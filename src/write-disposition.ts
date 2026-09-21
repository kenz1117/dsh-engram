/**
 * 写入四态处置：engram_save 与自动摄取共用的入库前判定（ACCEPT / MERGE / DROP / DEFER）。
 * 判定只用嵌入余弦与 kind，纯代码无 LLM 调用；DROP（空内容 / 批内重复等低熵）由调用方
 * 按内容自身判定，本模块只负责需要库状态的三种。飞轮的负反馈环：复述不再堆新节点，
 * 而是强化既有条目；疑似矛盾不再静默丢弃，而是落库建边待裁决。
 * @module @kenz1117/dsh-engram/write-disposition
 */

import type { EngramKind, MemoryRecord } from './types.ts'
import type { EngramStore } from './store/interface.ts'

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

/**
 * 判定一条新内容的处置。
 * 嵌入不可用 / 库内无向量条目 / 最近邻低于 DEFER_COSINE → accept；
 * 最近邻同 kind 且 ≥ MERGE_COSINE → merge；其余达到 DEFER_COSINE 的 → defer。
 * @param store - 目标分库
 * @param kind - 新内容的记忆种类（MERGE 要求同 kind，跨 kind 高度相似按 defer 处理）
 * @param embedding - 新内容的向量；undefined = 嵌入不可用，直接 accept
 */
export async function decideWrite(
  store: EngramStore,
  kind: EngramKind,
  embedding: Float32Array | undefined,
): Promise<WriteDecision> {
  if (embedding === undefined) return { disposition: 'accept' }
  const nearest = await store.nearestNeighbor(embedding)
  if (nearest === undefined || nearest.similarity < DEFER_COSINE) return { disposition: 'accept' }
  if (nearest.similarity >= MERGE_COSINE && nearest.record.kind === kind) {
    return { disposition: 'merge', into: nearest.record, similarity: nearest.similarity }
  }
  return { disposition: 'defer', neighbor: nearest.record, similarity: nearest.similarity }
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
