import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openEngramStore } from '../src/store/sqlite.ts'
import { asMemoryId } from '../src/types.ts'
import type { EngramStore } from '../src/store/interface.ts'

let dir: string
let store: EngramStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'engram-v2-'))
  store = await openEngramStore(join(dir, 'user.db'))
})
afterEach(async () => {
  await store.close()
})

describe('EngramStore v2 additions', () => {
  it('review 返回条目 + supersedes 链 + 操作日志', async () => {
    const old = await store.write({ scope: 'user', kind: 'fact', content: '端口 3000', sourceRound: 1, sourceSeq: 7 })
    const next = await store.update({ id: old.id, scope: 'user', kind: 'fact', content: '端口 4000' })
    const view = await store.review(next.id)
    expect(view?.record.content).toBe('端口 4000')
    expect(view?.supersedes.map(id => String(id))).toEqual([String(old.id)])
    expect(view?.record.sourceRound).toBeNull()
    const oldView = await store.review(old.id)
    expect(oldView?.supersededBy.map(id => String(id))).toEqual([String(next.id)])
    expect(oldView?.record.sourceSeq).toBe(7)
    expect(oldView?.operations.length).toBeGreaterThan(0)
    expect(oldView?.operations[0]!.op).toBe('superseded')
  })

  it('stats 统计分布与信噪比', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '甲' })
    await store.write({ scope: 'user', kind: 'preference', content: '乙' })
    const stale = await store.write({ scope: 'user', kind: 'episode', content: '丙' })
    await store.forget(stale.id)
    const stats = await store.stats()
    expect(stats.total).toBe(3)
    expect(stats.active).toBe(2)
    expect(stats.forgotten).toBe(1)
    expect(stats.byKind['fact']).toBe(1)
    expect(stats.byKind['episode']).toBe(1)
    expect(stats.signalRatio).toBeCloseTo(2 / 3, 5)
    expect(stats.opLogCount).toBeGreaterThan(0)
  })

  it('decay 归档低重要性且长期未访问的条目', async () => {
    const path = join(dir, 'user.db')
    await store.write({ scope: 'user', kind: 'fact', content: '将被衰减', importance: 0.1 })
    await store.write({ scope: 'user', kind: 'fact', content: '重要性高保留', importance: 0.9 })
    // 把全部条目的最近访问时间拨回 40 天前，模拟长期未访问。
    const { DatabaseSync } = await import('node:sqlite')
    const raw = new DatabaseSync(path)
    raw.prepare('UPDATE nodes SET last_accessed_at = ?').run(Date.now() - 40 * 86_400_000)
    raw.close()
    const archived = await store.decay({ importanceBelow: 0.3, olderThanDays: 30 })
    expect(archived).toBe(1)
    const survivors = await store.topActive('user', 10)
    expect(survivors.map(record => record.content)).toEqual(['重要性高保留'])
  })

  it('findContradictions 只报高相似近邻，linkEdge 幂等建边', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '部署端口是 4000', embedding: new Float32Array(512).fill(0.5) })
    await store.write({ scope: 'user', kind: 'fact', content: '毫无相关的另一条', embedding: new Float32Array(512).fill(-0.5) })
    const candidates = await store.findContradictions(new Float32Array(512).fill(0.5))
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.content).toBe('部署端口是 4000')
    // 写入新条目并建 contradicts 边 → review 分组可见
    const next = await store.write({ scope: 'user', kind: 'fact', content: '部署端口改为 5000' })
    await store.linkEdge(next.id, candidates[0]!.id, 'contradicts')
    await store.linkEdge(next.id, candidates[0]!.id, 'contradicts')
    const view = await store.review(next.id)
    expect(view?.contradicts.map(id => String(id))).toEqual([String(candidates[0]!.id)])
  })

  it('supersedeMany 单事务写新归旧并建链', async () => {
    const a = await store.write({ scope: 'user', kind: 'fact', content: '碎片甲', importance: 0.4 })
    const b = await store.write({ scope: 'user', kind: 'fact', content: '碎片乙', importance: 0.6 })
    const merged = await store.supersedeMany(
      { scope: 'user', kind: 'skill', content: '甲乙合并的规律', importance: 0.8, confidence: 0.7, sourceRound: 3, sourceSeq: 12 },
      [a.id, b.id],
    )
    expect((await store.get(a.id))?.status).toBe('archived')
    expect((await store.get(b.id))?.status).toBe('archived')
    const view = await store.review(merged.id)
    expect(view?.supersedes.map(id => String(id)).sort()).toEqual([String(a.id), String(b.id)].sort())
    expect(view?.record.sourceRound).toBe(3)
    expect(view?.record.sourceSeq).toBe(12)
    // 空数组时与 write 等价
    const solo = await store.supersedeMany({ scope: 'user', kind: 'fact', content: '独立条目' }, [])
    expect(solo.content).toBe('独立条目')
  })

  it('exportAll 含任意状态条目与边', async () => {
    const a = await store.write({ scope: 'user', kind: 'fact', content: '导出甲' })
    const forgotten = await store.write({ scope: 'user', kind: 'fact', content: '导出乙' })
    await store.forget(forgotten.id)
    await store.linkEdge(a.id, forgotten.id, 'related')
    const data = await store.exportAll()
    expect(data.records.map(record => record.id).sort()).toEqual([a.id, forgotten.id].sort())
    expect(data.records.find(record => record.id === forgotten.id)?.status).toBe('forgotten')
    expect(data.edges).toHaveLength(1)
    expect(asMemoryId(data.edges[0]!.from)).toBe(a.id)
  })

  it('search 命中提升 confidence', async () => {
    const record = await store.write({ scope: 'user', kind: 'fact', content: '置信度提升条目', confidence: 0.5 })
    await store.search({ text: '置信度', scopes: ['user'] }, undefined)
    const bumped = await store.get(record.id)
    expect(bumped?.confidence).toBeCloseTo(0.55, 5)
  })
})
