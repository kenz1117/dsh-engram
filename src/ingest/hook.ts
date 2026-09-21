/**
 * 自动摄取钩子：新一轮第一步读取会话日志中的上一轮事件，经辅助 LLM 提取
 * 候选事实写入记忆库。读取源是日志（model-visible ⟺ logged），辅助调用的
 * 请求由调用方经 logRequest append 到会话日志。候选以低 confidence 写入，
 * 检索命中时提升。异步执行不阻塞请求，失败由调用方捕获计数（不重试）。
 * @module @kenz1117/dsh-engram/ingest/hook
 */

import type { LlmRoute, SessionEventLike } from '../llm/client.ts'
import { parseJsonArray, routeFromEvents } from '../llm/client.ts'
import type { EngramEmbedder } from '../embedder/interface.ts'
import type { EngramStore } from '../store/interface.ts'
import type { EngramKind, EngramScope } from '../types.ts'
import { sanitizeProtocolText } from '../security/sanitize.ts'
import { redactSecrets } from '../security/redact.ts'
import { hasRecallToolCalls, omitRecallToolResults } from '../security/recall.ts'
import { applyMerge, decideWrite } from '../write-disposition.ts'

/** 摄取档位：off 关闭；light 只读用户消息、每轮上限 2 条；eager 用户+助手消息、上限 5 条。 */
export type IngestMode = 'off' | 'light' | 'eager'

/** 档位参数（协议内常量，非部署 tunables）。 */
const MODE_LIMITS: Readonly<Record<Exclude<IngestMode, 'off'>, { maxCandidates: number; confidence: number; includeAssistant: boolean }>> = {
  light: { maxCandidates: 2, confidence: 0.3, includeAssistant: false },
  eager: { maxCandidates: 5, confidence: 0.4, includeAssistant: true },
}

/** 摄取输出 token 上限（提取 JSON 数组，短输出足够）。 */
const INGEST_MAX_TOKENS = 600

/** op_log 幂等键 op：该 (sessionId, turn) 已完成摄取。 */
export const INGEST_DONE_OP = 'ingest-done'
/** op_log pending 键 op：disposed 末轮摄取失败/超时，待下次会话重放补做。 */
export const INGEST_PENDING_OP = 'ingest-pending'
/** disposed 末轮摄取的超时（fire-and-forget 观察器，进程退出可能打断，必须限时）。 */
export const FINAL_INGEST_TIMEOUT_MS = 5000

/** 幂等键编码：`${sessionId}#${turn}`。 */
export function encodeTurnKey(sessionId: string, turn: number): string {
  return `${sessionId}#${turn}`
}

/** 幂等键解码；损坏的键返回 undefined（调用方直接出队）。 */
export function decodeTurnKey(detail: string): { sessionId: string; turn: number } | undefined {
  const sep = detail.lastIndexOf('#')
  if (sep <= 0) return undefined
  const turn = Number(detail.slice(sep + 1))
  if (!Number.isInteger(turn) || turn < 0) return undefined
  return { sessionId: detail.slice(0, sep), turn }
}

const INGEST_SYSTEM = [
  '从对话记录中提取值得跨会话长期记住的用户信息（事实/偏好/决策/经历/做事方法）。',
  '只输出一个 JSON 数组，每项形如 {"content": "一句话完整表述", "kind": "fact|preference|decision|episode|skill", "scope": "project|user", "importance": 0到1的小数}。',
  'scope 决定这条记忆进哪座宫殿：只跟当前项目/仓库有关的（技术选型、项目约定、架构决策、该项目自身的事实）用 project；与具体项目无关、跨项目通用的（个人偏好、习惯、用户本人的经历、通用事实）用 user。拿不准用 project。',
  '只提取明确、可复用的信息；寒暄、临时上下文、你自己的回答不要提取。没有值得记的就输出 []。',
  '不要输出 JSON 以外的任何内容。',
].join('\n')

/** 摄取辅助调用的日志事件负载（append 到会话日志，供审计与归因）。 */
export interface IngestRequestEventData {
  /** 使用的模型路由。 */
  readonly route: LlmRoute
  /** 被摄取的会话轮次（上一轮号）。 */
  readonly round: number
  /** 框定给模型的消息文本。 */
  readonly userText: string
  /** 输出 token 上限。 */
  readonly maxTokens: number
  /** 档位。 */
  readonly mode: Exclude<IngestMode, 'off'>
}

/** 一次摄取的结果摘要（诊断与计数用）。 */
export interface IngestOutcome {
  /** 上一轮事件数（0 表示没有上一轮可摄取）。 */
  readonly scannedEvents: number
  /** LLM 提取的候选数。 */
  readonly candidates: number
  /** 实际新建条目数（accept + defer；defer 是落库但建 contradicts 边待裁决）。 */
  readonly written: number
  /** MERGE 处置数：复述并入既有条目（强化置信度与访问计数，不新建）。 */
  readonly merged: number
  /** written 中的待裁决条数（疑似矛盾/修正，已建边）。 */
  readonly deferred: number
  /** DROP 处置数：空内容 / 同批重复等低熵候选。 */
  readonly dropped: number
  /** 跳过原因；null = 正常完成。 */
  readonly skipped: string | null
}

/** 摄取依赖：由 index.ts 闭包构造，hook 保持纯逻辑可测。 */
export interface IngestDeps {
  /** 会话日志事件（本轮开始时的完整快照）。 */
  readonly events: readonly SessionEventLike[]
  /** 当前会话 id（归一化字符串）。 */
  readonly sessionId: string
  /** 当前轮次（上一轮 = turn - 1 的归属）。 */
  readonly turn: number
  /** user 分库打开器。 */
  readonly openStore: () => Promise<EngramStore>
  /** 嵌入器承诺；undefined = 无法去重（候选全量写入，重复风险由低置信度体现）。 */
  readonly embedder: Promise<EngramEmbedder | undefined>
  /** 档位。 */
  readonly mode: Exclude<IngestMode, 'off'>
  /** 显式路由覆盖（Config provider+model 成对）；缺省从日志解析。 */
  readonly routeOverride: LlmRoute | undefined
  /** 辅助 LLM 调用（由 index.ts 用 ctx.llm.stream 构造）。 */
  readonly call: (params: { route: LlmRoute; system: string; userText: string; maxTokens: number; purpose: string; signal: AbortSignal }) => Promise<string>
  /** 辅助调用请求记入会话日志（model-visible ⟺ logged）。 */
  readonly logRequest: (data: IngestRequestEventData) => void
  /** 取消信号（跟随请求）。 */
  readonly signal: AbortSignal
  /** 切片模式；缺省 previous（上一轮）。 */
  readonly slice?: IngestSlice
  /** 是否对本切片应用节流（低活动/寒暄/禁记跳过）。缺省只作用于 previous 切片；历史回填传 true。 */
  readonly throttle?: boolean
  /** 写入分库的作用域兜底（模型未给合法 scope 时用）。缺省 user；实时摄取与历史回填都传显式值。 */
  readonly writeScope?: EngramScope
  /** 逐条判宫殿：是否采纳提炼模型输出的 scope（缺省 false = 全部用 writeScope）。 */
  readonly perCandidateScope?: boolean
  /** 按作用域解析写入分库（模型判 project 时落到该项目库）；缺省 = 全部写 openStore() 的分库。 */
  readonly resolveStore?: (scope: EngramScope) => Promise<EngramStore>
  /** 幂等/审计键（ingest-done、ingest-pending）落点；缺省 = openStore()（键是会话级的，与写入落点解耦）。 */
  readonly openAuditStore?: () => Promise<EngramStore>
  /** 历史回填模式：写入不进入 SM-2 复习调度（避免一次性回填的条目同时涌入今日复习队列）。 */
  readonly history?: boolean
}

/** 写入路由：默认作用域 + 是否逐条采纳模型 scope + 按作用域解析分库。 */
export interface IngestWriteRouting {
  /** 默认（模型未给合法 scope 时）作用域。 */
  readonly writeScope: EngramScope
  /** 是否采纳模型逐条给出的 scope。 */
  readonly perCandidateScope: boolean
  /** 分库解析器；缺省表示所有写入都落 `openStore()` 那个库。 */
  readonly resolveStore?: (scope: EngramScope) => Promise<EngramStore>
}

/**
 * 组装一次摄取的写入路由：会话有 cwd（可归属项目）时默认进项目宫殿且采纳模型的逐条判定，
 * 明显跨项目的个人偏好可被标成 user 落私人宫殿；无 cwd 的会话只能进私人宫殿，
 * 故关掉逐条判定（否则 project 标记落进 user 库后检索不可见）。
 * @param cwd - 会话工作目录；空串/undefined = 无法归属项目。
 * @param openProjectStore - 按 cwd 打开项目分库。
 * @param openScopeStore - 按作用域打开分库（user / shared）。
 * @returns 可直接展开进 IngestDeps / ReplayIngestDeps 的路由字段。
 */
export function ingestWriteRouting(
  cwd: string | undefined,
  openProjectStore: (cwd: string) => Promise<EngramStore>,
  openScopeStore: (scope: EngramScope) => Promise<EngramStore>,
): IngestWriteRouting {
  if (cwd === undefined || cwd === '') return { writeScope: 'user', perCandidateScope: false }
  return {
    writeScope: 'project',
    perCandidateScope: true,
    resolveStore: scope => (scope === 'project' ? openProjectStore(cwd) : openScopeStore(scope)),
  }
}

/** 从事件里按类型收集文本块，跳过插件注入的 user 快照（它们不是用户说的话）。 */
function collectTexts(events: readonly SessionEventLike[], includeAssistant: boolean): { texts: string[]; minSeq: number | null } {
  const texts: string[] = []
  let minSeq: number | null = null
  for (const event of events) {
    if (event.type === 'user/message') {
      const data = event.data as { source?: { kind?: unknown }; content?: { type?: unknown; text?: unknown }[] } | null
      if (data?.source?.kind === 'plugin') continue
      const segments = (data?.content ?? [])
        .filter(block => block?.type === 'text' && typeof block.text === 'string')
        .map(block => block.text as string)
      if (segments.length > 0) {
        texts.push(...segments)
        if (event.seq !== undefined && (minSeq === null || event.seq < minSeq)) minSeq = event.seq
      }
    } else if (includeAssistant && event.type === 'assistant/message') {
      const data = event.data as { content?: { type?: unknown; text?: unknown }[] } | null
      const segments = (data?.content ?? [])
        .filter(block => block?.type === 'text' && typeof block.text === 'string')
        .map(block => block.text as string)
      if (segments.length > 0) texts.push(...segments)
    }
  }
  return { texts, minSeq }
}

/** 摄取切片模式：previous = 上一轮（新轮第一步触发）；last = 末轮到日志末尾（session/disposed 触发）；number = 指定轮次（pending 重放）。 */
export type IngestSlice = 'previous' | 'last' | number

/** 活动评分门槛：低于该值的上一轮不值得起一次辅助 LLM 摄取（四信号公式见 activityScore）。 */
export const ACTIVITY_THRESHOLD = 5

/** 寒暄正则：整段用户输入只含问候/感谢等无信息内容时跳过摄取。 */
const CHITCHAT_RE = /^(?:你好|您好|嗨|哈喽|hello|hi|hey|谢谢|感谢|ok|okay|好的|在吗|收到|辛苦了)[!！,.，。?？~\s]*$/iu

/** 显式禁记正则：用户明确要求不要记住本轮内容时跳过摄取（窄匹配整句指令，避免误伤）。 */
const NO_CAPTURE_RE = /(?:不要|别|不用|无需)(?:把这?[个件些条]?|把上一?轮|把刚才)?(?:记|存)(?:住|录|下来|进去|到记忆|进记忆)|don'?t\s+(?:remember|record|save)\s+(?:this|that|it)/i

/** 上一轮的活动信号（摄取节流的输入）。 */
export interface TurnSignals {
  /** 用户消息文本总字符数。 */
  readonly userChars: number
  /** 上一轮是否有完成的助手回复（0 或 1）。 */
  readonly completedTurns: number
  /** 工具结果数。 */
  readonly toolResults: number
  /** 出现过的工具名集合。 */
  readonly toolNames: ReadonlySet<string>
}

/** 工具多样性得分：无工具 0；1-2 种 1；≥3 种 2。 */
function toolDiversity(distinct: number): number {
  return distinct === 0 ? 0 : distinct <= 2 ? 1 : 2
}

/**
 * 活动评分（四信号，< ACTIVITY_THRESHOLD 跳过摄取）：
 * min(floor(userChars/50), 3) + completedTurns + min(floor(toolResults/5), 2) + toolDiversity。
 * @param signals - 上一轮活动信号。
 * @returns 0-8 的整数评分。
 */
export function activityScore(signals: TurnSignals): number {
  return Math.min(Math.floor(signals.userChars / 50), 3)
    + signals.completedTurns
    + Math.min(Math.floor(signals.toolResults / 5), 2)
    + toolDiversity(signals.toolNames.size)
}

/** 判断用户输入是否为纯寒暄（无信息内容）。 */
export function isChitchat(text: string): boolean {
  return CHITCHAT_RE.test(text.trim())
}

/** 判断用户输入是否显式要求不要记住。 */
export function forbidsCapture(text: string): boolean {
  return NO_CAPTURE_RE.test(text)
}

/** 从事件切片提取活动信号（用户文本排除插件注入的快照消息）。 */
export function turnSignals(events: readonly SessionEventLike[]): TurnSignals {
  let userChars = 0
  let completedTurns = 0
  let toolResults = 0
  const toolNames = new Set<string>()
  for (const event of events) {
    if (event.type === 'user/message') {
      const data = event.data as { source?: { kind?: unknown }; content?: { type?: unknown; text?: unknown }[] } | null
      if (data?.source?.kind === 'plugin') continue
      for (const block of data?.content ?? []) {
        if (block?.type === 'text' && typeof block.text === 'string') userChars += block.text.length
      }
    } else if (event.type === 'assistant/message') {
      const data = event.data as { content?: { type?: unknown; text?: unknown }[] } | null
      if ((data?.content ?? []).some(block => block?.type === 'text' && typeof block.text === 'string' && block.text !== '')) {
        completedTurns = 1
      }
    } else if (event.type === 'tool/result') {
      toolResults += 1
    } else if (event.type === 'tool/call') {
      const name = (event.data as { name?: unknown } | null)?.name
      if (typeof name === 'string') toolNames.add(name)
    }
  }
  return { userChars, completedTurns, toolResults, toolNames }
}

/**
 * 上一轮自动摄取的节流判定（只作用于 previous 切片；末轮/pending 重放补做不受限）。
 * @returns 跳过原因；null = 允许摄取。
 */
export function throttleDecision(events: readonly SessionEventLike[]): string | null {
  const signals = turnSignals(events)
  if (activityScore(signals) < ACTIVITY_THRESHOLD) return 'low-activity'
  const texts = collectTexts(events, false).texts
  const joined = texts.join(' ')
  if (joined !== '' && isChitchat(joined)) return 'chitchat'
  if (forbidsCapture(joined)) return 'capture-forbidden'
  return null
}

/** 各 turn/start 事件的下标与轮次号（缺 data.turn 时轮次为 undefined）。
 *  events 允许 undefined：会话 dispose 后事件源已 detach，宿主可能给不出日志，
 *  此时按空日志处理而不是抛 TypeError（调用方在会话生命周期之外，异常会变成未处理 rejection）。 */
function turnStarts(events: readonly SessionEventLike[] | undefined): { index: number; turn: number | undefined }[] {
  if (events === undefined) return []
  const starts: { index: number; turn: number | undefined }[] = []
  for (let i = 0; i < events.length; i++) {
    if (events[i]?.type !== 'turn/start') continue
    const turn = (events[i]!.data as { turn?: unknown } | null)?.turn
    starts.push({ index: i, turn: typeof turn === 'number' ? turn : undefined })
  }
  return starts
}

/** 上一轮事件切片：最后一个 turn/start 之前的那一轮（含其中的全部事件）。 */
export function previousTurnSlice(events: readonly SessionEventLike[]): readonly SessionEventLike[] {
  const starts = turnStarts(events)
  if (starts.length < 2) return []
  return events.slice(starts[starts.length - 2]!.index, starts[starts.length - 1]!.index)
}

/** 末轮事件切片：最后一个 turn/start 到日志末尾（session/disposed 摄取用）。 */
export function lastTurnSlice(events: readonly SessionEventLike[]): readonly SessionEventLike[] {
  const starts = turnStarts(events)
  if (starts.length === 0) return []
  return events.slice(starts[starts.length - 1]!.index)
}

/** 最后一个 turn/start 的轮次号；无 turn/start 或缺 data.turn 时 undefined。 */
export function lastTurnNumber(events: readonly SessionEventLike[]): number | undefined {
  const starts = turnStarts(events)
  return starts.length === 0 ? undefined : starts[starts.length - 1]!.turn
}

/** 指定轮次的事件切片：该轮 turn/start 到下一轮 turn/start（无下一轮则到日志末尾）。 */
export function turnSlice(events: readonly SessionEventLike[], turn: number): readonly SessionEventLike[] {
  const starts = turnStarts(events)
  const position = starts.findIndex(start => start.turn === turn)
  if (position === -1) return []
  const end = position + 1 < starts.length ? starts[position + 1]!.index : events.length
  return events.slice(starts[position]!.index, end)
}

/**
 * 执行一次摄取（默认上一轮；slice 指定末轮或显式轮次）。幂等：op_log 已存在
 * 该 (sessionId, turn) 的 done 键时直接跳过；成功完成后写入 done 键。
 * @returns 结果摘要；异常由调用方捕获计数（不重试）。
 */
export async function ingestPreviousTurn(deps: IngestDeps): Promise<IngestOutcome> {
  const limits = MODE_LIMITS[deps.mode]
  const sliceMode = deps.slice ?? 'previous'
  let slice: readonly SessionEventLike[]
  let round: number
  if (sliceMode === 'previous') {
    slice = previousTurnSlice(deps.events)
    round = Math.max(0, deps.turn - 1)
  } else if (sliceMode === 'last') {
    slice = lastTurnSlice(deps.events)
    round = lastTurnNumber(deps.events) ?? deps.turn
  } else {
    slice = turnSlice(deps.events, sliceMode)
    round = sliceMode
  }
  if (slice.length === 0) {
    return { scannedEvents: 0, candidates: 0, written: 0, merged: 0, deferred: 0, dropped: 0, skipped: typeof sliceMode === 'number' ? 'no-such-turn' : 'no-previous-turn' }
  }

  const store = await deps.openStore()
  // 幂等/审计键是会话级的（与写入落哪个宫殿无关）：固定落审计库，跨路径（实时/回填）共用一份。
  const auditStore = deps.openAuditStore === undefined ? store : await deps.openAuditStore()
  const doneKey = encodeTurnKey(deps.sessionId, round)
  if (await auditStore.hasAudit(INGEST_DONE_OP, doneKey)) {
    return { scannedEvents: slice.length, candidates: 0, written: 0, merged: 0, deferred: 0, dropped: 0, skipped: 'already-ingested' }
  }

  // 节流（默认只限 previous 自动摄取）：低活动/寒暄/显式禁记的轮次不值得起一次辅助 LLM。
  if (sliceMode === 'previous' || deps.throttle === true) {
    const throttled = throttleDecision(slice)
    if (throttled !== null) {
      return { scannedEvents: slice.length, candidates: 0, written: 0, merged: 0, deferred: 0, dropped: 0, skipped: throttled }
    }
  }

  // 召回占位先行：切片内召回工具的输出替换为占位文本，阻断记忆内容回流成新记忆。
  const scoped = omitRecallToolResults(slice)
  const { texts, minSeq } = collectTexts(scoped, limits.includeAssistant)
  // 入库前协议剥离 + 密钥脱敏；交给提取模型的 userText 同样脱敏。
  const cleaned = texts.map(text => redactSecrets(sanitizeProtocolText(text)))
  if (cleaned.every(text => text === '')) {
    return { scannedEvents: slice.length, candidates: 0, written: 0, merged: 0, deferred: 0, dropped: 0, skipped: 'no-user-content' }
  }

  const route = deps.routeOverride ?? routeFromEvents(deps.events)
  if (route === undefined) return { scannedEvents: slice.length, candidates: 0, written: 0, merged: 0, deferred: 0, dropped: 0, skipped: 'no-route-in-log' }

  // 防回声室附注：上一轮调用过召回工具时，提示提取模型既有记忆的复述不是新信息。
  const recallNote = hasRecallToolCalls(scoped)
    ? '（注意：上一轮调用过记忆召回工具（engram_search 等），其返回已省略；助手回答中复述的既有记忆不是新信息，不要提取。）'
    : ''
  const userText = `从下面这轮对话（JSON 数组）提取值得长期记住的信息：\n${JSON.stringify(cleaned)}${recallNote === '' ? '' : `\n${recallNote}`}`
  deps.logRequest({ route, round, userText, maxTokens: INGEST_MAX_TOKENS, mode: deps.mode })
  const raw = await deps.call({
    route,
    system: INGEST_SYSTEM,
    userText,
    maxTokens: INGEST_MAX_TOKENS,
    purpose: 'engram-ingest',
    signal: deps.signal,
  })
  const parsed = parseJsonArray(raw)
  if (parsed === undefined) return { scannedEvents: slice.length, candidates: 0, written: 0, merged: 0, deferred: 0, dropped: 0, skipped: 'unparseable-output' }

  const embedder = await deps.embedder
  const writtenContents: string[] = []
  let written = 0
  let merged = 0
  let deferred = 0
  let dropped = 0
  for (const item of parsed.slice(0, limits.maxCandidates)) {
    const candidate = item as { content?: unknown; kind?: unknown; scope?: unknown; importance?: unknown }
    if (typeof candidate.content !== 'string' || candidate.content.trim() === '') { dropped += 1; continue }
    // 模型输出候选入库前同样剥离协议块并脱敏（可能复述会话中的密钥或伪造协议标签）。
    const content = redactSecrets(sanitizeProtocolText(candidate.content.trim()))
    if (content === '') { dropped += 1; continue }
    const kind = (typeof candidate.kind === 'string' && ['fact', 'preference', 'decision', 'episode', 'skill'].includes(candidate.kind))
      ? candidate.kind as EngramKind
      : 'fact'
    // 逐条判宫殿：模型给出的 project/user 覆盖默认作用域；非法值（含 shared）一律回退默认。
    const modelScope = candidate.scope === 'user' || candidate.scope === 'project' ? candidate.scope : undefined
    const scope: EngramScope = deps.perCandidateScope === true && modelScope !== undefined
      ? modelScope
      : deps.writeScope ?? 'user'
    const target = deps.resolveStore === undefined ? store : await deps.resolveStore(scope)
    const importance = typeof candidate.importance === 'number' && Number.isFinite(candidate.importance)
      ? Math.min(1, Math.max(0, candidate.importance))
      : 0.5
    // 同批重复内容直接 DROP。
    if (writtenContents.includes(content)) { dropped += 1; continue }
    // 四态处置（嵌入可用时）：复述并入强化既有条目（MERGE，不新建）；
    // 疑似矛盾/修正落库并建 contradicts 边待裁决（DEFER）；其余 ACCEPT。
    const vector = embedder === undefined ? undefined : (await embedder.embed([content]))[0]
    const decision = await decideWrite(target, kind, vector)
    if (decision.disposition === 'merge') {
      await applyMerge(target, decision, content)
      writtenContents.push(content)
      merged += 1
      continue
    }
    const record = await target.write({
      scope,
      kind,
      content,
      importance,
      confidence: limits.confidence,
      sourceSessionId: deps.sessionId,
      sourceRound: round,
      ...(minSeq === null ? {} : { sourceSeq: minSeq }),
      ...(vector === undefined ? {} : { embedding: vector }),
      ...(deps.history === true ? { initialReviewAt: null } : {}),
    })
    if (decision.disposition === 'defer') {
      await target.linkEdge(record.id, decision.neighbor.id, 'contradicts')
      deferred += 1
    }
    writtenContents.push(content)
    written += 1
  }
  await auditStore.audit(INGEST_DONE_OP, deps.sessionId, doneKey)
  return { scannedEvents: slice.length, candidates: parsed.length, written, merged, deferred, dropped, skipped: null }
}

/**
 * 写入 pending 键（done 或 pending 已存在时不重复写）。仅在末轮摄取失败/超时后调用。
 */
export async function markPendingIngest(store: EngramStore, sessionId: string, turn: number): Promise<void> {
  const key = encodeTurnKey(sessionId, turn)
  if (await store.hasAudit(INGEST_DONE_OP, key)) return
  if (await store.hasAudit(INGEST_PENDING_OP, key)) return
  await store.audit(INGEST_PENDING_OP, sessionId, key)
}

/**
 * 会话结束时的末轮摄取：切片为最后一个 turn/start 到日志末尾，复用提炼管线。
 * 失败/超时只告警并把 (sessionId, turn) pending 键写入 op_log（下次会话首次
 * pre-step 重放补做），绝不影响对话。
 * 本函数不 reject：从取轮次到摄取全程在 try 内，异常一律降级为告警 + pending 键
 * （dispose 观察器是 fire-and-forget，逃逸的 rejection 会被宿主的 fail-loud 当作致命错误）。
 * @returns 摄取结果；无末轮或失败（已落 pending）时返回 null。
 */
export async function ingestFinalTurn(deps: IngestDeps): Promise<IngestOutcome | null> {
  /** 末轮轮次号；取不到（无 turn/start 或事件源不可用）时不落 pending——键需要轮次。 */
  let round: number | undefined
  try {
    round = lastTurnNumber(deps.events)
    if (round === undefined) return null
    return await ingestPreviousTurn({ ...deps, slice: 'last' })
  } catch (error) {
    if (round !== undefined) {
      try {
        await markPendingIngest(await (deps.openAuditStore ?? deps.openStore)(), deps.sessionId, round)
      } catch {
        // pending 落库失败：摄取本就尽力而为，不再升级。
      }
    }
    console.warn('[dsh-engram] 会话结束的末轮摄取失败（已记入待补做队列，不影响对话）：', error)
    return null
  }
}

/** pending 重放的依赖：事件源解析器由调用方注入（当前会话事件或持久化后端）。 */
export interface ReplayIngestDeps {
  /** 幂等/审计键（pending、done）所在分库；也是无 cwd 会话的写入落点。 */
  readonly openStore: () => Promise<EngramStore>
  /**
   * 按 sessionId 解析会话日志与它的 cwd；无法解析返回 undefined（保留 pending 到下次）。
   * cwd 决定该会话的待补做轮次写进哪座项目宫殿。
   */
  readonly resolveSession: (sessionId: string) => Promise<{ events: readonly SessionEventLike[]; cwd?: string | undefined } | undefined>
  /** 按会话 cwd 解析项目分库（模型判 project 时的落点）。 */
  readonly resolveStore: (cwd: string) => Promise<EngramStore>
  /** 嵌入器承诺。 */
  readonly embedder: Promise<EngramEmbedder | undefined>
  /** 档位。 */
  readonly mode: Exclude<IngestMode, 'off'>
  /** 显式路由覆盖；缺省从日志解析。 */
  readonly routeOverride: LlmRoute | undefined
  /** 辅助 LLM 调用。 */
  readonly call: IngestDeps['call']
  /** 辅助调用请求审计。 */
  readonly logRequest: IngestDeps['logRequest']
  /** 取消信号。 */
  readonly signal: AbortSignal
}

/** pending 重放结果摘要。 */
export interface ReplayOutcome {
  /** 成功补做的 pending 键数。 */
  readonly replayed: number
  /** 事件源不可得而保留的 pending 键数。 */
  readonly kept: number
}

/**
 * 重放待补做的末轮摄取（下次会话首次 pre-step 调用）。已有 done 标记或键损坏的
 * pending 直接出队；事件源不可得的保留到下次。单个键失败抛出，剩余键留待下次。
 * 每条 pending 按它自己会话的 cwd 组装写入路由（补做时同样逐条判宫殿）。
 */
export async function replayPendingIngests(deps: ReplayIngestDeps): Promise<ReplayOutcome> {
  const store = await deps.openStore()
  const pendings = await store.listAuditDetails(INGEST_PENDING_OP)
  let replayed = 0
  let kept = 0
  for (const detail of pendings) {
    const key = decodeTurnKey(detail)
    if (key === undefined || (await store.hasAudit(INGEST_DONE_OP, detail))) {
      await store.clearAudit(INGEST_PENDING_OP, detail)
      continue
    }
    const session = await deps.resolveSession(key.sessionId)
    if (session === undefined) {
      kept += 1
      continue
    }
    await ingestPreviousTurn({
      events: session.events,
      sessionId: key.sessionId,
      turn: key.turn,
      slice: key.turn,
      openStore: deps.openStore,
      openAuditStore: deps.openStore,
      ...ingestWriteRouting(session.cwd, deps.resolveStore, deps.openStore),
      embedder: deps.embedder,
      mode: deps.mode,
      routeOverride: deps.routeOverride,
      call: deps.call,
      logRequest: deps.logRequest,
      signal: deps.signal,
    })
    await store.clearAudit(INGEST_PENDING_OP, detail)
    replayed += 1
  }
  return { replayed, kept }
}
