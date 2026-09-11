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

/** 记忆作用域：user 私人宫殿；project 项目宫殿；shared 跨 agent 共享宫殿（公开可读）。 */
export type EngramScope = 'user' | 'project' | 'shared'

/** 是否为公开可读的 shared scope。 */
export function isSharedScope(scope: EngramScope): boolean {
  return scope === 'shared'
}

/** 记忆种类：fact 事实 / preference 偏好 / decision 决策 / episode 经历 / skill 方法。 */
export type EngramKind = 'fact' | 'preference' | 'decision' | 'episode' | 'skill'

/** 条目状态：active 参与检索；archived（衰减/被取代）不参与检索、可恢复；forgotten 软删、可恢复。 */
export type EngramStatus = 'active' | 'archived' | 'forgotten'

/** 关系边类型。supersedes 语义：from 取代 to。 */
export type EngramEdgeType = 'supports' | 'contradicts' | 'refines' | 'related' | 'supersedes'

/** 记忆使用效果（奖励信号）：success 用后有效提权，failure 用后无效降权；缺省未验证。 */
export type MemoryOutcome = 'success' | 'failure'

/** 感官印记五维：味/声/触/色/温。古典记忆术要求意象挂上感官钩以提高召回。 */
export type SensoryChannel = 'taste' | 'sound' | 'touch' | 'sight' | 'temperature'
/** 单个感官铭牌（如「海腥」「钟声回响」「粗麻布」「深绛红」「金属凉」）。 */
export type SensoryToken = string
/** 情绪强度：0-1，借鉴情绪记忆抗遗忘曲线——高强度优先参与巡游。 */
export type EmotionalValence = number

/** 意象铭牌：把抽象条目映射到一个具象挂念（「沾墨竹简」而非「用户偏好」）。古典记忆术核心：越具体越记得住。 */
export interface ImageryLabel {
  /** 一句具象描述（≤30 字），如「沾墨竹简」「落雨铜铃」。缺省 = null = 未铭刻。 */
  readonly caption: string | null
  /** 感官挂念列表（每条对应 SensoryChannel 之一，可选多维同感）。 */
  readonly sensoryTags: readonly SensoryToken[]
  /** 情感权重 0-1，0 表示中性陈述。 */
  readonly emotionalValence: EmotionalValence
  /** 是否由 LLM 推测生成（true = 候选铭牌，用户未确认）。 */
  readonly provisional: boolean
}

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
  /** 最近一次使用效果回报（engram_report 写入；未回报过为 undefined）。 */
  readonly outcome?: MemoryOutcome
  readonly createdAt: number
  readonly lastAccessedAt: number
  readonly accessCount: number
  readonly sourceSessionId: string | null
  /** 来源会话内轮次（自动摄取写入；显式保存为 null）。 */
  readonly sourceRound: number | null
  /** 来源事件 seq（自动摄取写入；显式保存为 null）。 */
  readonly sourceSeq: number | null
  /** 意象铭牌（schema v5 起；未铭刻时缺省）。 */
  readonly imagery?: ImageryLabel
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
  /** 意象铭牌（schema v5 起；缺省表示未铭刻）。 */
  readonly imagery?: ImageryLabel
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
  /** 意象铭牌替换；缺省继承旧条目。 */
  readonly imagery?: ImageryLabel
}

/** 一条操作日志（审计视图行）。 */
export interface OperationLogRow {
  readonly at: number
  readonly op: string
  /** 操作对象（条目 id 或 AUX）；全库活动视图按此展示归属。 */
  readonly targetId: string
  readonly detail: string | null
}

/** 一条修订历史：update 归档旧条目时的旧内容快照（内容不变性审计）。 */
export interface MemoryRevision {
  readonly content: string
  readonly kind: string
  readonly importance: number
  readonly supersededAt: number
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
  /** 修订历史（旧内容快照，按被取代时间倒序）。 */
  readonly revisions: readonly MemoryRevision[]
  /** 最近 20 条涉及此条目的操作日志（时间倒序）。 */
  readonly operations: readonly OperationLogRow[]
}

/** 全库统计（信噪比 = active / max(1, total)）。 */
export interface StoreStats {
  readonly total: number
  readonly active: number
  readonly archived: number
  readonly forgotten: number
  /** 含 `[REDACTED:` 脱敏标记的条目数（管理面板脱敏覆盖指标）。 */
  readonly redacted: number
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

/** 闭馆三问的答案（墓志铭）。写入 op_log 的 forget 详情，方便 engram_audit_forgotten 考古。 */
export interface ForgettingTombstone {
  /** 为什么关：可能是被取代、过期、与现实不符、隐私等。 */
  readonly reason: string
  /** 影响谁：影响哪些条目/人/项目；空串 = 不适用。 */
  readonly affects: string
  /** 还有用吗：明确遗留价值（可考古、可复习、可回滚时的语义）。 */
  readonly stillUseful: string
}

/** 闭馆考古视图：forgotten 条目 + 墓志铭（来自 op_log）。 */
export interface ForgottenAuditRow {
  readonly id: MemoryId
  readonly scope: EngramScope
  readonly kind: EngramKind
  readonly content: string
  readonly importance: number
  readonly lastAccessedAt: number
  readonly tombstone: ForgettingTombstone | null
  /** op_log 时间戳（闭馆瞬间）。 */
  readonly forgottenAt: number
}

/** 管理列表过滤条件（管理面板用；可看全部状态）。 */
export interface ListFilter {
  readonly scope: EngramScope
  readonly status?: EngramStatus
  readonly kind?: EngramKind
  /** content 子串匹配。 */
  readonly q?: string
  /** 脱敏标记过滤：true 只看含 `[REDACTED:` 的条目，false 只看不含的；缺省不过滤。 */
  readonly redacted?: boolean
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
