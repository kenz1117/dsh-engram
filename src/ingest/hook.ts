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
import type { EngramKind } from '../types.ts'

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
  '只输出一个 JSON 数组，每项形如 {"content": "一句话完整表述", "kind": "fact|preference|decision|episode|skill", "importance": 0到1的小数}。',
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
  /** 实际写入数（去重后）。 */
  readonly written: number
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

/** 各 turn/start 事件的下标与轮次号（缺 data.turn 时轮次为 undefined）。 */
function turnStarts(events: readonly SessionEventLike[]): { index: number; turn: number | undefined }[] {
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
    return { scannedEvents: 0, candidates: 0, written: 0, skipped: typeof sliceMode === 'number' ? 'no-such-turn' : 'no-previous-turn' }
  }

  const store = await deps.openStore()
  const doneKey = encodeTurnKey(deps.sessionId, round)
  if (await store.hasAudit(INGEST_DONE_OP, doneKey)) {
    return { scannedEvents: slice.length, candidates: 0, written: 0, skipped: 'already-ingested' }
  }

  const { texts, minSeq } = collectTexts(slice, limits.includeAssistant)
  if (texts.length === 0) return { scannedEvents: slice.length, candidates: 0, written: 0, skipped: 'no-user-content' }

  const route = deps.routeOverride ?? routeFromEvents(deps.events)
  if (route === undefined) return { scannedEvents: slice.length, candidates: 0, written: 0, skipped: 'no-route-in-log' }

  const userText = `从下面这轮对话（JSON 数组）提取值得长期记住的信息：\n${JSON.stringify(texts)}`
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
  if (parsed === undefined) return { scannedEvents: slice.length, candidates: 0, written: 0, skipped: 'unparseable-output' }

  const embedder = await deps.embedder
  const writtenContents: string[] = []
  let written = 0
  for (const item of parsed.slice(0, limits.maxCandidates)) {
    const candidate = item as { content?: unknown; kind?: unknown; importance?: unknown }
    if (typeof candidate.content !== 'string' || candidate.content.trim() === '') continue
    const content = candidate.content.trim()
    const kind = (typeof candidate.kind === 'string' && ['fact', 'preference', 'decision', 'episode', 'skill'].includes(candidate.kind))
      ? candidate.kind as EngramKind
      : 'fact'
    const importance = typeof candidate.importance === 'number' && Number.isFinite(candidate.importance)
      ? Math.min(1, Math.max(0, candidate.importance))
      : 0.5
    // 去重：嵌入可用时与现有 active 条目高度相似即跳过；同批重复内容也跳过。
    if (embedder !== undefined) {
      const vector = (await embedder.embed([content]))[0]
      if (vector !== undefined && (await store.findContradictions(vector, 1)).length > 0) continue
    }
    if (writtenContents.includes(content)) continue
    await store.write({
      scope: 'user',
      kind,
      content,
      importance,
      confidence: limits.confidence,
      sourceSessionId: deps.sessionId,
      sourceRound: round,
      ...(minSeq === null ? {} : { sourceSeq: minSeq }),
      ...(embedder === undefined ? {} : { embedding: (await embedder.embed([content]))[0] }),
    })
    writtenContents.push(content)
    written += 1
  }
  await store.audit(INGEST_DONE_OP, deps.sessionId, doneKey)
  return { scannedEvents: slice.length, candidates: parsed.length, written, skipped: null }
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
 * @returns 摄取结果；无末轮或失败（已落 pending）时返回 null。
 */
export async function ingestFinalTurn(deps: IngestDeps): Promise<IngestOutcome | null> {
  const round = lastTurnNumber(deps.events)
  if (round === undefined) return null
  try {
    return await ingestPreviousTurn({ ...deps, slice: 'last' })
  } catch (error) {
    try {
      await markPendingIngest(await deps.openStore(), deps.sessionId, round)
    } catch {
      // pending 落库失败：摄取本就尽力而为，不再升级。
    }
    console.warn('[dsh-engram] 会话结束的末轮摄取失败（已记入待补做队列，不影响对话）：', error)
    return null
  }
}

/** pending 重放的依赖：事件源解析器由调用方注入（当前会话事件或持久化后端）。 */
export interface ReplayIngestDeps {
  /** user 分库打开器。 */
  readonly openStore: () => Promise<EngramStore>
  /** 按 sessionId 解析会话日志事件；无法解析返回 undefined（保留 pending 到下次）。 */
  readonly resolveEvents: (sessionId: string) => Promise<readonly SessionEventLike[] | undefined>
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
    const events = await deps.resolveEvents(key.sessionId)
    if (events === undefined) {
      kept += 1
      continue
    }
    await ingestPreviousTurn({
      events,
      sessionId: key.sessionId,
      turn: key.turn,
      slice: key.turn,
      openStore: deps.openStore,
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
