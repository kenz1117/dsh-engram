import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ingestPreviousTurn, previousTurnSlice } from '../src/ingest/hook.ts'
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
})
