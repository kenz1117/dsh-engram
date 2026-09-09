/**
 * 9 个 engram_ 工具的定义与执行器。工具 schema 保持窄参数；
 * scope 决定读写哪个分库；嵌入缺失时检索结果显式标记降级。
 * @module @kenz1117/dsh-engram/tools/create
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { distillMemories } from '../flywheel/distill.ts'
import type { EngramEmbedder } from '../embedder/interface.ts'
import { parseJsonArray, routeFromEvents } from '../llm/client.ts'
import type { LlmRoute } from '../llm/client.ts'
import type { EngramStore } from '../store/interface.ts'
import type { EngramKind, EngramScope } from '../types.ts'
import { renderMemoryPacket, sanitizeProtocolText } from '../security/sanitize.ts'
import { redactSecrets } from '../security/redact.ts'
import {
  MAX_REWRITE_QUERIES, REWRITE_MAX_TOKENS, REWRITE_SYSTEM, RRF_CONSTANT,
  mergeQueryResults, normalizeRewriteQueries,
} from '../retrieve/rewrite.ts'

/** 工具依赖：分库打开器、嵌入器承诺、辅助 LLM 调用与导出目录。 */
export interface ToolDeps {
  /** 每次调用解析目标 scope 的分库（user/project 各一）。 */
  readonly openStore: (scope: EngramScope) => Promise<EngramStore>
  /** 嵌入器承诺；undefined = 嵌入不可用，检索降级纯关键词、矛盾检测停用。 */
  readonly embedder: Promise<EngramEmbedder | undefined>
  /** 辅助 LLM 调用（index.ts 用 ctx.llm.stream 构造）；undefined = distill 不可用。sessionId 由调用点补齐。 */
  readonly call: ((params: { route: LlmRoute; system: string; userText: string; maxTokens: number; purpose: string; signal: AbortSignal; sessionId: string | undefined }) => Promise<string>) | undefined
  /** 显式路由覆盖（Config provider+model）；缺省从会话日志解析。 */
  readonly routeOverride: LlmRoute | undefined
  /** 是否启用检索查询改写（Config queryRewrite）；false 时 engram_search 直接单查询。 */
  readonly queryRewrite: boolean
  /** 导出文件目录（engram_export 写入）。 */
  readonly exportDir: string
}

const KINDS = ['fact', 'preference', 'decision', 'episode', 'skill'] as const

/** 从模型参数收敛 scope（非法值或缺失回退 fallback）。 */
function scopeOf(raw: unknown, fallback: EngramScope): EngramScope {
  return raw === 'user' || raw === 'project' ? raw : fallback
}

/** 把 search scope 参数收敛为分库集合。 */
function scopesOf(raw: unknown): EngramScope[] {
  if (raw === 'user') return ['user']
  if (raw === 'project') return ['project']
  return ['user', 'project']
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
  const events = (exec.agent?.session?.events ?? []) as unknown as Parameters<typeof routeFromEvents>[0]
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
 * 构造 9 个工具定义（engram_save/search/timeline/update/forget/review/stats/export/distill）。
 * @param deps - 分库打开器、嵌入器、辅助 LLM、导出目录。
 * @returns 可直接 register 的工具定义数组。
 */
export function createEngramTools(deps: ToolDeps): ToolDefinition[] {
  /** 批量保存上限（协议内常量：与单轮摄取候选量级对齐，防一次灌入过多）。 */
  const MAX_SAVE_BATCH = 10

  /** engram_save 输出视图（schema 放宽后单条/批量字段均可能缺席）。 */
  interface SaveResultView {
    readonly id?: string
    readonly kind?: string
    readonly importance?: number
    /** 单条矛盾警告文本（execute 生成，render 优先呈现）。 */
    readonly text?: string
    /** 批量模式：成功条数。 */
    readonly count?: number
    /** 批量模式：成功条目。 */
    readonly items?: readonly { id: string; kind: string; importance: number }[]
    /** 批量模式：失败条目（index 为 items 数组下标）。 */
    readonly failed?: readonly { index: number; reason: string }[]
  }

  /** engram_save 呈现文本：矛盾警告 text 优先；批量输出汇总成功与失败。 */
  function renderSaveResultText(value: SaveResultView): string {
    if (value.count !== undefined) {
      const parts = [`已批量保存 ${value.count} 条记忆`]
      for (const item of value.items ?? []) {
        parts.push(`${item.id}（kind=${item.kind}, importance=${item.importance}）`)
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

  /** 写入单条已清洗内容并按嵌入建矛盾边；返回记录与矛盾候选（调用方决定呈现）。 */
  async function writeWithContradictions(
    store: EngramStore,
    item: {
      scope: EngramScope
      kind: EngramKind
      content: string
      importance?: number
      sourceSessionId: string | null
      embedding?: Float32Array
    },
  ): Promise<{ record: Awaited<ReturnType<EngramStore['write']>>; candidates: Awaited<ReturnType<EngramStore['findContradictions']>> }> {
    const { embedding } = item
    const record = await store.write({
      scope: item.scope,
      kind: item.kind,
      content: item.content,
      ...(item.importance === undefined ? {} : { importance: item.importance }),
      sourceSessionId: item.sourceSessionId,
      ...(embedding === undefined ? {} : { embedding }),
    })
    const candidates = embedding === undefined ? [] : await store.findContradictions(embedding)
    for (const candidate of candidates) {
      await store.linkEdge(record.id, candidate.id, 'contradicts')
    }
    return { record, candidates }
  }

  /** 批量保存结果（输出 schema 的运行时形状）。 */
  interface SaveBatchResult {
    readonly count: number
    readonly items: { id: string; kind: string; importance: number }[]
    readonly failed: { index: number; reason: string }[]
  }

  /** 批量保存：统一清洗/校验/批量内去重，一次批量嵌入，逐条写入；单条失败不阻塞其余。 */
  async function saveBatch(sourceSessionId: string | null, items: readonly unknown[], rawScope: unknown): Promise<SaveBatchResult> {
    if (items.length > MAX_SAVE_BATCH) throw new Error(`engram_save: 单次最多保存 ${MAX_SAVE_BATCH} 条`)
    const scope = scopeOf(rawScope, 'project')
    const store = await deps.openStore(scope)
    const embedder = await deps.embedder
    // 第一步：清洗 + 校验 + 批量内去重（失败按原始下标收集，不阻塞其余）。
    const prepared: { index: number; content: string; kind: EngramKind; importance: number | undefined }[] = []
    const failed: { index: number; reason: string }[] = []
    const seen = new Set<string>()
    for (const [index, raw] of items.entries()) {
      if (raw === null || typeof raw !== 'object') { failed.push({ index, reason: '条目必须是对象' }); continue }
      const candidate = raw as { content?: unknown; kind?: unknown; importance?: unknown }
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
      })
    }
    // 第二步：一次批量嵌入（对齐清洗后条目顺序）。
    const vectors = embedder === undefined || prepared.length === 0
      ? undefined
      : await embedder.embed(prepared.map(item => item.content.trim()))
    // 第三步：逐条写入；单条失败记入 failed 不阻塞其余（矛盾边照建，可经 engram_review 查看）。
    const saved: { id: string; kind: string; importance: number }[] = []
    for (const [position, item] of prepared.entries()) {
      try {
        const embedding = vectors?.[position]
        const { record } = await writeWithContradictions(store, {
          scope,
          kind: item.kind,
          content: item.content,
          ...(item.importance === undefined ? {} : { importance: item.importance }),
          sourceSessionId,
          ...(embedding === undefined ? {} : { embedding }),
        })
        saved.push({ id: record.id, kind: record.kind, importance: record.importance })
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
      items: {
        type: 'array',
        description: '批量保存条目数组，每项 {content, kind, importance?}；与 content/kind 二选一',
        items: { type: 'object', additionalProperties: false, properties: {
          content: { type: 'string', required: true, description: '记忆正文' },
          kind: { type: 'string', enum: [...KINDS], required: true, description: '记忆种类' },
          importance: { type: 'number', description: '重要性 0-1' },
        } },
      },
      scope: { type: 'string', enum: ['user', 'project'], description: '作用域，默认 project' },
      importance: { type: 'number', description: '重要性 0-1，默认 0.5（仅单条模式）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string' },
        kind: { type: 'string' },
        importance: { type: 'number' },
        text: { type: 'string' },
        count: { type: 'number' },
        items: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
          id: { type: 'string', required: true },
          kind: { type: 'string', required: true },
          importance: { type: 'number', required: true },
        } } },
        failed: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
          index: { type: 'number', required: true },
          reason: { type: 'string', required: true },
        } } },
      } },
      render: (_args, value) => [{ type: 'text', text: renderSaveResultText(value as SaveResultView) }],
    },
    async execute(args, exec) {
      const input = args as { content?: unknown; kind?: unknown; items?: unknown; scope?: unknown; importance?: unknown }
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
      const { record, candidates } = await writeWithContradictions(store, {
        scope,
        kind: input.kind as EngramKind,
        content,
        ...(typeof input.importance === 'number' ? { importance: input.importance } : {}),
        sourceSessionId,
        ...(embeddings?.[0] === undefined ? {} : { embedding: embeddings[0] }),
      })
      // 写入时矛盾检测：高相似近邻建 contradicts 边并在结果中报告候选，由模型/用户裁决。
      if (candidates.length > 0) {
        const listed = candidates.map(candidate => `「${candidate.content}」（id=${candidate.id}）`).join('；')
        return {
          id: record.id,
          kind: record.kind,
          importance: record.importance,
          text: `已保存 ${record.id}。注意：与现有记忆高度相似——${listed}。若这是修正而非新事实，请用 engram_update 归并，或 engram_forget 去重。`,
        }
      }
      return { id: record.id, kind: record.kind, importance: record.importance }
    },
  })

  const search = defineTool({
    name: 'engram_search',
    description: '语义 + 关键词混合检索长期记忆。user 作用域存偏好与通用事实，project 作用域存项目约定与决策。结果行尾给出 id，供 engram_update/engram_forget 引用。',
    parameters: {
      query: { type: 'string', required: true, description: '检索文本' },
      scope: { type: 'string', enum: ['user', 'project', 'all'], description: '作用域，默认 all' },
      limit: { type: 'number', description: '返回条数上限，默认 8' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        degraded: { type: 'boolean', required: true },
        text: { type: 'string', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const input = args as { query: string; scope?: unknown; limit?: number }
      const scopes = scopesOf(input.scope)
      const limit = input.limit ?? 8
      // 多查询改写：辅助 LLM 可用时生成 ≤3 个互补查询分别检索后 RRF 融合；
      // 失败/不可用降级原查询单查。多查询会对同一 id 重复命中强化（accessCount、
      // confidence 增长更快），语义上确为多次命中，属已知代价。
      const rewrite = await rewriteQueries(deps, exec, input.query)
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
      const lines = merged.map((hit, index) => {
        const edge = hit.viaEdge === undefined ? '' : `（经 ${hit.viaEdge.type} 关联自 ${hit.viaEdge.from}）`
        return `${index + 1}. [${hit.record.scope}/${hit.record.kind}] ${hit.record.content}（id=${hit.record.id}）${edge}`
      })
      const prefix = degraded && lines.length > 0 ? '（语义嵌入不可用，仅关键词检索）\n' : ''
      // 输出包协议标签：记忆正文是不可信历史上下文，当前请求为检索词本身。
      return { degraded, text: renderMemoryPacket(`${prefix}${lines.join('\n') || '无命中'}`, 'tool_search', input.query) }
    },
  })

  const timeline = defineTool({
    name: 'engram_timeline',
    description: '按时间范围与主题浏览记忆（时间倒序，最近 20 条）。无参数直接列出最近记录。',
    parameters: {
      scope: { type: 'string', enum: ['user', 'project', 'all'], description: '作用域，默认 all' },
      topic: { type: 'string', description: '主题子串' },
      since: { type: 'string', description: '起始时间（ISO 或可解析日期）' },
      until: { type: 'string', description: '结束时间' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const input = args as { scope?: unknown; topic?: string; since?: string; until?: string }
      const scopes = scopesOf(input.scope)
      const parseTime = (raw: string | undefined, field: string): number | undefined => {
        if (raw === undefined) return undefined
        const ms = Date.parse(raw)
        if (Number.isNaN(ms)) throw new Error(`engram_timeline: ${field} 不是可解析时间 ${raw}`)
        return ms
      }
      const since = parseTime(input.since, 'since')
      const until = parseTime(input.until, 'until')
      const rows = (await Promise.all(scopes.map(async (scope) => {
        const store = await deps.openStore(scope)
        return store.timeline({
          scopes: [scope],
          ...(input.topic === undefined ? {} : { topic: input.topic }),
          ...(since === undefined ? {} : { since }),
          ...(until === undefined ? {} : { until }),
          limit: 20,
        })
      }))).flat().sort((a, b) => b.createdAt - a.createdAt).slice(0, 20)
      // 输出包协议标签：记忆正文是不可信历史上下文；timeline 无查询参数，当前请求以占位句代替。
      const body = rows.map(record =>
        `${new Date(record.createdAt).toISOString()} [${record.scope}/${record.kind}] ${record.content}（id=${record.id}）`)
        .join('\n') || '时间线为空'
      return { text: renderMemoryPacket(body, 'tool_timeline', input.topic ?? '（对话继续）') }
    },
  })

  const update = defineTool({
    name: 'engram_update',
    description: '修正一条记忆：写入新条目并把旧条目标记为被取代（链条保留，可审计）。id 来自 engram_search 结果。',
    parameters: {
      id: { type: 'string', required: true, description: '要修正的旧条目 id' },
      content: { type: 'string', required: true, description: '修正后的正文' },
      scope: { type: 'string', enum: ['user', 'project'], description: '旧条目作用域，默认 project' },
      kind: { type: 'string', enum: [...KINDS], description: '种类，默认继承旧条目' },
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
      const input = args as { id: string; content: string; scope?: unknown; kind?: EngramKind }
      // 入库前协议剥离 + 密钥脱敏，与 engram_save 同一防线。
      const content = redactSecrets(sanitizeProtocolText(input.content))
      if (content.trim() === '') throw new Error('engram_update: 清洗后内容为空（原文只含协议标签或密钥）')
      const scope = scopeOf(input.scope, 'project')
      const store = await deps.openStore(scope)
      const old = await store.get(input.id as never)
      if (old === undefined) throw new Error(`engram_update: 条目 ${input.id} 不存在于 ${scope} 库（用 engram_search 确认 id 与 scope）`)
      const embedder = await deps.embedder
      const embeddings = embedder === undefined ? undefined : await embedder.embed([content.trim()])
      const record = await store.update({
        id: input.id as never,
        scope,
        kind: input.kind ?? old.kind,
        content,
        ...(embeddings === undefined ? {} : { embedding: embeddings[0] }),
      })
      return { id: record.id, superseded: input.id }
    },
  })

  const forget = defineTool({
    name: 'engram_forget',
    description: '遗忘一条记忆（软删，用户可从库中恢复）。id 与 scope 来自 engram_search 结果。',
    parameters: {
      id: { type: 'string', required: true, description: '条目 id' },
      scope: { type: 'string', enum: ['user', 'project'], description: '条目作用域，默认 project' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: `记忆 ${value.id} 已遗忘（软删，可恢复）。` }],
    },
    async execute(args) {
      const input = args as { id: string; scope?: unknown }
      const scope = scopeOf(input.scope, 'project')
      const store = await deps.openStore(scope)
      const record = await store.forget(input.id as never)
      return { id: record.id }
    },
  })

  const review = defineTool({
    name: 'engram_review',
    description: '审计一条记忆：查看内容、来源（会话/轮次/事件）、取代链、矛盾与关联，以及最近操作日志。',
    parameters: {
      id: { type: 'string', required: true, description: '条目 id' },
      scope: { type: 'string', enum: ['user', 'project'], description: '条目作用域，默认 project' },
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
          view.operations.length === 0 ? '' : `\n最近操作:\n${view.operations.map(op => `- ${new Date(op.at).toISOString()} ${op.op}${op.detail === null ? '' : ` ${op.detail}`}`).join('\n')}`,
        ].filter(part => part !== '').join('\n'), 'tool_review', '（对话继续）'),
      }
    },
  })

  const stats = defineTool({
    name: 'engram_stats',
    description: '记忆库统计：各状态与种类数量、关系边数、信噪比、操作日志量。scope=all 时合并两库。',
    parameters: {
      scope: { type: 'string', enum: ['user', 'project', 'all'], description: '作用域，默认 all' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const input = args as { scope?: unknown }
      const scopes = scopesOf(input.scope)
      const all = await Promise.all(scopes.map(async (scope) => ({
        scope,
        stats: await (await deps.openStore(scope)).stats(),
      })))
      const text = all.map(({ scope, stats }) => [
        `[${scope}] 总数 ${stats.total}（active ${stats.active} / archived ${stats.archived} / forgotten ${stats.forgotten}）`,
        `种类分布: ${Object.entries(stats.byKind).map(([kind, count]) => `${kind}=${count}`).join(', ') || '空'}`,
        `关系边 ${stats.edges} 条 · 信噪比 ${(stats.signalRatio * 100).toFixed(1)}% · 操作日志 ${stats.opLogCount} 条`,
      ].join('\n')).join('\n\n')
      return { text }
    },
  })

  const exportTool = defineTool({
    name: 'engram_export',
    description: '把记忆库导出为文件（Markdown 或 JSON，含全部状态与关系边），返回文件路径。数据可携带。',
    parameters: {
      format: { type: 'string', enum: ['markdown', 'json'], description: '导出格式，默认 markdown' },
      scope: { type: 'string', enum: ['user', 'project', 'all'], description: '作用域，默认 all' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const input = args as { format?: unknown; scope?: unknown }
      const format = input.format === 'json' ? 'json' : 'markdown'
      const scopes = scopesOf(input.scope)
      await mkdir(deps.exportDir, { recursive: true, mode: 0o700 })
      const written: string[] = []
      for (const scope of scopes) {
        const data = await (await deps.openStore(scope)).exportAll()
        const stamp = new Date().toISOString().replaceAll(':', '-')
        const path = join(deps.exportDir, `engram-${scope}-${stamp}.${format === 'json' ? 'json' : 'md'}`)
        const body = format === 'json'
          ? JSON.stringify(data, null, 2)
          : [
              `# dsh-engram 导出（${scope}）`,
              '',
              ...data.records.map(record =>
                `- [${record.status}/${record.kind}] ${record.content}（id=${record.id}，importance ${record.importance}）`),
              '',
              '## 关系边',
              ...data.edges.map(edge => `- ${edge.from} --${edge.type}--> ${edge.to}`),
              '',
            ].join('\n')
        await writeFile(path, body, { mode: 0o600 })
        written.push(`${path}（${data.records.length} 条记忆，${data.edges.length} 条边）`)
      }
      return { text: `已导出:\n${written.join('\n')}` }
    },
  })

  const distill = defineTool({
    name: 'engram_distill',
    description: '蒸馏整理：把同主题的记忆簇合并提炼为更高层的规律（旧条目归档、supersedes 链保留）。建议记忆较多时周期性执行。',
    parameters: {
      scope: { type: 'string', enum: ['user', 'project'], description: '作用域，默认 user' },
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
      const events = (exec.agent?.session?.events ?? []) as unknown as Parameters<typeof routeFromEvents>[0]
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

  return [save, search, timeline, update, forget, review, stats, exportTool, distill]
}
