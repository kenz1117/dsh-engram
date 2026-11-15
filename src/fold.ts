/**
 * 注入端折叠（#55）：top-N 画像候选渲染前按存储向量做同 kind 余弦聚类，每簇保留
 * importance 最高的条目（候选已按 importance 降序，首个到达者即簇头），其余从注入块
 * 移除但不删库——改写重复不再各占一个注入槽位。候选顺序来自 topActive 的
 * `importance DESC, created_at DESC, id ASC`。
 * @module @kenz1117/dsh-engram/fold
 */

import type { MemoryId, MemoryRecord } from './types.ts'
import { cosine, isDimensionMismatch } from './vec.ts'

/** 折叠阈值：同 kind 余弦达到该值判为同一事实的改写（报告人建议值）。 */
export const FOLD_COSINE = 0.9

/** 折叠后的一个簇头。 */
export interface FoldedHead {
  /** 簇头条目（簇内 importance 最高的那条）。 */
  readonly record: MemoryRecord
  /** 折叠进本簇头的条目数（不含簇头自身）。 */
  readonly foldedCount: number
  /** 被折叠条目的 id（不含簇头）。 */
  readonly foldedIds: readonly MemoryId[]
}

/** 折叠结果：kept 为保留的簇头（保持候选顺序），foldedCount 为被折叠条目总数。 */
export interface FoldResult {
  readonly kept: readonly FoldedHead[]
  readonly foldedCount: number
}

/**
 * 同 kind 近似重复折叠。无向量条目不可比较，一律保留不折叠；跨 kind 不折叠；
 * 混维（换过模型的存量库）视作不可比较，不折叠也不炸注入。
 * @param records - 候选（topActive 顺序 = importance 降序）。
 * @param vectors - id → 存储向量（键取各条目的 memoryId；缺向量条目一律保留）。
 * @param threshold - 折叠阈值（缺省 FOLD_COSINE）。
 */
export function foldNearDuplicates(
  records: readonly MemoryRecord[],
  vectors: ReadonlyMap<MemoryId, Float32Array>,
  threshold = FOLD_COSINE,
): FoldResult {
  const heads: { record: MemoryRecord; foldedIds: MemoryId[] }[] = []
  for (const record of records) {
    const vector = vectors.get(record.memoryId)
    const host = vector === undefined
      ? undefined
      : heads.find(head => {
        if (head.record.kind !== record.kind) return false
        const headVector = vectors.get(head.record.memoryId)
        if (headVector === undefined) return false
        try {
          return cosine(vector, headVector) >= threshold
        } catch (error) {
          if (isDimensionMismatch(error)) return false
          throw error
        }
      })
    if (host === undefined) heads.push({ record, foldedIds: [] })
    else host.foldedIds.push(record.id)
  }
  const kept: FoldedHead[] = heads.map(head => ({
    record: head.record,
    foldedCount: head.foldedIds.length,
    foldedIds: head.foldedIds,
  }))
  return { kept, foldedCount: kept.reduce((sum, head) => sum + head.foldedCount, 0) }
}
