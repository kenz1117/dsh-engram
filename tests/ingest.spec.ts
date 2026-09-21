import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ACTIVITY_THRESHOLD, INGEST_DONE_OP, INGEST_PENDING_OP, activityScore, encodeTurnKey, ensureSessionSummary, ingestFinalTurn,
  ingestPreviousTurn, ingestWriteRouting, isChitchat, forbidsCapture, lastTurnNumber, lastTurnSlice, markPendingIngest,
  previousTurnSlice, replayPendingIngests, throttleDecision, turnSlice, turnSignals,
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
const toolCall = (callId: string, name: string, seq: number) => ({
  type: 'tool/call', data: { callId, name, arguments: '{}' }, time: Date.now(), seq,
})
const toolResult = (callId: string, seq: number) => ({
  type: 'tool/result', data: { callId, isError: false }, time: Date.now(), seq,
})
const routeHeader = (seq: number) => ({
  type: 'request/header',
  data: { header: { config: { provider: 'deepseek', model: 'deepseek-v4-flash' } } },
  time: Date.now(),
  seq,
})

/** 长填充文本：把用户消息垫到 ≥150 字符（活动评分 userChars 满档 3 分）。 */
const PAD = '上下文填充。'.repeat(30)

/** 一轮「有实质活动」的上一轮事件（活动评分 6 分，越过摄取门槛）。 */
const substantiveTurn1 = () => [
  turnStart(1),
  userMsg(`我最喜欢 TypeScript。${PAD}`, 3),
  toolCall('c1', 'fs_read', 4),
  toolResult('c1', 5),
  toolCall('c2', 'web_search', 6),
  toolResult('c2', 7),
  assistantMsg('助手的完整回答', 8),
  routeHeader(9),
]

const VALID_LLM_OUTPUT = JSON.stringify([
  { content: '用户最喜欢的编程语言是 TypeScript', kind: 'preference', importance: 0.8 },
  { content: '用户在开发 dsh-engram 记忆插件', kind: 'fact', importance: 0.7 },
])

const baseDeps = (overrides?: Partial<Parameters<typeof ingestPreviousTurn>[0]>) => ({
  events: [...substantiveTurn1(), turnStart(2), userMsg('现在的问题', 200)],
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
        userMsg(`真实用户输入。${PAD}`, 3),
        assistantMsg('助手长回答内容', 4),
        toolCall('c1', 'fs_read', 5),
        toolResult('c1', 6),
        toolCall('c2', 'web_search', 7),
        toolResult('c2', 8),
        routeHeader(9),
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
        userMsg(`用户输入。${PAD}`, 2),
        assistantMsg('助手关键结论', 3),
        toolCall('c1', 'fs_read', 4),
        toolResult('c1', 5),
        toolCall('c2', 'web_search', 6),
        toolResult('c2', 7),
        routeHeader(8),
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
      events: [
        turnStart(1),
        userMsg(`内容。${PAD}`, 2),
        assistantMsg('回答内容', 3),
        toolCall('c1', 'fs_read', 4),
        toolResult('c1', 5),
        toolCall('c2', 'web_search', 6),
        toolResult('c2', 7),
        turnStart(2),
        userMsg('现在', 200),
      ],
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

describe('摄取节流', () => {
  it('activityScore 四信号计分与封顶', () => {
    expect(activityScore({ userChars: 0, completedTurns: 0, toolResults: 0, toolNames: new Set() })).toBe(0)
    expect(activityScore({ userChars: 300, completedTurns: 1, toolResults: 10, toolNames: new Set(['a', 'b', 'c']) })).toBe(8)
    // userChars 封顶 3 分（150 字符即满档），toolResults 封顶 2 分（10 条即满档），多样性 1-2 种工具 1 分。
    expect(activityScore({ userChars: 150, completedTurns: 0, toolResults: 10, toolNames: new Set(['a', 'b']) })).toBe(6)
    expect(activityScore({ userChars: 149, completedTurns: 0, toolResults: 4, toolNames: new Set(['a']) })).toBe(3)
  })

  it('isChitchat 只匹配纯寒暄，forbidsCapture 匹配显式禁记', () => {
    expect(isChitchat('你好')).toBe(true)
    expect(isChitchat('Hello!')).toBe(true)
    expect(isChitchat('谢谢，辛苦了')).toBe(false)
    expect(isChitchat('你好，帮我看看这个报错')).toBe(false)
    expect(forbidsCapture('这些是临时调试信息，不要记住这一轮的内容')).toBe(true)
    expect(forbidsCapture('don\'t save that it is sensitive')).toBe(true)
    expect(forbidsCapture('请记住我的部署端口是 4000')).toBe(false)
  })

  it('throttleDecision：低活动/寒暄/禁记分别命中对应原因，实质轮放行', () => {
    // 低活动：短消息 + 无工具 + 无助手回复。
    const low = [turnStart(1), userMsg('我最喜欢 TypeScript', 2), turnStart(2)]
    expect(throttleDecision(low)).toBe('low-activity')
    // 寒暄：活动分足够（助手 1 + 10 次工具结果 2 + 3 种工具 2 = 5 分），但用户文本是纯问候。
    const greeting = [
      turnStart(1),
      userMsg('你好', 2),
      assistantMsg('你好！有什么可以帮你？', 3),
      toolCall('c1', 'fs_read', 4), toolResult('c1', 5),
      toolCall('c2', 'fs_read', 6), toolResult('c2', 7),
      toolCall('c3', 'web_search', 8), toolResult('c3', 9),
      toolCall('c4', 'shell_run', 10), toolResult('c4', 11),
      toolCall('c5', 'shell_run', 12), toolResult('c5', 13),
      toolCall('c6', 'shell_run', 14), toolResult('c6', 15),
      toolCall('c7', 'web_search', 16), toolResult('c7', 17),
      toolCall('c8', 'fs_read', 18), toolResult('c8', 19),
      toolCall('c9', 'web_search', 20), toolResult('c9', 21),
      toolCall('c10', 'fs_read', 22), toolResult('c10', 23),
      turnStart(2),
    ]
    expect(throttleDecision(greeting)).toBe('chitchat')
    // 禁记：活动分足够，用户显式要求不要记。
    const forbidden = [
      turnStart(1),
      userMsg(`临时调试输出，不要记住这些内容。${PAD}`, 2),
      assistantMsg('好的，已忽略。', 3),
      toolCall('c1', 'fs_read', 4), toolResult('c1', 5),
      toolCall('c2', 'web_search', 6), toolResult('c2', 7),
      turnStart(2),
    ]
    expect(throttleDecision(forbidden)).toBe('capture-forbidden')
    // 实质轮放行。
    expect(throttleDecision(substantiveTurn1())).toBeNull()
  })

  it('集成：低活动轮摄取直接跳过且不写库、不调 LLM', async () => {
    let called = 0
    const outcome = await ingestPreviousTurn(baseDeps({
      events: [turnStart(1), userMsg('我最喜欢 TypeScript', 2), turnStart(2), userMsg('现在的问题', 200)],
      call: async () => { called += 1; return VALID_LLM_OUTPUT },
    }))
    expect(outcome.skipped).toBe('low-activity')
    expect(outcome.written).toBe(0)
    expect(called).toBe(0)
    expect(await store.topActive('user', 10)).toHaveLength(0)
  })

  it('活动门槛常量为 5（协议内定值）', () => {
    expect(ACTIVITY_THRESHOLD).toBe(5)
  })

  it('turnSignals 统计用户字符与工具信号，跳过插件注入快照', () => {
    const signals = turnSignals(substantiveTurn1())
    expect(signals.completedTurns).toBe(1)
    expect(signals.toolResults).toBe(2)
    expect(signals.toolNames).toEqual(new Set(['fs_read', 'web_search']))
    const withPlugin = turnSignals([pluginMsg('注入快照'.repeat(50), 1), ...substantiveTurn1()])
    expect(withPlugin.userChars).toBe(signals.userChars)
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

  it('事件源不可用（undefined）时按空日志处理，不抛 TypeError', () => {
    // 会话 dispose 后事件源已 detach，宿主可能给不出日志：此处曾抛 TypeError，
    // 从 fire-and-forget 的 disposed 观察器逃逸成未处理 rejection，被宿主 fail-loud 当致命错误退出进程。
    expect(lastTurnSlice(undefined as never)).toHaveLength(0)
    expect(previousTurnSlice(undefined as never)).toHaveLength(0)
    expect(lastTurnNumber(undefined as never)).toBeUndefined()
    expect(turnSlice(undefined as never, 1)).toHaveLength(0)
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

  it('事件源不可用（undefined）时静默返回 null：不抛、不落 pending', async () => {
    // dispose 后事件源已 detach：既拿不到末轮内容也拿不到轮次号，无法建 pending 键，只跳过。
    // 关键契约是「不 reject」——逃逸的 rejection 会让宿主 fail-loud 直接退出进程。
    const outcome = await ingestFinalTurn(baseDeps({ events: undefined as never }))
    expect(outcome).toBeNull()
    expect((await store.listAuditDetails(INGEST_PENDING_OP)).length).toBe(0)
  })
})

describe('ensureSessionSummary', () => {
  const summaryEvents = [
    turnStart(1),
    userMsg('帮我排查部署失败的问题', 2),
    assistantMsg('定位到是环境变量缺失，修复后部署成功', 3),
    routeHeader(4),
  ]

  const summaryDeps = (overrides?: Partial<Parameters<typeof ensureSessionSummary>[0]>) => ({
    events: summaryEvents,
    sessionId: 'sess-ingest-1',
    openStore: async () => store,
    call: async () => '围绕部署排查修复环境变量缺失的一场会话',
    logRequest: (_data: IngestRequestEventData) => undefined,
    mode: 'light' as const,
    routeOverride: undefined,
    signal: new AbortController().signal,
    round: 1,
    ...overrides,
  })

  it('生成摘要落库，请求日志挂在给定轮次上', async () => {
    const logged: IngestRequestEventData[] = []
    await ensureSessionSummary(summaryDeps({ logRequest: data => logged.push(data) }))
    expect(await store.getSessionSummary('sess-ingest-1')).toBe('围绕部署排查修复环境变量缺失的一场会话')
    expect(logged).toHaveLength(1)
    expect(logged[0]?.round).toBe(1)
    expect(logged[0]?.maxTokens).toBe(160)
    expect(logged[0]?.mode).toBe('light')
  })

  it('已有摘要时幂等跳过，不再起 LLM 调用', async () => {
    await store.setSessionSummary('sess-ingest-1', '既有摘要')
    let calls = 0
    await ensureSessionSummary(summaryDeps({ call: async () => { calls += 1; return '新摘要' } }))
    expect(calls).toBe(0)
    expect(await store.getSessionSummary('sess-ingest-1')).toBe('既有摘要')
  })

  it('LLM 失败静默：不抛出、不写摘要', async () => {
    await ensureSessionSummary(summaryDeps({ call: async () => { throw new Error('限流') } }))
    expect(await store.getSessionSummary('sess-ingest-1')).toBeUndefined()
  })

  it('无可用路由或整场无对话文本（仅插件注入快照）时跳过', async () => {
    let calls = 0
    const counting = async (): Promise<string> => { calls += 1; return '不应发生' }
    // 无 routeHeader 且无路由覆盖：路由解析失败跳过。
    await ensureSessionSummary(summaryDeps({ events: [turnStart(1), userMsg('你好', 2)], call: counting }))
    // 只有插件注入快照：对话文本为空跳过。
    await ensureSessionSummary(summaryDeps({ events: [turnStart(1), pluginMsg('系统上下文', 2)], call: counting }))
    expect(calls).toBe(0)
    expect(await store.getSessionSummary('sess-ingest-1')).toBeUndefined()
  })
})

describe('ingestWriteRouting', () => {
  const openProject = async () => store
  const openScope = async () => store

  it('有 cwd：默认项目宫殿、逐条采纳模型 scope，user 落按作用域解析的分库', async () => {
    const routing = ingestWriteRouting('/repo/x', openProject, openScope)
    expect(routing.writeScope).toBe('project')
    expect(routing.perCandidateScope).toBe(true)
    expect(await routing.resolveStore!('project')).toBe(store)
    expect(await routing.resolveStore!('user')).toBe(store)
  })

  it('无 cwd：只能进私人宫殿，关掉逐条判定（否则 project 标记落 user 库后检索不可见）', () => {
    expect(ingestWriteRouting(undefined, openProject, openScope)).toEqual({ writeScope: 'user', perCandidateScope: false })
    expect(ingestWriteRouting('', openProject, openScope)).toEqual({ writeScope: 'user', perCandidateScope: false })
  })
})

describe('逐条判宫殿（写入分库路由）', () => {
  it('采纳模型 scope：project 落项目库、user 落私人库；幂等键固定在审计库', async () => {
    const projectStore = await openEngramStore(join(dir, 'routed-project.db'))
    try {
      const outcome = await ingestPreviousTurn(baseDeps({
        perCandidateScope: true,
        writeScope: 'project',
        resolveStore: async scope => (scope === 'project' ? projectStore : store),
        openAuditStore: async () => store,
        call: async () => JSON.stringify([
          { content: '项目约定：提交信息用中文', kind: 'decision', scope: 'project', importance: 0.7 },
          { content: '用户偏好简体中文回复', kind: 'preference', scope: 'user', importance: 0.8 },
        ]),
      }))
      expect(outcome.written).toBe(2)
      const project = await projectStore.topActive('project', 10)
      expect(project.map(record => record.content)).toEqual(['项目约定：提交信息用中文'])
      expect(project[0]?.scope).toBe('project')
      const personal = await store.topActive('user', 10)
      expect(personal.map(record => record.content)).toContain('用户偏好简体中文回复')
      // 幂等键是会话级的：只落审计库（这里就是写入 user 库所用的那个库），不落写入库。
      expect(await store.hasAudit(INGEST_DONE_OP, encodeTurnKey('sess-ingest-1', 1))).toBe(true)
      expect(await projectStore.hasAudit(INGEST_DONE_OP, encodeTurnKey('sess-ingest-1', 1))).toBe(false)
    } finally {
      await projectStore.close()
    }
  })

  it('模型 scope 非法（shared）或缺失时回退默认作用域', async () => {
    const projectStore = await openEngramStore(join(dir, 'routed-project-2.db'))
    try {
      const outcome = await ingestPreviousTurn(baseDeps({
        perCandidateScope: true,
        writeScope: 'project',
        resolveStore: async () => projectStore,
        call: async () => JSON.stringify([
          { content: '非法 scope 的候选', kind: 'fact', scope: 'shared', importance: 0.5 },
          { content: '缺 scope 的候选', kind: 'fact', importance: 0.5 },
        ]),
      }))
      expect(outcome.written).toBe(2)
      expect(await projectStore.topActive('project', 10)).toHaveLength(2)
    } finally {
      await projectStore.close()
    }
  })

  it('perCandidateScope 关闭（历史回填的旧口径）时模型 scope 不生效', async () => {
    const outcome = await ingestPreviousTurn(baseDeps({
      perCandidateScope: false,
      writeScope: 'user',
      call: async () => JSON.stringify([{ content: '模型标了 project 但被忽略', kind: 'fact', scope: 'project' }]),
    }))
    expect(outcome.written).toBe(1)
    expect((await store.topActive('user', 10)).some(record => record.content === '模型标了 project 但被忽略')).toBe(true)
  })
})

describe('replayPendingIngests', () => {
  const replayDeps = (overrides?: Partial<Parameters<typeof replayPendingIngests>[0]>) => ({
    openStore: async () => store,
    resolveSession: async () => undefined,
    resolveStore: async () => store,
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
      resolveSession: async sessionId => (sessionId === 'sess-old' ? { events: pendingEvents } : undefined),
    }))
    expect(outcome).toEqual({ replayed: 1, kept: 0 })
    expect((await store.listAuditDetails(INGEST_PENDING_OP)).length).toBe(0)
    expect(await store.hasAudit(INGEST_DONE_OP, encodeTurnKey('sess-old', 2))).toBe(true)
    const rows = await store.topActive('user', 10)
    expect(rows.some(record => record.sourceSessionId === 'sess-old' && record.sourceRound === 2)).toBe(true)
    // 再次重放：pending 已出队，无动作。
    expect(await replayPendingIngests(replayDeps())).toEqual({ replayed: 0, kept: 0 })
  })

  it('按待补做会话自己的 cwd 落项目库（补做同样逐条判宫殿）', async () => {
    const projectStore = await openEngramStore(join(dir, 'replay-project.db'))
    try {
      await markPendingIngest(store, 'sess-proj', 2)
      const outcome = await replayPendingIngests(replayDeps({
        resolveSession: async sessionId => (sessionId === 'sess-proj' ? { events: pendingEvents, cwd: '/repo/x' } : undefined),
        resolveStore: async () => projectStore,
      }))
      expect(outcome).toEqual({ replayed: 1, kept: 0 })
      // 幂等键仍在审计库（user 库），记忆落该项目库。
      expect(await store.hasAudit(INGEST_DONE_OP, encodeTurnKey('sess-proj', 2))).toBe(true)
      expect(await projectStore.hasAudit(INGEST_DONE_OP, encodeTurnKey('sess-proj', 2))).toBe(false)
      const rows = await projectStore.topActive('project', 10)
      expect(rows.some(record => record.sourceSessionId === 'sess-proj' && record.sourceRound === 2)).toBe(true)
    } finally {
      await projectStore.close()
    }
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

describe('摄取写入四态', () => {
  /** 固定向量伪嵌入器：登记文本按表给向量，未登记文本给正交一热向量（维度 2 起，0/1 留给显式登记）。 */
  const fixedEmbedder = (table: Record<string, readonly number[]>) => {
    const dims = new Map<string, number>()
    let next = 2
    return {
      model: 'pseudo',
      embed: async (texts: readonly string[]) => texts.map(text => {
        const vector = new Float32Array(512)
        const pinned = table[text]
        if (pinned !== undefined) {
          pinned.forEach((value, index) => { vector[index] = value })
          return vector
        }
        let dim = dims.get(text)
        if (dim === undefined) { dim = next; next += 1; dims.set(text, dim) }
        vector[dim] = 1
        return vector
      }),
      close: async () => undefined,
    }
  }
  /** 构造 [1,0,...] 向量的辅助。 */
  const unitVec = (coords: readonly number[]): Float32Array => {
    const vector = new Float32Array(512)
    coords.forEach((value, index) => { vector[index] = value })
    return vector
  }

  it('复述候选 MERGE：并入强化既有条目，不新建、不计 written', async () => {
    const existing = await store.write({ scope: 'user', kind: 'preference', content: '既有偏好条目', embedding: unitVec([1, 0]) })
    const outcome = await ingestPreviousTurn(baseDeps({
      embedder: Promise.resolve(fixedEmbedder({ '用户最喜欢的编程语言是 TypeScript': [1, 0] })),
      call: async () => JSON.stringify([{ content: '用户最喜欢的编程语言是 TypeScript', kind: 'preference', importance: 0.8 }]),
    }))
    expect(outcome.merged).toBe(1)
    expect(outcome.written).toBe(0)
    expect((await store.stats()).total).toBe(1)
    const reinforced = await store.get(existing.id)
    expect(reinforced?.confidence).toBeCloseTo(0.55, 5)
    expect(reinforced?.accessCount).toBe(1)
    const ops = await store.recentOps(10)
    expect(ops.some(op => op.op === 'write-merge' && op.targetId === existing.id)).toBe(true)
  })

  it('defer 带候选落库并建 contradicts 边（计入 written 与 deferred）', async () => {
    const existing = await store.write({ scope: 'user', kind: 'fact', content: '项目包管理器是 pnpm 9', embedding: unitVec([1, 0]) })
    const outcome = await ingestPreviousTurn(baseDeps({
      embedder: Promise.resolve(fixedEmbedder({ '项目包管理器升级到 pnpm 10': [0.9, Math.sqrt(0.19)] })),
      call: async () => JSON.stringify([{ content: '项目包管理器升级到 pnpm 10', kind: 'fact' }]),
    }))
    expect(outcome.written).toBe(1)
    expect(outcome.deferred).toBe(1)
    const edges = (await store.exportAll()).edges
    expect(edges.some(edge => edge.type === 'contradicts' && edge.to === existing.id)).toBe(true)
  })

  it('同批重复候选 DROP 计入 dropped；嵌入不可用时全部 ACCEPT', async () => {
    const dup = await ingestPreviousTurn(baseDeps({
      call: async () => JSON.stringify([
        { content: '重复的事实条目', kind: 'fact' },
        { content: '重复的事实条目', kind: 'fact' },
      ]),
    }))
    expect(dup.written).toBe(1)
    expect(dup.dropped).toBe(1)
    expect(dup.merged).toBe(0)
  })
})
