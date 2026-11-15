/**
 * 知识飞轮的蒸馏步骤：把同主题的记忆簇由辅助 LLM 合并提炼为更高层的
 * skill/fact，被合并条目归档并逐条建立 supersedes 链，新条目继承簇内
 * 置信度均值。由 `engram_distill` 工具显式触发。
 * @module @kenz1117/dsh-engram/flywheel/distill
 */

import { isMaxTokensError, parseJsonArray } from '../llm/client.ts'
import type { LlmRoute } from '../llm/client.ts'
import type { EngramEmbedder } from '../embedder/interface.ts'
import type { EngramStore } from '../store/interface.ts'
import type { EngramScope, MemoryId, MemoryRecord } from '../types.ts'
import { asMemoryId } from '../types.ts'
import { message } from '../i18n/messages.ts'

/** 蒸馏输入条数上限（协议内常量：单次蒸馏的可控取材窗口）。 */
const DISTILL_MAX_INPUT = 30
/** 每批进一次辅助调用的条数上限（#55：30 条一次调用必然顶穿输出预算，蒸馏整次失败）。 */
const DISTILL_BATCH = 10
/** 蒸馏输出 token 上限。 */
const DISTILL_MAX_TOKENS = 900

/**
 * Системная инструкция дистилляции: текст живёт в словаре (`llm.distillSystem`),
 * берётся в момент вызова — язык становится известен только при сборке плагина.
 */
function distillSystemPrompt(): string {
  return message('llm.distillSystem')
}

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
  /** 带向量写进去的产物数。 */
  readonly vectorsAttached: number
  /** 未带向量写进去的产物数（嵌入器当时不可用）：这些条目将来会让库要求修复。 */
  readonly vectorsWithout: number
  /**
   * 取材但因本批输出超预算（对半到单片仍超限）或解析失败未能提炼的条数（#55 失败可见性）。
   * 这些条目保持 active，下次蒸馏仍会取材。
   */
  readonly failed: number
}

/**
 * 单批蒸馏的确定性失败（#55 分批自愈的内部信号）：max-tokens 由调用层对半递归重试，
 * unparseable 由调用层把整批计入 failed。网络等瞬时错误不用它承载、原样上抛
 * （整批失败仍由 distillMemories 抛给工具层报给模型）。
 */
class DistillBatchFailure extends Error {
  constructor(readonly reason: 'unparseable' | 'max-tokens') {
    super('distill-batch-failure')
    this.name = 'DistillBatchFailure'
  }
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
 * 执行一次蒸馏。取材按 DISTILL_BATCH 分批依次过辅助 LLM（#55：库稍大时整份计划
 * 必然顶穿输出预算、蒸馏整次失败，整理永不发生）；单批输出超预算对半递归重试，
 * 切到单片仍超限或解析失败只丢该批（计入 failed，不再空烧整次）。网络等瞬时错误
 * 原样上抛（工具层报给模型），单组写入失败中断本次。
 * @returns 结果摘要。
 */
export async function distillMemories(deps: DistillDeps): Promise<DistillOutcome> {
  const rows = await deps.store.topActive(deps.scope, DISTILL_MAX_INPUT)
  if (rows.length < 2) return { input: rows.length, distilled: 0, superseded: 0, vectorsAttached: 0, vectorsWithout: 0, failed: 0 }

  // 对外字段 readonly；函数内用 satisfies 保留可变字面量类型做累加，返回时结构兼容只读接口。
  const outcome = {
    input: rows.length, distilled: 0, superseded: 0, vectorsAttached: 0, vectorsWithout: 0, failed: 0,
  } satisfies DistillOutcome

  /**
   * 单批蒸馏：组装 → 调用 → 解析 → 逐项校验落库。输出超预算抛
   * DistillBatchFailure('max-tokens') 供上层对半递归；解析失败抛
   * DistillBatchFailure('unparseable') 由上层把整批计入 failed。LLM 只见过本批的
   * id，validIds/byId 也只覆盖本批：跨批 supersedes 引用一律无效。
   */
  const applyBatch = async (batch: readonly MemoryRecord[]): Promise<void> => {
    const lines = batch.map(record => `[${record.id}] (${record.kind}, importance ${record.importance.toFixed(2)}) ${record.content}`)
    const userText = `${message('llm.distillUserPrompt')}\n${lines.join('\n')}`
    deps.logRequest({ route: deps.route, scope: deps.scope, userText, maxTokens: DISTILL_MAX_TOKENS })
    let raw: string
    try {
      raw = await deps.call({
        route: deps.route,
        system: distillSystemPrompt(),
        userText,
        maxTokens: DISTILL_MAX_TOKENS,
        purpose: 'engram-distill',
        signal: deps.signal,
      })
    } catch (error) {
      // 输出超预算（finishError 的 LLM_MAX_TOKENS）归一为分批信号交上层对半递归；
      // 网络等瞬时错误原样上抛（整批失败由调用层报给模型）。
      if (isMaxTokensError(error)) throw new DistillBatchFailure('max-tokens')
      throw error
    }
    const parsed = parseJsonArray(raw)
    // 空数组是合法回答（LLM 判定无可合并簇）；解析不出数组才算本批失败——比旧实现
    // 的「一批乱输出就放弃全部取材」严格更好：其余批次照常蒸馏。
    if (parsed === undefined) throw new DistillBatchFailure('unparseable')

    const validIds = new Set(batch.map(record => String(record.id)))
    const byId = new Map(batch.map(record => [String(record.id), record]))
    // Вектор считается и тогда, когда продукт пишется без него: «дистилляция прошла, а
    // база потом попросит починки» — это факт, который человек должен видеть сразу, а не
    // находить через сутки в карточке обслуживания (случилось 22.10).
    for (const item of parsed) {
      const candidate = item as { content?: unknown; kind?: unknown; importance?: unknown; supersedes?: unknown }
      if (typeof candidate.content !== 'string' || candidate.content.trim() === '') continue
      if (!Array.isArray(candidate.supersedes) || candidate.supersedes.length === 0) continue
      // supersedes 必须全部来自本批取材且仍是 active（避免同批蒸馏相互归档后重复归档）。
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
      outcome.distilled += 1
      outcome.superseded += oldIds.length
      if (embedding === undefined) outcome.vectorsWithout += 1
      else outcome.vectorsAttached += 1
    }
  }

  /**
   * 单批失败自愈（#55）：输出超预算对半递归重试（两半各自独立调用——合回同一请求体积
   * 几乎不减、必然再超限）；切到单片仍超限则该条计入 failed（保持 active，下次蒸馏
   * 再次取材）；解析失败整批计入 failed；其余错误原样上抛。
   */
  const runBatch = async (batch: readonly MemoryRecord[]): Promise<void> => {
    try {
      await applyBatch(batch)
      return
    } catch (error) {
      if (!(error instanceof DistillBatchFailure)) throw error
      if (error.reason === 'unparseable') {
        outcome.failed += batch.length
        return
      }
    }
    if (batch.length <= 1) {
      // 切到单片仍超输出预算：放弃该条。
      outcome.failed += batch.length
      return
    }
    const mid = Math.ceil(batch.length / 2)
    await runBatch(batch.slice(0, mid))
    await runBatch(batch.slice(mid))
  }

  for (let start = 0; start < rows.length; start += DISTILL_BATCH) {
    await runBatch(rows.slice(start, start + DISTILL_BATCH))
  }
  return outcome
}
