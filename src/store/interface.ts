/**
 * EngramStore：存储 Provider 的可替换接口（capability seam 的 Provider 角色）。
 * scope 分库由调用方持有多个实例（user 与 project 各一）。
 * @module @kenz1117/dsh-engram/store/interface
 */

import type { MemoryId, MemoryRecord, SearchQuery, SearchResult, TimelineQuery, UpdateInput, WriteInput } from '../types.ts'

/** 存储接口。所有方法在库不可用时抛 EngramError。 */
export interface EngramStore {
  /** 追加一条 active 记忆，content 非空。 */
  write(input: WriteInput): Promise<MemoryRecord>
  /** 按 id 取条目（任意状态）；不存在返回 undefined。 */
  get(id: MemoryId): Promise<MemoryRecord | undefined>
  /**
   * 混合检索（FTS5 关键词 + 可选向量余弦，RRF 融合 + 关系边一跳扩展）。
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
  /** 物理清除本库全部数据（节点、边、FTS、操作日志）。 */
  purge(): Promise<void>
  /** 关闭数据库句柄。 */
  close(): Promise<void>
}
