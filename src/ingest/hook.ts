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

/** 上一轮事件切片：最后一个 turn/start 之前的那一轮（含其中的全部事件）。 */
export function previousTurnSlice(events: readonly SessionEventLike[]): readonly SessionEventLike[] {
  const starts: number[] = []
  for (let i = 0; i < events.length; i++) {
    if (events[i]?.type === 'turn/start') starts.push(i)
  }
  if (starts.length < 2) return []
  const previousStart = starts[starts.length - 2]!
  const currentStart = starts[starts.length - 1]!
  return events.slice(previousStart, currentStart)
}

/**
 * 执行一次上一轮摄取。
 * @returns 结果摘要；异常由调用方捕获计数（不重试）。
 */
export async function ingestPreviousTurn(deps: IngestDeps): Promise<IngestOutcome> {
  const limits = MODE_LIMITS[deps.mode]
  const slice = previousTurnSlice(deps.events)
  if (slice.length === 0) return { scannedEvents: 0, candidates: 0, written: 0, skipped: 'no-previous-turn' }

  const { texts, minSeq } = collectTexts(slice, limits.includeAssistant)
  if (texts.length === 0) return { scannedEvents: slice.length, candidates: 0, written: 0, skipped: 'no-user-content' }

  const route = deps.routeOverride ?? routeFromEvents(deps.events)
  if (route === undefined) return { scannedEvents: slice.length, candidates: 0, written: 0, skipped: 'no-route-in-log' }

  const userText = `从下面这轮对话（JSON 数组）提取值得长期记住的信息：\n${JSON.stringify(texts)}`
  deps.logRequest({ route, round: Math.max(0, deps.turn - 1), userText, maxTokens: INGEST_MAX_TOKENS, mode: deps.mode })
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

  const store = await deps.openStore()
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
      sourceRound: Math.max(0, deps.turn - 1),
      ...(minSeq === null ? {} : { sourceSeq: minSeq }),
      ...(embedder === undefined ? {} : { embedding: (await embedder.embed([content]))[0] }),
    })
    writtenContents.push(content)
    written += 1
  }
  return { scannedEvents: slice.length, candidates: parsed.length, written, skipped: null }
}
