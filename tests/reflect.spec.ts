/**
 * 信念巩固 reflectObservations 测试：取材幂等、form/refine/still/refute 四动作校验、
 * 新证据近邻触发的 stale 新鲜度扫描。
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reflectObservations } from '../src/consolidation/reflect.ts'
import { openEngramStore } from '../src/store/sqlite.ts'
import type { EngramStore } from '../src/store/interface.ts'
import type { EngramEmbedder } from '../src/embedder/interface.ts'
import { asMemoryId } from '../src/types.ts'

let dir: string
let store: EngramStore

const ROUTE = { provider: 'deepseek', model: 'deepseek-v4-flash' }
const SIGNAL = new AbortController().signal

/** 构造一个返回固定向量的假嵌入器（新鲜度扫描/近邻归并用）。 */
function fakeEmbedder(vectors: readonly Float32Array[]): EngramEmbedder {
  return {
    model: 'fake-embedder',
    embed: async (texts: readonly string[]) => texts.map((_, index) => vectors[index % vectors.length]!),
    close: async () => undefined,
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'engram-reflect-'))
  store = await openEngramStore(join(dir, 'user.db'))
})
afterEach(async () => {
  await store.close()
})

describe('reflectObservations', () => {
  it('空库：无候选无 stale 时不调用 LLM', async () => {
    const call = vi.fn(async () => '[]')
    const outcome = await reflectObservations({
      store, embedder: undefined, scope: 'user', call, logRequest: () => undefined, route: ROUTE, signal: SIGNAL,
    })
    expect(outcome.candidates).toBe(0)
    expect(call).not.toHaveBeenCalled()
  })

  it('form：新证据巩固为带证据链的 active 信念（无嵌入时不做近邻归并）', async () => {
    const a = await store.write({ scope: 'user', kind: 'fact', content: '构建用 pnpm', importance: 0.8 })
    const b = await store.write({ scope: 'user', kind: 'fact', content: '装依赖也用 pnpm', importance: 0.7 })
    const outcome = await reflectObservations({
      store,
      embedder: undefined,
      scope: 'user',
      call: async () => JSON.stringify([
        { action: 'form', belief: '项目包管理统一用 pnpm', sourceIds: [String(a.id), String(b.id)] },
      ]),
      logRequest: () => undefined,
      route: ROUTE,
      signal: SIGNAL,
    })
    expect(outcome.formed).toBe(1)
    const observations = await store.listObservations({ status: 'active', limit: 10 })
    expect(observations).toHaveLength(1)
    expect(observations[0]!.belief).toBe('项目包管理统一用 pnpm')
    expect(observations[0]!.proofCount).toBe(2)
    // 原始记忆保留 active（巩固是叠加抽象层，不归档证据）。
    expect((await store.get(a.id))?.status).toBe('active')
    expect((await store.get(b.id))?.status).toBe('active')
  })

  it('幂等：已成为信念证据的记忆不再进入候选，二次运行不调 LLM', async () => {
    const a = await store.write({ scope: 'user', kind: 'fact', content: '一条已巩固的记忆' })
    const call = vi.fn(async () => JSON.stringify([
      { action: 'form', belief: '已巩固信念', sourceIds: [String(a.id)] },
    ]))
    const first = await reflectObservations({
      store, embedder: undefined, scope: 'user', call, logRequest: () => undefined, route: ROUTE, signal: SIGNAL,
    })
    expect(first.formed).toBe(1)
    const secondCall = vi.fn(async () => '[]')
    const second = await reflectObservations({
      store, embedder: undefined, scope: 'user', call: secondCall, logRequest: () => undefined, route: ROUTE, signal: SIGNAL,
    })
    expect(second.candidates).toBe(0)
    expect(secondCall).not.toHaveBeenCalled()
  })

  it('form 的 sourceIds 越界时跳过该动作', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '候选记忆' })
    const outcome = await reflectObservations({
      store,
      embedder: undefined,
      scope: 'user',
      call: async () => JSON.stringify([
        { action: 'form', belief: '非法信念', sourceIds: ['not-in-candidates'] },
      ]),
      logRequest: () => undefined,
      route: ROUTE,
      signal: SIGNAL,
    })
    expect(outcome.formed).toBe(0)
    expect(outcome.skipped).toBe(1)
    expect(await store.listObservations({ limit: 10 })).toHaveLength(0)
  })

  it('stale 信念三动作：refine 合并证据回 active、still 维持、refute 否定', async () => {
    // 三条既有信念（直接落库造 active），各自标 stale。
    const toRefine = await store.createObservation({ scope: 'user', belief: '待细化', sourceIds: [asMemoryId('old-1')] })
    const toConfirm = await store.createObservation({ scope: 'user', belief: '仍成立', sourceIds: [asMemoryId('old-2')] })
    const toRefute = await store.createObservation({ scope: 'user', belief: '已过时', sourceIds: [asMemoryId('old-3')] })
    await store.markObservationStale(toRefine.id)
    await store.markObservationStale(toConfirm.id)
    await store.markObservationStale(toRefute.id)
    // 一条新证据供 refine 引用。
    const fresh = await store.write({ scope: 'user', kind: 'fact', content: '新的限定条件' })

    const outcome = await reflectObservations({
      store,
      embedder: undefined,
      scope: 'user',
      call: async () => JSON.stringify([
        { action: 'refine', observationId: String(toRefine.id), belief: '细化后的表述', sourceIds: [String(fresh.id)] },
        { action: 'still', observationId: String(toConfirm.id) },
        { action: 'refute', observationId: String(toRefute.id), reason: '新证据表明相反' },
      ]),
      logRequest: () => undefined,
      route: ROUTE,
      signal: SIGNAL,
    })
    expect(outcome.refined).toBe(1)
    expect(outcome.confirmed).toBe(1)
    expect(outcome.refuted).toBe(1)

    const refined = (await store.listObservations({ status: 'active', limit: 10 }))
      .find(item => String(item.id) === String(toRefine.id))
    expect(refined?.belief).toBe('细化后的表述')
    expect(refined?.proofCount).toBe(2)
    const refuted = (await store.listObservations({ status: 'refuted', limit: 10 }))
      .find(item => String(item.id) === String(toRefute.id))
    expect(refuted?.belief).toBe('已过时')
  })

  it('observationId 越界（非本次 stale 集）的动作跳过', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '候选' })
    const outcome = await reflectObservations({
      store,
      embedder: undefined,
      scope: 'user',
      call: async () => JSON.stringify([
        { action: 'still', observationId: 'ghost-id' },
      ]),
      logRequest: () => undefined,
      route: ROUTE,
      signal: SIGNAL,
    })
    expect(outcome.confirmed).toBe(0)
    expect(outcome.skipped).toBe(1)
  })

  it('新鲜度扫描：新证据与 active 信念近邻达到阈值时标 stale 并喂入复核段', async () => {
    // 既有信念沿 x 轴；新证据也沿 x 轴（cosine = 1 ≥ 0.86 stale 阈值）。
    const observation = await store.createObservation({
      scope: 'user', belief: '既有信念', sourceIds: [asMemoryId('old-x')], embedding: new Float32Array([1, 0]),
    })
    await store.write({ scope: 'user', kind: 'fact', content: '一条近邻新证据' })
    const embedder = fakeEmbedder([new Float32Array([1, 0]), new Float32Array([1, 0])])

    let userText = ''
    const outcome = await reflectObservations({
      store,
      embedder,
      scope: 'user',
      call: async (params) => {
        userText = params.userText
        return JSON.stringify([{ action: 'still', observationId: String(observation.id) }])
      },
      logRequest: () => undefined,
      route: ROUTE,
      signal: SIGNAL,
    })
    expect(outcome.staleReviewed).toBe(1)
    expect(userText).toContain('【待复核信念】')
    expect(userText).toContain(String(observation.id))
    // still 后信念回到 active。
    expect((await store.listObservations({ status: 'active', limit: 10 }))).toHaveLength(1)
  })
})
