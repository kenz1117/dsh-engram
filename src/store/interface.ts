/**
 * EngramStore：存储 Provider 的可替换接口（capability seam 的 Provider 角色）。
 * scope 分库由调用方持有多个实例（user 与 project 各一）。
 * @module @kenz1117/dsh-engram/store/interface
 */

import type {
  DecayOptions, EngramEdgeType, ExportData, MemoryId, MemoryRecord,
  ReviewView, SearchQuery, SearchResult, StoreStats, TimelineQuery, UpdateInput, WriteInput,
} from '../types.ts'

/** 存储接口。所有方法在库不可用时抛 EngramError。 */
export interface EngramStore {
  /** 追加一条 active 记忆，content 非空。 */
  write(input: WriteInput): Promise<MemoryRecord>
  /** 按 id 取条目（任意状态）；不存在返回 undefined。 */
  get(id: MemoryId): Promise<MemoryRecord | undefined>
  /**
   * 混合检索（向量 + FTS5 + 一跳扩展）。命中强化：accessCount+1、confidence+0.05（封顶 1）。
   * @param queryVector - 查询向量；undefined 表示嵌入不可用（结果 degraded）。
   */
  search(query: SearchQuery, queryVector: Float32Array | undefined): Promise<SearchResult>
  /** 时间线查询，按 createdAt 倒序。 */
  timeline(query: TimelineQuery): Promise<MemoryRecord[]>
  /** 修正：旧条目转 archived，建立 supersedes 边（from=新，to=旧），返回新条目。 */
  update(input: UpdateInput): Promise<MemoryRecord>
  /** 软删（可恢复）。 */
  forget(id: MemoryId): Promise<MemoryRecord>
  /** 从 archived/forgotten 恢复为 active。 */
  restore(id: MemoryId): Promise<MemoryRecord>
  /** 画像注入：user scope 的 active 条目按 importance、confidence 倒序取前 n。 */
  topActive(n: number): Promise<MemoryRecord[]>
  /** 审计视图：条目 + supersedes/contradicts/related 邻居 + 最近操作日志。 */
  review(id: MemoryId): Promise<ReviewView | undefined>
  /** 全库统计。 */
  stats(): Promise<StoreStats>
  /** 全库导出（任意状态条目 + 全部边），数据可携带。 */
  exportAll(): Promise<ExportData>
  /** 衰减：满足条件的 active 条目转 archived，返回归档数量。 */
  decay(options: DecayOptions): Promise<number>
  /** 矛盾候选：与给定向量余弦 ≥ 0.88 的同库 active 条目（调用方裁决后用 linkEdge 建边）。 */
  findContradictions(embedding: Float32Array, limit?: number): Promise<MemoryRecord[]>
  /** 建立一条关系边（幂等）。 */
  linkEdge(from: MemoryId, to: MemoryId, type: EngramEdgeType): Promise<void>
  /** 蒸馏写入原语：单事务内写新条目、归档全部旧条目并逐条建立 supersedes 边。 */
  supersedeMany(input: WriteInput, oldIds: readonly MemoryId[]): Promise<MemoryRecord>
  /** 物理清除本库全部数据（节点、边、FTS、操作日志）。 */
  purge(): Promise<void>
  /** 关闭数据库句柄。 */
  close(): Promise<void>
}
