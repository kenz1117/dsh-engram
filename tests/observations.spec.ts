/**
 * observations 巩固信念表（schema v12）的 store 层测试：
 * CRUD、证据并集去重、三态流转、排序与向量近邻。
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
