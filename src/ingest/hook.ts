/**
 * 自动摄取钩子：新一轮第一步读取会话日志中的上一轮事件，经辅助 LLM 提取
 * 候选事实写入记忆库。读取源是日志（model-visible ⟺ logged），辅助调用的
 * 请求由调用方经 logRequest append 到会话日志。候选以低 confidence 写入，
 * 检索命中时提升。异步执行不阻塞请求，失败由调用方捕获计数（不重试）。
 * 另含会话收尾摘要（ensureSessionSummary）：整场会话一句话概括，实时 dispose
 * 与历史回填共用。
 * @module @kenz1117/dsh-engram/ingest/hook
 */

import type { LlmRoute, SessionEventLike } from '../llm/client.ts'
import { parseJsonArray, routeFromEvents } from '../llm/client.ts'
import { message } from '../i18n/messages.ts'
import { chitchatPatterns, noCapturePatterns } from '../i18n/patterns.ts'
import type { EmbedderHandle } from '../embedder/interface.ts'
import type { EngramStore } from '../store/interface.ts'
import type { EngramEntityKind, EngramKind, EngramScope, EntityMention, FactMention, FactWriteInput, MemoryId } from '../types.ts'
import { normalizeEntityName } from '../types.ts'
import { sanitizeProtocolText } from '../security/sanitize.ts'
import { redactSecrets } from '../security/redact.ts'
import { hasRecallToolCalls, omitRecallToolResults } from '../security/recall.ts'
import { applyMerge, confirmContradictions, decideWrite } from '../write-disposition.ts'
import type { JudgeProvider } from '../write-disposition.ts'

/** 摄取档位：off 关闭；light 只读用户消息、每轮上限 2 条；eager 用户+助手消息、上限 5 条。 */
export type IngestMode = 'off' | 'light' | 'eager'

/** 档位参数（协议内常量，非部署 tunables）。 */
const MODE_LIMITS: Readonly<Record<Exclude<IngestMode, 'off'>, { maxCandidates: number; confidence: number; includeAssistant: boolean }>> = {
  light: { maxCandidates: 2, confidence: 0.3, includeAssistant: false },
  eager: { maxCandidates: 5, confidence: 0.4, includeAssistant: true },
}

/** 摄取输出 token 上限。completion 预算含 reasoning_tokens：推理模型可能把预算耗在思考上、
    答案为空（实测 600/2000 都会出现，4000 未复现），上限给足余量而非按答案长度估。 */
const INGEST_MAX_TOKENS = 4000

/** op_log 幂等键 op：该 (sessionId, turn) 已完成摄取。 */
export const INGEST_DONE_OP = 'ingest-done'
/** op_log pending 键 op：disposed 末轮摄取失败/超时，待下次会话重放补做。 */
export const INGEST_PENDING_OP = 'ingest-pending'
/**
 * op_log 跳过标记 op：该 (sessionId, turn) 被确定性的前置检查跳过（节流/无正文/无路由）。
 * 不记它，估算与重跑就永远把这些轮当待处理（issue #40：回填的「待处理」降不到零）。
 * 跳过判定由轮内容决定、逐字可复现，标记因此不掩盖内容；target_id 存原因
 * （turn key 已含 sessionId，用它携带原因供日后按规则版本清理），detail 与 done 同键。
 */
export const INGEST_SKIP_OP = 'ingest-skip'
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

/**
 * Системная инструкция извлечения: текст живёт в словаре (`llm.ingestSystem`),
 * берётся в момент вызова — язык становится известен только при сборке плагина.
 */
function ingestSystemPrompt(): string {
  return message('llm.ingestSystem')
}

/** 实体提及 kind 的合法值集合（模型输出边界校验用）。 */
const ENTITY_KINDS: readonly EngramEntityKind[] = ['person', 'project', 'tool', 'concept', 'other']
/** 单个实体名的长度上限（专名本身，防止把整句话当实体）。 */
const ENTITY_NAME_MAX = 80
/** 单条事实陈述的长度上限（一句话）。 */
const FACT_CONTENT_MAX = 500

/**
 * 解析模型输出的 entities 字段为合法提及列表。模型输出是不可信边界：
 * 非数组、元素缺 name、name 清洗后为空或超长的条目一律丢弃，kind 非法回退 other。
 */
export function parseEntityMentions(raw: unknown): EntityMention[] {
  if (!Array.isArray(raw)) return []
  const mentions: EntityMention[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as { name?: unknown; kind?: unknown; aliases?: unknown }
    if (typeof record.name !== 'string') continue
    const name = record.name.trim()
    if (name === '' || name.length > ENTITY_NAME_MAX) continue
    const kind = ENTITY_KINDS.includes(record.kind as EngramEntityKind) ? record.kind as EngramEntityKind : 'other'
    const aliases = Array.isArray(record.aliases)
      ? record.aliases.filter((a): a is string => typeof a === 'string' && a.trim() !== '' && a.trim().length <= ENTITY_NAME_MAX)
      : []
    mentions.push({
      name,
      kind,
      ...(aliases.length === 0 ? {} : { aliases }),
    })
  }
  return mentions
}

/**
 * 解析模型输出的 facts 字段为合法事实提及列表。模型输出是不可信边界：
 * 非数组、元素缺 entity/content、清洗后为空或超长的条目一律丢弃。
 * entity 与同批实体名的对应关系由写入路径按归一化名匹配（匹配不上整条丢弃）。
 */
export function parseFactMentions(raw: unknown): FactMention[] {
  if (!Array.isArray(raw)) return []
  const mentions: FactMention[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as { entity?: unknown; content?: unknown }
    if (typeof record.entity !== 'string' || typeof record.content !== 'string') continue
    const entity = record.entity.trim()
    const content = record.content.trim()
    if (entity === '' || entity.length > ENTITY_NAME_MAX) continue
    if (content === '' || content.length > FACT_CONTENT_MAX) continue
    mentions.push({ entity, content })
  }
  return mentions
}

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
  /**
   * Причина пропуска; null = обычное завершение.
   *
   * Значения — это же и ключи словаря панели (SKIP_KEY в EngramPanel.tsx), поэтому
   * список один на обе половины: 'low-activity', 'chitchat', 'capture-forbidden',
   * 'no-user-content', 'already-ingested', 'no-such-turn', 'no-previous-turn',
   * 'no-route-in-log', 'unparseable-output', 'empty-answer'. Опечатка здесь стоит
   * пользователю локализованной подписи: неизвестное значение показывается как есть.
   */
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
  readonly embedder: EmbedderHandle
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
  /**
   * Поставщик судьи Jev: спрашивается в начале обработки, поэтому включение Jev и выбор
   * провайдера, модели или адреса в панели действуют без перезапуска. Отсутствует или
   * вернул undefined = судьи нет, чистые правила (DEFER пишется и сразу связывается).
   */
  readonly resolveJudge?: JudgeProvider
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
      // 插件注入两种形状（v3 历史 'plugin' / v4 'plugin:<包名>'）一律跳过，防摄取自己注入的快照。
      if (typeof data?.source?.kind === 'string' && data.source.kind.startsWith('plugin')) continue
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

/**
 * Реплики человека из событий текущей сессии.
 *
 * Нужны языку дворца: по ним видно, на каком языке человек ведёт диалог. Это единственный
 * дешёвый источник — события текущей сессии уже в памяти процесса. Журналы сессий,
 * в том числе прошлых, по-прежнему не читаются (решение 20.10): журнал читается целиком
 * и стоит сотни мегабайт кучи.
 *
 * Считается только то, что человек набрал сам: события с видом `user`. Инструкции
 * агента (`agent-instructions`), снимок рантайма (`runtime-context`) и каталог навыков
 * (`skill-catalog`) приходят теми же `user/message`, но написаны по-английски и голосом
 * человека не являются — без этого отсева английский служебный текст перевешивал русскую
 * речь (проверено 21.10 на живом дворце: `dialogue: en` при базах `ru`). Всё незнакомое
 * тоже не считается: ошибиться в сторону «спросить» безопаснее, чем назначить чужой язык.
 * @param events - события текущей сессии.
 * @returns Реплики человека в порядке появления.
 */
export function userTexts(events: readonly SessionEventLike[]): string[] {
  const texts: string[] = []
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const data = event.data as { source?: { kind?: unknown }; content?: { type?: unknown; text?: unknown }[] } | null
    if (data?.source?.kind !== 'user') continue
    for (const block of data.content ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    }
  }
  return texts
}

/** 摄取切片模式：previous = 上一轮（新轮第一步触发）；last = 末轮到日志末尾（session/disposed 触发）；number = 指定轮次（pending 重放）。 */
export type IngestSlice = 'previous' | 'last' | number

/** 活动评分门槛：低于该值的上一轮不值得起一次辅助 LLM 摄取（四信号公式见 activityScore）。 */
export const ACTIVITY_THRESHOLD = 5

/*
 * Образцы болтовни и запрета запоминать переехали в языковой пакет
 * (`i18n/patterns.ts`): это языковые данные, и меняться они должны вместе с пакетом.
 * Форма авторских правил сохранена — болтовня привязана к сообщению целиком, запрет
 * ищется в любом месте; заменены только сами слова.
 */

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

/**
 * 判断用户输入是否为纯寒暄（无信息内容）。
 *
 * Русская доработка (F-10): слова берутся из языкового пакета и проверяются для
 * английского набора и набора действующего языка. Привязка к сообщению целиком сохранена
 * намеренно: срабатывание пропускает сообщение целиком, поэтому список должен оставаться
 * узким — при сомнении лучше записать.
 */
export function isChitchat(text: string): boolean {
  const trimmed = text.trim()
  return chitchatPatterns().some((pattern) => pattern.test(trimmed))
}

/**
 * 判断用户输入是否显式要求不要记住。
 *
 * Русская доработка (F-10): формы запрета тоже языковые. Отрицание в образцах обязательно:
 * «запомни это» и «не запоминай это» — противоположные указания, путать их нельзя.
 */
export function forbidsCapture(text: string): boolean {
  return noCapturePatterns().some((pattern) => pattern.test(text))
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
      if (typeof data?.source?.kind === 'string' && data.source.kind.startsWith('plugin')) continue
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
  // 已被确定性规则跳过过的轮次同样直接跳过（issue #40）：不查这个键，回填每跑一次
  // 都把它们重新扫描、重新判定、重新跳过，估算的「待处理」永远不动。
  if (await auditStore.hasAudit(INGEST_SKIP_OP, doneKey)) {
    return { scannedEvents: slice.length, candidates: 0, written: 0, merged: 0, deferred: 0, dropped: 0, skipped: 'already-ingested' }
  }

  // 节流（默认只限 previous 自动摄取）：低活动/寒暄/显式禁记的轮次不值得起一次辅助 LLM。
  if (sliceMode === 'previous' || deps.throttle === true) {
    const throttled = throttleDecision(slice)
    if (throttled !== null) {
      await auditStore.audit(INGEST_SKIP_OP, throttled, doneKey)
      return { scannedEvents: slice.length, candidates: 0, written: 0, merged: 0, deferred: 0, dropped: 0, skipped: throttled }
    }
  }

  // 召回占位先行：切片内召回工具的输出替换为占位文本，阻断记忆内容回流成新记忆。
  const scoped = omitRecallToolResults(slice)
  const { texts, minSeq } = collectTexts(scoped, limits.includeAssistant)
  // 入库前协议剥离 + 密钥脱敏；交给提取模型的 userText 同样脱敏。
  const cleaned = texts.map(text => redactSecrets(sanitizeProtocolText(text)))
  if (cleaned.every(text => text === '')) {
    await auditStore.audit(INGEST_SKIP_OP, 'no-user-content', doneKey)
    return { scannedEvents: slice.length, candidates: 0, written: 0, merged: 0, deferred: 0, dropped: 0, skipped: 'no-user-content' }
  }

  const route = deps.routeOverride ?? routeFromEvents(deps.events)
  if (route === undefined) {
    // 路由取自会话日志自身，对既有历史是确定性的：无路由头的历史轮不会再有路由。
    await auditStore.audit(INGEST_SKIP_OP, 'no-route-in-log', doneKey)
    return { scannedEvents: slice.length, candidates: 0, written: 0, merged: 0, deferred: 0, dropped: 0, skipped: 'no-route-in-log' }
  }

  // 防回声室附注：上一轮调用过召回工具时，提示提取模型既有记忆的复述不是新信息。
  const recallNote = hasRecallToolCalls(scoped)
    ? message('llm.ingestRecallNote')
    : ''
  const userText = `${message('llm.ingestUserPrompt')}\n${JSON.stringify(cleaned)}${recallNote === '' ? '' : `\n${recallNote}`}`
  deps.logRequest({ route, round, userText, maxTokens: INGEST_MAX_TOKENS, mode: deps.mode })
  let raw = await deps.call({
    route,
    system: ingestSystemPrompt(),
    userText,
    maxTokens: INGEST_MAX_TOKENS,
    purpose: 'engram-ingest',
    signal: deps.signal,
  })
  let parsed = parseJsonArray(raw)
  // 空答案重试一次：推理模型的 reasoning_tokens 计入 completion 预算，预算可能耗在思考上
  // （答案为空），一整轮对话因此静默丢失。重试给该轮第二次机会；非空但不可解析的输出
  // 已有 parseJsonArray 前缀抢救，不重试（避免为坏输出双倍计费）。
  if (parsed === undefined && raw.trim() === '') {
    raw = await deps.call({
      route,
      system: ingestSystemPrompt(),
      userText,
      maxTokens: INGEST_MAX_TOKENS,
      purpose: 'engram-ingest',
      signal: deps.signal,
    })
    parsed = parseJsonArray(raw)
  }
  if (parsed === undefined) {
    // 失败原因细分：空答案（重试后仍空）与不可解析分开记，事后排查不必回放请求。
    return { scannedEvents: slice.length, candidates: 0, written: 0, merged: 0, deferred: 0, dropped: 0, skipped: raw.trim() === '' ? 'empty-answer' : 'unparseable-output' }
  }

  const embedder = await deps.embedder
  // Поставщик судьи спрашивается в момент операции, а не при сборке плагина: панель
  // могла измениться, а вопросы одной операции делят одно соединение.
  const judge = deps.resolveJudge?.()
  const writtenContents: string[] = []
  let written = 0
  let merged = 0
  let deferred = 0
  let dropped = 0
  // 异常落榜的候选数（区别于内容非法等确定性淘汰）——全败回合保留 pending 用（审计 F13）。
  let failedDrops = 0
  for (const item of parsed.slice(0, limits.maxCandidates)) {
    const candidate = item as { content?: unknown; kind?: unknown; scope?: unknown; importance?: unknown; entities?: unknown; facts?: unknown }
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
    const importance = typeof candidate.importance === 'number' && Number.isFinite(candidate.importance)
      ? Math.min(1, Math.max(0, candidate.importance))
      : 0.5
    // 同批重复内容直接 DROP。
    if (writtenContents.includes(content)) { dropped += 1; continue }
    // 审计 F13 · 逐候选隔离：嵌入/裁决/落库失败只属于这一条——计入 dropped、警告、
    // 继续余下候选。此前一条抛错会弃掉整批后半，且 done 键不写（:622 被跳过），
    // 重放于是整轮重跑：第二个付费 LLM 调用换回同一批候选。批内自愈的范式同
    // tools/create.ts 的 saveBatch。
    try {
      const target = deps.resolveStore === undefined ? store : await deps.resolveStore(scope)
      // 实体关联（schema v10）：候选自带的 entities 消解为词典实体后挂到最终条目上。
      // 事实链（schema v11）：候选自带的 facts 按归一化实体名对上消解结果后写进事实表。
      // 增强数据：消解/关联/事实写入失败只跳过，不改变该候选的写入处置结果。
      const linkEntities = async (nodeId: MemoryId): Promise<void> => {
        const mentions = parseEntityMentions(candidate.entities)
        if (mentions.length === 0) return
        try {
          const entities = await target.resolveEntities(mentions)
          await target.linkNodeEntities(nodeId, entities.map(entity => entity.id))
          const factInputs: FactWriteInput[] = []
          const byName = new Map(entities.map(entity => [normalizeEntityName(entity.name), entity]))
          for (const mention of parseFactMentions(candidate.facts)) {
            const entity = byName.get(normalizeEntityName(mention.entity))
            if (entity === undefined) continue
            factInputs.push({ entityId: entity.id, content: mention.content, sourceNodeId: nodeId })
          }
          if (factInputs.length > 0) await target.writeFacts(factInputs)
        } catch {
          // 实体词典/事实表写入失败（如 EMPTY_ENTITY_NAME）不影响记忆条目本身的落库。
        }
      }
      // 四态处置（嵌入可用时）：复述并入强化既有条目（MERGE，不新建）；
      // 疑似矛盾/修正落库并建 contradicts 边待裁决（DEFER）；其余 ACCEPT。
      const vector = embedder === undefined ? undefined : (await embedder.embed([content]))[0]
      // judge + content 成对提供时，DEFER 模糊带（0.88-0.92 之外按阈值）交 Jev 三路裁决；失败静默降级回 defer。
      const decision = await decideWrite(target, kind, vector, judge === undefined ? {} : { judge, content })
      if (decision.disposition === 'merge') {
        await applyMerge(target, decision, content)
        await linkEntities(decision.into.id)
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
        // judge 在场时矛盾边先经 Jev 确认（失败返回 undefined = 降级为全量建边，与旧行为一致）。
        const neighbors = judge === undefined
          ? [decision.neighbor]
          : (await confirmContradictions(judge, content, [decision.neighbor], target)) ?? [decision.neighbor]
        for (const neighbor of neighbors) {
          // Запись уже сохранена: защитно пропускаем саму себя, чтобы не создать
          // связь «противоречит сама себе» (см. то же место в tools/create.ts).
          if (neighbor.id === record.id) continue
          await target.linkEdge(record.id, neighbor.id, 'contradicts')
        }
        deferred += 1
      }
      await linkEntities(record.id)
      writtenContents.push(content)
      written += 1
    } catch (error) {
      dropped += 1
      failedDrops += 1
      console.warn(message('ingest.candidateFailed'), content.slice(0, 80), error)
    }
  }
  // 审计 F13 的对偶面：逐条隔离不能把「整回合瞬时失败」（嵌入端点抖动、库短暂锁死）
  // 洗成「成功零写入」——done 键照写会关掉 pending 重放这条恢复路，那轮对话的记忆
  // 就永久丢了。此时不写 done 键、以 skipped 报告，重放侧保留 pending 下个会话再试。
  // 判定用 failedDrops（异常落榜）而不是 dropped（含空内容等确定性淘汰——那种重放也不会成功）。
  if (failedDrops > 0 && written === 0 && merged === 0 && deferred === 0) {
    return { scannedEvents: slice.length, candidates: parsed.length, written, merged, deferred, dropped, skipped: 'all-candidates-failed' }
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
    console.warn(message('llm.warnFinalIngestFailed'), error)
    return null
  }
}

/** 会话摘要提示词：一句话概括整场会话，供情景时间线的组头展示。 */
function sessionSummarySystemPrompt(): string {
  return message('llm.sessionSummarySystem')
}

/** 会话摘要输出 token 上限（一句话足够）。 */
const SESSION_SUMMARY_MAX_TOKENS = 160
/** 会话摘要的输入截断上限（字符）：摘要只需主题级信息，超长会话截尾。 */
const SESSION_SUMMARY_TEXT_LIMIT = 4000

/** 收集整场会话的对话文本（用户跳过插件注入快照 + 助手），脱敏后拼接并截断。 */
function collectSessionText(events: readonly SessionEventLike[]): string {
  const texts: string[] = []
  for (const event of events) {
    if (event.type === 'user/message') {
      const data = event.data as { source?: { kind?: unknown }; content?: { type?: unknown; text?: unknown }[] } | null
      if (typeof data?.source?.kind === 'string' && data.source.kind.startsWith('plugin')) continue
      const segments = (data?.content ?? [])
        .filter(block => block?.type === 'text' && typeof block.text === 'string')
        .map(block => block.text as string)
      if (segments.length > 0) texts.push(...segments)
    } else if (event.type === 'assistant/message') {
      const data = event.data as { content?: { type?: unknown; text?: unknown }[] } | null
      const segments = (data?.content ?? [])
        .filter(block => block?.type === 'text' && typeof block.text === 'string')
        .map(block => block.text as string)
      if (segments.length > 0) texts.push(...segments)
    }
  }
  const cleaned = texts.map(text => redactSecrets(sanitizeProtocolText(text))).filter(text => text !== '')
  const joined = cleaned.join('\n')
  return joined.length > SESSION_SUMMARY_TEXT_LIMIT ? `${joined.slice(0, SESSION_SUMMARY_TEXT_LIMIT)}…` : joined
}

/** 会话摘要依赖：实时会话收尾与历史回填共用同一套提炼与守卫。 */
export interface SessionSummaryDeps {
  /** 整场会话的事件（摘要是会话级，不是单轮切片）。 */
  readonly events: readonly SessionEventLike[]
  /** 会话 id（摘要在 session_summaries 表的存储键）。 */
  readonly sessionId: string
  /** 摘要落库目标（会话主库：有 cwd 落该项目库，无 cwd 落 user 库）。 */
  readonly openStore: () => Promise<EngramStore>
  /** 辅助 LLM 调用。 */
  readonly call: IngestDeps['call']
  /** 辅助调用请求记入会话日志（model-visible ⟺ logged）。 */
  readonly logRequest: IngestDeps['logRequest']
  /** 档位（请求日志负载字段）。 */
  readonly mode: Exclude<IngestMode, 'off'>
  /** 显式路由覆盖；缺省从日志解析。 */
  readonly routeOverride: LlmRoute | undefined
  /** 取消信号。 */
  readonly signal: AbortSignal
  /** 摘要请求挂在的轮次号（请求日志按轮次归档；缺省按 0 记）。 */
  readonly round: number | undefined
}

/**
 * 会话循环结束处生成一句话摘要（情景时间线组头的增强信息）：
 * 已有摘要直接跳过（重跑幂等，不再起 LLM）；无可用路由 / 已中止 / 无对话文本同样跳过。
 * LLM 失败静默：摘要是增强信息，实时路径挂在 dispose 观察器、回填路径在批次循环里，
 * 一次限流/超时都不值得升级为告警或失败。
 */
export async function ensureSessionSummary(deps: SessionSummaryDeps): Promise<void> {
  if (deps.signal.aborted) return
  const route = deps.routeOverride ?? routeFromEvents(deps.events)
  if (route === undefined) return
  const dialog = collectSessionText(deps.events)
  if (dialog === '') return
  const store = await deps.openStore()
  if (await store.getSessionSummary(deps.sessionId) !== undefined) return
  const userText = `${message('llm.sessionSummaryUserPrompt')}\n${dialog}`
  deps.logRequest({ route, round: deps.round ?? 0, userText, maxTokens: SESSION_SUMMARY_MAX_TOKENS, mode: deps.mode })
  try {
    const raw = await deps.call({
      route,
      system: sessionSummarySystemPrompt(),
      userText,
      maxTokens: SESSION_SUMMARY_MAX_TOKENS,
      purpose: 'engram-session-summary',
      signal: deps.signal,
    })
    const summary = raw.trim()
    if (summary === '') return
    await store.setSessionSummary(deps.sessionId, summary)
  } catch {
    // 静默：摘要缺失只影响组头展示。
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
  readonly embedder: EmbedderHandle
  /** 档位。 */
  readonly mode: Exclude<IngestMode, 'off'>
  /** 显式路由覆盖；缺省从日志解析。 */
  readonly routeOverride: LlmRoute | undefined
  /** 辅助 LLM 调用。 */
  readonly call: IngestDeps['call']
  /** 辅助调用请求审计。 */
  readonly logRequest: IngestDeps['logRequest']
  /** Поставщик судьи Jev; отсутствует или вернул undefined = 纯规则四态. */
  readonly resolveJudge?: JudgeProvider
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
 * pending 直接出队；事件源不可得的保留到下次。
 * 审计 F11：单个键失败不再冲出整个循环（队头阻塞——#1 失败 #2..N 全不试）。
 * 审计 F12/F11②：LLM 已付费但输出不可解析/为空时保留 pending 下次重试（可能是暂时性
 * 截断）；但会话陈旧（末事件早于 REPLAY_ABANDON_AGE_MS）即放弃——确定性失败不应
 * 每个会话白付一次辅助调用、永久卡住队列。
 * 每条 pending 按它自己会话的 cwd 组装写入路由（补做时同样逐条判宫殿）。
 */

/** pending 重放的放弃窗口：会话末事件早于该时长视为陈旧，失败即出队。 */
const REPLAY_ABANDON_AGE_MS = 14 * 86_400_000

/** 会话末事件早于放弃窗口即为陈旧（事件缺 time 无法判定时视作非陈旧，保守保留）。 */
function replayStale(session: { events: readonly SessionEventLike[] }): boolean {
  for (let i = session.events.length - 1; i >= 0; i -= 1) {
    const time = session.events[i]?.time
    if (time !== undefined) return Date.now() - time > REPLAY_ABANDON_AGE_MS
  }
  return false
}

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
    const stale = replayStale(session)
    try {
      const outcome = await ingestPreviousTurn({
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
        ...(deps.resolveJudge === undefined ? {} : { resolveJudge: deps.resolveJudge }),
        signal: deps.signal,
      })
      if (outcome.skipped === 'unparseable-output' || outcome.skipped === 'empty-answer' || outcome.skipped === 'all-candidates-failed') {
        kept += 1
        if (stale) {
          await store.clearAudit(INGEST_PENDING_OP, detail)
          console.warn(message('ingest.replayAbandoned'), key.sessionId, key.turn, outcome.skipped)
        }
        continue
      }
      await store.clearAudit(INGEST_PENDING_OP, detail)
      replayed += 1
    } catch (error) {
      kept += 1
      if (stale) {
        await store.clearAudit(INGEST_PENDING_OP, detail)
        console.warn(message('ingest.replayAbandoned'), key.sessionId, key.turn, error instanceof Error ? error.message : error)
      } else {
        console.warn(message('ingest.replayKeyFailed'), key.sessionId, key.turn, error)
      }
    }
  }
  return { replayed, kept }
}
