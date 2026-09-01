/**
 * 知识飞轮的蒸馏步骤：把同主题的记忆簇由辅助 LLM 合并提炼为更高层的
 * skill/fact，被合并条目归档并逐条建立 supersedes 链，新条目继承簇内
 * 置信度均值。由 `engram_distill` 工具显式触发。
 * @module @kenz1117/dsh-engram/flywheel/distill
 */

import { parseJsonArray } from '../llm/client.ts'
import type { LlmRoute } from '../llm/client.ts'
import type { EngramEmbedder } from '../embedder/interface.ts'
import type { EngramStore } from '../store/interface.ts'
import type { EngramScope, MemoryId } from '../types.ts'
import { asMemoryId } from '../types.ts'

/** 蒸馏输入条数上限（协议内常量：单次辅助调用的可控上下文）。 */
const DISTILL_MAX_INPUT = 30
/** 蒸馏输出 token 上限。 */
const DISTILL_MAX_TOKENS = 900

const DISTILL_SYSTEM = [
  '下面是一组用户的长期记忆条目。把表达同一主题或可归纳为一条规律的若干条，合并提炼为更高层的一条。',
  '只输出一个 JSON 数组，每项形如 {"content": "提炼后的一句话规律", "kind": "skill或fact", "importance": 0到1, "supersedes": ["被合并条目的id", ...]}。',
  'supersedes 必须从输入给出的 id 中选取且每组至少 1 个；无法归并的条目不要输出。没有可归并的就输出 []。',
  '不要输出 JSON 以外的任何内容。',
].join('\n')

/** 蒸馏辅助调用的日志事件负载。 */
export interface DistillRequestEventData {
  readonly route: LlmRoute
  readonly scope: EngramScope
  readonly userText: string
  readonly maxTokens: number
}

/** 蒸馏结果摘要。 */
export interface DistillOutcome {
  /** 取材条目数。 */
  readonly input: number
  /** 蒸馏产物条数。 */
  readonly distilled: number
  /** 被归档的旧条目数。 */
  readonly superseded: number
}

/** 蒸馏依赖。 */
export interface DistillDeps {
  readonly store: EngramStore
  readonly embedder: EngramEmbedder | undefined
  readonly scope: EngramScope
  /** 辅助 LLM 调用（index.ts 用 ctx.llm.stream 构造）。 */
  readonly call: (params: { route: LlmRoute; system: string; userText: string; maxTokens: number; purpose: string; signal: AbortSignal }) => Promise<string>
  readonly logRequest: (data: DistillRequestEventData) => void
  readonly route: LlmRoute
  readonly signal: AbortSignal
}

/**
 * 执行一次蒸馏。
 * @returns 结果摘要；LLM/解析失败抛错（工具层报给模型），单组写入失败中断本次。
 */
export async function distillMemories(deps: DistillDeps): Promise<DistillOutcome> {
  const rows = await deps.store.topActive(deps.scope, DISTILL_MAX_INPUT)
  if (rows.length < 2) return { input: rows.length, distilled: 0, superseded: 0 }

  const lines = rows.map(record => `[${record.id}] (${record.kind}, importance ${record.importance.toFixed(2)}) ${record.content}`)
  const userText = `记忆条目：\n${lines.join('\n')}`
  deps.logRequest({ route: deps.route, scope: deps.scope, userText, maxTokens: DISTILL_MAX_TOKENS })
  const raw = await deps.call({
    route: deps.route,
    system: DISTILL_SYSTEM,
    userText,
    maxTokens: DISTILL_MAX_TOKENS,
    purpose: 'engram-distill',
    signal: deps.signal,
  })
  const parsed = parseJsonArray(raw)
  if (parsed === undefined || parsed.length === 0) return { input: rows.length, distilled: 0, superseded: 0 }

  const validIds = new Set(rows.map(record => String(record.id)))
  const byId = new Map(rows.map(record => [String(record.id), record]))
  let distilled = 0
  let superseded = 0
  for (const item of parsed) {
    const candidate = item as { content?: unknown; kind?: unknown; importance?: unknown; supersedes?: unknown }
    if (typeof candidate.content !== 'string' || candidate.content.trim() === '') continue
    if (!Array.isArray(candidate.supersedes) || candidate.supersedes.length === 0) continue
    // supersedes 必须全部来自本次取材且仍是 active（避免同批蒸馏相互归档后重复归档）。
    const oldIds: MemoryId[] = []
    for (const rawId of candidate.supersedes) {
      if (typeof rawId !== 'string' || !validIds.has(rawId)) continue
      const row = await deps.store.get(asMemoryId(rawId))
      if (row !== undefined && row.status === 'active') oldIds.push(asMemoryId(rawId))
    }
    if (oldIds.length === 0) continue
    const kind = candidate.kind === 'skill' || candidate.kind === 'fact' ? candidate.kind : 'skill'
    const importance = typeof candidate.importance === 'number' && Number.isFinite(candidate.importance)
      ? Math.min(1, Math.max(0, candidate.importance))
      : 0.7
    // 置信度继承簇内均值；向量继承簇内平均（嵌入可用时）。
    const confidences = oldIds
      .map(oldId => byId.get(String(oldId))?.confidence ?? 0.5)
      .filter(value => value > 0)
    const confidence = confidences.length === 0 ? 0.5 : confidences.reduce((sum, value) => sum + value, 0) / confidences.length
    let embedding: Float32Array | undefined
    if (deps.embedder !== undefined) {
      const vectors: Float32Array[] = []
      for (const oldId of oldIds) {
        const vector = (await deps.embedder.embed([byId.get(String(oldId))?.content ?? '']))[0]
        if (vector !== undefined) vectors.push(vector)
      }
      if (vectors.length > 0) {
        const average = new Float32Array(vectors[0]!.length)
        for (const vector of vectors) {
          for (let i = 0; i < vector.length; i++) average[i] = (average[i] ?? 0) + vector[i]! / vectors.length
        }
        embedding = average
      }
    }
    await deps.store.supersedeMany(
      {
        scope: deps.scope,
        kind,
        content: candidate.content.trim(),
        importance,
        confidence,
        ...(embedding === undefined ? {} : { embedding }),
      },
      oldIds,
    )
    distilled += 1
    superseded += oldIds.length
  }
  return { input: rows.length, distilled, superseded }
}
