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

/** 品牌化实体 id：实体词典主键，跨工具与存储边界拒绝裸 string。 */
declare const entityIdBrand: unique symbol
export type EntityId = string & { readonly [entityIdBrand]: true }

/** 从任意字符串铸造品牌化实体 id（存储层入库前调用）。 */
export function asEntityId(raw: string): EntityId {
  return raw as EntityId
}

/** 品牌化事实 id：事实链主键，跨工具与存储边界拒绝裸 string。 */
declare const factIdBrand: unique symbol
export type FactId = string & { readonly [factIdBrand]: true }

/** 从任意字符串铸造品牌化事实 id（存储层入库前调用）。 */
export function asFactId(raw: string): FactId {
  return raw as FactId
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

/** 桩位：记忆在宫殿中的固定位置（房间名 + 房内序号）。地点法核心——位置固定，巡游顺序才稳定。 */
export interface Slot {
  /** 房间名（默认按 kind 映射：事实厅/偏好阁/决策堂/往事廊/技法坊；满员自动开「<名>-2」）。 */
  readonly room: string
  /** 房内桩位序号（从 1 起）。 */
  readonly index: number
}

/** 回忆质量自评（SM-2）：0 完全遗忘 … 5 完美回忆；≥3 算通过。 */
export type ReviewGrade = 0 | 1 | 2 | 3 | 4 | 5

/** 间隔重复调度状态（SM-2 简版）。进入调度的条目不参与自动衰减，由复习结果决定命运。 */
export interface ReviewSchedule {
  /** 下次到期时间（epoch 毫秒）；null = 未排期（存量条目默认）。 */
  readonly nextReviewAt: number | null
  /** 难度系数（SM-2 ease，下限 1.3，初始 2.5）。 */
  readonly easeFactor: number
  /** 当前间隔天数。 */
  readonly intervalDays: number
  /** 连续通过次数（失败清零）。 */
  readonly reps: number
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
  /** 桩位（schema v6 起；未排桩时缺省）。 */
  readonly slot?: Slot
  /** 意象质量分 0-1（schema v6 起，save 时启发式落库；未评分时缺省）。 */
  readonly imageryScore?: number
  /** 间隔重复调度（schema v6 起；未进入调度时缺省）。 */
  readonly review?: ReviewSchedule
}

/** 记忆关系边。 */
export interface MemoryEdge {
  readonly from: MemoryId
  readonly to: MemoryId
  readonly type: EngramEdgeType
  readonly createdAt: number
}

/** 实体类别：LLM 从记忆内容中抽取的提及对象归类。 */
export type EngramEntityKind = 'person' | 'project' | 'tool' | 'concept' | 'other'

/** 归一化比较键：trim + 合并连续空白 + 小写（消解第一版只做精确归一匹配，不做相似合并）。 */
export function normalizeEntityName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** 一条实体：从记忆中抽取的命名对象（人/项目/工具/概念），随来源记忆所在 scope 分库。 */
export interface EntityRecord {
  readonly id: EntityId
  /** 规范名（首次创建时的写法）。 */
  readonly name: string
  readonly kind: EngramEntityKind
  /** 别名列表（含规范名变体；消解时与 name 同权参与归一匹配）。 */
  readonly aliases: readonly string[]
  readonly createdAt: number
  readonly updatedAt: number
}

/** 实体提及：LLM 抽取输出中的单个候选（写入路径消解为既有实体或新建）。 */
export interface EntityMention {
  readonly name: string
  readonly kind: EngramEntityKind
  /** 提及的别名（缺省无别名）。 */
  readonly aliases?: readonly string[]
}

/** 事实提及：LLM 抽取输出中的单条事实候选（entity 须为同批实体提及出现过的实体名）。 */
export interface FactMention {
  readonly entity: string
  readonly content: string
}

/** 管理列表过滤条件（实体词典面板用）。 */
export interface EntityListFilter {
  readonly kind?: EngramEntityKind
  /** name 与 aliases_json 的子串匹配（大小写不敏感）。 */
  readonly q?: string
  readonly limit: number
  readonly offset: number
}

/** 实体列表行：实体 + 关联 active 记忆数（排序与规模展示用）。 */
export interface EntityListItem {
  readonly entity: EntityRecord
  readonly memoryCount: number
}

/** 实体列表结果（updated_at 倒序，附总数）。 */
export interface EntityListResult {
  readonly items: readonly EntityListItem[]
  readonly total: number
}

/** 实体详情：实体自身 + 关联的 active 记忆（创建时间倒序）。 */
export interface EntityDetail {
  readonly entity: EntityRecord
  readonly memories: readonly MemoryRecord[]
}

/** 一条事实：挂在实体上的一句话陈述，带有效时间窗与软失效链（schema v11）。 */
export interface FactRecord {
  readonly id: FactId
  readonly entityId: EntityId
  /** 事实陈述（一句话）。 */
  readonly content: string
  /** 事实开始有效的时刻（ms）。 */
  readonly validAt: number
  /** 被取代时刻（ms）；null = 仍有效。 */
  readonly invalidAt: number | null
  /** 取代本事实的后继事实 id；未被取代时 null。 */
  readonly replacedBy: FactId | null
  /** 抽出该事实的来源记忆 id；工具直写时缺省 null。 */
  readonly sourceNodeId: MemoryId | null
  readonly createdAt: number
  readonly updatedAt: number
}

/** 事实写入请求：entityId 须为同库实体；replaces 声明取代的既有事实（目标不存在则按无取代写入）。 */
export interface FactWriteInput {
  readonly entityId: EntityId
  readonly content: string
  readonly replaces?: FactId
  readonly sourceNodeId?: MemoryId
  /** 事实开始有效时刻（ms）；缺省取当前时间。 */
  readonly validAt?: number
}

/** 事实链查询：按实体过滤；asOf 限定时间点视角，includeInvalid 展开全链。 */
export interface FactListFilter {
  readonly entityId: EntityId
  /** 时点查询：返回该时刻仍有效的事实（valid_at <= asOf 且 invalid_at 为 null 或 > asOf）。 */
  readonly asOf?: number
  /** true 时不过滤失效，返回全部历史链（含失效事实及其 replacedBy 回指）。 */
  readonly includeInvalid?: boolean
  readonly limit: number
  readonly offset: number
}

/** 事实链结果（valid_at 倒序，附总数）。 */
export interface FactListResult {
  readonly items: readonly FactRecord[]
  readonly total: number
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
  /** 意象质量分（调用方经 scoreImagery 算好落库；缺省不写入）。 */
  readonly imageryScore?: number
  /** 桩位（调用方经排桩逻辑分配；缺省表示未排桩）。 */
  readonly slot?: Slot
  /** 初始复习排期：毫秒时间戳 = 指定首次到期；null = 明确不进入复习调度（历史回填用，
   *  避免一次性回填的条目同时涌入今日复习队列）；缺省 = 由写入期自动化决定。 */
  readonly initialReviewAt?: number | null
}

/** 检索请求。 */
export interface SearchQuery {
  readonly text: string
  readonly scopes: readonly EngramScope[]
  readonly limit?: number
  /**
   * 房间路由（schema v6 起）：只在指定房间内检索（走廊索引——先决定进哪个房间）。
   * 缺省全库检索；未排桩（slot_room 为空）的条目不属于任何房间，指定 rooms 时不出现。
   */
  readonly rooms?: readonly string[]
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
  /** 编码特异性线索（schema v6 起）：同房间相邻桩位的条目 id——提取时重建编码情境。 */
  readonly cues?: { readonly neighbors: readonly MemoryId[] }
  /** 命中条目关联的实体（schema v10 起；无关联时缺省）。 */
  readonly entities?: readonly { readonly id: EntityId; readonly name: string }[]
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
  /** 排序：缺省 'time' 按创建时间倒序；'tour' 按固定巡游路线桩位顺序（未上路线者按创建时间排末尾）。 */
  readonly order?: 'time' | 'tour'
  readonly limit?: number
}

/** episode 情景时间线的时间邻近扩展缺省窗口：锚点 createdAt ± 60 分钟。 */
export const EPISODE_PROXIMITY_MS_DEFAULT = 60 * 60 * 1000
/** episode 情景时间线缺省返回条数上限。 */
export const EPISODE_TIMELINE_LIMIT_DEFAULT = 100

/** episode 情景记忆时间线查询：独立于通用 TimelineQuery 的情景线索。
 *  缺省模式按 since/until/sessionId 过滤 episode 条目并按来源会话分组；
 *  around 指定时切换为时间邻近扩展模式（以锚点 createdAt 为中心开窗，
 *  忽略 since/until/sessionId——窗口语义下日期过滤只会截断扩展结果）。 */
export interface EpisodeTimelineQuery {
  readonly scopes: readonly EngramScope[]
  /** 起始时间（epoch 毫秒，含）；缺省不限。 */
  readonly since?: number
  /** 结束时间（epoch 毫秒，含）；缺省不限。 */
  readonly until?: number
  /** 只看该来源会话（source_session_id 精确匹配）的情景。 */
  readonly sessionId?: string
  /** 时间邻近扩展锚点（任意 active 记忆 id，不限于 episode）；该库中不存在时 loud 失败。 */
  readonly around?: MemoryId
  /** 邻近窗口毫秒数（around 模式）；缺省 EPISODE_PROXIMITY_MS_DEFAULT。 */
  readonly proximityMs?: number
  /** 返回条数上限（组模式按条数、around 模式按邻居数）；缺省 EPISODE_TIMELINE_LIMIT_DEFAULT。 */
  readonly limit?: number
}

/** 按来源会话分组的一组情景（组内条目按创建时间升序）。 */
export interface EpisodeSessionGroup {
  /** 来源会话 id；null = 无会话来源（显式保存或来源链缺失）。 */
  readonly sessionId: string | null
  readonly episodes: readonly MemoryRecord[]
  /** 组内最早创建时间（组的排序键，会话起点）。 */
  readonly startedAt: number
  /** 组内最晚创建时间（会话跨度展示用）。 */
  readonly endedAt: number
  /** 摄取期生成的一句话会话摘要（组头展示）；未生成过或缺省不携带。 */
  readonly summary?: string
}

/** episode 情景时间线结果。 */
export interface EpisodeTimelineResult {
  /** 按会话分组的情景（组按 startedAt 倒序，最新会话在前）；around 模式下为空数组。 */
  readonly groups: readonly EpisodeSessionGroup[]
  /** 时间邻近扩展（query.around 指定时返回）：锚点条目 + 窗口内的 episode 邻居
   *  （排除锚点自身，按创建时间升序；limit 约束邻居数）。 */
  readonly around?: { readonly anchor: MemoryRecord; readonly neighbors: readonly MemoryRecord[] }
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

/** 画像 curated block 的单条版本记录（追加式版本链，rollback 数据源）。 */
export interface ProfileBlockVersion {
  readonly scope: EngramScope
  /** 版本号：从 1 起单调递增，回滚也产生新版本（历史永不改写）。 */
  readonly version: number
  readonly content: string
  /** 产生方式：edit 人工/模型编辑；rollback 回滚到历史版本的内容。 */
  readonly source: 'edit' | 'rollback'
  readonly at: number
}

/** 画像 curated block 当前态：会话开始注入时优先于自动派生画像。 */
export interface ProfileBlock {
  readonly scope: EngramScope
  readonly content: string
  /** 当前版本号（乐观锁基准：编辑时必须携带此值）。 */
  readonly version: number
  readonly updatedAt: number
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
  /** 实体词典（schema v10 起；旧版本导出缺省）。 */
  readonly entities?: readonly EntityRecord[]
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
  /** 排序：缺省 created_at 倒序；'tour' = 按固定巡游路线桩位顺序（未上路线者按创建时间排末尾）。 */
  readonly sort?: 'tour'
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
