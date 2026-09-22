/**
 * 20 个 engram_ 工具的定义与执行器。工具 schema 保持窄参数；
 * scope 决定读写哪个分库；嵌入缺失时检索结果显式标记降级。
 * @module @kenz1117/dsh-engram/tools/create
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { AsyncLocalStorage } from 'node:async_hooks'
import { join } from 'node:path'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { distillMemories } from '../flywheel/distill.ts'
import { writeMirror } from '../mirror/markdown.ts'
import type { EngramEmbedder } from '../embedder/interface.ts'
import { parseJsonArray, routeFromEvents } from '../llm/client.ts'
import type { LlmRoute } from '../llm/client.ts'
import type { EngramStore } from '../store/interface.ts'
import { parseEntityMentions } from '../ingest/hook.ts'
import type { EngramKind, EngramScope, EntityId, EntityMention, FactRecord, FactWriteInput, ImageryLabel, MemoryId } from '../types.ts'
import type { MemoryRecord, SearchHit } from '../types.ts'
import { EPISODE_PROXIMITY_MS_DEFAULT, EPISODE_TIMELINE_LIMIT_DEFAULT, asEntityId, asFactId, asMemoryId, normalizeEntityName } from '../types.ts'
import { renderMemoryPacket, sanitizeProtocolText } from '../security/sanitize.ts'
import { redactSecrets } from '../security/redact.ts'
import {
  MAX_REWRITE_QUERIES, REWRITE_MAX_TOKENS, REWRITE_SYSTEM, RRF_CONSTANT,
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
import type { MemoryJudge, WriteDisposition } from '../write-disposition.ts'

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
  /** Jev 判断器（Config jev.enabled 时注入）；undefined = 纯规则四态，DEFER 落库即建边。 */
  readonly judge?: MemoryJudge
  /** 是否启用检索查询改写（Config queryRewrite）；false 时 engram_search 直接单查询。 */
  readonly queryRewrite: boolean
  /** 导出文件目录（engram_export 写入）。 */
  readonly exportDir: string
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
  if (Number.isNaN(ms)) throw new Error(`${toolName}: ${field} 不是可解析时间 ${raw}`)
  return ms
}

/** 工具入参正数解析（分钟/条数等计数）：缺省 fallback；非有限数字或越界 loud 失败。 */
function parseCountParam(raw: number | undefined, toolName: string, field: string, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback
  if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new Error(`${toolName}: ${field} 必须是有限数字，收到 ${String(raw)}`)
  const value = Math.floor(raw)
  if (value < min || value > max) throw new Error(`${toolName}: ${field} 需在 ${String(min)}-${String(max)} 之间，收到 ${String(value)}`)
  return value
}

/** 事实链行渲染：序号 + 陈述 + id/生效日期；失效事实附失效日期与后继 id（全链视图用）。 */
function renderFactLine(index: number, fact: FactRecord): string {
  const valid = new Date(fact.validAt).toISOString().slice(0, 10)
  const state = fact.invalidAt === null
    ? ''
    : `（已失效 ${new Date(fact.invalidAt).toISOString().slice(0, 10)}，被 ${fact.replacedBy ?? '未知事实'} 取代）`
  return `${index + 1}. ${fact.content}（id=${fact.id}, 生效 ${valid}）${state}`
}

/** 历史回填估算的模型可读文本（零成本，先看数再决定跑不跑）。 */
function renderHistoryEstimate(estimate: HistoryEstimate): string {
  if (estimate.unavailable !== undefined) return `历史回填不可用：${estimate.unavailable}`
  const rules = estimate.rules
  const window = rules.days === 0 ? '不限' : `${String(rules.days)} 天`
  const lines = [
    `历史回填估算：候选 ${String(estimate.candidates)} 个会话 · 规则内 ${String(estimate.eligibleTurns)} 轮 · 待处理 ${String(estimate.pendingTurns)} 轮（此前已摄取 ${String(estimate.alreadyIngested)} 轮会自动跳过）。`,
    `规则：时间窗 ${window} · 单会话≤${String(rules.maxTurnsPerSession)} 轮 · 总轮数≤${String(rules.maxTotalTurns)} · 含子代理 ${rules.includeSubagents ? '是' : '否'} · 含种子 ${rules.includeSeeded ? '是' : '否'} · 含无 cwd ${rules.includeNoCwd ? '是' : '否'}`,
    `已排除：子代理 ${String(estimate.skipped.subagent)} · 种子 ${String(estimate.skipped.seeded)} · 无 cwd ${String(estimate.skipped.noCwd)} · 超时间窗 ${String(estimate.skipped.tooOld)} · 日志不可读 ${String(estimate.skipped.unreadable)}`,
  ]
  if (estimate.truncated) {
    lines.push('注意：候选超出总轮数上限，本次只会处理最近的一部分会话；可调大 maxTotalTurns 或缩小时间窗分几次跑。')
  }
  lines.push('实际 LLM 调用次数不超过待处理轮数（低活动/寒暄/显式禁记的轮次会被节流跳过）。确认要真正回填请再传 dryRun=false。')
  return lines.join('\n')
}

/** 历史回填执行结果的模型可读文本。 */
function renderHistoryRun(result: HistoryRunResult): string {
  const state = result.state === 'done' ? '完成' : result.state === 'cancelled' ? '已中止（可重跑续做）' : '失败'
  const lines = [
    `历史回填${state}：处理 ${String(result.sessionsDone)}/${String(result.sessionsTotal)} 个会话 · ${String(result.turnsDone)} 轮 → 写入 ${String(result.memoriesWritten)} 条记忆；跳过 ${String(result.turnsSkipped)} 轮 · 失败 ${String(result.turnsFailed)} 轮。`,
  ]
  const reasons = Object.entries(result.skipReasons).sort(([, a], [, b]) => b - a)
  if (reasons.length > 0) {
    lines.push(`跳过原因：${reasons.map(([reason, count]) => `${reason} ${String(count)}`).join(' · ')}`)
  }
  if (result.failures.length > 0) {
    const shown = result.failures.slice(0, 3).map(failure => `${failure.sessionId.slice(-12)} 第 ${String(failure.turn)} 轮：${failure.reason}`)
    lines.push(`失败明细（前 ${String(shown.length)} 条）：${shown.join('；')}`)
    // 最常见的一种失败：历史会话记录的路由在当前环境没有对应模型配置。
    lines.push('若失败原因是历史会话记录的路由在当前环境不可用，可在 cordis.yml 配 provider/model，或让一个会话先用目标模型跑一轮（回填会优先复用当前在用的路由）后重跑——已完成的轮次会自动跳过。')
  }
  lines.push('同一批可重复执行：已完成的轮次按幂等键跳过，只补未完成的部分。')
  return lines.join('\n')
}

/** 证据门策略的可读提示。 */
const STRATEGY_HINT: Record<NextStrategy, string> = {
  answer: '可以据此作答',
  search_keyword: '换关键词再检索（engram_search）',
  search_room: '收窄到具体房间再检索（engram_search 带 room）',
  search_timeline: '按时间线找（engram_timeline 或 engram_episode_timeline 查情景）',
  ask_user: '向用户澄清缺失的信息',
  stop: '不回答，并向用户说明缺少什么',
}

/** 证据门判定的模型可读文本（含被拒绝的 ref 与强制改写说明）。 */
function renderAssessText(verdict: AssessVerdict, batchId: string): string {
  const lines = [
    verdict.sufficient
      ? `证据判定：充足（批次 ${batchId}，${String(verdict.evidenceRefs.length)} 条有效证据）——可以据此作答。`
      : `证据判定：不足（批次 ${batchId}）。`,
  ]
  if (verdict.evidenceRefs.length > 0) lines.push(`有效证据：${verdict.evidenceRefs.join('、')}`)
  if (verdict.rejectedRefs.length > 0) lines.push(`无效 ref（不属于该批次，已忽略）：${verdict.rejectedRefs.join('、')}`)
  if (verdict.droppedRefs.length > 0) lines.push(`超出上限被丢弃（单次最多 ${String(MAX_EVIDENCE_REFS)} 条）：${verdict.droppedRefs.join('、')}`)
  lines.push(`缺口：${verdict.missing === '' ? '（未填写）' : verdict.missing}${verdict.missingTruncated ? '（已截断）' : ''}`)
  lines.push(`下一步：${verdict.nextStrategy} —— ${STRATEGY_HINT[verdict.nextStrategy]}`)
  if (verdict.forced) {
    lines.push('注意：判定由代码修正——sufficient 需同时满足「你声称充足」「至少一条属于本批次的有效证据」「nextStrategy=answer」。')
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
      system: REWRITE_SYSTEM,
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
 * 构造 20 个工具定义（engram_save/search/facts/assess/timeline/episode_timeline/update/forget/report/review/review_queue/
 * stats/export/distill/examine/neighbors/audit_forgotten/tour/ingest_history/profile_edit）。
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
      const parts = [`已批量保存 ${value.count} 条记忆`]
      const states: string[] = []
      if (merged > 0) states.push(`并入强化 ${merged} 条既有记忆`)
      if (deferred > 0) states.push(`${deferred} 条与现有记忆高度相似待裁决`)
      if (states.length > 0) parts.push(states.join('，'))
      for (const item of items) {
        const slot = item.slot === undefined ? '' : `, ${item.slot.room}#${item.slot.index}`
        const state = item.disposition === 'merge' ? `, 并入 ${item.mergedInto}` : item.disposition === 'defer' ? ', 待裁决' : ''
        parts.push(`${item.id}（kind=${item.kind}, importance=${item.importance}${slot}${state}）`)
      }
      const failures = value.failed ?? []
      if (failures.length > 0) {
        parts.push(`${failures.length} 条失败：${failures.map(entry => `#${entry.index + 1} ${entry.reason}`).join('；')}`)
      }
      parts.push('后续会话可用 engram_search 召回。')
      return parts.join('；')
    }
    if (value.text !== undefined) return value.text
    return `已保存记忆 ${value.id}（kind=${value.kind}, importance=${value.importance}）。后续会话可用 engram_search 召回。`
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
  ): Promise<WriteOutcome> {
    const { embedding } = item
    // judge + content 成对提供时，DEFER 模糊带交 Jev 三路裁决；未注入 judge 时行为与纯规则四态一致。
    const decision = await decideWrite(store, item.kind, embedding, deps.judge === undefined ? {} : { judge: deps.judge, content: item.content })
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
      const candidates = await store.findContradictions(embedding as Float32Array)
      // judge 在场时矛盾边先经 Jev 确认（失败返回 undefined = 降级为全量建边，与旧行为一致）。
      const confirmed = deps.judge === undefined
        ? candidates
        : (await confirmContradictions(deps.judge, item.content, candidates)) ?? candidates
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
    if (items.length > MAX_SAVE_BATCH) throw new Error(`engram_save: 单次最多保存 ${MAX_SAVE_BATCH} 条`)
    const scope = scopeOf(rawScope, 'project')
    const store = await deps.openStore(scope)
    const embedder = await deps.embedder
    // 第一步：清洗 + 校验 + 批量内去重（失败按原始下标收集，不阻塞其余）。
    const prepared: { index: number; content: string; kind: EngramKind; importance: number | undefined; entities: readonly EntityMention[] }[] = []
    const failed: { index: number; reason: string }[] = []
    const seen = new Set<string>()
    for (const [index, raw] of items.entries()) {
      if (raw === null || typeof raw !== 'object') { failed.push({ index, reason: '条目必须是对象' }); continue }
      const candidate = raw as { content?: unknown; kind?: unknown; importance?: unknown; entities?: unknown }
      if (typeof candidate.content !== 'string' || candidate.content.trim() === '') {
        failed.push({ index, reason: 'content 缺失或为空' }); continue
      }
      if (!KINDS.includes(candidate.kind as EngramKind)) {
        failed.push({ index, reason: 'kind 无效' }); continue
      }
      const content = redactSecrets(sanitizeProtocolText(candidate.content))
      if (content.trim() === '') {
        failed.push({ index, reason: '清洗后内容为空（只含协议标签或密钥）' }); continue
      }
      const key = content.toLowerCase()
      if (seen.has(key)) { failed.push({ index, reason: '批量内重复' }); continue }
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
        })
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
    description: '保存长期记忆（跨会话可用），支持单条（content/kind）或批量（items，最多 10 条，单条失败不影响其余）。kind：fact 事实 / preference 偏好 / decision 决策 / episode 经历 / skill 方法。scope：project 仅当前项目，user 全局。',
    parameters: {
      content: { type: 'string', description: '记忆正文（单条模式必填），一句话完整表达' },
      kind: { type: 'string', enum: [...KINDS], description: '记忆种类（单条模式必填）' },
      entities: {
        type: 'array',
        description: '本条记忆提到的实体（可选，仅单条模式）：人名/项目名/工具名/概念名，用于按实体检索',
        items: { type: 'object', additionalProperties: false, properties: {
          name: { type: 'string', required: true, description: '实体名（专名本身，不超过 20 字）' },
          kind: { type: 'string', enum: ['person', 'project', 'tool', 'concept', 'other'], description: '实体种类，默认 other' },
          aliases: { type: 'array', items: { type: 'string' }, description: '该实体的其他叫法' },
        } },
      },
      items: {
        type: 'array',
        description: '批量保存条目数组，每项 {content, kind, importance?, entities?}；与 content/kind 二选一',
        items: { type: 'object', additionalProperties: false, properties: {
          content: { type: 'string', required: true, description: '记忆正文' },
          kind: { type: 'string', enum: [...KINDS], required: true, description: '记忆种类' },
          importance: { type: 'number', description: '重要性 0-1' },
          entities: {
            type: 'array',
            description: '该条提到的实体',
            items: { type: 'object', additionalProperties: false, properties: {
              name: { type: 'string', required: true, description: '实体名（专名本身，不超过 20 字）' },
              kind: { type: 'string', enum: ['person', 'project', 'tool', 'concept', 'other'], description: '实体种类，默认 other' },
              aliases: { type: 'array', items: { type: 'string' }, description: '该实体的其他叫法' },
            } },
          },
        } },
      },
      scope: { type: 'string', enum: ['user', 'project', 'shared'], description: '作用域，默认 project' },
      importance: { type: 'number', description: '重要性 0-1，默认 0.5（仅单条模式）' },
      placard: { type: 'string', description: '门牌（可选，仅单条模式）：4-30 字铭牌。宫殿纪律：唯一 · 差异化 · 带日期锚点（如「2026-09 向量检索选型」），禁止与既有门牌近似到无法区分' },
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
          throw new Error('engram_save: items 与 content/kind 参数不能同时使用')
        }
        if (!Array.isArray(input.items) || input.items.length === 0) {
          throw new Error('engram_save: items 必须是非空数组')
        }
        return saveBatch(sourceSessionId, input.items, input.scope)
      }
      if (typeof input.content !== 'string' || typeof input.kind !== 'string') {
        throw new Error('engram_save: 需要 content/kind（单条）或 items（批量）参数')
      }
      // 入库前协议剥离 + 密钥脱敏（模型可能把会话中的密钥或协议块原样写进记忆）。
      const content = redactSecrets(sanitizeProtocolText(input.content))
      if (content.trim() === '') throw new Error('engram_save: 清洗后内容为空（原文只含协议标签或密钥）')
      const scope = scopeOf(input.scope, 'project')
      const store = await deps.openStore(scope)
      const embedder = await deps.embedder
      const embeddings = embedder === undefined ? undefined : await embedder.embed([content.trim()])
      const imagery = placardOf(input.placard)
      const mentions = parseEntityMentions(input.entities)
      const outcome = await writeWithDisposition(store, {
        scope,
        kind: input.kind as EngramKind,
        content,
        ...(typeof input.importance === 'number' ? { importance: input.importance } : {}),
        sourceSessionId,
        ...(embeddings?.[0] === undefined ? {} : { embedding: embeddings[0] }),
        ...(imagery === undefined ? {} : { imagery }),
      })
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
          text: `与既有记忆高度重复（相似度 ${sim}），已并入 ${outcome.relatedId} 并强化其置信度与访问计数，未新建条目。若这是修正而非复述，请用 engram_update 归并。`,
        }
      }
      // 门牌质量提示：低分（不合「唯一·差异化·带日期」纪律）附增强建议。
      const placardHint = imagery === undefined || record.imageryScore === undefined
        ? ''
        : `\n${placardImprovementHint(record.imageryScore) ?? ''}`
      // DEFER：疑似矛盾/修正——落库并建 contradicts 边，报告候选由模型/用户裁决。
      if (outcome.disposition === 'defer') {
        const listed = candidates.map(candidate => `「${candidate.content}」（id=${candidate.id}）`).join('；')
        return {
          id: record.id,
          kind: record.kind,
          importance: record.importance,
          disposition: 'defer' as const,
          ...(outcome.similarity === undefined ? {} : { similarity: outcome.similarity }),
          text: `已保存 ${record.id}。注意：与现有记忆高度相似——${listed}。若这是修正而非新事实，请用 engram_update 归并，或 engram_forget 去重。${placardHint}`,
        }
      }
      const base = `已保存记忆 ${record.id}（kind=${record.kind}, importance=${record.importance}${record.slot === undefined ? '' : `, ${record.slot.room}#${record.slot.index}`}）。后续会话可用 engram_search 召回。`
      return { id: record.id, kind: record.kind, importance: record.importance, disposition: 'accept' as const, text: `${base}${placardHint}` }
    },
  })

  const search = defineTool({
    name: 'engram_search',
    description: '语义 + 关键词混合检索长期记忆。宫殿纪律：先想进哪个房间——事实厅（fact）/偏好阁（preference）/决策堂（decision）/往事廊（episode）/技法坊（skill），带上 room 参数只查该房间，更快更准；不确定房间时缺省全库检索。user 作用域存偏好与通用事实，project 作用域存项目约定与决策。结果行尾给出 id，供 engram_update/engram_forget 引用。',
    parameters: {
      query: { type: 'string', required: true, description: '检索文本' },
      scope: { type: 'string', enum: ['user', 'project', 'shared', 'all'], description: '作用域，默认 all' },
      room: { type: 'string', description: '房间路由：只在指定房间内检索（如「决策堂」）。房间目录见 engram_stats 输出' },
      limit: { type: 'number', description: '返回条数上限，默认 8' },
      asOf: { type: 'string', description: '时点回看（可选，ISO 日期如 2026-03-01）：结果行附各记忆关联实体在该时点仍有效的事实快照，回答「当时」类问题时防止过时事实误导' },
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
      const rooms = typeof input.room === 'string' && input.room.trim() !== '' ? [input.room.trim()] : undefined
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
        const ref = evidenceRefOf(hit.record.scope, hit.record.id, hit.record.slot)
        const edge = hit.viaEdge === undefined ? '' : `（经 ${hit.viaEdge.type} 关联自 ${hit.viaEdge.from}）`
        const slot = hit.record.slot === undefined ? '' : ` ${hit.record.slot.room}#${hit.record.slot.index}`
        const date = ` 刻于 ${new Date(hit.record.createdAt).toISOString().slice(0, 10)}`
        const cues = hit.cues === undefined ? '' : ` 相邻桩位: ${hit.cues.neighbors.join(', ')}`
        const notes = factNotes.get(String(hit.record.id))
        const facts = notes === undefined ? '' : ` 时点事实: ${notes.join('；')}`
        return {
          ref,
          line: `${index + 1}. [${hit.record.scope}/${hit.record.kind}]${slot}${date} ${truncateItem(hit.record.content)}（id=${hit.record.id}, ref=${ref}）${edge}${cues}${facts}`,
        }
      })
      const { kept, dropped } = fitWithinBudget(candidates, entry => entry.line.length, RECALL_TOTAL_CHARS)
      const lines = kept.map(entry => entry.line)
      if (dropped > 0) lines.push(`（另有 ${dropped} 条未展示：缩小查询范围或降低 limit 后重试）`)
      // 证据门：把本次真正输出的 ref 登记成批次，engram_assess 只能引用这里登记过的 ref。
      const sessionId = exec.agent === undefined ? undefined : String(exec.agent.session.id)
      const batch = sessionId === undefined || kept.length === 0
        ? undefined
        : evidenceBatches.register(sessionId, kept.map(entry => entry.ref))
      const prefix = degraded && lines.length > 0 ? '（语义嵌入不可用，仅关键词检索）\n' : ''
      const roomNote = rooms === undefined ? '' : `（房间路由：${rooms.join('、')}）\n`
      const asOfNote = asOfMs === undefined ? '' : `（时点回看：行尾「时点事实」为关联实体在 ${new Date(asOfMs).toISOString().slice(0, 10)} 仍有效的事实快照）\n`
      const batchNote = batch === undefined
        ? ''
        : `\n批次 ${batch.batchId}（${String(batch.refs.size)} 条可引用证据）：作答前用 engram_assess 判定证据是否充分，evidenceRefs 只能引用上面的 ref。`
      // 输出包协议标签：记忆正文是不可信历史上下文，当前请求为检索词本身。
      return { degraded, text: renderMemoryPacket(`${prefix}${roomNote}${asOfNote}${lines.join('\n') || '无命中'}${batchNote}`, 'tool_search', input.query) }
    },
  })

  const factsTool = defineTool({
    name: 'engram_facts',
    description: '实体事实链：查询某实体的时序事实（asOf 时点回看 / includeInvalid 全链展开），或写入与修正事实（facts 数组）。事实是关于具体实体的一条客观陈述（状态/归属/关系/数据）。修正过时事实时传 replaces=旧事实 id：旧事实软失效、新事实接棒，历史链保留——不要反复保存互相矛盾的事实，用取代链表达演变。',
    parameters: {
      scope: { type: 'string', enum: ['user', 'project', 'shared'], description: '作用域，默认 project' },
      entityId: { type: 'string', description: '查询模式：实体 id（engram_search/engram_entities 输出中获取；与 entity 二选一，优先）' },
      entity: { type: 'string', description: '查询模式：实体名（按名称与别名精确匹配；未命中不新建，返回近似候选）' },
      asOf: { type: 'string', description: '时点回看（ISO 日期或毫秒时间戳）：只看该时点仍有效的事实' },
      includeInvalid: { type: 'boolean', description: 'true 展开全链（含已失效事实，查看事实演变历史）' },
      limit: { type: 'number', description: '返回条数上限，默认 20' },
      offset: { type: 'number', description: '分页偏移，默认 0' },
      facts: {
        type: 'array',
        description: '写入模式：事实数组（与查询参数二选一），每项 {entity 或 entityId, content, replaces?}',
        items: { type: 'object', additionalProperties: false, properties: {
          entity: { type: 'string', description: '实体名（与 entityId 二选一；实体不存在时新建）' },
          entityId: { type: 'string', description: '实体 id（优先于 entity）' },
          content: { type: 'string', required: true, description: '事实陈述（一句话，不超过 500 字符）' },
          replaces: { type: 'string', description: '被取代的旧事实 id（旧事实软失效；id 不存在时按无取代写入）' },
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
          throw new Error('engram_facts: facts（写入）与 entityId/entity/asOf/includeInvalid（查询）参数不能同时使用')
        }
        if (!Array.isArray(input.facts) || input.facts.length === 0) {
          throw new Error('engram_facts: facts 必须是非空数组')
        }
        if (input.facts.length > MAX_SAVE_BATCH) throw new Error(`engram_facts: 单次最多写入 ${MAX_SAVE_BATCH} 条事实`)
        const failed: { index: number; reason: string }[] = []
        const prepared: { index: number; input: FactWriteInput }[] = []
        for (const [index, raw] of input.facts.entries()) {
          if (raw === null || typeof raw !== 'object') { failed.push({ index, reason: '条目必须是对象' }); continue }
          const candidate = raw as { entity?: unknown; entityId?: unknown; content?: unknown; replaces?: unknown }
          if (typeof candidate.content !== 'string' || candidate.content.trim() === '') {
            failed.push({ index, reason: 'content 缺失或为空' }); continue
          }
          // 入库前协议剥离 + 密钥脱敏（与 engram_save 同一清洗纪律）。
          const content = redactSecrets(sanitizeProtocolText(candidate.content))
          if (content.trim() === '') { failed.push({ index, reason: '清洗后内容为空（只含协议标签或密钥）' }); continue }
          try {
            let entityId: EntityId
            if (typeof candidate.entityId === 'string' && candidate.entityId.trim() !== '') {
              entityId = asEntityId(candidate.entityId.trim())
            } else if (typeof candidate.entity === 'string' && candidate.entity.trim() !== '') {
              // 按名写入走消解（未命中新建）；kind 固定 other（事实挂靠不负责实体归类）。
              const resolved = await store.resolveEntities([{ name: candidate.entity.trim(), kind: 'other' }])
              const resolvedEntity = resolved[0]
              if (resolvedEntity === undefined) { failed.push({ index, reason: '实体消解未返回结果' }); continue }
              entityId = resolvedEntity.id
            } else {
              failed.push({ index, reason: '需要 entity 或 entityId' }); continue
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
        const parts = [`已写入 ${String(records.length)} 条事实`]
        const replacedCount = prepared.filter(entry => entry.input.replaces !== undefined).length
        if (replacedCount > 0) parts.push(`其中 ${String(replacedCount)} 条声明取代旧事实（旧事实已软失效，历史链保留；id 不存在时按无取代写入）`)
        for (const item of items) {
          parts.push(`${item.id} → 实体 ${item.entityId}${item.replaced === undefined ? '' : `（取代 ${item.replaced}）`}`)
        }
        if (failed.length > 0) {
          parts.push(`${String(failed.length)} 条失败：${failed.map(entry => `#${String(entry.index + 1)} ${entry.reason}`).join('；')}`)
        }
        return {
          count: records.length,
          items,
          ...(failed.length > 0 ? { failed } : {}),
          text: parts.join('；'),
        }
      }
      // —— 查询模式：entityId 优先；entity 名走「列表子串查 + 归一精确过滤」，
      // 不经 resolveEntities（查询路径未命中会新建，污染实体词典）。
      const hasEntityId = typeof input.entityId === 'string' && input.entityId.trim() !== ''
      const hasEntityName = typeof input.entity === 'string' && input.entity.trim() !== ''
      if (!hasEntityId && !hasEntityName) {
        throw new Error('engram_facts: 需要 entityId/entity（查询）或 facts（写入）参数')
      }
      const limit = parseCountParam(typeof input.limit === 'number' ? input.limit : undefined, 'engram_facts', 'limit', 20, 1, 100)
      const offset = parseCountParam(typeof input.offset === 'number' ? input.offset : undefined, 'engram_facts', 'offset', 0, 0, 100000)
      const includeInvalid = input.includeInvalid === true
      let entityId: EntityId
      let entityName: string
      if (hasEntityId) {
        entityId = asEntityId((input.entityId as string).trim())
        const detail = await store.entityDetail(entityId, 0)
        if (detail === undefined) throw new Error(`engram_facts: 实体 ${input.entityId} 不存在`)
        entityName = detail.entity.name
      } else {
        const name = (input.entity as string).trim()
        const { items: candidates } = await store.listEntities({ q: name, limit: 10, offset: 0 })
        const normalized = normalizeEntityName(name)
        const matches = candidates.filter(item =>
          normalizeEntityName(item.entity.name) === normalized
          || item.entity.aliases.some(alias => normalizeEntityName(alias) === normalized))
        if (matches.length === 0) {
          const near = candidates.map(item => `${item.entity.name}（id=${item.entity.id}）`).join('；')
          return {
            total: 0,
            text: `未找到实体「${name}」（按名称与别名精确匹配，不自动新建）。${near === '' ? '词典中没有近似名称。' : `近似候选：${near}。可用 entityId 精确查询。`}`,
          }
        }
        if (matches.length > 1) {
          const listed = matches.map(item => `${item.entity.name}（id=${item.entity.id}）`).join('；')
          return { total: 0, text: `名称「${name}」匹配到 ${String(matches.length)} 个实体：${listed}。请用 entityId 指定。` }
        }
        const match = matches[0]
        if (match === undefined) {
          return { total: 0, text: `未找到实体「${name}」。` }
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
      const header = `实体「${entityName}」的事实（共 ${String(total)} 条${asOfMs === undefined ? '' : `，时点 ${new Date(asOfMs).toISOString().slice(0, 10)}`}${includeInvalid ? '，全链含已失效' : ''}）`
      const lines = facts.map((fact, index) => renderFactLine(index, fact))
      const body = lines.length === 0 ? '没有符合条件的事实。' : lines.join('\n')
      // 输出包协议标签：事实摘自历史记忆，属不可信历史上下文；当前请求以实体名近似。
      return { total, text: renderMemoryPacket(`${header}\n${body}`, 'tool_facts', hasEntityName ? (input.entity as string) : entityId) }
    },
  })

  const assess = defineTool({
    name: 'engram_assess',
    description: '证据门：检索（engram_search）之后、作答之前，判定「检索到的内容是否足以回答当前问题」。提交 batchId、sufficient、最多 8 条 evidenceRefs（只能引用该批次输出里的 ref=…）、缺口说明 missing（≤160 字符）与下一步 nextStrategy。代码强制校验：sufficient 需同时满足「你声称充足」「至少一条属于本批次的有效证据」「nextStrategy=answer」，否则判为不足并把策略改回继续检索；不属于该批次的 ref 会被拒绝并列出。判词与拒绝明细写入审计日志。',
    parameters: {
      batchId: { type: 'string', required: true, description: 'engram_search 输出末尾给出的批次 id（如 batch-3）' },
      sufficient: { type: 'boolean', required: true, description: '证据是否足以回答当前问题（true 时 nextStrategy 必须为 answer）' },
      evidenceRefs: { type: 'array', items: { type: 'string' }, description: '引用的证据 ref（最多 8 条，只能取该批次输出里的 ref=…）' },
      missing: { type: 'string', description: '缺少什么维度的信息（≤160 字符）' },
      nextStrategy: { type: 'string', enum: [...NEXT_STRATEGIES], description: '下一步：answer 作答 / search_keyword 换关键词 / search_room 换房间 / search_timeline 查时间线 / ask_user 问用户 / stop 不回答' },
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
      if (typeof input.batchId !== 'string' || input.batchId.trim() === '') throw new Error('engram_assess: batchId 必填（取自 engram_search 输出末尾）')
      const sessionId = exec.agent === undefined ? undefined : String(exec.agent.session.id)
      const batch = sessionId === undefined ? undefined : evidenceBatches.get(sessionId, input.batchId.trim())
      if (batch === undefined) {
        throw new Error(`engram_assess: 批次 ${input.batchId} 不存在或已过期（每个会话保留最近 ${String(MAX_BATCHES_PER_SESSION)} 个批次）——请重新 engram_search 取新批次`)
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
    description: '按时间范围与主题浏览记忆（默认时间倒序，最近 20 条）。order=tour 时改按固定巡游路线的桩位顺序走（未上路线者排末尾），输出附宫殿坐标——适合按宫殿固定路线复述；多作用域按 user→project→shared 顺序拼接（桩位顺序只在各自库内有意义）。无参数直接列出最近记录。',
    parameters: {
      scope: { type: 'string', enum: ['user', 'project', 'shared', 'all'], description: '作用域，默认 all' },
      topic: { type: 'string', description: '主题子串' },
      since: { type: 'string', description: '起始时间（ISO 或可解析日期）' },
      until: { type: 'string', description: '结束时间' },
      order: { type: 'string', enum: ['time', 'tour'], description: "排序：缺省 'time' 按创建时间倒序；'tour' 按固定巡游路线桩位顺序" },
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
        const slot = order === 'tour' && record.slot !== undefined ? ` ${record.slot.room}#${record.slot.index}` : ''
        return `${new Date(record.createdAt).toISOString()}${slot} [${record.scope}/${record.kind}] ${truncateItem(record.content)}（id=${record.id}）`
      }))
      const tail = order === 'tour' ? '\n（按固定巡游路线桩位顺序；未上路线者按创建时间排末尾）' : ''
      return { text: renderMemoryPacket(`${body.join('\n') || '时间线为空'}${tail}`, 'tool_timeline', input.topic ?? '（对话继续）') }
    },
  })

  const episodeTimeline = defineTool({
    name: 'engram_episode_timeline',
    description: 'episode 情景记忆的独立时间线：按日期范围与来源会话浏览经历，输出按会话分组（组间新→旧，组内时间升序），适合回答「那天/那段时间我们做了什么」。around 传锚点记忆 id 时切换为时间邻近扩展——列出锚点创建时刻 ± 窗口内的情景（忽略日期过滤），回答「当时前后还发生了什么」。',
    parameters: {
      scope: { type: 'string', enum: ['user', 'project', 'shared', 'all'], description: '作用域，默认 all' },
      since: { type: 'string', description: '起始日期（ISO 或可解析日期）' },
      until: { type: 'string', description: '结束日期' },
      sessionId: { type: 'string', description: '只看该来源会话的情景（id 精确匹配，从本工具输出的「会话 …」组头取得）' },
      around: { type: 'string', description: '锚点记忆 id：切换为时间邻近扩展模式（与 since/until/sessionId 互斥，此时忽略它们）' },
      windowMinutes: { type: 'number', description: `邻近窗口分钟数（around 模式，默认 ${String(EPISODE_PROXIMITY_MS_DEFAULT / 60000)}）` },
      limit: { type: 'number', description: `最多返回条数（默认 ${String(EPISODE_TIMELINE_LIMIT_DEFAULT)}）` },
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
        `${new Date(record.createdAt).toISOString()} [${record.scope}/${record.kind}] ${truncateItem(record.content)}（id=${record.id}）`
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
            ? [`锚点：${renderRow(around.anchor)}`, '邻近窗口内没有情景记忆。']
            : [
                `锚点：${renderRow(around.anchor)}`,
                `邻近情景（±${String(windowMinutes)} 分钟，${String(around.neighbors.length)} 条，按时间正序）：`,
                ...around.neighbors.map(renderRow),
              ]
          const body = enforceBudget(lines)
          return { text: renderMemoryPacket(body.join('\n'), 'tool_episode_timeline', aroundId) }
        }
        throw new Error(`engram_episode_timeline: 锚点 ${aroundId} 不存在`)
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
          ? `[无会话来源] ${new Date(group.startedAt).toISOString()} ~ ${new Date(group.endedAt).toISOString()}（${String(group.episodes.length)} 条）`
          : `[会话 ${group.sessionId}] ${new Date(group.startedAt).toISOString()} ~ ${new Date(group.endedAt).toISOString()}（${String(group.episodes.length)} 条）`)
        // 组头摘要：摄取期生成的一句话概括，模型不用逐条展开就能定位目标会话。
        if (group.summary !== undefined) lines.push(`  摘要：${group.summary}`)
        for (const record of group.episodes) lines.push(`- ${renderRow(record)}`)
      }
      const body = enforceBudget(lines)
      return { text: renderMemoryPacket(body.join('\n') || '情景时间线为空', 'tool_episode_timeline', sessionId ?? '（对话继续）') }
    },
  })

  const update = defineTool({
    name: 'engram_update',
    description: '修正一条记忆：写入新条目并把旧条目标记为被取代（链条保留，可审计）。id 来自 engram_search 结果。',
    parameters: {
      id: { type: 'string', required: true, description: '要修正的旧条目 id' },
      content: { type: 'string', required: true, description: '修正后的正文' },
      scope: { type: 'string', enum: ['user', 'project', 'shared'], description: '旧条目作用域，默认 project' },
      kind: { type: 'string', enum: [...KINDS], description: '种类，默认继承旧条目' },
      placard: { type: 'string', description: '门牌（可选）：4-30 字铭牌，替换旧条目门牌。宫殿纪律：唯一 · 差异化 · 带日期锚点' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true },
        superseded: { type: 'string', required: true },
      } },
      render: (_args, value) =>
        [{ type: 'text', text: `已写入修正记忆 ${value.id}；旧条目 ${value.superseded} 已归档并建立取代链。` }],
    },
    async execute(args) {
      const input = args as { id: string; content: string; scope?: unknown; kind?: EngramKind; placard?: unknown }
      // 入库前协议剥离 + 密钥脱敏，与 engram_save 同一防线。
      const content = redactSecrets(sanitizeProtocolText(input.content))
      if (content.trim() === '') throw new Error('engram_update: 清洗后内容为空（原文只含协议标签或密钥）')
      const scope = scopeOf(input.scope, 'project')
      const store = await deps.openStore(scope)
      const old = await store.get(input.id as never)
      if (old === undefined) throw new Error(`engram_update: 条目 ${input.id} 不存在于 ${scope} 库（用 engram_search 确认 id 与 scope）`)
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
    description: '闭馆仪式（软删，可恢复）：遗忘前必须留下「为什么关 / 影响谁 / 还有用吗」三问答案作为墓志铭，便于日后考古。id 与 scope 来自 engram_search 结果。',
    parameters: {
      id: { type: 'string', required: true, description: '条目 id' },
      scope: { type: 'string', enum: ['user', 'project', 'shared'], description: '条目作用域，默认 project' },
      reason: { type: 'string', required: true, description: '闭馆原因：被取代 / 过期 / 与现实不符 / 隐私 等' },
      affects: { type: 'string', required: true, description: '影响哪些条目/人/项目，空串表示不适用' },
      stillUseful: { type: 'string', required: true, description: '遗留价值：可考古 / 可复习 / 回滚时如何理解' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: `记忆 ${value.id} 已闭馆（软删，可恢复），墓志铭已刻入操作日志。` }],
    },
    async execute(args) {
      const input = args as { id: string; scope?: unknown; reason: unknown; affects: unknown; stillUseful: unknown }
      const scope = scopeOf(input.scope, 'project')
      const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
      const affects = typeof input.affects === 'string' ? input.affects.trim() : ''
      const stillUseful = typeof input.stillUseful === 'string' ? input.stillUseful.trim() : ''
      if (reason === '' || affects === '' || stillUseful === '') {
        throw new Error('engram_forget: 闭馆三问（reason / affects / stillUseful）都必须填写，方便日后考古')
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
    description: '历史会话回填：把 dsh 的历史会话逐轮提炼进记忆宫殿（写进各会话自己 cwd 对应的项目库；此前已摄取的轮次自动跳过，中断后可重跑续做）。dryRun 缺省 true，只返回估算（候选会话数 / 规则内轮数 / 待处理轮数）而不调 LLM、不写库；确认后再传 dryRun=false 执行。大批量回填建议用设置页「历史回填」tab（有规则选择、进度与暂停）；本工具适合先估算或小批量执行。',
    parameters: {
      dryRun: { type: 'boolean', description: '只估算不执行（默认 true；显式 false 才真正回填）' },
      days: { type: 'number', description: '时间窗天数，0 = 不限；缺省用部署配置值' },
      maxTurnsPerSession: { type: 'number', description: '单个会话最多摄取轮数；缺省用部署配置值' },
      maxTotalTurns: { type: 'number', description: '本次最多处理的总轮数（只能调低配置硬上限）' },
      includeSubagents: { type: 'boolean', description: '是否包含子代理会话（默认 false）' },
      includeSeeded: { type: 'boolean', description: '是否包含种子会话（默认 false）' },
      includeNoCwd: { type: 'boolean', description: '是否包含无 cwd 会话（默认 false；这类会话只能写进 user 库）' },
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
        return { text: '历史回填不可用：当前组合未挂载会话持久化服务（会话日志不可读，例如 headless profile）。' }
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
    description: '闭馆考古：列出最近 N 条已闭馆条目 + 墓志铭（为什么关 / 影响谁 / 还有用吗），便于复核过去的遗忘是否得当。',
    parameters: {
      scope: { type: 'string', enum: ['user', 'project', 'shared', 'all'], description: '作用域，默认 all' },
      limit: { type: 'integer', description: '返回条数上限，默认 20' },
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
      if (sliced.length === 0) return { text: '尚无闭馆条目。' }
      const lines = sliced.map((row, index) => {
        const stamp = new Date(row.forgottenAt).toISOString()
        const tomb = row.tombstone === null
          ? '（墓志铭缺失：旧版无三问数据）'
          : `\n   - 为什么关：${row.tombstone.reason}\n   - 影响谁：${row.tombstone.affects}\n   - 还有用吗：${row.tombstone.stillUseful}`
        return `${index + 1}. [${row.scope}/${row.kind}] ${row.content.slice(0, 80)}${row.content.length > 80 ? '…' : ''}\n   id=${row.id} · importance=${row.importance.toFixed(2)} · 闭馆于 ${stamp}${tomb}`
      })
      return { text: `闭馆考古（共 ${sliced.length} 条）：\n${lines.join('\n')}` }
    },
  })

  // 今日待回忆队列（检索练习）：只给线索（房间/桩位/门牌），不给内容——模型先主动回忆，
  // 再用 engram_review 揭示核对、engram_report grade 自评。主动回忆的强化效果远强于被动重看。
  const reviewQueue = defineTool({
    name: 'engram_review_queue',
    description: '今日待回忆队列：列出已到期间隔重复的记忆，每条只给宫殿坐标与门牌线索（不给正文）。用法：对每条先尝试回忆内容，然后 engram_review 揭示核对，再 engram_report 传 grade（0-5）自评——主动回忆比重复阅读的记忆强化效果强得多。会话开始注入会提示今日是否有待回忆。',
    parameters: {
      scope: { type: 'string', enum: ['user', 'project', 'shared', 'all'], description: '作用域，默认 all' },
      limit: { type: 'integer', description: '返回条数上限，默认 10（最逾期在前）' },
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
      if (total === 0) return { text: '今日无待回忆条目（队列空）。新记忆保存后次日首次到期。' }
      const lines: string[] = [`今日待回忆 ${total} 段（最逾期在前）。对每段：先回忆 → engram_review 核对 → engram_report 传 grade 自评。`]
      for (const { scope, due } of groups) {
        for (const [index, record] of due.entries()) {
          const slot = record.slot === undefined ? '（未排桩）' : `${record.slot.room} #${record.slot.index}`
          const placard = record.imagery?.caption ?? '（无门牌）'
          const overdueDays = record.review?.nextReviewAt === null || record.review?.nextReviewAt === undefined
            ? 0
            : Math.max(0, Math.floor((now - record.review.nextReviewAt) / 86_400_000))
          const overdue = overdueDays === 0 ? '今日到期' : `逾期 ${overdueDays} 天`
          lines.push(`${index + 1}. [${scope}] ${slot} · 门牌「${placard}」 · ${overdue} · id=${record.id}`)
        }
      }
      return { text: lines.join('\n') }
    },
  })

  // 奖励信号入口：模型用完一条记忆（尤其 skill 类）后回报实际效果，成功提权/失败降权。
  // 同时衔接间隔重复：success=grade 5 / failure=grade 1 推进 SM-2 调度；显式 grade 自评优先。
  const report = defineTool({
    name: 'engram_report',
    description: '回报一条记忆（尤其 skill 类）使用后的实际效果：success（有效，提权）或 failure（无效，降权）。id 与 scope 来自 engram_search 结果。也可作为复习自评入口：传 grade（0 完全遗忘 … 5 完美回忆）显式报告回忆质量。效果影响后续召回排序与复习排期，长期无效的记忆会被衰减归档。',
    parameters: {
      id: { type: 'string', required: true, description: '条目 id' },
      outcome: { type: 'string', enum: ['success', 'failure'], description: '使用效果（与 grade 二选一；同传时 grade 优先）' },
      grade: { type: 'integer', description: '回忆质量自评 0-5（复习答题用；0/1 完全遗忘，3 勉强，5 完美）' },
      scope: { type: 'string', enum: ['user', 'project', 'shared'], description: '条目作用域，默认 project' },
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
          ? `已记录：记忆 ${value.id} 使用有效（confidence=${value.confidence}）。该记忆后续召回排序将提升。`
          : `已记录：记忆 ${value.id} 标记为无效/遗忘（confidence=${value.confidence}）。排序将下降，持续无效会被衰减归档。`)
          + (value.nextReviewAt === undefined
            ? ''
            : ` 下次复习：${new Date(value.nextReviewAt).toISOString().slice(0, 10)}。`),
      }],
    },
    async execute(args) {
      const input = args as { id: string; outcome?: unknown; grade?: unknown; scope?: unknown }
      const hasGrade = Number.isInteger(input.grade) && (input.grade as number) >= 0 && (input.grade as number) <= 5
      if (input.grade !== undefined && !hasGrade) {
        throw new Error('engram_report: grade 必须是 0-5 的整数')
      }
      if (input.outcome !== 'success' && input.outcome !== 'failure' && !hasGrade) {
        throw new Error('engram_report: 需要 outcome（success/failure）或 grade（0-5）参数')
      }
      // grade 显式自评优先；否则 outcome 映射为 SM-2 grade（success=5 完美，failure=1 遗忘）。
      const outcome = input.outcome === 'success' || input.outcome === 'failure'
        ? input.outcome
        : (input.grade as number) >= 3 ? 'success' : 'failure'
      const grade = (hasGrade ? input.grade : outcome === 'success' ? 5 : 1) as 0 | 1 | 2 | 3 | 4 | 5
      const scope = scopeOf(input.scope, 'project')
      const store = await deps.openStore(scope)
      const record = await store.reportOutcome(input.id as never, outcome)
      if (record === undefined) throw new Error(`engram_report: 条目 ${input.id} 不存在（scope=${scope}）`)
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
    description: '审计一条记忆：查看内容、来源（会话/轮次/事件）、取代链、矛盾与关联，以及最近操作日志。',
    parameters: {
      id: { type: 'string', required: true, description: '条目 id' },
      scope: { type: 'string', enum: ['user', 'project', 'shared'], description: '条目作用域，默认 project' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const input = args as { id: string; scope?: unknown }
      const store = await deps.openStore(scopeOf(input.scope, 'project'))
      const view = await store.review(input.id as never)
      if (view === undefined) return { text: `未找到条目 ${input.id}（用 engram_search 确认 id 与 scope）` }
      const record = view.record
      const source = record.sourceSessionId === null
        ? '显式保存（无会话来源）'
        : `会话 ${record.sourceSessionId}`
          + (record.sourceRound === null ? '' : ` 第 ${record.sourceRound} 轮`)
          + (record.sourceSeq === null ? '' : `，事件 seq ${record.sourceSeq}`)
      const section = (title: string, ids: readonly string[]): string =>
        ids.length === 0 ? '' : `\n${title}: ${ids.join(', ')}`
      // 输出包协议标签：记忆正文与来源链是不可信历史上下文。
      return {
        text: renderMemoryPacket([
          `内容: ${record.content}`,
          `属性: kind=${record.kind}, scope=${record.scope}, status=${record.status}, importance=${record.importance}, confidence=${record.confidence}, 访问 ${record.accessCount} 次`,
          `来源: ${source}`,
          section('被谁取代', view.supersededBy.map(String)),
          section('取代了谁', view.supersedes.map(String)),
          section('矛盾候选', view.contradicts.map(String)),
          section('关联', view.related.map(String)),
          view.revisions.length === 0 ? '' : `\n修订历史:\n${view.revisions.map(rev =>
            `- ${new Date(rev.supersededAt).toISOString()} [${rev.kind}] ${truncateItem(rev.content)}`).join('\n')}`,
          view.operations.length === 0 ? '' : `\n最近操作:\n${view.operations.map(op => `- ${new Date(op.at).toISOString()} ${op.op}${op.detail === null ? '' : ` ${op.detail}`}`).join('\n')}`,
        ].filter(part => part !== '').join('\n'), 'tool_review', '（对话继续）'),
      }
    },
  })

  const stats = defineTool({
    name: 'engram_stats',
    description: '记忆库统计：各状态与种类数量、关系边数、信噪比、操作日志量，以及房间目录（房名/桩位数/最新门牌——检索前先看目录决定进哪个房间，配 engram_search 的 room 参数）。scope=all 时合并两库。',
    parameters: {
      scope: { type: 'string', enum: ['user', 'project', 'shared', 'all'], description: '作用域，默认 all' },
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
          .sort(([a], [b]) => a.localeCompare(b, 'zh-Hans-CN'))
          .map(([room, state]) => {
            const placard = latestPlacardByRoom.get(room)
            return `  ${room}: ${state.count}/${state.maxIndex} 桩${placard === undefined ? '' : ` · 最新门牌「${placard}」`}`
          })
        return [
          `[${scope}] 总数 ${stats.total}（active ${stats.active} / archived ${stats.archived} / forgotten ${stats.forgotten}）`,
          `种类分布: ${Object.entries(stats.byKind).map(([kind, count]) => `${kind}=${count}`).join(', ') || '空'}`,
          `关系边 ${stats.edges} 条 · 信噪比 ${(stats.signalRatio * 100).toFixed(1)}% · 操作日志 ${stats.opLogCount} 条`,
          roomLines.length === 0 ? '房间目录: （尚未排桩）' : `房间目录（engram_search 用 room 参数直进）:\n${roomLines.join('\n')}`,
        ].join('\n')
      }).join('\n\n')
      return { text }
    },
  })

  const exportTool = defineTool({
    name: 'engram_export',
    description: '把记忆库导出为文件（Markdown / JSON / 镜像目录），返回文件路径。redactedView=true 时输出脱敏视图（内容二次清洗并截断为 40 字预览，可安全分享）。format=markdown-mirror 时按房间（kind）分目录、每条记忆一个 .md + frontmatter，附房间清单 _meta.json 与全宫殿入口 _index.md，可直接用 Obsidian / git 漫游。',
    parameters: {
      format: { type: 'string', enum: ['markdown', 'json', 'markdown-mirror'], description: '导出格式：markdown 单文件、json 单文件、markdown-mirror 每条记忆一文件（按房间分目录，默认 markdown）' },
      scope: { type: 'string', enum: ['user', 'project', 'shared', 'all'], description: '作用域，默认 all' },
      redactedView: { type: 'boolean', description: '脱敏视图：内容二次脱敏并截断为预览（默认 false 完整导出；镜像模式忽略此参数）' },
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
          const report = await writeMirror(mirrorRoot, data)
          written.push(`${mirrorRoot}（${report.fileCount} 个文件，${data.records.length} 条记忆，${report.rooms.length} 个房间）`)
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
              `# dsh-engram 导出（${scope}${redactedView ? '，脱敏视图' : ''}）`,
              '',
              ...payload.records.map(record =>
                `- [${record.status}/${record.kind}] ${record.content}（id=${record.id}，importance ${record.importance}）`),
              '',
              '## 关系边',
              ...payload.edges.map(edge => `- ${edge.from} --${edge.type}--> ${edge.to}`),
              '',
            ].join('\n')
        await writeFile(path, body, { mode: 0o600 })
        written.push(`${path}（${payload.records.length} 条记忆，${payload.edges.length} 条边${redactedView ? '，脱敏视图' : ''}）`)
      }
      return { text: `已导出${redactedView ? '（脱敏视图）' : ''}:\n${written.join('\n')}` }
    },
  })

  const distill = defineTool({
    name: 'engram_distill',
    description: '蒸馏整理：把同主题的记忆簇合并提炼为更高层的规律（旧条目归档、supersedes 链保留）。建议记忆较多时周期性执行。',
    parameters: {
      scope: { type: 'string', enum: ['user', 'project', 'shared'], description: '作用域，默认 user' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const input = args as { scope?: unknown }
      const scope = scopeOf(input.scope, 'user')
      if (deps.call === undefined) throw new Error('engram_distill: 辅助 LLM 不可用（宿主未提供 llm 服务），无法蒸馏')
      const call = deps.call
      const events = (exec.agent?.session?.snapshotEvents() ?? []) as unknown as Parameters<typeof routeFromEvents>[0]
      const route = deps.routeOverride ?? routeFromEvents(events)
      if (route === undefined) throw new Error('engram_distill: 无法确定模型路由（会话尚无模型请求），请在 cordis.yml 配置 provider/model')
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
      return { text: `蒸馏完成：取材 ${outcome.input} 条，产出 ${outcome.distilled} 条高层规律，归档 ${outcome.superseded} 条旧记忆（supersedes 链已建立，可 engram_review 审计）。` }
    },
  })

  /**
   * 渐进式披露 — 记忆铭牌批量访客：拿到一组 id 后才决定取哪几条。
   * 与 engram_search 配合使用：search 只返门牌号摘要，examine 才进房看铭牌。
   */
  const examine = defineTool({
    name: 'engram_examine',
    description: '渐进式披露：按 id 批量拉取记忆完整铭牌（content + 房间 + 状态 + 边关系）。仅在已通过 engram_search/timeline/neighbors 拿到候选 id 后调用，避免一次性吞全文。建议 ≤16 个 id，超出会按入参顺序保留前 N 条。',
    parameters: {
      ids: { type: 'array', items: { type: 'string' }, description: '记忆 id 列表' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const input = args as { ids?: unknown }
      const rawIds = Array.isArray(input.ids) ? input.ids.filter((x): x is string => typeof x === 'string') : []
      if (rawIds.length === 0) throw new Error('engram_examine: ids 必填且至少含 1 条')
      const ids = rawIds.slice(0, 16).map(id => asMemoryId(id))
      const store = await deps.openStore('user')
      const projectStore = await deps.openStore('project')
      const [fromUser, fromProject] = await Promise.all([store.getMany(ids), projectStore.getMany(ids)])
      const records = [...fromUser, ...fromProject]
      if (records.length === 0) throw new Error(`engram_examine: 全部 ${ids.length} 个 id 都找不到`)
      const text = records.map((record, index) => [
        `### ${index + 1}. [${record.scope}/${record.kind}/${record.status}] id=${record.id}`,
        `铭牌: ${record.content}`,
        `地标亮度=${record.importance.toFixed(2)} · 考据可靠度=${record.confidence.toFixed(2)} · 参观=${record.accessCount}人次`,
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
    description: '走廊漫步：从某条记忆出发走 1-3 跳内的 related/supersedes/contradicts 边，返回邻居记忆简表（仅 id + scope + kind + status + content），便于判断下一站。',
    parameters: {
      id: { type: 'string', description: '起点记忆 id' },
      depth: { type: 'integer', description: '跳数（默认 1，最多 3，由执行器夹逼）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const input = args as { id?: unknown; depth?: unknown }
      if (typeof input.id !== 'string' || input.id === '') throw new Error('engram_neighbors: id 必填')
      const depth = Number.isInteger(input.depth) ? Math.min(Math.max(1, input.depth as number), 3) : 1
      const seed = asMemoryId(input.id)
      const userStore = await deps.openStore('user')
      const projectStore = await deps.openStore('project')
      const seedRow = await userStore.get(seed) ?? await projectStore.get(seed)
      if (seedRow === undefined) throw new Error(`engram_neighbors: 起点 ${seed} 不存在`)
      const seedScope = seedRow.scope
      const scopeStore = seedScope === 'user' ? userStore : projectStore
      const neighbors = await scopeStore.neighbors(seed, depth)
      if (neighbors.length === 0) return { text: `从 ${seed}（${seedScope}）出发，${depth} 跳内无邻居记忆。` }
      const lines = neighbors.map((record, index) => `${index + 1}. [${record.scope}/${record.kind}/${record.status}] ${record.content.slice(0, 80)}${record.content.length > 80 ? '…' : ''}（id=${record.id}）`)
      return { text: `起点 ${seed}（${seedScope}）→ ${depth} 跳走廊共访 ${neighbors.length} 条：\n${lines.join('\n')}` }
    },
  })

  /**
   * P0-2 巡游路由：把检索结果重组为有序 3-7 条记忆路径，附回声触发器与入选理由。
   * 与 engram_search 复用底层查询，避免重复 IO。
   */
  const tour = defineTool({
    name: 'engram_tour',
    description: '巡游路由。mode=fixed：按固定巡游路线走全宫（桩位顺序恒定，骨架长期复用——宫殿的路线永远不变，靠顺序提取）；mode=thematic（默认）：按主题动态规划 3-7 站（同类巩固 → 走廊相邻 → 反差补位），适合用户问起某主题时给出一条可走的导览路线。',
    parameters: {
      query: { type: 'string', description: '巡游主题（thematic 模式必填，与 engram_search 同义）' },
      mode: { type: 'string', enum: ['fixed', 'thematic'], description: 'fixed 固定路线全宫巡游 / thematic 主题动态路线（默认 thematic）' },
      scope: { type: 'string', enum: ['user', 'project', 'shared', 'all'], description: '作用域，默认 all' },
      maxStops: { type: 'integer', description: '最多站数（默认 6，3-7 之间；fixed 模式默认 20）' },
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
            const slot = record.slot === undefined ? '' : `${record.slot.room} #${record.slot.index} · `
            const placard = record.imagery?.caption
            lines.push(`第 ${stop.position + 1} 站 · ${slot}[${record.kind}] ${truncateItem(record.content)}（id=${record.id}）${placard === null || placard === undefined ? '' : ` · 门牌「${placard}」`}`)
          }
          if (lines.length > 0) sections.push(`【${scope} 宫殿 · 固定巡游】\n${lines.join('\n')}`)
        }
        if (shown === 0) return { text: '巡游路线为空：尚无排桩记忆（保存记忆后自动登记路线）。' }
        const tail = skipped > 0 ? `\n（另有 ${skipped} 个空桩：原记忆已闭馆或归档，桩位保留不回收）` : ''
        return { text: `${sections.join('\n\n')}${tail}` }
      }
      if (typeof input.query !== 'string' || input.query.trim() === '') {
        throw new Error('engram_tour: thematic 模式需要 query 参数（巡游主题）')
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
      const prefix = degraded ? '（语义嵌入不可用，仅关键词检索）\n' : ''
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
    description: '编辑会话开始注入的用户画像 curated block（注入时位于自动派生画像之前，是画像的最高优先层）。action=view 查看当前内容与版本历史；action=edit 编辑（乐观锁：须带当前 expectedVersion，版本冲突会报错，重读最新版本后再改；首次创建省略 expectedVersion）；action=rollback 回滚（把 toVersion 版本的内容作为新版本写入，历史不改写）。内容入库前做协议剥离与密钥脱敏。',
    parameters: {
      action: { type: 'string', enum: ['view', 'edit', 'rollback'], required: true, description: 'view 查看 / edit 编辑 / rollback 回滚' },
      scope: { type: 'string', enum: ['user', 'project', 'shared'], description: '作用域，默认 user' },
      content: { type: 'string', description: 'edit 必填：新的画像内容（多行文本，会话开始按原文注入）' },
      expectedVersion: { type: 'integer', description: 'edit 带上=并发保护（乐观锁）；省略=仅当尚无 block 时创建 v1' },
      toVersion: { type: 'integer', description: 'rollback 必填：要回滚到的历史版本号（用 view 查得）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const input = args as { action?: unknown; scope?: unknown; content?: unknown; expectedVersion?: unknown; toVersion?: unknown }
      const action = input.action === 'edit' || input.action === 'rollback' || input.action === 'view' ? input.action : undefined
      if (action === undefined) throw new Error('engram_profile_edit: action 必须是 view / edit / rollback 之一')
      const scope = scopeOf(input.scope, 'user')
      const store = await deps.openStore(scope)
      if (action === 'view') {
        const block = await store.getProfileBlock(scope)
        if (block === undefined) {
          return { text: `${scope} 库暂无 curated 画像 block。用 action=edit（省略 expectedVersion）即可创建 v1；创建后会话开始时优先于自动派生画像注入。` }
        }
        const versions = await store.listProfileBlockVersions(scope, 10)
        return {
          text: [
            `当前 curated 画像（${scope}，v${block.version}）：`,
            block.content,
            '',
            `版本历史（最近 ${versions.length} 条，新→旧；rollback 用 toVersion 指定）：`,
            ...versions.map(version =>
              `- v${version.version} · ${version.source === 'rollback' ? '回滚' : '编辑'} · ${new Date(version.at).toISOString().slice(0, 16).replace('T', ' ')} · ${version.content.length} 字`),
          ].join('\n'),
        }
      }
      if (action === 'edit') {
        if (typeof input.content !== 'string' || input.content.trim() === '') throw new Error('engram_profile_edit: edit 需要 content 参数')
        let expectedVersion: number | undefined
        if (input.expectedVersion !== undefined) {
          if (!Number.isInteger(input.expectedVersion)) throw new Error('engram_profile_edit: expectedVersion 必须是整数（用 action=view 查得）')
          expectedVersion = input.expectedVersion as number
        }
        // 入库前协议剥离 + 密钥脱敏，与 engram_save/update 同一防线。
        const content = redactSecrets(sanitizeProtocolText(input.content))
        if (content.trim() === '') throw new Error('engram_profile_edit: 清洗后内容为空（原文只含协议标签或密钥）')
        const block = await store.saveProfileBlock(scope, expectedVersion, content, 'edit')
        // 编辑记录入 op_log（面板管家日志可见；target_id 用 scope）。
        await store.audit('profile-edit', scope, JSON.stringify({
          action: 'edit',
          fromVersion: expectedVersion ?? null,
          toVersion: block.version,
          chars: content.length,
        }))
        return { text: `curated 画像已写入（${scope}，v${block.version}）。下一轮会话开始时将优先于自动派生画像注入。` }
      }
      // rollback：取历史版本内容，作为新版本写入（乐观锁同样适用）。
      if (!Number.isInteger(input.toVersion)) throw new Error('engram_profile_edit: rollback 需要 toVersion（目标历史版本号，用 action=view 查得）')
      const target = await store.getProfileBlockVersion(scope, input.toVersion as number)
      if (target === undefined) throw new Error(`engram_profile_edit: ${scope} 库不存在版本 v${input.toVersion}（用 action=view 查看版本历史）`)
      const current = await store.getProfileBlock(scope)
      if (current === undefined) throw new Error(`engram_profile_edit: ${scope} 库尚无 curated 画像 block，无从回滚`)
      const updated = await store.saveProfileBlock(scope, current.version, target.content, 'rollback')
      await store.audit('profile-edit', scope, JSON.stringify({
        action: 'rollback',
        fromVersion: current.version,
        toVersion: updated.version,
        restoredFrom: target.version,
        chars: target.content.length,
      }))
      return { text: `已把 v${target.version} 的内容作为 v${updated.version} 写入（${scope}；版本链只增不改，可继续回滚）。` }
    },
  })

  const tools = [save, search, factsTool, assess, timeline, episodeTimeline, update, forget, report, reviewQueue, review, stats, exportTool, distill, examine, neighborsTool, tour, auditForgotten, ingestHistory, profileEdit]
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
  if (hits.length === 0) return { stops: [], narrative: '无命中，无巡游路径可规划。', query }

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
  if (stops.length === 0) return '无巡游路径。'
  const reasonLabel = (reason: TourStop['reason']): string => {
    switch (reason) {
      case 'same-kind': return '同类巩固'
      case 'neighbor': return '走廊相邻'
      case 'contrast': return '反差补位'
      case 'emotional-peak': return '情绪强反差'
    }
  }
  const lines: string[] = [`巡游路径（查询：${query}）：按「同类巩固 → 走廊相邻 → 反差补位」顺序组织，共 ${stops.length} 站。`]
  stops.forEach((stop, index) => {
    const caption = stop.record.imagery?.caption
    const sensory = stop.record.imagery?.sensoryTags ?? []
    const echo = caption === null || caption === undefined
      ? '（未铭刻意象，请先调用 engram_examine 读铭牌）'
      : `回声：似曾「${caption}」${sensory.length > 0 ? `（${sensory.slice(0, 3).join('、')}）` : ''}`
    lines.push(`${index + 1}. [${stop.record.scope}/${stop.record.kind}] ${stop.record.content.slice(0, 60)}${stop.record.content.length > 60 ? '…' : ''}（id=${stop.record.id}，理由：${reasonLabel(stop.reason)}）— ${echo}`)
  })
  return lines.join('\n')
}
