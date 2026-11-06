/**
 * observations 巩固信念表（schema v12）的 store 层测试：
 * CRUD、证据并集去重、三态流转、排序与向量近邻、归档传播（#48）。
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { reflectObservations } from '../src/consolidation/reflect.ts'
import { openEngramStore } from '../src/store/sqlite.ts'
import type { EngramStore } from '../src/store/interface.ts'
import { asMemoryId, asObservationId, EngramError } from '../src/types.ts'

let dir: string
let store: EngramStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'engram-observations-'))
  store = await openEngramStore(join(dir, 'user.db'))
})
afterEach(async () => {
  await store.close()
})

describe('observations CRUD', () => {
  it('create：证据去重、proof_count 正确、初始 active', async () => {
    const created = await store.createObservation({
      scope: 'user',
      belief: '项目统一用 pnpm',
      // 故意重复一次，落库必须去重。
      sourceIds: [asMemoryId('a'), asMemoryId('a'), asMemoryId('b')],
    })
    expect(created.status).toBe('active')
    expect(created.proofCount).toBe(2)
    expect(created.sourceIds.map(String)).toEqual(['a', 'b'])
    expect(created.lastValidatedAt).toBe(created.createdAt)
  })

  it('create：空证据 loud 失败', async () => {
    await expect(store.createObservation({ scope: 'user', belief: '无证据', sourceIds: [] }))
      .rejects.toBeInstanceOf(EngramError)
  })

  it('refine：合并证据并集、belief 更新、stale 回 active', async () => {
    const observation = await store.createObservation({
      scope: 'user', belief: '旧表述', sourceIds: [asMemoryId('a')],
    })
    await store.markObservationStale(observation.id)
    expect((await store.listObservations({ status: 'stale', limit: 10 }))).toHaveLength(1)

    const refined = await store.refineObservation(observation.id, '新表述', [asMemoryId('a'), asMemoryId('c')])
    expect(refined?.status).toBe('active')
    expect(refined?.belief).toBe('新表述')
    expect(refined?.proofCount).toBe(2)
    expect(refined?.sourceIds.map(String).sort()).toEqual(['a', 'c'])
    expect(refined?.lastValidatedAt).toBeGreaterThanOrEqual(observation.createdAt)
  })

  it('refine/markStale/confirm/refute：不存在的 id 返回 undefined', async () => {
    expect(await store.refineObservation(asObservationId('ghost'), 'x', [])).toBeUndefined()
    expect(await store.markObservationStale(asObservationId('ghost'))).toBeUndefined()
    expect(await store.confirmObservation(asObservationId('ghost'))).toBeUndefined()
    expect(await store.refuteObservation(asObservationId('ghost'))).toBeUndefined()
  })

  it('confirm 回 active；refute 终态不参与近邻', async () => {
    const observation = await store.createObservation({
      scope: 'user', belief: '待验证', sourceIds: [asMemoryId('a')], embedding: new Float32Array([1, 0]),
    })
    await store.markObservationStale(observation.id)
    expect((await store.confirmObservation(observation.id))?.status).toBe('active')
    await store.refuteObservation(observation.id)
    expect((await store.listObservations({ limit: 10 }))[0]?.status).toBe('refuted')
    // refuted 即使带向量也不进近邻候选。
    expect(await store.nearestObservation(new Float32Array([1, 0]))).toBeUndefined()
  })

  it('list：状态过滤 + proof_count 倒序', async () => {
    const weak = await store.createObservation({ scope: 'user', belief: '弱证据', sourceIds: [asMemoryId('a')] })
    const strong = await store.createObservation({
      scope: 'user', belief: '强证据', sourceIds: [asMemoryId('b'), asMemoryId('c'), asMemoryId('d')],
    })
    const listed = await store.listObservations({ status: 'active', limit: 10 })
    expect(listed.map(item => String(item.id))).toEqual([String(strong.id), String(weak.id)])
    await store.refuteObservation(weak.id)
    expect(await store.listObservations({ status: 'active', limit: 10 })).toHaveLength(1)
  })

  it('nearestObservation：返回最高余弦同库信念', async () => {
    await store.createObservation({
      scope: 'user', belief: 'x 方向', sourceIds: [asMemoryId('a')], embedding: new Float32Array([1, 0]),
    })
    await store.createObservation({
      scope: 'user', belief: 'y 方向', sourceIds: [asMemoryId('b')], embedding: new Float32Array([0, 1]),
    })
    const nearest = await store.nearestObservation(new Float32Array([0.9, 0.1]))
    expect(nearest?.record.belief).toBe('x 方向')
    expect(nearest?.similarity).toBeGreaterThan(0.9)
  })
})

describe('归档传播（#48：证据死亡 → 信念扣源/降级）', () => {
  /** 取当前库中唯一一条信念（传播矩阵都是单信念场景）。 */
  const onlyObservation = async () => (await store.listObservations({ limit: 10 }))[0]!

  it('forget 源节点：证据有余置 stale 扣源，证据耗尽置 refuted', async () => {
    const a = await store.write({ scope: 'user', kind: 'fact', content: '构建用 pnpm' })
    const b = await store.write({ scope: 'user', kind: 'fact', content: '装依赖也用 pnpm' })
    await store.createObservation({ scope: 'user', belief: '项目包管理统一用 pnpm', sourceIds: [a.id, b.id] })

    await store.forget(a.id)
    const afterA = await onlyObservation()
    expect(afterA.status).toBe('stale')
    expect(afterA.proofCount).toBe(1)
    expect(afterA.sourceIds.map(String)).toEqual([String(b.id)])

    await store.forget(b.id)
    const afterB = await onlyObservation()
    expect(afterB.status).toBe('refuted')
    // refute 只置状态：证据链保留供审计，proof_count 不再变。
    expect(afterB.proofCount).toBe(1)
  })

  it('update（supersede）旧条目：同样扣源降级', async () => {
    const a = await store.write({ scope: 'user', kind: 'fact', content: '构建用 pnpm' })
    const b = await store.write({ scope: 'user', kind: 'fact', content: '装依赖也用 pnpm' })
    await store.createObservation({ scope: 'user', belief: '项目包管理统一用 pnpm', sourceIds: [a.id, b.id] })

    await store.update({ id: a.id, scope: 'user', kind: 'fact', content: '构建用 pnpm（修订版）' })
    const observation = await onlyObservation()
    expect(observation.status).toBe('stale')
    expect(observation.proofCount).toBe(1)
    expect(observation.sourceIds.map(String)).toEqual([String(b.id)])
  })

  it('supersedeMany（蒸馏归档）：批量归档后扣源', async () => {
    const a = await store.write({ scope: 'user', kind: 'fact', content: '构建用 pnpm' })
    const b = await store.write({ scope: 'user', kind: 'fact', content: '装依赖也用 pnpm' })
    await store.createObservation({ scope: 'user', belief: '项目包管理统一用 pnpm', sourceIds: [a.id, b.id] })

    await store.supersedeMany({ scope: 'user', kind: 'fact', content: 'pnpm 是唯一包管理器' }, [a.id])
    const observation = await onlyObservation()
    expect(observation.status).toBe('stale')
    expect(observation.proofCount).toBe(1)
    expect(observation.sourceIds.map(String)).toEqual([String(b.id)])
  })

  it('decay 归档：同判准先行取 id 后传播', async () => {
    const c = await store.write({ scope: 'user', kind: 'fact', content: '将被衰减', importance: 0.1 })
    const d = await store.write({ scope: 'user', kind: 'fact', content: '重要性高保留', importance: 0.9 })
    await store.createObservation({ scope: 'user', belief: '构建工具链结论', sourceIds: [c.id, d.id] })
    // 把全部条目的最近访问时间拨回 40 天前，并清掉写入期自动排的复习日程（进复习调度的条目不参与衰减）。
    const { DatabaseSync } = await import('node:sqlite')
    const raw = new DatabaseSync(join(dir, 'user.db'))
    raw.prepare('UPDATE nodes SET last_accessed_at = ?, next_review_at = NULL').run(Date.now() - 40 * 86_400_000)
    raw.close()

    const archived = await store.decay({ importanceBelow: 0.3, olderThanDays: 30 })
    expect(archived).toBe(1)
    const observation = await onlyObservation()
    expect(observation.status).toBe('stale')
    expect(observation.proofCount).toBe(1)
    expect(observation.sourceIds.map(String)).toEqual([String(d.id)])
  })

  it('restore 不复活信念：归档传播后 restore 源节点，信念保持 stale/refuted', async () => {
    const a = await store.write({ scope: 'user', kind: 'fact', content: '构建用 pnpm' })
    const b = await store.write({ scope: 'user', kind: 'fact', content: '装依赖也用 pnpm' })
    await store.createObservation({ scope: 'user', belief: '项目包管理统一用 pnpm', sourceIds: [a.id, b.id] })

    await store.forget(a.id)
    expect((await onlyObservation()).status).toBe('stale')
    // restore 有意不联动：节点复活，信念不自动把证据加回来。
    await store.restore(a.id)
    const restored = await onlyObservation()
    expect(restored.status).toBe('stale')
    expect(restored.sourceIds.map(String)).toEqual([String(b.id)])

    await store.forget(b.id)
    await store.restore(b.id)
    const refuted = await onlyObservation()
    expect(refuted.status).toBe('refuted')
  })

  it('重新取材幂等：源被摘除后该节点 id 可再被 reflect 取材', async () => {
    const a = await store.write({ scope: 'user', kind: 'fact', content: '构建用 pnpm' })
    const b = await store.write({ scope: 'user', kind: 'fact', content: '装依赖也用 pnpm' })
    await store.createObservation({ scope: 'user', belief: '项目包管理统一用 pnpm', sourceIds: [a.id, b.id] })

    await store.forget(a.id)
    await store.restore(a.id)
    // reflect 取材池排除「仍是 active/stale 信念证据」的记忆；a 已被摘除，应重新进入候选。
    let userText = ''
    await reflectObservations({
      store,
      embedder: undefined,
      scope: 'user',
      call: async (params) => {
        userText = params.userText
        return '[]'
      },
      logRequest: () => undefined,
      route: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      signal: new AbortController().signal,
    })
    expect(userText).toContain(String(a.id))
    // b 仍是证据，不该再次出现在取材池里。
    expect(userText).not.toContain(String(b.id))
    expect((await onlyObservation()).status).toBe('stale')
  })

  it('人工状态切换：proof_count 与 sources_json 全程一致', async () => {
    const a = await store.write({ scope: 'user', kind: 'fact', content: '构建用 pnpm' })
    const b = await store.write({ scope: 'user', kind: 'fact', content: '装依赖也用 pnpm' })
    const observation = await store.createObservation({ scope: 'user', belief: '项目包管理统一用 pnpm', sourceIds: [a.id, b.id] })

    const expectedSources = [String(a.id), String(b.id)].sort()
    const stale = await store.markObservationStale(observation.id)
    expect(stale?.status).toBe('stale')
    expect(stale?.proofCount).toBe(2)
    expect(stale?.sourceIds.map(String).sort()).toEqual(expectedSources)

    const confirmed = await store.confirmObservation(observation.id)
    expect(confirmed?.status).toBe('active')
    expect(confirmed?.proofCount).toBe(2)
    expect(confirmed?.sourceIds.map(String).sort()).toEqual(expectedSources)

    const refuted = await store.refuteObservation(observation.id)
    expect(refuted?.status).toBe('refuted')
    expect(refuted?.proofCount).toBe(2)
    expect(refuted?.sourceIds.map(String).sort()).toEqual(expectedSources)
  })
})
