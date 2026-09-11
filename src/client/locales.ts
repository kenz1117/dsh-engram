/**
 * 「记忆库」client 词典：zh/en 键并集必须完全一致（类型化注册的编译约束）。
 * 数据层英文枚举（status/kind/op 等）只在显示层映射，存储值保持英文不变。
 * @module @kenz1117/dsh-engram/client/locales
 */

/** 词典命名空间（同时用作 LocaleNamespaceMap 的声明合并键）。 */
export const NS = 'engram'

/** 「记忆库」全部界面文案键。 */
export type EngramKey =
  | 'nav'
  | 'scopeUser'
  | 'scopeProject'
  | 'scopeShared'
  | 'refresh'
  | 'exportMd'
  | 'exportJson'
  | 'export'
  | 'exportMirror'
  | 'exportMdHint'
  | 'exportJsonHint'
  | 'exportMirrorHint'
  | 'allStatuses'
  | 'allKinds'
  | 'redactedAll'
  | 'redactedOnly'
  | 'redactedNone'
  | 'tagRedacted'
  | 'tagOutcomeSuccess'
  | 'tagOutcomeFailure'
  | 'searchPlaceholder'
  | 'statusActive'
  | 'statusArchived'
  | 'statusForgotten'
  | 'kindFact'
  | 'kindPreference'
  | 'kindDecision'
  | 'kindEpisode'
  | 'kindSkill'
  | 'labelContent'
  | 'labelKind'
  | 'labelStatus'
  | 'labelScope'
  | 'importance'
  | 'confidence'
  | 'accessCount'
  | 'labelCreated'
  | 'timeJustNow'
  | 'timeMinutesAgo'
  | 'timeHoursAgo'
  | 'timeDaysAgo'
  | 'sourceExplicit'
  | 'sourceSession'
  | 'round'
  | 'cardActive'
  | 'cardRedacted'
  | 'signalRatio'
  | 'detail'
  | 'edit'
  | 'forget'
  | 'restore'
  | 'empty'
  | 'loadFailed'
  | 'loading'
  | 'pagerInfo'
  | 'prevPage'
  | 'nextPage'
  | 'cancel'
  | 'saveWithHint'
  | 'detailAttributes'
  | 'detailSource'
  | 'detailRelations'
  | 'detailOperations'
  | 'headerTitle'
  | 'headerSubtitle'
  | 'tabLibrary'
  | 'tabObservability'
  | 'tabLibraryCount'
  | 'drawerClose'
  | 'drawerTitle'
  | 'kpiTotal'
  | 'kpiActive'
  | 'kpiForgotten'
  | 'kpiSignal'
  | 'emptyHint'
  | 'relSupersededBy'
  | 'relSupersedes'
  | 'relContradicts'
  | 'relRelated'
  | 'opWrite'
  | 'opUpdate'
  | 'opForget'
  | 'opRestore'
  | 'opDecay'
  | 'opSuperseded'
  | 'opIngestRequest'
  | 'opIngestDone'
  | 'opOutcomeReport'
  | 'opSearchRewrite'
  | 'opCompressRequest'
  | 'opDistillRequest'
  | 'selectAll'
  | 'deselectAll'
  | 'selectedCount'
  | 'batchForget'
  | 'batchForgetConfirm'
  | 'batchRestore'
  | 'clearSelection'
  | 'sectionBench'
  | 'sectionCorridor'
  | 'corridorEmpty'
  | 'corridorFailed'
  | 'corridorLoad'
  | 'healthTitle'
  | 'healthLoading'
  | 'healthFailed'
  | 'healthMetricSignal'
  | 'healthMetricActive'
  | 'healthMetricCorridors'
  | 'healthMetricRedaction'
  | 'healthMetricDecay'
  | 'teleTitle'
  | 'teleFailed'
  | 'teleLoading'
  | 'teleGroupScale'
  | 'teleGroupRecent'
  | 'telePrivacyHint'
  | 'telePrivacyTip'
  | 'teleWrites'
  | 'teleForgets'
  | 'teleIngest'
  | 'teleDistill'
  | 'teleConsolidate'
  | 'benchPlaceholder'
  | 'benchRun'
  | 'benchScopeAll'
  | 'benchHits'
  | 'benchDegraded'
  | 'benchEmpty'
  | 'benchNote'
  | 'viaFts'
  | 'viaVec'
  | 'viaBoth'
  | 'viaEdgeLabel'
  | 'benchRewrite'
  | 'benchCompress'
  | 'sectionActivity'
  | 'activityEmpty'
  | 'detailRevisions'
  | 'tourProposalTitle'
  | 'tourProposalEmpty'
  | 'tourProposalHint'
  | 'tourFocusAll'
  | 'refurbTitle'
  | 'refurbEmpty'
  | 'refurbRun'
  | 'refurbActionDemote'
  | 'refurbActionMerge'
  | 'refurbActionReview'
  | 'refurbActionSplit'
  | 'refurbCount'
  | 'refurbExecute'
  | 'refurbConfirmDemote'
  | 'refurbConfirmMerge'
  | 'refurbDemoteDone'
  | 'refurbMergeDone'
  | 'refurbActionFailed'
  | 'refurbMergeEmpty'
  | 'reviewQueueTitle'
  | 'reviewQueueEmpty'
  | 'reviewReveal'
  | 'reviewGradeRemember'
  | 'reviewGradeVague'
  | 'reviewGradeForgot'
  | 'reviewOverdue'
  | 'reviewDueToday'
  | 'reviewNoPlacard'
  | 'reviewScheduled'
  | 'sortTime'
  | 'sortTour'
  | 'dueBadgeLabel'
/** 中文词典（宿主默认语言）。整页采用「记忆宫殿」语言：楼 / 房间 / 楼层 / 铭牌 / 参观 / 管家 / 走廊。
   数据层英文枚举（status/kind/op）不在此映射，文案键保持稳定以保证编译约束。 */
export const zh: Record<EngramKey, string> = {
  nav: '记忆宫殿',
  scopeUser: '私人宫殿',
  scopeProject: '项目宫殿',
  scopeShared: '共享宫殿',
  refresh: '重访',
  exportMd: '导出 MD',
  exportJson: '导出 JSON',
  export: '导出',
  exportMirror: '镜像目录',
  exportMdHint: '单文件，可直接分享',
  exportJsonHint: '结构化全文，便于程序处理',
  exportMirrorHint: '每房间一个 .md，可用 Obsidian 漫游',
  allStatuses: '全部房间',
  allKinds: '全部楼层',
  redactedAll: '全部铭牌',
  redactedOnly: '含涂改',
  redactedNone: '无涂改',
  tagRedacted: '已涂改',
  tagOutcomeSuccess: '管家验证·有效',
  tagOutcomeFailure: '管家验证·失效',
  searchPlaceholder: '在宫殿里寻找…',
  statusActive: '对外开放',
  statusArchived: '展厅陈列',
  statusForgotten: '已闭馆',
  kindFact: '事实层',
  kindPreference: '偏好层',
  kindDecision: '决策层',
  kindEpisode: '事件层',
  kindSkill: '技能层',
  labelContent: '铭牌',
  labelKind: '楼层',
  labelStatus: '房门状态',
  labelScope: '宫殿归属',
  importance: '地标亮度',
  confidence: '考据可靠度',
  accessCount: '参观 {n} 人次',
  labelCreated: '开馆时间',
  timeJustNow: '方才',
  timeMinutesAgo: '{n} 分钟前',
  timeHoursAgo: '{n} 小时前',
  timeDaysAgo: '{n} 天前',
  sourceExplicit: '管理员添置',
  sourceSession: '发掘地 {id}',
  round: '第 {n} 趟',
  cardActive: '开放 {n}',
  cardRedacted: '涂改 {n}',
  signalRatio: '走廊清晰度 {n}%',
  detail: '参观',
  edit: '修缮',
  forget: '封门',
  restore: '重开',
  empty: '宫殿暂无可陈展的房间',
  emptyHint: '试试调整楼层筛选，或新添一间',
  loadFailed: '访客受挫：{msg}',
  loading: '导览中…',
  pagerInfo: '第 {page} / {pages} 层 · 共 {total} 间',
  prevPage: '上层',
  nextPage: '下层',
  cancel: '作罢',
  saveWithHint: '修缮（旧铭牌归展厅）',
  detailAttributes: '铭牌',
  detailSource: '发掘地',
  detailRelations: '邻接走廊',
  detailOperations: '管家日志',
  relSupersededBy: '被替代',
  relSupersedes: '替代',
  relContradicts: '互斥',
  relRelated: '相邻',
  headerTitle: '记忆宫殿',
  headerSubtitle: '跨会话长期记忆宫殿',
  tabLibrary: '宫殿陈展',
  tabObservability: '导览管家',
  tabLibraryCount: '{n} 间',
  drawerClose: '归殿',
  drawerTitle: '房间铭牌',
  kpiTotal: '房间',
  kpiActive: '开放',
  kpiForgotten: '闭馆',
  kpiSignal: '清晰度',
  opWrite: '落成',
  opUpdate: '修缮',
  opForget: '封门',
  opRestore: '重开',
  opDecay: '闭门陈列',
  opSuperseded: '被替代',
  opIngestRequest: '发掘请求',
  opIngestDone: '发掘完成',
  opOutcomeReport: '管家验证',
  opSearchRewrite: '路线改写',
  opCompressRequest: '导览压缩',
  opDistillRequest: '重塑楼层',
  selectAll: '本页全选',
  deselectAll: '取消全选',
  selectedCount: '已选 {n} 间',
  batchForget: '批量封门（{n}）',
  batchForgetConfirm: '确认封门 {n} 间？',
  batchRestore: '批量重开（{n}）',
  clearSelection: '清空所选',
  sectionBench: '试走一遍',
  sectionCorridor: '走廊鸟瞰',
  corridorEmpty: '走廊空空如也，落成几间房间后这里会出现鸟瞰图。',
  corridorFailed: '走廊加载失败',
  corridorLoad: '加载走廊鸟瞰…',
  healthTitle: '宫殿健康分',
  healthLoading: '正在诊脉…',
  healthFailed: '诊脉失败',
  healthMetricSignal: '走廊清晰度',
  healthMetricActive: '对外开放率',
  healthMetricCorridors: '走廊密度',
  healthMetricRedaction: '涂改缓解',
  healthMetricDecay: '衰减覆盖',
  teleTitle: '管家日报',
  teleFailed: '遥测加载失败',
  teleLoading: '聚合管家记录中…',
  teleGroupScale: '规模',
  teleGroupRecent: '近 7 天',
  telePrivacyHint: '数据仅在本机聚合 · 不外传',
  telePrivacyTip: '所有 op_log 与遥测计数只在当前进程的 SQLite 里聚合，从未发送至任何外部服务；本机重启或卸载插件即清空。',
  teleWrites: '落成',
  teleForgets: '闭馆',
  teleIngest: '发掘',
  teleDistill: '蒸馏',
  teleConsolidate: '整理',
  benchPlaceholder: '说出要找的房间关键词或语义…',
  benchRun: '出发',
  benchScopeAll: '全部宫殿',
  benchHits: '到访 {n} 间',
  benchDegraded: '语义灯熄，仅关键词引路',
  benchEmpty: '此路不通',
  benchNote: '试走与正式导览共用同一张地图，会计入参观人次',
  viaFts: '关键词',
  viaVec: '语义',
  viaBoth: '双路',
  viaEdgeLabel: '邻接走廊',
  benchRewrite: '路线改写为 {n} 段',
  benchCompress: '铭牌压缩 {n} 条',
  sectionActivity: '管家日志',
  activityEmpty: '暂无管家活动',
  detailRevisions: '陈展沿革',
  tourProposalTitle: '入殿导航',
  tourProposalEmpty: '宫殿尚空，建议先放第一段记忆（调用 engram_save）',
  tourProposalHint: '点击房间可展开抽屉查看铭牌',
  tourFocusAll: '全部',
  refurbTitle: '翻新清单',
  refurbEmpty: '所有房间状态健康，无翻新建议',
  refurbRun: '重新扫描',
  refurbActionDemote: '降级',
  refurbActionMerge: '合并',
  refurbActionReview: '复习',
  refurbActionSplit: '拆分',
  refurbCount: '{n} 条建议',
  refurbExecute: '执行',
  refurbConfirmDemote: '确认降级此房间？执行后状态转 archived，可在统计页恢复。',
  refurbConfirmMerge: '确认合并 {n} 间相似房间？将触发 engram_distill 把多间归纳为 1 条高层规律。',
  refurbDemoteDone: '已降级',
  refurbMergeDone: '合并任务已派发',
  refurbActionFailed: '执行失败：{msg}',
  refurbMergeEmpty: '无可合并的候选条目',
  reviewQueueTitle: '今日待回忆',
  reviewQueueEmpty: '今日无到期记忆，宫殿节奏良好',
  reviewReveal: '揭示铭牌',
  reviewGradeRemember: '记得',
  reviewGradeVague: '模糊',
  reviewGradeForgot: '忘了',
  reviewOverdue: '逾期 {n} 天',
  reviewDueToday: '今日到期',
  reviewNoPlacard: '（无门牌）',
  reviewScheduled: '已排入 {n} 天后再回忆',
  sortTime: '按时间',
  sortTour: '按巡游路线',
  dueBadgeLabel: '今日待回忆 {n} 段，点击前往',
}

/** 英文词典。整页采用「Memory Palace」语言：palace / room / floor / placard / tour / curator / corridor。
   数据层英文枚举（status/kind/op）不在此映射，文案键保持稳定。 */
export const en: Record<EngramKey, string> = {
  nav: 'Memory Palace',
  scopeUser: 'Private Palace',
  scopeProject: 'Project Palace',
  scopeShared: 'Shared Palace',
  refresh: 'Revisit',
  exportMd: 'Export MD',
  exportJson: 'Export JSON',
  export: 'Export',
  exportMirror: 'Mirror tree',
  exportMdHint: 'Single file, easy to share',
  exportJsonHint: 'Structured full dump for scripts',
  exportMirrorHint: 'One .md per room, roamable in Obsidian',
  allStatuses: 'All rooms',
  allKinds: 'All floors',
  redactedAll: 'All placards',
  redactedOnly: 'Redacted',
  redactedNone: 'Unredacted',
  tagRedacted: 'redacted',
  tagOutcomeSuccess: 'curator: worked',
  tagOutcomeFailure: 'curator: failed',
  searchPlaceholder: 'Wander the palace…',
  statusActive: 'open to public',
  statusArchived: 'on display',
  statusForgotten: 'closed',
  kindFact: 'Fact Floor',
  kindPreference: 'Preference Floor',
  kindDecision: 'Decision Floor',
  kindEpisode: 'Episode Floor',
  kindSkill: 'Skill Floor',
  labelContent: 'Placard',
  labelKind: 'Floor',
  labelStatus: 'Door',
  labelScope: 'Palace',
  importance: 'Beacon',
  confidence: 'Provenance',
  accessCount: '{n} visits',
  labelCreated: 'Opened',
  timeJustNow: 'just now',
  timeMinutesAgo: '{n} min ago',
  timeHoursAgo: '{n} hr ago',
  timeDaysAgo: '{n} d ago',
  sourceExplicit: 'Curator placed',
  sourceSession: 'Excavated at {id}',
  round: 'pass {n}',
  cardActive: '{n} open',
  cardRedacted: '{n} redacted',
  signalRatio: 'corridor clarity {n}%',
  detail: 'Tour',
  edit: 'Renovate',
  forget: 'Close',
  restore: 'Reopen',
  empty: 'No exhibits to display',
  emptyHint: 'Adjust the floors above, or place a new room',
  loadFailed: 'Tour halted: {msg}',
  loading: 'Guiding…',
  pagerInfo: 'Floor {page} / {pages} · {total} rooms',
  prevPage: 'Floor up',
  nextPage: 'Floor down',
  cancel: 'Cancel',
  saveWithHint: 'Renovate (archive old placard)',
  detailAttributes: 'Placard',
  detailSource: 'Excavation',
  detailRelations: 'Corridors',
  detailOperations: 'Curator log',
  relSupersededBy: 'Superseded by',
  relSupersedes: 'Supersedes',
  relContradicts: 'Contradicts',
  relRelated: 'Adjacent',
  headerTitle: 'Memory Palace',
  headerSubtitle: 'Cross-session long-term memory palace',
  tabLibrary: 'Palace',
  tabObservability: 'Tour butler',
  tabLibraryCount: '{n} rooms',
  drawerClose: 'Return',
  drawerTitle: 'Room placard',
  kpiTotal: 'Rooms',
  kpiActive: 'Open',
  kpiForgotten: 'Closed',
  kpiSignal: 'Clarity',
  opWrite: 'opened',
  opUpdate: 'renovated',
  opForget: 'closed',
  opRestore: 'reopened',
  opDecay: 'archived',
  opSuperseded: 'superseded',
  opIngestRequest: 'excavation requested',
  opIngestDone: 'excavated',
  opOutcomeReport: 'curator report',
  opSearchRewrite: 'route rewritten',
  opCompressRequest: 'placard compressed',
  opDistillRequest: 'floor remodelled',
  selectAll: 'Select all on floor',
  deselectAll: 'Deselect all',
  selectedCount: '{n} rooms',
  batchForget: 'Close selected ({n})',
  batchForgetConfirm: 'Close {n} rooms?',
  batchRestore: 'Reopen selected ({n})',
  clearSelection: 'Clear selection',
  sectionBench: 'Take a walk',
  sectionCorridor: 'Corridor overview',
  corridorEmpty: 'No rooms yet — the bird’s-eye view appears after a few rooms open.',
  corridorFailed: 'Failed to load corridor',
  corridorLoad: 'Loading corridor overview…',
  healthTitle: 'Palace health',
  healthLoading: 'Taking pulse…',
  healthFailed: 'Pulse failed',
  healthMetricSignal: 'Corridor clarity',
  healthMetricActive: 'Open ratio',
  healthMetricCorridors: 'Corridor density',
  healthMetricRedaction: 'Redaction relief',
  healthMetricDecay: 'Decay coverage',
  teleTitle: 'Curator log',
  teleFailed: 'Telemetry failed',
  teleLoading: 'Aggregating curator events…',
  teleGroupScale: 'Scale',
  teleGroupRecent: 'Last 7 days',
  telePrivacyHint: 'Local aggregation only · never transmitted',
  telePrivacyTip: 'All op_log and telemetry counters are aggregated in this process\u2019s SQLite only; nothing is sent to any external service. Clearing the plugin or restarting the host wipes the data.',
  teleWrites: 'Opened',
  teleForgets: 'Closed',
  teleIngest: 'Excavated',
  teleDistill: 'Distilled',
  teleConsolidate: 'Consolidated',
  benchPlaceholder: 'Name a room by keyword or meaning…',
  benchRun: 'Walk',
  benchScopeAll: 'All palaces',
  benchHits: '{n} rooms found',
  benchDegraded: 'Beacon dark · keyword lane only',
  benchEmpty: 'No route found',
  benchNote: 'Walk uses the same map as the guided tour and counts as a visit',
  viaFts: 'keyword',
  viaVec: 'semantic',
  viaBoth: 'dual',
  viaEdgeLabel: 'corridor',
  benchRewrite: 'route split into {n}',
  benchCompress: 'compressed {n} overflow placards',
  sectionActivity: 'Curator log',
  activityEmpty: 'No curator activity yet',
  detailRevisions: 'Exhibit history',
  tourProposalTitle: 'Tour proposal',
  tourProposalEmpty: 'The palace is empty — place a first room via engram_save',
  tourProposalHint: 'Click a room to open its placard',
  tourFocusAll: 'All',
  refurbTitle: 'Refurb suggestions',
  refurbEmpty: 'All rooms are healthy — no suggestions',
  refurbRun: 'Re-scan',
  refurbActionDemote: 'demote',
  refurbActionMerge: 'merge',
  refurbActionReview: 'review',
  refurbActionSplit: 'split',
  refurbCount: '{n} suggestions',
  refurbExecute: 'Apply',
  refurbConfirmDemote: 'Demote this room? Status will become archived; you can reopen it later.',
  refurbConfirmMerge: 'Merge {n} similar rooms? This triggers engram_distill to fold them into one higher-level pattern.',
  refurbDemoteDone: 'Demoted',
  refurbMergeDone: 'Merge dispatched',
  refurbActionFailed: 'Action failed: {msg}',
  refurbMergeEmpty: 'No merge candidates',
  reviewQueueTitle: 'Due today',
  reviewQueueEmpty: 'Nothing due today — palace rhythm is healthy',
  reviewReveal: 'Reveal placard',
  reviewGradeRemember: 'Remembered',
  reviewGradeVague: 'Hazy',
  reviewGradeForgot: 'Forgot',
  reviewOverdue: '{n}d overdue',
  reviewDueToday: 'due today',
  reviewNoPlacard: '(no placard)',
  reviewScheduled: 'Scheduled again in {n}d',
  sortTime: 'By time',
  sortTour: 'By tour route',
  dueBadgeLabel: '{n} due for review — click to open',
}
