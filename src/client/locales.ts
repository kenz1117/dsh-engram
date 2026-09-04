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
  | 'refresh'
  | 'exportMd'
  | 'exportJson'
  | 'allStatuses'
  | 'allKinds'
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
  | 'opDistillRequest'
  | 'selectAll'
  | 'deselectAll'
  | 'selectedCount'
  | 'batchForget'
  | 'batchForgetConfirm'
  | 'batchRestore'
  | 'clearSelection'

/** 中文词典（宿主默认语言）。 */
export const zh: Record<EngramKey, string> = {
  nav: '记忆库',
  scopeUser: '用户级',
  scopeProject: '项目级',
  refresh: '刷新',
  exportMd: '导出 MD',
  exportJson: '导出 JSON',
  allStatuses: '全部状态',
  allKinds: '全部种类',
  searchPlaceholder: '按内容搜索…',
  statusActive: '生效中',
  statusArchived: '已归档',
  statusForgotten: '已遗忘',
  kindFact: '事实',
  kindPreference: '偏好',
  kindDecision: '决策',
  kindEpisode: '事件',
  kindSkill: '技能',
  labelContent: '内容',
  labelKind: '种类',
  labelStatus: '状态',
  labelScope: '作用域',
  importance: '重要性',
  confidence: '置信',
  accessCount: '访问 {n} 次',
  labelCreated: '创建时间',
  timeJustNow: '刚刚',
  timeMinutesAgo: '{n} 分钟前',
  timeHoursAgo: '{n} 小时前',
  timeDaysAgo: '{n} 天前',
  sourceExplicit: '显式保存',
  sourceSession: '来源 {id}',
  round: '第 {n} 轮',
  cardActive: '生效 {n}',
  signalRatio: '信噪比 {n}%',
  detail: '详情',
  edit: '编辑',
  forget: '遗忘',
  restore: '恢复',
  empty: '没有符合条件的记忆',
  loadFailed: '加载失败：{msg}',
  loading: '加载中…',
  pagerInfo: '第 {page} / {pages} 页 · 共 {total} 条',
  prevPage: '上一页',
  nextPage: '下一页',
  cancel: '取消',
  saveWithHint: '保存（旧条目归档）',
  detailAttributes: '属性',
  detailSource: '来源',
  detailRelations: '关系',
  detailOperations: '最近操作',
  relSupersededBy: '被取代',
  relSupersedes: '取代',
  relContradicts: '矛盾',
  relRelated: '关联',
  opWrite: '写入',
  opUpdate: '更新',
  opForget: '遗忘',
  opRestore: '恢复',
  opDecay: '衰减归档',
  opSuperseded: '被取代',
  opIngestRequest: '摄取请求',
  opDistillRequest: '蒸馏请求',
  selectAll: '全选本页',
  deselectAll: '取消全选',
  selectedCount: '已选 {n} 条',
  batchForget: '批量遗忘（{n}）',
  batchForgetConfirm: '确认遗忘 {n} 条？',
  batchRestore: '批量恢复（{n}）',
  clearSelection: '取消选择',
}

/** 英文词典。 */
export const en: Record<EngramKey, string> = {
  nav: 'Memory Library',
  scopeUser: 'User',
  scopeProject: 'Project',
  refresh: 'Refresh',
  exportMd: 'Export MD',
  exportJson: 'Export JSON',
  allStatuses: 'All statuses',
  allKinds: 'All kinds',
  searchPlaceholder: 'Search content…',
  statusActive: 'active',
  statusArchived: 'archived',
  statusForgotten: 'forgotten',
  kindFact: 'fact',
  kindPreference: 'preference',
  kindDecision: 'decision',
  kindEpisode: 'episode',
  kindSkill: 'skill',
  labelContent: 'Content',
  labelKind: 'Kind',
  labelStatus: 'Status',
  labelScope: 'Scope',
  importance: 'Importance',
  confidence: 'Confidence',
  accessCount: '{n}× accessed',
  labelCreated: 'Created',
  timeJustNow: 'just now',
  timeMinutesAgo: '{n} min ago',
  timeHoursAgo: '{n} hr ago',
  timeDaysAgo: '{n} d ago',
  sourceExplicit: 'Explicitly saved',
  sourceSession: 'Source {id}',
  round: 'round {n}',
  cardActive: '{n} active',
  signalRatio: 'signal {n}%',
  detail: 'Details',
  edit: 'Edit',
  forget: 'Forget',
  restore: 'Restore',
  empty: 'No matching memories',
  loadFailed: 'Failed to load: {msg}',
  loading: 'Loading…',
  pagerInfo: 'Page {page} / {pages} · {total} records',
  prevPage: 'Prev',
  nextPage: 'Next',
  cancel: 'Cancel',
  saveWithHint: 'Save (archives old entry)',
  detailAttributes: 'Attributes',
  detailSource: 'Source',
  detailRelations: 'Relations',
  detailOperations: 'Recent operations',
  relSupersededBy: 'Superseded by',
  relSupersedes: 'Supersedes',
  relContradicts: 'Contradicts',
  relRelated: 'Related',
  opWrite: 'write',
  opUpdate: 'update',
  opForget: 'forget',
  opRestore: 'restore',
  opDecay: 'decay',
  opSuperseded: 'superseded',
  opIngestRequest: 'ingest-request',
  opDistillRequest: 'distill-request',
  selectAll: 'Select all on page',
  deselectAll: 'Deselect all',
  selectedCount: '{n} selected',
  batchForget: 'Forget selected ({n})',
  batchForgetConfirm: 'Forget {n} entries?',
  batchRestore: 'Restore selected ({n})',
  clearSelection: 'Clear selection',
}
