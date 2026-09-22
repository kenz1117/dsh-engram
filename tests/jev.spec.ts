import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { askNoul, createMemoryJudge, testJevConnection } from '../src/jev/client.ts'
import { clearJevObservations, listJevObservations, recordJevObservation } from '../src/jev/observe.ts'
import { confirmContradictions, decideWrite } from '../src/write-disposition.ts'
import type { ResolvedJevConfig } from '../src/config.ts'
import type { EngramStore } from '../src/store/interface.ts'
import type { JudgeQuestion, MemoryJudge } from '../src/write-disposition.ts'
import type { MemoryId, MemoryRecord } from '../src/types.ts'

/** 测试用 Jev 配置：enabled 场景的标准夹具。 */
const jevConfig: ResolvedJevConfig = {
  enabled: true,
  apiKey: 'test-key',
  baseUrl: 'https://jev.test',
  model: 'jev-test',
  timeoutMs: 3000,
  deferMergeAbove: 0.85,
  deferAcceptBelow: 0.15,
  contradictMinProbability: 0.8,
}

/** MemoryRecord 夹具：四态判定只读 id/kind/content，其余字段落默认。 */
function makeRecord(content: string, id = 'm-neighbor'): MemoryRecord {
  return {
    id: id as MemoryId,
    scope: 'user',
    kind: 'fact',
    content,
    importance: 0.5,
    confidence: 0.5,
    status: 'active',
    createdAt: 0,
    lastAccessedAt: 0,
    accessCount: 0,
    sourceSessionId: null,
    sourceRound: null,
    sourceSeq: null,
  }
}

/**
 * fake judge：按问题 id 回固定概率；answer 传 Error 时 ask 抛错（模拟网络失败）。
 * calls 记录每次提问的 state 与 questions，供断言提问内容与调用次数。
 */
function fakeJudge(answer: number | Error): MemoryJudge & { calls: { state: string; questions: readonly JudgeQuestion[] }[] } {
  const calls: { state: string; questions: readonly JudgeQuestion[] }[] = []
  return {
    deferMergeAbove: 0.85,
    deferAcceptBelow: 0.15,
    contradictMinProbability: 0.8,
    ask: async (state, questions) => {
      calls.push({ state, questions })
      if (answer instanceof Error) throw answer
      return Object.fromEntries(questions.map(question => [question.id, answer]))
    },
    calls,
  }
}

/** stub 全局 fetch：返回固定 JSON 与状态码，返回 mock 供断言请求形状。 */
function stubFetch(payload: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), { status }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('askNoul', () => {
  it('POST state/questions 到 {baseUrl}/v1/systemone 并解析 noul 概率', async () => {
    const fetchMock = stubFetch({ answers: { same_memory: { noul: 0.7 } } })
    const answers = await askNoul(jevConfig, '状态文本', [{ id: 'same_memory', instructions: '同一事实吗' }])
    expect(answers).toEqual({ same_memory: 0.7 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit]
    expect(url.toString()).toBe('https://jev.test/v1/systemone')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key')
    const body = JSON.parse(init.body as string) as { model: string; state: string; questions: Record<string, { type: string; instructions: string }> }
    expect(body.model).toBe('jev-test')
    expect(body.state).toBe('状态文本')
    expect(body.questions.same_memory).toEqual({ type: 'noul', instructions: '同一事实吗' })
  })

  it('空问题列表短路，不发请求', async () => {
    const fetchMock = stubFetch({ answers: {} })
    const answers = await askNoul(jevConfig, '状态文本', [])
    expect(answers).toEqual({})
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('非 2xx 抛错', async () => {
    stubFetch({ error: 'nope' }, 503)
    await expect(askNoul(jevConfig, 's', [{ id: 'q', instructions: 'i' }])).rejects.toThrow(/HTTP 503/)
  })

  it('响应缺失 answers 抛错', async () => {
    stubFetch({})
    await expect(askNoul(jevConfig, 's', [{ id: 'q', instructions: 'i' }])).rejects.toThrow(/missing answers/)
  })

  it('noul 非数字或越界抛错', async () => {
    stubFetch({ answers: { q: { noul: 'high' } } })
    await expect(askNoul(jevConfig, 's', [{ id: 'q', instructions: 'i' }])).rejects.toThrow(/noul probability/)
    stubFetch({ answers: { q: { noul: 1.5 } } })
    await expect(askNoul(jevConfig, 's', [{ id: 'q', instructions: 'i' }])).rejects.toThrow(/noul probability/)
  })
})

describe('createMemoryJudge', () => {
  it('三阈值与超时从配置透传', () => {
    const judge = createMemoryJudge(jevConfig)
    expect(judge.deferMergeAbove).toBe(0.85)
    expect(judge.deferAcceptBelow).toBe(0.15)
    expect(judge.contradictMinProbability).toBe(0.8)
  })
})

describe('decideWrite 模糊带 Jev 裁决', () => {
  /** 模糊带 store 夹具：最近邻相似度 0.9 落在 DEFER_COSINE(0.88) 与 MERGE_COSINE(0.92) 之间。 */
  function bandStore(neighbor: MemoryRecord, similarity = 0.9): EngramStore {
    return { nearestNeighbor: async () => ({ record: neighbor, similarity }) } as unknown as EngramStore
  }
  const embedding = new Float32Array(4).fill(0.5)

  it('概率 ≥ deferMergeAbove：merge 进最近邻', async () => {
    const judge = fakeJudge(0.9)
    const neighbor = makeRecord('用户在杭州工作')
    const decision = await decideWrite(bandStore(neighbor), 'fact', embedding, { judge, content: '用户定居杭州' })
    expect(decision).toEqual({ disposition: 'merge', into: neighbor, similarity: 0.9 })
    expect(judge.calls).toHaveLength(1)
    // 提问 state 是 Memory A/B 对照，A 为既有条目、B 为新内容（calls 已断言长度 1，取首条用可选链满足索引访问检查）。
    expect(judge.calls[0]?.state).toContain('用户在杭州工作')
    expect(judge.calls[0]?.state).toContain('用户定居杭州')
  })

  it('概率 ≤ deferAcceptBelow：accept 新建', async () => {
    const judge = fakeJudge(0.1)
    const decision = await decideWrite(bandStore(makeRecord('A')), 'fact', embedding, { judge, content: 'B' })
    expect(decision).toEqual({ disposition: 'accept' })
  })

  it('模糊概率：维持 defer 待人审', async () => {
    const judge = fakeJudge(0.5)
    const neighbor = makeRecord('A')
    const decision = await decideWrite(bandStore(neighbor), 'fact', embedding, { judge, content: 'B' })
    expect(decision).toEqual({ disposition: 'defer', neighbor, similarity: 0.9 })
  })

  it('judge.ask 抛错：静默降级回 defer（不丢人审）', async () => {
    const judge = fakeJudge(new Error('network down'))
    const neighbor = makeRecord('A')
    const decision = await decideWrite(bandStore(neighbor), 'fact', embedding, { judge, content: 'B' })
    expect(decision).toEqual({ disposition: 'defer', neighbor, similarity: 0.9 })
  })

  it('未注入 judge：纯规则 defer（行为与接入前一致）', async () => {
    const neighbor = makeRecord('A')
    const decision = await decideWrite(bandStore(neighbor), 'fact', embedding)
    expect(decision).toEqual({ disposition: 'defer', neighbor, similarity: 0.9 })
  })

  it('相似度 ≥ MERGE_COSINE 同 kind：纯规则直接 merge，不问 judge', async () => {
    const judge = fakeJudge(new Error('should not be asked'))
    const neighbor = makeRecord('A')
    const decision = await decideWrite(bandStore(neighbor, 0.95), 'fact', embedding, { judge, content: 'B' })
    expect(decision).toEqual({ disposition: 'merge', into: neighbor, similarity: 0.95 })
    expect(judge.calls).toHaveLength(0)
  })
})

describe('confirmContradictions', () => {
  it('概率 ≥ contradictMinProbability 的候选保留', async () => {
    const judge = fakeJudge(0.9)
    const candidate = makeRecord('矛盾候选A', 'm-a')
    const confirmed = await confirmContradictions(judge, '新内容', [candidate])
    expect(confirmed).toEqual([candidate])
  })

  it('概率低于阈值：全部过滤', async () => {
    const judge = fakeJudge(0.3)
    const confirmed = await confirmContradictions(judge, '新内容', [makeRecord('A', 'm-a')])
    expect(confirmed).toEqual([])
  })

  it('judge 抛错：返回 undefined（调用方降级为全量建边）', async () => {
    const judge = fakeJudge(new Error('network down'))
    const confirmed = await confirmContradictions(judge, '新内容', [makeRecord('A', 'm-a')])
    expect(confirmed).toBeUndefined()
  })

  it('空候选：不发提问返回空数组', async () => {
    const judge = fakeJudge(0.9)
    const confirmed = await confirmContradictions(judge, '新内容', [])
    expect(confirmed).toEqual([])
    expect(judge.calls).toHaveLength(0)
  })
})

describe('裁决观测插桩', () => {
  beforeEach(() => { clearJevObservations() })

  /** 模糊带 store 夹具（与 decideWrite describe 同构）：相似度 0.9 落模糊带。 */
  function bandStore(neighbor: MemoryRecord): EngramStore {
    return { nearestNeighbor: async () => ({ record: neighbor, similarity: 0.9 }) } as unknown as EngramStore
  }
  const embedding = new Float32Array(4).fill(0.5)

  it('模糊带三路判定分别记录 merge/accept/defer', async () => {
    await decideWrite(bandStore(makeRecord('A')), 'fact', embedding, { judge: fakeJudge(0.9), content: 'B' })
    await decideWrite(bandStore(makeRecord('A')), 'fact', embedding, { judge: fakeJudge(0.1), content: 'B' })
    await decideWrite(bandStore(makeRecord('A')), 'fact', embedding, { judge: fakeJudge(0.5), content: 'B' })
    expect(listJevObservations().map(o => o.verdict)).toEqual(['merge', 'accept', 'defer'])
    const first = listJevObservations()[0]
    expect(first?.site).toBe('band')
    expect(first?.question).toBe('same_memory')
    expect(first?.answered).toBe(true)
    expect(first?.probability).toBe(0.9)
    expect(first?.error).toBeUndefined()
    expect(typeof first?.elapsedMs).toBe('number')
  })

  it('模糊带答案缺失记录 fallback（answered=false）', async () => {
    const noAnswerJudge: MemoryJudge = {
      deferMergeAbove: 0.85,
      deferAcceptBelow: 0.15,
      contradictMinProbability: 0.8,
      ask: async () => ({}),
    }
    const decision = await decideWrite(bandStore(makeRecord('A')), 'fact', embedding, { judge: noAnswerJudge, content: 'B' })
    expect(decision).toEqual({ disposition: 'defer', neighbor: makeRecord('A'), similarity: 0.9 })
    const last = listJevObservations().at(-1)
    expect(last?.verdict).toBe('fallback')
    expect(last?.answered).toBe(false)
    expect(last?.probability).toBeUndefined()
  })

  it('模糊带 judge 抛错记录 fallback 并携带错误文案', async () => {
    await decideWrite(bandStore(makeRecord('A')), 'fact', embedding, { judge: fakeJudge(new Error('network down')), content: 'B' })
    const last = listJevObservations().at(-1)
    expect(last?.verdict).toBe('fallback')
    expect(last?.error).toBe('network down')
  })

  it('矛盾确认分别记录 confirm/reject', async () => {
    await confirmContradictions(fakeJudge(0.9), '新内容', [makeRecord('A', 'm-a')])
    await confirmContradictions(fakeJudge(0.3), '新内容', [makeRecord('B', 'm-b')])
    expect(listJevObservations().map(o => o.verdict)).toEqual(['confirm', 'reject'])
    const first = listJevObservations()[0]
    expect(first?.site).toBe('contradiction')
    expect(first?.question).toBe('contradicts')
  })

  it('矛盾确认抛错记录 fallback 且整体降级契约不变', async () => {
    const confirmed = await confirmContradictions(fakeJudge(new Error('boom')), '新内容', [makeRecord('A', 'm-a')])
    expect(confirmed).toBeUndefined()
    const last = listJevObservations().at(-1)
    expect(last?.verdict).toBe('fallback')
    expect(last?.error).toBe('boom')
  })
})

describe('observe 环形缓冲', () => {
  beforeEach(() => { clearJevObservations() })

  /** 观测夹具：at 递增区分先后，其余字段固定。 */
  function makeObservation(at: number): Parameters<typeof recordJevObservation>[0] {
    return { at, site: 'band', question: 'same_memory', answered: true, probability: 0.5, elapsedMs: 1, error: undefined, verdict: 'defer' }
  }

  it('按序读取，超出 50 条丢弃最旧', () => {
    for (let at = 0; at < 55; at += 1) recordJevObservation(makeObservation(at))
    const all = listJevObservations()
    expect(all).toHaveLength(50)
    expect(all[0]?.at).toBe(5)
    expect(all.at(-1)?.at).toBe(54)
  })

  it('返回副本，外部改动不影响缓冲', () => {
    recordJevObservation(makeObservation(1))
    const copy = [...listJevObservations()]
    copy.pop()
    expect(listJevObservations()).toHaveLength(1)
  })
})

describe('testJevConnection', () => {
  it('成功返回 ok 与 ping 概率', async () => {
    stubFetch({ answers: { ping: { noul: 0.42 } } })
    const result = await testJevConnection(jevConfig)
    expect(result.ok).toBe(true)
    expect(result.probability).toBe(0.42)
    expect(result.error).toBeUndefined()
    expect(typeof result.elapsedMs).toBe('number')
  })

  it('失败不抛错，error 返回原因', async () => {
    stubFetch({}, 401)
    const result = await testJevConnection(jevConfig)
    expect(result.ok).toBe(false)
    expect(result.probability).toBeUndefined()
    expect(result.error).toContain('HTTP 401')
  })
})
