/**
 * 9 个 engram_ 工具的定义与执行器。工具 schema 保持窄参数；
 * scope 决定读写哪个分库；嵌入缺失时检索结果显式标记降级。
 * @module @kenz1117/dsh-engram/tools/create
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { distillMemories } from '../flywheel/distill.ts'
import type { EngramEmbedder } from '../embedder/interface.ts'
import { routeFromEvents } from '../llm/client.ts'
import type { LlmRoute } from '../llm/client.ts'
import type { EngramStore } from '../store/interface.ts'
import type { EngramKind, EngramScope } from '../types.ts'

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
 * 构造 9 个工具定义（engram_save/search/timeline/update/forget/review/stats/export/distill）。
 * @param deps - 分库打开器、嵌入器、辅助 LLM、导出目录。
 * @returns 可直接 register 的工具定义数组。
 */
export function createEngramTools(deps: ToolDeps): ToolDefinition[] {
  const save = defineTool({
    name: 'engram_save',
    description: '保存一条长期记忆（跨会话可用）。kind：fact 事实 / preference 偏好 / decision 决策 / episode 经历 / skill 方法。scope：project 仅当前项目，user 全局。',
    parameters: {
      content: { type: 'string', required: true, description: '记忆正文，一句话完整表达' },
      kind: { type: 'string', enum: [...KINDS], required: true, description: '记忆种类' },
      scope: { type: 'string', enum: ['user', 'project'], description: '作用域，默认 project' },
      importance: { type: 'number', description: '重要性 0-1，默认 0.5' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true },
        kind: { type: 'string', required: true },
        importance: { type: 'number', required: true },
      } },
      render: (_args, value) => [{
        type: 'text',
        text: `已保存记忆 ${value.id}（kind=${value.kind}, importance=${value.importance}）。后续会话可用 engram_search 召回。`,
      }],
    },
    async execute(args, exec) {
      const input = args as { content: string; kind: EngramKind; scope?: unknown; importance?: number }
      const scope = scopeOf(input.scope, 'project')
      const store = await deps.openStore(scope)
      const embedder = await deps.embedder
      const embeddings = embedder === undefined ? undefined : await embedder.embed([input.content.trim()])
      const record = await store.write({
        scope,
        kind: input.kind,
        content: input.content,
        ...(input.importance === undefined ? {} : { importance: input.importance }),
        sourceSessionId: exec.agent?.id ?? null,
        ...(embeddings === undefined ? {} : { embedding: embeddings[0] }),
      })
      // 写入时矛盾检测：高相似近邻建 contradicts 边并在结果中报告候选，由模型/用户裁决。
      if (embeddings?.[0] !== undefined) {
        const candidates = await store.findContradictions(embeddings[0])
        for (const candidate of candidates) {
          await store.linkEdge(record.id, candidate.id, 'contradicts')
        }
        if (candidates.length > 0) {
          const listed = candidates.map(candidate => `「${candidate.content}」（id=${candidate.id}）`).join('；')
          return {
            id: record.id,
            kind: record.kind,
            importance: record.importance,
            text: `已保存 ${record.id}。注意：与现有记忆高度相似——${listed}。若这是修正而非新事实，请用 engram_update 归并，或 engram_forget 去重。`,
          }
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
    async execute(args) {
      const input = args as { query: string; scope?: unknown; limit?: number }
      const scopes = scopesOf(input.scope)
      const limit = input.limit ?? 8
      const vector = await queryVectorOf(deps, input.query)
      const results = await Promise.all(scopes.map(async (scope) => {
        const store = await deps.openStore(scope)
        return store.search({ text: input.query, scopes: [scope], limit }, vector)
      }))
      const merged = results
        .flatMap(result => result.hits)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
      const degraded = results.some(result => result.degraded)
      const lines = merged.map((hit, index) => {
        const edge = hit.viaEdge === undefined ? '' : `（经 ${hit.viaEdge.type} 关联自 ${hit.viaEdge.from}）`
        return `${index + 1}. [${hit.record.scope}/${hit.record.kind}] ${hit.record.content}（id=${hit.record.id}）${edge}`
      })
      const prefix = degraded && lines.length > 0 ? '（语义嵌入不可用，仅关键词检索）\n' : ''
      return { degraded, text: `${prefix}${lines.join('\n') || '无命中'}` }
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
      return {
        text: rows.map(record =>
          `${new Date(record.createdAt).toISOString()} [${record.scope}/${record.kind}] ${record.content}（id=${record.id}）`)
          .join('\n') || '时间线为空',
      }
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
      const scope = scopeOf(input.scope, 'project')
      const store = await deps.openStore(scope)
      const old = await store.get(input.id as never)
      if (old === undefined) throw new Error(`engram_update: 条目 ${input.id} 不存在于 ${scope} 库（用 engram_search 确认 id 与 scope）`)
      const embedder = await deps.embedder
      const embeddings = embedder === undefined ? undefined : await embedder.embed([input.content.trim()])
      const record = await store.update({
        id: input.id as never,
        scope,
        kind: input.kind ?? old.kind,
        content: input.content,
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
      return {
        text: [
          `内容: ${record.content}`,
          `属性: kind=${record.kind}, scope=${record.scope}, status=${record.status}, importance=${record.importance}, confidence=${record.confidence}, 访问 ${record.accessCount} 次`,
          `来源: ${source}`,
          section('被谁取代', view.supersededBy.map(String)),
          section('取代了谁', view.supersedes.map(String)),
          section('矛盾候选', view.contradicts.map(String)),
          section('关联', view.related.map(String)),
          view.operations.length === 0 ? '' : `\n最近操作:\n${view.operations.map(op => `- ${new Date(op.at).toISOString()} ${op.op}${op.detail === null ? '' : ` ${op.detail}`}`).join('\n')}`,
        ].filter(part => part !== '').join('\n'),
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
