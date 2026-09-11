/**
 * EngramStore：存储 Provider 的可替换接口（capability seam 的 Provider 角色）。
 * scope 分库由调用方持有多个实例（user 与 project 各一）。
 * @module @kenz1117/dsh-engram/store/interface
 */

import type {
  DecayOptions, EngramEdgeType, EngramScope, ExportData, ForgettingTombstone,
  ForgottenAuditRow, ListFilter, ListResult,
  MemoryId, MemoryOutcome, MemoryRecord, OperationLogRow,
  ReviewGrade, ReviewView, SearchQuery, SearchResult, Slot, StoreStats, TimelineQuery, UpdateInput, WriteInput,
} from '../types.ts'

/** 一个房间的占用状态（slotCountsByRoom 的行）。 */
export interface RoomState {
  /** 已占用桩位数（forgotten 除外——软删即刻腾位）。 */
  readonly count: number
  /** 当前最大桩位序号（含空桩，决定下一个分配的序号）。 */
  readonly maxIndex: number
}

/** 门牌快照行：房间名 + caption（门牌评分的唯一性/差异化上下文）。 */
export interface PlacardRow {
  readonly room: string | null
  readonly caption: string
}

/** 固定巡游路线的一站。 */
export interface RouteStop {
  readonly position: number
  readonly id: MemoryId
}

/** 存储接口。所有方法在库不可用时抛 EngramError。 */
export interface EngramStore {
  /** 追加一条 active 记忆，content 非空。 */
  write(input: WriteInput): Promise<MemoryRecord>
  /** 按 id 取条目（任意状态）；不存在返回 undefined。 */
  get(id: MemoryId): Promise<MemoryRecord | undefined>
  /**
   * 渐进式披露：按 id 批量拉取条目，保留输入顺序，去重；缺 id 静默跳过。
   * 用于 engram_examine 等「先看门牌号再选进几间」场景。
   */
  getMany(ids: readonly MemoryId[]): Promise<MemoryRecord[]>
  /**
   * 走廊：从 id 出发走 related/supersedes/contradicts 走廊边，depth 跳内返回
   * 全部可到的邻居记忆（不含起点本身，去重）。无邻居返回空数组。
   */
  neighbors(id: MemoryId, depth: number): Promise<MemoryRecord[]>
  /**
   * 混合检索（向量 + FTS5 + 一跳扩展）。命中强化：accessCount+1、confidence+0.05（封顶 1）。
   * @param queryVector - 查询向量；undefined 表示嵌入不可用（结果 degraded）。
   */
  search(query: SearchQuery, queryVector: Float32Array | undefined): Promise<SearchResult>
  /** 时间线查询：缺省按 createdAt 倒序，order='tour' 时按固定巡游路线桩位顺序。 */
  timeline(query: TimelineQuery): Promise<MemoryRecord[]>
  /** 修正：旧条目转 archived，建立 supersedes 边（from=新，to=旧），返回新条目。 */
  update(input: UpdateInput): Promise<MemoryRecord>
  /** 软删（可恢复）。 */
  forget(id: MemoryId): Promise<MemoryRecord>
  /**
   * 闭馆仪式：与 forget 等价的软删，但要求留下墓志铭（闭馆三问答案）写入 op_log。
   * 墓志铭用于 engram_audit_forgotten 考古：事后能说清「为什么关 / 影响谁 / 还有用吗」。
   */
  forgetWithTombstone(id: MemoryId, tombstone: ForgettingTombstone): Promise<MemoryRecord>
  /** 闭馆考古视图：forgotten 条目 + 墓志铭（来自 op_log），按闭馆时间倒序。 */
  listForgottenWithTombs(limit: number): Promise<readonly ForgottenAuditRow[]>
  /** 回报使用效果（奖励信号）：success 提权 confidence+0.05，failure 降权 confidence-0.1（夹逼 0-1）；返回更新后条目，id 不存在返回 undefined。 */
  reportOutcome(id: MemoryId, outcome: MemoryOutcome): Promise<MemoryRecord | undefined>
  /** SM-2 复习答题：按回忆质量推进调度（间隔/ease/reps），返回更新后条目，id 不存在返回 undefined。 */
  scheduleReview(id: MemoryId, grade: ReviewGrade): Promise<MemoryRecord | undefined>
  /** 今日待回忆队列：active 且已到期的条目，按到期时间升序（最逾期在前）。 */
  dueReviews(now: number, limit: number): Promise<MemoryRecord[]>
  /** 各房间占用状态快照（排桩分配的输入）。 */
  slotCountsByRoom(): Promise<Record<string, RoomState>>
  /** 给条目钉桩位（房间 + 序号），记 op_log。 */
  assignSlot(id: MemoryId, slot: Slot): Promise<void>
  /**
   * 存量排桩：为全部 active 且未排桩的条目按 kind 分房、created_at 定序钉桩，
   * 并补登记巡游路线；幂等（只处理 slot_room 为空的行），返回排桩条数。
   * @param capacityNote - 开新房时的回调（调用方记 op_log 提醒人工命名）。
   */
  backfillSlots(capacityNote: (room: string) => void): Promise<number>
  /** 把条目追加到固定巡游路线末尾（位置只增，骨架长期复用）。 */
  routeAppend(id: MemoryId): Promise<void>
  /** 条目是否已在巡游路线上。 */
  routeHas(id: MemoryId): Promise<boolean>
  /** 固定巡游路线全程（按位置升序；已归档/遗忘的站点由渲染层跳过）。 */
  routeList(): Promise<RouteStop[]>
  /** 门牌快照：全库 active 条目的 (房间, caption) 列表（门牌评分上下文）。 */
  listPlacards(): Promise<PlacardRow[]>
  /** 从 archived/forgotten 恢复为 active。 */
  restore(id: MemoryId): Promise<MemoryRecord>
  /** 画像注入/蒸馏取材：指定 scope 的 active 条目按 importance、confidence 倒序取前 n。 */
  topActive(scope: EngramScope, n: number): Promise<MemoryRecord[]>
  /** 管理列表：按 scope/status/kind/子串过滤的分页视图（含全部状态），附总数。 */
  list(filter: ListFilter): Promise<ListResult>
  /** 审计视图：条目 + supersedes/contradicts/related 邻居 + 修订历史 + 最近操作日志。 */
  review(id: MemoryId): Promise<ReviewView | undefined>
  /** 最近操作日志（全库，时间倒序；管理面板活动视图用）。 */
  recentOps(limit: number): Promise<OperationLogRow[]>
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
  /** 写入一条结构化审计记录（辅助 LLM 请求等，不进会话日志——下游插件禁止写未知事件类型）。 */
  audit(op: string, targetId: string, detail: string | null): Promise<void>
  /** 幂等键查重：op_log 中是否已存在指定 op+detail 的记录。 */
  hasAudit(op: string, detail: string): Promise<boolean>
  /** 列出指定 op 的全部 detail（按写入顺序；pending 队列枚举用）。 */
  listAuditDetails(op: string): Promise<string[]>
  /** 清除指定 op+detail 的全部记录（pending 队列出队）。 */
  clearAudit(op: string, detail: string): Promise<void>
  /** 物理清除本库全部数据（节点、边、FTS、操作日志）。 */
  purge(): Promise<void>
  /** 关闭数据库句柄。 */
  close(): Promise<void>
}
