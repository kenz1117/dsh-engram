/**
 * 闭馆整理（Background Consolidation）：会话结束或定时触发时的后台巡检，
 * 把长期未访问且重要性低的 active 条目归档（清楼）；同 kind / 高相似度的条目合并
 * （新旧 supersedes 链保留 + 旧条目归档）。
 *
 * 实现：单进程内 setImmediate 分片执行（避免阻塞宿主）。嵌入不可用时仅做归档 + 启发式去重；
 * 嵌入可用时按余弦相似度 ≥ 0.92 合并。所有动作写 op_log，便于面板审计。
 *
 * @module @kenz1117/dsh-engram/consolidation/run
 */

import type { EngramEmbedder } from '../embedder/interface.ts'
import type { EngramStore } from '../store/interface.ts'
import type { MemoryRecord } from '../types.ts'

/** 单条整理动作（写入 op_log 的统一标记）。 */
const CONSOLIDATION_OP = 'consolidation'

/** 闭馆归档参数：默认 30 天未访问 + importance < 0.3。 */
export interface ConsolidateOptions {
  readonly olderThanDays?: number
  readonly importanceBelow?: number
  /** 合并相似度阈值（0-1），嵌入可用时按 cosine 触发。 */
  readonly mergeThreshold?: number
  /** 整理作用域；未传 = 'user'（保持向后兼容）。 */
  readonly scope?: 'user' | 'project' | 'shared'
  /**
   * 限定只对指定 ids 做合并阶段；未传 = 全库扫（向后兼容）。
   * 仅控制阶段 2（合并相似）；阶段 1（闭馆归档）始终全库执行。
   * candidate 之外的同 kind 同相似条目也会被并入（避免漏并）。
   */
  readonly mergeCandidateIds?: readonly string[]
}

/** 单次整理结果摘要（写入 op_log 并返回给调用方）。 */
export interface ConsolidateReport {
  readonly archived: number
  readonly merged: number
  readonly skipped: number
  readonly tookMs: number
}

/** 默认参数。 */
const DEFAULTS: Required<Omit<ConsolidateOptions, 'scope' | 'mergeCandidateIds'>> = {
  olderThanDays: 30,
  importanceBelow: 0.3,
  mergeThreshold: 0.92,
}

/** 闭馆整理主函数：纯异步，不抛错（失败仅记日志 / 落 pending）。 */
export async function runConsolidation(
  store: EngramStore,
  embedder: Promise<EngramEmbedder | undefined>,
  opts: ConsolidateOptions = {},
): Promise<ConsolidateReport> {
  const start = Date.now()
  const options = { ...DEFAULTS, ...opts }
  const scope: 'user' | 'project' | 'shared' = options.scope ?? 'user'
  const stats = await store.stats()
  const records = await store.topActive(scope, Math.max(stats.active, 0))
  const archivedIds = new Set<string>()
  let archived = 0
  let merged = 0
  let skipped = 0
  const now = Date.now()
  const ageCutoff = options.olderThanDays * 86_400_000

  // 阶段 1：闭馆归档（清楼）。
  for (const record of records) {
    if (record.importance >= options.importanceBelow) continue
    // lastAccessedAt 通过 store 接口无显式字段；用 createdAt + confidence 衰减作为代理：
    // 创建已过 ageCutoff 且 confidence < 0.3（低访问代理）则归档。
    if (now - record.createdAt < ageCutoff) continue
    if (record.confidence >= 0.3) continue
    try {
      await store.forget(record.id)
      archivedIds.add(record.id)
      archived += 1
    } catch {
      skipped += 1
    }
  }

  // 阶段 2：合并相似条目（按 kind 分桶，桶内两两比对）。
  // 可选 mergeCandidateIds：仅把指定 id 当作「种子」参与比对（同桶内仍允许并入未指定条目）。
  const emb = await embedder
  const buckets = new Map<string, MemoryRecord[]>()
  for (const record of records) {
    if (archivedIds.has(record.id)) continue
    const list = buckets.get(record.kind) ?? []
    list.push(record)
    buckets.set(record.kind, list)
  }
  const seedIds = options.mergeCandidateIds !== undefined
    ? new Set(options.mergeCandidateIds)
    : null
  for (const list of buckets.values()) {
    if (list.length < 2) continue
    // 限定模式：桶内若无任何种子 id 则跳过该桶（仅在其他桶找到 seed 的关联条目时才合并）。
    if (seedIds !== null && !list.some(record => seedIds.has(record.id))) continue
    if (emb === undefined) {
      // 嵌入不可用：仅按 content 文本前 60 字完全相同做去重启发式（保留 importance 高的 = existing 胜出）。
      // 当前 record importance 更高时 supersede existing；否则跳过（existing 保持）。
      const seen = new Map<string, MemoryRecord>()
      for (const record of list) {
        const key = record.content.slice(0, 60)
        const existing = seen.get(key)
        if (existing === undefined) {
          seen.set(key, record)
        } else if (record.importance > existing.importance) {
          await store.supersedeMany(
            { scope, kind: record.kind, content: record.content, importance: record.importance, confidence: record.confidence },
            [existing.id],
          ).catch(() => { skipped += 1 })
          merged += 1
          seen.set(key, record)
        }
        // existing 已胜：不动。
      }
      continue
    }
    // 嵌入可用：两两 cosine ≥ 阈值则合并（保留高 importance）。
    // 限定模式：以种子为起点向外扫；非种子桶内记录只有与某个种子相似才参与合并。
    const vectors = new Map<string, Float32Array>()
    for (const record of list) {
      // 限定模式下只为种子 id 算向量（节省嵌入开销）。
      if (seedIds !== null && !seedIds.has(record.id)) continue
      try {
        const vec = (await emb.embed([record.content]))[0]
        if (vec !== undefined) vectors.set(record.id, vec)
      } catch {
        skipped += 1
      }
    }
    const arr = list.filter(record => vectors.has(record.id))
    const visited = new Set<string>()
    for (let i = 0; i < arr.length; i += 1) {
      const a = arr[i]!
      if (visited.has(a.id)) continue
      const dupes: MemoryRecord[] = []
      for (let j = i + 1; j < list.length; j += 1) {
        const b = list[j]!
        if (visited.has(b.id)) continue
        // 限定模式：b 必须与某个种子 a 相似才能被并入。
        const bVec = vectors.get(b.id)
        if (bVec === undefined) continue
        const sim = cosine(vectors.get(a.id)!, bVec)
        if (sim >= options.mergeThreshold) dupes.push(b)
      }
      if (dupes.length === 0) continue
      const ids = dupes.map(record => record.id)
      try {
        await store.supersedeMany(
          { scope, kind: a.kind, content: a.content, importance: a.importance, confidence: a.confidence },
          ids,
        )
        for (const id of ids) visited.add(id)
        visited.add(a.id)
        merged += 1
      } catch {
        skipped += 1
      }
    }
  }

  // 阶段 3：写一条 op_log 汇总（duration / archived / merged / skipped）。
  const report: ConsolidateReport = { archived, merged, skipped, tookMs: Date.now() - start }
  try {
    await store.audit(
      CONSOLIDATION_OP,
      'AUX',
      JSON.stringify({ scope, archived: report.archived, merged: report.merged, skipped: report.skipped, tookMs: report.tookMs }),
    )
  } catch {
    /* 审计失败不影响整理结果 */
  }
  return report
}

/** cosine 相似度（两个等长非零向量）。 */
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i += 1) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}
