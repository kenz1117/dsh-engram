import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { openEngramStore } from '../src/store/sqlite.ts'
import type { RankBoostOptions } from '../src/store/sqlite.ts'
import type { MemoryId } from '../src/types.ts'

/**
 * 夹具：A 词频更高（纯 RRF 排前）但 40 天未访问、访问计数 0；
 * B 词频低但刚访问过、访问计数 30。boost 生效时 B 应反超。
 */
let path: string
let a: MemoryId
let b: MemoryId

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'engram-rank-'))
  path = join(dir, 'user.db')
  const store = await openEngramStore(path)
  a = (await store.write({ scope: 'user', kind: 'fact', content: '端口 端口 配置' })).id
  b = (await store.write({ scope: 'user', kind: 'fact', content: '端口 改动' })).id
  await store.close()
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path)
  db.prepare('UPDATE nodes SET last_accessed_at = ? WHERE id = ?').run(Date.now() - 40 * 86_400_000, a)
  db.prepare('UPDATE nodes SET access_count = 30 WHERE id = ?').run(b)
  db.close()
})

const searchOrder = async (boost: RankBoostOptions): Promise<MemoryId[]> => {
  const store = await openEngramStore(path, boost)
  const result = await store.search({ text: '端口', scopes: ['user'] }, undefined)
  await store.close()
  return result.hits.map(hit => hit.record.id)
}

describe('检索排序 boost', () => {
  it('系数为 0 退化为纯 RRF 现状排序', async () => {
    expect(await searchOrder({ recencyWeight: 0, proofWeight: 0, decayAfterDays: 30 })).toEqual([a, b])
    expect(await searchOrder({ recencyWeight: 0, proofWeight: 0, decayAfterDays: 30 })).toEqual([a, b])
  })

  it('recency 因子：新鲜条目反超', async () => {
    expect(await searchOrder({ recencyWeight: 1, proofWeight: 0, decayAfterDays: 30 })).toEqual([b, a])
  })

  it('proof 因子：高访问计数反超', async () => {
    expect(await searchOrder({ recencyWeight: 0, proofWeight: 1, decayAfterDays: 30 })).toEqual([b, a])
  })

  it('缺省不加 boost（openEngramStore 不传选项时保持旧排序）', async () => {
    const store = await openEngramStore(path)
    const result = await store.search({ text: '端口', scopes: ['user'] }, undefined)
    await store.close()
    expect(result.hits.map(hit => hit.record.id)).toEqual([a, b])
  })
})
