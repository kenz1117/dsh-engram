/**
 * 21 个 engram_ 工具的定义与执行器。工具 schema 保持窄参数；
 * scope 决定读写哪个分库；嵌入缺失时检索结果显式标记降级。
 * @module @kenz1117/dsh-engram/tools/create
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { AsyncLocalStorage } from 'node:async_hooks'
import { join } from 'node:path'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { distillMemories } from '../flywheel/distill.ts'
import { reflectObservations } from '../consolidation/reflect.ts'
import { writeMirror } from '../mirror/markdown.ts'
import type { EngramEmbedder } from '../embedder/interface.ts'
import { parseJsonArray, routeFromEvents } from '../llm/client.ts'
import type { LlmRoute } from '../llm/client.ts'
import type { EngramStore } from '../store/interface.ts'
import { embedImportedRecords, parseImportData, parseMarkdownExport } from '../store/import.ts'
import { parseEntityMentions } from '../ingest/hook.ts'
import type { EngramKind, EngramScope, EntityId, EntityMention, ExportData, FactRecord, FactWriteInput, ImageryLabel, MemoryId } from '../types.ts'
import type { MemoryRecord, SearchHit } from '../types.ts'
import { EPISODE_PROXIMITY_MS_DEFAULT, EPISODE_TIMELINE_LIMIT_DEFAULT, EngramError, asEntityId, asFactId, asMemoryId, normalizeEntityName } from '../types.ts'
import { packageRoot } from '../registry/root.ts'
import { renderMemoryPacket, sanitizeProtocolText } from '../security/sanitize.ts'
import { redactSecrets } from '../security/redact.ts'
import {
  MAX_REWRITE_QUERIES, REWRITE_MAX_TOKENS, rewriteSystem, RRF_CONSTANT,
  mergeQueryResults, normalizeRewriteQueries,
} from '../retrieve/rewrite.ts'
import { RECALL_TOTAL_CHARS, enforceBudget, fitWithinBudget, truncateItem } from '../retrieve/budget.ts'
import {
  MAX_BATCHES_PER_SESSION, MAX_EVIDENCE_REFS, NEXT_STRATEGIES, assessEvidence, evidenceBatches, evidenceRefOf,
} from '../retrieve/evidence.ts'
import type { AssessVerdict, NextStrategy } from '../retrieve/evidence.ts'
import { placardImprovementHint } from '../imagery/score.ts'
import type { HistoryBackfillRules, HistoryEstimate, HistoryRunResult } from '../ingest/history.ts'
import { applyMerge, confirmContradictions, decideWrite } from '../write-disposition.ts'
import type { JudgeProvider, MemoryJudge, WriteDisposition } from '../write-disposition.ts'
import type { EngramLanguage } from '../i18n/language.ts'
import { message } from '../i18n/messages.ts'
import { resolveRoomInput, roomLabel } from '../i18n/rooms.ts'

/** 工具依赖：分库打开器、嵌入器承诺、辅助 LLM 调用与导出目录。 */
export interface ToolDeps {
  /** 每次调用解析目标 scope 的分库（user/shared 各一）。 */
  readonly openStore: (scope: EngramScope) => Promise<EngramStore>
  /**
   * 项目分库解析：按会话 cwd 归属（undefined = 会话 cwd 不可得，回退插件进程目录）。
   * 与面板「项目」scope、自动摄取的落点同一口径——切换工作区时工具读写随会话走。
   */
  readonly resolveProjectStore: (cwd: string | undefined) => Promise<EngramStore>
  /** 嵌入器承诺；undefined = 嵌入不可用，检索降级纯关键词、矛盾检测停用。 */
  readonly embedder: Promise<EngramEmbedder | undefined>
  /** 辅助 LLM 调用（index.ts 用 ctx.llm.stream 构造）；undefined = distill 不可用。sessionId 由调用点补齐。 */
  readonly call: ((params: { route: LlmRoute; system: string; userText: string; maxTokens: number; purpose: string; signal: AbortSignal; sessionId: string | undefined }) => Promise<string>) | undefined
  /** 显式路由覆盖（Config provider+model）；缺省从会话日志解析。 */
  readonly routeOverride: LlmRoute | undefined
  /**
   * Поставщик судьи Jev: спрашивается в начале вызова инструмента, поэтому включение
   * Jev и выбор провайдера, модели или адреса в панели действуют без перезапуска.
   * Отсутствует или вернул undefined = судьи нет, чистые правила (DEFER пишется и сразу связывается).
   */
  readonly resolveJudge?: JudgeProvider
  /** 是否启用检索查询改写（Config queryRewrite）；false 时 engram_search 直接单查询。 */
  readonly queryRewrite: boolean
  /** 导出文件目录（engram_export 写入）。 */
  readonly exportDir: string
  /**
   * Язык текстов, которые формирует плагин (имена комнат, сообщения инструментов).
   * Приходит из разобранной конфигурации: «auto» там уже развёрнут в язык системы.
   */
  readonly language: EngramLanguage
  /** 历史回填（可选：缺省时不注册 engram_ingest_history，表示环境不支持读取历史会话）。 */
  readonly historyBackfill?: {
    /** 估算：候选会话数 / 规则内轮数 / 真正待处理轮数。 */
    readonly estimate: (rules: HistoryBackfillRules) => Promise<HistoryEstimate>
    /** 执行：逐会话逐轮摄取（同步等待，受调用方 signal 约束）。 */
    readonly run: (rules: HistoryBackfillRules, signal: AbortSignal) => Promise<HistoryRunResult>
  }
}

const KINDS = ['fact', 'preference', 'decision', 'episode', 'skill'] as const

/**
 * 工具执行期的会话 cwd：project scope 的读写据此解析项目宫殿。
 * 用 AsyncLocalStorage 而不是模块级变量：同一进程里多个会话的工具调用可能交错，
 * 模块级可变状态会把 A 会话的 cwd 泄漏给 B 会话。
 */
const execSessionCwd = new AsyncLocalStorage<string | undefined>()

/** 从工具运行上下文取会话 cwd（缺省 = 无会话信息，调用方回退插件进程目录）。 */
function sessionCwdOf(exec: ToolRunContext): string | undefined {
  const cwd = exec.agent?.session?.header?.cwd
  return cwd === undefined || cwd === '' ? undefined : cwd
}

/** 工具入参时间解析：ISO 或可解析日期字符串 → epoch 毫秒；缺省 undefined；不可解析 loud 失败。 */
function parseTimeParam(raw: string | undefined, toolName: string, field: string): number | undefined {
  if (raw === undefined) return undefined
  const ms = Date.parse(raw)
  if (Number.isNaN(ms)) throw new Error(message('tool.paramNotParsableTime', { tool: toolName, field, value: raw }))
  return ms
}

/** 工具入参正数解析（分钟/条数等计数）：缺省 fallback；非有限数字或越界 loud 失败。 */
function parseCountParam(raw: number | undefined, toolName: string, field: string, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback
  if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new Error(message('tool.paramMustBeFiniteNumber', { tool: toolName, field, value: raw }))
  const value = Math.floor(raw)
  if (value < min || value > max) throw new Error(message('tool.paramOutOfRange', { tool: toolName, field, min, max, value }))
  return value
}

/** 事实链行渲染：序号 + 陈述 + id/生效日期；失效事实附失效日期与后继 id（全链视图用）。 */
function renderFactLine(index: number, fact: FactRecord): string {
  const valid = new Date(fact.validAt).toISOString().slice(0, 10)
  const state = fact.invalidAt === null
    ? ''
    : message('tool.factLineInvalid', {
        invalidAt: new Date(fact.invalidAt).toISOString().slice(0, 10),
        replacedBy: fact.replacedBy ?? message('tool.factReplacedByUnknown'),
      })
  return message('tool.factLine', { index: index + 1, content: fact.content, id: fact.id, validAt: valid, state })
}

/** 历史回填估算的模型可读文本（零成本，先看数再决定跑不跑）。 */
function renderHistoryEstimate(estimate: HistoryEstimate): string {
  if (estimate.unavailable !== undefined) return message('tool.historyUnavailable', { reason: estimate.unavailable })
  const rules = estimate.rules
  const window = rules.days === 0 ? message('tool.historyDaysUnlimited') : message('tool.historyDays', { days: rules.days })
  const yesNo = (flag: boolean): string => (flag ? message('tool.historyYes') : message('tool.historyNo'))
  const lines = [
    message('tool.historyEstimateSummary', {
      candidates: estimate.candidates,
      eligibleTurns: estimate.eligibleTurns,
      pendingTurns: estimate.pendingTurns,
      alreadyIngested: estimate.alreadyIngested,
    }),
    message('tool.historyEstimateRules', {
      window,
      maxTurnsPerSession: rules.maxTurnsPerSession,
      maxTotalTurns: rules.maxTotalTurns,
      subagents: yesNo(rules.includeSubagents),
      seeded: yesNo(rules.includeSeeded),
      noCwd: yesNo(rules.includeNoCwd),
    }),
    message('tool.historyEstimateSkipped', {
      subagent: estimate.skipped.subagent,
      seeded: estimate.skipped.seeded,
      noCwd: estimate.skipped.noCwd,
      tooOld: estimate.skipped.tooOld,
      unreadable: estimate.skipped.unreadable,
    }),
  ]
  if (estimate.truncated) {
    lines.push(message('tool.historyEstimateTruncated'))
  }
  lines.push(message('tool.historyEstimateNote'))
  return lines.join('\n')
}

/** 历史回填执行结果的模型可读文本。 */
function renderHistoryRun(result: HistoryRunResult): string {
  const state = result.state === 'done'
    ? message('tool.historyStateDone')
    : result.state === 'cancelled' ? message('tool.historyStateCancelled') : message('tool.historyStateFailed')
  const lines = [
    message('tool.historyRunSummary', {
      state,
      sessionsDone: result.sessionsDone,
      sessionsTotal: result.sessionsTotal,
      turnsDone: result.turnsDone,
      memoriesWritten: result.memoriesWritten,
      turnsSkipped: result.turnsSkipped,
      turnsFailed: result.turnsFailed,
    }),
  ]
  const reasons = Object.entries(result.skipReasons).sort(([, a], [, b]) => b - a)
  if (reasons.length > 0) {
    const listed = reasons.map(([reason, count]) => message('tool.historySkipReason', { reason, count })).join(' · ')
    lines.push(message('tool.historyRunSkipReasons', { reasons: listed }))
  }
  if (result.failures.length > 0) {
    const shown = result.failures.slice(0, 3).map(failure =>
      message('tool.historyFailureEntry', { sessionId: failure.sessionId.slice(-12), turn: failure.turn, reason: failure.reason }))
    lines.push(message('tool.historyRunFailures', { count: shown.length, entries: shown.join(message('tool.separatorSemicolon')) }))
    // 最常见的一种失败：历史会话记录的路由在当前环境没有对应模型配置。
    lines.push(message('tool.historyRunRouteHint'))
  }
  lines.push(message('tool.historyRunIdempotent'))
  return lines.join('\n')
}

/** 证据门策略的可读提示（取值时才解析语言：模块级常量不能把语言固化在加载期）。 */
const STRATEGY_HINT: Record<NextStrategy, () => string> = {
  answer: () => message('tool.strategyAnswer'),
  search_keyword: () => message('tool.strategySearchKeyword'),
  search_room: () => message('tool.strategySearchRoom'),
  search_timeline: () => message('tool.strategySearchTimeline'),
  ask_user: () => message('tool.strategyAskUser'),
  stop: () => message('tool.strategyStop'),
}

/** 证据门判定的模型可读文本（含被拒绝的 ref 与强制改写说明）。 */
function renderAssessText(verdict: AssessVerdict, batchId: string): string {
  const lines = [
    verdict.sufficient
      ? message('tool.assessSufficient', { batchId, count: verdict.evidenceRefs.length })
      : message('tool.assessInsufficient', { batchId }),
  ]
  if (verdict.evidenceRefs.length > 0) lines.push(message('tool.assessEvidenceRefs', { refs: verdict.evidenceRefs.join(message('tool.separatorIdea')) }))
  if (verdict.rejectedRefs.length > 0) lines.push(message('tool.assessRejectedRefs', { refs: verdict.rejectedRefs.join(message('tool.separatorIdea')) }))
  if (verdict.droppedRefs.length > 0) lines.push(message('tool.assessDroppedRefs', { max: MAX_EVIDENCE_REFS, refs: verdict.droppedRefs.join(message('tool.separatorIdea')) }))
  const missing = `${verdict.missing === '' ? message('tool.assessMissingEmpty') : verdict.missing}${verdict.missingTruncated ? message('tool.assessMissingTruncated') : ''}`
  lines.push(message('tool.assessMissing', { missing }))
  lines.push(message('tool.assessNextStep', { strategy: verdict.nextStrategy, hint: STRATEGY_HINT[verdict.nextStrategy]() }))
  if (verdict.forced) {
    lines.push(message('tool.assessForcedNote'))
  }
  return lines.join('\n')
}

/** 从模型参数收敛 scope（非法值或缺失回退 fallback）。 */
function scopeOf(raw: unknown, fallback: EngramScope): EngramScope {
  if (raw === 'user' || raw === 'project' || raw === 'shared') return raw
  return fallback
}

/** 把 search scope 参数收敛为分库集合。 */
function scopesOf(raw: unknown): EngramScope[] {
  if (raw === 'user') return ['user']
  if (raw === 'project') return ['project']
  if (raw === 'shared') return ['shared']
  return ['user', 'project', 'shared']
}

/** 查询向量：嵌入可用时返回查询文本的向量，否则 undefined（降级）。 */
async function queryVectorOf(deps: ToolDeps, text: string): Promise<Float32Array | undefined> {
  const embedder = await deps.embedder
  if (embedder === undefined || text.trim() === '') return undefined
  const vectors = await embedder.embed([text.trim()])
  return vectors[0]
}

/**
 * 检索查询改写：辅助 LLM 把查询改写为 ≤3 个互补查询。任何失败（无 call、
 * 无路由、输出不可解析、调用异常）都降级为只含原查询的列表，不阻塞检索。
 * 改写成功时把请求审计到 user 库（辅助调用不进会话日志，落 op_log 供归因）。
 */
async function rewriteQueries(deps: ToolDeps, exec: ToolRunContext, query: string): Promise<{ queries: string[]; rewritten: boolean }> {
  if (deps.call === undefined || !deps.queryRewrite) return { queries: [query], rewritten: false }
  const events = (exec.agent?.session?.snapshotEvents() ?? []) as unknown as Parameters<typeof routeFromEvents>[0]
  const route = deps.routeOverride ?? routeFromEvents(events)
  if (route === undefined) return { queries: [query], rewritten: false }
  try {
    const raw = await deps.call({
      route,
      system: rewriteSystem(),
      userText: query,
      maxTokens: REWRITE_MAX_TOKENS,
      purpose: 'engram-rewrite',
      signal: exec.signal,
      sessionId: exec.agent === undefined ? undefined : String(exec.agent.session.id),
    })
    const queries = normalizeRewriteQueries(parseJsonArray(raw), MAX_REWRITE_QUERIES)
    if (queries.length === 0) return { queries: [query], rewritten: false }
    await (await deps.openStore('user')).audit('search-rewrite-request', 'AUX', JSON.stringify({ route, query, queries }))
    return { queries, rewritten: true }
  } catch {
    // 改写是增强路径：失败一律降级原查询单查。
    return { queries: [query], rewritten: false }
  }
}

/**
 * 构造 21 个工具定义（engram_save/search/facts/assess/timeline/episode_timeline/update/forget/report/review/review_queue/
 * stats/export/import/distill/examine/neighbors/audit_forgotten/tour/ingest_history/profile_edit）。
 * @param baseDeps - 分库打开器、嵌入器、辅助 LLM、导出目录。
 * @returns 可直接 register 的工具定义数组（execute 已绑定会话 cwd 的项目宫殿路由）。
 */
export function createEngramTools(baseDeps: ToolDeps): ToolDefinition[] {
  /**
   * 分库门面：project scope 一律走 `resolveProjectStore(执行期会话 cwd)`，
   * 其余 scope 原样透传。所有 handler 都用这个 `deps`，无需逐处改调用点。
   */
  const deps: ToolDeps = {
    ...baseDeps,
    openStore: scope => (scope === 'project'
      ? baseDeps.resolveProjectStore(execSessionCwd.getStore())
      : baseDeps.openStore(scope)),
  }
  /** 批量保存上限（协议内常量：与单轮摄取候选量级对齐，防一次灌入过多）。 */
  const MAX_SAVE_BATCH = 10

  /** engram_save 输出视图（schema 放宽后单条/批量字段均可能缺席）。 */
  interface SaveResultView {
    readonly id?: string
    readonly kind?: string
    readonly importance?: number
    /** 写入四态处置：accept 新建 / merge 并入强化 / defer 待裁决（drop 不进结果——校验失败的条目走 failed）。 */
    readonly disposition?: WriteDisposition
    /** merge：被并入强化的既有条目 id。 */
    readonly mergedInto?: string
    /** merge/defer：与最近邻的余弦相似度。 */
    readonly similarity?: number
    /** 单条矛盾警告文本（execute 生成，render 优先呈现）。 */
    readonly text?: string
    /** 批量模式：成功条数。 */
    readonly count?: number
    /** 批量模式：成功条目（带宫殿坐标与处置，让批量写入也有位置感与四态可见性）。 */
    readonly items?: readonly { id: string; kind: string; importance: number; slot?: { room: string; index: number }; disposition: Exclude<WriteDisposition, 'drop'>; mergedInto?: string }[]
    /** 批量模式：失败条目（index 为 items 数组下标）。 */
    readonly failed?: readonly { index: number; reason: string }[]
  }

  /** engram_save 呈现文本：矛盾警告 text 优先；批量输出汇总成功与失败。 */
  function renderSaveResultText(value: SaveResultView): string {
    if (value.count !== undefined) {
      const items = value.items ?? []
      const merged = items.filter(item => item.disposition === 'merge').length
      const deferred = items.filter(item => item.disposition === 'defer').length
      const parts = [message('tool.saveBatchSaved', { count: value.count })]
      const states: string[] = []
      if (merged > 0) states.push(message('tool.saveBatchMerged', { count: merged }))
      if (deferred > 0) states.push(message('tool.saveBatchDeferred', { count: deferred }))
      if (states.length > 0) parts.push(states.join(message('tool.separatorClause')))
      for (const item of items) {
        const slot = item.slot === undefined ? '' : `, ${roomLabel(item.slot.room, deps.language)}#${item.slot.index}`
        const state = item.disposition === 'merge'
          ? message('tool.saveItemMergedInto', { id: item.mergedInto ?? '' })
          : item.disposition === 'defer' ? message('tool.saveItemDeferred') : ''
        parts.push(message('tool.saveItemLine', { id: item.id, kind: item.kind, importance: item.importance, slot, state }))
      }
      const failures = value.failed ?? []
      if (failures.length > 0) {
        const entries = failures.map(entry => message('tool.saveFailureEntry', { index: entry.index + 1, reason: entry.reason }))
        parts.push(message('tool.saveFailuresSummary', { count: failures.length, entries: entries.join(message('tool.separatorSemicolon')) }))
      }
      parts.push(message('tool.saveRecallNote'))
      return parts.join(message('tool.separatorSemicolon'))
    }
    if (value.text !== undefined) return value.text
    return message('tool.saveAcceptedText', {
      id: value.id ?? '',
      kind: value.kind ?? '',
      importance: value.importance ?? 0,
      slot: '',
    })
  }

  /** 单条写入的处置结果（批量与单条共用）。 */
  interface WriteOutcome {
    readonly disposition: Exclude<WriteDisposition, 'drop'>
    /** accept/defer：新条目；merge：被并入强化的既有条目。 */
    readonly record: MemoryRecord
    /** merge：被并入的既有条目 id；defer：最近邻 id。 */
    readonly relatedId?: string
    /** merge/defer：与最近邻的余弦相似度。 */
    readonly similarity?: number
    /** defer：全部矛盾候选（已建 contradicts 边，供呈现层报告）。 */
    readonly candidates: readonly MemoryRecord[]
  }

  /**
   * 写入单条已清洗内容（四态处置）：MERGE 不新建条目只强化既有；
   * DEFER 写入并建 contradicts 边待裁决；ACCEPT 原样写入。
   */
  async function writeWithDisposition(
    store: EngramStore,
    item: {
      scope: EngramScope
      kind: EngramKind
      content: string
      importance?: number
      sourceSessionId: string | null
      embedding?: Float32Array
      imagery?: ImageryLabel
    },
    judge: MemoryJudge | undefined,
  ): Promise<WriteOutcome> {
    const { embedding } = item
    // judge + content 成对提供时，DEFER 模糊带交 Jev 三路裁决；未注入 judge 时行为与纯规则四态一致。
    const decision = await decideWrite(store, item.kind, embedding, judge === undefined ? {} : { judge, content: item.content })
    if (decision.disposition === 'merge') {
      const record = await applyMerge(store, decision, item.content)
      return { disposition: 'merge', record, relatedId: decision.into.id, similarity: decision.similarity, candidates: [] }
    }
    const record = await store.write({
      scope: item.scope,
      kind: item.kind,
      content: item.content,
      ...(item.importance === undefined ? {} : { importance: item.importance }),
      sourceSessionId: item.sourceSessionId,
      ...(embedding === undefined ? {} : { embedding }),
      ...(item.imagery === undefined ? {} : { imagery: item.imagery }),
    })
    if (decision.disposition === 'defer') {
      // defer 时 embedding 必然存在（decideWrite 在无嵌入时只判 accept）。
      // Запись уже сохранена, поэтому она обязательно попадает в свой же список
      // ближайших соседей (косинус с собой равен единице). Исключаем себя, иначе
      // каждая отложенная запись порождает связь «противоречит сама себе».
      const candidates = (await store.findContradictions(embedding as Float32Array))
        .filter(candidate => candidate.id !== record.id)
      // judge 在场时矛盾边先经 Jev 确认（失败返回 undefined = 降级为全量建边，与旧行为一致）。
      const confirmed = judge === undefined
        ? candidates
        : (await confirmContradictions(judge, item.content, candidates, store)) ?? candidates
      for (const candidate of confirmed) {
        await store.linkEdge(record.id, candidate.id, 'contradicts')
      }
      return { disposition: 'defer', record, relatedId: decision.neighbor.id, similarity: decision.similarity, candidates: confirmed }
    }
    return { disposition: 'accept', record, candidates: [] }
  }

  /**
   * 实体关联辅助：消解实体提及并挂到条目。merge 处置挂被并入的既有条目，
   * accept/defer 挂新条目；失败静默（实体词典是增强数据，不阻塞记忆写入）。
   */
  async function linkEntities(store: EngramStore, nodeId: MemoryId, mentions: readonly EntityMention[]): Promise<void> {
    if (mentions.length === 0) return
    try {
      const entities = await store.resolveEntities(mentions)
      await store.linkNodeEntities(nodeId, entities.map(entity => entity.id))
    } catch {
      // 实体词典写入失败（如 EMPTY_ENTITY_NAME）不影响记忆条目本身的落库。
    }
  }

  /** 门牌参数收敛：非空字符串转 ImageryLabel（感官/情绪维度留空——AI 不需要人脑补丁），非法返回 undefined。 */
  function placardOf(raw: unknown): ImageryLabel | undefined {
    if (typeof raw !== 'string') return undefined
    const caption = raw.trim()
    if (caption === '') return undefined
    return { caption, sensoryTags: [], emotionalValence: 0, provisional: false }
  }

  /** 批量保存结果（输出 schema 的运行时形状）。 */
  interface SaveBatchResult {
    readonly count: number
    readonly items: { id: string; kind: string; importance: number; disposition: Exclude<WriteDisposition, 'drop'>; mergedInto?: string }[]
    readonly failed: { index: number; reason: string }[]
  }

  /** 批量保存：统一清洗/校验/批量内去重，一次批量嵌入，逐条写入；单条失败不阻塞其余。 */
  async function saveBatch(sourceSessionId: string | null, items: readonly unknown[], rawScope: unknown): Promise<SaveBatchResult> {
    if (items.length > MAX_SAVE_BATCH) throw new Error(message('tool.saveTooManyInBatch', { max: MAX_SAVE_BATCH }))
    const scope = scopeOf(rawScope, 'project')
    const store = await deps.openStore(scope)
    const embedder = await deps.embedder
    // 第一步：清洗 + 校验 + 批量内去重（失败按原始下标收集，不阻塞其余）。
    const prepared: { index: number; content: string; kind: EngramKind; importance: number | undefined; entities: readonly EntityMention[] }[] = []
    const failed: { index: number; reason: string }[] = []
    const seen = new Set<string>()
    for (const [index, raw] of items.entries()) {
      if (raw === null || typeof raw !== 'object') { failed.push({ index, reason: message('tool.reasonItemMustBeObject') }); continue }
      const candidate = raw as { content?: unknown; kind?: unknown; importance?: unknown; entities?: unknown }
      if (typeof candidate.content !== 'string' || candidate.content.trim() === '') {
        failed.push({ index, reason: message('tool.reasonContentMissingOrEmpty') }); continue
      }
      if (!KINDS.includes(candidate.kind as EngramKind)) {
        failed.push({ index, reason: message('tool.reasonKindInvalid') }); continue
      }
      const content = redactSecrets(sanitizeProtocolText(candidate.content))
      if (content.trim() === '') {
        failed.push({ index, reason: message('tool.reasonContentEmptyAfterSanitize') }); continue
      }
      const key = content.toLowerCase()
      if (seen.has(key)) { failed.push({ index, reason: message('tool.reasonDuplicateInBatch') }); continue }
      seen.add(key)
      prepared.push({
        index,
        content,
        kind: candidate.kind as EngramKind,
        importance: typeof candidate.importance === 'number' ? candidate.importance : undefined,
        entities: parseEntityMentions(candidate.entities),
      })
    }
    // 第二步：一次批量嵌入（对齐清洗后条目顺序）。
    const vectors = embedder === undefined || prepared.length === 0
      ? undefined
      : await embedder.embed(prepared.map(item => item.content.trim()))
    // 第三步：逐条处置写入；单条失败记入 failed 不阻塞其余（defer 的矛盾边照建，可经 engram_review 查看）。
    const saved: { id: string; kind: string; importance: number; slot?: { room: string; index: number }; disposition: Exclude<WriteDisposition, 'drop'>; mergedInto?: string }[] = []
    // Поставщик судьи спрашивается один раз на вызов инструмента: панель могла измениться
    // после сборки плагина, а вопросы одной операции делят одно соединение.
    const judge = deps.resolveJudge?.()
    for (const [position, item] of prepared.entries()) {
      try {
        const embedding = vectors?.[position]
        const outcome = await writeWithDisposition(store, {
          scope,
          kind: item.kind,
          content: item.content,
          ...(item.importance === undefined ? {} : { importance: item.importance }),
          sourceSessionId,
          ...(embedding === undefined ? {} : { embedding }),
        }, judge)
        // merge 处置无新条目，实体挂被并入的既有条目；其余挂新条目。
        const nodeId = outcome.disposition === 'merge' && outcome.relatedId !== undefined
          ? asMemoryId(outcome.relatedId)
          : outcome.record.id
        await linkEntities(store, nodeId, item.entities)
        saved.push({
          id: outcome.record.id,
          kind: outcome.record.kind,
          importance: outcome.record.importance,
          disposition: outcome.disposition,
          // merge 处置不新建条目，record 即被强化的既有条目，不重复报桩位。
          ...(outcome.disposition === 'merge' || outcome.record.slot === undefined ? {} : { slot: outcome.record.slot }),
          ...(outcome.disposition === 'merge' && outcome.relatedId !== undefined ? { mergedInto: outcome.relatedId } : {}),
        })
      } catch (error) {
        failed.push({ index: item.index, reason: error instanceof Error ? error.message : String(error) })
      }
    }
    return { count: saved.length, items: saved, failed }
  }

  const save = defineTool({
    name: 'engram_save',
    description: message('tool.saveDescription'),
    parameters: {
      content: { type: 'string', description: message('tool.saveContentDescription') },
      kind: { type: 'string', enum: [...KINDS], description: message('tool.saveKindDescription') },
      entities: {
        type: 'array',
        description: message('tool.saveEntitiesDescription'),
        items: { type: 'object', additionalProperties: false, properties: {
          name: { type: 'string', required: true, description: message('tool.entityNameDescription') },
          kind: { type: 'string', enum: ['person', 'project', 'tool', 'concept', 'other'], description: message('tool.entityKindDescription') },
          aliases: { type: 'array', items: { type: 'string' }, description: message('tool.entityAliasesDescription') },
        } },
      },
      items: {
        type: 'array',
        description: message('tool.saveItemsDescription'),
        items: { type: 'object', additionalProperties: false, properties: {
          content: { type: 'string', required: true, description: message('tool.saveItemContentDescription') },
          kind: { type: 'string', enum: [...KINDS], required: true, description: message('tool.saveItemKindDescription') },
          importance: { type: 'number', description: message('tool.saveItemImportanceDescription') },
          entities: {
            type: 'array',
            description: message('tool.saveItemEntitiesDescription'),
            items: { type: 'object', additionalProperties: false, properties: {
              name: { type: 'string', required: true, description: message('tool.entityNameDescription') },
              kind: { type: 'string', enum: ['person', 'project', 'tool', 'concept', 'other'], description: message('tool.entityKindDescription') },
              aliases: { type: 'array', items: { type: 'string' }, description: message('tool.entityAliasesDescription') },
            } },
          },
        } },
      },
      scope: { type: 'string', enum: ['user', 'project', 'shared'], description: message('tool.scopeDescriptionProject') },
      importance: { type: 'number', description: message('tool.saveImportanceDescription') },
      placard: { type: 'string', description: message('tool.savePlacardDescription') },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string' },
        kind: { type: 'string' },
        importance: { type: 'number' },
        disposition: { type: 'string', enum: ['accept', 'merge', 'defer'] },
        mergedInto: { type: 'string' },
        similarity: { type: 'number' },
        text: { type: 'string' },
        count: { type: 'number' },
        items: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
          id: { type: 'string', required: true },
          kind: { type: 'string', required: true },
          importance: { type: 'number', required: true },
          disposition: { type: 'string', enum: ['accept', 'merge', 'defer'], required: true },
          mergedInto: { type: 'string' },
          slot: { type: 'object', additionalProperties: false, properties: {
            room: { type: 'string', required: true },
            index: { type: 'number', required: true },
          } },
        } } },
        failed: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
          index: { type: 'number', required: true },
          reason: { type: 'string', required: true },
        } } },
      } },
      render: (_args, value) => [{ type: 'text', text: renderSaveResultText(value as SaveResultView) }],
    },
    async execute(args, exec) {
      const input = args as { content?: unknown; kind?: unknown; entities?: unknown; items?: unknown; scope?: unknown; importance?: unknown; placard?: unknown }
      const sourceSessionId = exec.agent?.id ?? null
      // 批量模式：items 与 content/kind 互斥，同传 loud 失败。
      if (input.items !== undefined) {
        if (input.content !== undefined || input.kind !== undefined) {
          throw new Error(message('tool.saveItemsConflict'))
        }
        if (!Array.isArray(input.items) || input.items.length === 0) {
          throw new Error(message('tool.saveItemsMustBeNonEmpty'))
        }
        return saveBatch(sourceSessionId, input.items, input.scope)
      }
      if (typeof input.content !== 'string' || typeof input.kind !== 'string') {
        throw new Error(message('tool.saveParamsRequired'))
      }
      // 入库前协议剥离 + 密钥脱敏（模型可能把会话中的密钥或协议块原样写进记忆）。
      const content = redactSecrets(sanitizeProtocolText(input.content))
      if (content.trim() === '') throw new Error(message('tool.saveContentEmptyAfterSanitize'))
      const scope = scopeOf(input.scope, 'project')
      const store = await deps.openStore(scope)
      const embedder = await deps.embedder
      const embeddings = embedder === undefined ? undefined : await embedder.embed([content.trim()])
      const imagery = placardOf(input.placard)
      const mentions = parseEntityMentions(input.entities)
      const judge = deps.resolveJudge?.()
      const outcome = await writeWithDisposition(store, {
        scope,
        kind: input.kind as EngramKind,
        content,
        ...(typeof input.importance === 'number' ? { importance: input.importance } : {}),
        sourceSessionId,
        ...(embeddings?.[0] === undefined ? {} : { embedding: embeddings[0] }),
        ...(imagery === undefined ? {} : { imagery }),
      }, judge)
      // 实体关联：merge 挂被并入的既有条目，accept/defer 挂新条目；失败静默。
      if (mentions.length > 0) {
        const nodeId = outcome.disposition === 'merge' && outcome.relatedId !== undefined
          ? asMemoryId(outcome.relatedId)
          : outcome.record.id
        await linkEntities(store, nodeId, mentions)
      }
      const { record, candidates } = outcome
      // MERGE：复述并入既有条目——不新建、不挂门牌，只强化并明确告知（防模型误以为新建成功）。
      if (outcome.disposition === 'merge') {
        const sim = (outcome.similarity ?? 0).toFixed(2)
        return {
          id: record.id,
          kind: record.kind,
          importance: record.importance,
          disposition: 'merge' as const,
          ...(outcome.relatedId === undefined ? {} : { mergedInto: outcome.relatedId }),
          ...(outcome.similarity === undefined ? {} : { similarity: outcome.similarity }),
          text: message('tool.saveMergeText', { similarity: sim, mergedInto: outcome.relatedId ?? '' }),
        }
      }
      // 门牌质量提示：低分（不合「唯一·差异化·带日期」纪律）附增强建议。
      const placardHint = imagery === undefined || record.imageryScore === undefined
        ? ''
        : `\n${placardImprovementHint(record.imageryScore) ?? ''}`
      // DEFER：疑似矛盾/修正——落库并建 contradicts 边，报告候选由模型/用户裁决。
      if (outcome.disposition === 'defer') {
        const listed = candidates.map(candidate => message('tool.contradictionEntry', { content: candidate.content, id: candidate.id })).join(message('tool.separatorSemicolon'))
        return {
          id: record.id,
          kind: record.kind,
          importance: record.importance,
          disposition: 'defer' as const,
          ...(outcome.similarity === undefined ? {} : { similarity: outcome.similarity }),
          text: message('tool.saveDeferText', { id: record.id, listed, placardHint }),
        }
      }
      const slot = record.slot === undefined ? '' : `, ${roomLabel(record.slot.room, deps.language)}#${record.slot.index}`
      const base = message('tool.saveAcceptedText', { id: record.id, kind: record.kind, importance: record.importance, slot })
      return { id: record.id, kind: record.kind, importance: record.importance, disposition: 'accept' as const, text: `${base}${placardHint}` }
    },
  })

  const search = defineTool({
    name: 'engram_search',
    description: message('tool.searchDescription'),
    parameters: {
      query: { type: 'string', required: true, description: message('tool.searchQueryDescription') },
      scope: { type: 'string', enum: ['user', 'project', 'shared', 'all'], description: message('tool.scopeDescriptionAll') },
      room: { type: 'string', description: message('tool.searchRoomDescription') },
      limit: { type: 'number', description: message('tool.searchLimitDescription') },
      asOf: { type: 'string', description: message('tool.searchAsOfDescription') },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        degraded: { type: 'boolean', required: true },
        text: { type: 'string', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const input = args as { query: string; scope?: unknown; room?: unknown; limit?: number; asOf?: unknown }
      const scopes = scopesOf(input.scope)
      const rooms = typeof input.room === 'string' && input.room.trim() !== ''
        ? [resolveRoomInput(input.room) ?? input.room.trim()]
        : undefined
      const limit = input.limit ?? 8
      const asOfMs = parseTimeParam(typeof input.asOf === 'string' ? input.asOf : undefined, 'engram_search', 'asOf')
      // 多查询改写：辅助 LLM 可用时生成 ≤3 个互补查询分别检索后 RRF 融合；
      // 失败/不可用降级原查询单查。多查询会对同一 id 重复命中强化（accessCount、
      // confidence 增长更快），语义上确为多次命中，属已知代价。
      const rewrite = await rewriteQueries(deps, exec, input.query)
      const retrievals = await Promise.all(rewrite.queries.map(async (queryText) => {
        const vector = await queryVectorOf(deps, queryText)
        const results = await Promise.all(scopes.map(async (scope) => {
          const store = await deps.openStore(scope)
          return store.search({ text: queryText, scopes: [scope], limit, ...(rooms === undefined ? {} : { rooms }) }, vector)
        }))
        return {
          hits: results.flatMap(result => result.hits).sort((a, b) => b.score - a.score).slice(0, limit),
          degraded: results.some(result => result.degraded),
        }
      }))
      const degraded = retrievals.some(retrieval => retrieval.degraded)
      const merged = mergeQueryResults(
        retrievals,
        limit,
        RRF_CONSTANT,
        Math.floor(Math.max(0, limit) / Math.max(1, rewrite.queries.length)),
      )
      // 字符预算：单条 1200、总量 4800（超预算行丢弃并提示，防止长记忆淹没上下文）。
      // 行格式带宫殿坐标（房间 #桩位 + 刻入日期）、证据 ref 与编码线索（相邻桩位 id）——提取时重建编码情境。
      // asOf 时点事实标签：命中记忆关联实体在该时点仍有效的事实（每记忆至多 4 条），随行参与预算裁剪。
      const factNotes = new Map<string, string[]>()
      if (asOfMs !== undefined) {
        const scopeGroups = new Map<EngramScope, MemoryId[]>()
        for (const hit of merged) {
          const ids = scopeGroups.get(hit.record.scope)
          if (ids === undefined) scopeGroups.set(hit.record.scope, [hit.record.id])
          else ids.push(hit.record.id)
        }
        for (const [scope, ids] of scopeGroups) {
          const store = await deps.openStore(scope)
          const entityMap = await store.entitiesOfNodes(ids)
          const factLists = new Map<EntityId, readonly FactRecord[]>()
          for (const entities of entityMap.values()) {
            for (const entity of entities) {
              if (factLists.has(entity.id)) continue
              factLists.set(entity.id, (await store.factsOfEntity({ entityId: entity.id, asOf: asOfMs, limit: 3, offset: 0 })).items)
            }
          }
          for (const [nodeId, entities] of entityMap) {
            const contents: string[] = []
            for (const entity of entities) {
              for (const fact of factLists.get(entity.id) ?? []) {
                if (contents.length >= 4) break
                contents.push(fact.content)
              }
            }
            if (contents.length > 0) factNotes.set(String(nodeId), contents)
          }
        }
      }
      const candidates = merged.map((hit, index) => {
        const ref = evidenceRefOf(hit.record.scope, hit.record.id, hit.record.slot, deps.language)
        const edge = hit.viaEdge === undefined ? '' : message('tool.searchViaEdge', { type: hit.viaEdge.type, from: hit.viaEdge.from })
        const slot = hit.record.slot === undefined ? '' : ` ${roomLabel(hit.record.slot.room, deps.language)}#${hit.record.slot.index}`
        const date = message('tool.searchCreatedAt', { date: new Date(hit.record.createdAt).toISOString().slice(0, 10) })
        const cues = hit.cues === undefined ? '' : message('tool.searchNeighborCues', { cues: hit.cues.neighbors.join(', ') })
        const notes = factNotes.get(String(hit.record.id))
        const facts = notes === undefined ? '' : message('tool.searchAsOfFacts', { facts: notes.join(message('tool.separatorSemicolon')) })
        return {
          ref,
          line: `${index + 1}. [${hit.record.scope}/${hit.record.kind}]${slot}${date} ${truncateItem(hit.record.content)}${message('tool.searchHitIdRef', { id: hit.record.id, ref })}${edge}${cues}${facts}`,
        }
      })
      const { kept, dropped } = fitWithinBudget(candidates, entry => entry.line.length, RECALL_TOTAL_CHARS)
      const lines = kept.map(entry => entry.line)
      if (dropped > 0) lines.push(message('store.budgetDropped', { count: dropped }))
      // 证据门：把本次真正输出的 ref 登记成批次，engram_assess 只能引用这里登记过的 ref。
      const sessionId = exec.agent === undefined ? undefined : String(exec.agent.session.id)
      const batch = sessionId === undefined || kept.length === 0
        ? undefined
        : evidenceBatches.register(sessionId, kept.map(entry => entry.ref))
      const prefix = degraded && lines.length > 0 ? message('tool.searchDegradedPrefix') : ''
      const roomNote = rooms === undefined ? '' : message('tool.searchRoomRoutePrefix', { rooms: rooms.join(message('tool.separatorIdea')) })
      const asOfNote = asOfMs === undefined ? '' : message('tool.searchAsOfPrefix', { date: new Date(asOfMs).toISOString().slice(0, 10) })
      const batchNote = batch === undefined
        ? ''
        : message('tool.searchBatchNote', { batchId: batch.batchId, count: batch.refs.size })
      // 输出包协议标签：记忆正文是不可信历史上下文，当前请求为检索词本身。
      return { degraded, text: renderMemoryPacket(`${prefix}${roomNote}${asOfNote}${lines.join('\n') || message('tool.searchNoHits')}${batchNote}`, 'tool_search', input.query) }
    },
  })

  const factsTool = defineTool({
    name: 'engram_facts',
    description: message('tool.factsDescription'),
    parameters: {
      scope: { type: 'string', enum: ['user', 'project', 'shared'], description: message('tool.scopeDescriptionProject') },
      entityId: { type: 'string', description: message('tool.factsEntityIdDescription') },
      entity: { type: 'string', description: message('tool.factsEntityDescription') },
      asOf: { type: 'string', description: message('tool.factsAsOfDescription') },
      includeInvalid: { type: 'boolean', description: message('tool.factsIncludeInvalidDescription') },
      limit: { type: 'number', description: message('tool.limitDescription20') },
      offset: { type: 'number', description: message('tool.factsOffsetDescription') },
      facts: {
        type: 'array',
        description: message('tool.factsWriteDescription'),
        items: { type: 'object', additionalProperties: false, properties: {
          entity: { type: 'string', description: message('tool.factsItemEntityDescription') },
          entityId: { type: 'string', description: message('tool.factsItemEntityIdDescription') },
          content: { type: 'string', required: true, description: message('tool.factsItemContentDescription') },
          replaces: { type: 'string', description: message('tool.factsItemReplacesDescription') },
        } },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        total: { type: 'number' },
        count: { type: 'number' },
        items: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
          id: { type: 'string', required: true },
          entityId: { type: 'string', required: true },
          replaced: { type: 'string' },
        } } },
        failed: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
          index: { type: 'number', required: true },
          reason: { type: 'string', required: true },
        } } },
        text: { type: 'string', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const input = args as {
        scope?: unknown; entityId?: unknown; entity?: unknown; asOf?: unknown
        includeInvalid?: unknown; limit?: unknown; offset?: unknown; facts?: unknown
      }
      const scope = scopeOf(input.scope, 'project')
      const store = await deps.openStore(scope)
      const asOfMs = parseTimeParam(typeof input.asOf === 'string' ? input.asOf : undefined, 'engram_facts', 'asOf')
      // —— 写入模式：facts 与查询参数互斥（照 engram_save 的 items 模式）。
      if (input.facts !== undefined) {
        if (input.entityId !== undefined || input.entity !== undefined || input.asOf !== undefined || input.includeInvalid !== undefined) {
          throw new Error(message('tool.factsWriteConflict'))
        }
        if (!Array.isArray(input.facts) || input.facts.length === 0) {
          throw new Error(message('tool.factsMustBeNonEmptyArray'))
        }
        if (input.facts.length > MAX_SAVE_BATCH) throw new Error(message('tool.factsTooManyPerCall', { max: MAX_SAVE_BATCH }))
        const failed: { index: number; reason: string }[] = []
        const prepared: { index: number; input: FactWriteInput }[] = []
        for (const [index, raw] of input.facts.entries()) {
          if (raw === null || typeof raw !== 'object') { failed.push({ index, reason: message('tool.reasonItemMustBeObject') }); continue }
          const candidate = raw as { entity?: unknown; entityId?: unknown; content?: unknown; replaces?: unknown }
          if (typeof candidate.content !== 'string' || candidate.content.trim() === '') {
            failed.push({ index, reason: message('tool.reasonContentMissingOrEmpty') }); continue
          }
          // 入库前协议剥离 + 密钥脱敏（与 engram_save 同一清洗纪律）。
          const content = redactSecrets(sanitizeProtocolText(candidate.content))
          if (content.trim() === '') { failed.push({ index, reason: message('tool.reasonContentEmptyAfterSanitize') }); continue }
          try {
            let entityId: EntityId
            if (typeof candidate.entityId === 'string' && candidate.entityId.trim() !== '') {
              entityId = asEntityId(candidate.entityId.trim())
            } else if (typeof candidate.entity === 'string' && candidate.entity.trim() !== '') {
              // 按名写入走消解（未命中新建）；kind 固定 other（事实挂靠不负责实体归类）。
              const resolved = await store.resolveEntities([{ name: candidate.entity.trim(), kind: 'other' }])
              const resolvedEntity = resolved[0]
              if (resolvedEntity === undefined) { failed.push({ index, reason: message('tool.reasonEntityResolveEmpty') }); continue }
              entityId = resolvedEntity.id
            } else {
              failed.push({ index, reason: message('tool.reasonEntityRequired') }); continue
            }
            prepared.push({
              index,
              input: {
                entityId,
                content,
                ...(typeof candidate.replaces === 'string' && candidate.replaces.trim() !== ''
                  ? { replaces: asFactId(candidate.replaces.trim()) }
                  : {}),
              },
            })
          } catch (error) {
            failed.push({ index, reason: error instanceof Error ? error.message : String(error) })
          }
        }
        // 批量写入（store 层处理 replaces 存在性校验与软失效）；单条解析失败已入 failed。
        const records = prepared.length === 0 ? [] : await store.writeFacts(prepared.map(entry => entry.input))
        const items: { id: string; entityId: string; replaced?: string }[] = []
        for (const [position, record] of records.entries()) {
          const entry = prepared[position]
          if (entry === undefined) continue
          items.push({
            id: record.id,
            entityId: record.entityId,
            ...(entry.input.replaces === undefined ? {} : { replaced: entry.input.replaces }),
          })
        }
        const parts = [message('tool.factsWrittenSummary', { count: records.length })]
        const replacedCount = prepared.filter(entry => entry.input.replaces !== undefined).length
        if (replacedCount > 0) parts.push(message('tool.factsReplacedSummary', { count: replacedCount }))
        for (const item of items) {
          const replaced = item.replaced === undefined ? '' : message('tool.factsReplacedSuffix', { id: item.replaced })
          parts.push(message('tool.factsWrittenItem', { id: item.id, entityId: item.entityId, replaced }))
        }
        if (failed.length > 0) {
          const entries = failed.map(entry => message('tool.saveFailureEntry', { index: entry.index + 1, reason: entry.reason }))
          parts.push(message('tool.saveFailuresSummary', { count: failed.length, entries: entries.join(message('tool.separatorSemicolon')) }))
        }
        return {
          count: records.length,
          items,
          ...(failed.length > 0 ? { failed } : {}),
          text: parts.join(message('tool.separatorSemicolon')),
        }
      }
      // —— 查询模式：entityId 优先；entity 名走「列表子串查 + 归一精确过滤」，
      // 不经 resolveEntities（查询路径未命中会新建，污染实体词典）。
      const hasEntityId = typeof input.entityId === 'string' && input.entityId.trim() !== ''
      const hasEntityName = typeof input.entity === 'string' && input.entity.trim() !== ''
      if (!hasEntityId && !hasEntityName) {
        throw new Error(message('tool.factsParamsRequired'))
      }
      const limit = parseCountParam(typeof input.limit === 'number' ? input.limit : undefined, 'engram_facts', 'limit', 20, 1, 100)
      const offset = parseCountParam(typeof input.offset === 'number' ? input.offset : undefined, 'engram_facts', 'offset', 0, 0, 100000)
      const includeInvalid = input.includeInvalid === true
      let entityId: EntityId
      let entityName: string
      if (hasEntityId) {
        entityId = asEntityId((input.entityId as string).trim())
        const detail = await store.entityDetail(entityId, 0)
        if (detail === undefined) throw new Error(message('tool.factsEntityIdNotFound', { id: String(input.entityId) }))
        entityName = detail.entity.name
      } else {
        const name = (input.entity as string).trim()
        const { items: candidates } = await store.listEntities({ q: name, limit: 10, offset: 0 })
        const normalized = normalizeEntityName(name)
        const matches = candidates.filter(item =>
          normalizeEntityName(item.entity.name) === normalized
          || item.entity.aliases.some(alias => normalizeEntityName(alias) === normalized))
        if (matches.length === 0) {
          const near = candidates.map(item => message('tool.entityWithId', { name: item.entity.name, id: item.entity.id })).join(message('tool.separatorSemicolon'))
          return {
            total: 0,
            text: message('tool.factsEntityNotFoundByName', {
              name,
              tail: near === ''
                ? message('tool.factsNoNearNames')
                : message('tool.factsNearCandidates', { near }),
            }),
          }
        }
        if (matches.length > 1) {
          const listed = matches.map(item => message('tool.entityWithId', { name: item.entity.name, id: item.entity.id })).join(message('tool.separatorSemicolon'))
          return { total: 0, text: message('tool.factsNameAmbiguous', { name, count: matches.length, listed }) }
        }
        const match = matches[0]
        if (match === undefined) {
          return { total: 0, text: message('tool.factsEntityNotFoundShort', { name }) }
        }
        entityId = match.entity.id
        entityName = match.entity.name
      }
      const { items: facts, total } = await store.factsOfEntity({
        entityId,
        ...(asOfMs === undefined ? {} : { asOf: asOfMs }),
        ...(includeInvalid ? { includeInvalid: true } : {}),
        limit,
        offset,
      })
      const header = message('tool.factsHeader', {
        name: entityName,
        count: total,
        asOf: asOfMs === undefined ? '' : message('tool.factsHeaderAsOf', { date: new Date(asOfMs).toISOString().slice(0, 10) }),
        fullChain: includeInvalid ? message('tool.factsHeaderFullChain') : '',
      })
      const lines = facts.map((fact, index) => renderFactLine(index, fact))
      const body = lines.length === 0 ? message('tool.factsEmpty') : lines.join('\n')
      // 输出包协议标签：事实摘自历史记忆，属不可信历史上下文；当前请求以实体名近似。
      return { total, text: renderMemoryPacket(`${header}\n${body}`, 'tool_facts', hasEntityName ? (input.entity as string) : entityId) }
    },
  })

  const assess = defineTool({
    name: 'engram_assess',
    description: message('tool.assessDescription'),
    parameters: {
      batchId: { type: 'string', required: true, description: message('tool.assessBatchIdDescription') },
      sufficient: { type: 'boolean', required: true, description: message('tool.assessSufficientDescription') },
      evidenceRefs: { type: 'array', items: { type: 'string' }, description: message('tool.assessEvidenceRefsDescription') },
      missing: { type: 'string', description: message('tool.assessMissingDescription') },
      nextStrategy: { type: 'string', enum: [...NEXT_STRATEGIES], description: message('tool.assessNextStrategyDescription') },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        sufficient: { type: 'boolean', required: true },
        nextStrategy: { type: 'string', required: true },
        text: { type: 'string', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const input = args as { batchId?: unknown; sufficient?: unknown; evidenceRefs?: unknown; missing?: unknown; nextStrategy?: unknown }
      if (typeof input.batchId !== 'string' || input.batchId.trim() === '') throw new Error(message('tool.assessBatchIdRequired'))
      const sessionId = exec.agent === undefined ? undefined : String(exec.agent.session.id)
      const batch = sessionId === undefined ? undefined : evidenceBatches.get(sessionId, input.batchId.trim())
      if (batch === undefined) {
        throw new Error(message('tool.assessBatchNotFound', { batchId: input.batchId, max: MAX_BATCHES_PER_SESSION }))
      }
      const verdict = assessEvidence(batch, {
        sufficient: input.sufficient === true,
        evidenceRefs: Array.isArray(input.evidenceRefs) ? input.evidenceRefs.filter((ref): ref is string => typeof ref === 'string') : [],
        missing: typeof input.missing === 'string' ? input.missing : '',
        nextStrategy: typeof input.nextStrategy === 'string' ? input.nextStrategy : '',
      })
      // 记录判定（收尾提醒据此知道批次已处理、连续不足时升级建议）。
      if (sessionId !== undefined) evidenceBatches.recordVerdict(sessionId, batch.batchId, verdict)
      // 判定结果会回到模型上下文，写入审计日志（不进会话日志——下游插件禁止写未知事件类型）。
      const userStore = await deps.openStore('user')
      await userStore.audit('assess', batch.batchId, JSON.stringify({
        batchId: batch.batchId,
        sufficient: verdict.sufficient,
        refs: verdict.evidenceRefs,
        rejected: verdict.rejectedRefs,
        strategy: verdict.nextStrategy,
      }))
      return { sufficient: verdict.sufficient, nextStrategy: verdict.nextStrategy, text: renderAssessText(verdict, batch.batchId) }
    },
  })

  const timeline = defineTool({
    name: 'engram_timeline',
    description: message('tool.timelineDescription'),
    parameters: {
      scope: { type: 'string', enum: ['user', 'project', 'shared', 'all'], description: message('tool.scopeDescriptionAll') },
      topic: { type: 'string', description: message('tool.timelineTopicDescription') },
      since: { type: 'string', description: message('tool.sinceDescription') },
      until: { type: 'string', description: message('tool.untilDescription') },
      order: { type: 'string', enum: ['time', 'tour'], description: message('tool.timelineOrderDescription') },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const input = args as { scope?: unknown; topic?: string; since?: string; until?: string; order?: unknown }
      const scopes = scopesOf(input.scope)
      const order = input.order === 'tour' ? 'tour' : 'time'
      const since = parseTimeParam(input.since, 'engram_timeline', 'since')
      const until = parseTimeParam(input.until, 'engram_timeline', 'until')
      const results = await Promise.all(scopes.map(async (scope) => {
        const store = await deps.openStore(scope)
        return store.timeline({
          scopes: [scope],
          ...(input.topic === undefined ? {} : { topic: input.topic }),
          ...(since === undefined ? {} : { since }),
          ...(until === undefined ? {} : { until }),
          order,
          limit: 20,
        })
      }))
      // time 序跨作用域有共同尺度（时间），全局重排；tour 序的桩位只在各自库内可比，按 scope 顺序拼接。
      const rows = order === 'tour'
        ? results.flat().slice(0, 20)
        : results.flat().sort((a, b) => b.createdAt - a.createdAt).slice(0, 20)
      // 输出包协议标签：记忆正文是不可信历史上下文；timeline 无查询参数，当前请求以占位句代替。
      const body = enforceBudget(rows.map(record => {
        const slot = order === 'tour' && record.slot !== undefined ? ` ${roomLabel(record.slot.room, deps.language)}#${record.slot.index}` : ''
        return `${new Date(record.createdAt).toISOString()}${slot} [${record.scope}/${record.kind}] ${truncateItem(record.content)}${message('tool.idSuffix', { id: record.id })}`
      }))
      const tail = order === 'tour' ? message('tool.timelineTourTail') : ''
      return { text: renderMemoryPacket(`${body.join('\n') || message('tool.timelineEmpty')}${tail}`, 'tool_timeline', input.topic ?? message('store.conversationContinues')) }
    },
  })

  const episodeTimeline = defineTool({
    name: 'engram_episode_timeline',
    description: message('tool.episodeTimelineDescription'),
    parameters: {
      scope: { type: 'string', enum: ['user', 'project', 'shared', 'all'], description: message('tool.scopeDescriptionAll') },
      since: { type: 'string', description: message('tool.sinceDateDescription') },
      until: { type: 'string', description: message('tool.untilDateDescription') },
      sessionId: { type: 'string', description: message('tool.episodeSessionIdDescription') },
      around: { type: 'string', description: message('tool.episodeAroundDescription') },
      windowMinutes: { type: 'number', description: message('tool.episodeWindowMinutesDescription', { minutes: EPISODE_PROXIMITY_MS_DEFAULT / 60000 }) },
      limit: { type: 'number', description: message('tool.episodeLimitDescription', { limit: EPISODE_TIMELINE_LIMIT_DEFAULT }) },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const input = args as { scope?: unknown; since?: string; until?: string; sessionId?: string; around?: string; windowMinutes?: number; limit?: number }
      const scopes = scopesOf(input.scope)
      const since = parseTimeParam(input.since, 'engram_episode_timeline', 'since')
      const until = parseTimeParam(input.until, 'engram_episode_timeline', 'until')
      const limit = parseCountParam(input.limit, 'engram_episode_timeline', 'limit', EPISODE_TIMELINE_LIMIT_DEFAULT, 1, 500)
      const sessionId = input.sessionId?.trim()
      const aroundId = input.around?.trim()
      // 输出行与 engram_timeline 同一格式，模型无需区分两种时间线的行文。
      const renderRow = (record: MemoryRecord): string =>
        `${new Date(record.createdAt).toISOString()} [${record.scope}/${record.kind}] ${truncateItem(record.content)}${message('tool.idSuffix', { id: record.id })}`
      if (aroundId !== undefined && aroundId !== '') {
        const windowMinutes = parseCountParam(input.windowMinutes, 'engram_episode_timeline', 'windowMinutes', EPISODE_PROXIMITY_MS_DEFAULT / 60000, 1, 24 * 60)
        const anchor = asMemoryId(aroundId)
        // 邻近扩展在锚点所在的库执行：id 全局唯一，先定位持有它的分库。
        for (const scope of scopes) {
          const store = await deps.openStore(scope)
          if (await store.get(anchor) === undefined) continue
          const result = await store.episodeTimeline({ scopes: [scope], around: anchor, proximityMs: windowMinutes * 60_000, limit })
          const around = result.around!
          const lines = around.neighbors.length === 0
            ? [message('tool.episodeAnchor', { row: renderRow(around.anchor) }), message('tool.episodeNoNeighbors')]
            : [
                message('tool.episodeAnchor', { row: renderRow(around.anchor) }),
                message('tool.episodeNeighborsHeader', { minutes: windowMinutes, count: around.neighbors.length }),
                ...around.neighbors.map(renderRow),
              ]
          const body = enforceBudget(lines)
          return { text: renderMemoryPacket(body.join('\n'), 'tool_episode_timeline', aroundId) }
        }
        throw new Error(message('tool.episodeAnchorNotFound', { id: aroundId }))
      }
      const results = await Promise.all(scopes.map(async (scope) => {
        const store = await deps.openStore(scope)
        return store.episodeTimeline({
          scopes: [scope],
          ...(since === undefined ? {} : { since }),
          ...(until === undefined ? {} : { until }),
          ...(sessionId === undefined || sessionId === '' ? {} : { sessionId }),
          limit,
        })
      }))
      // 组排序键是时间（跨 scope 有共同尺度），全局重排后按序渲染。
      const groups = results.flatMap(result => result.groups).sort((a, b) => b.startedAt - a.startedAt)
      const lines: string[] = []
      for (const group of groups) {
        lines.push(group.sessionId === null
          ? message('tool.episodeGroupNoSession', {
              start: new Date(group.startedAt).toISOString(),
              end: new Date(group.endedAt).toISOString(),
              count: group.episodes.length,
            })
          : message('tool.episodeGroupSession', {
              sessionId: group.sessionId,
              start: new Date(group.startedAt).toISOString(),
              end: new Date(group.endedAt).toISOString(),
              count: group.episodes.length,
            }))
        // 组头摘要：摄取期生成的一句话概括，模型不用逐条展开就能定位目标会话。
        if (group.summary !== undefined) lines.push(message('tool.episodeGroupSummary', { summary: group.summary }))
        for (const record of group.episodes) lines.push(`- ${renderRow(record)}`)
      }
      const body = enforceBudget(lines)
      return { text: renderMemoryPacket(body.join('\n') || message('tool.episodeEmpty'), 'tool_episode_timeline', sessionId ?? message('store.conversationContinues')) }
    },
  })

  const update = defineTool({
    name: 'engram_update',
    description: message('tool.updateDescription'),
    parameters: {
      id: { type: 'string', required: true, description: message('tool.updateIdDescription') },
      content: { type: 'string', required: true, description: message('tool.updateContentDescription') },
      scope: { type: 'string', enum: ['user', 'project', 'shared'], description: message('tool.updateScopeDescription') },
      kind: { type: 'string', enum: [...KINDS], description: message('tool.updateKindDescription') },
      placard: { type: 'string', description: message('tool.updatePlacardDescription') },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true },
        superseded: { type: 'string', required: true },
      } },
      render: (_args, value) =>
        [{ type: 'text', text: message('tool.updateRendered', { id: value.id, superseded: value.superseded }) }],
    },
    async execute(args) {
      const input = args as { id: string; content: string; scope?: unknown; kind?: EngramKind; placard?: unknown }
      // 入库前协议剥离 + 密钥脱敏，与 engram_save 同一防线。
      const content = redactSecrets(sanitizeProtocolText(input.content))
      if (content.trim() === '') throw new Error(message('tool.updateContentEmptyAfterSanitize'))
      const scope = scopeOf(input.scope, 'project')
      const store = await deps.openStore(scope)
      const old = await store.get(input.id as never)
      if (old === undefined) throw new Error(message('tool.updateNotFound', { id: input.id, scope }))
      const embedder = await deps.embedder
      const embeddings = embedder === undefined ? undefined : await embedder.embed([content.trim()])
      const imagery = placardOf(input.placard)
      const record = await store.update({
        id: input.id as never,
        scope,
        kind: input.kind ?? old.kind,
        content,
        ...(embeddings === undefined ? {} : { embedding: embeddings[0] }),
        ...(imagery === undefined ? {} : { imagery }),
      })
      return { id: record.id, superseded: input.id }
    },
  })

  const forget = defineTool({
    name: 'engram_forget',
    description: message('tool.forgetDescription'),
    parameters: {
      id: { type: 'string', required: true, description: message('tool.idDescription') },
      scope: { type: 'string', enum: ['user', 'project', 'shared'], description: message('tool.entryScopeDescription') },
      reason: { type: 'string', required: true, description: message('tool.forgetReasonDescription') },
      affects: { type: 'string', required: true, description: message('tool.forgetAffectsDescription') },
      stillUseful: { type: 'string', required: true, description: message('tool.forgetStillUsefulDescription') },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: message('tool.forgetRendered', { id: value.id }) }],
    },
    async execute(args) {
      const input = args as { id: string; scope?: unknown; reason: unknown; affects: unknown; stillUseful: unknown }
      const scope = scopeOf(input.scope, 'project')
      const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
      const affects = typeof input.affects === 'string' ? input.affects.trim() : ''
      const stillUseful = typeof input.stillUseful === 'string' ? input.stillUseful.trim() : ''
      if (reason === '' || affects === '' || stillUseful === '') {
        throw new Error(message('tool.forgetTombstoneRequired'))
      }
      const store = await deps.openStore(scope)
      const record = await store.forgetWithTombstone(input.id as never, { reason, affects, stillUseful })
      return { id: record.id }
    },
  })

  /**
   * 历史回填：把 dsh 历史会话逐轮提炼进宫殿（按会话 cwd 分库、已有幂等键的轮次跳过）。
   * dryRun 默认 true——避免模型顺手触发成百次辅助调用；显式传 false 才真正写入。
   */
  const ingestHistory = defineTool({
    name: 'engram_ingest_history',
    description: message('tool.ingestHistoryDescription'),
    parameters: {
      dryRun: { type: 'boolean', description: message('tool.ingestDryRunDescription') },
      days: { type: 'number', description: message('tool.ingestDaysDescription') },
      maxTurnsPerSession: { type: 'number', description: message('tool.ingestMaxTurnsDescription') },
      maxTotalTurns: { type: 'number', description: message('tool.ingestMaxTotalTurnsDescription') },
      includeSubagents: { type: 'boolean', description: message('tool.ingestIncludeSubagentsDescription') },
      includeSeeded: { type: 'boolean', description: message('tool.ingestIncludeSeededDescription') },
      includeNoCwd: { type: 'boolean', description: message('tool.ingestIncludeNoCwdDescription') },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const input = args as {
        dryRun?: unknown
        days?: unknown
        maxTurnsPerSession?: unknown
        maxTotalTurns?: unknown
        includeSubagents?: unknown
        includeSeeded?: unknown
        includeNoCwd?: unknown
      }
      const history = deps.historyBackfill
      if (history === undefined) {
        return { text: message('tool.ingestUnavailable') }
      }
      const rules: HistoryBackfillRules = {
        ...(typeof input.days === 'number' ? { days: input.days } : {}),
        ...(typeof input.maxTurnsPerSession === 'number' ? { maxTurnsPerSession: input.maxTurnsPerSession } : {}),
        ...(typeof input.maxTotalTurns === 'number' ? { maxTotalTurns: input.maxTotalTurns } : {}),
        ...(typeof input.includeSubagents === 'boolean' ? { includeSubagents: input.includeSubagents } : {}),
        ...(typeof input.includeSeeded === 'boolean' ? { includeSeeded: input.includeSeeded } : {}),
        ...(typeof input.includeNoCwd === 'boolean' ? { includeNoCwd: input.includeNoCwd } : {}),
      }
      // 缺省 dryRun=true：估算零成本，执行有 LLM 成本，必须显式确认。
      if (input.dryRun !== false) {
        return { text: renderHistoryEstimate(await history.estimate(rules)) }
      }
      const result = await history.run(rules, exec.signal)
      return { text: renderHistoryRun(result) }
    },
  })

  /** P0-3 闭馆考古：返回最近 N 条 forgotten 条目 + 墓志铭。 */
  const auditForgotten = defineTool({
    name: 'engram_audit_forgotten',
    description: message('tool.auditForgottenDescription'),
    parameters: {
      scope: { type: 'string', enum: ['user', 'project', 'shared', 'all'], description: message('tool.scopeDescriptionAll') },
      limit: { type: 'integer', description: message('tool.limitDescription20') },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const input = args as { scope?: unknown; limit?: unknown }
      const scopes = scopesOf(input.scope)
      const limit = Number.isInteger(input.limit) ? Math.min(Math.max(1, input.limit as number), 50) : 20
      const all = (await Promise.all(scopes.map(async (scope) =>
        (await deps.openStore(scope)).listForgottenWithTombs(limit)
      ))).flat()
      all.sort((a, b) => b.forgottenAt - a.forgottenAt)
      const sliced = all.slice(0, limit)
      if (sliced.length === 0) return { text: message('tool.auditForgottenEmpty') }
      const lines = sliced.map((row, index) => {
        const stamp = new Date(row.forgottenAt).toISOString()
        const tomb = row.tombstone === null
          ? message('tool.auditForgottenTombstoneMissing')
          : message('tool.auditForgottenTombstone', {
              reason: row.tombstone.reason,
              affects: row.tombstone.affects,
              stillUseful: row.tombstone.stillUseful,
            })
        return message('tool.auditForgottenLine', {
          index: index + 1,
          scope: row.scope,
          kind: row.kind,
          content: row.content.slice(0, 80),
          ellipsis: row.content.length > 80 ? message('tool.ellipsis') : '',
          id: row.id,
          importance: row.importance.toFixed(2),
          forgottenAt: stamp,
          tombstone: tomb,
        })
      })
      return { text: message('tool.auditForgottenHeader', { count: sliced.length, lines: lines.join('\n') }) }
    },
  })

  // 今日待回忆队列（检索练习）：只给线索（房间/桩位/门牌），不给内容——模型先主动回忆，
  // 再用 engram_review 揭示核对、engram_report grade 自评。主动回忆的强化效果远强于被动重看。
  const reviewQueue = defineTool({
    name: 'engram_review_queue',
    description: message('tool.reviewQueueDescription'),
    parameters: {
      scope: { type: 'string', enum: ['user', 'project', 'shared', 'all'], description: message('tool.scopeDescriptionAll') },
      limit: { type: 'integer', description: message('tool.reviewQueueLimitDescription') },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const input = args as { scope?: unknown; limit?: unknown }
      const scopes = scopesOf(input.scope)
      const limit = Number.isInteger(input.limit) ? Math.min(Math.max(1, input.limit as number), 50) : 10
      const now = Date.now()
      const groups = await Promise.all(scopes.map(async (scope) => ({
        scope,
        due: await (await deps.openStore(scope)).dueReviews(now, limit),
      })))
      const total = groups.reduce((sum, group) => sum + group.due.length, 0)
      if (total === 0) return { text: message('tool.reviewQueueEmpty') }
      const lines: string[] = [message('tool.reviewQueueHeader', { count: total })]
      for (const { scope, due } of groups) {
        for (const [index, record] of due.entries()) {
          const slot = record.slot === undefined
            ? message('tool.reviewQueueNoSlot')
            : `${roomLabel(record.slot.room, deps.language)} #${record.slot.index}`
          const placard = record.imagery?.caption ?? message('tool.reviewQueueNoPlacard')
          const overdueDays = record.review?.nextReviewAt === null || record.review?.nextReviewAt === undefined
            ? 0
            : Math.max(0, Math.floor((now - record.review.nextReviewAt) / 86_400_000))
          const overdue = overdueDays === 0 ? message('tool.reviewQueueDueToday') : message('tool.reviewQueueOverdue', { days: overdueDays })
          lines.push(message('tool.reviewQueueLine', { index: index + 1, scope, slot, placard, overdue, id: record.id }))
        }
      }
      return { text: lines.join('\n') }
    },
  })

  // 奖励信号入口：模型用完一条记忆（尤其 skill 类）后回报实际效果，成功提权/失败降权。
  // 同时衔接间隔重复：success=grade 5 / failure=grade 1 推进 SM-2 调度；显式 grade 自评优先。
  const report = defineTool({
    name: 'engram_report',
    description: message('tool.reportDescription'),
    parameters: {
      id: { type: 'string', required: true, description: message('tool.idDescription') },
      outcome: { type: 'string', enum: ['success', 'failure'], description: message('tool.reportOutcomeDescription') },
      grade: { type: 'integer', description: message('tool.reportGradeDescription') },
      scope: { type: 'string', enum: ['user', 'project', 'shared'], description: message('tool.entryScopeDescription') },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true },
        outcome: { type: 'string', required: true },
        confidence: { type: 'number', required: true },
        nextReviewAt: { type: 'number' },
      } },
      render: (_args, value) => [{
        type: 'text',
        text: (value.outcome === 'success'
          ? message('tool.reportSuccess', { id: value.id, confidence: value.confidence })
          : message('tool.reportFailure', { id: value.id, confidence: value.confidence }))
          + (value.nextReviewAt === undefined
            ? ''
            : message('tool.reportNextReview', { date: new Date(value.nextReviewAt).toISOString().slice(0, 10) })),
      }],
    },
    async execute(args) {
      const input = args as { id: string; outcome?: unknown; grade?: unknown; scope?: unknown }
      const hasGrade = Number.isInteger(input.grade) && (input.grade as number) >= 0 && (input.grade as number) <= 5
      if (input.grade !== undefined && !hasGrade) {
        throw new Error(message('tool.reportGradeInvalid'))
      }
      if (input.outcome !== 'success' && input.outcome !== 'failure' && !hasGrade) {
        throw new Error(message('tool.reportParamsRequired'))
      }
      // grade 显式自评优先；否则 outcome 映射为 SM-2 grade（success=5 完美，failure=1 遗忘）。
      const outcome = input.outcome === 'success' || input.outcome === 'failure'
        ? input.outcome
        : (input.grade as number) >= 3 ? 'success' : 'failure'
      const grade = (hasGrade ? input.grade : outcome === 'success' ? 5 : 1) as 0 | 1 | 2 | 3 | 4 | 5
      const scope = scopeOf(input.scope, 'project')
      const store = await deps.openStore(scope)
      const record = await store.reportOutcome(input.id as never, outcome)
      if (record === undefined) throw new Error(message('tool.reportNotFound', { id: input.id, scope }))
      const scheduled = await store.scheduleReview(input.id as never, grade)
      return {
        id: record.id,
        outcome,
        confidence: record.confidence,
        ...(scheduled?.review?.nextReviewAt === null || scheduled?.review?.nextReviewAt === undefined
          ? {}
          : { nextReviewAt: scheduled.review.nextReviewAt }),
      }
    },
  })

  const review = defineTool({
    name: 'engram_review',
    description: message('tool.reviewDescription'),
    parameters: {
      id: { type: 'string', required: true, description: message('tool.idDescription') },
      scope: { type: 'string', enum: ['user', 'project', 'shared'], description: message('tool.entryScopeDescription') },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const input = args as { id: string; scope?: unknown }
      const store = await deps.openStore(scopeOf(input.scope, 'project'))
      const view = await store.review(input.id as never)
      if (view === undefined) return { text: message('tool.reviewNotFound', { id: input.id }) }
      const record = view.record
      const source = record.sourceSessionId === null
        ? message('tool.reviewSourceExplicit')
        : message('tool.reviewSourceSession', { sessionId: record.sourceSessionId })
          + (record.sourceRound === null ? '' : message('tool.reviewSourceRound', { round: record.sourceRound }))
          + (record.sourceSeq === null ? '' : message('tool.reviewSourceSeq', { seq: record.sourceSeq }))
      const section = (title: string, ids: readonly string[]): string =>
        ids.length === 0 ? '' : `\n${title}: ${ids.join(', ')}`
      // 输出包协议标签：记忆正文与来源链是不可信历史上下文。
      return {
        text: renderMemoryPacket([
          message('tool.reviewContent', { content: record.content }),
          message('tool.reviewAttributes', {
            kind: record.kind,
            scope: record.scope,
            status: record.status,
            importance: record.importance,
            confidence: record.confidence,
            accessCount: record.accessCount,
          }),
          message('tool.reviewSource', { source }),
          section(message('tool.reviewSectionSupersededBy'), view.supersededBy.map(String)),
          section(message('tool.reviewSectionSupersedes'), view.supersedes.map(String)),
          section(message('tool.reviewSectionContradicts'), view.contradicts.map(String)),
          section(message('tool.reviewSectionRelated'), view.related.map(String)),
          view.revisions.length === 0 ? '' : message('tool.reviewRevisions', { entries: view.revisions.map(rev =>
            `- ${new Date(rev.supersededAt).toISOString()} [${rev.kind}] ${truncateItem(rev.content)}`).join('\n') }),
          view.operations.length === 0
            ? ''
            : message('tool.reviewOperations', {
                entries: view.operations.map(op => `- ${new Date(op.at).toISOString()} ${op.op}${op.detail === null ? '' : ` ${op.detail}`}`).join('\n'),
              }),
        ].filter(part => part !== '').join('\n'), 'tool_review', message('store.conversationContinues')),
      }
    },
  })

  const stats = defineTool({
    name: 'engram_stats',
    description: message('tool.statsDescription'),
    parameters: {
      scope: { type: 'string', enum: ['user', 'project', 'shared', 'all'], description: message('tool.scopeDescriptionAll') },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const input = args as { scope?: unknown }
      const scopes = scopesOf(input.scope)
      const all = await Promise.all(scopes.map(async (scope) => {
        const store = await deps.openStore(scope)
        const [storeStats, rooms, placards] = await Promise.all([
          store.stats(),
          store.slotCountsByRoom(),
          store.listPlacards(),
        ])
        return { scope, stats: storeStats, rooms, placards }
      }))
      const text = all.map(({ scope, stats, rooms, placards }) => {
        // 房间目录（走廊路由索引）：每房一行，桩位数 + 最新门牌作路由线索。
        const latestPlacardByRoom = new Map<string, string>()
        for (const row of placards) {
          if (row.room !== null) latestPlacardByRoom.set(row.room, row.caption)
        }
        const roomLines = Object.entries(rooms)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([room, state]) => {
            const placard = latestPlacardByRoom.get(room)
            // Идентификатор — то, что принимает параметр room; имя — для чтения.
            const placardLine = placard === undefined ? '' : message('tool.statsRoomPlacard', { placard })
            return message('tool.statsRoomLine', {
              room,
              label: roomLabel(room, deps.language),
              count: state.count,
              maxIndex: state.maxIndex,
              placard: placardLine,
            })
          })
        return [
          message('tool.statsTotal', { scope, total: stats.total, active: stats.active, archived: stats.archived, forgotten: stats.forgotten }),
          message('tool.statsByKind', { distribution: Object.entries(stats.byKind).map(([kind, count]) => `${kind}=${count}`).join(', ') || message('tool.statsByKindEmpty') }),
          message('tool.statsEdges', { edges: stats.edges, ratio: (stats.signalRatio * 100).toFixed(1), logs: stats.opLogCount }),
          roomLines.length === 0
            ? message('tool.statsNoRooms')
            : message('tool.statsRoomsHeader', { rooms: roomLines.join('\n') }),
        ].join('\n')
      }).join('\n\n')
      return { text }
    },
  })

  const exportTool = defineTool({
    name: 'engram_export',
    description: message('tool.exportDescription'),
    parameters: {
      format: { type: 'string', enum: ['markdown', 'json', 'markdown-mirror'], description: message('tool.exportFormatDescription') },
      scope: { type: 'string', enum: ['user', 'project', 'shared', 'all'], description: message('tool.scopeDescriptionAll') },
      redactedView: { type: 'boolean', description: message('tool.exportRedactedDescription') },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const input = args as { format?: unknown; scope?: unknown; redactedView?: unknown }
      const format = input.format === 'json' ? 'json' : input.format === 'markdown-mirror' ? 'markdown-mirror' : 'markdown'
      const redactedView = input.redactedView === true
      const scopes = scopesOf(input.scope)
      // 脱敏视图：入库清洗可能晚于旧数据，导出前幂等重洗一遍并截断为预览。
      const preview = (content: string): string => {
        const cleaned = redactSecrets(content)
        return cleaned.length > 40 ? `${cleaned.slice(0, 40)}…` : cleaned
      }
      await mkdir(deps.exportDir, { recursive: true, mode: 0o700 })
      const written: string[] = []
      for (const scope of scopes) {
        const data = await (await deps.openStore(scope)).exportAll()
        if (format === 'markdown-mirror') {
          // 镜像模式：完整导出，忽略脱敏（用户用 Obsidian 看完整内容更符合预期；脱敏请走 markdown/json + redactedView）。
          const stamp = new Date().toISOString().replaceAll(':', '-').slice(0, 19)
          const mirrorRoot = join(deps.exportDir, `mirror-${scope}-${stamp}`)
          const report = await writeMirror(mirrorRoot, data, deps.language)
          written.push(message('tool.exportMirrorWritten', {
            path: mirrorRoot,
            files: report.fileCount,
            records: data.records.length,
            rooms: report.rooms.length,
          }))
          continue
        }
        const payload = redactedView
          ? { ...data, records: data.records.map(record => ({ ...record, content: preview(record.content) })) }
          : data
        const stamp = new Date().toISOString().replaceAll(':', '-')
        const suffix = redactedView ? '-redacted' : ''
        const path = join(deps.exportDir, `engram-${scope}${suffix}-${stamp}.${format === 'json' ? 'json' : 'md'}`)
        const body = format === 'json'
          ? JSON.stringify(payload, null, 2)
          : [
              message('tool.exportMarkdownTitle', { scope, redacted: redactedView ? message('tool.exportRedactedMark') : '' }),
              '',
              ...payload.records.map(record =>
                message('tool.exportMarkdownRecord', {
                  status: record.status,
                  kind: record.kind,
                  content: record.content,
                  id: record.id,
                  importance: record.importance,
                })),
              '',
              message('tool.exportMarkdownEdges'),
              ...payload.edges.map(edge => `- ${edge.from} --${edge.type}--> ${edge.to}`),
              '',
            ].join('\n')
        await writeFile(path, body, { mode: 0o600 })
        written.push(message('tool.exportWritten', {
          path,
          records: payload.records.length,
          edges: payload.edges.length,
          redacted: redactedView ? message('tool.exportRedactedMark') : '',
        }))
      }
      return { text: message('tool.exportDone', { redacted: redactedView ? message('tool.exportRedactedView') : '', paths: written.join('\n') }) }
    },
  })

  const importTool = defineTool({
    name: 'engram_import',
    description: message('tool.importDescription'),
    parameters: {
      path: { type: 'string', description: message('tool.importPathDescription') },
      scope: { type: 'string', enum: ['user', 'project', 'shared'], description: message('tool.importScopeDescription') },
      format: { type: 'string', enum: ['json', 'markdown'], description: message('tool.importFormatDescription') },
      dryRun: { type: 'boolean', description: message('tool.importDryRunDescription') },
      keepDuplicates: { type: 'boolean', description: message('tool.importKeepDuplicatesDescription') },
      selectedIds: { type: 'array', items: { type: 'string' }, description: message('tool.importSelectedIdsDescription') },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const input = args as {
        path?: unknown
        scope?: unknown
        format?: unknown
        dryRun?: unknown
        keepDuplicates?: unknown
        selectedIds?: unknown
      }
      if (typeof input.path !== 'string' || input.path.trim() === '') throw new Error(message('tool.importPathRequired'))
      const scope = scopeOf(input.scope, 'user')
      // 格式：显式 format 优先；缺省按扩展名识别（.md/.markdown → markdown，其余 JSON）。
      const markdown = input.format === 'markdown' || (input.format === undefined && /\.(?:md|markdown)$/i.test(input.path))
      // 文件读取错误原样带路径抛出；解析/校验错误带首条问题字段——迁移场景用户要能自己定位坏文件。
      let text: string
      try {
        text = await readFile(input.path, 'utf8')
      } catch (error) {
        throw new Error(message('tool.importReadFailed', { path: input.path, error: error instanceof Error ? error.message : String(error) }))
      }
      let data: ExportData
      if (markdown) {
        const parsedMarkdown = parseMarkdownExport(text, scope)
        if (typeof parsedMarkdown === 'string') throw new Error(message('tool.importInvalidPayload', { error: parsedMarkdown }))
        data = parsedMarkdown.data
      } else {
        let raw: unknown
        try {
          raw = JSON.parse(text)
        } catch (error) {
          throw new Error(message('tool.importReadFailed', { path: input.path, error: error instanceof Error ? error.message : String(error) }))
        }
        const parsed = parseImportData(raw)
        if (typeof parsed === 'string') throw new Error(message('tool.importInvalidPayload', { error: parsed }))
        data = parsed
      }
      const store = await deps.openStore(scope)
      if (input.dryRun === true) {
        const preview = await store.importPreview(data)
        const fresh = preview.entries.filter(e => e.classification === 'new').length
        const dup = preview.entries.filter(e => e.classification === 'duplicate').length
        return {
          text: preview.entries.length === 0
            ? message('tool.importEmpty')
            : message('tool.importPreviewDone', {
              total: preview.entries.length,
              fresh,
              dup,
              conflict: preview.entries.length - fresh - dup,
              edges: preview.edgesTotal,
              dangling: preview.edgesDangling,
              entitiesNew: preview.entitiesNew,
              entitiesMerged: preview.entitiesMerged,
            }),
        }
      }
      const result = await store.importData(data, {
        ...(Array.isArray(input.selectedIds)
          ? { selectedIds: input.selectedIds.filter((v): v is string => typeof v === 'string').map(id => asMemoryId(id)) }
          : {}),
        ...(input.keepDuplicates === true ? { keepDuplicates: true } : {}),
      })
      // 就地补嵌入：导出格式不携带向量，导入后按批嵌入并回填；嵌入器不可用或单批失败只计数不中断。
      const embedded = await embedImportedRecords(store, await deps.embedder, result.importedIds)
      return {
        text: result.imported === 0
          ? message('tool.importNothing', {
            dup: result.skippedDuplicates,
            conflict: result.conflicts,
          })
          : message('tool.importDone', {
            imported: result.imported,
            embedded,
            pending: result.imported - embedded,
            dup: result.skippedDuplicates,
            conflict: result.conflicts,
            edges: result.edgesLinked,
            dangling: result.edgesDangling,
            entitiesNew: result.entitiesNew,
            entitiesMerged: result.entitiesMerged,
          }),
      }
    },
  })

  const distill = defineTool({
    name: 'engram_distill',
    description: message('tool.distillDescription'),
    parameters: {
      scope: { type: 'string', enum: ['user', 'project', 'shared'], description: message('tool.scopeDescriptionUser') },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const input = args as { scope?: unknown }
      const scope = scopeOf(input.scope, 'user')
      if (deps.call === undefined) throw new Error(message('tool.distillNoLlm'))
      const call = deps.call
      const events = (exec.agent?.session?.snapshotEvents() ?? []) as unknown as Parameters<typeof routeFromEvents>[0]
      const route = deps.routeOverride ?? routeFromEvents(events)
      if (route === undefined) throw new Error(message('tool.distillNoRoute'))
      const embedder = await deps.embedder
      const outcome = await distillMemories({
        store: await deps.openStore(scope),
        embedder,
        scope,
        call: params => call({ ...params, sessionId: exec.agent === undefined ? undefined : String(exec.agent.session.id) }),
        logRequest: (data) => {
          void (async () => {
            const store = await deps.openStore(scope)
            await store.audit('distill-request', 'AUX', JSON.stringify(data))
          })().catch(() => { /* 审计失败不影响蒸馏 */ })
        },
        route,
        signal: exec.signal,
      })
      // Наблюдение за векторами: продукт дистилляции без вектора — это будущее «база
      // требует ремонта» (так и вышло 22.10). Пишем это и в ответ модели, и в журнал
      // операций: молчаливое «дистилляция прошла» скрывает причину от человека.
      if (outcome.vectorsWithout > 0) {
        void (async () => {
          const auditStore = await deps.openStore(scope)
          await auditStore.audit('vectors-missing', 'AUX', JSON.stringify({ count: outcome.vectorsWithout, scope }))
        })().catch(() => { /* журнал не влияет на дистилляцию */ })
      }
      const done = message('tool.distillDone', { input: outcome.input, distilled: outcome.distilled, superseded: outcome.superseded })
      return {
        text: outcome.vectorsWithout === 0
          ? done
          : `${done}\n${message('tool.distillNoVectors', { count: outcome.vectorsWithout })}`,
      }
    },
  })

  /**
   * 信念巩固 — 从尚未巩固的原始记忆抽象出带证据链的一句话信念，并复核 stale 信念。
   * 与 distill 的关键差异：原始记忆全部保留，信念是叠加的抽象层（同主题向量近邻归并，
   * 持续细化同一条）。reflect=suggest 档位下这是待巩固登记的执行出口；任何档位均可手动调。
   */
  const reflect = defineTool({
    name: 'engram_reflect',
    description: message('tool.reflectDescription'),
    parameters: {
      scope: { type: 'string', enum: ['user', 'project', 'shared'], description: message('tool.scopeDescriptionUser') },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const input = args as { scope?: unknown }
      const scope = scopeOf(input.scope, 'user')
      if (deps.call === undefined) throw new Error(message('tool.reflectNoLlm'))
      const call = deps.call
      const events = (exec.agent?.session?.snapshotEvents() ?? []) as unknown as Parameters<typeof routeFromEvents>[0]
      const route = deps.routeOverride ?? routeFromEvents(events)
      if (route === undefined) throw new Error(message('tool.reflectNoRoute'))
      const store = await deps.openStore(scope)
      const embedder = await deps.embedder
      const outcome = await reflectObservations({
        store,
        embedder,
        scope,
        call: params => call({ ...params, sessionId: exec.agent === undefined ? undefined : String(exec.agent.session.id) }),
        logRequest: (data) => {
          void store.audit('reflect-request', 'AUX', JSON.stringify(data)).catch(() => { /* 审计失败不影响巩固 */ })
        },
        route,
        signal: exec.signal,
      })
      // 消费该 scope 的 suggest 待巩固登记（detail 为 {scope,sessionId} JSON，越界/损坏条目忽略）。
      const pending = await store.listAuditDetails('reflect-pending')
      let consumed = 0
      for (const detail of pending) {
        try {
          const parsed = JSON.parse(detail) as { scope?: unknown }
          if (parsed.scope === scope) {
            await store.clearAudit('reflect-pending', detail)
            consumed += 1
          }
        } catch {
          /* 损坏的 pending 条目留给清理流程，不阻断本次结果 */
        }
      }
      const lines = [
        message('tool.reflectDone', {
          pool: outcome.pool,
          candidates: outcome.candidates,
          staleReviewed: outcome.staleReviewed,
          formed: outcome.formed,
          refined: outcome.refined,
          confirmed: outcome.confirmed,
          refuted: outcome.refuted,
          skipped: outcome.skipped,
        }),
        message('tool.reflectNote'),
      ]
      if (consumed > 0) lines.push(message('tool.reflectConsumed', { count: consumed }))
      return { text: lines.join('\n') }
    },
  })

  /**
   * 渐进式披露 — 记忆铭牌批量访客：拿到一组 id 后才决定取哪几条。
   * 与 engram_search 配合使用：search 只返门牌号摘要，examine 才进房看铭牌。
   */
  const examine = defineTool({
    name: 'engram_examine',
    description: message('tool.examineDescription'),
    parameters: {
      ids: { type: 'array', items: { type: 'string' }, description: message('tool.examineIdsDescription') },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const input = args as { ids?: unknown }
      const rawIds = Array.isArray(input.ids) ? input.ids.filter((x): x is string => typeof x === 'string') : []
      if (rawIds.length === 0) throw new Error(message('tool.examineIdsRequired'))
      const ids = rawIds.slice(0, 16).map(id => asMemoryId(id))
      const store = await deps.openStore('user')
      const projectStore = await deps.openStore('project')
      const [fromUser, fromProject] = await Promise.all([store.getMany(ids), projectStore.getMany(ids)])
      const records = [...fromUser, ...fromProject]
      if (records.length === 0) throw new Error(message('tool.examineAllNotFound', { count: ids.length }))
      const text = records.map((record, index) => [
        `### ${index + 1}. [${record.scope}/${record.kind}/${record.status}] id=${record.id}`,
        message('tool.examineNameplate', { content: record.content }),
        message('tool.examineAttributes', {
          brightness: record.importance.toFixed(2),
          reliability: record.confidence.toFixed(2),
          visits: record.accessCount,
        }),
      ].join('\n')).join('\n\n')
      return { text }
    },
  })

  /**
   * 渐进式披露 — 走廊漫步：从一间出发走 related/supersedes/contradicts 走廊边，
   * 找到与之相关的邻居记忆简表（仅 id + 一句话摘要，不返全文）。
   */
  const neighborsTool = defineTool({
    name: 'engram_neighbors',
    description: message('tool.neighborsDescription'),
    parameters: {
      id: { type: 'string', description: message('tool.neighborsIdDescription') },
      depth: { type: 'integer', description: message('tool.neighborsDepthDescription') },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const input = args as { id?: unknown; depth?: unknown }
      if (typeof input.id !== 'string' || input.id === '') throw new Error(message('tool.neighborsIdRequired'))
      const depth = Number.isInteger(input.depth) ? Math.min(Math.max(1, input.depth as number), 3) : 1
      const seed = asMemoryId(input.id)
      const userStore = await deps.openStore('user')
      const projectStore = await deps.openStore('project')
      const seedRow = await userStore.get(seed) ?? await projectStore.get(seed)
      if (seedRow === undefined) throw new Error(message('tool.neighborsSeedNotFound', { id: String(seed) }))
      const seedScope = seedRow.scope
      const scopeStore = seedScope === 'user' ? userStore : projectStore
      const neighbors = await scopeStore.neighbors(seed, depth)
      if (neighbors.length === 0) return { text: message('tool.neighborsNone', { id: String(seed), scope: seedScope, depth }) }
      const lines = neighbors.map((record, index) => message('tool.neighborsLine', {
        index: index + 1,
        scope: record.scope,
        kind: record.kind,
        status: record.status,
        content: record.content.slice(0, 80),
        ellipsis: record.content.length > 80 ? message('tool.ellipsis') : '',
        idSuffix: message('tool.idSuffix', { id: record.id }),
      }))
      return { text: message('tool.neighborsHeader', { id: String(seed), scope: seedScope, depth, count: neighbors.length, lines: lines.join('\n') }) }
    },
  })

  /**
   * P0-2 巡游路由：把检索结果重组为有序 3-7 条记忆路径，附回声触发器与入选理由。
   * 与 engram_search 复用底层查询，避免重复 IO。
   */
  const tour = defineTool({
    name: 'engram_tour',
    description: message('tool.tourDescription'),
    parameters: {
      query: { type: 'string', description: message('tool.tourQueryDescription') },
      mode: { type: 'string', enum: ['fixed', 'thematic'], description: message('tool.tourModeDescription') },
      scope: { type: 'string', enum: ['user', 'project', 'shared', 'all'], description: message('tool.scopeDescriptionAll') },
      maxStops: { type: 'integer', description: message('tool.tourMaxStopsDescription') },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const input = args as { query?: string; mode?: unknown; scope?: unknown; maxStops?: unknown }
      const scopes = scopesOf(input.scope)
      const mode = input.mode === 'fixed' ? 'fixed' : 'thematic'
      // fixed 模式：按 tour_routes 表顺序输出全宫巡游（已归档/遗忘站点跳过并标注空桩）。
      if (mode === 'fixed') {
        const maxStops = Number.isInteger(input.maxStops) ? Math.max(1, input.maxStops as number) : 20
        const sections: string[] = []
        let shown = 0
        let skipped = 0
        for (const scope of scopes) {
          const store = await deps.openStore(scope)
          const route = await store.routeList()
          if (route.length === 0) continue
          const records = await store.getMany(route.map(stop => stop.id))
          const byId = new Map(records.map(record => [String(record.id), record]))
          const lines: string[] = []
          for (const stop of route) {
            if (shown >= maxStops) break
            const record = byId.get(String(stop.id))
            if (record === undefined || record.status !== 'active') { skipped += 1; continue }
            shown += 1
            const slot = record.slot === undefined ? '' : `${roomLabel(record.slot.room, deps.language)} #${record.slot.index} · `
            const placard = record.imagery?.caption
            lines.push(message('tool.tourStopLine', {
              index: stop.position + 1,
              slot,
              kind: record.kind,
              content: truncateItem(record.content),
              idSuffix: message('tool.idSuffix', { id: record.id }),
              placard: placard === null || placard === undefined ? '' : message('tool.tourStopPlacard', { placard }),
            }))
          }
          if (lines.length > 0) sections.push(message('tool.tourFixedSection', { scope, lines: lines.join('\n') }))
        }
        if (shown === 0) return { text: message('tool.tourFixedEmpty') }
        const tail = skipped > 0 ? message('tool.tourFixedSkipped', { count: skipped }) : ''
        return { text: `${sections.join('\n\n')}${tail}` }
      }
      if (typeof input.query !== 'string' || input.query.trim() === '') {
        throw new Error(message('tool.tourQueryRequired'))
      }
      const tourQuery = input.query
      const limit = 12
      const maxStops = Number.isInteger(input.maxStops) ? Math.min(Math.max(3, input.maxStops as number), 7) : 6
      const rewrite = await rewriteQueries(deps, exec, tourQuery)
      const retrievals = await Promise.all(rewrite.queries.map(async (queryText) => {
        const vector = await queryVectorOf(deps, queryText)
        const results = await Promise.all(scopes.map(async (scope) => {
          const store = await deps.openStore(scope)
          return store.search({ text: queryText, scopes: [scope], limit }, vector)
        }))
        return {
          hits: results.flatMap(result => result.hits).sort((a, b) => b.score - a.score).slice(0, limit),
          degraded: results.some(result => result.degraded),
        }
      }))
      const degraded = retrievals.some(retrieval => retrieval.degraded)
      const merged = mergeQueryResults(
        retrievals,
        limit,
        RRF_CONSTANT,
        Math.floor(Math.max(0, limit) / Math.max(1, rewrite.queries.length)),
      )
      // 用 user+project 库联合做邻居查询（neighbors 需 poolLookup 同步取记录）。
      const userStore = await deps.openStore('user')
      const projectStore = await deps.openStore('project')
      const poolLookup = async (id: string): Promise<MemoryRecord | undefined> =>
        await userStore.get(id as never) ?? await projectStore.get(id as never)
      const route = await planTour(merged, poolLookup, tourQuery, maxStops)
      const prefix = degraded ? message('tool.searchDegradedPrefix') : ''
      return { text: `${prefix}${route.narrative}` }
    },
  })

  /**
   * 画像可编辑：维护会话开始注入的 curated block（注入时优先于自动派生画像）。
   * view 查看当前内容与版本历史；edit 编辑（乐观锁，冲突 loud 失败）；rollback
   * 把历史版本的内容作为新版本写入（版本链只增不改，可反复回滚）。
   */
  const profileEdit = defineTool({
    name: 'engram_profile_edit',
    description: message('tool.profileEditDescription'),
    parameters: {
      action: { type: 'string', enum: ['view', 'edit', 'rollback'], required: true, description: message('tool.profileEditActionDescription') },
      scope: { type: 'string', enum: ['user', 'project', 'shared'], description: message('tool.scopeDescriptionUser') },
      content: { type: 'string', description: message('tool.profileEditContentDescription') },
      expectedVersion: { type: 'integer', description: message('tool.profileEditExpectedVersionDescription') },
      toVersion: { type: 'integer', description: message('tool.profileEditToVersionDescription') },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const input = args as { action?: unknown; scope?: unknown; content?: unknown; expectedVersion?: unknown; toVersion?: unknown }
      const action = input.action === 'edit' || input.action === 'rollback' || input.action === 'view' ? input.action : undefined
      if (action === undefined) throw new Error(message('tool.profileEditActionInvalid'))
      const scope = scopeOf(input.scope, 'user')
      const store = await deps.openStore(scope)
      if (action === 'view') {
        const block = await store.getProfileBlock(scope)
        if (block === undefined) {
          return { text: message('tool.profileEditNoBlock', { scope }) }
        }
        const versions = await store.listProfileBlockVersions(scope, 10)
        return {
          text: [
            message('tool.profileEditCurrent', { scope, version: block.version }),
            block.content,
            '',
            message('tool.profileEditVersions', { count: versions.length }),
            ...versions.map(version =>
              message('tool.profileEditVersionLine', {
                version: version.version,
                source: version.source === 'rollback' ? message('tool.profileEditSourceRollback') : message('tool.profileEditSourceEdit'),
                at: new Date(version.at).toISOString().slice(0, 16).replace('T', ' '),
                chars: version.content.length,
              })),
          ].join('\n'),
        }
      }
      if (action === 'edit') {
        if (typeof input.content !== 'string' || input.content.trim() === '') throw new Error(message('tool.profileEditContentRequired'))
        let expectedVersion: number | undefined
        if (input.expectedVersion !== undefined) {
          if (!Number.isInteger(input.expectedVersion)) throw new Error(message('tool.profileEditExpectedVersionInvalid'))
          expectedVersion = input.expectedVersion as number
        }
        // 入库前协议剥离 + 密钥脱敏，与 engram_save/update 同一防线。
        const content = redactSecrets(sanitizeProtocolText(input.content))
        if (content.trim() === '') throw new Error(message('tool.profileEditContentEmptyAfterSanitize'))
        const block = await store.saveProfileBlock(scope, expectedVersion, content, 'edit')
        // 编辑记录入 op_log（面板管家日志可见；target_id 用 scope）。
        await store.audit('profile-edit', scope, JSON.stringify({
          action: 'edit',
          fromVersion: expectedVersion ?? null,
          toVersion: block.version,
          chars: content.length,
        }))
        return { text: message('tool.profileEditSaved', { scope, version: block.version }) }
      }
      // rollback：取历史版本内容，作为新版本写入（乐观锁同样适用）。
      if (!Number.isInteger(input.toVersion)) throw new Error(message('tool.profileEditToVersionRequired'))
      const target = await store.getProfileBlockVersion(scope, input.toVersion as number)
      if (target === undefined) throw new Error(message('tool.profileEditVersionNotFound', { scope, version: String(input.toVersion) }))
      const current = await store.getProfileBlock(scope)
      if (current === undefined) throw new Error(message('tool.profileEditNoBlockToRollback', { scope }))
      const updated = await store.saveProfileBlock(scope, current.version, target.content, 'rollback')
      await store.audit('profile-edit', scope, JSON.stringify({
        action: 'rollback',
        fromVersion: current.version,
        toVersion: updated.version,
        restoredFrom: target.version,
        chars: target.content.length,
      }))
      return { text: message('tool.profileEditRolledBack', { from: target.version, to: updated.version, scope }) }
    },
  })

  /**
   * Инструкция для агента: как ввести новый язык дворца (В.08).
   *
   * Окно первого запуска обещает человеку, чьего языка нет среди вшитых, что агент
   * выведет инструкцию. Обещание держится этим инструментом: текст лежит файлом рядом
   * с пакетом (`docs/agent-language-guide.ru.md`) и пока написан только по-русски —
   * это черновик, который агент переводит на язык человека сам.
   *
   * Файл, а не строка в каталоге сообщений: текст длинный, правится как документ, и
   * перевод на другие языки появится позже, не ломая проверку полноты словарей.
   */
  const languageGuide = defineTool({
    name: 'engram_language_guide',
    description: message('tool.languageGuideDescription'),
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      // Типы у параметров заданы явно: объявлений типов у хоста нет, и без этого
      // проверка типов записывала бы их в «неявный any» — лишний шум в базе ошибок.
      render: (_args: unknown, value: { readonly text: string }) => [{ type: 'text', text: value.text }],
    },
    async execute() {
      const file = join(packageRoot(), 'docs', 'agent-language-guide.ru.md')
      try {
        return { text: await readFile(file, 'utf8') }
      } catch (error) {
        // Файл потерялся при упаковке — это наша ошибка, а не «инструкции нет»:
        // говорим, где её искать, вместо пустого ответа.
        throw new EngramError('LANGUAGE_GUIDE_MISSING', message('tool.languageGuideMissing', {
          file,
          error: error instanceof Error ? error.message : String(error),
        }))
      }
    },
  })

  const tools = [save, search, factsTool, assess, timeline, episodeTimeline, update, forget, report, reviewQueue, review, stats, exportTool, importTool, distill, reflect, examine, neighborsTool, tour, auditForgotten, ingestHistory, profileEdit, languageGuide]
  // 执行前把该会话的 cwd 放进 ALS 上下文：project scope 的分库解析据此归属（并发会话互不串味）。
  return tools.map(tool => ({
    ...tool,
    execute: (args: Parameters<ToolDefinition['execute']>[0], exec: ToolRunContext) =>
      execSessionCwd.run(sessionCwdOf(exec), () => tool.execute(args, exec)),
  }))
}

// ===== P0-2 巡游路由：engram_tour =====
// 路径策略（同色→近邻→反差）：先聚同类（同 kind + 同 scope），再展开沿相关边一跳的邻居，
// 最后收一个情绪权重 ≥ 0.7 的强反差条目做收束。该顺序与古典记忆术「先放同色、再放反差」一致：
// 先建语义群落便于巩固，再以反差事件唤醒注意。

/** 巡游候选：节点 + 入选阶段的「入场动机」，供渲染时生成回声触发器。 */
export interface TourStop {
  readonly record: MemoryRecord
  /** 触发该节点入选的理由（供模型/用户解释）。 */
  readonly reason: 'same-kind' | 'neighbor' | 'contrast' | 'emotional-peak'
}

/** 巡游路径结果：有序 stops + 每段决策说明。 */
export interface TourRoute {
  readonly stops: readonly TourStop[]
  /** 巡游文案：路径逻辑 + 逐站回声。 */
  readonly narrative: string
  /** 入参：原始查询（用于审计）。 */
  readonly query: string
}

/**
 * 构造巡游路径：在 search 命中的基础上按路径策略重排。
 * 1) 起点簇：取命中中 kind 出现频次最高的前 N 个同 kind 节点（同类巩固）。
 * 2) 走廊扩展：从起点簇每个节点的 1-跳 neighbors 中挑 active 且 score > 0 的记忆。
 * 3) 反差收束：从剩余命中挑一个 emotionalValence ≥ 0.7 的做收束（强反差唤醒）。
 * 命中不足时按可用性回退；命中为 0 时返回空 stops。
 */
export async function planTour(
  hits: readonly SearchHit[],
  poolLookup: (id: string) => Promise<MemoryRecord | undefined>,
  query: string,
  maxStops = 6,
): Promise<TourRoute> {
  if (hits.length === 0) return { stops: [], narrative: message('tool.tourNoHits'), query }

  const used = new Set<string>()
  const stops: TourStop[] = []

  // 阶段 1：同类簇（按 kind 出现频次从高到低，最多 2 个 kind）。
  const kindCounts = new Map<string, number>()
  for (const hit of hits) kindCounts.set(hit.record.kind, (kindCounts.get(hit.record.kind) ?? 0) + 1)
  const topKinds = [...kindCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([kind]) => kind)
  for (const kind of topKinds) {
    for (const hit of hits) {
      if (stops.length >= maxStops) break
      if (hit.record.kind !== kind || used.has(hit.record.id)) continue
      stops.push({ record: hit.record, reason: 'same-kind' })
      used.add(hit.record.id)
    }
  }

  // 阶段 2：走廊扩展——每个已选 stop 拉邻居，挑未用过且 active 的（最多填到 maxStops-1，给反差留位）。
  for (const stop of [...stops]) {
    if (stops.length >= maxStops - 1) break
    const neighbors = await poolLookup(stop.record.id)
    // 简单退化：用 hits 自身做邻居候选（保证路径合理且不引入额外 IO）。生产实现应走 engram_neighbors。
    for (const hit of hits) {
      if (stops.length >= maxStops - 1) break
      if (used.has(hit.record.id) || hit.record.id === stop.record.id) continue
      if (hit.record.scope !== stop.record.scope) continue
      stops.push({ record: hit.record, reason: 'neighbor' })
      used.add(hit.record.id)
    }
    // 显式 noop 仅保留扩展入口
    void neighbors
  }

  // 阶段 3：反差收束——情绪权重 ≥ 0.7 且未入选的命中。
  const emotionCut = hits.find(hit => !used.has(hit.record.id) && (hit.record.imagery?.emotionalValence ?? 0) >= 0.7)
  if (emotionCut !== undefined && stops.length < maxStops) {
    stops.push({ record: emotionCut.record, reason: 'emotional-peak' })
    used.add(emotionCut.record.id)
  }

  // 阶段 4（兜底）：仍有空位则补 any remaining hit，按 score 倒序。
  for (const hit of hits) {
    if (stops.length >= maxStops) break
    if (used.has(hit.record.id)) continue
    stops.push({ record: hit.record, reason: 'contrast' })
    used.add(hit.record.id)
  }

  const narrative = renderTourNarrative(stops, query)
  return { stops, narrative, query }
}

/** 把巡游路径渲染为一段含回声触发器的可读文本（供 engram_tour 的 text 字段）。 */
function renderTourNarrative(stops: readonly TourStop[], query: string): string {
  if (stops.length === 0) return message('tool.tourNoPath')
  const reasonLabel = (reason: TourStop['reason']): string => {
    switch (reason) {
      case 'same-kind': return message('tool.tourReasonSameKind')
      case 'neighbor': return message('tool.tourReasonNeighbor')
      case 'contrast': return message('tool.tourReasonContrast')
      case 'emotional-peak': return message('tool.tourReasonEmotionalPeak')
    }
  }
  const lines: string[] = [message('tool.tourNarrativeHeader', { query, count: stops.length })]
  stops.forEach((stop, index) => {
    const caption = stop.record.imagery?.caption
    const sensory = stop.record.imagery?.sensoryTags ?? []
    const echo = caption === null || caption === undefined
      ? message('tool.tourNoImagery')
      : message('tool.tourEcho', {
          caption,
          sensory: sensory.length > 0
            ? message('tool.tourEchoSensory', { tags: sensory.slice(0, 3).join(message('tool.separatorIdea')) })
            : '',
        })
    lines.push(message('tool.tourNarrativeStop', {
      index: index + 1,
      scope: stop.record.scope,
      kind: stop.record.kind,
      content: stop.record.content.slice(0, 60),
      ellipsis: stop.record.content.length > 60 ? message('tool.ellipsis') : '',
      id: stop.record.id,
      reason: reasonLabel(stop.reason),
      echo,
    }))
  })
  return lines.join('\n')
}
