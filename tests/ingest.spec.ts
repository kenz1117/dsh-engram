import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  INGEST_DONE_OP, INGEST_PENDING_OP, encodeTurnKey, ingestFinalTurn, ingestPreviousTurn,
  lastTurnSlice, markPendingIngest, previousTurnSlice, replayPendingIngests, turnSlice,
} from '../src/ingest/hook.ts'
import type { IngestRequestEventData } from '../src/ingest/hook.ts'
import { openEngramStore } from '../src/store/sqlite.ts'
import type { EngramStore } from '../src/store/interface.ts'

let dir: string
let store: EngramStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'engram-ingest-'))
  store = await openEngramStore(join(dir, 'user.db'))
})
afterEach(async () => {
  await store.close()
})

/** 会话事件构造器（形状对齐 harness 日志事件的运行时窄化视图）。 */
const turnStart = (turn: number) => ({ type: 'turn/start', data: { turn }, time: Date.now(), seq: turn * 100 })
const userMsg = (text: string, seq: number) => ({
  type: 'user/message',
  data: { content: [{ type: 'text', text }] },
  time: Date.now(),
  seq,
})
const pluginMsg = (text: string, seq: number) => ({
  type: 'user/message',
  data: { source: { kind: 'plugin', plugin: 'time-context' }, content: [{ type: 'text', text }] },
  time: Date.now(),
  seq,
})
const assistantMsg = (text: string, seq: number) => ({
  type: 'assistant/message',
  data: { content: [{ type: 'text', text }] },
  time: Date.now(),
  seq,
})
const routeHeader = (seq: number) => ({
  type: 'request/header',
  data: { header: { config: { provider: 'deepseek', model: 'deepseek-v4-flash' } } },
  time: Date.now(),
  seq,
})

const VALID_LLM_OUTPUT = JSON.stringify([
  { content: '用户最喜欢的编程语言是 TypeScript', kind: 'preference', importance: 0.8 },
  { content: '用户在开发 dsh-engram 记忆插件', kind: 'fact', importance: 0.7 },
])

const baseDeps = (overrides?: Partial<Parameters<typeof ingestPreviousTurn>[0]>) => ({
  events: [
    turnStart(1),
    userMsg('我最喜欢 TypeScript', 3),
    routeHeader(4),
    turnStart(2),
    userMsg('现在的问题', 200),
  ],
  sessionId: 'sess-ingest-1',
  turn: 2,
  openStore: async () => store,
  embedder: Promise.resolve(undefined),
  mode: 'light' as const,
  routeOverride: undefined,
  call: async () => VALID_LLM_OUTPUT,
  logRequest: (_data: IngestRequestEventData) => undefined,
  signal: new AbortController().signal,
  ...overrides,
})

describe('previousTurnSlice', () => {
  it('不足两轮时为空', () => {
    expect(previousTurnSlice([turnStart(1), userMsg('x', 1)])).toHaveLength(0)
    expect(previousTurnSlice([])).toHaveLength(0)
  })

  it('切到最后一个 turn/start 之前的整轮', () => {
    const slice = previousTurnSlice([
      turnStart(1),
      userMsg('第一轮内容', 2),
      assistantMsg('第一轮回答', 3),
      turnStart(2),
      userMsg('第二轮内容', 200),
    ])
    expect(slice).toHaveLength(3)
  })
})

describe('ingestPreviousTurn', () => {
  it('light 模式从用户消息提取并写入，记录来源归属', async () => {
    const logged: IngestRequestEventData[] = []
    const outcome = await ingestPreviousTurn(baseDeps({
      logRequest: data => logged.push(data),
    }))
    expect(outcome.written).toBe(2)
    expect(outcome.skipped).toBeNull()
    expect(logged).toHaveLength(1)
    expect(logged[0]!.route).toEqual({ provider: 'deepseek', model: 'deepseek-v4-flash' })
    expect(logged[0]!.round).toBe(1)
    const rows = await store.topActive('user', 10)
    expect(rows.some(record => record.content === '用户最喜欢的编程语言是 TypeScript')).toBe(true)
    const withRound = rows.find(record => record.content === '用户在开发 dsh-engram 记忆插件')
    expect(withRound?.sourceSessionId).toBe('sess-ingest-1')
    expect(withRound?.sourceRound).toBe(1)
    expect(withRound?.sourceSeq).toBe(3)
    expect(withRound?.confidence).toBeCloseTo(0.3, 5)
  })

  it('light 模式不读助手消息、跳过插件注入快照', async () => {
    const seen: string[] = []
    await ingestPreviousTurn(baseDeps({
      events: [
        turnStart(1),
        pluginMsg('User memory profile (dsh-engram):', 2),
        userMsg('真实用户输入', 3),
        assistantMsg('助手长回答内容', 4),
        routeHeader(5),
        turnStart(2),
        userMsg('现在的问题', 200),
      ],
      call: async params => {
        seen.push(params.userText)
        return JSON.stringify([{ content: '一条记忆', kind: 'fact', importance: 0.5 }])
      },
    }))
    expect(seen[0]).toContain('真实用户输入')
    expect(seen[0]).not.toContain('助手长回答内容')
    expect(seen[0]).not.toContain('User memory profile')
  })

  it('eager 模式包含助手消息', async () => {
    let userText = ''
    await ingestPreviousTurn(baseDeps({
      mode: 'eager',
      events: [
        turnStart(1),
        userMsg('用户输入', 2),
        assistantMsg('助手关键结论', 3),
        routeHeader(4),
        turnStart(2),
        userMsg('现在的问题', 200),
      ],
      call: async params => {
        userText = params.userText
        return JSON.stringify([{ content: '来自助手的记忆', kind: 'fact', importance: 0.5 }])
      },
    }))
    expect(userText).toContain('助手关键结论')
  })

  it('日志无路由时跳过', async () => {
    const outcome = await ingestPreviousTurn(baseDeps({
      events: [turnStart(1), userMsg('内容', 2), turnStart(2), userMsg('现在', 200)],
    }))
    expect(outcome.skipped).toBe('no-route-in-log')
    expect(outcome.written).toBe(0)
  })

  it('LLM 输出不可解析时跳过', async () => {
    const outcome = await ingestPreviousTurn(baseDeps({ call: async () => '这不是 JSON' }))
    expect(outcome.skipped).toBe('unparseable-output')
    expect(outcome.written).toBe(0)
  })

  it('路由覆盖优先于日志解析', async () => {
    const logged: IngestRequestEventData[] = []
    await ingestPreviousTurn(baseDeps({
      routeOverride: { provider: 'zai', model: 'glm-5.2' },
      logRequest: data => logged.push(data),
    }))
    expect(logged[0]!.route).toEqual({ provider: 'zai', model: 'glm-5.2' })
  })

  it('同批重复内容只写一次', async () => {
    const outcome = await ingestPreviousTurn(baseDeps({
      call: async () => JSON.stringify([
        { content: '同一条记忆', kind: 'fact', importance: 0.5 },
        { content: '同一条记忆', kind: 'fact', importance: 0.5 },
      ]),
    }))
    expect(outcome.written).toBe(1)
  })

  it('档位上限生效：light 最多 2 条', async () => {
    const outcome = await ingestPreviousTurn(baseDeps({
      mode: 'light',
      call: async () => JSON.stringify([
        { content: '甲', kind: 'fact', importance: 0.5 },
        { content: '乙', kind: 'fact', importance: 0.5 },
        { content: '丙', kind: 'fact', importance: 0.5 },
      ]),
    }))
    expect(outcome.written).toBe(2)
  })

  it('幂等：同一 (sessionId, turn) 重复摄取直接跳过', async () => {
    const first = await ingestPreviousTurn(baseDeps())
    expect(first.written).toBe(2)
    const second = await ingestPreviousTurn(baseDeps())
    expect(second.skipped).toBe('already-ingested')
    expect(second.written).toBe(0)
    expect(await store.hasAudit(INGEST_DONE_OP, encodeTurnKey('sess-ingest-1', 1))).toBe(true)
    // 库里仍只有第一批（无重复写入）。
    expect((await store.topActive('user', 10)).length).toBe(2)
  })

  it('normal 与 disposed 路径互不重复：末轮已摄取后，恢复会话的上一轮摄取跳过', async () => {
    const events = [
      turnStart(1),
      userMsg('第一轮内容', 2),
      routeHeader(3),
      turnStart(2),
      userMsg('末轮内容', 200),
    ]
    // disposed 路径摄取末轮（turn 2）。
    const finalOutcome = await ingestPreviousTurn(baseDeps({ events, turn: 2, slice: 'last' }))
    expect(finalOutcome.written).toBe(2)
    // 会话恢复继续 turn 3，normal 路径要摄取的上一轮正是 turn 2 → 幂等跳过。
    const resumed = [...events, turnStart(3), userMsg('新一轮', 300)]
    const outcome = await ingestPreviousTurn(baseDeps({ events: resumed, turn: 3 }))
    expect(outcome.skipped).toBe('already-ingested')
    expect(outcome.written).toBe(0)
  })
})

describe('末轮切片', () => {
  it('lastTurnSlice 切最后一个 turn/start 到日志末尾', () => {
    const slice = lastTurnSlice([
      turnStart(1),
      userMsg('第一轮', 2),
      turnStart(2),
      userMsg('末轮', 200),
      assistantMsg('末轮回答', 201),
    ])
    expect(slice).toHaveLength(3)
    expect(slice[0]!.type).toBe('turn/start')
    expect(lastTurnSlice([userMsg('无轮次', 1)])).toHaveLength(0)
  })

  it('turnSlice 切指定轮次到下一轮边界', () => {
    const events = [
      turnStart(1),
      userMsg('第一轮', 2),
      turnStart(2),
      userMsg('第二轮', 200),
      turnStart(3),
      userMsg('第三轮', 300),
    ]
    expect(turnSlice(events, 2)).toHaveLength(2)
    expect(turnSlice(events, 3)).toHaveLength(2)
    expect(turnSlice(events, 9)).toHaveLength(0)
  })
})

describe('ingestFinalTurn', () => {
  const finalEvents = [
    turnStart(1),
    userMsg('第一轮', 2),
    routeHeader(3),
    turnStart(2),
    userMsg('末轮用户输入', 200),
  ]

  it('摄取末轮并写 done 键', async () => {
    const outcome = await ingestFinalTurn(baseDeps({ events: finalEvents, turn: 2 }))
    expect(outcome?.written).toBe(2)
    expect(await store.hasAudit(INGEST_DONE_OP, encodeTurnKey('sess-ingest-1', 2))).toBe(true)
  })

  it('超时/失败落 pending 键，不抛出', async () => {
    const outcome = await ingestFinalTurn(baseDeps({
      events: finalEvents,
      turn: 2,
      call: ({ signal }) => new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')))
      }),
      signal: AbortSignal.timeout(50),
    }))
    expect(outcome).toBeNull()
    expect(await store.hasAudit(INGEST_PENDING_OP, encodeTurnKey('sess-ingest-1', 2))).toBe(true)
    // 重复失败不重复落 pending。
    await markPendingIngest(store, 'sess-ingest-1', 2)
    expect((await store.listAuditDetails(INGEST_PENDING_OP)).length).toBe(1)
  })

  it('无 turn/start 时不摄取也不落 pending', async () => {
    const outcome = await ingestFinalTurn(baseDeps({ events: [userMsg('孤儿消息', 1)] }))
    expect(outcome).toBeNull()
    expect((await store.listAuditDetails(INGEST_PENDING_OP)).length).toBe(0)
  })
})

describe('replayPendingIngests', () => {
  const replayDeps = (overrides?: Partial<Parameters<typeof replayPendingIngests>[0]>) => ({
    openStore: async () => store,
    resolveEvents: async () => undefined,
    embedder: Promise.resolve(undefined),
    mode: 'light' as const,
    routeOverride: undefined,
    call: async () => VALID_LLM_OUTPUT,
    logRequest: (_data: IngestRequestEventData) => undefined,
    signal: new AbortController().signal,
    ...overrides,
  })

  const pendingEvents = [
    turnStart(1),
    userMsg('旧会话第一轮', 2),
    routeHeader(3),
    turnStart(2),
    userMsg('旧会话末轮输入', 200),
  ]

  it('重放补做：摄取写入、pending 出队、done 落键', async () => {
    await markPendingIngest(store, 'sess-old', 2)
    const outcome = await replayPendingIngests(replayDeps({
      resolveEvents: async sessionId => sessionId === 'sess-old' ? pendingEvents : undefined,
    }))
    expect(outcome).toEqual({ replayed: 1, kept: 0 })
    expect((await store.listAuditDetails(INGEST_PENDING_OP)).length).toBe(0)
    expect(await store.hasAudit(INGEST_DONE_OP, encodeTurnKey('sess-old', 2))).toBe(true)
    const rows = await store.topActive('user', 10)
    expect(rows.some(record => record.sourceSessionId === 'sess-old' && record.sourceRound === 2)).toBe(true)
    // 再次重放：pending 已出队，无动作。
    expect(await replayPendingIngests(replayDeps())).toEqual({ replayed: 0, kept: 0 })
  })

  it('事件源不可得的 pending 保留到下次', async () => {
    await markPendingIngest(store, 'sess-gone', 3)
    const outcome = await replayPendingIngests(replayDeps())
    expect(outcome).toEqual({ replayed: 0, kept: 1 })
    expect((await store.listAuditDetails(INGEST_PENDING_OP)).length).toBe(1)
  })

  it('已有 done 标记或键损坏的 pending 直接出队', async () => {
    await markPendingIngest(store, 'sess-done', 1)
    await store.audit(INGEST_DONE_OP, 'sess-done', encodeTurnKey('sess-done', 1))
    await store.audit(INGEST_PENDING_OP, 'BROKEN', '没有分隔符的坏键')
    const outcome = await replayPendingIngests(replayDeps())
    expect(outcome).toEqual({ replayed: 0, kept: 0 })
    expect((await store.listAuditDetails(INGEST_PENDING_OP)).length).toBe(0)
  })
})
