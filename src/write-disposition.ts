/**
 * 写入四态处置：engram_save 与自动摄取共用的入库前判定（ACCEPT / MERGE / DROP / DEFER）。
 * 判定以嵌入余弦与 kind 的纯规则为基底；可选注入 Jev 判断器（MemoryJudge）在 DEFER
 * 模糊带做自动裁决、对矛盾候选做建边前确认。Jev 不可用或判断失败时逐点静默降级回纯规则。
 * DROP（空内容 / 批内重复等低熵）由调用方按内容自身判定，本模块只负责需要库状态的三种。
 * 飞轮的负反馈环：复述不再堆新节点，而是强化既有条目；疑似矛盾不再静默丢弃，而是落库建边待裁决。
 * @module @kenz1117/dsh-engram/write-disposition
 */

import type { EngramKind, MemoryRecord } from './types.ts'
import type { EngramStore } from './store/interface.ts'
import { recordJevObservation } from './jev/observe.ts'

/** 写入处置四态。 */
export type WriteDisposition = 'accept' | 'merge' | 'drop' | 'defer'

/** 并入阈值：余弦 ≥ 该值且同 kind 视为同一事实的复述（与闭馆整理 mergeThreshold 默认值对齐）。 */
export const MERGE_COSINE = 0.92
/** 待定阈值：余弦 ≥ 该值且不满足 MERGE（相似度不足或跨 kind）视为疑似矛盾/修正，落库但建 contradicts 边待裁决（与矛盾候选门槛对齐）。 */
export const DEFER_COSINE = 0.88

/** 处置判定结果（DROP 不进此 union：它不依赖库状态，由调用方直接判）。 */
export type WriteDecision =
  | { readonly disposition: 'accept' }
  | { readonly disposition: 'merge'; readonly into: MemoryRecord; readonly similarity: number }
  | { readonly disposition: 'defer'; readonly neighbor: MemoryRecord; readonly similarity: number }

/** 判断问题：对状态文本的一个是否判断（对应 Jev Noul 原语）。 */
export interface JudgeQuestion {
  /** 问题标识，判断器按此键回填概率。 */
  readonly id: string
  /** 问题的自然语言描述（英文措辞；Jev 的中文判断弱于英文）。 */
  readonly instructions: string
}

/** 判断结果：问题 id → Noul 概率（0-1，数字即信念）。 */
export type JudgeAnswers = Readonly<Record<string, number>>

/**
 * 可选注入的记忆判断器（Jev System One 模型适配）。
 * 三阈值由装配方从 ResolvedJevConfig 落地；ask 失败抛错，由调用方逐点降级回纯规则。
 */
export interface MemoryJudge {
  /** 模糊带裁决：概率高于该值判「同一条」→ merge。 */
  readonly deferMergeAbove: number
  /** 模糊带裁决：概率低于该值判「确属不同条」→ 放行 accept。 */
  readonly deferAcceptBelow: number
  /** 矛盾确认：概率达到该值才建 contradicts 边。 */
  readonly contradictMinProbability: number
  /** 对 state 并行提问。 */
  ask(state: string, questions: readonly JudgeQuestion[]): Promise<JudgeAnswers>
}

/** decideWrite 的可选注入项：judge 与 content 同时提供时模糊带才走 Jev 裁决。 */
export interface DecideWriteOptions {
  /** Jev 判断器；undefined = 纯规则判定。 */
  readonly judge?: MemoryJudge
  /** 新内容原文；judge 裁决需要它与最近邻正文拼成对照 state。 */
  readonly content?: string
}

/**
 * 模糊带的 Jev 三路裁决。
 * @returns 高置信同 → merge；高置信异 → accept；低置信、答案缺失或 judge 抛错 → undefined（保持 defer）。
 */
async function resolveBand(
  judge: MemoryJudge,
  neighbor: MemoryRecord,
  similarity: number,
  kind: EngramKind,
  content: string,
): Promise<WriteDecision | undefined> {
  const startedAt = Date.now()
  try {
    const answers = await judge.ask(
      `Memory A:\n${neighbor.content}\n\nMemory B:\n${content}`,
      [{
        id: 'same_memory',
        instructions: `Are Memory A and Memory B the same fact, i.e. restatements of one identical statement (both are "${kind}" memories)? Answer true only for genuine restatements.`,
      }],
    )
    const p = answers['same_memory']
    recordJevObservation({
      at: startedAt,
      site: 'band',
      question: 'same_memory',
      answered: p !== undefined,
      probability: p,
      elapsedMs: Date.now() - startedAt,
      error: undefined,
      verdict: p === undefined
        ? 'fallback'
        : p >= judge.deferMergeAbove ? 'merge' : p <= judge.deferAcceptBelow ? 'accept' : 'defer',
    })
    if (p === undefined) return undefined
    if (p >= judge.deferMergeAbove) return { disposition: 'merge', into: neighbor, similarity }
    if (p <= judge.deferAcceptBelow) return { disposition: 'accept' }
    return undefined
  } catch (error) {
    // Jev 不可用（网络/超时/解析失败）：静默降级回纯规则 defer，不中断写入链路。
    recordJevObservation({
      at: startedAt,
      site: 'band',
      question: 'same_memory',
      answered: false,
      probability: undefined,
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      verdict: 'fallback',
    })
    return undefined
  }
}

/**
 * 判定一条新内容的处置。
 * 嵌入不可用 / 库内无向量条目 / 最近邻低于 DEFER_COSINE → accept；
 * 最近邻同 kind 且 ≥ MERGE_COSINE → merge；
 * 其余达到 DEFER_COSINE 的进模糊带：注入 judge 时自动裁决（高置信同 → merge、
 * 高置信异 → accept、低置信或失败 → defer）；未注入 judge → defer（纯规则原行为）。
 * @param store - 目标分库
 * @param kind - 新内容的记忆种类（MERGE 要求同 kind，跨 kind 高度相似按 defer 处理）
 * @param embedding - 新内容的向量；undefined = 嵌入不可用，直接 accept
 * @param options - 可选 judge 注入；judge 与 content 齐备时模糊带走自动裁决
 */
export async function decideWrite(
  store: EngramStore,
  kind: EngramKind,
  embedding: Float32Array | undefined,
  options: DecideWriteOptions = {},
): Promise<WriteDecision> {
  if (embedding === undefined) return { disposition: 'accept' }
  const nearest = await store.nearestNeighbor(embedding)
  if (nearest === undefined || nearest.similarity < DEFER_COSINE) return { disposition: 'accept' }
  if (nearest.similarity >= MERGE_COSINE && nearest.record.kind === kind) {
    return { disposition: 'merge', into: nearest.record, similarity: nearest.similarity }
  }
  const { judge, content } = options
  if (judge !== undefined && content !== undefined) {
    const verdict = await resolveBand(judge, nearest.record, nearest.similarity, kind, content)
    if (verdict !== undefined) return verdict
  }
  return { disposition: 'defer', neighbor: nearest.record, similarity: nearest.similarity }
}

/**
 * Jev 矛盾确认：对候选逐个问「真矛盾吗」，只保留概率达标的候选。
 * @param judge - Jev 判断器
 * @param incoming - 新写入内容原文
 * @param candidates - 矛盾候选（摄取链路的 defer 最近邻 / 工具链路的 findContradictions 结果）
 * @returns 达标候选数组；judge 抛错时返回 undefined，调用方按旧行为（全量建边）降级。
 */
export async function confirmContradictions(
  judge: MemoryJudge,
  incoming: string,
  candidates: readonly MemoryRecord[],
): Promise<readonly MemoryRecord[] | undefined> {
  try {
    const verdicts = await Promise.all(candidates.map(async candidate => {
      const startedAt = Date.now()
      try {
        const answers = await judge.ask(
          `Memory A:\n${candidate.content}\n\nMemory B:\n${incoming}`,
          [{
            id: 'contradicts',
            instructions: 'Do Memory A and Memory B state facts that cannot both be true at the same time (a genuine contradiction)?',
          }],
        )
        const p = answers['contradicts']
        recordJevObservation({
          at: startedAt,
          site: 'contradiction',
          question: 'contradicts',
          answered: p !== undefined,
          probability: p,
          elapsedMs: Date.now() - startedAt,
          error: undefined,
          verdict: p === undefined ? 'fallback' : p >= judge.contradictMinProbability ? 'confirm' : 'reject',
        })
        return p !== undefined && p >= judge.contradictMinProbability ? candidate : undefined
      } catch (error) {
        // 沿用原契约：任一候选失败即整个确认降级（全量建边）；先记观测再 rethrow。
        recordJevObservation({
          at: startedAt,
          site: 'contradiction',
          question: 'contradicts',
          answered: false,
          probability: undefined,
          elapsedMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          verdict: 'fallback',
        })
        throw error
      }
    }))
    return verdicts.filter(c => c !== undefined)
  } catch {
    // 失败候选的观测已在内层记录；此处按原契约整体降级（全量建边）。
    return undefined
  }
}

/**
 * MERGE 落地：强化既有条目（accessCount+1 / confidence+0.05）并记 write-merge 审计行。
 * @returns 强化后的既有条目；目标在并发窗口内被物理清除时抛错（loud，调用方按写入失败处理）。
 */
export async function applyMerge(
  store: EngramStore,
  decision: WriteDecision & { readonly disposition: 'merge' },
  content: string,
): Promise<MemoryRecord> {
  const note = JSON.stringify({ content: content.slice(0, 40), similarity: Number(decision.similarity.toFixed(4)) })
  const record = await store.reinforce(decision.into.id, note)
  if (record === undefined) throw new Error(`write-disposition: 并入目标 ${decision.into.id} 不存在`)
  return record
}
