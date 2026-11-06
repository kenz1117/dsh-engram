/**
 * 面板数据模型与纯显示辅助：记忆行、列表/审计返回形状、状态枚举映射与时间格式化。
 * 独立成模块的理由同 panel-kit：EngramPanel 与 views/* 都要用它们，而 client 半按
 * CJS 闭包工厂打包，视图回引 EngramPanel 会形成循环依赖（闭包产物里表现为
 * 「用到时还是 undefined」）。本模块只含类型与纯函数，无 React 依赖。
 * @module @kenz1117/dsh-engram/client/ui/model
 */

import styles from '../panel.module.css'
import type { EngramKey } from '../locales/index.ts'
import { kindLabel, type T } from './panel-kit.tsx'

/** 列表/详情用的记忆视图（宿主 /api/engram/list 的行结构）。 */
export interface MemoryRow {
  readonly id: string
  /** 稳定逻辑身份（v15）；修正后不变。列表行可能缺省（旧后端），显示层按 id 回退。 */
  readonly memoryId?: string
  readonly scope: 'user' | 'project' | 'shared'
  readonly kind: string
  readonly content: string
  readonly importance: number
  readonly confidence: number
  readonly status: 'active' | 'archived' | 'forgotten'
  /** 最近一次使用效果回报（engram_report 写入；未回报过缺省）。 */
  readonly outcome?: 'success' | 'failure'
  readonly createdAt: number
  readonly accessCount: number
  readonly sourceSessionId: string | null
  readonly sourceRound: number | null
  /** 桩位（v0.7.2 起；未排桩时缺省）。 */
  readonly slot?: { readonly room: string; readonly index: number }
}

/** /api/engram/list 的返回（分页头 + 当前页行）。 */
export interface ListResult {
  readonly records: MemoryRow[]
  readonly total: number
}

/** review API 的返回结构（详情行内展开区的数据源）。 */
export interface ReviewView {
  readonly record: MemoryRow
  readonly supersededBy?: readonly string[]
  readonly supersedes?: readonly string[]
  readonly contradicts?: readonly string[]
  readonly related?: readonly string[]
  /** 修订历史（旧内容快照，按被取代时间倒序）。 */
  readonly revisions?: readonly { content: string; kind: string; importance: number; supersededAt: number }[]
  readonly operations?: readonly { at: number; op: string; detail: string | null }[]
}

/** 列表页大小（陈展分页与 Recall 结果共用同一档）。 */
export const PAGE_SIZE = 20

/** 数据层枚举 → 词典键映射（显示层本地化，存储值不变）。 */
export const STATUS_KEY: Record<MemoryRow['status'], EngramKey> = {
  active: 'statusActive',
  archived: 'statusArchived',
  forgotten: 'statusForgotten',
}

export const SCOPE_KEY: Record<MemoryRow['scope'], EngramKey> = {
  user: 'scopeUser',
  project: 'scopeProject',
  shared: 'scopeShared',
}

/** 关系类型 → 词典键（审计区关系 chips）。 */
export const REL_KEY: Record<string, EngramKey> = {
  supersededBy: 'relSupersededBy',
  supersedes: 'relSupersedes',
  contradicts: 'relContradicts',
  related: 'relRelated',
}

/** op 数据值 → 词典键（审计时间线与活动日志共用）。 */
const OP_KEY: Record<string, EngramKey> = {
  write: 'opWrite',
  'write-merge': 'opWriteMerge',
  update: 'opUpdate',
  forget: 'opForget',
  restore: 'opRestore',
  decay: 'opDecay',
  superseded: 'opSuperseded',
  'ingest-request': 'opIngestRequest',
  'ingest-done': 'opIngestDone',
  'outcome-report': 'opOutcomeReport',
  assess: 'opAssess',
  consolidation: 'opConsolidation',
  'review-answer': 'opReviewAnswer',
  'slot-assign': 'opSlotAssign',
  'slot-backfill': 'opSlotBackfill',
  'room-open': 'opRoomOpen',
  'search-rewrite-request': 'opSearchRewrite',
  'compress-request': 'opCompressRequest',
  'distill-request': 'opDistillRequest',
  'profile-edit': 'opProfileEdit',
  // Находки обслуживания тоже попадают в общий журнал: без метки человек читал бы
  // служебные имена (`jev-fallback`, `vectors-missing`) в русском списке как есть.
  'jev-fallback': 'opJevFallback',
  'vectors-missing': 'opVectorsMissing',
}

/** 操作日志 detail JSON 的已知键 → 词典键（write/update/superseded 的小对象）。 */
const DETAIL_KEY: Record<string, EngramKey> = {
  kind: 'labelKind',
  scope: 'labelScope',
  status: 'labelStatus',
}

/** op 数据值 → 本地化标签（未知值回退原文）。 */
export function opLabel(t: T, op: string): string {
  const key = OP_KEY[op]
  return key === undefined ? op : t(key)
}

/** 操作日志 detail 的本地化：write/update/superseded 的小对象转中文键值；摄取/蒸馏请求的完整 JSON 保持原样（审计诚实性优先）。 */
export function formatOpDetail(t: T, op: string, detail: string | null): string {
  if (detail === null) return ''
  // 画像修订的小对象转成语义句（创建/编辑/回滚三式，与工具的 audit detail 键对齐）。
  if (op === 'profile-edit') {
    try {
      const parsed = JSON.parse(detail) as { action?: unknown; fromVersion?: unknown; toVersion?: unknown; restoredFrom?: unknown; chars?: unknown }
      const to = Number(parsed.toVersion)
      const chars = Number(parsed.chars)
      if (parsed.action === 'edit' && parsed.fromVersion === null) {
        return ` ${t('profileOpCreate', { to, chars })}`
      }
      const from = Number(parsed.fromVersion)
      if (parsed.action === 'edit') return ` ${t('profileOpEdit', { from, to, chars })}`
      const restored = Number(parsed.restoredFrom)
      if (parsed.action === 'rollback' && Number.isInteger(from) && Number.isInteger(to) && Number.isInteger(restored)) {
        return ` ${t('profileOpRollback', { from, to, restored, chars })}`
      }
    } catch {
      // detail 不是预期的 JSON：落到底部原样展示。
    }
    return ` ${detail}`
  }
  if (op === 'jev-fallback') {
    // Одна строка на срыв: где спрашивали, что сорвалось и сколько ждали. Полный JSON
    // здесь читать нечего — он и писался так, чтобы человеку хватило одной строки.
    try {
      const parsed = JSON.parse(detail) as { site?: unknown, question?: unknown, reason?: unknown, elapsedMs?: unknown }
      return ` ${t('opJevFallbackDetail', {
        site: String(parsed.site ?? '—'),
        question: String(parsed.question ?? '—'),
        reason: String(parsed.reason ?? '—'),
        ms: Number(parsed.elapsedMs ?? 0),
      })}`
    } catch {
      return ` ${detail}`
    }
  }
  if (op === 'vectors-missing') {
    try {
      const parsed = JSON.parse(detail) as { count?: unknown, scope?: unknown }
      return ` ${t('opVectorsMissingDetail', { count: Number(parsed.count ?? 0), scope: String(parsed.scope ?? '—') })}`
    } catch {
      return ` ${detail}`
    }
  }
  if (op !== 'write' && op !== 'update' && op !== 'superseded') return ` ${detail}`
  try {
    const parsed = JSON.parse(detail) as Record<string, unknown>
    const entries = Object.entries(parsed)
    if (entries.length === 0) return ` ${detail}`
    return ` ${entries.map(([key, value]) => {
      const label = DETAIL_KEY[key]
      if (label === undefined) return `${key}=${String(value)}`
      if (key === 'kind' && typeof value === 'string') return `${t(label)}=${kindLabel(t, value)}`
      if (key === 'scope' && (value === 'user' || value === 'project')) return `${t(label)}=${t(SCOPE_KEY[value])}`
      return `${t(label)}=${String(value)}`
    }).join(' · ')}`
  } catch {
    return ` ${detail}`
  }
}

/** 来源会话展示片段：截短的会话 id + 可选轮次。 */
export function sourceLabel(t: T, record: Pick<MemoryRow, 'sourceSessionId' | 'sourceRound'>): string {
  if (record.sourceSessionId === null) return t('sourceExplicit')
  const id = `${record.sourceSessionId.slice(0, 16)}…`
  const withRound = record.sourceRound === null
    ? id
    : `${id} ${t('round', { n: record.sourceRound })}`
  return t('sourceSession', { id: withRound })
}

/** 绝对时间（审计时间线等需要精确时刻的位置）。 */
export function fmtTime(ms: number): string {
  // 时间格式跟随浏览器环境语言（宿主界面语言通常与浏览器一致）。
  return new Date(ms).toLocaleString(navigator.language || 'zh-CN', { hour12: false })
}

/** 列表用的相对时间：1 分钟内「刚刚」，其后按分钟/小时/天取整。 */
export function relTime(t: T, ms: number): string {
  const diff = Math.max(0, Date.now() - ms)
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return t('timeJustNow')
  if (minutes < 60) return t('timeMinutesAgo', { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return t('timeHoursAgo', { n: hours })
  return t('timeDaysAgo', { n: Math.floor(hours / 24) })
}

/** Размер в человеческом виде: журнал показывает «сколько занимает на диске». */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(Math.max(0, Math.round(bytes)))} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

/** activity API 的行结构（两库 op_log 合并）。 */
export interface ActivityRow {
  readonly at: number
  readonly op: string
  readonly targetId: string
  readonly detail: string | null
  readonly scope: 'user' | 'project'
}

/** 活动日志 detail 的摘要：摄取/改写/压缩请求解析 JSON 字段，其余原样截断。
   窄侧栏下文本应尽量短，长详情交给 title 悬浮展示。 */
export function activityDetail(t: T, detail: string | null): string {
  if (detail === null) return ''
  try {
    const parsed = JSON.parse(detail) as Record<string, unknown>
    if (typeof parsed.round === 'number' && typeof parsed.userText === 'string') {
      const mode = typeof parsed.mode === 'string' ? ` · ${parsed.mode}` : ''
      return `${t('round', { n: parsed.round })}${mode} · ${parsed.userText.slice(0, 48)}`
    }
    if (typeof parsed.query === 'string' && Array.isArray(parsed.queries)) {
      return `${t('benchRewrite', { n: parsed.queries.length })} · ${parsed.query.slice(0, 36)}`
    }
    if (typeof parsed.count === 'number' && Object.keys(parsed).length === 1) {
      return t('benchCompress', { n: parsed.count })
    }
    if (typeof parsed.batchId === 'string' && typeof parsed.sufficient === 'boolean') {
      const refs = Array.isArray(parsed.refs) ? parsed.refs.length : 0
      return `${parsed.batchId} · ${t(parsed.sufficient ? 'assessAdequate' : 'assessInadequate')} · ${t('assessRefs', { n: refs })}`
    }
    // 闭馆整理汇总：scope + 归档 / 合并 / 跳过三项计数。
    if (typeof parsed.archived === 'number' && typeof parsed.merged === 'number' && typeof parsed.skipped === 'number') {
      const scope = parsed.scope === 'project' ? t('scopeProject') : t('scopeUser')
      return `${scope} · ${t('consolidateArchived', { n: parsed.archived })} · ${t('consolidateMerged', { n: parsed.merged })} · ${t('consolidateSkipped', { n: parsed.skipped })}`
    }
    // 衰减归档：只有 archived 计数。
    if (typeof parsed.archived === 'number' && parsed.merged === undefined) {
      return t('decayArchived', { n: parsed.archived })
    }
    if (typeof parsed.assigned === 'number') return t('slotBackfilled', { n: parsed.assigned })
    if (typeof parsed.room === 'string') return t('roomOpened', { room: parsed.room })
    if (typeof parsed.grade === 'number' && typeof parsed.nextIntervalDays === 'number') {
      return t('reviewAnswered', { grade: parsed.grade, days: parsed.nextIntervalDays })
    }
  } catch {
    // 非 JSON（outcome 值等）：走末尾原样截断。
  }
  return detail.length > 56 ? `${detail.slice(0, 56)}…` : detail
}

/** 日志筛选分组：op 枚举 → 分组（数据层英文枚举只在显示层映射）。 */
export type LogFilter = 'all' | 'write' | 'ingest' | 'retrieve' | 'organize'

export const LOG_GROUPS: Readonly<Record<LogFilter, readonly string[] | null>> = {
  all: null,
  write: ['write', 'update', 'forget', 'restore', 'decay', 'superseded', 'outcome-report'],
  ingest: ['ingest-request', 'ingest-done'],
  retrieve: ['search-rewrite-request', 'compress-request', 'assess'],
  organize: ['distill-request', 'consolidation', 'slot-assign', 'slot-backfill', 'room-open', 'review-answer', 'profile-edit'],
}

export const LOG_FILTER_KEY: Readonly<Record<LogFilter, EngramKey>> = {
  all: 'logFilterAll',
  write: 'logFilterWrite',
  ingest: 'logFilterIngest',
  retrieve: 'logFilterRetrieve',
  organize: 'logFilterOrganize',
}

/** 分组 → 行首色点类（与工具条计数、筛选分组同色）。 */
const LOG_DOT: Readonly<Record<'write' | 'ingest' | 'retrieve' | 'organize', string>> = {
  write: 'logDotWrite',
  ingest: 'logDotIngest',
  retrieve: 'logDotRetrieve',
  organize: 'logDotOrganize',
}

/** op 枚举 → 所属筛选分组（未归类返回 all）。 */
function logGroupOf(op: string): LogFilter {
  for (const group of ['write', 'ingest', 'retrieve', 'organize'] as const) {
    if (LOG_GROUPS[group]?.includes(op) === true) return group
  }
  return 'all'
}

/** 行首色点类名：未归类的 op 用中性灰点，避免出现无颜色的空列。 */
export function logDotClass(op: string): string {
  const group = logGroupOf(op)
  const base = styles.logDot ?? ''
  return group === 'all' ? base : `${base} ${styles[LOG_DOT[group]] ?? ''}`
}

/** Одна база дворца в отчёте о журнале (GET/POST /api/engram/log-info|log-clear). */
export interface LogStoragePart {
  readonly scope: string
  /** Абсолютный путь файла базы. */
  readonly path: string
  /** Размер файла вместе с WAL/SHM. */
  readonly fileBytes: number
  /** Строк в op_log. */
  readonly rows: number
  /** Байт текста записей журнала. */
  readonly bytes: number
  /** Только в ответе на очистку: сколько строк удалено. */
  readonly deleted?: number
  /** Сжался ли файл после очистки (VACUUM). */
  readonly vacuumed?: boolean
  /** Освободились ли страницы в главный файл (TRUNCATE-checkpoint: WAL обнулён). */
  readonly checkpointed?: boolean
}

/** Отчёт о журнале: где лежит, сколько занимает, сколько в нём строк. */
export interface LogStorageInfo {
  readonly dir: string
  readonly parts: readonly LogStoragePart[]
  readonly totals: {
    readonly fileBytes: number
    readonly rows: number
    readonly bytes: number
    readonly deleted?: number
    readonly vacuumed?: boolean
    readonly checkpointed?: boolean
  }
}
