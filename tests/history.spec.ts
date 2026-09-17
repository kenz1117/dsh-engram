import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ResolvedHistoryRules } from '../src/config.ts'
import { estimateHistoryBackfill, mergeHistoryRules, runHistoryBackfill } from '../src/ingest/history.ts'
import type { HistoryBackfillDeps, HistoryLogSource } from '../src/ingest/history.ts'
import { INGEST_DONE_OP, encodeTurnKey } from '../src/ingest/hook.ts'
import { openEngramStore } from '../src/store/sqlite.ts'
import type { EngramStore } from '../src/store/interface.ts'

/** 配置默认规则（各用例按需覆盖）。 */
const DEFAULTS: ResolvedHistoryRules = {
  days: 7,
  maxTurnsPerSession: 20,
  maxTotalTurns: 200,
  includeSubagents: false,
  includeSeeded: false,
  includeNoCwd: false,
}

let dir: string
const stores = new Map<string, EngramStore>()

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'engram-history-'))
  stores.clear()
})
afterEach(async () => {
  for (const store of stores.values()) await store.close()
  stores.clear()
})

/** 打开（并缓存）某个键名对应的分库。 */
async function storeFor(key: string): Promise<EngramStore> {
  const existing = stores.get(key)
  if (existing !== undefined) return existing
  const created = await openEngramStore(join(dir, `${key}.db`))
  stores.set(key, created)
  return created
}

/** 长文本：让活动评分越过节流阈值（userChars 满档 3 分 + 两条助手消息 2 分 = 5）。 */
const PAD = '这是一段足够长的具体描述，用来让活动评分达到节流阈值。'.repeat(12)

/** 一轮的事件序列：长用户输入 + 助手文本 + 工具调用/结果，越过节流阈值（评分 8）。 */
const turnEvents = (turn: number): unknown[] => [
  { type: 'turn/start', data: { turn }, seq: turn * 100, time: Date.now() },
  { type: 'user/message', data: { content: [{ type: 'text', text: `第 ${turn} 轮：${PAD}` }] }, seq: turn * 100 + 1, time: Date.now() },
  { type: 'assistant/message', data: { content: [{ type: 'text', text: '回答一' }] }, seq: turn * 100 + 2, time: Date.now() },
  ...['read', 'grep', 'edit'].map((name, index) => ({
    type: 'tool/call', data: { callId: `call-${turn}-${index}`, name, arguments: '{}' }, seq: turn * 100 + 3 + index, time: Date.now(),
  })),
  ...Array.from({ length: 5 }, (_, index) => ({
    type: 'tool/result', data: { callId: `call-${turn}-${index % 3}`, isError: false }, seq: turn * 100 + 10 + index, time: Date.now(),
  })),
]

interface SessionFixture {
  readonly id: string
  readonly createdAt: number
  readonly cwd?: string | undefined
  readonly isSeeded?: boolean
  readonly origin?: string
  /** 该会话包含的轮次号。 */
  readonly turns: readonly number[]
  /** 读取时抛错（模拟日志损坏）。 */
  readonly unreadable?: boolean
}

/** 事件源替身：header 来自 fixture，events 按 turns 生成。 */
function makeSource(fixtures: readonly SessionFixture[]): HistoryLogSource {
  return {
    list: async () => fixtures.map(({ id, createdAt, cwd, isSeeded, origin }) => ({ id, createdAt, cwd, isSeeded, origin })),
    load: async (id) => {
      const fixture = fixtures.find(item => item.id === id)
      if (fixture === undefined) throw new Error(`unknown session ${id}`)
      if (fixture.unreadable === true) throw new Error('corrupted log')
      return { events: fixture.turns.flatMap(turn => turnEvents(turn)) }
    },
  }
}

/** 依赖装配：按 cwd 路由到不同分库（user 库既是无 cwd 会话的落点，也是幂等/审计键所在库）。 */
function makeDeps(source: HistoryLogSource | undefined, calls: { count: number; routes?: { provider: string; model: string }[] }): HistoryBackfillDeps {
  return {
    source,
    resolveStore: cwd => storeFor(cwd),
    openUserStore: () => storeFor('user'),
    resolveExistingUserStore: async () => stores.get('user'),
    embedder: Promise.resolve(undefined),
    mode: 'light',
    routeOverride: { provider: 'deepseek', model: 'deepseek-v4' },
    call: async (params) => {
      calls.count += 1
      calls.routes?.push(params.route)
      const content = `提炼事实 ${calls.count}`
      return JSON.stringify([{ kind: 'fact', content, importance: 0.6 }])
    },
    logRequest: () => undefined,
  }
}

const NOW = 1_700_000_000_000

describe('mergeHistoryRules', () => {
  it('未给的字段沿用配置默认值', () => {
    expect(mergeHistoryRules(DEFAULTS, {})).toEqual(DEFAULTS)
  })

  it('覆盖项生效，但总轮数上限受配置硬顶约束（只能调低）', () => {
    const merged = mergeHistoryRules({ ...DEFAULTS, maxTotalTurns: 100 }, { days: 30, maxTurnsPerSession: 5, maxTotalTurns: 999 })
    expect(merged.days).toBe(30)
    expect(merged.maxTurnsPerSession).toBe(5)
    expect(merged.maxTotalTurns).toBe(100)
  })

  it('越界覆盖项抛错（与配置校验同界）', () => {
    expect(() => mergeHistoryRules(DEFAULTS, { days: -1 })).toThrow(/days/)
    expect(() => mergeHistoryRules(DEFAULTS, { maxTurnsPerSession: 0 })).toThrow(/maxTurnsPerSession/)
    expect(() => mergeHistoryRules(DEFAULTS, { maxTotalTurns: 99999 })).toThrow(/maxTotalTurns/)
  })

  it('辅助模型必须成对提供（只给一半是配置错误）', () => {
    expect(() => mergeHistoryRules(DEFAULTS, { provider: 'zai' })).toThrow(/成对/)
    expect(() => mergeHistoryRules(DEFAULTS, { model: 'glm-4.5-air' })).toThrow(/成对/)
    expect(() => mergeHistoryRules(DEFAULTS, { provider: 'zai', model: 'glm-4.5-air' })).not.toThrow()
  })
})

describe('历史回填的辅助模型路由', () => {
  it('未指定时沿用默认路由（配置覆盖 > 当前在用的模型）', async () => {
    const source = makeSource([{ id: 'a', createdAt: NOW - 1000, cwd: '/repo/a', turns: [1] }])
    const calls: { count: number; routes?: { provider: string; model: string }[] } = { count: 0, routes: [] }
    const deps = { ...makeDeps(source, calls), now: () => NOW }
    await runHistoryBackfill(deps, DEFAULTS, {}, () => undefined, new AbortController().signal)
    expect(calls.routes?.[0]).toEqual({ provider: 'deepseek', model: 'deepseek-v4' })
  })

  it('规则里显式指定 provider/model 时覆盖默认路由', async () => {
    const source = makeSource([{ id: 'a', createdAt: NOW - 1000, cwd: '/repo/a', turns: [1] }])
    const calls: { count: number; routes?: { provider: string; model: string }[] } = { count: 0, routes: [] }
    const deps = { ...makeDeps(source, calls), now: () => NOW }
    await runHistoryBackfill(
      deps, DEFAULTS,
      { provider: 'zai', model: 'glm-4.5-air' },
      () => undefined,
      new AbortController().signal,
    )
    expect(calls.routes?.[0]).toEqual({ provider: 'zai', model: 'glm-4.5-air' })
  })
})

describe('estimateHistoryBackfill', () => {
  it('环境不提供会话持久化时返回 unavailable', async () => {
    const estimate = await estimateHistoryBackfill(makeDeps(undefined, { count: 0 }), DEFAULTS)
    expect(estimate.unavailable).toBeDefined()
    expect(estimate.candidates).toBe(0)
  })

  it('按规则排除子代理/种子/无 cwd/超窗会话，并单独计数', async () => {
    const source = makeSource([
      { id: 'keep', createdAt: NOW - 1000, cwd: '/repo/a', turns: [1, 2, 3] },
      { id: 'sub', createdAt: NOW - 1000, cwd: '/repo/a', origin: 'subagent', turns: [1] },
      { id: 'seed', createdAt: NOW - 1000, cwd: '/repo/a', isSeeded: true, turns: [1] },
      { id: 'nocwd', createdAt: NOW - 1000, turns: [1] },
      { id: 'old', createdAt: NOW - 40 * 86_400_000, cwd: '/repo/a', turns: [1] },
    ])
    const deps = { ...makeDeps(source, { count: 0 }), now: () => NOW }
    const estimate = await estimateHistoryBackfill(deps, DEFAULTS)
    expect(estimate.candidates).toBe(1)
    expect(estimate.eligibleTurns).toBe(3)
    expect(estimate.skipped.subagent).toBe(1)
    expect(estimate.skipped.seeded).toBe(1)
    expect(estimate.skipped.noCwd).toBe(1)
    expect(estimate.skipped.tooOld).toBe(1)
  })

  it('单会话取最近 N 轮；总轮数上限截断并标记 truncated', async () => {
    const source = makeSource([
      { id: 'a', createdAt: NOW - 1000, cwd: '/repo/a', turns: [1, 2, 3, 4, 5] },
      { id: 'b', createdAt: NOW - 2000, cwd: '/repo/a', turns: [1, 2, 3, 4, 5] },
    ])
    const deps = { ...makeDeps(source, { count: 0 }), now: () => NOW }
    // 单会话上限 3：每个会话只保留最近的 3 轮。
    const perSession = await estimateHistoryBackfill(deps, DEFAULTS, { maxTurnsPerSession: 3 })
    expect(perSession.eligibleTurns).toBe(6)
    // 总上限 4：只排得下最近一个会话 + 第二个会话的最近 1 轮。
    const total = await estimateHistoryBackfill(deps, DEFAULTS, { maxTotalTurns: 4 })
    expect(total.eligibleTurns).toBe(4)
    expect(total.truncated).toBe(true)
  })

  it('扣掉此前已摄取的轮次（估算只查已存在的库，不新建空库）', async () => {
    const source = makeSource([{ id: 'a', createdAt: NOW - 1000, cwd: '/repo/a', turns: [1, 2] }])
    const deps = { ...makeDeps(source, { count: 0 }), now: () => NOW }
    // 首次估算：目标库还不存在 → 没有已摄取。
    const before = await estimateHistoryBackfill(deps, DEFAULTS)
    expect(before.pendingTurns).toBe(2)
    expect(before.alreadyIngested).toBe(0)
    // 跑一轮摄取后重估：已摄取的 2 轮应被扣掉。
    await runHistoryBackfill(deps, DEFAULTS, {}, () => undefined, new AbortController().signal)
    const after = await estimateHistoryBackfill(deps, DEFAULTS)
    expect(after.alreadyIngested).toBe(2)
    expect(after.pendingTurns).toBe(0)
  })
})

describe('runHistoryBackfill', () => {
  it('逐轮摄取并写入会话 cwd 对应的项目库（不是当前库）', async () => {
    const source = makeSource([
      { id: 'a', createdAt: NOW - 1000, cwd: '/repo/alpha', turns: [1, 2] },
      { id: 'b', createdAt: NOW - 2000, cwd: '/repo/beta', turns: [1] },
    ])
    const calls = { count: 0 }
    const deps = { ...makeDeps(source, calls), now: () => NOW }
    const progress: number[] = []
    const result = await runHistoryBackfill(deps, DEFAULTS, {}, p => { progress.push(p.turnsDone) }, new AbortController().signal)
    expect(result.state).toBe('done')
    expect(result.sessionsDone).toBe(2)
    expect(result.turnsDone).toBe(3)
    expect(result.memoriesWritten).toBe(3)
    expect(calls.count).toBe(3)
    // 各自落在自己 cwd 的库：alpha 2 条、beta 1 条，且 scope 标记为 project。
    const alpha = await storeFor('/repo/alpha')
    const beta = await storeFor('/repo/beta')
    const alphaRecords = await alpha.topActive('project', 10)
    expect(alphaRecords).toHaveLength(2)
    expect(alphaRecords[0]?.sourceSessionId).toBe('a')
    expect(await beta.topActive('project', 10)).toHaveLength(1)
    // 进度回调被调用（含结束态）。
    expect(progress.length).toBeGreaterThan(0)
    // 幂等键固定在 user 库：与实时路径共用一份 (会话,轮次) 键，跨路径不重复摄取。
    const userStore = await storeFor('user')
    expect(await userStore.hasAudit(INGEST_DONE_OP, encodeTurnKey('a', 1))).toBe(true)
    expect(await alpha.hasAudit(INGEST_DONE_OP, encodeTurnKey('a', 1))).toBe(false)
  })

  it('回填同样采纳模型的逐条 scope：跨项目通用的个人偏好落私人宫殿', async () => {
    const source = makeSource([{ id: 'a', createdAt: NOW - 1000, cwd: '/repo/alpha', turns: [1] }])
    const deps = {
      ...makeDeps(source, { count: 0 }),
      now: () => NOW,
      call: async () => JSON.stringify([
        { kind: 'decision', content: '项目约定：发布前跑全量测试', scope: 'project', importance: 0.7 },
        { kind: 'preference', content: '用户偏好简体中文回复', scope: 'user', importance: 0.8 },
      ]),
    }
    const result = await runHistoryBackfill(deps, DEFAULTS, {}, () => undefined, new AbortController().signal)
    expect(result.memoriesWritten).toBe(2)
    // project 落会话 cwd 的项目库，user 落私人库。
    const alpha = await storeFor('/repo/alpha')
    expect((await alpha.topActive('project', 10)).map(record => record.content)).toEqual(['项目约定：发布前跑全量测试'])
    const userStore = await storeFor('user')
    expect((await userStore.topActive('user', 10)).map(record => record.content)).toContain('用户偏好简体中文回复')
  })

  it('回填的条目不进 SM-2 复习队列（否则一次性回填会淹没今日待回忆）', async () => {
    const source = makeSource([{ id: 'a', createdAt: NOW - 1000, cwd: '/repo/a', turns: [1] }])
    const deps = { ...makeDeps(source, { count: 0 }), now: () => NOW }
    await runHistoryBackfill(deps, DEFAULTS, {}, () => undefined, new AbortController().signal)
    const store = await storeFor('/repo/a')
    const records = await store.topActive('project', 10)
    expect(records[0]?.review).toBeUndefined()
    expect(await store.dueReviews(Date.now(), 10)).toHaveLength(0)
  })

  it('重跑幂等：已完成的轮次跳过，不再调 LLM', async () => {
    const source = makeSource([{ id: 'a', createdAt: NOW - 1000, cwd: '/repo/a', turns: [1, 2] }])
    const calls = { count: 0 }
    const deps = { ...makeDeps(source, calls), now: () => NOW }
    await runHistoryBackfill(deps, DEFAULTS, {}, () => undefined, new AbortController().signal)
    expect(calls.count).toBe(2)
    const second = await runHistoryBackfill(deps, DEFAULTS, {}, () => undefined, new AbortController().signal)
    expect(second.memoriesWritten).toBe(0)
    expect(second.turnsSkipped).toBe(2)
    // 跳过原因可解释：重跑时两轮都因「已摄取」跳过。
    expect(second.skipReasons['already-ingested']).toBe(2)
    expect(calls.count).toBe(2)
    expect(await (await storeFor('/repo/a')).topActive('project', 10)).toHaveLength(2)
  })

  it('单轮失败只记录并继续，整批不中断', async () => {
    const source = makeSource([{ id: 'a', createdAt: NOW - 1000, cwd: '/repo/a', turns: [1, 2] }])
    const deps = {
      ...makeDeps(source, { count: 0 }),
      now: () => NOW,
      call: async (params: { userText: string }) => {
        // 第二轮让辅助调用抛错（模拟限流/超时）。
        if (params.userText.includes('第 2 轮')) throw new Error('rate limited')
        return JSON.stringify([{ kind: 'fact', content: '提炼事实', importance: 0.6 }])
      },
    }
    const result = await runHistoryBackfill(deps, DEFAULTS, {}, () => undefined, new AbortController().signal)
    expect(result.state).toBe('done')
    expect(result.turnsFailed).toBe(1)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]?.turn).toBe(2)
    expect(result.failures[0]?.reason).toContain('rate limited')
    // 第 1 轮照常写入。
    expect(result.memoriesWritten).toBe(1)
  })

  it('暂停信号在轮次之间生效，已完成的部分保留', async () => {
    const source = makeSource([{ id: 'a', createdAt: NOW - 1000, cwd: '/repo/a', turns: [1, 2, 3] }])
    const controller = new AbortController()
    const deps = {
      ...makeDeps(source, { count: 0 }),
      now: () => NOW,
      call: async () => {
        // 第一轮完成后请求中止。
        controller.abort()
        return JSON.stringify([{ kind: 'fact', content: '提炼事实', importance: 0.6 }])
      },
    }
    const result = await runHistoryBackfill(deps, DEFAULTS, {}, () => undefined, controller.signal)
    expect(result.state).toBe('cancelled')
    expect(result.turnsDone).toBeLessThan(3)
  })

  it('损坏的会话日志被跳过，不影响其余会话', async () => {
    const source = makeSource([
      { id: 'bad', createdAt: NOW - 1000, cwd: '/repo/a', turns: [1], unreadable: true },
      { id: 'good', createdAt: NOW - 2000, cwd: '/repo/a', turns: [1] },
    ])
    const deps = { ...makeDeps(source, { count: 0 }), now: () => NOW }
    const estimate = await estimateHistoryBackfill(deps, DEFAULTS)
    expect(estimate.candidates).toBe(1)
    expect(estimate.skipped.unreadable).toBe(1)
    const result = await runHistoryBackfill(deps, DEFAULTS, {}, () => undefined, new AbortController().signal)
    expect(result.memoriesWritten).toBe(1)
  })

  it('低活动轮次被节流跳过（不调 LLM）', async () => {
    // 短用户输入 + 无助手消息 → 活动评分 0，低于阈值。
    const source: HistoryLogSource = {
      list: async () => [{ id: 'low', createdAt: NOW - 1000, cwd: '/repo/a' }],
      load: async () => ({
        events: [
          { type: 'turn/start', data: { turn: 1 }, seq: 1, time: NOW },
          { type: 'user/message', data: { content: [{ type: 'text', text: '好的' }] }, seq: 2, time: NOW },
        ],
      }),
    }
    const calls = { count: 0 }
    const deps = { ...makeDeps(source, calls), now: () => NOW }
    const result = await runHistoryBackfill(deps, DEFAULTS, {}, () => undefined, new AbortController().signal)
    expect(calls.count).toBe(0)
    expect(result.memoriesWritten).toBe(0)
    expect(result.turnsSkipped).toBe(1)
    // 跳过原因要能解释「为什么没写东西」。
    expect(result.skipReasons['low-activity']).toBe(1)
  })
})
