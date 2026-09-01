/**
 * dsh-engram 词汇表：记忆条目、关系边、查询与错误。
 * @module @kenz1117/dsh-engram/types
 */

/** 品牌化记忆 id：跨工具与存储边界的 id 一律此类型，拒绝裸 string。 */
declare const memoryIdBrand: unique symbol
export type MemoryId = string & { readonly [memoryIdBrand]: true }

/** 从任意字符串铸造品牌化 id（存储层入库前调用）。 */
export function asMemoryId(raw: string): MemoryId {
  return raw as MemoryId
}

/** 记忆作用域：user 全局共享；project 按工作目录分库。 */
export type EngramScope = 'user' | 'project'

/** 记忆种类：fact 事实 / preference 偏好 / decision 决策 / episode 经历 / skill 方法。 */
export type EngramKind = 'fact' | 'preference' | 'decision' | 'episode' | 'skill'

/** 条目状态：active 参与检索；archived（衰减/被取代）不参与检索、可恢复；forgotten 软删、可恢复。 */
export type EngramStatus = 'active' | 'archived' | 'forgotten'

/** 关系边类型。supersedes 语义：from 取代 to。 */
export type EngramEdgeType = 'supports' | 'contradicts' | 'refines' | 'related' | 'supersedes'

/** 一条记忆。来源链：v0.0.1 记 sourceSessionId；v0.2.0 起自动摄取补 sourceRound/sourceSeq。 */
export interface MemoryRecord {
  readonly id: MemoryId
  readonly scope: EngramScope
  readonly kind: EngramKind
  readonly content: string
  /** 0-1：重要性，影响注入排序与衰减调度。 */
  readonly importance: number
  /** 0-1：置信度，命中强化提升、蒸馏失败回退。 */
  readonly confidence: number
  readonly status: EngramStatus
  readonly createdAt: number
  readonly lastAccessedAt: number
  readonly accessCount: number
  readonly sourceSessionId: string | null
  /** 来源会话内轮次（自动摄取写入；显式保存为 null）。 */
  readonly sourceRound: number | null
  /** 来源事件 seq（自动摄取写入；显式保存为 null）。 */
  readonly sourceSeq: number | null
}

/** 记忆关系边。 */
export interface MemoryEdge {
  readonly from: MemoryId
  readonly to: MemoryId
  readonly type: EngramEdgeType
  readonly createdAt: number
}

/** 写入请求。可选数值字段缺省时由存储层取默认（不显式传 undefined）。 */
export interface WriteInput {
  readonly scope: EngramScope
  readonly kind: EngramKind
  readonly content: string
  readonly importance?: number
  readonly confidence?: number
  readonly sourceSessionId?: string | null
  readonly sourceRound?: number
  readonly sourceSeq?: number
  /** 内容向量（调用方经嵌入器算好）；缺省时该条目不参与向量检索。 */
  readonly embedding?: Float32Array
}

/** 检索请求。 */
export interface SearchQuery {
  readonly text: string
  readonly scopes: readonly EngramScope[]
  readonly limit?: number
}

/** 一条检索命中。 */
export interface SearchHit {
  readonly record: MemoryRecord
  /** 融合得分（RRF），越高越相关。 */
  readonly score: number
  /** 该条命中的贡献道：fts 关键词 / vec 语义 / both。 */
  readonly via: 'fts' | 'vec' | 'both'
  /** 经关系边一跳扩展引入时，来源条目 id 与边类型。 */
  readonly viaEdge?: { readonly from: MemoryId; readonly type: EngramEdgeType }
}

/** 检索结果：degraded=true 表示嵌入缺失/失败，仅关键词道参与排序。 */
export interface SearchResult {
  readonly hits: readonly SearchHit[]
  readonly degraded: boolean
}

/** 时间线查询。since/until 为 epoch 毫秒；topic 为子串匹配。 */
export interface TimelineQuery {
  readonly since?: number
  readonly until?: number
  readonly topic?: string
  readonly scopes: readonly EngramScope[]
  readonly limit?: number
}

/** 更新请求：旧条目转 archived 并建立 supersedes 边（from=新，to=旧）。 */
export interface UpdateInput {
  readonly id: MemoryId
  readonly scope: EngramScope
  readonly kind: EngramKind
  readonly content: string
  readonly importance?: number
  /** 新内容向量；缺省时继承旧条目向量。 */
  readonly embedding?: Float32Array
}

/** 一条操作日志（审计视图行）。 */
export interface OperationLogRow {
  readonly at: number
  readonly op: string
  readonly detail: string | null
}

/** 审计视图：条目 + 来源链 + 关系邻居 + 操作日志。 */
export interface ReviewView {
  readonly record: MemoryRecord
  /** 谁取代了此条目（supersedes 边 from → 此条目）。 */
  readonly supersededBy: readonly MemoryId[]
  /** 此条目取代了谁（supersedes 边 此条目 → to）。 */
  readonly supersedes: readonly MemoryId[]
  readonly contradicts: readonly MemoryId[]
  readonly related: readonly MemoryId[]
  /** 最近 20 条涉及此条目的操作日志（时间倒序）。 */
  readonly operations: readonly OperationLogRow[]
}

/** 全库统计（信噪比 = active / max(1, total)）。 */
export interface StoreStats {
  readonly total: number
  readonly active: number
  readonly archived: number
  readonly forgotten: number
  readonly byKind: Readonly<Record<string, number>>
  readonly edges: number
  readonly opLogCount: number
  readonly signalRatio: number
}

/** 全库导出（数据可携带：任意状态条目 + 全部边）。 */
export interface ExportData {
  readonly exportedAt: number
  readonly records: readonly MemoryRecord[]
  readonly edges: readonly MemoryEdge[]
}

/** 衰减参数：低于 importanceBelow 且 lastAccessedAt 超过 olderThanDays 的 active 条目归档。 */
export interface DecayOptions {
  readonly importanceBelow: number
  readonly olderThanDays: number
}

/** 管理列表过滤条件（管理面板用；可看全部状态）。 */
export interface ListFilter {
  readonly scope: EngramScope
  readonly status?: EngramStatus
  readonly kind?: EngramKind
  /** content 子串匹配。 */
  readonly q?: string
  readonly limit: number
  readonly offset: number
}

/** 分页列表结果。 */
export interface ListResult {
  readonly records: readonly MemoryRecord[]
  readonly total: number
}

/** dsh-engram 统一错误：加载/使用期的可诊断失败都抛此类型。 */
export class EngramError extends Error {
  /** 机器可读原因码，如 EMBEDDER_DOWNLOAD_FAILED / SCHEMA_INCOMPATIBLE。 */
  readonly code: string

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'EngramError'
    this.code = code
  }
}
