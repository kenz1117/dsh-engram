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

/** 一条记忆。来源链 v0.0.1 记 sourceSessionId；round/seq 由二期自动摄取补全。 */
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
