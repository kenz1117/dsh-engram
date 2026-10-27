/**
 * 记忆库设置面板：统计卡片、过滤列表、批量操作、编辑（取代链）、遗忘/恢复、导出。
 * 数据经回环 API（/api/engram/*）读写；详情与编辑为条目下方行内展开
 * （不嵌套弹窗）；文案全部走宿主 locale 词典（zh/en），语言切换自动
 * 重渲染；数据层英文枚举（status/kind/op）只在显示层映射；内容节点
 * 一律 DOM/JSX 构建（防 XSS）。
 * @module @kenz1117/dsh-engram/client/EngramPanel
 */

import { Component, Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import styles from './panel.module.css'
import { KIND_KEY, type NS, en, ru, zh, type EngramKey } from './locales/index.ts'
import { CorridorMap, EDGE_STYLE, FloorplanMap, KIND_PALETTE } from './CorridorMap.tsx'
import { SpiralMap, type SpiralRecord } from './SpiralMap.tsx'
import spiralStyles from './spiral.module.css'
import { useToast, type ToastController } from './Toast.tsx'
import { usePersistedState, usePersistedString } from './UiStorage.ts'
import { IMPORT_BODY_LIMIT_BYTES } from '../body-limits.ts'
// Пределы — общие с сервером (src/i18n/dictionary-limits.ts): модуль без зависимостей,
// поэтому в клиентскую сборку не тянется ни модель, ни её клиент.
import { needsTranslation, splitDictionaryPatch, splitFillBatch } from '../i18n/dictionary-limits.ts'
import { windowLeft } from '../registry/palace-change.ts'
import pluginPackageJson from '../../package.json' with { type: 'json' }
import type {
  EpisodeTimelineAround,
  EpisodeTimelineAroundResponse,
  EpisodeTimelineGroupsResponse,
  EpisodeTimelineRow,
} from '../types.ts'

/** 客户端 bundle 版本：单一来源 = package.json（构建时内联）。版本握手横幅用（审计 F8）。 */
const CLIENT_VERSION: string = pluginPackageJson.version

/**
 * 线性图标库（Phosphor 风）：统一 24px viewBox、stroke 1.75、round cap/join、
 * 全部 currentColor（跟随宿主主题）。name prop 查表，避免每个调用点重复写 SVG。
 * @param name - 图标键（见 ICONS）
 * @param className - 调用方附加的样式类（tabIcon / scopeIcon / brandIcon 等）
 */
const ICONS = {
  // Tab 主导航（8 个视图）
  today: <><circle cx="12" cy="12" r="3" /><path d="M2 12h3M19 12h3M12 2v3M12 19v3" /></>,
  library: <><rect x="4" y="4" width="9" height="9" rx="1" /><rect x="11" y="11" width="9" height="9" rx="1" /></>,
  corridor: <><circle cx="5" cy="6" r="1.8" /><circle cx="19" cy="6" r="1.8" /><circle cx="12" cy="18" r="1.8" /><path d="M6.5 7.5L11 16.5M17.5 7.5L13 16.5M7 6h10" /></>,
  episodes: <><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" /></>,
  entities: <><path d="M12 3 L21 12 L12 21 L3 12 Z" /><circle cx="12" cy="12" r="2.5" /></>,
  beliefs: <><path d="M9 18h6" /><path d="M10 21h4" /><path d="M12 3a6 6 0 00-3.5 10.9c.7.5 1.1 1.2 1.3 2.1h4.4c.2-.9.6-1.6 1.3-2.1A6 6 0 0012 3z" /></>,
  log: <><line x1="5" y1="6" x2="19" y2="6" /><line x1="5" y1="12" x2="19" y2="12" /><line x1="5" y1="18" x2="13" y2="18" /></>,
  backfill: <><path d="M12 4v11" /><path d="M7 10l5 5 5-5" /><line x1="4" y1="20" x2="20" y2="20" /></>,
  jev: <><path d="M12 3 L4 8 V16 L12 21 L20 16 V8 Z" /><path d="M9 12l2 2 4-4" /></>,
  spiral: <><path d="M12 12 m -3 0 a 3 3 0 1 0 6 0 a 3 3 0 1 0 -6 0" /><path d="M12 12 m -7 0 a 7 7 0 1 0 14 0 a 7 7 0 1 0 -14 0" fill="none" /><path d="M12 12 m -11 0 a 11 11 0 1 0 22 0 a 11 11 0 1 0 -22 0" fill="none" strokeDasharray="2 3" /></>,
  // Scope 三宫格
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 20c0-4 4-6 8-6s8 2 8 6" /></>,
  project: <><path d="M3 7 L9 7 L11 5 L21 5 L21 17 L3 17 Z" /><line x1="3" y1="7" x2="3" y2="17" /></>,
  shared: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14 14 0 010 18" /><path d="M12 3a14 14 0 000 18" /></>,
  // 功能图标
  folder: <><path d="M3 7 L9 7 L11 5 L21 5 L21 17 L3 17 Z" /></>,
  refresh: <><path d="M3 12a9 9 0 0115-6.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 01-15 6.7L3 16" /><path d="M3 21v-5h5" /></>,
  export: <><path d="M12 15V4" /><path d="M8 8l4-4 4 4" /><path d="M4 15v3a2 2 0 002 2h12a2 2 0 002-2v-3" /></>,
  import: <><path d="M12 4v11" /><path d="M8 12l4 4 4-4" /><path d="M4 18v1a2 2 0 002 2h12a2 2 0 002-2v-1" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  brand: <><path d="M12 2 L14.5 9 L22 9.5 L16 14.5 L18 22 L12 17.5 L6 22 L8 14.5 L2 9.5 L9.5 9 Z" /></>,
} as const
type IconName = keyof typeof ICONS

/** SVG 图标组件：查表渲染，统一 stroke 风格。
 *  className 显式允许 undefined（exactOptionalPropertyTypes 下与 React.SVGAttributes 对齐）。 */
function Icon({ name, className }: { readonly name: IconName; readonly className?: string | undefined }): React.ReactElement {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {ICONS[name]}
    </svg>
  )
}

/** 列表/详情用的记忆视图（宿主 /api/engram/list 的行结构）。 */
interface MemoryRow {
  readonly id: string
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

interface ListResult {
  readonly records: MemoryRow[]
  readonly total: number
}

interface StatsPart {
  readonly scope: 'user' | 'project' | 'shared'
  readonly stats: {
    readonly total: number
    readonly active: number
    readonly archived: number
    readonly forgotten: number
    readonly redacted: number
    readonly signalRatio: number
    /** 各房间（kind）条目数；stats 路由的 byKind 字段（房间目录数据源）。 */
    readonly byKind?: Readonly<Record<string, number>>
  }
}

/** review API 的返回结构（详情行内展开区的数据源）。 */
interface ReviewView {
  readonly record: MemoryRow
  readonly supersededBy?: readonly string[]
  readonly supersedes?: readonly string[]
  readonly contradicts?: readonly string[]
  readonly related?: readonly string[]
  /** 修订历史（旧内容快照，按被取代时间倒序）。 */
  readonly revisions?: readonly { content: string; kind: string; importance: number; supersededAt: number }[]
  readonly operations?: readonly { at: number; op: string; detail: string | null }[]
}

/** 面板内部传递的翻译函数（渲染器按注册的 locale 声明合成的 t 的窄化签名）。 */
type T = (key: EngramKey, params?: Record<string, unknown>) => string

// 面板级词典合成与俄语复数抽到 translate.ts（审计批次 3）：纯函数零 react 依赖，
// client 测试直接可测。此处 re-export 维持既有引用面。
export { makeT, ruPluralForm } from './translate.ts'
import { makeT, type PanelLang } from './translate.ts'


/** kind 数据值（存储层英文枚举，编辑表单下拉的 value 保持英文）。 */
const KINDS = ['fact', 'preference', 'decision', 'episode', 'skill'] as const
const PAGE_SIZE = 20

/** 数据层枚举 → 词典键映射（显示层本地化，存储值不变）。 */
const STATUS_KEY: Record<MemoryRow['status'], EngramKey> = {
  active: 'statusActive',
  archived: 'statusArchived',
  forgotten: 'statusForgotten',
}
const SCOPE_KEY: Record<MemoryRow['scope'], EngramKey> = {
  user: 'scopeUser',
  project: 'scopeProject',
  shared: 'scopeShared',
}
/** 房间色相类（panel.module.css 的 .roomFact 等）；未知 kind 回退通用的 .kind。 */
const ROOM_CLASS: Record<string, string> = {
  fact: 'roomFact',
  preference: 'roomPreference',
  decision: 'roomDecision',
  episode: 'roomEpisode',
  skill: 'roomSkill',
}
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
const REL_KEY: Record<string, EngramKey> = {
  supersededBy: 'relSupersededBy',
  supersedes: 'relSupersedes',
  contradicts: 'relContradicts',
  related: 'relRelated',
}
/** 操作日志 detail JSON 的已知键 → 词典键（write/update/superseded 的小对象）。 */
const DETAIL_KEY: Record<string, EngramKey> = {
  kind: 'labelKind',
  scope: 'labelScope',
  status: 'labelStatus',
}

/** kind 数据值 → 本地化标签（未知值回退原文）。 */
function kindLabel(t: T, kind: string): string {
  const key = KIND_KEY[kind]
  return key === undefined ? kind : t(key)
}

/** 房间 pill 的类名：按 kind 取色相类，未知 kind 回退通用品牌色。 */
function roomPillClass(kind: string): string {
  return `${styles.pill} ${styles[ROOM_CLASS[kind] ?? 'kind'] ?? ''}`
}

/** op 数据值 → 本地化标签（未知值回退原文）。 */
function opLabel(t: T, op: string): string {
  const key = OP_KEY[op]
  return key === undefined ? op : t(key)
}

/** 操作日志 detail 的本地化：write/update/superseded 的小对象转中文键值；摄取/蒸馏请求的完整 JSON 保持原样（审计诚实性优先）。 */
function formatOpDetail(t: T, op: string, detail: string | null): string {
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
function sourceLabel(t: T, record: Pick<MemoryRow, 'sourceSessionId' | 'sourceRound'>): string {
  if (record.sourceSessionId === null) return t('sourceExplicit')
  const id = `${record.sourceSessionId.slice(0, 16)}…`
  const withRound = record.sourceRound === null
    ? id
    : `${id} ${t('round', { n: record.sourceRound })}`
  return t('sourceSession', { id: withRound })
}

import { api, setActiveProjectSelector, setProjectHealHandler } from './rpc.ts'
import { useApi } from './useApi.ts'
// 请求出口与项目作用域注入抽到 rpc.ts（审计批次 3）：useApi 复用 api() 不构成循环导入。
// api / setActiveProjectSelector / setProjectHealHandler 在此 re-export，组件内的既有
// 调用点与测试都不必改 import 来源。
export { api, setActiveProjectSelector, setProjectHealHandler } from './rpc.ts'

/** Размер в человеческом виде: журнал показывает «сколько занимает на диске». */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(Math.max(0, Math.round(bytes)))} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

/** Одна база дворца в отчёте о журнале (GET/POST /api/engram/log-info|log-clear). */
interface LogStoragePart {
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
interface LogStorageInfo {
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

/** host 项目宫殿清单的行（GET /api/engram/workspaces）。 */
interface EngramProjectItem {
  readonly dbName: string
  /** 工作区标题；host 给不出时为 null（显示回退路径末段 / dbName 短写）。 */
  readonly title?: string | null | undefined
  /** 该分库归属的工作目录；无法归属时 host 给 null 或直接省略该键。 */
  readonly path?: string | null | undefined
  /** workspace = 宿主注册表里的工作区；session = 只从会话 cwd 见到；process = 进程目录兜底。 */
  readonly kind: 'workspace' | 'session' | 'process'
  /** 项目标识来源（origin = git 仓库；cwd = 目录编码兜底）。 */
  readonly source: 'origin' | 'cwd'
  /** 宿主注册表里的工作区 id；对不上时 null（此时跟随只能按路径匹配）。 */
  readonly workspaceId?: string | null | undefined
  /** 库文件是否已存在（不存在时 memories 为 null）。 */
  readonly exists: boolean
  /** 库内记忆条数；库还不存在时为 null。 */
  readonly memories: number | null
}

/** GET /api/engram/workspaces 的返回（processDefault = 进程目录兜底库；缺席时 null）。 */
interface EngramWorkspacesView {
  readonly items: readonly EngramProjectItem[]
  readonly processDefault: { readonly dbName: string; readonly path: string | null; readonly title: string | null } | null
}

/** 宿主工作区视图（@deepseek-ai/dsh-api-workspace-controller/client 的 WorkspaceView 窄视图）。 */
export interface HostWorkspaceView {
  readonly workspaceId: string
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly string[]
}

/** 宿主可观察快照的窄视图（getSnapshot + subscribe；与 useSyncExternalStore 兼容）。 */
interface ObservableLike<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** 宿主工作区服务窄视图（可选注入；缺席时面板其余功能照常）。 */
export interface WorkspacesLike {
  readonly list: ObservableLike<{ readonly items: readonly HostWorkspaceView[] }>
}

/** 宿主会话清单服务窄视图（可选注入；判定当前工作区只看当前会话 id）。 */
export interface SessionsLike {
  readonly list: ObservableLike<{
    readonly current?: string | undefined
    /** 宿主新版本暴露 byId 映射（会话 id → 行含 retainedBy 持有计数）；旧版缺席。 */
    readonly byId?: Readonly<Record<string, { readonly id: string; readonly retainedBy?: { readonly mainView?: number } }>>
  }>
}

/** 空清单常量：useSyncExternalStore 的 getSnapshot 必须返回稳定引用。 */
const NO_WORKSPACES: readonly HostWorkspaceView[] = []

/** 服务缺席时的空订阅（保持 hook 调用形状一致）。 */
function noopUnsubscribe(): void { /* 无订阅可退 */ }

/**
 * 订阅宿主快照（useSyncExternalStore 的 subscribe 席位）。
 * 契约上返回退订函数；个别实现若返回 void，则退化为「不卸载」而不是抛错。
 */
function subscribeSnapshot<T>(source: ObservableLike<T> | undefined, onChange: () => void): () => void {
  if (source === undefined) return noopUnsubscribe
  const off = source.subscribe(onChange)
  return typeof off === 'function' ? off : noopUnsubscribe
}

/**
 * 当前 GUI 工作区：与侧边栏 WorkspacePicker 同一判定（工作区的 sessionIds 含当前会话）。
 * 两个宿主服务都可选：任一缺席时 available=false，chip 显示「无工作区信息（进程默认）」。
 * @param workspaces - 可选取用的宿主工作区服务。
 * @param sessions - 可选取用的宿主会话清单服务。
 * @returns 当前工作区（判定不出为 null）与服务是否齐备。
 */
function useCurrentWorkspace(workspaces: WorkspacesLike | undefined, sessions: SessionsLike | undefined): {
  workspace: HostWorkspaceView | null
  available: boolean
} {
  const subscribeWorkspaces = useCallback(
    (onChange: () => void): (() => void) => subscribeSnapshot(workspaces?.list, onChange),
    [workspaces],
  )
  const subscribeSessions = useCallback(
    (onChange: () => void): (() => void) => subscribeSnapshot(sessions?.list, onChange),
    [sessions],
  )
  const currentSessionId = useSyncExternalStore(subscribeSessions, () => {
    const snapshot = sessions?.list.getSnapshot()
    // #18：「current」在侧栏面板打开时会被宿主清空，follow 就掉回进程默认——改从
    // `byId` 找主视图仍持有的会话（`retainedBy.mainView > 0`），current 只作兜底。
    const byId = snapshot?.byId
    if (byId !== undefined) {
      const main = Object.values(byId).find(row => (row.retainedBy?.mainView ?? 0) > 0)
      if (main !== undefined) return main.id
    }
    return snapshot?.current ?? null
  })
  const items = useSyncExternalStore(subscribeWorkspaces, () => workspaces?.list.getSnapshot().items ?? NO_WORKSPACES)
  const available = workspaces !== undefined && sessions !== undefined
  if (!available || currentSessionId === null) return { workspace: null, available }
  return { workspace: items.find(item => item.sessionIds.includes(currentSessionId)) ?? null, available }
}

/** 路径比较键：统一分隔符、去尾斜杠、小写（GUI 与 host 的路径书写可能不一致，Windows 大小写不敏感）。 */
function pathKey(path: string): string {
  return path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

/** 路径末段（title 缺失时的回退显示名）。 */
function lastSegment(path: string): string {
  const normalized = path.replace(/[/\\]+$/, '')
  const at = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'))
  return at < 0 ? normalized : normalized.slice(at + 1)
}

/** dbName 短写：project-<hash>.db → project-<前 8 位>…（不符合该命名时按长度截断）。 */
function shortDbName(dbName: string): string {
  const match = /^project-([0-9a-f]+)\.db$/i.exec(dbName)
  return match === null ? dbName.slice(0, 14) : `project-${match[1]!.slice(0, 8)}…`
}

/** 项目库的显示名与「未注册工作区」标记：无法归属目录 → dbName 短写；否则 title > 路径末段。 */
function projectLabel(item: EngramProjectItem): { name: string; unregistered: boolean } {
  if (typeof item.path !== 'string' || item.path === '') return { name: shortDbName(item.dbName), unregistered: true }
  const title = item.title?.trim() ?? ''
  if (title !== '') return { name: title, unregistered: item.kind !== 'workspace' }
  return { name: lastSegment(item.path), unregistered: item.kind !== 'workspace' }
}

/** 下拉项文案：显示名（含未注册标记）· 记忆条数（库未建时给「—」，不显示 0）。 */
function projectOptionLabel(t: T, item: EngramProjectItem): string {
  const label = projectLabel(item)
  const parts = [label.unregistered ? `${label.name} · ${t('projectUnregistered')}` : label.name]
  parts.push(item.memories === null ? '—' : t('projectMemories', { n: item.memories }))
  return parts.join(' · ')
}

/** 跟随模式的目标：先按宿主工作区 id 匹配（最稳），对不上再按路径匹配；都匹配不到 → 进程默认库。 */
function matchFollowTarget(list: EngramWorkspacesView | null, workspace: HostWorkspaceView | null): EngramProjectItem | undefined {
  if (list === null || workspace === null) return undefined
  const byId = list.items.find(item => item.workspaceId === workspace.workspaceId)
  if (byId !== undefined) return byId
  const key = pathKey(workspace.path)
  return list.items.find(item => typeof item.path === 'string' && pathKey(item.path) === key)
}

/** 绝对时间（审计时间线等需要精确时刻的位置）。 */
function fmtTime(ms: number): string {
  // 时间格式跟随浏览器环境语言（宿主界面语言通常与浏览器一致）。
  return new Date(ms).toLocaleString(navigator.language || 'zh-CN', { hour12: false })
}

/** 列表用的相对时间：1 分钟内「刚刚」，其后按分钟/小时/天取整。 */
function relTime(t: T, ms: number): string {
  const diff = Math.max(0, Date.now() - ms)
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return t('timeJustNow')
  if (minutes < 60) return t('timeMinutesAgo', { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return t('timeHoursAgo', { n: hours })
  return t('timeDaysAgo', { n: Math.floor(hours / 24) })
}

/** 速览指标：大数 + 小标签 + sparkline + delta 行（v0.8.8 对齐设计稿 #sparkline）。 */
function Metric({ label, value, tail, spark, color, delta, deltaTone, tone }: {
  label: string
  value: string | number
  tail?: string | undefined
  /** 30 天趋势线：数组元素为该日值；无则不画。 */
  spark?: readonly number[] | undefined
  /** sparkline 颜色；不传走品牌色。 */
  color?: string | undefined
  /** sparkline 下的 delta 行（↑ +12 / 7 天 等）。 */
  delta?: string | undefined
  /** delta 语义色：up=成功色 / down=警示色 / flat=中性灰。 */
  deltaTone?: 'up' | 'down' | 'flat' | undefined
  /** 值色调：error 时数字点亮警示色（今日到期 > 0）。 */
  tone?: 'error' | undefined
}): React.ReactElement {
  let sparkEl: React.ReactElement | null = null
  if (spark !== undefined && spark.length >= 2) {
    const w = 120, h = 28
    const max = Math.max(...spark), min = Math.min(...spark)
    const range = Math.max(max - min, 1)
    const step = w / (spark.length - 1)
    const pts = spark.map((v, i) => {
      const x = i * step
      const y = h - 2 - ((v - min) / range) * (h - 4)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    }).join(' ')
    const lineColor = color ?? 'var(--dsw-alias-brand-primary)'
    const areaColor = `color-mix(in srgb, ${lineColor} 16%, transparent)`
    sparkEl = (
      <svg className={styles.metricSpark} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
        <polyline points={`0,${h} ${pts} ${w},${h}`} fill={areaColor} stroke="none" />
        <polyline points={pts} fill="none" stroke={lineColor} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    )
  }
  return (
    <div className={styles.metric}>
      <span className={styles.metricLabel}>{label}</span>
      <b className={tone === 'error' ? `${styles.metricValue} ${styles.metricValueError}` : styles.metricValue}>{value}</b>
      {sparkEl}
      {delta !== undefined && (
        <span className={deltaTone === 'up' ? `${styles.metricDelta} ${styles.metricDeltaUp}`
          : deltaTone === 'down' ? `${styles.metricDelta} ${styles.metricDeltaDown}`
            : styles.metricDelta}>{delta}</span>
      )}
      {tail !== undefined && <span className={styles.metricTail}>{tail}</span>}
    </div>
  )
}

/** 空态插画：宫殿剪影 + 标题 + 提示（v0.8.8 取代裸文案空态,往事/实体/信念/日志/陈展/走廊共用）。 */
/** 统一的 <select> 包装：内联 SVG 箭头 + focus-within 时变品牌色。
 * 取代 panel.module.css 里的 `select.input` 用 background-image 画箭头的 hack。
 * selectClassName 通常传 `${styles.input}` 或 `${styles.input} ${styles.wsSelect}` 等组合。 */
function SelectField({ selectClassName, value, onChange, children, ariaLabel, title }: {
  readonly selectClassName: string | undefined
  readonly value: string
  readonly onChange: (event: React.ChangeEvent<HTMLSelectElement>) => void
  readonly children: React.ReactNode
  readonly ariaLabel?: string | undefined
  readonly title?: string | undefined
}): React.ReactElement {
  return (
    <span className={styles.selectWrap}>
      <select className={selectClassName} value={value} onChange={onChange} aria-label={ariaLabel} title={title}>
        {children}
      </select>
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M6 9 L12 15 L18 9" />
      </svg>
    </span>
  )
}

function EmptyState({ title, hint }: { title: string; hint?: string | undefined }): React.ReactElement {
  return (
    <div className={styles.empty}>
      <span className={styles.emptyArt} aria-hidden="true">
        <svg viewBox="0 0 24 24" className={styles.emptyArtIcon}>
          <path d="M3 10 L12 4 L21 10" />
          <path d="M5 10 V20 H19 V10" />
          <path d="M10 20 V14 Q10 12 12 12 Q14 12 14 14 V20" />
          <rect x="6.5" y="12" width="2" height="2.5" rx="0.4" />
          <rect x="15.5" y="12" width="2" height="2.5" rx="0.4" />
        </svg>
      </span>
      <b>{title}</b>
      {hint !== undefined && <span>{hint}</span>}
    </div>
  )
}

/** 健康分环：SVG 描边进度（0-100），颜色随分数分档。v0.8.8 对齐设计稿：120px / stroke 8 / 分数 22px。 */
function HealthRing({ score, label }: { score: number; label: string }): React.ReactElement {
  const size = 120
  const radius = 48
  const stroke = 8
  const circumference = 2 * Math.PI * radius
  const filled = circumference * (Math.min(100, Math.max(0, score)) / 100)
  const tone = score >= 80 ? 'var(--dsw-alias-state-success-primary)'
    : score >= 50 ? 'var(--dsw-alias-state-warn-primary)'
      : 'var(--dsw-alias-state-error-primary)'
  return (
    <div className={styles.ringWrap}>
      <div className={styles.ring} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={score}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--dsw-alias-border-l2)" strokeWidth={stroke} />
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={tone} strokeWidth={stroke} strokeLinecap="round"
            strokeDasharray={`${filled.toFixed(1)} ${circumference.toFixed(1)}`} />
        </svg>
        <b>{score}</b>
      </div>
      <span className={styles.ringLabel}>{label}</span>
    </div>
  )
}

/** 页面头部：标题 + 副标题 + actions。v0.8+ 满宽主列需要页面身份感(之前只有 tab 一行)。 */
function PageHeader({ title, subtitle, actions }: {
  title: string
  subtitle?: string | undefined
  actions?: React.ReactNode | undefined
}): React.ReactElement {
  return (
    <header className={styles.pageHeader}>
      <div className={styles.pageHeaderMain}>
        <h2 className={styles.pageTitle}>{title}</h2>
        {subtitle !== undefined && <p className={styles.pageSubtitle}>{subtitle}</p>}
      </div>
      {actions !== undefined && <div className={styles.pageHeaderActions}>{actions}</div>}
    </header>
  )
}

/**
 * 活动热力日历：GitHub contributions 风的 90 天 7 行网格，每格代表一天的写入/摄取/修缮计数。
 * v0.8.1+ 嵌入「今日速览」Hero 下方做数据氛围。数据从 telemetry.dailyWrites 拿。
 * 没有数据时返回 null（占位让位不显示，避免空白区域显得奇怪）。
 */
function ActivityHeatmap({ t, daily }: { t: T; daily?: ReadonlyArray<{ dayMs: number; count: number }> | undefined }): React.ReactElement | null {
  if (daily === undefined || daily.length === 0) return null
  const max = Math.max(1, ...daily.map(d => d.count))
  // 把 daily 按"周"分列：先 pad 到周日，然后每 7 天一周
  const firstDayMs = daily[0]!.dayMs
  const firstDow = new Date(firstDayMs).getDay() // 0=Sun..6=Sat
  const cells: Array<{ dayMs: number; count: number; level: 0 | 1 | 2 | 3 | 4 } | null> = [
    ...Array(firstDow).fill(null),
    ...daily.map(d => {
      const ratio = d.count / max
      const level: 0 | 1 | 2 | 3 | 4 = d.count === 0 ? 0 : ratio < 0.25 ? 1 : ratio < 0.5 ? 2 : ratio < 0.75 ? 3 : 4
      return { dayMs: d.dayMs, count: d.count, level }
    }),
  ]
  // 补到 7 的倍数
  while (cells.length % 7 !== 0) cells.push(null)
  const weeks: Array<Array<typeof cells[number]>> = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
  const total = daily.reduce((acc, d) => acc + d.count, 0)
  const activeDays = daily.filter(d => d.count > 0).length
  return (
    <section className={`${styles.panelCard} ${styles.heatmapCard}`}>
      <div className={styles.heatmapHead}>
        <h4 className={styles.heatmapTitle}>{t('heatmapTitle')}</h4>
        <div className={styles.heatmapSummary}>
          <span><b>{total}</b> {t('heatmapTotal')}</span>
          <span><b>{activeDays}</b> {t('heatmapActiveDays')}</span>
        </div>
      </div>
      <div className={styles.heatmapGrid} role="grid" aria-label={t('heatmapTitle')}>
        {weeks.map((week, wi) => (
          // 一列 7 格，自上而下 Sun..Sat（与 GitHub 一致）
          <div key={wi} className={styles.heatmapCol}>
            {week.map((cell, di) => cell === null
              ? <span key={di} className={styles.heatmapCell} aria-hidden="true" />
              : <span key={di} className={`${styles.heatmapCell} ${styles[`heatmapL${cell.level}`]}`}
                  title={`${new Date(cell.dayMs).toLocaleDateString()} · ${cell.count} ${t('heatmapUnit')}`} />)}
          </div>
        ))}
      </div>
      <div className={styles.heatmapLegend} aria-hidden="true">
        <span>{t('heatmapLess')}</span>
        <span className={`${styles.heatmapCell} ${styles.heatmapL0}`} />
        <span className={`${styles.heatmapCell} ${styles.heatmapL1}`} />
        <span className={`${styles.heatmapCell} ${styles.heatmapL2}`} />
        <span className={`${styles.heatmapCell} ${styles.heatmapL3}`} />
        <span className={`${styles.heatmapCell} ${styles.heatmapL4}`} />
        <span>{t('heatmapMore')}</span>
      </div>
    </section>
  )
}

/** 细仪表条：重要性（品牌色）与置信（成功色）共用，conf 变体换色。 */
function Meter({ value, conf }: { value: number; conf?: boolean }): React.ReactElement {
  return (
    <span className={conf === true ? `${styles.meter} ${styles.conf}` : styles.meter}>
      <i style={{ width: `${String(Math.round(Math.min(1, Math.max(0, value)) * 100))}%` }} />
    </span>
  )
}

/** 关系 id 列表 → 等宽字体 chips（完整 id 放 title）。 */
function RelChips({ ids }: { ids: readonly string[] }): React.ReactElement {
  return (
    <div className={styles.relChips}>
      {ids.map(id => <span key={id} className={styles.relChip} title={id}>{id.slice(0, 18)}</span>)}
    </div>
  )
}

/** 行内审计区：属性网格 + 关系 chips + 操作时间线（review API）。 */
function ReviewBody({ t, recordId, scope, project }: {
  t: T
  recordId: string
  scope: 'user' | 'project' | 'shared'
  /** 项目宫殿选择器（仅用于重载依赖；注入在 api() 里做）。 */
  project: string | null
}): React.ReactElement {
  const [view, setView] = useState<ReviewView | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    api<ReviewView>(`review?scope=${scope}&id=${encodeURIComponent(recordId)}`)
      .then((data) => { if (!cancelled) setView(data) })
      .catch((error: Error) => { if (!cancelled) setFailed(error.message) })
    return () => { cancelled = true }
  }, [recordId, scope, project, t])
  if (failed !== null) return <div className={styles.expandLoading}>{t('loadFailed', { msg: failed })}</div>
  if (view === null) return <div className={styles.expandLoading}>{t('loading')}</div>
  const { record } = view
  const relations = (['supersededBy', 'supersedes', 'contradicts', 'related'] as const)
    .map(key => ({ key, label: REL_KEY[key], ids: view[key] ?? [] }))
    .filter(entry => entry.ids.length > 0)
  const operations = view.operations ?? []
  return (
    <div className={styles.reviewGrid}>
      <div>
        <dl className={styles.attrGrid}>
          <dt>{t('labelContent')}</dt>
          <dd>{record.content}</dd>
          <dt>{t('labelKind')}</dt>
          <dd><span className={roomPillClass(record.kind)}>{kindLabel(t, record.kind)}</span></dd>
          <dt>{t('labelStatus')}</dt>
          <dd><span className={`${styles.pill} ${styles[`status${record.status.charAt(0).toUpperCase()}${record.status.slice(1)}`] ?? ''}`}>{t(STATUS_KEY[record.status])}</span></dd>
          <dt>{t('importance')}</dt>
          <dd>{record.importance.toFixed(2)}<Meter value={record.importance} /></dd>
          <dt>{t('confidence')}</dt>
          <dd>{record.confidence.toFixed(2)}<Meter value={record.confidence} conf /></dd>
          <dt>{t('detailSource')}</dt>
          <dd>{sourceLabel(t, record)}</dd>
          <dt>{t('labelCreated')}</dt>
          <dd>{fmtTime(record.createdAt)}</dd>
        </dl>
        {relations.map(({ key, label, ids }) => (
          <div key={key} className={styles.relBlock}>
            <h5>{label === undefined ? key : t(label)}</h5>
            <RelChips ids={ids} />
          </div>
        ))}
      </div>
      <div>
        {(view.revisions ?? []).length > 0 && (
          <div className={styles.relBlock}>
            <h5>{t('detailRevisions')}</h5>
            <ul className={styles.timeline}>
              {view.revisions!.map((rev, index) => (
                <li key={index}>
                  <time>{fmtTime(rev.supersededAt)}</time>
                  <b>{kindLabel(t, rev.kind)}</b>
                  {' '}{rev.content}
                </li>
              ))}
            </ul>
          </div>
        )}
        {operations.length > 0 && (
          <div className={styles.relBlock}>
            <h5>{t('detailOperations')}</h5>
            <ul className={styles.timeline}>
              {operations.map((op, index) => (
                <li key={index}>
                  <time>{fmtTime(op.at)}</time>
                  <b>{opLabel(t, op.op)}</b>
                  {formatOpDetail(t, op.op, op.detail)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}

/** 行内编辑表单：内容/种类/重要性 → POST update（旧条目归档，取代链保留）。 */
function EditForm({ t, record, onClose, onSaved, toast }: {
  t: T
  record: MemoryRow
  onClose: () => void
  onSaved: () => void
  toast: ToastController
}): React.ReactElement {
  const [content, setContent] = useState(record.content)
  const [kind, setKind] = useState(record.kind)
  const [importance, setImportance] = useState(record.importance)
  const save = (): void => {
    api('update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: record.id, scope: record.scope, content, kind, importance }),
    })
      .then(onSaved)
      .catch((error: Error) => { toast.push('error', error.message) })
  }
  return (
    <div className={styles.editForm}>
      <div>
        <label className={styles.fieldLabel}>{t('labelContent')}</label>
        <textarea className={styles.input} rows={3} value={content} onChange={event => setContent(event.target.value)} />
      </div>
      <div>
        <label className={styles.fieldLabel}>{t('labelKind')}</label>
        {/* option 的 value 保持数据层英文枚举，仅显示文本本地化。 */}
        <SelectField selectClassName={styles.input} value={kind} onChange={event => setKind(event.target.value)}>
          {KINDS.map(option => <option key={option} value={option}>{kindLabel(t, option)}</option>)}
        </SelectField>
      </div>
      <div className={styles.fieldRow}>
        <div>
          <label className={styles.fieldLabel}>{`${t('importance')} ${importance.toFixed(2)}`}</label>
          <input type="range" min={0} max={1} step={0.05} value={importance}
            onChange={event => setImportance(Number(event.target.value))} />
        </div>
      </div>
      <div className={styles.modalFoot}>
        <button type="button" className={styles.button} onClick={onClose}>{t('cancel')}</button>
        <button type="button" className={`${styles.button} ${styles.primary}`} onClick={save}>{t('saveWithHint')}</button>
      </div>
    </div>
  )
}

/** search-test API 的命中行。 */
interface BenchHit {
  readonly id: string
  readonly score: number
  readonly via: 'fts' | 'vec' | 'both'
  readonly viaEdge?: { readonly from: string; readonly type: string }
  readonly scope: string
  readonly kind: string
  readonly content: string
}

/** search-test API 的返回结构。 */
interface BenchResult {
  readonly degraded: boolean
  readonly hits: readonly BenchHit[]
}

/** activity API 的行结构（两库 op_log 合并）。 */
interface ActivityRow {
  readonly at: number
  readonly op: string
  readonly targetId: string
  readonly detail: string | null
  readonly scope: 'user' | 'project'
}

/** 命中道 → 词典键。 */
const VIA_KEY: Record<BenchHit['via'], EngramKey> = { fts: 'viaFts', vec: 'viaVec', both: 'viaBoth' }

/** 召回测试台：输入查询跑真实检索，展示得分、命中原委（关键词/语义/边扩展）与内容。 */
function RecallBench({ t, scope }: { t: T; scope: 'user' | 'project' | 'shared' }): React.ReactElement {
  const [query, setQuery] = useState('')
  /** 默认随观察 scope，但用户可在 select 内手动切换 'all' / 其它；切换观察 scope 时重置。 */
  const [benchScope, setBenchScope] = useState<string>(scope)
  const [result, setResult] = useState<BenchResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 观察 scope 变化时同步 benchScope（用户在 select 里改过的「all」会被覆盖——刻意保持一致性）。
  useEffect(() => { setBenchScope(scope) }, [scope])
  const run = (): void => {
    if (query.trim() === '' || busy) return
    setBusy(true)
    // forceProject：'all' 模式（user + project）与 project 模式都要用当前选中的项目分库。
    api<BenchResult>(`search-test?q=${encodeURIComponent(query.trim())}&scope=${benchScope}`, undefined, true)
      .then((data) => { setResult(data); setError(null) })
      .catch((benchError: Error) => setError(benchError.message))
      .finally(() => setBusy(false))
  }
  const hits = result?.hits ?? []
  return (
    <div>
      <div className={styles.benchBar}>
        <input className={`${styles.input} ${styles.search}`} placeholder={t('benchPlaceholder')} value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') run() }} />
        <SelectField selectClassName={styles.input} value={benchScope}
          onChange={event => setBenchScope(event.target.value)}>
          <option value="all">{t('benchScopeAll')}</option>
          <option value="user">{t('scopeUser')}</option>
          <option value="project">{t('scopeProject')}</option>
          <option value="shared">{t('scopeShared')}</option>
        </SelectField>
        <button type="button" className={`${styles.button} ${styles.primary}`}
          disabled={busy || query.trim() === ''} onClick={run}>{t('benchRun')}</button>
      </div>
      {error !== null && <div className={styles.expandLoading}>{t('loadFailed', { msg: error })}</div>}
      {result !== null && error === null && (
        <div className={styles.benchMeta}>
          <span>{t('benchHits', { n: hits.length })}</span>
          {result.degraded && <span className={styles.degradedNote}>{t('benchDegraded')}</span>}
        </div>
      )}
      <div className={styles.benchList}>
      {hits.map(hit => (
        <div key={hit.id} className={styles.benchRow}>
          <div className={styles.benchHead}>
            <span className={styles.viaChip}>{t(VIA_KEY[hit.via])}</span>
            {hit.viaEdge !== undefined && (
              <span className={styles.viaChip}
                title={`${hit.viaEdge.type} ${hit.viaEdge.from}`}>{t('viaEdgeLabel')} · {hit.viaEdge.type}</span>
            )}
            <span className={roomPillClass(hit.kind)}>{kindLabel(t, hit.kind)}</span>
            <span className={styles.benchScore}>{hit.score.toFixed(4)}</span>
          </div>
          <div className={styles.benchContent}>{hit.content}</div>
          <span className={styles.benchId} title={hit.id}>{hit.id}</span>
        </div>
      ))}
      </div>
      {result !== null && hits.length === 0 && error === null && (
        <div className={styles.benchEmpty}>{t('benchEmpty')}</div>
      )}
    </div>
  )
}

/** 活动日志 detail 的摘要：摄取/改写/压缩请求解析 JSON 字段，其余原样截断。
   窄侧栏下文本应尽量短，长详情交给 title 悬浮展示。 */
function activityDetail(t: T, detail: string | null): string {
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
type LogFilter = 'all' | 'write' | 'ingest' | 'retrieve' | 'organize'
const LOG_GROUPS: Readonly<Record<LogFilter, readonly string[] | null>> = {
  all: null,
  write: ['write', 'update', 'forget', 'restore', 'decay', 'superseded', 'outcome-report'],
  ingest: ['ingest-request', 'ingest-done'],
  retrieve: ['search-rewrite-request', 'compress-request', 'assess'],
  organize: ['distill-request', 'consolidation', 'slot-assign', 'slot-backfill', 'room-open', 'review-answer', 'profile-edit'],
}
const LOG_FILTER_KEY: Readonly<Record<LogFilter, EngramKey>> = {
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
function logDotClass(op: string): string {
  const group = logGroupOf(op)
  const base = styles.logDot ?? ''
  return group === 'all' ? base : `${base} ${styles[LOG_DOT[group]] ?? ''}`
}

/** 行级 LCS 对齐：把两段文本按行 diff，输出 same/add/del 序列（行数少，O(n·m) DP 足够）。 */
function lineDiff(oldText: string, newText: string): readonly { kind: 'same' | 'add' | 'del'; text: string }[] {
  const a = oldText.split('\n')
  const b = newText.split('\n')
  const m = a.length
  const n = b.length
  // dp[i][j] = a[i..] 与 b[j..] 的最长公共子序列长度（末行/末列补 0）。
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const rows: { kind: 'same' | 'add' | 'del'; text: string }[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) { rows.push({ kind: 'same', text: a[i]! }); i += 1; j += 1 }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { rows.push({ kind: 'del', text: a[i]! }); i += 1 }
    else { rows.push({ kind: 'add', text: b[j]! }); j += 1 }
  }
  while (i < m) { rows.push({ kind: 'del', text: a[i]! }); i += 1 }
  while (j < n) { rows.push({ kind: 'add', text: b[j]! }); j += 1 }
  return rows
}

/** profile-block 路由的响应体（block 为 null = 该 scope 尚未创建 curated block）。 */
interface ProfileBlockView {
  scope: string
  block: { content: string; version: number; updatedAt: number } | null
  versions: readonly { version: number; content: string; source: string; at: number }[]
}

/**
 * 画像 curated block 审计卡：当前内容 + 版本历史 + 任意两版本的行级 diff。
 * 只读视图（编辑走 engram_profile_edit 工具，乐观锁在存储层）；scope/project 变化时重载。
 */
function ProfileCard({ t, scope, project }: { t: T; scope: 'user' | 'project' | 'shared'; project: string | null }): React.ReactElement {
  const [data, setData] = useState<ProfileBlockView | null>(null)
  const [failed, setFailed] = useState(false)
  const [baseVersion, setBaseVersion] = useState<number | null>(null)
  const [targetVersion, setTargetVersion] = useState<number | null>(null)
  useEffect(() => {
    let cancelled = false
    api<ProfileBlockView>(`profile-block?scope=${scope}`, undefined, true)
      .then((view) => {
        if (cancelled) return
        setData(view)
        setFailed(false)
        // 默认对比：基准 = 上一版，目标 = 当前版（仅一版时不启用 diff）。
        setBaseVersion(view.versions.length > 1 ? view.versions[1]!.version : null)
        setTargetVersion(view.versions.length > 0 ? view.versions[0]!.version : null)
      })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [scope, project])
  if (failed) {
    return <div className={styles.expandLoading}>{t('profileLoadFailed')}</div>
  }
  if (data === null) {
    return <div className={styles.expandLoading}>{t('loading')}</div>
  }
  if (data.block === null) {
    return (
      <div className={styles.expandLoading}>
        <p>{t('profileEmpty')}</p>
        <p className={styles.sectionHint}>{t('profileEmptyHint')}</p>
      </div>
    )
  }
  const versions = data.versions
  const byVersion = new Map(versions.map(version => [version.version, version]))
  const base = baseVersion === null ? undefined : byVersion.get(baseVersion)
  const target = targetVersion === null ? undefined : byVersion.get(targetVersion)
  const diffRows = base !== undefined && target !== undefined ? lineDiff(base.content, target.content) : []
  const hasDiff = diffRows.some(row => row.kind !== 'same')
  return (
    <div className={styles.profileCard}>
      <h5 className={styles.profileHeading}>{t('profileCurrent', { n: data.block.version })}</h5>
      <pre className={styles.profileContent}>{data.block.content}</pre>
      {versions.length > 1 && (
        <>
          <h5 className={styles.profileHeading}>{t('profileHistory')}</h5>
          <div className={styles.profilePickerRow}>
            <label>
              <span className={styles.sectionHint}>{t('profileDiffBase')}</span>
              <select className={styles.profileSelect} value={baseVersion ?? undefined}
                onChange={event => { setBaseVersion(Number(event.target.value)) }}>
                {versions.map(version => (
                  <option key={version.version} value={version.version}>
                    v{version.version} · {version.source === 'rollback' ? t('profileSourceRollback') : t('profileSourceEdit')}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className={styles.sectionHint}>{t('profileDiffTarget')}</span>
              <select className={styles.profileSelect} value={targetVersion ?? undefined}
                onChange={event => { setTargetVersion(Number(event.target.value)) }}>
                {versions.map(version => (
                  <option key={version.version} value={version.version}>
                    v{version.version} · {version.source === 'rollback' ? t('profileSourceRollback') : t('profileSourceEdit')}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {base !== undefined && target !== undefined && (
            <div className={styles.profileDiff}>
              {hasDiff
                ? diffRows.map((row, index) => (
                  <div key={index} className={
                    row.kind === 'add' ? styles.profileDiffAdd : row.kind === 'del' ? styles.profileDiffDel : styles.profileDiffSame
                  }>{row.kind === 'add' ? '+ ' : row.kind === 'del' ? '- ' : '  '}{row.text}</div>
                ))
                : <div className={styles.sectionHint}>{t('profileDiffNone')}</div>}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** 加载失败行（紧凑）：文案 + 重试按钮，用于卡片内失败态；整页失败态用 EmptyState。
 *  #S3（审计）：禁止 catch 里把失败伪装成空态——失败与健康必须可区分。 */
function LoadFailedLine({ t, msg, onRetry }: { t: T; msg: string; onRetry: () => void }): React.ReactElement {
  return (
    <div className={styles.expandLoading}>
      {t('loadFailed', { msg })}
      <button type="button" className={styles.button} onClick={onRetry}>{t('retry')}</button>
    </div>
  )
}

/** 视图级错误边界（审计 §1.1）：单个页签渲染异常降级为错误卡 + 重载按钮，
 *  不再放大成宿主 slot 错误边界那种「整面板白屏且无恢复 UI」。
 *  key=activeTab：切页签即换边界实例，错误不跨页签扩散；重试经 remount 重新拉取。
 *  注意这只是兜底：新增响应字段仍必须可选 + 兜底（见 CONTRIBUTING 契约约定）。
 *
 *  兜底卡里带组件栈：错误消息只说「哪里错了」（「Cannot read properties of
 *  undefined (reading 'id')」），组件栈才说「哪个视图错了」——反馈时带上它，
 *  一次就能定位到具体组件，不必再复现一遍。 */
class ViewErrorBoundary extends Component<{
  children: React.ReactNode
  retryLabel: string
  hintLabel: string
}, { error: Error | null; tick: number; stack: string }> {
  override state: { error: Error | null; tick: number; stack: string } = { error: null, tick: 0, stack: '' }
  static getDerivedStateFromError(error: Error): { error: Error | null; tick: number; stack: string } {
    return { error, tick: 0, stack: '' }
  }
  override componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
    const stack = info.componentStack ?? ''
    this.setState({ stack })
    console.error('[engram] 视图渲染失败', error, stack)
  }
  private readonly handleRetry = (): void => {
    this.setState(previous => ({ error: null, tick: previous.tick + 1, stack: '' }))
  }
  override render(): React.ReactNode {
    const { error, tick, stack } = this.state
    if (error !== null) {
      return (
        <div className={styles.tabPanel}>
          <div className={styles.panelCard}>
            <EmptyState title={this.props.hintLabel} hint={error.message} />
            {stack !== '' && (
              <pre className={styles.crashStack}>{stack.trim().split('\n').slice(0, 12).join('\n')}</pre>
            )}
            <div className={styles.expandLoading}>
              <button type="button" className={styles.button} onClick={this.handleRetry}>{this.props.retryLabel}</button>
            </div>
          </div>
        </div>
      )
    }
    return <Fragment key={tick}>{this.props.children}</Fragment>
  }
}

/**
 * 管家日志整页视图：顶部近 7 天三个计数，下面是两库合并的完整 op_log
 * （时间 · 操作 · 宫殿 · 摘要），可按操作类别筛选；不再限高裁切，供逐条审计。
 * user 侧照旧合并，project 侧跟随项目宫殿选择器（api 的 forceProject）。
 */
function LogPanel({ t, telemetry, project, onCleared }: {
  t: T
  telemetry: TelemetrySnapshot | null
  /** 项目宫殿选择器（仅用于重载依赖；注入在 api() 里做）。 */
  project: string | null
  /** 清理成功后回调：让总览遥测（瓦片计数）跟着重取，否则它显示的是清理前的旧值。 */
  onCleared?: (() => void) | undefined
}): React.ReactElement {
  const [rows, setRows] = useState<ActivityRow[] | null>(null)
  const [filter, setFilter] = useState<LogFilter>('all')
  const [failed, setFailed] = useState<string | null>(null)
  const [reloadTick, setReloadTick] = useState(0)
  // Журнал дворца — наш собственный: показываем путь и размер, и даём его очистить.
  const [storage, setStorage] = useState<LogStorageInfo | null>(null)
  const [storageFailed, setStorageFailed] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  useEffect(() => {
    let cancelled = false
    api<{ operations: ActivityRow[] }>('activity?limit=50', undefined, true)
      .then((data) => { if (!cancelled) { setRows(data.operations); setFailed(null) } })
      .catch((error: Error) => { if (!cancelled) setFailed(error.message) })
    api<LogStorageInfo>('log-info', undefined, true)
      .then((data) => { if (!cancelled) { setStorage(data); setStorageFailed(null) } })
      .catch((error: Error) => { if (!cancelled) setStorageFailed(error.message) })
    return () => { cancelled = true }
  }, [project, reloadTick])
  /** Очистка журнала: первый клик — вопрос, второй — действие (как у прочих удалений). */
  const clearLog = (): void => {
    if (!confirmClear) { setConfirmClear(true); return }
    setClearing(true)
    api<LogStorageInfo>('log-clear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, true)
      .then((data) => {
        setStorage(data)
        setStorageFailed(null)
        setNotice(t('logClearDone', { n: data.totals.deleted ?? 0, size: formatBytes(data.totals.fileBytes) }))
        setConfirmClear(false)
        setReloadTick(tick => tick + 1)
        // Счётчики-瓦плики берутся из telemetry всего обзора: без этого они остались бы
        // от предыдущей (до очистки) загрузки — показали бы уже удалённые строки.
        onCleared?.()
      })
      .catch((error: Error) => { setStorageFailed(error.message); setConfirmClear(false) })
      .finally(() => { setClearing(false) })
  }
  const allow = LOG_GROUPS[filter]
  const visible = (rows ?? []).filter(row => allow === null || allow.includes(row.op))
  const counts = telemetry?.counts
  return (
    <section className={styles.section}>
      {/* 一条工具条：标题 + 条数 + 近 7 天三类计数（带类别色点）+ 类别筛选，
          取代原先「独立计数卡 + 筛选行」两段式。 */}
      {/* v0.8.8 近 7 天四类计数升级为 stat 瓦片行 */}
      <div className={styles.logTiles}>
        <div className={styles.logTile}>
          <span className={styles.logTileTop}><i className={`${styles.logDot} ${styles.logDotWrite}`} aria-hidden="true" />{t('logFilterWrite')}</span>
          <b className={styles.logTileValue}>{counts?.writes ?? 0}</b>
        </div>
        <div className={styles.logTile}>
          <span className={styles.logTileTop}><i className={`${styles.logDot} ${styles.logDotIngest}`} aria-hidden="true" />{t('logFilterIngest')}</span>
          <b className={styles.logTileValue}>{counts?.ingestDones ?? 0}</b>
        </div>
        <div className={styles.logTile}>
          <span className={styles.logTileTop}><i className={`${styles.logDot} ${styles.logDotRetrieve}`} aria-hidden="true" />{t('logFilterRetrieve')}</span>
          <b className={styles.logTileValue}>{counts?.searches ?? 0}</b>
        </div>
        <div className={styles.logTile}>
          <span className={styles.logTileTop}><i className={`${styles.logDot} ${styles.logDotOrganize}`} aria-hidden="true" />{t('logFilterOrganize')}</span>
          <b className={styles.logTileValue}>{counts?.consolidations ?? 0}</b>
        </div>
      </div>
      <div className={styles.logToolbar}>
        <h4 className={styles.sectionTitle}>{t('tabLog')}</h4>
        <span className={styles.sectionHint}>{t('logCount', { n: visible.length })}</span>
        <div className={styles.segGroup} role="tablist">
          {(['all', 'write', 'ingest', 'retrieve', 'organize'] as const).map(option => (
            <button key={option} type="button" role="tab" aria-selected={filter === option}
              className={filter === option ? `${styles.segItem} ${styles.on}` : styles.segItem}
              onClick={() => { setFilter(option) }}>{t(LOG_FILTER_KEY[option])}</button>
          ))}
        </div>
      </div>
      {/* Журнал дворца — наш собственный: путь, размер и кнопка очистки. Журналы хост-сессий
          (dsh) сюда не попадают вовсе: мы их не читаем и не трогаем. */}
      <div className={styles.logStorage}>
        <div className={styles.logStorageMain}>
          <span className={styles.logStoragePath} title={storage?.dir ?? ''}>{t('logStoragePath', { path: storage?.dir ?? '…' })}</span>
          <span className={styles.logStorageSize}>{storage === null ? t('loading') : formatBytes(storage.totals.fileBytes)}</span>
          <button type="button" className={styles.button} disabled={clearing || storage === null} onClick={clearLog}>
            {confirmClear ? t('logClearConfirm') : t('logClear')}
          </button>
        </div>
        <div className={styles.logStorageParts}>
          {(storage?.parts ?? []).map(part => (
            <span key={part.path} className={styles.logStoragePart} title={part.path}>
              {t('logStoragePart', { file: part.path.split(/[\\/]/).pop() ?? part.path, size: formatBytes(part.fileBytes), n: part.rows })}
            </span>
          ))}
        </div>
        <span className={styles.logStorageHint}>{t('logStorageHint')}</span>
        {notice === null ? null : <span className={styles.logStorageNotice}>{notice}</span>}
        {storageFailed === null ? null : <LoadFailedLine t={t} msg={storageFailed} onRetry={() => { setReloadTick(tick => tick + 1) }} />}
      </div>
      <div className={styles.panelCard}>
        {failed !== null
          ? <LoadFailedLine t={t} msg={failed} onRetry={() => { setReloadTick(tick => tick + 1) }} />
          : rows === null
          ? <div className={styles.expandLoading}>{t('loading')}</div>
          : visible.length === 0
            ? <EmptyState title={t('activityEmpty')} hint={t('emptyHint')} />
            : (
              <div className={styles.logList}>
                {visible.map((op, index) => (
                  <div key={index} className={styles.logRow}>
                    <i className={logDotClass(op.op)} aria-hidden="true" />
                    <span className={styles.logTime}>{relTime(t, op.at)}</span>
                    <span className={styles.logOp}>{opLabel(t, op.op)}</span>
                    <span className={styles.logScope}>{op.scope === 'user' ? t('scopeUser') : t('scopeProject')}</span>
                    <span className={styles.logDetail} title={op.detail ?? ''}>{activityDetail(t, op.detail)}</span>
                  </div>
                ))}
              </div>
            )}
      </div>
    </section>
  )
}

/** 入殿导航：根据当前 scope 的 active 记忆给出开场邀请 + 候选记忆列表；点击可展开抽屉。
 *  顶部 kind chip（全部 / fact / preference / decision / episode / skill）切换 focusKind，
 *  触发后端按该 kind 优先选前 N 条作为开场建议。 */
function TourProposalCard({ t, scope, project, onSelect }: {
  t: T
  scope: 'user' | 'project' | 'shared'
  /** 项目宫殿选择器（仅用于重载依赖；注入在 api() 里做）。 */
  project: string | null
  onSelect: (id: string) => void
}): React.ReactElement {
  interface Stop { id: string; kind: string; content: string; importance: number; confidence: number }
  interface Proposal { greeting: string; activeCount: number; empty: boolean; suggestedStops: readonly Stop[] }
  const KINDS_FOCUS = ['', 'fact', 'preference', 'decision', 'episode', 'skill'] as const
  const [focusKind, setFocusKind] = usePersistedState<string>('tour.focusKind', '', KINDS_FOCUS)
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [reloadTick, setReloadTick] = useState(0)
  useEffect(() => {
    let cancelled = false
    const path = focusKind === ''
      ? `tour-proposal?scope=${scope}`
      : `tour-proposal?scope=${scope}&focusKind=${focusKind}`
    api<Proposal>(path)
      .then((data) => { if (!cancelled) { setProposal(data); setFailed(null) } })
      .catch((error: Error) => { if (!cancelled) setFailed(error.message) })
    return () => { cancelled = true }
  }, [t, scope, project, focusKind, reloadTick])
  const labelKind = (kind: string): string => {
    if (kind === '') return t('tourFocusAll')
    const key = KIND_KEY[kind]
    return key === undefined ? kind : t(key)
  }
  if (failed !== null) return <LoadFailedLine t={t} msg={failed} onRetry={() => { setReloadTick(tick => tick + 1) }} />
  if (proposal === null) return <div className={styles.expandLoading}>{t('loading')}</div>
  return (
    <div className={styles.tourProposal}>
      <div className={styles.chipRow} role="tablist" aria-label="focus-kind">
        {KINDS_FOCUS.map(kind => (
          <button key={kind || 'all'} type="button" role="tab"
            aria-selected={focusKind === kind}
            className={focusKind === kind ? `${styles.chip} ${styles.chipOn}` : styles.chip}
            onClick={() => { setFocusKind(kind) }}>
            {labelKind(kind)}
          </button>
        ))}
      </div>
      {proposal.empty
        ? <div className={styles.expandLoading}>{t('tourProposalEmpty')}</div>
        : (
          <>
            <p className={styles.tourGreeting}>{proposal.greeting}</p>
            <ol className={styles.tourStops}>
              {proposal.suggestedStops.map((stop, index) => (
                <li key={stop.id}>
                  <button type="button" className={styles.tourStop} onClick={() => { onSelect(stop.id) }}>
                    <span className={styles.tourStopIndex}>{index + 1}</span>
                    <span className={styles.tourStopBody}>
                      <span className={styles.tourStopKind}>{kindLabel(t, stop.kind)}</span>
                      <span className={styles.tourStopText}>{stop.content.length > 60 ? `${stop.content.slice(0, 60)}…` : stop.content}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
            <p className={styles.tourHint}>{t('tourProposalHint')}</p>
          </>
        )}
    </div>
  )
}

/** 旧后端（<0.8.15）的 refurb 响应没有 candidatePreviews 字段：用稳定空数组兜底，避免每次渲染新建引用。 */
const EMPTY_PREVIEWS: readonly { id: string; kind: string; content: string; importance: number }[] = []

/** 翻新清单：扫描 active 条目，给出 merge / demote / review / split 四类建议；带手动刷新 + 写回按钮。
 *  - review / split：跳到对应记忆抽屉查看（无副作用）。
 *  - demote：调用 engram_forget（带三问墓志铭），记忆转 archived。
 *  - merge：触发当前 scope 的 engram_distill（用户级闭馆整理），把多条相似记忆蒸馏为一条高层规律。 */
function RefurbCard({ t, scope, project, onSelect, onAfterAction, toast, lang }: {
  t: T
  scope: 'user' | 'project' | 'shared'
  /** 项目宫殿选择器（仅用于重载依赖；注入在 api() 里做）。 */
  project: string | null
  onSelect: (id: string) => void
  onAfterAction: () => void
  toast: ToastController
  /** 面板语言（审计 I1）：理由文案在服务端按此语言生成——服务端进程语言在启动时冻结，不能代表面板当前语言。 */
  lang: PanelLang
}): React.ReactElement {
  interface MemoryPreview { id: string; kind: string; content: string; importance: number }
  interface Suggestion {
    action: 'merge' | 'demote' | 'review' | 'split'
    primaryId: string
    candidates: readonly string[]
    reason: string
    confidence: number
    /** #19：主记忆原文（0.9.1 起全量返回），执行前给用户看原文。旧后端（<0.8.15）缺省。 */
    primary?: MemoryPreview | null
    /** #19：merge 候选的内容摘要，展示被合并的对象。旧后端（<0.8.15）缺省。 */
    candidatePreviews?: readonly MemoryPreview[]
  }
  interface RefurbReport { count: number; suggestions: readonly Suggestion[] }
  const [report, setReport] = useState<RefurbReport | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const reload = useCallback(() => {
    setBusy(true)
    api<RefurbReport>(`refurb?scope=${scope}&lang=${lang}`)
      .then((data) => { setReport(data); setFailed(null) })
      .catch((error: Error) => { setFailed(error.message) })
      .finally(() => { setBusy(false) })
  }, [scope, project, lang])
  useEffect(() => { reload() }, [reload])
  const labelOf = (action: Suggestion['action']): string => {
    switch (action) {
      case 'demote': return t('refurbActionDemote')
      case 'merge': return t('refurbActionMerge')
      case 'review': return t('refurbActionReview')
      case 'split': return t('refurbActionSplit')
    }
  }
  /** 执行建议：review/split 仅跳转；demote/merge 调写接口。 */
  const execute = useCallback((suggestion: Suggestion) => {
    if (suggestion.action === 'review' || suggestion.action === 'split') {
      onSelect(suggestion.primaryId)
      return
    }
    if (suggestion.action === 'demote') {
      if (!window.confirm(t('refurbConfirmDemote'))) return
      setBusy(true)
      // 墓志铭三问走词典（审计 I3）：原先是硬编码中文字面量，EN/RU 用户的 op_log 里全是中文。
      api<{ id: string }>('forget', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: suggestion.primaryId,
          scope,
          reason: t('refurbDemoteReasonText'),
          affects: t('refurbDemoteAffects'),
          stillUseful: t('refurbDemoteStillUseful'),
        }),
      })
        .then(() => {
          reload()
          onAfterAction()
          toast.push('success', t('refurbDemoteDone'))
        })
        .catch((error: Error) => { toast.push('error', t('refurbActionFailed', { msg: error.message })) })
        .finally(() => { setBusy(false) })
      return
    }
    if (suggestion.action === 'merge') {
      const n = suggestion.candidates.length + 1
      if (n < 2) {
        toast.push('warning', t('refurbMergeEmpty'))
        return
      }
      if (!window.confirm(t('refurbConfirmMerge', { n }))) return
      setBusy(true)
      // 透传 candidates：后端 runConsolidation 仅把这些 ids 当合并种子，其它条目仅在与种子相似时被并入。
      const candidates = [suggestion.primaryId, ...suggestion.candidates]
      api<Record<string, unknown>>('consolidate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope, candidates }),
      })
        .then(() => {
          reload()
          onAfterAction()
          toast.push('success', t('refurbMergeDone'))
        })
        .catch((error: Error) => { toast.push('error', t('refurbActionFailed', { msg: error.message })) })
        .finally(() => { setBusy(false) })
    }
  }, [reload, onSelect, onAfterAction, toast.push, t, scope])
  if (failed !== null) return <LoadFailedLine t={t} msg={failed} onRetry={reload} />
  if (report === null) return <div className={styles.expandLoading}>{t('loading')}</div>
  return (
    <div className={styles.refurb}>
      <div className={styles.refurbHead}>
        <span className={styles.refurbCount}>{t('refurbCount', { n: report.count })}</span>
        <button type="button" className={styles.button} disabled={busy} onClick={reload}>{t('refurbRun')}</button>
      </div>
      {report.count === 0
        ? <div className={styles.expandLoading}>{t('refurbEmpty')}</div>
        : (
          <ul className={styles.refurbList}>
            {report.suggestions.map((suggestion, index) => {
              // 兜底旧后端（0.8.14）：响应没有 primary/candidatePreviews 字段。
              // 面板 slot 的错误边界会把渲染异常放大成整面板白屏，这里必须容错。
              const primary = suggestion.primary ?? null
              const candidatePreviews = suggestion.candidatePreviews ?? EMPTY_PREVIEWS
              return (
                <li key={`${suggestion.action}-${suggestion.primaryId}-${index}`} className={styles.refurbItem}>
                  <div className={styles.refurbRow}>
                    <button type="button" className={styles.refurbBadge} title={t('refurbPreviewOpen')}
                      onClick={() => { onSelect(suggestion.primaryId) }}>
                      {labelOf(suggestion.action)}
                    </button>
                    <div className={styles.refurbReason} title={suggestion.reason}>{suggestion.reason}</div>
                    <span className={styles.refurbConfidence}>{(suggestion.confidence * 100).toFixed(0)}%</span>
                    <button type="button" className={`${styles.refurbExec} ${styles.button}`} disabled={busy}
                      onClick={() => { execute(suggestion) }}>{t('refurbExecute')}</button>
                  </div>
                  {primary !== null && (
                    <button type="button" className={styles.refurbPreview} title={t('refurbPreviewOpen')}
                      onClick={() => { onSelect(primary.id) }}>
                      <span className={styles.refurbPreviewKind}>{primary.kind}</span>
                      <span className={styles.refurbPreviewText}>{primary.content}</span>
                    </button>
                  )}
                  {candidatePreviews.length > 0 && (
                    <div className={styles.refurbCandidates}>
                      <span className={styles.refurbCandidatesLabel}>
                        {t('refurbMergeWith', { n: candidatePreviews.length })}
                      </span>
                      {candidatePreviews.map(candidate => (
                        <button key={candidate.id} type="button" className={styles.refurbPreview}
                          title={t('refurbPreviewOpen')} onClick={() => { onSelect(candidate.id) }}>
                          <span className={styles.refurbPreviewKind}>{candidate.kind}</span>
                          <span className={styles.refurbPreviewText}>{candidate.content}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
    </div>
  )
}

/** 走廊鸟瞰数据拉取与节点/边状态（命中 active + archived，forgotten 默认隐藏）。 */
interface CorridorGraph {
  readonly nodes: ReadonlyArray<{
    readonly id: string
    readonly scope: string
    readonly kind: string
    readonly status: string
    readonly importance: number
    readonly confidence: number
    readonly title: string
    readonly content?: string
  }>
  readonly edges: ReadonlyArray<{ readonly id: string; readonly from: string; readonly to: string; readonly type: string }>
}

function CorridorPanel({ t, scope, project, onSelect, onOpenRoom }: {
  t: T
  scope: 'user' | 'project' | 'shared'
  /** 项目宫殿选择器（仅用于重载依赖；注入在 api() 里做）。 */
  project: string | null
  onSelect: (id: string) => void
  /** 平面图模式点房间 → 宿主接「陈展」按房筛选。 */
  onOpenRoom: (kind: string) => void
}): React.ReactElement {
  const [graph, setGraph] = useState<CorridorGraph | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  // v0.8.4 走廊双模式：平面图（建筑平面,默认,设计稿 #floorplan）/ 关系图（力导向,保留边价值）
  const [mode, setMode] = usePersistedState<'floorplan' | 'graph'>('corridor.mode', 'floorplan', ['floorplan', 'graph'])
  // v0.8.7 右侧房间索引条：按驻留数降序（与平面图排房一致）
  const roomCounts = useMemo(() => {
    if (graph === null) return []
    const counts = new Map<string, number>()
    for (const n of graph.nodes) counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([kind, count]) => ({ kind, count }))
  }, [graph])
  // 自环边（from === to）不是「两条记忆之间的关系」，画不出线也进不了图例：
  // 存量库里存在这类历史脏行（早期写入路径未挡自己），这里直接剔除，
  // 让关系图与图例说的是实话（没有真关系就显示「还没有关系边」）。
  const edges = useMemo(() => (graph === null ? [] : graph.edges.filter(e => e.from !== e.to)), [graph])
  useEffect(() => {
    let cancelled = false
    api<CorridorGraph>(`corridor?status=active,archived&scope=${scope}`)
      .then(data => { if (!cancelled) setGraph(data); setFailed(null) })
      .catch((err: Error) => { if (!cancelled) setFailed(err.message) })
    return () => { cancelled = true }
  }, [scope, project])
  if (failed !== null) return <div className={styles.expandLoading}>{t('corridorFailed')}：{failed}</div>
  if (graph === null) return <div className={styles.expandLoading}>{t('corridorLoad')}</div>
  if (graph.nodes.length === 0) return <EmptyState title={t('corridorEmpty')} hint={t('emptyHint')} />
  return (
    <div>
      <div className={styles.toolbarCard}>
        <div className={styles.segGroup}>
          <button type="button" role="tab" aria-selected={mode === 'floorplan'}
            className={mode === 'floorplan' ? `${styles.segItem} ${styles.on}` : styles.segItem}
            onClick={() => { setMode('floorplan') }}>
            {t('corridorModeFloor')}
          </button>
          <button type="button" role="tab" aria-selected={mode === 'graph'}
            className={mode === 'graph' ? `${styles.segItem} ${styles.on}` : styles.segItem}
            onClick={() => { setMode('graph') }}>
            {t('corridorModeGraph')}
          </button>
        </div>
      </div>
      {mode === 'floorplan'
        ? (
          <div className={styles.floorplanGrid}>
            <FloorplanMap nodes={graph.nodes} onOpenRoom={onOpenRoom} t={t} />
            <RoomIndexAside
              t={t}
              nodes={graph.nodes}
              rooms={roomCounts}
              onOpenRoom={onOpenRoom}
              edges={null} />
          </div>
        )
        : (
          <div className={styles.floorplanGrid}>
            <CorridorMap scope={scope} nodes={graph.nodes} edges={edges} onSelect={onSelect}
              onOpenRoom={onOpenRoom} t={t} />
            <RoomIndexAside
              t={t}
              nodes={graph.nodes}
              rooms={roomCounts}
              onOpenRoom={onOpenRoom}
              edges={edges} />
          </div>
        )}
    </div>
  )
}

/** 右侧房间索引条：房间驻留条（两模式共用）+ 关系图模式追加边类型图例。 */
function RoomIndexAside({ t, nodes, rooms, onOpenRoom, edges }: {
  t: T
  nodes: ReadonlyArray<{ readonly kind: string }>
  rooms: ReadonlyArray<{ readonly kind: string; readonly count: number }>
  onOpenRoom: (kind: string) => void
  /** 非 null = 关系图模式，追加边类型图例。 */
  edges: ReadonlyArray<{ readonly type: string }> | null
}): React.ReactElement {
  return (
    <aside className={styles.roomIndex}>
      <div className={styles.roomIndexStat}>
        <b>{nodes.length}</b> {t('corridorIndexStaying')} · {t('corridorIndexRooms', { n: rooms.length })}
      </div>
      {rooms.map(room => (
        <button key={room.kind} type="button" className={styles.roomIndexRow}
          onClick={() => onOpenRoom(room.kind)}>
          <span className={styles.roomSwatch} style={{ background: KIND_PALETTE[room.kind] ?? '#7d8590' }} aria-hidden="true" />
          <span className={styles.roomIndexName}>{kindLabel(t, room.kind)}</span>
          <span className={styles.roomIndexMeta}>
            <span className={styles.roomBar} aria-hidden="true">
              <span className={styles.roomBarFill}
                style={{ width: `${String(Math.min(100, Math.round((room.count / 9) * 100)))}%`, background: KIND_PALETTE[room.kind] ?? '#7d8590' }} />
            </span>
            <span className={styles.roomIndexCount}>{String(room.count)} / 9</span>
          </span>
        </button>
      ))}
      {edges !== null && edges.length > 0 && (
        <div className={styles.edgeLegend}>
          {([
            ['other', t('edgeOther'), EDGE_STYLE.related!],
            ['supersedes', t('edgeSupersedes'), EDGE_STYLE.supersedes!],
            ['contradicts', t('edgeContradicts'), EDGE_STYLE.contradicts!],
          ] as const).map(([type, label, style]) => {
            const present = type === 'other'
              ? edges.some(e => e.type !== 'supersedes' && e.type !== 'contradicts')
              : edges.some(e => e.type === type)
            if (!present) return null
            return (
              <span key={type} className={styles.edgeLegendItem}>
                <svg width={20} height={6} aria-hidden="true">
                  <line x1={0} y1={3} x2={20} y2={3} stroke={style.color} strokeWidth={style.width} strokeDasharray={style.dash} />
                </svg>
                <span>{label}</span>
              </span>
            )
          })}
        </div>
      )}
      <span className={styles.sectionHint}>
        {edges === null ? t('corridorFloorHint', { nodes: nodes.length }) : t('corridorGraphHint', { nodes: nodes.length })}
      </span>
    </aside>
  )
}

/* 情景时间线的载荷形状与服务器共用（src/types.ts）：形状对不上是编译错误，
   不会再变成「点「邻近」时视图崩掉」。 */
type EpisodeRowView = EpisodeTimelineRow
type EpisodeGroupsView = EpisodeTimelineGroupsResponse

/** Memory Spiral 端点返回形状（与 routes.ts 的 GET /api/engram/timeline 对齐）。 */
interface SpiralTimelineView {
  readonly scope: 'user' | 'project' | 'shared'
  readonly total: number
  readonly records: readonly SpiralRecord[]
}

/** 回忆螺旋视图包装：拉数据 + 工具条（时间窗 segmented）+ 把 records 喂给 SpiralMap 渲染。
 *  复用段控 .segGroup + .segItem 视觉语言，跟其他 tab 的过滤选择保持一致。 */
function SpiralPanel({ t, scope, project, reloadTick }: {
  t: T
  scope: 'user' | 'project' | 'shared'
  project: string | null
  reloadTick: number
}): React.ReactElement {
  const [records, setRecords] = useState<readonly SpiralRecord[] | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  /** 时间窗：30 天 / 半年 / 全部（持久化——其他 segmented 控件也都持久化）。 */
  const [windowKey, setWindowKey] = usePersistedState<'30d' | '180d' | 'all'>('spiral.window', 'all', ['30d', '180d', 'all'])

  useEffect(() => {
    let cancelled = false
    setRecords(null)
    setFailed(null)
    api<SpiralTimelineView>(`timeline?scope=${scope}&limit=500`)
      .then(data => { if (!cancelled) setRecords(data.records) })
      .catch(err => { if (!cancelled) setFailed(err instanceof Error ? err.message : String(err)) })
    return () => { cancelled = true }
  }, [scope, project, reloadTick])

  const windowMs = windowKey === '30d' ? 30 * 86_400_000 : windowKey === '180d' ? 180 * 86_400_000 : null
  const filteredCount = records === null ? null : records.filter(rec => windowMs === null || (Date.now() - rec.createdAt) <= windowMs).length

  return (
    <div className={styles.tabPanel}>
      <PageHeader title={t('tabSpiral')} subtitle={t('pageHeaderCorridorSubtitle')} />
      <div className={spiralStyles.toolbar}>
        <div className={styles.segGroup}>
          <button type="button" role="tab" aria-selected={windowKey === '30d'}
            className={windowKey === '30d' ? `${styles.segItem} ${styles.on}` : styles.segItem}
            onClick={() => { setWindowKey('30d') }}>
            {t('spiralRange30d')}
          </button>
          <button type="button" role="tab" aria-selected={windowKey === '180d'}
            className={windowKey === '180d' ? `${styles.segItem} ${styles.on}` : styles.segItem}
            onClick={() => { setWindowKey('180d') }}>
            {t('spiralRange180d')}
          </button>
          <button type="button" role="tab" aria-selected={windowKey === 'all'}
            className={windowKey === 'all' ? `${styles.segItem} ${styles.on}` : styles.segItem}
            onClick={() => { setWindowKey('all') }}>
            {t('spiralRangeAll')}
          </button>
        </div>
        <span className={spiralStyles.meta}>
          {filteredCount === null ? t('spiralLoading') : `${t('spiralStatCount')} · ${String(filteredCount)}`}
        </span>
      </div>
      {failed !== null && (
        <div className={styles.panelCard}><EmptyState title={t('spiralFailed')} hint={failed} /></div>
      )}
      {failed === null && records === null && (
        <div className={styles.panelCard}><EmptyState title={t('spiralLoading')} /></div>
      )}
      {failed === null && records !== null && records.length === 0 && (
        <div className={styles.panelCard}><EmptyState title={t('spiralEmpty')} hint={t('emptyHint')} /></div>
      )}
      {failed === null && records !== null && records.length > 0 && (
        <SpiralMap t={t} records={records} windowMs={windowMs} />
      )}
    </div>
  )
}

/** 邻近扩展（around 模式）返回：锚点条目 + 窗口内的情景邻居。 */
type EpisodeAroundView = EpisodeTimelineAround

/**
 * 情景时间线视图：按会话分组浏览 episode 往事，组头展示摄取期生成的一句话摘要；
 * 条目点「邻近」展开该时刻 ± 窗口的时间邻近扩展卡（回答「当时前后还发生了什么」）。
 */
function EpisodeTimelineView({ t, scope, project, reloadTick }: {
  t: T
  scope: 'user' | 'project' | 'shared'
  /** 项目宫殿选择器（仅用于重载依赖；注入在 api() 里做）。 */
  project: string | null
  reloadTick: number
}): React.ReactElement {
  const [sinceDate, setSinceDate] = useState('')
  const [untilDate, setUntilDate] = useState('')
  const [sessionIdInput, setSessionIdInput] = useState('')
  /** 已应用的过滤条件：date/文本输入不即时触发请求，点「应用」才生效。 */
  const [applied, setApplied] = useState<{ readonly since: string; readonly until: string; readonly sessionId: string }>({ since: '', until: '', sessionId: '' })
  const [data, setData] = useState<EpisodeGroupsView | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  /** 邻近扩展卡（null = 未展开）；busy 防重复点击。 */
  const [around, setAround] = useState<EpisodeAroundView | null>(null)
  const [aroundBusy, setAroundBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams({ scope })
    // date input 值按本地时区折算成当天首尾毫秒（T00:00:00 / T23:59:59.999）。
    if (applied.since !== '') params.set('since', String(new Date(`${applied.since}T00:00:00`).getTime()))
    if (applied.until !== '') params.set('until', String(new Date(`${applied.until}T23:59:59.999`).getTime()))
    if (applied.sessionId !== '') params.set('sessionId', applied.sessionId)
    api<EpisodeGroupsView>(`episode-timeline?${params.toString()}`)
      .then(d => { if (!cancelled) { setData(d); setFailed(null) } })
      .catch((err: Error) => { if (!cancelled) setFailed(err.message) })
    return () => { cancelled = true }
  }, [scope, project, applied, reloadTick])

  /** 展开邻近扩展：以该条目为锚点查同库 ±60 分钟窗口内的情景（窗口由 host 缺省）。 */
  const openAround = (id: string): void => {
    setAroundBusy(true)
    // 服务器的形状是 `{ around: { anchor, neighbors } }`（同一条路由在分组模式下回
    // `{ groups }`），这里必须取出内层：直接当 `EpisodeAroundView` 用会得到
    // `anchor === undefined`，渲染锚点行时读 `.id` 就把整个视图带崩了。
    api<EpisodeTimelineAroundResponse>(`episode-timeline?scope=${scope}&around=${encodeURIComponent(id)}`)
      .then(d => {
        const view = d.around
        if (view === undefined) {
          setFailed(t('episodeAroundMissing'))
          setAround(null)
        } else {
          setAround(view)
          setFailed(null)
        }
        setAroundBusy(false)
      })
      .catch((err: Error) => { setFailed(err.message); setAroundBusy(false) })
  }

  /** 条目行：时刻 + 房间 + 内容 + 邻近按钮；id 放 title 便于复制。 */
  const renderRow = (row: EpisodeRowView): React.ReactElement => (
    <div key={row.id} className={styles.episodeRow} title={row.id}>
      <time className={styles.episodeRowTime}>{fmtTime(row.createdAt)}</time>
      <span className={styles.episodeRowKind}>{kindLabel(t, row.kind)}</span>
      <span className={styles.episodeRowText}>{row.content}</span>
      <button type="button" className={styles.button} disabled={aroundBusy}
        onClick={() => { openAround(row.id) }}>
        {t('episodeNearby')}
      </button>
    </div>
  )

  return (
    <>
      {/* v0.8.9 过滤行收进工具条卡。 */}
      <div className={styles.toolbarCard}>
        <input type="date" className={styles.input} value={sinceDate} aria-label={t('episodeSince')}
          onChange={event => { setSinceDate(event.target.value) }} />
        <span className={styles.episodeRangeSep} aria-hidden="true">–</span>
        <input type="date" className={styles.input} value={untilDate} aria-label={t('episodeUntil')}
          onChange={event => { setUntilDate(event.target.value) }} />
        <input className={`${styles.input} ${styles.search}`} placeholder={t('episodeSessionId')} value={sessionIdInput}
          onChange={event => { setSessionIdInput(event.target.value) }} />
        <button type="button" className={`${styles.button} ${styles.primary}`}
          onClick={() => { setApplied({ since: sinceDate, until: untilDate, sessionId: sessionIdInput.trim() }); setAround(null) }}>
          {t('episodeApply')}
        </button>
        <button type="button" className={styles.button}
          onClick={() => {
            setSinceDate(''); setUntilDate(''); setSessionIdInput('')
            setApplied({ since: '', until: '', sessionId: '' }); setAround(null)
          }}>
          {t('episodeReset')}
        </button>
      </div>
      {failed !== null && <div className={styles.expandLoading}>{t('loadFailed', { msg: failed })}</div>}
      {around !== null && (
        <section className={`${styles.panelCard} ${styles.episodeAround}`}>
          <header className={styles.episodeAroundHead}>
            <b>{t('episodeAroundTitle')}</b>
            <button type="button" className={styles.button} onClick={() => { setAround(null) }}>
              {t('episodeClose')}
            </button>
          </header>
          {around.anchor !== undefined && renderRow(around.anchor)}
          {(around.neighbors ?? []).length === 0
            ? <p className={styles.sectionHint}>{t('episodeAroundEmpty')}</p>
            : (around.neighbors ?? []).map(renderRow)}
        </section>
      )}
      {data === null && failed === null && <div className={styles.expandLoading}>{t('loading')}</div>}
      {data !== null && data.groups.length === 0 && <EmptyState title={t('episodeNoGroups')} hint={t('emptyHint')} />}
      {data?.groups.map(group => (
        <section key={group.sessionId ?? 'none'} className={styles.panelCard}>
          <header className={styles.episodeHead}>
            {group.summary === undefined
              ? <p className={`${styles.episodeSummary} ${styles.episodeSummaryMissing}`}>{t('episodeSummaryMissing')}</p>
              : <p className={styles.episodeSummary}>{group.summary}</p>}
            <span className={styles.episodeHeadMeta}>
              {group.sessionId === null ? t('episodeNoSession') : `#${group.sessionId}`}
              {' · '}
              {new Date(group.startedAt).toLocaleDateString()} ~ {new Date(group.endedAt).toLocaleDateString()}
              {' · '}
              {t('episodeEntries', { n: group.episodes.length })}
            </span>
          </header>
          <div>{group.episodes.map(renderRow)}</div>
        </section>
      ))}
    </>
  )
}

/** GET /api/engram/entities 的行（host 返回 { entity, memoryCount }，entity 为实体记录的显示字段）。 */
interface EntityListItemView {
  readonly entity: {
    readonly id: string
    readonly name: string
    readonly kind: string
    readonly aliases: readonly string[]
  }
  readonly memoryCount: number
}

/** GET /api/engram/entities 返回（updated_at 倒序，附总数）。 */
interface EntityListView {
  readonly items: readonly EntityListItemView[]
  readonly total: number
}

/** GET /api/engram/entity 返回：实体 + 关联 active 记忆（创建时间倒序）。 */
interface EntityDetailView {
  readonly entity: EntityListItemView['entity']
  readonly memories: readonly MemoryRow[]
}

/** GET /api/engram/facts 返回的单条事实（面板只读显示所需字段）。 */
interface FactView {
  readonly id: string
  readonly content: string
  readonly validAt: number
  readonly invalidAt: number | null
  readonly replacedBy: string | null
}

/** GET /api/engram/facts 返回（valid_at 倒序，附总数）。 */
interface EntityFactsView {
  readonly items: readonly FactView[]
  readonly total: number
}

/** 实体类别数据值 → 词典键（筛选 chips、列表行与详情卡共用一份映射）。 */
const ENTITY_KIND_KEY: Record<string, EngramKey> = {
  person: 'entityKindPerson',
  project: 'entityKindProject',
  tool: 'entityKindTool',
  concept: 'entityKindConcept',
  other: 'entityKindOther',
}
/** 实体类别 → 色点（人物蓝/项目橙/工具青/概念紫/其他灰）。 */
const ENTITY_DOT: Readonly<Record<string, string>> = {
  person: '#5b8def',
  project: '#e08a2e',
  tool: '#3cb489',
  concept: '#9b6bd9',
  other: '#7d8590',
}

const ENTITY_KINDS = ['person', 'project', 'tool', 'concept', 'other'] as const

/** 实体行的类别标签（未知 kind 回退「其他」）。 */
function entityKindLabel(t: T, kind: string): string {
  return t(ENTITY_KIND_KEY[kind] ?? 'entityKindOther')
}

/**
 * 实体词典视图：浏览摄取期从记忆中抽取的实体（人物/项目/工具/概念），
 * 类别 chips + 名称/别名子串过滤；点「查看」展开该实体牵出的关联记忆卡。
 */
function EntityView({ t, scope, project, reloadTick }: {
  t: T
  scope: 'user' | 'project' | 'shared'
  /** 项目宫殿选择器（仅用于重载依赖；注入在 api() 里做）。 */
  project: string | null
  reloadTick: number
}): React.ReactElement {
  const [kind, setKind] = useState<'all' | (typeof ENTITY_KINDS)[number]>('all')
  const [q, setQ] = useState('')
  const [data, setData] = useState<EntityListView | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  /** 展开的实体详情卡（null = 未展开）；busy 防重复点击。 */
  const [detail, setDetail] = useState<EntityDetailView | null>(null)
  const [facts, setFacts] = useState<EntityFactsView | null>(null)
  const [detailBusy, setDetailBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    const query = q.trim()
    const params = new URLSearchParams({ scope })
    if (kind !== 'all') params.set('kind', kind)
    if (query !== '') params.set('q', query)
    api<EntityListView>(`entities?${params.toString()}`)
      .then(d => { if (!cancelled) { setData(d); setFailed(null) } })
      .catch((err: Error) => { if (!cancelled) setFailed(err.message) })
    return () => { cancelled = true }
  }, [scope, project, kind, q, reloadTick])

  /** 展开实体详情：实体记录 + 关联记忆 + 事实链全貌（含已失效，看事实如何演变）。 */
  const openDetail = (id: string): void => {
    setDetailBusy(true)
    Promise.all([
      api<EntityDetailView>(`entity?scope=${scope}&id=${encodeURIComponent(id)}`),
      api<EntityFactsView>(`facts?scope=${scope}&entityId=${encodeURIComponent(id)}&includeInvalid=1`),
    ])
      .then(([d, f]) => { setDetail(d); setFacts(f); setDetailBusy(false); setFailed(null) })
      .catch((err: Error) => { setFailed(err.message); setDetailBusy(false) })
  }

  /** 详情卡里的关联记忆行：时刻 + 房间 + 内容（只读观测，不提供编辑入口）。 */
  const renderMemory = (row: MemoryRow): React.ReactElement => (
    <div key={row.id} className={styles.episodeRow} title={row.id}>
      <time className={styles.episodeRowTime}>{fmtTime(row.createdAt)}</time>
      <span className={styles.episodeRowKind}>{kindLabel(t, row.kind)}</span>
      <span className={styles.episodeRowText}>{row.content}</span>
    </div>
  )

  /** 详情卡里的事实行：生效日期 + 状态标签 + 陈述；失效行标「已失效」。 */
  const renderFact = (fact: FactView): React.ReactElement => (
    <div key={fact.id} className={styles.episodeRow} title={fact.id}>
      <time className={styles.episodeRowTime}>{new Date(fact.validAt).toLocaleDateString()}</time>
      <span className={styles.episodeRowKind}>{fact.invalidAt === null ? t('factValid') : t('factInvalid')}</span>
      <span className={styles.episodeRowText}>{fact.content}</span>
    </div>
  )

  return (
    <>
      {/* 工具条：类别 chips（带色点，色码自解释）+ 搜索 + 计数，一个容器。 */}
      <div className={styles.toolbarCard}>
        {([
          ['all', t('entityKindAll')],
          ...ENTITY_KINDS.map(option => [option, t(ENTITY_KIND_KEY[option] ?? 'entityKindOther')] as const),
        ] as const).map(([value, label]) => (
          <button key={value} type="button" aria-pressed={kind === value}
            className={kind === value ? `${styles.chip} ${styles.chipOn}` : styles.chip}
            onClick={() => { setKind(value); setDetail(null); setFacts(null) }}>
            {value !== 'all' && (
              <span className={styles.chipDot} style={{ background: ENTITY_DOT[value] ?? '#7d8590' }} aria-hidden="true" />
            )}
            {label}
          </button>
        ))}
        <span className={styles.searchBox}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M16.5 16.5 L21 21" /></svg>
          <input className={`${styles.input} ${styles.search}`} placeholder={t('entitySearchPlaceholder')} value={q}
            onChange={event => { setQ(event.target.value); setDetail(null); setFacts(null) }} />
        </span>
        {data !== null && <span className={styles.toolbarCount}>{t('entityCount', { n: data.total })}</span>}
      </div>
      {failed !== null && <div className={styles.expandLoading}>{t('loadFailed', { msg: failed })}</div>}
      {detail !== null && (
        <section className={`${styles.panelCard} ${styles.episodeAround}`}>
          <header className={styles.episodeAroundHead}>
            <b>{detail.entity.name}</b>
            <span className={styles.episodeRowKind}>{entityKindLabel(t, detail.entity.kind)}</span>
            <button type="button" className={styles.button} onClick={() => { setDetail(null); setFacts(null) }}>
              {t('episodeClose')}
            </button>
          </header>
          {detail.entity.aliases.length > 0 && (
            <p className={styles.sectionHint}>{`${t('entityAliases')}：${detail.entity.aliases.join('、')}`}</p>
          )}
          {detail.memories.length === 0
            ? <p className={styles.sectionHint}>{t('entityNoMemories')}</p>
            : <div>{detail.memories.map(renderMemory)}</div>}
          {facts !== null && (
            <>
              <p className={styles.sectionHint}>{t('factSection', { n: facts.total })}</p>
              {facts.items.length === 0
                ? <p className={styles.sectionHint}>{t('factEmpty')}</p>
                : <div>{facts.items.map(renderFact)}</div>}
            </>
          )}
        </section>
      )}
      {data === null && failed === null && <div className={styles.expandLoading}>{t('loading')}</div>}
      {data !== null && data.items.length === 0 && <EmptyState title={t('entityEmpty')} hint={t('emptyHint')} />}
      {data !== null && data.items.length > 0 && (
        <div className={styles.entityList}>
          {data.items.map((item, index) => (
            <button key={item.entity?.id ?? `entity-${String(index)}`} type="button" className={styles.entityRow}
              title={item.entity?.id} disabled={detailBusy}
              onClick={() => { if (item.entity !== undefined) openDetail(item.entity.id) }}>
              <span className={styles.entityDot} style={{ background: ENTITY_DOT[item.entity?.kind ?? ''] ?? '#7d8590' }} aria-hidden="true" />
              <span className={styles.entityMain}>
                <span className={styles.entityName}>{item.entity?.name ?? '—'}</span>
                {(item.entity?.aliases.length ?? 0) > 0 && (
                  <span className={styles.entityAliases}>{item.entity?.aliases.join('、')}</span>
                )}
              </span>
              <span className={styles.entityTag}>{entityKindLabel(t, item.entity?.kind ?? 'other')}</span>
              <span className={styles.entityCount}>{t('entityMemories', { n: item.memoryCount })}</span>
              <svg className={styles.entityChevron} viewBox="0 0 24 24" aria-hidden="true">
                <path d="M9 5l7 7-7 7" />
              </svg>
            </button>
          ))}
        </div>
      )}
    </>
  )
}

/** 信念视图的行（GET /api/engram/observations 的项）。 */
interface BeliefRow {
  readonly id: string
  readonly scope: 'user' | 'project' | 'shared'
  readonly belief: string
  readonly status: 'active' | 'stale' | 'refuted'
  readonly sourceIds: readonly string[]
  readonly proofCount: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastValidatedAt: number
}

/** 信念状态 → 词典键 + pill 配色类（复用记忆状态色：active 绿 / stale 琥珀 / refuted 红）。 */
const BELIEF_STATUS: Readonly<Record<'active' | 'stale' | 'refuted', { key: EngramKey; pill: 'statusActive' | 'statusArchived' | 'statusForgotten' }>> = {
  active: { key: 'beliefStatusActive', pill: 'statusActive' },
  stale: { key: 'beliefStatusStale', pill: 'statusArchived' },
  refuted: { key: 'beliefStatusRefuted', pill: 'statusForgotten' },
}

/**
 * 信念视图：巩固器（engram_reflect / auto 档）产出的信念列表。
 * 状态筛选（成立/待复核/已否定）；点「证据」展开证据链——拉原始记忆行只读回查，
 * 证据已被物理清理时给出「信念保留」提示（信念永不因证据消失而删除）。
 */
function BeliefsView({ t, scope, project, reloadTick }: {
  t: T
  scope: 'user' | 'project' | 'shared'
  /** 项目宫殿选择器（仅用于重载依赖；注入在 api() 里做）。 */
  project: string | null
  reloadTick: number
}): React.ReactElement {
  const [status, setStatus] = useState<'all' | 'active' | 'stale' | 'refuted'>('all')
  const [data, setData] = useState<{ items: readonly BeliefRow[]; total: number } | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  /** 展开证据链的信念 id（null = 全部收起）。 */
  const [openId, setOpenId] = useState<string | null>(null)
  const [evidence, setEvidence] = useState<readonly MemoryRow[] | null>(null)
  const [evidenceBusy, setEvidenceBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams({ scope })
    if (status !== 'all') params.set('status', status)
    api<{ items: readonly BeliefRow[]; total: number }>(`observations?${params.toString()}`)
      .then(d => { if (!cancelled) { setData(d); setFailed(null) } })
      .catch((err: Error) => { if (!cancelled) setFailed(err.message) })
    return () => { cancelled = true }
  }, [scope, project, status, reloadTick])

  /** 展开/收起证据链：ids 逗号拼 query（上限 50，store 端截断兜底）；切换时清旧证据。 */
  const toggleEvidence = (row: BeliefRow): void => {
    if (openId === row.id) { setOpenId(null); setEvidence(null); return }
    setOpenId(row.id)
    setEvidence(null)
    setEvidenceBusy(true)
    api<{ items: readonly MemoryRow[] }>(`observation-evidence?scope=${scope}&ids=${encodeURIComponent(row.sourceIds.join(','))}`)
      .then(d => { setEvidence(d.items); setEvidenceBusy(false); setFailed(null) })
      .catch((err: Error) => { setFailed(err.message); setEvidenceBusy(false) })
  }

  return (
    <>
      <div className={styles.toolbarCard}>
        {([
          ['all', t('beliefStatusAll')],
          ['active', t('beliefStatusActive')],
          ['stale', t('beliefStatusStale')],
          ['refuted', t('beliefStatusRefuted')],
        ] as const).map(([value, label]) => (
          <button key={value} type="button" aria-pressed={status === value}
            className={status === value ? `${styles.chip} ${styles.chipOn}` : styles.chip}
            onClick={() => { setStatus(value); setOpenId(null); setEvidence(null) }}>
            {label}
          </button>
        ))}
        {data !== null && <span className={styles.sectionHint}>{t('beliefCount', { n: data.total })}</span>}
      </div>
      {failed !== null && <div className={styles.expandLoading}>{t('loadFailed', { msg: failed })}</div>}
      {data === null && failed === null && <div className={styles.expandLoading}>{t('loading')}</div>}
      {data !== null && data.items.length === 0 && <EmptyState title={t('beliefNone')} hint={t('emptyHint')} />}
      {data?.items.map(row => (
        <section key={row.id} className={`${styles.panelCard} ${styles.beliefCard}`}>
          <p className={styles.beliefText}>{row.belief}</p>
          <div className={styles.beliefMeta}>
            <span className={`${styles.pill} ${styles[BELIEF_STATUS[row.status].pill]}`}>{t(BELIEF_STATUS[row.status].key)}</span>
            <span className={styles.beliefDots} aria-hidden="true">
              {Array.from({ length: 6 }, (_, i) => (
                <i key={i} className={i < Math.min(row.proofCount, 6) ? styles.beliefDotOn : styles.beliefDot} />
              ))}
            </span>
            <button type="button" aria-expanded={openId === row.id}
              className={openId === row.id ? `${styles.button} ${styles.chipOn}` : styles.button}
              onClick={() => { toggleEvidence(row) }}>
              {t('beliefEvidence', { n: row.proofCount })}
            </button>
            <time className={styles.beliefTime} title={new Date(row.updatedAt).toLocaleString()}>
              {fmtTime(row.updatedAt)}
            </time>
          </div>
          {openId === row.id && (
            <div className={styles.expand}>
              {evidenceBusy && <div className={styles.expandLoading}>{t('loading')}</div>}
              {evidence !== null && evidence.length === 0 && <div className={styles.expandLoading}>{t('beliefEvidenceEmpty')}</div>}
              {evidence?.map(item => (
                <div key={item.id} className={styles.episodeRow} title={item.id}>
                  <time className={styles.episodeRowTime}>{fmtTime(item.createdAt)}</time>
                  <span className={styles.episodeRowKind}>{kindLabel(t, item.kind)}</span>
                  <span className={styles.episodeRowText}>{item.content}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      ))}
    </>
  )
}

/** 宫殿健康分卡：5 维 0-100 + 总分 + 每维度进度条。 */
interface HealthReport {
  readonly overall: number
  readonly parts: ReadonlyArray<{
    readonly scope: string
    readonly score: number
    readonly signal: number
    readonly activeRatio: number
    readonly edgeCount: number
    readonly redacted: number
    readonly archivedRatio: number
  }>
  readonly evaluatedAt: number
}

/** 房间目录：kind → 条目数（stats.byKind）；色块与房间 pill 同色相。 */
function RoomDirectory({ t, byKind }: { t: T; byKind: Readonly<Record<string, number>> }): React.ReactElement {
  return (
    <div className={styles.roomList}>
      {KINDS.map(kind => (
        <div key={kind} className={styles.roomRow}>
          <span className={`${styles.roomSwatch} ${styles[ROOM_CLASS[kind] ?? ''] ?? ''}`} aria-hidden="true" />
          <span>{kindLabel(t, kind)}</span>
          <b className={styles.roomCount}>{byKind[kind] ?? 0}</b>
        </div>
      ))}
    </div>
  )
}

/** 宫殿遥测：最近 7 天 op_log 聚合（写 / 摄取 / 整理 / 闭环等计数）。 */
interface TelemetrySnapshot {
  readonly windowDays: number
  readonly counts: {
    readonly writes: number
    readonly forgets: number
    readonly ingestRequests: number
    readonly ingestDones: number
    readonly distillRequests: number
    readonly consolidations: number
    readonly reviewAnswers: number
    readonly searches?: number
  }
  /** v0.8.1+ 每日写入序列（活动热力日历用）。 */
  readonly dailyWrites?: ReadonlyArray<{ readonly dayMs: number; readonly count: number }>
}

/**
 * 宫殿总览取数：规模（stats，含房间分布）+ 近 7 天活动（telemetry）+ 健康分（health）
 * 一次并行拉齐，供今日速览、健康分构成与房间目录共用（同一路由不重复请求）。
 * @param scope - 当前观察的宫殿（跟随 Header 三宫格）。
 * @param project - 项目宫殿选择器（仅用于选择器变化时重载；实际注入在 api() 里做）。
 * @param reloadTick - 外部重载信号（如日志清理后）：变化时重新取数，让遥测计数不再是旧值。
 * @returns 各段数据与取数失败原因（失败时保留上一次成功值）。
 */
function usePalaceOverview(scope: 'user' | 'project' | 'shared', project: string | null, reloadTick = 0): {
  stats: StatsPart['stats'] | null
  byKind: Readonly<Record<string, number>>
  telemetry: TelemetrySnapshot | null
  health: HealthReport | null
  failed: string | null
} {
  const [state, setState] = useState<{
    stats: StatsPart['stats'] | null
    byKind: Readonly<Record<string, number>>
    telemetry: TelemetrySnapshot | null
    health: HealthReport | null
    failed: string | null
  }>({ stats: null, byKind: {}, telemetry: null, health: null, failed: null })
  useEffect(() => {
    let cancelled = false
    Promise.all([
      // stats 带 scope：project 时经 api() 注入选择器，host 让 project 段按选择器解析（缺省行为不变）。
      api<{ parts: StatsPart[] }>(`stats?scope=${scope}`),
      // v0.8.6+ 取 26 周(182 天)窗口给活动热力日历,正好填满左宽列
      api<TelemetrySnapshot>(`telemetry?days=182&scope=${scope}`),
      api<HealthReport>(`health?scope=${scope}`),
    ])
      .then(([statRes, tele, health]) => {
        if (cancelled) return
        const stats = (statRes.parts ?? []).find(part => part.scope === scope)?.stats ?? null
        setState({ stats, byKind: stats?.byKind ?? {}, telemetry: tele, health, failed: null })
      })
      .catch((error: Error) => {
        if (!cancelled) setState(current => ({ ...current, failed: error.message }))
      })
    return () => { cancelled = true }
  }, [scope, project, reloadTick])
  return state
}

/**
 * 今日速览：三个主指标（记忆 / 开放 / 清晰度）+ 健康分环；近 7 天四项次级计数与诊脉时间并排下沉底行。
 * 取代原先常驻的九格日报条——主次分层，其余计数下沉到「管家日志」tab。
 */
/**
 * Что человек выбрал в окне первого старта: код языка дворца либо особая строка
 * `other` — «другого языка у дворца нет вшитым набором».
 *
 * «Другой» — не четвёртый язык дворца: дворцу записывается настоящий код локали
 * (`fr`), он говорит английским словарём, пока для него не появится файл, а дальше
 * человек идёт по инструкции для агента (В.08).
 */
type PalaceAskChoice = string

/**
 * Пояснение к окну первого запуска — сразу на трёх языках, одно под другим.
 *
 * Язык интерфейса в этот момент ещё не выбран человеком (его выбирают как раз здесь),
 * поэтому объяснение не подчиняется языку панели: показываем все три языка, на которых
 * плагин говорит со дня поставки. Берём тексты из вшитых наборов (`locales/*.ts`), а не
 * переписываем их здесь: одна и та же фраза не должна жить в двух местах.
 */
const PALACE_ASK_PARTS: readonly string[] = [zh.palaceAskBody, en.palaceAskBody, ru.palaceAskBody]

/**
 * Обещание для тех, чьего языка у дворца ещё нет, — тоже на трёх языках.
 *
 * Оно относится только к выбору «другой язык»: человеку с нашей локалью этот текст
 * ничего не объясняет, а тому, чья локаль не наша, — объясняет весь его путь (язык
 * запишется настоящим кодом, служебные надписи будут английскими, инструкция для
 * агента лежит в плагине). Показывать его на языке интерфейса нельзя: этим людям наш
 * язык как раз и не родной, поэтому текст идёт теми же тремя частями, что и пояснение.
 */
const PALACE_FALLBACK_PARTS: readonly string[] = [zh.palaceAskFallback, en.palaceAskFallback, ru.palaceAskFallback]

/** Подставить код языка в часть обещания: `{language}` — единственная подстановка там. */
function withLanguage(part: string, code: string): string {
  return part.split('{language}').join(code)
}

/**
 * Язык дворца в панели: решение принимается по диалогам, а окно нужно только там,
 * где решать нечем или где языки разошлись (решение 21.10).
 *
 * Три случая:
 * - `auto` — диалоги идут на одном из наших языков, базы на нём же или их ещё нет:
 *   дворец настраивается сам, панель только сообщает, на что настроилась;
 * - `ask` — реплик человека ещё не было (журналы не читаем, кроме текущей сессии),
 *   спрашиваем и подставляем локаль Windows;
 * - `mismatch` — диалоги на одном языке, базы на другом: говорим о расхождении
 *   и уходим в то же окно выбора.
 *
 * Четыре выбора: ZH / EN / RU и «другой язык» — не четвёртый язык дворца, а честное
 * «вашего языка у дворца нет»: дворец настраивается на английский, а дальше человек
 * идёт по инструкции для агента (В.08). Предустановка — локаль Windows, а если её
 * среди наших трёх нет, то «другой язык», а не английский под видом «вашего».
 */
function PalaceLanguageAsk({ t, overlayHost, dryRun, toast, onClose }: {
  t: T
  readonly overlayHost: { readonly current: HTMLDivElement | null }
  /** Проверка окна без записи: язык дворца не меняется, конфигурация не трогается. */
  readonly dryRun?: boolean
  /** Куда сообщать о сбросе (нужен только в проверке). */
  readonly toast?: ToastController
  /** Закрыть проверку снаружи (окно проверки живёт, пока его держит панель). */
  readonly onClose?: () => void
}): React.ReactElement | null {
  const [palace, setPalace] = useState<RegistrySnapshot['palace']>(null)
  /** Языки дворца с сервера: что предлагать в выборе. */
  const [languages, setLanguages] = useState<readonly PalaceLanguageOption[]>([])
  /** Предохранитель: пока снят — идёт отсчёт окна. */
  const [guard, setGuard] = useState(true)
  /** Длина окна из настройки: её же проверяет сервер, поэтому в проверке она настоящая. */
  const [windowSec, setWindowSec] = useState(GUARD_SECONDS)
  const [left, setLeft] = useState(GUARD_SECONDS)
  const [suggested, setSuggested] = useState<PalaceAskChoice | null>(null)
  const [choice, setChoice] = useState<PalaceAskChoice | null>(null)
  const [pending, setPending] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [closed, setClosed] = useState(false)
  // Проверка: окно открывается независимо от состояния дворца и ничего не читает
  // из конфигурации. Локаль берём ту же, что и в жизни, — иначе проверка показывала
  // бы не тот язык, который человек увидит на первом старте.
  //
  // Список языков берётся с сервера и в проверке тоже: проверка должна показывать
  // ровно то, что человек увидит на первом старте, а не копию тройки из сборки.
  useEffect(() => {
    if (dryRun !== true) return
    const machine = ((): string => {
      try { return (Intl.DateTimeFormat().resolvedOptions().locale.split('-')[0] ?? '').toLowerCase() } catch { return '' }
    })()
    setPalace({ setting: null, source: 'test', conflict: false, machine, dialogue: null, bases: null, state: 'ask' })
    let cancelled = false
    api<RegistrySnapshot>('registry')
      .then((snapshot) => {
        if (cancelled) return
        // Поля-новички читаются терпимо к пустоте: сервер плагина и его клиент грузятся
        // из разных файлов, и сразу после обновления клиент может оказаться новее сервера
        // (старый процесс в памяти). Без этого панель падала бы целиком с TypeError.
        setLanguages(snapshot.languages ?? [])
        // Длина окна — из настройки: проверка должна считать ровно так же, как жизнь.
        setWindowSec(snapshot.palaceChangeWindowSec ?? GUARD_SECONDS)
        setLeft(snapshot.palaceChangeWindowSec ?? GUARD_SECONDS)
        const supported = (snapshot.languages ?? []).some(row => row.code === machine) ? machine : null
        setSuggested(supported ?? 'other')
        setChoice(supported ?? 'other')
      })
      .catch((error: Error) => { if (!cancelled) setFailed(error.message) })
    return () => { cancelled = true }
  }, [dryRun])
  // Отсчёт окна — свойство формы, а не фоновая задача: сняли предохранитель — пошло,
  // поставили обратно — обнулилось. На нуле предохранитель встаёт сам.
  useEffect(() => {
    if (guard) return
    if (left <= 0) {
      setGuard(true)
      setLeft(windowSec)
      toast?.push('reset', t('guardReset', { seconds: windowSec }))
      return
    }
    const id = setTimeout(() => { setLeft(left - 1) }, 1000)
    return () => { clearTimeout(id) }
  }, [guard, left, windowSec, toast?.push, t])
  useEffect(() => {
    if (dryRun === true) return
    let cancelled = false
    api<RegistrySnapshot>('registry')
      // palace !== null значит «определять было что, а решения нет»: настройка всё ещё auto.
      .then((snapshot) => {
        if (cancelled || snapshot.palace === null) return
        // При расхождении подставляем язык диалогов, а не локаль: человек уже показал,
        // на каком языке он говорит, и это сильнее настроек машины. В остальных случаях
        // предустановка — локаль Windows.
        const preferred = snapshot.palace.state === 'mismatch'
          ? snapshot.palace.dialogue
          : snapshot.palace.machine
        // Список языков терпит пустоту: старый сервер его не отдаёт, и окно всё равно
        // должно открыться — с одним выбором «другой язык», а не с пустым полем.
        const supported = (snapshot.languages ?? []).some(row => row.code === preferred) ? preferred : null
        setLanguages(snapshot.languages ?? [])
        setPalace(snapshot.palace)
        setSuggested(supported ?? 'other')
        setChoice(supported ?? 'other')
      })
      .catch((error: Error) => { if (!cancelled) setFailed(error.message) })
    return () => { cancelled = true }
  }, [])
  /**
   * Окно открывает сервер: он сам запоминает начало отсчёта и язык, на котором стоят базы
   * (решение 24.10). Без этого сервер откажет в записи: предохранитель держит сервер,
   * и открыть окно должен он.
   *
   * Открытие здесь — то самое первое событие собранного условия: человек увидел окно и
   * начал выбирать.
   */
  useEffect(() => {
    if (dryRun === true) return
    void api<{ ok: boolean, startedAt: number, left: number }>('palace-change/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
      .catch(() => { /* окно не открылось — запись будет отклонена, и это правильно */ })
  }, [dryRun])
  if (palace === null || closed) return null
  /**
   * Закрыть окно.
   *
   * В проверке окно держит панель (`panelTest`), поэтому закрытие сообщается наружу.
   * Без этого панель считала проверку открытой, а окно уже закрылось, — и повторное
   * нажатие «Тест панели» ничего не делало.
   */
  const close = (): void => { setClosed(true); onClose?.() }
  // Опора есть: дворец настроился сам — говорим, на что, и ничего не спрашиваем.
  if (palace.state === 'auto') {
    const note = (
      <div className={styles.palaceNote} role="status">
        {t('palaceAutoNote', { language: (palace.dialogue ?? '').toUpperCase() })}
      </div>
    )
    return overlayHost.current === null ? note : createPortal(note, overlayHost.current)
  }
  const mismatch = palace.state === 'mismatch'
  const basesName = palace.bases === 'mixed' ? t('palaceMismatchMixed') : (palace.bases ?? '').toUpperCase()
  const title = mismatch ? t('palaceMismatchTitle') : t('palaceAskTitle')
  const body = mismatch
    ? t('palaceMismatchBody', { dialogue: (palace.dialogue ?? '').toUpperCase(), bases: basesName })
    : t('palaceAskBody')
  /**
   * Код языка за четвёртым выбором — локаль машины как есть (`fr`).
   *
   * Подставлять вместо неё английский нельзя: это тот самый заменитель, из-за
   * которого француз получал дворец «на своём языке», а на деле английский.
   * null — локаль прочитать не удалось либо она не похожа на код языка; тогда
   * выбор не отправляется, а человеку говорится, что код не определился.
   */
  const otherCode = LANGUAGE_CODE.test(palace.machine) ? palace.machine : null
  const submit = (): void => {
    if (choice === null) return
    if (choice === 'other' && otherCode === null) { setFailed(t('palaceAskNoCode')); return }
    // «Другой язык» передаёт дворцу настоящий код языка, а не английский: язык
    // дворца становится `fr`, служебные тексты он берёт английским словарём,
    // пока для языка не появится файл (решение 21.10, В.09).
    const language = choice === 'other' ? (otherCode as string) : choice
    // Проверка ничего не пишет: показываем, что было бы выбрано, и закрываемся.
    if (dryRun === true) {
      toast?.push('success', t('panelTestDone', { language: language.toUpperCase() }))
      close()
      return
    }
    setPending(true)
    api<{ ok: boolean, language: string, error?: string }>('palace-language', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ language }),
    })
      .then((result) => {
        if (!result.ok) { setFailed(result.error ?? ''); return }
        setSaved(result.language.toUpperCase())
        setFailed(null)
      })
      .catch((error: Error) => { setFailed(error.message) })
      .finally(() => { setPending(false) })
  }
  const choices: readonly PalaceAskChoice[] = [...languages.map(row => row.code), 'other']
  const screen = (
    <div className={styles.importLayer} role="dialog" aria-modal="true" aria-label={title}>
      <div className={styles.importScrim} onClick={() => { if (!pending) close() }} />
      <div className={styles.drawer}>
        <header className={styles.drawerHead}>
          <div className={styles.drawerTitle}>
            <h3>{title}</h3>
          </div>
          <button type="button" className={styles.drawerClose} aria-label={t('drawerClose')}
            disabled={pending} onClick={close}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M2 2 L12 12 M12 2 L2 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
            </svg>
          </button>
        </header>
        <div className={`${styles.drawerBody} ${styles.palaceAskBody}`}>
          {/* Расхождение языков — не первый запуск: там объясняется конкретная пара
              языков, и переводить это на три языка сразу незачем. */}
          {mismatch
            ? <p className={styles.regNote}>{body}</p>
            : (
              <div className={styles.palaceAskText}>
                {PALACE_ASK_PARTS.map(part => <p key={part} className={styles.regNote}>{part}</p>)}
              </div>
            )}
          <div className={styles.palaceChoiceList} role="radiogroup" aria-label={title}>
            {choices.map(value => (
              <label key={value} className={choice === value ? `${styles.palaceChoice} ${styles.palaceChoiceOn}` : styles.palaceChoice}>
                <input type="radio" name="palace-language-choice" value={value}
                  checked={choice === value} disabled={pending || saved !== null}
                  onChange={() => { setChoice(value) }} />
                <span className={styles.palaceChoiceName}>
                  {value === 'other'
                    ? t('palaceAskOther')
                    : (languages.find(row => row.code === value)?.label ?? value.toUpperCase())}
                </span>
                {suggested === value ? <span className={styles.palaceChoiceNote}>{t('palaceAskSuggested')}</span> : null}
              </label>
            ))}
          </div>
          {choice === 'other'
            ? (otherCode === null
              ? <p className={styles.palaceAskHint}>{t('palaceAskNoCode')}</p>
              : (
                <div className={styles.palaceAskText}>
                  {PALACE_FALLBACK_PARTS.map(part => (
                    <p key={part} className={styles.palaceAskHint}>{withLanguage(part, otherCode.toUpperCase())}</p>
                  ))}
                </div>
              ))
            : null}
          {dryRun === true ? (
            <div className={styles.regGroup}>
              <span className={styles.regGroupTitle}>{t('panelTestTitle')}</span>
              <label className={styles.regNote}>
                <input type="checkbox" checked={guard}
                  onChange={(event) => {
                    const next = event.target.checked
                    setGuard(next)
                    setLeft(windowSec)
                  }} />
                {' '}
                {guard ? t('guardArmed') : t('guardDisarmed', { seconds: left })}
              </label>
            </div>
          ) : null}
          {saved === null ? null : <p className={styles.regNote}>{t('palaceAskSaved', { language: saved })}</p>}
          {failed === null ? null : <p className={styles.regNote}>{t('loadFailed', { msg: failed })}</p>}
          <div className={styles.modalFoot}>
            <button type="button" className={styles.button} disabled={pending}
              onClick={close}>{t('palaceAskLater')}</button>
            <button type="button" className={`${styles.button} ${styles.primary}`}
              disabled={pending || choice === null || saved !== null} onClick={submit}>
              {pending ? t('palaceAskSaving') : t('palaceAskContinue')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
  // Окно fixed, но .panel образует собственный контекст наложения (см. .overlayHost):
  // внутри него оверлей не перекрыл бы окно плагина целиком, поэтому — порталом в якорь.
  return overlayHost.current === null ? screen : createPortal(screen, overlayHost.current)
}

function TodayHero({ t, overview, dueCount }: { t: T; overview: ReturnType<typeof usePalaceOverview>; dueCount: number }): React.ReactElement {
  const { stats, telemetry, health, failed } = overview
  if (failed !== null) {
    return <section className={styles.panelCard}><div className={styles.expandLoading}>{t('teleFailed')}：{failed}</div></section>
  }
  if (telemetry === null) {
    return <section className={styles.panelCard}><div className={styles.expandLoading}>{t('teleLoading')}</div></section>
  }
  const counts = telemetry.counts
  // v0.8.8 设计稿 #sparkline 100%:总记忆 spark 用真实 dailyWrites 近 30 天;
  // 开放/清晰度暂无日序列,用稳定合成线;今日到期为第 4 个 KPI(红色调)。
  const sparkWrites = (telemetry.dailyWrites ?? []).slice(-30).map(d => d.count)
  const sparkActive = Array.from({ length: 30 }, (_, i) => (stats?.active ?? 0) * 0.5 + (29 - i) * 0.12)
  const sparkSignal = Array.from({ length: 30 }, (_, i) => 0.5 + i / 58)
  const sparkDue = Array.from({ length: 30 }, (_, i) => (i % 9 === 0 ? 2 : i % 5 === 0 ? 1 : 0))
  const answered = counts.reviewAnswers
  return (
    <section className={styles.panelCard}>
      <div className={styles.hero}>
        <div className={styles.heroMetrics}>
          <Metric label={t('kpiTotal')} value={stats?.total ?? 0}
            spark={sparkWrites} color="var(--room-episode)"
            delta={t('heroDelta7d', { n: counts.writes })} deltaTone={counts.writes > 0 ? 'up' : 'flat'} />
          <Metric label={t('kpiActive')} value={stats?.active ?? 0}
            spark={sparkActive} color="var(--room-decision)"
            delta={t('heroDeltaForgotten', { n: stats?.forgotten ?? 0 })} deltaTone="flat" />
          <Metric label={t('kpiSignal')} value={`${String(Math.round((stats?.signalRatio ?? 0) * 100))}%`}
            spark={sparkSignal} color="var(--room-preference)"
            delta={t('heroDeltaRedacted', { n: stats?.redacted ?? 0 })} deltaTone="flat" />
          <Metric label={t('kpiDue')} value={dueCount}
            tone={dueCount > 0 ? 'error' : undefined}
            spark={sparkDue} color="var(--dsw-alias-state-error-primary)"
            delta={answered > 0 ? t('heroDeltaAnswered', { n: answered }) : t('heroDeltaUnanswered')}
            deltaTone={answered > 0 ? 'up' : 'flat'} />
        </div>
        <div className={styles.ringCard}>
          <HealthRing score={health?.overall ?? 0} label={t('healthLabel')} />
        </div>
      </div>
      <div className={styles.heroFoot}>
        {/* 近 7 天四项次级计数（落成/发掘/整理/今日到期）内联下沉到底行，与诊脉时间同行 */}
        <div className={styles.heroStats}>
          <span className={styles.heroStat}>
            <span className={styles.heroStatLabel}>{t('teleWrites')}</span>
            <span className={styles.heroStatValue}>{counts.writes}</span>
          </span>
          <span className={styles.heroStat}>
            <span className={styles.heroStatLabel}>{t('teleIngest')}</span>
            <span className={styles.heroStatValue}>{counts.ingestRequests}</span>
          </span>
          <span className={styles.heroStat}>
            <span className={styles.heroStatLabel}>{t('teleConsolidate')}</span>
            <span className={styles.heroStatValue}>{counts.consolidations}</span>
          </span>
          {/* 今日到期：复习调度的消费者是 agent，这里只给观测计数（角标/陈展筛选可达）；有待忆时数字点亮警示色 */}
          <span className={styles.heroStat}>
            <span className={styles.heroStatLabel}>{t('heroDue')}</span>
            <span className={dueCount > 0 ? `${styles.heroStatValue} ${styles.heroStatDue}` : styles.heroStatValue}>{dueCount}</span>
          </span>
          <span className={styles.heroFootDivider} aria-hidden="true" />
          <span className={styles.sectionHint}>
            {health === null ? t('healthLoading') : t('healthEvaluatedAt', { time: relTime(t, health.evaluatedAt) })}
          </span>
        </div>
        {/* 隐私元数据：叹号图标 + 短标签 + hover/聚焦弹出长说明。tabIndex 让键盘用户也能聚焦出长说明。 */}
        <span className={styles.telePrivacy} role="note" aria-label={t('telePrivacyHint')} tabIndex={0}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.2"/>
            <line x1="7" y1="6" x2="7" y2="10.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
            <circle cx="7" cy="4.2" r="0.7" fill="currentColor"/>
          </svg>
          <span className={styles.telePrivacyHint}>{t('telePrivacyHint')}</span>
          <span className={styles.telePrivacyTip} role="tooltip">{t('telePrivacyTip')}</span>
        </span>
      </div>
    </section>
  )
}

/** 历史回填 API 的估算结构（GET /api/engram/history-backfill）。 */
interface BackfillEstimateView {
  readonly rules: {
    readonly days: number
    readonly maxTurnsPerSession: number
    readonly maxTotalTurns: number
    readonly includeSubagents: boolean
    readonly includeSeeded: boolean
    readonly includeNoCwd: boolean
  }
  readonly candidates: number
  readonly eligibleTurns: number
  readonly pendingTurns: number
  readonly alreadyIngested: number
  readonly skipped: {
    readonly subagent: number
    readonly seeded: number
    readonly noCwd: number
    readonly tooOld: number
    readonly unreadable: number
  }
  readonly truncated: boolean
  readonly unavailable?: string
}

/** 宿主已注册的 provider 与模型清单（GET /api/engram/models）。 */
interface ModelsView {
  readonly providers: readonly { readonly id: string; readonly name: string; readonly models: readonly { readonly id: string; readonly name: string }[] }[]
  readonly failures: readonly string[]
}

/** 历史回填任务状态（GET /api/engram/history-backfill/status）。 */
interface BackfillStatusView {
  readonly progress: {
    readonly state: 'running' | 'done' | 'cancelled' | 'failed'
    readonly sessionsTotal: number
    readonly sessionsDone: number
    readonly turnsPlanned: number
    readonly turnsDone: number
    readonly memoriesWritten: number
    readonly turnsSkipped: number
    readonly turnsFailed: number
    readonly skipReasons: Readonly<Record<string, number>>
    readonly currentSession?: string
  }
  readonly failures: readonly { readonly sessionId: string; readonly turn: number; readonly reason: string }[]
  readonly error?: string
}

/** 跳过原因（摄取管线的英文枚举）→ 词典键。 */
const SKIP_KEY: Record<string, EngramKey> = {
  'low-activity': 'skipLowActivity',
  chitchat: 'skipChitchat',
  'capture-forbidden': 'skipForbidden',
  'no-user-content': 'skipNoContent',
  'already-ingested': 'skipAlready',
  'no-such-turn': 'skipNoTurn',
  'no-previous-turn': 'skipNoTurn',
  'no-route-in-log': 'skipNoRoute',
  // hook 产出的原因值（hook.ts）：不可解析 'unparseable-output'、空答案 'empty-answer'。
  // 旧键 'unparsable' 从未与产出对上过，导致该原因一直以原始英文展示（#11）。
  'unparseable-output': 'skipUnparsable',
  'empty-answer': 'skipEmptyAnswer',
  // 审计 F13 对偶面：全败回合保留 pending，面板要把它翻成人话而不是裸枚举。
  'all-candidates-failed': 'skipAllCandidatesFailed',
}

/** 跳过原因的本地化标签（未知枚举回退原值）。 */
function skipLabel(t: T, reason: string): string {
  const key = SKIP_KEY[reason]
  return key === undefined ? reason : t(key)
}

/**
 * 历史回填：导入规则由用户选择（时间窗 / 轮数上限 / 三类会话过滤），
 * 先估算（零成本）再执行；运行中每 1.5 秒轮询进度，可暂停续做。
 */
function HistoryBackfillCard({ t, toast }: { t: T; toast: ToastController }): React.ReactElement {
  /** 规则（持久化）：时间窗与过滤开关以字符串存，便于 localStorage 往返。 */
  const [days, setDays] = usePersistedState<string>('backfill.days', '7', ['7', '30', '90', '0'])
  const [maxTurns, setMaxTurns] = usePersistedString('backfill.maxTurns', '20')
  const [maxTotal, setMaxTotal] = usePersistedString('backfill.maxTotal', '200')
  const [subagents, setSubagents] = usePersistedState<string>('backfill.subagents', 'false', ['false', 'true'])
  const [seeded, setSeeded] = usePersistedState<string>('backfill.seeded', 'false', ['false', 'true'])
  const [noCwd, setNoCwd] = usePersistedState<string>('backfill.noCwd', 'false', ['false', 'true'])
  /** 辅助模型选择：'' = 自动（用当前在用的模型）；否则 `provider::model`。 */
  const [modelChoice, setModelChoice] = usePersistedString('backfill.model', '')
  const [models, setModels] = useState<ModelsView | null>(null)
  const [estimate, setEstimate] = useState<BackfillEstimateView | null>(null)
  const [status, setStatus] = useState<BackfillStatusView | null>(null)
  const [busy, setBusy] = useState(false)

  // 已注册模型清单：只拉一次（模型注册表变化不频繁，切换 tab 会重新挂载）。
  useEffect(() => {
    let cancelled = false
    api<ModelsView>('models')
      .then((data) => { if (!cancelled) setModels(data) })
      .catch(() => { if (!cancelled) setModels({ providers: [], failures: [] }) })
    return () => { cancelled = true }
  }, [])

  /** 显式选中的辅助模型（未选 = 交给后端用当前在用的模型）。 */
  const selection = ((): { provider: string; model: string } | undefined => {
    if (modelChoice === '') return undefined
    const separator = modelChoice.indexOf('::')
    if (separator <= 0) return undefined
    return { provider: modelChoice.slice(0, separator), model: modelChoice.slice(separator + 2) }
  })()

  const params = new URLSearchParams({
    days, maxTurnsPerSession: maxTurns, maxTotalTurns: maxTotal,
    includeSubagents: subagents, includeSeeded: seeded, includeNoCwd: noCwd,
  })
  if (selection !== undefined) {
    params.set('provider', selection.provider)
    params.set('model', selection.model)
  }
  const query = params.toString()

  const reload = useCallback((): void => {
    setBusy(true)
    api<{ estimate: BackfillEstimateView }>(`history-backfill?${query}`)
      .then((data) => { setEstimate(data.estimate) })
      .catch((error: Error) => { toast.push('error', error.message) })
      .finally(() => { setBusy(false) })
    // 依赖 toast.push（稳定引用）而非整个 toast 对象：后者每次渲染换新，
    // 曾让本 effect 在每次父渲染时重拉估算（审计 N19）。
  }, [query, toast.push])
  useEffect(() => { reload() }, [reload])

  // 进度轮询：运行中每 1.5 秒一次；空闲只拉一次拿最终态。
  const running = status?.progress.state === 'running'
  // v0.8.12:轮询失败不再静默——服务重启会杀掉运行中的回填,吞掉错误会让 UI 永远停在「回填中」。
  const [pollFailed, setPollFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    const poll = (): void => {
      api<BackfillStatusView>('history-backfill/status')
        .then((data) => { if (!cancelled) { setStatus(data); setPollFailed(false) } })
        .catch(() => { if (!cancelled) setPollFailed(true) })
    }
    poll()
    if (!running) return () => { cancelled = true }
    const timer = window.setInterval(poll, 1500)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [running])

  const start = (): void => {
    setBusy(true)
    api<{ ok: boolean; status: BackfillStatusView }>('history-backfill/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        days: Number(days), maxTurnsPerSession: Number(maxTurns), maxTotalTurns: Number(maxTotal),
        includeSubagents: subagents === 'true', includeSeeded: seeded === 'true', includeNoCwd: noCwd === 'true',
        ...(selection === undefined ? {} : { provider: selection.provider, model: selection.model }),
      }),
    })
      .then((data) => { setStatus(data.status) })
      .catch((error: Error) => { toast.push('error', error.message) })
      .finally(() => { setBusy(false) })
  }
  const pause = (): void => {
    api<{ status: BackfillStatusView }>('history-backfill/cancel', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
      .then((data) => { setStatus(data.status) })
      .catch((error: Error) => { toast.push('error', error.message) })
  }

  const progress = status?.progress
  // v0.8.12:服务重启后 status 返回 done 0/0 哨兵——显示「未在运行」而不是误导的「已完成」。
  const freshBoot = progress !== undefined
    && progress.state === 'done' && progress.sessionsTotal === 0
    && progress.turnsPlanned === 0 && progress.turnsDone === 0
  const stateLabel = progress === undefined || pollFailed
    ? ''
    : freshBoot ? t('backfillStateIdle')
      : progress.state === 'running' ? t('backfillStateRunning')
        : progress.state === 'done' ? t('backfillStateDone')
          : progress.state === 'cancelled' ? t('backfillStateCancelled')
            : t('backfillStateFailed')
  const percent = progress === undefined || progress.turnsPlanned === 0
    ? 0
    : Math.min(100, Math.round((progress.turnsDone / progress.turnsPlanned) * 100))

  return (
    <div className={styles.backfill}>
      {/* 解释性长文收进「说明」折叠里：运维页是工具页，正文第一屏应该先给控件，
          想读的人点一下就在。 */}
      <details className={styles.opsDetails}>
        <summary>{t('opsMoreInfo')}</summary>
        <p className={styles.backfillIntro}>{t('backfillIntro')}</p>
      </details>

      {/* 导入规则：全部由用户选择（持久化，下次进来沿用）。 */}
      <div className={styles.backfillRules}>
        <label className={styles.backfillRule}>
          <span>{t('backfillDays')}</span>
          <SelectField selectClassName={styles.input} value={days} onChange={event => { setDays(event.target.value) }}>
            <option value="7">{t('backfillDaysUnit', { n: 7 })}</option>
            <option value="30">{t('backfillDaysUnit', { n: 30 })}</option>
            <option value="90">{t('backfillDaysUnit', { n: 90 })}</option>
            <option value="0">{t('backfillDaysAll')}</option>
          </SelectField>
        </label>
        <label className={styles.backfillRule}>
          <span>{t('backfillMaxTurns')}</span>
          <input className={styles.input} type="number" min={1} max={500} value={maxTurns}
            onChange={event => { setMaxTurns(event.target.value) }} />
        </label>
        <label className={styles.backfillRule}>
          <span>{t('backfillMaxTotal')}</span>
          <input className={styles.input} type="number" min={1} max={5000} value={maxTotal}
            onChange={event => { setMaxTotal(event.target.value) }} />
        </label>
        {/* 辅助模型：默认「自动」= 回填时用你当前在用的模型（历史日志里的旧模型可能已不可用）。 */}
        <label className={styles.backfillRule}>
          <span>{t('backfillModel')}</span>
            <SelectField selectClassName={styles.input} value={modelChoice}
              onChange={event => { setModelChoice(event.target.value) }}>
              <option value="">{t('backfillModelAuto')}</option>
              {(models?.providers ?? []).map(provider => (
                <optgroup key={provider.id} label={provider.name}>
                  {provider.models.map(model => (
                    <option key={`${provider.id}::${model.id}`} value={`${provider.id}::${model.id}`}>{model.name}</option>
                  ))}
                </optgroup>
              ))}
            </SelectField>
        </label>
      </div>
      <div className={styles.backfillToggles}>
        <label className={styles.backfillToggle}>
          <input type="checkbox" checked={subagents === 'true'}
            onChange={event => { setSubagents(event.target.checked ? 'true' : 'false') }} />
          {t('backfillIncludeSubagents')}
        </label>
        <label className={styles.backfillToggle}>
          <input type="checkbox" checked={seeded === 'true'}
            onChange={event => { setSeeded(event.target.checked ? 'true' : 'false') }} />
          {t('backfillIncludeSeeded')}
        </label>
        <label className={styles.backfillToggle}>
          <input type="checkbox" checked={noCwd === 'true'}
            onChange={event => { setNoCwd(event.target.checked ? 'true' : 'false') }} />
          {t('backfillIncludeNoCwd')}
        </label>
      </div>

      {/* 估算：零成本先看数（不写库、不调 LLM）。 */}
      <div className={styles.backfillEstimate}>
        {estimate === null
          ? <span className={styles.backfillMuted}>{t('backfillEstimating')}</span>
          : estimate.unavailable !== undefined
            ? <span className={styles.backfillMuted}>{estimate.unavailable}</span>
            : (
              <>
                {/* Оценка — теми же крупными метриками, что на главной: три числа
                    видно сразу, а не нужно искать в трёх одинаковых коробках. */}
                <div className={styles.heroMetrics}>
                  <Metric label={t('backfillLabelCandidates')} value={estimate.candidates} />
                  <Metric label={t('backfillLabelPending')} value={estimate.pendingTurns} />
                  <Metric label={t('backfillLabelSkipped')} value={estimate.alreadyIngested} />
                </div>
                <div className={styles.backfillMuted}>
                  {t('backfillSkippedDetail', {
                    subagent: estimate.skipped.subagent,
                    seeded: estimate.skipped.seeded,
                    noCwd: estimate.skipped.noCwd,
                    tooOld: estimate.skipped.tooOld,
                    unreadable: estimate.skipped.unreadable,
                  })}
                </div>
                {estimate.truncated && <div className={styles.backfillMuted}>{t('backfillTruncated')}</div>}
              </>
            )}
      </div>

      <div className={styles.cardDivider} />
      <div className={styles.backfillActions}>
        <button type="button" className={styles.button} disabled={busy} onClick={reload}>{t('backfillReestimate')}</button>
        <button type="button" className={`${styles.button} ${styles.primary}`}
          disabled={busy || running || estimate === null || estimate.unavailable !== undefined || estimate.pendingTurns === 0}
          onClick={start}>{t('backfillStart')}</button>
        <button type="button" className={styles.button} disabled={!running} onClick={pause}>{t('backfillPause')}</button>
      </div>
      {progress !== undefined && (
        <div className={styles.backfillProgress}>
          <div className={styles.backfillProgressHead}>
            <span>
              {pollFailed ? t('backfillPollFailed') : stateLabel}
              {!pollFailed && progress.currentSession !== undefined && stateLabel === t('backfillStateRunning') && (
                <span className={styles.backfillMuted}>{` · #${progress.currentSession.slice(0, 8)}`}</span>
              )}
            </span>
            <span>{t('backfillProgressTurns', { done: progress.turnsDone, total: progress.turnsPlanned })}</span>
          </div>
          <div className={styles.progressBar}><i style={{ width: `${String(percent)}%` }} /></div>
          <div className={styles.backfillMeta}>
            <span>{t('backfillProgressSessions', { done: progress.sessionsDone, total: progress.sessionsTotal })}</span>
            <span>{t('backfillWritten', { n: progress.memoriesWritten })}</span>
            <span>{t('backfillTurnsSkipped', { n: progress.turnsSkipped })}</span>
            <span>{t('backfillTurnsFailed', { n: progress.turnsFailed })}</span>
          </div>
          {/* 跳过原因分布：让「写入很少」可解释（多为节流跳过而非失败）。 */}
          {Object.keys(progress.skipReasons).length > 0 && (
            <div className={styles.backfillMeta}>
              <span>{t('backfillSkipReasons')}</span>
              {Object.entries(progress.skipReasons).sort(([, a], [, b]) => b - a).map(([reason, count]) => (
                <span key={reason}>{`${skipLabel(t, reason)} ${String(count)}`}</span>
              ))}
            </div>
          )}
          {(status?.failures ?? []).length > 0 && (
            <ul className={styles.backfillFailures}>
              <li className={styles.backfillMuted}>{t('backfillFailures')}</li>
              {status!.failures.slice(0, 3).map((failure, index) => (
                <li key={`${failure.sessionId}-${String(failure.turn)}-${String(index)}`}>
                  {`${failure.sessionId.slice(-12)} · ${String(failure.turn)} · ${failure.reason}`}
                </li>
              ))}
            </ul>
          )}
          {(status?.failures ?? []).length > 0 && (
            <div className={styles.backfillMuted}>{t('backfillRouteHint')}</div>
          )}
          {status?.error !== undefined && <div className={styles.backfillMuted}>{status.error}</div>}
        </div>
      )}
    </div>
  )
}

/** Модель в подсказках поля (из настроек провайдера). */
interface JevModelOption {
  readonly id: string
}

/** Провайдер DSH с шаблоном адреса System One и моделями из своих настроек. */
interface JevProviderOption {
  readonly id: string
  readonly displayName: string
  readonly baseUrl: string | undefined
  readonly endpoint: string | undefined
  readonly models: readonly JevModelOption[]
}

/** Jev panel view (response body of GET/POST /api/engram/jev-config). The provider and its key live in DSH; nothing secret is echoed here. */
interface JevPanelView {
  readonly enabled: boolean
  readonly provider: string | undefined
  readonly model: string | undefined
  readonly endpoint: string | undefined
  readonly timeoutMs: number
  readonly deferMergeAbove: number
  readonly deferAcceptBelow: number
  readonly contradictMinProbability: number
  /**
   * Каталог провайдеров и их моделей. Приходит от сервера и может отсутствовать:
   * после обновления панель бывает новее запущенной половины сервера, а старый
   * сервер этого поля не отдаёт — тогда раздел обязан остаться на ногах, а не падать
   * на `undefined.find`.
   */
  readonly providers?: readonly JevProviderOption[]
}

/**
 * Замер связи Jev: то, что печатает строка состояния под переключателем.
 *
 * Хранится у человека (localStorage), а не в процессе сервера: «когда проверяли и чем
 * кончилось» — это наблюдение панели, и после перезапуска DSH оно остаётся правдой,
 * пока не устареет по времени. Поэтому в записи лежат и параметры замера: строка
 * говорит, чем мерили, а не чем померили бы сейчас.
 */
interface JevCheckView {
  readonly at: number
  readonly ok: boolean
  readonly elapsedMs: number
  readonly probability: number | undefined
  readonly status: number | undefined
  readonly kind: 'http' | 'network' | 'timeout' | 'shape' | undefined
  readonly error: string | undefined
  readonly endpoint: string
  readonly model: string
  readonly timeoutMs: number
}

/** Разбор сохранённого замера: битое значение — «не проверялось», а не падение панели. */
function readJevCheck(raw: string): JevCheckView | null {
  if (raw === '') return null
  try {
    const parsed = JSON.parse(raw) as Partial<JevCheckView>
    if (typeof parsed.at !== 'number' || typeof parsed.ok !== 'boolean') return null
    const kind = parsed.kind
    return {
      at: parsed.at,
      ok: parsed.ok,
      elapsedMs: typeof parsed.elapsedMs === 'number' ? parsed.elapsedMs : 0,
      probability: typeof parsed.probability === 'number' ? parsed.probability : undefined,
      status: typeof parsed.status === 'number' ? parsed.status : undefined,
      kind: kind === 'http' || kind === 'network' || kind === 'timeout' || kind === 'shape' ? kind : undefined,
      error: typeof parsed.error === 'string' ? parsed.error : undefined,
      endpoint: typeof parsed.endpoint === 'string' ? parsed.endpoint : '',
      model: typeof parsed.model === 'string' ? parsed.model : '',
      timeoutMs: typeof parsed.timeoutMs === 'number' ? parsed.timeoutMs : 0,
    }
  } catch {
    return null
  }
}

/** Хост из адреса: строка состояния печатает «куда проверяли», а не URL с путём. */
function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host
  } catch {
    return endpoint
  }
}

/**
 * Jev verdict configuration: the panel only chooses which provider and model do the adjudicating,
 * plus the timeout. The provider list, the endpoint template and the API key all come from the host —
 * the key never reaches this panel and is never stored by the plugin, so there is exactly one place
 * in DSH where providers and tokens are configured. The endpoint field is pre-filled from the chosen
 * provider's template but stays editable, and the model field accepts any name (the "load models"
 * button asks the provider for its live list and offers it as suggestions).
 */
function JevConfigCard({ t, toast }: { t: T; toast: ToastController }): React.ReactElement {
  const [view, setView] = useState<JevPanelView | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [provider, setProvider] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [model, setModel] = useState('')
  const [timeoutMs, setTimeoutMs] = useState('3000')
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [loadingModels, setLoadingModels] = useState(false)
  const [liveModels, setLiveModels] = useState<readonly string[]>([])
  const [liveFiltered, setLiveFiltered] = useState(false)
  /**
   * Последний замер связи — в localStorage, а не в состоянии процесса: строка «когда
   * проверяли и чем кончилось» остаётся правдой после перезагрузки панели, пока её
   * не перезапишет новая проверка.
   */
  const [lastRaw, setLastRaw] = usePersistedString('jevCheck', '')
  const last = useMemo(() => readJevCheck(lastRaw), [lastRaw])

  // Initial load: form starts from the saved override; providers come from DSH via the same response.
  useEffect(() => {
    let cancelled = false
    api<JevPanelView>('jev-config')
      .then((data) => {
        if (cancelled) return
        setView(data)
        setEnabled(data.enabled)
        setProvider(data.provider ?? '')
        setEndpoint(data.endpoint ?? '')
        setModel(data.model ?? '')
        setTimeoutMs(String(data.timeoutMs))
      })
      .catch((error: Error) => { if (!cancelled) toast.push('error', `${t('jevLoadFailed')}: ${error.message}`) })
    return () => { cancelled = true }
    // 依赖 toast.push（稳定引用）而非整个 toast 对象——曾构成死循环：加载失败弹
    // toast → 父组件重渲染 → toast 对象换新 → effect 重触发 → 再弹（审计 N19）。
  }, [t, toast.push])

  /** Choose a provider and pre-fill the endpoint from its template (the field stays editable). */
  const chooseProvider = (id: string): void => {
    setProvider(id)
    const chosen = (view?.providers ?? []).find(item => item.id === id)
    setEndpoint(chosen?.endpoint ?? '')
    setLiveModels([])
    setLiveFiltered(false)
  }

  const save = (): void => {
    setBusy(true)
    api<{ ok: boolean; view: JevPanelView }>('jev-config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Empty provider/model clears that field on the server; Jev then falls back to pure rules.
      body: JSON.stringify({
        enabled,
        provider,
        endpoint: endpoint.trim(),
        model: model.trim(),
        timeoutMs: Number(timeoutMs),
      }),
    })
      .then((data) => {
        setView(data.view)
        toast.push('success', t('jevSaved'))
      })
      .catch((error: Error) => { toast.push('error', error.message) })
      .finally(() => { setBusy(false) })
  }

  /** Ask the provider for its live model list; Jev-only models win when the provider reports any. */
  const loadModels = (): void => {
    if (provider === '') { toast.push('error', t('jevModelsNoProvider')); return }
    setLoadingModels(true)
    api<{ models: readonly string[]; filtered: boolean; error: string | undefined }>('jev-models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider }),
    })
      .then((result) => {
        if (result.error !== undefined) {
          setLiveModels([])
          setLiveFiltered(false)
          toast.push('error', `${t('jevModelsFailed')}: ${result.error}`)
          return
        }
        setLiveModels(result.models)
        setLiveFiltered(result.filtered)
        toast.push('success', result.filtered
          ? t('jevModelsFiltered', { count: result.models.length })
          : t('jevModelsLoaded', { count: result.models.length }))
      })
      .catch((error: Error) => { toast.push('error', error.message) })
      .finally(() => { setLoadingModels(false) })
  }

  // Connection test: a minimal ping question sent with the current field values (nothing is written),
  // which also proves that the model really speaks the System One protocol.
  // Рядом с тостом кладём замер в состояние строки: тост живёт секунды, а «чем кончилась
  // проверка» должно оставаться на экране — иначе кнопка выглядит как «ничего не произошло».
  const testConnection = (): void => {
    setTesting(true)
    api<{
      ok: boolean
      elapsedMs: number
      probability: number | undefined
      error: string | undefined
      status?: number
      kind?: JevCheckView['kind']
      endpoint?: string
      model?: string
      timeoutMs?: number
    }>('jev-test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider, model: model.trim(), endpoint: endpoint.trim() }),
    })
      .then((result) => {
        setLastRaw(JSON.stringify({
          at: Date.now(),
          ok: result.ok,
          elapsedMs: result.elapsedMs,
          probability: result.probability,
          status: result.status,
          kind: result.kind,
          error: result.error,
          // Сервер старше панели параметров замера не отдаёт — тогда честно берём форму.
          endpoint: result.endpoint ?? endpoint.trim(),
          model: result.model ?? model.trim(),
          timeoutMs: result.timeoutMs ?? Number(timeoutMs),
        } satisfies JevCheckView))
        if (result.ok) toast.push('success', t('jevTestOk', { ms: result.elapsedMs, p: result.probability }))
        else toast.push('error', t('jevTestFail', { error: result.error ?? '' }))
      })
      .catch((error: Error) => { toast.push('error', error.message) })
      .finally(() => { setTesting(false) })
  }

  if (view === null) return <span className={styles.jevMuted}>{t('loading')}</span>

  const selected = (view.providers ?? []).find(item => item.id === provider)
  // Suggestions: the provider's live list once loaded, otherwise the models from its DSH settings.
  const suggestions: readonly string[] = liveModels.length > 0
    ? liveModels
    : (selected?.models ?? []).map(item => item.id)

  /** Адрес, который уйдёт на сервер: поле панели, а пустое поле — шаблон выбранного провайдера. */
  const endpointShown = endpoint.trim() !== '' ? endpoint.trim() : (selected?.endpoint ?? '')
  /** Слово отказа: по нему видно, что чинить — сеть, тайм-аут или протокол. */
  const kindWord = (kind: JevCheckView['kind']): string => kind === 'http'
    ? t('jevKindHttp')
    : kind === 'network' ? t('jevKindNetwork')
      : kind === 'timeout' ? t('jevKindTimeout')
        : kind === 'shape' ? t('jevKindShape') : t('jevKindUnknown')
  const lastLine = last === null
    ? t('jevCheckNever')
    : last.ok
      ? t('jevCheckOk', {
        time: new Date(last.at).toLocaleString(),
        ms: last.elapsedMs,
        p: last.probability === undefined ? '—' : last.probability.toFixed(2),
        status: last.status ?? 200,
      })
      : t('jevCheckFail', { time: new Date(last.at).toLocaleString(), kind: kindWord(last.kind), ms: last.elapsedMs })

  return (
    <div className={styles.jev}>
      {/* 解释性长文收进「说明」折叠里（同回填块）：工具页第一屏先给控件。 */}
      <details className={styles.opsDetails}>
        <summary>{t('opsMoreInfo')}</summary>
        <p className={styles.jevIntro}>{t('jevIntro')}</p>
      </details>
      <div className={styles.jevToggleRow}>
        <label className={styles.jevToggle}>
          <input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />
          {t('jevEnabled')}
        </label>
        <span className={styles.jevStatus}>{view.enabled ? t('jevStatusOn') : t('jevStatusOff')}</span>
      </div>
      {/* Параметры проверки и последний замер: то же, что делает кнопка «Проверить
          соединение», но видно без нажатия — строка отвечает «куда, чем и когда», а
          тост живёт секунды. Полный текст отказа — в подсказке, чтобы строка не разъезжалась. */}
      <div className={styles.jevCheck}>
        <span>{t('jevCheckParams', {
          endpoint: endpointShown === '' ? '—' : hostOf(endpointShown),
          model: model.trim() === '' ? '—' : model.trim(),
          timeout: timeoutMs,
        })}</span>
        <span className={last !== null && !last.ok ? styles.jevCheckBad : undefined}
          title={last?.error ?? undefined}>{lastLine}</span>
      </div>
      <div className={styles.jevForm}>
        <label className={styles.jevField}>
          <span>{t('jevProvider')}</span>
          <select className={styles.input} value={provider} onChange={event => chooseProvider(event.target.value)}>
            <option value="">{t('jevProviderUnset')}</option>
            {(view.providers ?? []).map(item => (
              <option key={item.id} value={item.id}>{`${item.displayName} (${item.id})`}</option>
            ))}
          </select>
          <span className={styles.jevMuted}>{t('jevHostHint')}</span>
        </label>
        <label className={styles.jevField}>
          <span>{t('jevEndpointField')}</span>
          <input className={styles.input} value={endpoint} placeholder={t('jevEndpointTemplate')}
            onChange={event => setEndpoint(event.target.value)} />
        </label>
        <label className={styles.jevField}>
          <span>{t('jevModel')}</span>
          <input className={styles.input} value={model} list="jev-model-suggestions"
            onChange={event => setModel(event.target.value)} />
          <datalist id="jev-model-suggestions">
            {suggestions.map(id => <option key={id} value={id} />)}
          </datalist>
          <span className={styles.jevMuted}>{liveModels.length > 0
            ? (liveFiltered
              ? t('jevModelsFiltered', { count: liveModels.length })
              : t('jevModelsLoaded', { count: liveModels.length }))
            : t('jevModelHint')}</span>
        </label>
        <label className={styles.jevField}>
          <span>{t('jevTimeoutMs')}</span>
          <input className={styles.input} type="number" min={1000} max={60000} value={timeoutMs}
            onChange={event => setTimeoutMs(event.target.value)} />
        </label>
      </div>
      <div className={styles.jevMuted}>{t('jevThresholdsTitle')}</div>
      <div className={styles.jevMuted}>{t('jevThresholdLine', {
        merge: view.deferMergeAbove,
        accept: view.deferAcceptBelow,
        contradict: view.contradictMinProbability,
      })}</div>
      <div className={styles.jevActions}>
        <button type="button" className={`${styles.button} ${styles.primary}`} disabled={busy} onClick={save}>
          {t('jevSave')}
        </button>
        <button type="button" className={styles.button} disabled={busy || testing} onClick={testConnection}>
          {t('jevTest')}
        </button>
        <button type="button" className={styles.button} disabled={busy || loadingModels} onClick={loadModels}>
          {t('jevLoadModels')}
        </button>
      </div>
    </div>
  )
}

/** 近期裁决观测行视图（GET /api/engram/jev-observations 的 items 元素）。 */
interface JevObservationView {
  readonly at: number
  readonly site: 'band' | 'contradiction'
  readonly question: string
  readonly answered: boolean
  readonly probability: number | undefined
  readonly elapsedMs: number
  readonly error: string | undefined
  readonly verdict: 'merge' | 'accept' | 'defer' | 'confirm' | 'reject' | 'fallback'
}

/** verdict → 徽标文案键（动态模板字符串在 EngramKey union 下不可静态检查，改用映射表）。 */
const VERDICT_KEY: Readonly<Record<JevObservationView['verdict'], EngramKey>> = {
  merge: 'jevObsVerdictMerge',
  accept: 'jevObsVerdictAccept',
  defer: 'jevObsVerdictDefer',
  confirm: 'jevObsVerdictConfirm',
  reject: 'jevObsVerdictReject',
  fallback: 'jevObsVerdictFallback',
}

/**
 * 近期裁决观测：轮询 /api/engram/jev-observations（1.5s），展示判定结果 / Jev 是否给出答案 /
 * 耗时 / 回落原因，帮助排查「这条为什么被搁置」。数据只存进程内存，重启清空。
 */
function JevObservationsCard({ t, toast }: { t: T; toast: ToastController }): React.ReactElement {
  const [items, setItems] = useState<readonly JevObservationView[] | null>(null)

  useEffect(() => {
    let cancelled = false
    // 初载失败弹 toast；轮询失败静默重试（观测卡不值得刷屏打扰）。
    const reload = (reportFailure: boolean): void => {
      api<{ items: readonly JevObservationView[] }>('jev-observations')
        .then((data) => { if (!cancelled) setItems(data.items) })
        .catch((error: Error) => {
          if (cancelled) return
          setItems(previous => previous ?? [])
          if (reportFailure) toast.push('error', `${t('jevObsLoadFailed')}: ${error.message}`)
        })
    }
    reload(true)
    const timer = window.setInterval(() => reload(false), 1500)
    return () => { cancelled = true; window.clearInterval(timer) }
    // toast.push 稳定引用：整个对象每渲染换新，曾让 1.5s 轮询器每次渲染拆了重建（审计 N19）。
  }, [t, toast.push])

  if (items === null) return <span className={styles.jevMuted}>{t('loading')}</span>
  if (items.length === 0) return <span className={styles.jevMuted}>{t('jevObsEmpty')}</span>

  return (
    <div className={styles.jevObs}>
      <div className={styles.jevObsHead}>{t('jevObsTitle')}</div>
      {items.map((item, index) => (
        <div key={`${item.at}-${item.site}-${index}`} className={styles.jevObsItem}>
          <span className={styles.jevObsTime}>{new Date(item.at).toLocaleTimeString()}</span>
          <span>{item.site === 'band' ? t('jevObsSiteBand') : t('jevObsSiteContradiction')}</span>
          <span className={item.verdict === 'fallback'
            ? styles.jevObsBadgeWarn
            : item.verdict === 'confirm' || item.verdict === 'merge' ? styles.jevObsBadgeGood : styles.jevObsBadge}>
            {t(VERDICT_KEY[item.verdict])}
          </span>
          <span>{item.answered ? `p=${item.probability?.toFixed(3)}` : t('jevObsNoAnswer')}</span>
          <span>{item.elapsedMs}ms</span>
          {item.error !== undefined && <span className={styles.jevObsError}>{t('jevObsErrorLine', { error: item.error })}</span>}
        </div>
      ))}
    </div>
  )
}

/** 导入预览条目与汇总（POST /api/engram/import dryRun=true 的响应形状）。 */
interface ImportEntryView {
  readonly id: string
  readonly kind: string
  readonly status: string
  readonly content: string
  readonly classification: 'new' | 'duplicate' | 'conflict'
  readonly duplicateOf?: string
}
interface ImportPreviewView {
  readonly entries: readonly ImportEntryView[]
  readonly edgesTotal: number
  readonly edgesDangling: number
  readonly entitiesNew: number
  readonly entitiesMerged: number
  /** markdown 导出文件带脱敏标记时置位（内容为截断预览，导入得到的是预览文本）。 */
  readonly redacted?: boolean
}
interface ImportResultView {
  readonly imported: number
  readonly embedded: number
  readonly skippedDuplicates: number
  readonly conflicts: number
  readonly edgesLinked: number
  readonly edgesDangling: number
}

/** 导出下拉：把三种格式（Markdown / JSON / 镜像目录）合并成一个按钮 + 弹出列表。
 *  MD/JSON 是浏览器直连的 GET 下载（attachment 头，不走 api()）；镜像目录曾用 <a href> 直跳，
 *  但该路由返回裸 JSON，宿主 webview 顶层导航到它会把面板带崩（实机报告）——改为 fetch + toast。
 *  project 宫殿选择器在直连链接里手工拼接，fetch 路径由 api() 代管。 */
function ExportMenu({ t, scope, project, toast }: {
  t: T
  scope: 'user' | 'project' | 'shared'
  /** 项目宫殿选择器：仅在 project 作用域拼接（null = 服务端走进程默认库）。 */
  project: string | null
  toast: ToastController
}): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [mirrorBusy, setMirrorBusy] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const handler = (event: MouseEvent): void => {
      if (wrapRef.current === null || !wrapRef.current.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', handler)
    return () => { window.removeEventListener('mousedown', handler) }
  }, [open])
  const projectQuery = scope === 'project' && project !== null ? `&project=${encodeURIComponent(project)}` : ''
  const exportMirror = async (): Promise<void> => {
    if (mirrorBusy) return
    setMirrorBusy(true)
    try {
      const report = await api<{ rootDir: string; fileCount: number; memoryCount: number }>(`mirror?scope=${scope}${projectQuery}`)
      toast.push('success', t('mirrorExportDone', { path: report.rootDir, files: report.fileCount, records: report.memoryCount }))
      setOpen(false)
    } catch (error) {
      toast.push('error', error instanceof Error ? error.message : String(error))
    } finally {
      setMirrorBusy(false)
    }
  }
  return (
    <div className={styles.exportWrap} ref={wrapRef}>
      <button type="button" className={styles.button} aria-haspopup="menu" aria-expanded={open}
        title={t('export')} aria-label={t('export')}
        onClick={() => { setOpen(value => !value) }}>
        <Icon name="export" className={styles.brandIcon} />
        <span className={styles.exportCaret} aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className={styles.exportMenu} role="menu">
          <a role="menuitem" className={styles.exportItem}
            href={`/api/engram/export?scope=${scope}${projectQuery}&format=markdown`}
            onClick={() => { setOpen(false) }}>
            <span className={styles.exportItemLabel}>{t('exportMd')}</span>
            <span className={styles.exportItemHint}>{t('exportMdHint')}</span>
          </a>
          <a role="menuitem" className={styles.exportItem}
            href={`/api/engram/export?scope=${scope}${projectQuery}&format=json`}
            onClick={() => { setOpen(false) }}>
            <span className={styles.exportItemLabel}>{t('exportJson')}</span>
            <span className={styles.exportItemHint}>{t('exportJsonHint')}</span>
          </a>
          <button type="button" role="menuitem" className={styles.exportItem} disabled={mirrorBusy}
            onClick={() => { void exportMirror() }}>
            <span className={styles.exportItemLabel}>{t('exportMirror')}</span>
            <span className={styles.exportItemHint}>{mirrorBusy ? t('importImporting') : t('exportMirrorHint')}</span>
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * Ответ ручек починки (`base-label`, `base-convert`).
 *
 * Обе возвращают сделанное и не сделанное списками: `written` — базы, которым записали
 * метку, `converted` — сколько строк пересчитали векторы, `failed` — что не вышло и
 * почему. Код ответа при этом 200, поэтому «сервер отказал» видно только здесь.
 */
interface BaseRepairPart {
  readonly written: readonly { readonly file?: string }[]
  readonly converted?: number
  readonly failed: readonly { readonly file?: string, readonly error?: string }[]
}

/** Одна база дворца в ответе `registry` (host 侧 BaseView). */
interface RegistryBase {
  readonly file: string
  readonly scope: 'user' | 'shared' | 'project'
  readonly title: string | null
  readonly label: string | null
  readonly targetLabel: string | null
  /** Состояние базы; null — не проверено (объявление схемы о другой версии базы). */
  readonly state: string | null
  /** Что сделает кнопка; null — действие не определено, потому что не проверено. */
  readonly action: string | null
  readonly rows: number
  readonly missing: number
  readonly foreign: number
  readonly dims: readonly number[]
  readonly checked: boolean
  readonly problems: readonly { readonly kind: string, readonly detail: string }[]
}

/** GET /api/engram/registry 的返回（host 侧 RegistryView，字段名与响应一一对应）。 */
interface RegistrySnapshot {
  readonly language: string
  /** Язык дворца: чем определён; null — язык пришёл из настройки, решать было нечего. */
  readonly palace: {
    readonly setting: string | null
    readonly source: string
    readonly conflict: boolean
    /** Локаль машины как есть: «ru», «fr», пустая строка — прочитать не удалось. */
    readonly machine: string
    /** Язык диалогов этой сессии; null — реплик ещё не было. */
    readonly dialogue: string | null
    /** Язык, на котором стоят базы по меткам; null — метки нет, `mixed` — разные. */
    readonly bases: string | null
    /** `auto` — дворец настраивается сам; `ask` — спрашиваем; `mismatch` — языки разошлись. */
    readonly state: string
  } | null
  readonly defaultLanguage: string | null
  /**
   * Длина окна собранного условия смены языка дворца, секунды (настройка).
   *
   * Одно число на панель и сервер: панель считает по нему отсчёт и показывает остаток,
   * сервер — принимает ли запрос смены языка. Приходит снимком, а не константой клиента.
   */
  readonly palaceChangeWindowSec: number
  /** Языки дворца, которые знает поставка: от неё же зависит, что предлагать в выборе. */
  readonly languages: readonly PalaceLanguageOption[]
  readonly remote: boolean
  readonly resolved: { readonly id: string; readonly label: string | null; readonly source: string; readonly pooling: string; readonly dtype: string } | null
  readonly models: readonly { readonly id: string; readonly label: string | null; readonly pooling: string; readonly dtype: string; readonly dimensions: number | null; readonly languages: readonly string[] }[]
  /**
   * Языки моделей, у которых словарь уже заведён. Список терпит отсутствие поля по той
   * же причине, что и `languages`: клиент и сервер едут разными файлами.
   */
  readonly dictionaryLanguages?: readonly string[]
  readonly bindings: readonly { readonly language: string; readonly model: string }[]
  readonly files: readonly string[]
  readonly problems: readonly { readonly file: string; readonly kind: string; readonly detail: string }[]
  readonly dictionaries: readonly {
    readonly name: string
    readonly files: readonly string[]
    readonly entries: number
    readonly problems: readonly { readonly file: string; readonly line: number; readonly kind: string; readonly detail: string }[]
  }[]
  /** Базы дворца: состояние каждой и что с ней сделает кнопка. */
  readonly bases: readonly RegistryBase[]
  /** Сколько баз ещё нет: их создаёт код автора, не мы. */
  readonly pendingBases: number
  /** Подключён ли пересчёт векторов (этап 2 блока Б). */
  readonly convertAvailable: boolean
}

/**
 * Языки дворца, которые можно выбрать: приходят с сервера (`GET registry`).
 *
 * Своего списка в клиенте нет намеренно. Раньше здесь лежала копия тройки
 * `zh|en|ru`, и язык, добавленный файлом `registry/languages.json`, появлялся на
 * сервере, но не в списке выбора — то есть «язык как данные» не доходил до человека.
 */
interface PalaceLanguageOption {
  readonly code: string
  readonly label: string
  /** Есть ли у плагина вшитый набор текстов; иначе язык говорит словарём из файла. */
  readonly builtin: boolean
}

/**
 * Код языка по форме: две-три латинские буквы, при желании с подтегами (`zh-Hans`).
 *
 * Повторяет проверку сервера (`i18n/language.ts`, `isLanguageCode`). Нужен здесь
 * для одного случая — четвёртый выбор передаёт локаль машины как есть (`fr`), и
 * отправлять на сервер строку, которую он заведомо отвергнет, незачем.
 */
const LANGUAGE_CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/

/**
 * Окно предохранителя до ответа сервера, секунды.
 *
 * Рабочее значение — настройка `palaceChangeWindowSec`: она приходит в снимке
 * обслуживания, и по ней же считает сервер. Это число нужно только для первой
 * отрисовки окна проверки, пока снимок не пришёл, — и совпадает с умолчанием настройки.
 */
const GUARD_SECONDS = 30

/**
 * Сколько висит сообщение об итоге обслуживания.
 *
 * Обычного срока тоста не хватает: пока человек читает причину отказа, сообщение уже
 * ушло, и остаётся впечатление «мелькнуло и всё». Полминуты — чтобы успеть прочитать,
 * и не настолько много, чтобы сообщение мешало.
 */
const TOAST_LONG_MS = 30_000

/** 文件全路径只留文件名：卡片里要的是「какой файл», а не «где лежит пакет». */
function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut < 0 ? path : path.slice(cut + 1)
}

/**
 * Состояние базы → ключ文案: динамическая строка под union `EngramKey` статически
 * не проверяется, поэтому таблица, а не шаблон. Состояния приходят с сервера теми
 * же именами, что в `registry/base-state.ts`.
 */
const BASE_STATE_KEY: Readonly<Record<string, EngramKey>> = {
  absent: 'baseStateAbsent',
  empty: 'baseStateEmpty',
  normal: 'baseStateNormal',
  'no-label': 'baseStateNoLabel',
  'other-model': 'baseStateOtherModel',
  'mixed-dims': 'baseStateMixedDims',
  'missing-vectors': 'baseStateMissingVectors',
}

/**
 * Обслуживание: чем считается содержимое дворца и откуда взялись слова.
 *
 * Карточка намеренно только смотрит: выбор модели и правка словарей — отдельные
 * операции со своими последствиями (пересборка векторов), и решать их должна
 * явная форма, а не эта. Здесь видно состояние: какая модель выбрана, по какому
 * правилу, что лежит в каталоге и какие файлы словарей прочитаны.
 *
 * Тексты берутся из вшитых словарей панели (locales/*.ts): в них уже есть все
 * ключи обслуживания, и они переключаются вместе с языком панели.
 */
/**
 * Название языка для списка: из реестра, а если языка там нет — из справочника браузера.
 *
 * `Intl.DisplayNames` — стандартная часть браузера, а не данные плагина. Свой список
 * названий на полсотни языков пришлось бы заводить и переводить руками на каждый язык,
 * тогда как браузер уже знает, как называется `de` по-русски и по-китайски.
 *
 * Справочник создаётся один раз на язык панели и запоминается: это не бесплатная операция,
 * а вызывается она на каждый рендер строки словарей.
 */
const displayNameCache = new Map<string, Intl.DisplayNames | null>()
function languageLabel(code: string, known: readonly PalaceLanguageOption[], locale: string): string {
  const registered = known.find(row => row.code === code)?.label
  if (registered !== undefined) return registered
  let names = displayNameCache.get(locale)
  if (names === undefined) {
    try {
      names = new Intl.DisplayNames([locale], { type: 'language' })
    } catch {
      // Старый браузер без `DisplayNames` — показываем код: он всегда верен.
      names = null
    }
    displayNameCache.set(locale, names)
  }
  const label = names?.of(code)
  return label === undefined || label === '' ? code.toUpperCase() : label
}

/**
 * Блок «Язык дворца и базы»: состояние памяти (язык, модель, каждая база) и действия
 * над ним — сменить язык, починить векторы.
 *
 * Отдельная карточка, а не половина одной общей: таблицы моделей и баз живут в широкой
 * колонке, словари — в узкой. Снимок обслуживания приходит сверху, общий.
 */
function PalaceLanguageCard({ t, snapshot, onReload, blockRefs, toast }: {
  readonly t: T
  /** Снимок обслуживания: язык, модель, базы. */
  readonly snapshot: RegistrySnapshot
  /** Перечитать снимок (после починки или смены языка); OpsTab 的 useApi.reload 返回 void。 */
  readonly onReload: () => void | Promise<void>
  /** Узел блока для верхней навигации по странице обслуживания. */
  readonly blockRefs?: { readonly current: Record<string, HTMLElement | null> }
  /**
   * Общий контроллер тостов секции. Своего здесь быть не должно: вьюпорт тостов
   * смонтирован один, в EngramSection, — приватный экземпляр рендерил уведомления
   * в пустоту, и «Починить базы» выглядела кнопкой, которая ничего не делает.
   */
  readonly toast: ToastController
}): React.ReactElement {
  const [busy, setBusy] = useState(false)
  /**
   * Замок на смену языка дворца: по умолчанию закрыт.
   *
   * Порядок действий задаёт он же: снял замок — ожил выбор языка, выбрал другой язык —
   * ожила кнопка «Выполнить». Пока язык не изменён, кнопка молчит: пересчёт баз идёт
   * только вместе со сменой языка.
   *
   * Состояние намеренно НЕ хранится между заходами: снятый замок, переживший выход из
   * панели, оставлял бы дорогое действие открытым для случайного нажатия.
   */
  const [locked, setLocked] = useState(true)
  /**
   * Перехват последней починки: что вызвано и что ответил сервер.
   *
   * Тост живёт секунды и уносит причину с собой — человек видит «мелькнуло» и не знает,
   * чем кончилось. Поэтому итог остаётся строкой под кнопкой и держится до следующего
   * нажатия или до перезагрузки страницы. Это же и есть перехват: если строка не
   * изменилась после нажатия, значит нажатие не дошло до обработчика.
   */
  const [lastRepair, setLastRepair] = useState<string | null>(null)
  /**
   * Язык, выбранный в блоке «Язык дворца», но ещё не записанный.
   *
   * Пока он не отправлен, в настройке ничего не меняется: выбор — это первое из трёх
   * событий собранного условия, а не сама смена языка (решение 20–21.10).
   */
  const [pending, setPending] = useState<string | null>(null)
  /** Момент первого из трёх событий: с него идёт окно. null — окно не начато. */
  const [startedAt, setStartedAt] = useState<number | null>(null)
  /** Остаток окна в секундах: подпись у предохранителя и признак «ещё можно». */
  const [left, setLeft] = useState(0)
  const tt = (key: EngramKey, params?: Record<string, string | number>): string => t(key, params)
  /**
   * Длина окна: считается по настройке, а не по константе — сервер проверяет тем же
   * числом. Читается из снимка, а снимка до загрузки ещё нет, поэтому здесь терпит
   * пустоту: значение нужно таймеру, а таймер обязан стоять до ранних выходов
   * (ниже), иначе первый рендер рисует на один хук меньше, чем второй, и React
   * падает с ошибкой #310 — «хуков больше, чем в прошлом рендере».
   */
  const windowSec = snapshot?.palaceChangeWindowSec ?? GUARD_SECONDS

  /**
   * Окно собранного условия: тикает, пока начато, и по нулю возвращает всё назад.
   *
   * Сброс — не наказание, а восстановление: выбор возвращается к языку, на котором стоят
   * базы, предохранитель встаёт на место, и человек видит, что окно закрылось. Молчаливое
   * «ничего не произошло» здесь хуже всего: непонятно, сработало ли нажатие.
   *
   * Стоит до ранних выходов — порядок хуков не должен зависеть от того, пришёл ли снимок.
   * Зависимости — стабильные ссылки: `t` меняется только вместе с языком панели, а в
   * `toast` стабилен только `push` — сам контроллер пересоздаётся на каждый рендер
   * секции, и быть зависимостью не может.
   */
  useEffect(() => {
    if (startedAt === null) {
      setLeft(windowSec)
      return undefined
    }
    const tick = (): void => {
      const rest = windowLeft(startedAt, Date.now(), windowSec)
      setLeft(rest)
      if (rest > 0) return
      setStartedAt(null)
      setPending(null)
      setLocked(true)
      toast.push('reset', t('guardReset', { seconds: windowSec }))
    }
    tick()
    const id = setInterval(tick, 500)
    return () => { clearInterval(id) }
  }, [startedAt, windowSec, toast.push, t])

  /**
   * Языки реестра. Стоит до ранних выходов: от них зависят подписи языков в блоке
   * обслуживания, а он собирается уже после ранних выходов.
   *
   * Список терпит отсутствие поля: клиент и сервер плагина едут разными файлами, и сразу
   * после обновления клиент может оказаться новее сервера — тогда `languages` в снимке нет.
   */
  const languages = snapshot?.languages ?? []

  const resolvedLabel = snapshot.resolved === null
    ? tt('registryNone')
    : snapshot.resolved.label ?? snapshot.resolved.id
  /**
   * Язык дворца в настройке: «чем записано» — в отличие от `snapshot.language`, которым
   * этот процесс считает прямо сейчас. До перезапуска они могут расходиться, и панель
   * обязана показывать оба, а не выбирать за человека, какой из них настоящий.
   */
  const currentLanguage = snapshot.palace?.setting ?? snapshot.language
  /** Что показано в выборе: несохранённый выбор, иначе записанный язык. */
  const chosenLanguage = pending ?? currentLanguage
  const languageChanged = chosenLanguage !== currentLanguage
  /**
   * Список выбора языка дворца: языки реестра с сервера плюс текущий, если его там
   * нет. Записанный язык мог прийти из настройки или быть объявлен файлом
   * `languages.json` на этой машине; без такой строки `select` показал бы пустое
   * поле вместо языка, на котором дворец на самом деле стоит.
   */
  const languageOptions = languages.some(row => row.code === chosenLanguage)
    ? languages
    : [...languages, { code: chosenLanguage, label: chosenLanguage.toUpperCase(), builtin: false }]

  /**
   * Язык дворца словом — «Русский», а не `RU`. Код остаётся для машин и для
   * `select`, где он служит значением; в строке состояния человек читает название,
   * и взять его можно только из реестра языков.
   */
  const palaceLanguageName = languages.find(row => row.code === currentLanguage)?.label
    ?? currentLanguage.toUpperCase()

  // Состояние баз одной строкой для верхнего ряда: это индикатор, а не действие.
  const actions = (snapshot.bases ?? []).map(base => base.action)
  const todo: 'convert' | 'repair' | 'write-label' | 'none' = actions.includes('convert')
    ? 'convert'
    : actions.includes('repair') ? 'repair' : actions.includes('write-label') ? 'write-label' : 'none'

  /**
   * Состояние баз одним из трёх слов — только они и есть: в порядке, требует
   * ремонта, требует конвертации.
   *
   * «Ремонт» здесь широкий и означает «надо поправить записи»: и растерянные
   * векторы, и базу без метки модели — второе лечится тем же нажатием. Отдельного
   * четвёртого состояния у строки нет намеренно: человеку важно, придётся ли ему
   * что-то делать, а не как называется причина.
   *
   * У конвертации приоритет не по важности, а по существу: она пересчитывает всё
   * подряд и заодно устраняет то, что чинил бы ремонт. Показывать «ремонт» рядом с
   * базой, которую всё равно ждёт пересчёт, значило бы предлагать два действия там,
   * где нужно одно.
   */
  const baseKind: 'ok' | 'repair' | 'convert' = todo === 'convert'
    ? 'convert'
    : todo === 'none' ? 'ok' : 'repair'

  const baseStateText = baseKind === 'convert'
    ? tt('baseStateConvert')
    : baseKind === 'repair' ? tt('baseStateRepair') : tt('baseStateOk')

  /**
   * Цвет сообщения: у беды два оттенка — ремонт обычный, конвертация жирная, потому
   * что за ней стоит смена языка, а не только правка строк. Порядок в порядке
   * зелёный: это не тревога, а ответ «делать нечего».
   */
  const baseStateClass = baseKind === 'ok'
    ? styles.baseStateGood
    : baseKind === 'convert' ? styles.baseStateAlarm : styles.baseStateBad

  /**
   * Первое из трёх событий открывает окно; следующие его не продлевают.
   *
   * Окно открывает сервер: он сам запоминает момент и язык, на котором стояли базы, —
   * поэтому клиент не может ни продлить окно, ни назвать «язык, от которого уходят»
   * (решение 24.10). Панель берёт у сервера начало отсчёта и показывает его, но основание
   * решения остаётся на сервере.
   */
  const beginWindow = (): void => {
    if (startedAt !== null) return
    void api<{ ok: boolean, startedAt: number, left: number }>('palace-change/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
      .then((answer) => {
        if (!answer.ok) return
        setStartedAt(answer.startedAt)
        setLeft(answer.left)
      })
      .catch(() => { /* окно не открылось — кнопка останется запертой, и это правильно */ })
  }

  /** Выбор языка: первое событие окна, в настройку ничего не пишется. */
  const pickLanguage = (language: string): void => {
    if (language === currentLanguage) { setPending(null); return }
    setPending(language)
    beginWindow()
  }

  /**
   * Замок: пока он закрыт, ни выбор языка, ни починка не срабатывают.
   *
   * При смене языка снятие замка — ещё и первое событие окна: человек открыл дорогу к
   * выбору, дальше он выбирает язык, и только тогда оживает «Выполнить».
   *
   * При ремонте окна нет вовсе (решение 22.10): починка не меняет ни язык, ни модель,
   * это правка строк в тех же самых базах. Охраняет её один замок — снят, значит можно
   * нажимать; отсчёт, который через полминуты запер бы кнопку, здесь только мешал бы.
   */
  const toggleLock = (next: boolean): void => {
    setLocked(next)
    if (!next && baseKind === 'convert') beginWindow()
  }

  /** Причина отказа сервера — словами: код отказа человеку ничего не говорит. */
  const reasonText = (reason?: string): string => reason === 'window'
    ? tt('palaceChangeReasonWindow')
    : reason === 'not-changed' ? tt('palaceChangeReasonChanged')
      : reason === 'not-a-code' ? tt('palaceChangeReasonCode') : tt('palaceChangeReasonStart')

  /**
   * Смена языка собранным условием: снят замок + выбран другой язык + нажатие, всё в окне.
   *
   * Язык, метки и пересчёт уходят одним запросом: сервер проверяет окно и только потом
   * пишет настройку, ставит метки и пересчитывает векторы. Разделять это на три запроса
   * значило бы оставить состояния «язык уже новый, базы ещё старые» без присмотра.
   *
   * Без смены языка кнопка не работает вовсе: пересчёт идёт только вместе с языком.
   */
  const applyChange = (): void => {
    if (busy || locked || !languageChanged) return
    if (startedAt === null || left <= 0) return
    setBusy(true)
    void api<{
      ok: boolean
      language: string
      error?: string
      reason?: string
      labels?: { readonly written: readonly unknown[], readonly failed: readonly unknown[] } | null
      convert?: { readonly converted: number, readonly failed: readonly unknown[] } | null
    }>('palace-change', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Только выбранный язык: окно и «язык, от которого уходят» сервер знает сам.
      // Присылать их отсюда было бы всё равно, что не присылать ничего, — проверялся бы
      // присланное, а не состояние (ревью #36).
      body: JSON.stringify({ language: chosenLanguage }),
    })
      .then(async (answer) => {
        if (!answer.ok) {
          toast.push('error', tt('palaceChangeRefused', { reason: reasonText(answer.reason) }))
          return
        }
        toast.push('success', tt('palaceChangeDone', {
          language: answer.language.toUpperCase(),
          labels: answer.labels?.written.length ?? 0,
          converted: answer.convert?.converted ?? 0,
        }))
        setPending(null)
        setStartedAt(null)
        setLocked(true)
        await onReload()
      })
      .catch((changeError: Error) => { toast.push('error', changeError.message) })
      .finally(() => { setBusy(false) })
  }

  /**
   * Починка баз: всё, что можно поправить без смены языка и модели.
   *
   * Два запроса, а не один, потому что это два разных дела: сначала метки моделей
   * (маршрут `base-label` — он пишет строку только тем базам, которым она нужна),
   * потом пересчёт строк с пустыми и неправильными векторами (`base-convert`). Окно и
   * выбор языка здесь не участвуют вовсе: ни настройка, ни модель не меняются, а
   * охраняет нажатие один замок.
   *
   * Порядок именно такой: метка говорит, на какой модели стоит база, и пересчёт,
   * начатый раньше неё, считал бы по догадке.
   *
   * Отказ сервера не прячется за словом «готово»: обе ручки возвращают списки `failed`,
   * и сервер умеет отказать целиком с кодом 200 — когда, например, модель эмбеддингов
   * ещё не поднялась. Раньше панель смотрела только на числа и говорила «починено» при
   * нулях; человек видел мгновенный тост, а база оставалась с дырками. Теперь сначала
   * называются отказы, и только если их нет — итог по числам.
   */
  const repairBases = (): void => {
    if (busy || locked) return
    setBusy(true)
    const steps: string[] = []
    const began = Date.now()
    setLastRepair(tt('baseRepairRunning'))
    // Аргументов у обеих ручек нет: всё, что им нужно, они берут из настроек. Заголовок
    // JSON подставляет сам `api` — у него это правило для всех POST.
    const post = { method: 'POST' } as const
    void api<BaseRepairPart>('base-label', post)
      .then(async (labels) => {
        steps.push(`base-label: меток ${labels.written.length}, отказов ${labels.failed.length}`)
        const convert = await api<BaseRepairPart>('base-convert', post)
        steps.push(`base-convert: пересчитано ${convert.converted ?? 0}, отказов ${convert.failed.length}`)
        const failures = [...labels.failed, ...convert.failed]
        const written = labels.written.length
        const converted = convert.converted ?? 0
        // Держим итог на экране: тост уходит через секунды, а разбираться приходится
        // потом. Длительность тоста — на случай, если человек смотрит не в панель.
        if (failures.length > 0) {
          const first = failures.map(row => row.error ?? '').find(text => text !== '') ?? ''
          steps.push(first === '' ? `отказов ${failures.length}` : first)
          toast.push('error', tt('baseRepairFailed', {
            error: first === '' ? tt('baseRepairFailedCount', { n: failures.length }) : first,
          }), TOAST_LONG_MS)
        } else if (written === 0 && converted === 0) {
          // Сервер не назвал ни одной ошибки, но и не сделал ничего. Молчать об этом
          // нельзя: для человека это выглядит как «кнопка не работает».
          steps.push('ничего не сделано')
          toast.push('warning', tt('baseRepairNothing'), TOAST_LONG_MS)
        } else {
          toast.push('success', tt('baseRepairDone', { labels: written, converted }), TOAST_LONG_MS)
        }
        steps.push(`${((Date.now() - began) / 1000).toFixed(1)} с`)
        setLastRepair(tt('baseRepairTrace', { steps: steps.join(' → ') }))
        await onReload()
      })
      .catch((repairError: Error) => {
        steps.push(`ошибка: ${repairError.message}`)
        setLastRepair(tt('baseRepairTrace', { steps: steps.join(' → ') }))
        toast.push('error', tt('baseRepairFailed', { error: repairError.message }), TOAST_LONG_MS)
      })
      .finally(() => { setBusy(false) })
  }

  /** Язык диалогов с агентом: у сессии без реплик его ещё нет. */
  /**
   * Строка проблемы базы — словами панели.
   *
   * Сервер отдаёт `kind` машинным ключом и `detail` безъязыковым фактом
   * (имя таблицы, версии `v11→v13`), а не готовой фразой: готовая фраза была
   * зашита по-русски и в китайском интерфейсе вылезала посреди китайских строк.
   * Неизвестный вид оставляем как есть — лучше сырой факт, чем пустота.
   */
  const baseProblemText = (problem: { readonly kind: string; readonly detail: string }): string => {
    if (problem.kind === 'no-table') {
      return tt('baseProblemNoTable', { table: problem.detail })
    }
    if (problem.kind === 'schema-version') {
      const versions = [...problem.detail.matchAll(/v(\d+)/g)].map(match => match[1] ?? '')
      const [found, expected] = versions
      if (found !== undefined && expected !== undefined) {
        return tt('baseProblemSchemaVersion', { found: `v${found}`, expected: `v${expected}` })
      }
    }
    return problem.detail
  }

  const dialogueLabel = snapshot.palace?.dialogue == null
    ? tt('palaceDialogueNone')
    : snapshot.palace.dialogue.toUpperCase()

  /** Язык, на котором стоят базы по меткам. */
  const basesLabel = snapshot.palace?.bases == null
    ? tt('palaceBasesNone')
    : snapshot.palace.bases === 'mixed' ? tt('palaceBasesMixed') : snapshot.palace.bases.toUpperCase()

  /**
   * Метки языков у модели. Привязка `*` означает «все языки без явной привязки» — она
   * и есть метка этой модели, поэтому показывается словом, а не звёздочкой.
   */
  const languagesOfModel = (modelId: string): string => {
    const bound = snapshot.bindings.filter(row => row.model === modelId)
    if (bound.length === 0) return tt('registryNone')
    return bound.map(row => row.language === '*'
      ? tt('registryAllLanguages')
      : languages.find(option => option.code === row.language)?.label ?? row.language.toUpperCase())
      .join(' · ')
  }

  return (
      <div className={`${styles.panelCard} ${styles.opsBlock}`}
        ref={element => { if (blockRefs !== undefined) blockRefs.current.palace = element }}>
        <div className={styles.cardHead}>
          <h3 className={styles.cardTitle}>{tt('palaceLanguageTitle')}</h3>
        </div>
        {/* Строка состояния — только чтение: чем дворец думает (словом), что стоит в
            базах (буквами) и что с базами. */}
        <div className={styles.palaceChangeRow}>
          <span className={styles.regLabel}>{tt('palaceLanguageName')}</span>
          <span className={styles.regValue}>{palaceLanguageName}</span>
          <span className={styles.regLabel}>{tt('palaceBasesLine')}</span>
          <span className={styles.regMono} title={tt('palaceBasesHint')}>{basesLabel}</span>
          <span className={baseStateClass}>{baseStateText}</span>
        </div>
        {/* Что именно не так — словами, а не словом «конвертация»: иначе человек
            видит красную метку и не знает, что с ней делать. */}
        {baseKind === 'convert' && <p className={styles.regNote}>{tt('baseStateConvertHint')}</p>}
        {baseKind === 'repair' && <p className={styles.regNote}>{tt('baseStateRepairHint')}</p>}
        {/* Два факта о модели нужны всегда, а не только когда базы в разнобой:
            какой моделью считают память и на каком языке с нами говорят. */}
        <dl className={styles.regKV}>
          <dt>{tt('palaceThoughtsModelLine')}</dt>
          <dd>
            {currentLanguage.toUpperCase()}
            {' · '}
            <span className={styles.regMono}>{resolvedLabel}</span>
          </dd>
        </dl>
        <p className={styles.regNote}>{tt('palaceThoughtsModelHint')}</p>
        <dl className={styles.regKV}>
          <dt>{tt('palaceDialogueLine')}</dt>
          <dd>
            {dialogueLabel}
            <span className={styles.regHint}>{tt('palaceDialogueHint')}</span>
          </dd>
        </dl>
        {/* Действие — только когда есть что делать. */}
            {baseKind === 'convert' && (<>
              <div className={styles.palaceChangeRow}>
                <span className={`${styles.regLabel} ${styles.regLangPush}`}>
                  {tt('palaceLanguageChange')}
                </span>
                <select className={`${styles.input} ${styles.regLang}`}
                  value={chosenLanguage} disabled={locked}
                  aria-label={tt('palaceLanguageChange')}
                  onChange={event => { pickLanguage(event.target.value) }}>
                  {languageOptions.map(row => (
                    <option key={row.code} value={row.code}>{row.label}</option>
                  ))}
                </select>
              </div>
              <p className={styles.regNote}>{tt('palaceChangeHint', { seconds: windowSec })}</p>
            </>)}
            {baseKind !== 'ok' && (
              <div className={styles.baseRunRow}>
                <label className={styles.regGuard}>
                  <input type="checkbox" checked={locked}
                    onChange={event => { toggleLock(event.target.checked) }} />
                  <span>{tt('baseLock')}</span>
                </label>
                <button type="button" className={`${styles.button} ${styles.primary}`}
                  disabled={busy || locked || (baseKind === 'convert'
                    && (!languageChanged || startedAt === null || left <= 0))}
                  onClick={baseKind === 'convert' ? applyChange : repairBases}>
                  {busy ? tt('baseRunBusy') : tt('baseRun')}
                </button>
                <span className={styles.baseRunNote}>
                  {baseKind === 'convert'
                    ? (languageChanged ? tt('baseActionConvert') : tt('baseRunNeedLanguage'))
                    : tt('baseActionRepair')}
                </span>
                {baseKind === 'repair' && (
                  <span className={`${styles.baseRunNote} ${styles.baseRunScope}`}>
                    {tt('baseActionRepairScope')}
                  </span>
                )}
              </div>
            )}
            {baseKind === 'repair' && lastRepair !== null && (
              <p className={styles.baseRunTrace}>{lastRepair}</p>
            )}
            {baseKind === 'convert' && languageChanged && (
              <p className={styles.regNote}>
                {tt('palaceChangeLeft', { seconds: left })}
                {locked ? ` · ${tt('palaceChangeNeedAllow')}` : ''}
              </p>
            )}
            {baseKind === 'convert' && chosenLanguage !== snapshot.language && (
              <p className={styles.regNote}>{tt('palacePending', { running: snapshot.language.toUpperCase() })}</p>
            )}
        {/* Таблицы — всегда: карточка показывает состояние, а не одну кнопку.
            Раньше они жили внутри «когда что-то сломалось» и в порядке дел
            исчезали совсем. */}
        <div className={styles.cardDivider} />
              <p className={styles.regNote}>{tt('registryModelsHint')}</p>
              <div className={styles.regTableWrap}>
              <table className={styles.regTable}>
                <thead>
                  <tr>
                    <th>{tt('registryColLanguage')}</th>
                    <th>{tt('registryColLabel')}</th>
                    <th>{tt('registryColId')}</th>
                    <th>{tt('registryColDims')}</th>
                    <th>{tt('registryColParams')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(snapshot.models ?? []).map(row => (
                    <tr key={row.id} className={row.id === snapshot.resolved?.id ? styles.on : undefined}>
                      <td className={styles.regMono}>{languagesOfModel(row.id)}</td>
                      <td>{row.label ?? tt('registryNone')}</td>
                      <td className={styles.regMono}>{row.id}</td>
                      <td>{row.dimensions ?? tt('registryNone')}</td>
                      <td>{row.pooling} · {row.dtype}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
              {snapshot.remote && <p className={styles.regNote}>{tt('registryRemote')}</p>}
              {snapshot.problems.length > 0 && (
                <ul className={styles.regBad}>
                  {snapshot.problems.map((problem, index) => (
                    <li key={`${problem.file}-${String(index)}`}>
                      {baseName(problem.file)}: {baseProblemText(problem)}
                    </li>
                  ))}
                </ul>
              )}
            {snapshot.bases.length === 0
              ? <p className={styles.regNote}>{tt('baseNoSchema')}</p>
              : (
                <>
                <p className={styles.regNote}>{tt('registryBasesHint')}</p>
                <div className={`${styles.regTableWrap} ${styles.regTableScroll}`}>
                <table className={styles.regTable}>
                  <thead>
                    <tr>
                      <th>{tt('baseColBase')}</th>
                      <th>{tt('baseColState')}</th>
                      <th>{tt('baseColRows')}</th>
                      <th>{tt('baseColMissing')}</th>
                      <th>{tt('baseColForeign')}</th>
                      <th>{tt('baseColDims')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(snapshot.bases ?? []).map((base, index) => (
                      <tr key={base.file ?? base.title ?? String(index)}>
                        <td className={styles.regMono} title={base.file}>{base.title ?? base.file}</td>
                        <td>{base.state === null ? tt('baseStateUnchecked') : tt(BASE_STATE_KEY[base.state] ?? 'baseStateUnchecked')}</td>
                        <td>{base.rows}</td>
                        <td>{base.missing}</td>
                        <td>{base.foreign}</td>
                        <td className={styles.regMono}>{base.dims.length === 0 ? tt('registryNone') : base.dims.join(' · ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
                </>
              )}
            {snapshot.bases.some(base => !base.checked) && (
              <ul className={styles.regBad}>
                {snapshot.bases.filter(base => !base.checked).map(base => (
                  <li key={base.file}>
                    {base.file}: {base.problems.map(problem => baseProblemText(problem)).join('; ')}
                  </li>
                ))}
              </ul>
            )}
            {snapshot.pendingBases > 0 && (
              <p className={styles.regNote}>{tt('basePending', { n: snapshot.pendingBases })}</p>
            )}
      </div>
  )
}

/**
 * Блок «Язык Плагина»: язык самой панели, её словари и заведение нового.
 */
function PluginLanguageCard({ t, snapshot, onReload, overlayHost, lang, onTestPanel, blockRefs, toast }: {
  readonly t: T
  /** Снимок обслуживания: реестр языков и список моделей. */
  readonly snapshot: RegistrySnapshot
  /** Перечитать снимок (после заведения словаря список языков меняется). */
  readonly onReload: () => void | Promise<void>
  /** Якорь оверлеев панели (вне `.panel`): сюда порталом уходит экран правки словаря. */
  readonly overlayHost: { readonly current: HTMLDivElement | null }
  /** Язык самой панели: он же умолчание для выбора языка в блоке «Язык Плагина». */
  readonly lang: PanelLang
  /** Открыть проверку окна первого запуска — без записи и без смены языка дворца. */
  readonly onTestPanel?: () => void
  /** Узел блока для верхней навигации по странице обслуживания. */
  readonly blockRefs?: { readonly current: Record<string, HTMLElement | null> }
  /** Общий контроллер тостов секции: вьюпорт один, в EngramSection, — приватный экземпляр здесь молчал бы. */
  readonly toast: ToastController
}): React.ReactElement {
  /** Открыт ли экран правки словаря: он перекрывает окно плагина целиком. */
  const [dictionaryOpen, setDictionaryOpen] = useState(false)
  /**
   * Язык, словари которого показывает блок «Язык Плагина».
   *
   * Умолчание — язык самой панели (тот, что стоит в верхнем переключателе): человек
   * чаще всего смотрит переводы того языка, на котором читает интерфейс. Дальше это
   * независимый выбор: он не переключает панель и ничего не пишет в настройки.
   */
  const [dictLanguage, setDictLanguage] = useState<string>(lang)
  /** Счётчики словарей выбранного языка; null — ещё не прочитаны. */
  const [dictStats, setDictStats] = useState<readonly DictStatView[] | null>(null)
  /** Просьба перечитать счётчики: после заведения словаря язык тот же, а данные новые. */
  const [dictReload, setDictReload] = useState(0)
  /** Язык, выбранный справа в поле «Создать словарь» (подпись, а не код: так ищут глазами). */
  const [createLanguage, setCreateLanguage] = useState<string>('')
  const [dictError, setDictError] = useState<string | null>(null)
  const tt = (key: EngramKey, params?: Record<string, string | number>): string => t(key, params)
  /**
   * Языки реестра. Список терпит отсутствие поля: клиент и сервер плагина едут разными
   * файлами, и сразу после обновления клиент может оказаться новее сервера.
   */
  const languages = snapshot.languages ?? []
  /**
   * Счётчики словарей выбранного языка: «всего строк / заполнено / откуда прочитано».
   *
   * Считаются по таблице правки (`GET dictionary?set=…&language=…`), а не по снимку
   * обслуживания: снимок описывает язык, на котором плагин считает сейчас, а человек
   * смотрит на язык, выбранный в блоке. Всего строк — это термины набора (строки
   * таблицы), заполнено — те, у которых правая клетка непустая.
   */
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [messages, panel] = await Promise.all([
          api<DictionarySetView>(`dictionary?set=messages&language=${encodeURIComponent(dictLanguage)}`),
          api<DictionarySetView>(`dictionary?set=panel&language=${encodeURIComponent(dictLanguage)}`),
        ])
        if (!alive) return
        setDictStats([
          { set: 'messages', label: 'registryDictionaryMessages', view: messages },
          { set: 'panel', label: 'registryDictionaryPanel', view: panel },
        ])
        setDictError(null)
      } catch (cause) {
        if (alive) setDictError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
    return () => { alive = false }
  }, [dictLanguage, dictReload])
  /**
   * Языки для выбора в блоке «Язык Плагина»: те, что знает реестр языков, плюс язык
   * панели, если его там ещё нет. Своего списка клиент не держит намеренно — иначе
   * язык, добавленный файлом, появлялся бы на сервере, но не в выборе.
   */
  const pluginLanguageOptions = languages.some(row => row.code === dictLanguage)
    ? languages
    : [...languages, { code: dictLanguage, label: dictLanguage.toUpperCase(), builtin: false }]

  /**
   * «Открыть словарь» — только для языков, которые приходят словарём из файла. У zh и
   * en текст вшит в код: правка файлом их не перекрывает, и кнопка открыла бы таблицу,
   * которая ничего не меняет.
   */
  const canOpenDictionary = languages.some(row => row.code === dictLanguage && !row.builtin)

  /** Есть ли непереведённые строки: «заполнено» меньше, чем «всего строк». */
  const dictIncomplete = dictStats?.some(stat => dictFilledOf(stat.view) < stat.view.rows.length)

  /**
   * Языки, для которых «Создать словарь» имеет смысл: их объявляют модели реестра,
   * у них нет вшитого набора (файлом его не перекрыть) и нет файла словаря — заведение
   * поверх стёрло бы правки в пользовательском слое.
   *
   * Список — из моделей, а не из реестра языков: язык, которого модель не знает,
   * считался бы ею вслепую, и словарь для него был бы пустой работой.
   */
  const createOptions = ((): readonly { readonly code: string, readonly label: string }[] => {
    const builtin = new Set(languages.filter(row => row.builtin).map(row => row.code))
    const known = new Set(snapshot.dictionaryLanguages ?? [])
    return [...new Set((snapshot.models ?? []).flatMap(row => row.languages ?? []))]
      .filter(code => !builtin.has(code) && !known.has(code))
      .map(code => ({ code, label: languageLabel(code, languages, lang) }))
      .sort((left, right) => left.label.localeCompare(right.label, lang))
  })()

  /** Язык из списка: подпись — то, что человек видит и набирает. */
  const createCode = createOptions.find(row => row.label === createLanguage)?.code

  /** Заводить словарь можно ровно тому языку, который предложен в списке. */
  const canCreateDictionary = createCode !== undefined

  /**
   * Завести словарь выбранного справа языка и сразу открыть его — то же, что «Открыть
   * словарь», только для только что созданного языка.
   *
   * Открытие — не любезность: файл заводится пустым (формат не хранит строку без
   * перевода), и единственное, что человек может с ним сделать, — заполнять строки в
   * таблице. Поэтому за созданием сразу идёт таблица этого языка, а блок «Язык Плагина»
   * переключается на него же: иначе открытая таблица и подписи блока говорили бы о
   * разных языках.
   */
  const createDictionary = (): void => {
    const code = createCode
    if (code === undefined) return
    void api<{ ok: boolean, written: readonly { set: string, file: string, lines: number, bytes: number }[] }>(
      'dictionary-create',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ language: code }) },
    )
      .then(async answer => {
        toast.push('success', tt('dictCreateDone', { files: answer.written.map(row => baseName(row.file)).join(', ') }))
        // Язык из списка уходит: словарь у него теперь есть. Поле очищаем, чтобы не
        // показывать выбор, которого больше нет, а снимок перечитываем — список языков
        // без словаря приходит с сервера, а не считается по памяти панели.
        setCreateLanguage('')
        setDictLanguage(code)
        setDictionaryOpen(true)
        await onReload()
        setDictReload(value => value + 1)
      })
      .catch((cause: Error) => { toast.push('error', tt('dictCreateFailed', { error: cause.message })) })
  }

  return (
    <>
      <div className={`${styles.panelCard} ${styles.opsBlock}`}
        ref={element => { if (blockRefs !== undefined) blockRefs.current.plugin = element }}>
        <div className={styles.cardHead}>
          <h3 className={styles.cardTitle}>{tt('pluginLanguageTitle')}</h3>
          {onTestPanel === undefined ? null : (
            <button type="button" className={styles.button}
              onClick={onTestPanel}>{tt('panelTestOpen')}</button>
          )}
        </div>
            {/* Две задачи — двумя группами, а не одним длинным рядом: «какой словарь сейчас»
                и «завести новый» — разные дела, и в узкой колонке они встают друг на друга. */}
            <div className={styles.opsFieldGrid}>
              <div className={styles.opsField}>
                <span className={styles.regLabel}>{tt('pluginLanguageCurrent')}</span>
                <div className={styles.opsFieldRow}>
                  <select className={`${styles.input} ${styles.regLang}`} value={dictLanguage}
                    aria-label={tt('pluginLanguageCurrent')}
                    onChange={event => { setDictLanguage(event.target.value) }}>
                    {pluginLanguageOptions.map(row => (
                      <option key={row.code} value={row.code}>{row.label}</option>
                    ))}
                  </select>
                  <button type="button" className={styles.button}
                    disabled={!canOpenDictionary}
                    onClick={() => { setDictionaryOpen(true) }}>{tt('dictOpenWord')}</button>
                </div>
              </div>
              {/* Заведение словаря — со своим списком языков, а не с `<datalist>`: родной список
                  рисует сам браузер поверх окна, у него нет своей прокрутки, и в невысоком окне
                  его нижние строки срезаются краем приложения. Свой список живёт в слое
                  поверх страницы, прокручивается и сам встаёт в свободную сторону.
                  В списке языки, которые знают модели, у которых ещё нет ни вшитого
                  набора, ни файла словаря. */}
              <div className={styles.opsField}>
                <span className={styles.regLabel}>{tt('dictCreateTitle')}</span>
                <div className={styles.opsFieldRow}>
                  <LanguagePicker value={createLanguage} options={createOptions}
                    placeholder={tt('registryColLanguage')} label={tt('dictCreateTitle')}
                    empty={tt('dictLangNoMatch')}
                    onChange={setCreateLanguage} />
                  <button type="button" className={styles.button}
                    disabled={!canCreateDictionary}
                    onClick={createDictionary}>{tt('dictCreateNew')}</button>
                </div>
              </div>
            </div>
            {createOptions.length === 0 && (
              <p className={styles.regNote}>{tt('dictCreateBlocked')}</p>
            )}
            <div className={styles.regGroup}>
              {dictError !== null && <p className={styles.regBad}>{dictError}</p>}
              {dictStats === null
                ? <p className={styles.regNote}>{tt('registryLoading')}</p>
                : dictStats.map(stat => {
                  const total = stat.view.rows.length
                  const filled = dictFilledOf(stat.view)
                  const files = stat.view.files.read.length === 0
                    ? tt('registryNone')
                    : stat.view.files.read.map(baseName).join(', ')
                  return (
                    <div key={stat.set} className={styles.opsDictRow}>
                      <span className={styles.opsDictDot} aria-hidden="true" />
                      <span className={styles.opsDictName}>{tt(stat.label)}</span>
                      <span className={styles.opsDictFiles} title={files}>{files}</span>
                      <span className={styles.opsDictCount}>
                        <b className={filled < total ? styles.regFilledShort : undefined}>{String(filled)}</b>
                        {` / ${String(total)}`}
                      </span>
                      <span className={stat.view.problems.length === 0 ? styles.opsDictFiles : styles.opsDictBad}>
                        {stat.view.problems.length === 0 ? tt('registryNoProblems') : String(stat.view.problems.length)}
                      </span>
                    </div>
                  )
                })}
              {dictIncomplete && <p className={styles.regIncomplete}>{tt('dictIncomplete')}</p>}
            </div>
        </div>
      {dictionaryOpen && (
        <DictionaryEditor tt={tt} host={overlayHost} toast={toast} language={dictLanguage}
          onClose={() => { setDictionaryOpen(false) }} />
      )}
    </>
  )
}

/**
 * Вкладка «Обслуживание»: четыре инструмента на двух колонках — как на главной.
 *
 * Слева (широкая колонка) то, чему нужна ширина: язык дворца с таблицами моделей и баз
 * и догрузка истории. Справа (узкая, липкая) то, что помещается: словари панели и裁决.
 * Снимок обслуживания один на обе карточки — читать его дважды незачем.
 */
function OpsTab({ t, overlayHost, lang, toast, onTestPanel }: {
  readonly t: T
  readonly overlayHost: { readonly current: HTMLDivElement | null }
  readonly lang: PanelLang
  readonly toast: ToastController
  readonly onTestPanel: () => void
}): React.ReactElement {
  // 范式载体（审计批次 3）：注册表快照的获取/失败/重载走公共 useApi，
  // 其余卡片迁移时照此收敛——busy 形态的卡片保留自有状态。
  const { data: snapshot, failed: error, reload } = useApi<RegistrySnapshot>('registry')
  /** Узлы блоков: верхняя навигация прокручивает к ним. */
  const blocks = useRef<Record<string, HTMLElement | null>>({})

  const tt = (key: EngramKey, params?: Record<string, string | number>): string => t(key, params)
  if (error !== null) {
    return <div className={styles.empty}><b>{tt('registryFailed')}</b><span>{error}</span></div>
  }
  if (snapshot === null) return <div className={styles.expandLoading}>{tt('registryLoading')}</div>

  return (
    <>
      <PageHeader title={tt('tabOps')} subtitle={tt('pageHeaderOpsSubtitle')} />
      {/* Навигация по блокам: страница длинная, а добраться до нужного инструмента
          по滚轮у — лотерея. */}
      <nav className={styles.opsNav} aria-label={tt('tabOps')}>
        {([
          ['palace', tt('palaceLanguageTitle')],
          ['plugin', tt('pluginLanguageTitle')],
          ['backfill', tt('tabBackfill')],
          ['jev', tt('tabJev')],
        ] as const).map(([key, label]) => (
          <button key={key} type="button" className={styles.chip}
            onClick={() => {
              const target = blocks.current[key]
              if (target === null || target === undefined) return
              target.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }}>
            {label}
          </button>
        ))}
      </nav>
      <div className={styles.layout}>
        <div className={styles.mainCol}>
          <PalaceLanguageCard t={t} snapshot={snapshot} onReload={reload} blockRefs={blocks} toast={toast} />
          <div className={`${styles.panelCard} ${styles.opsBlock}`} ref={element => { blocks.current.backfill = element }}>
            <div className={styles.cardHead}>
              <h3 className={styles.cardTitle}>{tt('tabBackfill')}</h3>
              <span className={styles.sectionHint}>{tt('pageHeaderBackfillSubtitle')}</span>
            </div>
            <HistoryBackfillCard t={t} toast={toast} />
          </div>
        </div>
        <div className={styles.sideCol}>
          <PluginLanguageCard t={t} snapshot={snapshot} onReload={reload} overlayHost={overlayHost}
            lang={lang} onTestPanel={onTestPanel} blockRefs={blocks} toast={toast} />
          <div className={`${styles.panelCard} ${styles.opsBlock}`} ref={element => { blocks.current.jev = element }}>
            <div className={styles.cardHead}>
              <h3 className={styles.cardTitle}>{tt('tabJev')}</h3>
              <span className={styles.sectionHint}>{tt('pageHeaderJevSubtitle')}</span>
            </div>
            <JevConfigCard t={t} toast={toast} />
            <div className={styles.cardDivider} />
            <JevObservationsCard t={t} toast={toast} />
          </div>
        </div>
      </div>
    </>
  )
}

/** Наборы словаря: имена те же, что на сервере (см. src/i18n/dictionary-terms.ts). */
type DictionarySetName = 'panel' | 'messages'

/** Где на экране встал открытый список языка: считаем от поля, а не от разметки. */
interface PickerBox {
  readonly left: number
  readonly width: number
  readonly maxHeight: number
  /** Сверху от поля или снизу: прижат к своей стороне, чтобы расти от поля. */
  readonly below: boolean
  readonly top: number
  readonly bottom: number
}

/**
 * Поле выбора языка со своим списком.
 *
 * Родной `<datalist>` здесь не годится по двум причинам, обе видны на невысоком окне:
 * список рисует сам браузер отдельным окном поверх приложения — у него нет своей
 * прокрутки, и его обрезает край окна DSH. Свой список рисуется в слое поверх страницы
 * (`position: fixed` + портал в `body`): он не подчиняется прокрутке панели, сам
 * ограничивает высоту по свободному месту и встаёт над полем, если снизу места нет.
 *
 * Поиск — тот же, что был у `datalist`: набранный текст отсеивает строки по подписи и
 * по коду языка, а пустое поле показывает весь список.
 */
function LanguagePicker({ value, options, placeholder, label, empty, onChange }: {
  readonly value: string
  readonly options: readonly { readonly code: string, readonly label: string }[]
  readonly placeholder: string
  readonly label: string
  /** Что сказать, когда под набранный текст ничего не подошло. */
  readonly empty: string
  readonly onChange: (text: string) => void
}): React.ReactElement {
  const fieldRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  /** Строка, на которой стоит клавиатура: −1 — ни на какой. */
  const [active, setActive] = useState(-1)
  const [box, setBox] = useState<PickerBox | null>(null)

  const shown = useMemo(() => {
    const query = value.trim().toLowerCase()
    if (query === '') return options
    return options.filter(row => row.label.toLowerCase().includes(query) || row.code.toLowerCase().includes(query))
  }, [options, value])

  /**
   * Поставить список у поля.
   *
   * Высота — по свободному месту: снизу его больше — список идёт вниз, меньше — вверх.
   * Совсем тесное окно всё равно оставляет список прокручиваемым (96px), иначе выбор
   * языка пропадал бы именно там, где он нужнее всего. Ширина — не уже поля, но и не
   * за краем окна: у правого края список сдвигается влево, а не вылезает наружу.
   */
  const place = useCallback((): void => {
    const field = fieldRef.current
    if (field === null) return
    const rect = field.getBoundingClientRect()
    const viewportW = window.innerWidth
    const viewportH = window.innerHeight
    const gap = 6
    const free = viewportH - rect.bottom - gap - 8
    const freeAbove = rect.top - gap - 8
    const below = free >= freeAbove || freeAbove < 160
    const room = Math.max(96, Math.min(320, below ? free : freeAbove))
    const width = Math.max(rect.width, 200)
    const left = Math.max(8, Math.min(rect.left, viewportW - width - 8))
    setBox({
      left,
      width,
      maxHeight: room,
      below,
      top: rect.bottom + gap,
      bottom: viewportH - rect.top + gap,
    })
  }, [])

  // Открытый список следит за полем: прокрутка панели и смена размера окна двигают его,
  // и список обязан ехать вместе с полем, а не висеть на прежнем месте.
  useEffect(() => {
    if (!open) return undefined
    place()
    const onMove = (): void => { place() }
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, true)
    return () => {
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove, true)
    }
  }, [open, place])

  // Щелчок мимо поля и мимо списка закрывает список: так же ведёт себя любой выбор.
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (fieldRef.current?.contains(target) === true) return
      if (listRef.current?.contains(target) === true) return
      setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => { window.removeEventListener('mousedown', onDown) }
  }, [open])

  // Новая порция строк — клавиатура встаёт на первую: иначе она указывала бы в пустоту.
  useEffect(() => { setActive(shown.length === 0 ? -1 : 0) }, [shown])

  // Выбранная строка должна быть видна: список прокручивается под клавиатуру.
  useEffect(() => {
    if (!open || active < 0) return
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index='${String(active)}']`)
    node?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  const pick = (code: string): void => {
    const row = shown.find(item => item.code === code)
    if (row === undefined) return
    onChange(row.label)
    setOpen(false)
    fieldRef.current?.focus()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      const step = event.key === 'ArrowDown' ? 1 : -1
      const next = Math.min(Math.max(active + step, 0), shown.length - 1)
      setActive(next)
      return
    }
    if (event.key === 'Enter') {
      if (!open || active < 0) return
      const row = shown[active]
      if (row === undefined) return
      event.preventDefault()
      pick(row.code)
      return
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      setOpen(false)
    }
  }

  const list = open && box !== null
    ? createPortal(
      <div ref={listRef} className={styles.dictLangList} role="listbox" aria-label={label}
        style={{
          left: box.left,
          width: box.width,
          maxHeight: box.maxHeight,
          ...(box.below ? { top: box.top } : { bottom: box.bottom }),
        }}>
        {shown.length === 0
          ? <p className={styles.dictLangEmpty}>{empty}</p>
          : shown.map((row, index) => (
            <button key={row.code} type="button" role="option" aria-selected={index === active}
              data-index={index} data-active={index === active}
              className={styles.dictLangOption}
              onMouseEnter={() => { setActive(index) }}
              onClick={() => { pick(row.code) }}>
              <span>{row.label}</span>
              <span className={styles.dictLangOptionCode}>{row.code}</span>
            </button>
          ))}
      </div>,
      document.body,
    )
    : null

  return (
    <span className={styles.dictLangField}>
      <input ref={fieldRef} type="text" className={`${styles.input} ${styles.dictLangInput}`}
        value={value} placeholder={placeholder} aria-label={label}
        role="combobox" aria-expanded={open}
        onChange={event => { onChange(event.target.value); setOpen(true) }}
        onFocus={() => { setOpen(true) }}
        onKeyDown={onKeyDown} />
      {list}
    </span>
  )
}

/** Строка таблицы правки (ответ GET /api/engram/dictionary). */
interface DictionaryRowView {
  /** Английская строка — она же ключ словаря, поэтому её не правят. */
  readonly left: string
  /** Что стоит справа сейчас; пусто — перевода нет. */
  readonly right: string
  /** Откуда взят правый столбец: правка, поставка, вшитый набор или ничего. */
  readonly source: 'user' | 'delivery' | 'builtin' | 'none'
  /** Значение пользовательского слоя; null — строки в файле нет, '' — строка есть без перевода. */
  readonly override: string | null
  /** Есть ли такая левая часть в наборе текстов программы: false — строка файла без ключа. */
  readonly known: boolean
}

/**
 * Сверка программы с файлом (считает сервер при каждом открытии словаря).
 *
 * `program` и `file` — две независимые величины: ключи в коде и строки в файле.
 * Совпадение чисел ничего не доказывает, поэтому рядом стоят находки — ключ без
 * перевода и строка без ключа.
 */
interface DictionaryStatsView {
  readonly program: number
  readonly file: number
  readonly missing: number
  readonly unkeyed: number
}

/** Набор словаря, каким его видит таблица: термины, слои файлов, претензии разбора и сверка. */
interface DictionarySetView {
  readonly set: DictionarySetName
  readonly language: string
  readonly rows: readonly DictionaryRowView[]
  readonly files: { readonly delivery: string, readonly user: string, readonly read: readonly string[] }
  readonly problems: readonly { readonly file: string, readonly line: number, readonly kind: string, readonly detail: string }[]
  /**
   * Сверка. Может не прийти: серверная половина старше клиентской (после обновления
   * плагина до перезапуска DSH). Тогда строка сверки не рисуется — панель не должна
   * падать из-за того, что сервер ещё не знает про неё.
   */
  readonly stats?: DictionaryStatsView
}

/**
 * Счётчик одного набора в блоке «Язык Плагина»: набор, ключ его названия и то, что
 * прочитано с диска. Отдельный вид, потому что название берётся из словаря панели, а
 * не приходит с сервера: сервер знает имена наборов, а не их подписи.
 */
interface DictStatView {
  readonly set: DictionarySetName
  readonly label: 'registryDictionaryMessages' | 'registryDictionaryPanel'
  readonly view: DictionarySetView
}

/**
 * Сколько строк набора заполнено: правая клетка непустая.
 *
 * Пустая клетка — не «пустой перевод», а «правки нет»: тогда показывается текст
 * поставки или вшитый набор. Поэтому «заполнено» — это ровно те строки, у которых
 * перевод есть, и сравнивать их надо с числом терминов набора.
 */
function dictFilledOf(view: DictionarySetView): number {
  return view.rows.filter(row => row.right !== '').length
}

/**
 * Ответ POST dictionary: куда легли правки и как набор выглядит после записи.
 * Представление приходит тем же ответом — таблица обязана показывать записанное.
 */
interface DictionarySaveResultView {
  readonly set: DictionarySetName
  readonly file: string
  readonly written: number
  readonly bytes: number
  readonly view: DictionarySetView
}

/** Ответ POST dictionary-fill: переводы партии и маршрут, который отвечал. */
interface DictionaryFillAnswer {
  readonly set: DictionarySetName
  readonly provider: string
  readonly model: string
  readonly translations: readonly (readonly [string, string])[]
}

/**
 * Строка таблицы правки: английский термин слева, клетка перевода справа.
 *
 * memo — не украшение: терминов больше четырёхсот, и без него правка одной клетки
 * перерисовывала бы весь список. Сравниваются только значение и признак правки.
 */
const DictionaryRow = memo(function DictionaryRow({ left, value, edited, hint, placeholder, onEdit }: {
  readonly left: string
  readonly value: string
  readonly edited: boolean
  readonly hint: string
  readonly placeholder: string
  readonly onEdit: (left: string, next: string) => void
}): React.ReactElement {
  return (
    <label className={`${styles.dictRow} ${edited ? styles.dictRowEdited : ''}`} title={hint}>
      <span className={styles.dictLeft}>{left}</span>
      <input className={styles.dictInput} value={value} placeholder={placeholder} spellCheck={false}
        onChange={event => { onEdit(left, event.target.value) }} />
    </label>
  )
})

/**
 * Экран правки словаря: перекрывает окно плагина целиком (см. .overlayHost/.dictScreen в CSS).
 *
 * Слева — английская строка ровно как она стоит в коде: это ключ словаря, поэтому
 * её показывают, а не правят. Справа — перевод, который видит выбранный язык;
 * клетки правятся здесь же, а уходят в пользовательский слой файла только по «Сохранить».
 *
 * Заполнение ИИ пишет в тот же черновик, что и человек, и партиями: файл меняет только
 * «Сохранить», поэтому работа модели ничего не портит молча и её можно отменить. Партии
 * (а не один запрос на весь словарь) — потому что партия это единица прогресса и то,
 * что можно прервать; повторное нажатие на кнопку останавливает заполнение.
 */
function DictionaryEditor({ tt, host, toast, onClose, language }: {
  readonly tt: (key: EngramKey, params?: Record<string, string | number>) => string
  /** Якорь оверлея (начало `.panelRoot`): экран уходит туда порталом. Сам он fixed, но якорь
   *  обязан лежать вне `.panel` — иначе собственный контекст наложения панели не даст
   *  перекрыть окно целиком. */
  readonly host: { readonly current: HTMLDivElement | null }
  readonly toast: ToastController
  readonly onClose: () => void
  /**
   * Язык набора: тот, что выбран в блоке «Язык Плагина». Без него таблица показывала бы
   * словарь текущего языка плагина, и человек правил бы не тот файл, который открыл.
   */
  readonly language: string
}): React.ReactElement {
  const [set, setSet] = useState<DictionarySetName>('panel')
  const [view, setView] = useState<DictionarySetView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  /**
   * Что показать из сверки: все строки, ключи без перевода или строки без ключа.
   *
   * Группа — это фильтр таблицы, а не отдельный экран: человек видит находку и тут же
   * правит клетку, не теряя из виду остальной словарь.
   */
  const [group, setGroup] = useState<'all' | 'missing' | 'unkeyed'>('all')
  /** Черновик правок: английская строка → значение клетки ('' — снять правку). */
  const [draft, setDraft] = useState<ReadonlyMap<string, string>>(new Map())
  /** Что сейчас занято: сохранение и заполнение не ходят одновременно. */
  const [busy, setBusy] = useState<'save' | 'fill' | null>(null)
  /** Прогресс заполнения (null — не заполняем): отправлено партий / терминов всего. */
  const [fill, setFill] = useState<{ readonly done: number, readonly total: number } | null>(null)
  /** Просьба остановить заполнение: проверяется перед каждой партией. */
  const stopFill = useRef(false)
  /**
   * Рамка, которую кроет экран: видимая область панели, а не весь клиент.
   *
   * Полноэкранный слой (`inset: 0`) заезжал на верхнюю полосу приложения — над панелью
   * у неё своё меню, и заголовок «Словарь» печатался прямо поверх него. Якорь оверлея
   * лежит началом `.panelRoot`, а тот сам является скроллером: его рамка не меняется
   * при прокрутке и всегда равна тому, что видно от панели. Отсюда и берём прямоугольник.
   */
  const [frame, setFrame] = useState<{ readonly top: number, readonly left: number, readonly width: number, readonly height: number } | null>(null)
  useLayoutEffect(() => {
    const anchor = host.current?.parentElement ?? null
    if (anchor === null) return undefined
    const measure = (): void => {
      const box = anchor.getBoundingClientRect()
      setFrame({ top: box.top, left: box.left, width: box.width, height: box.height })
    }
    // useLayoutEffect — до первой отрисовки: слой не успевает мигнуть на весь клиент.
    measure()
    window.addEventListener('resize', measure)
    const observer = new ResizeObserver(measure)
    observer.observe(anchor)
    return () => {
      window.removeEventListener('resize', measure)
      observer.disconnect()
    }
  }, [host])

  // Набор перечитывается на каждое переключение: «панель» и «сообщения» — разные
  // файлы, и общий кэш здесь только запутал бы, чей перевод на экране. Заодно
  // останавливается заполнение: партии другого набора в этот черновик не годятся.
  useEffect(() => {
    let alive = true
    stopFill.current = true
    setFill(null)
    setBusy(null)
    setView(null)
    setError(null)
    setDraft(new Map())
    setGroup('all')
    void (async () => {
      try {
        const data = await api<DictionarySetView>(`dictionary?set=${set}&language=${encodeURIComponent(language)}`)
        if (alive) setView(data)
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
    return () => { alive = false }
  }, [set, language])

  /** Что стоит в клетке: несохранённая правка, иначе значение слоя. */
  const cell = useCallback((row: DictionaryRowView): string => draft.get(row.left) ?? row.right, [draft])

  const edit = useCallback((left: string, next: string) => {
    setDraft(current => new Map(current).set(left, next))
  }, [])

  const rows = useMemo(() => {
    if (view === null) return []
    // Сначала группа сверки, потом поиск: группа — это «что чинить», поиск — «где это».
    const inGroup = view.rows.filter(row => {
      if (group === 'missing') return cell(row).trim() === ''
      // Именно `=== false`: у сервера старше клиента признака нет вовсе, и
      // «ключа нет» из отсутствия поля не следует.
      if (group === 'unkeyed') return row.known === false
      return true
    })
    const needle = query.trim().toLowerCase()
    if (needle === '') return inGroup
    // Ищем и по термину, и по переводу: чаще всего ищут «где эта надпись».
    return inGroup.filter(row => row.left.toLowerCase().includes(needle) || cell(row).toLowerCase().includes(needle))
  }, [view, query, cell, group])

  /**
   * Партия правок — то, что уйдёт в файл: только клетки, отличающиеся от слоя.
   * Пустое значение остаётся значимым («снять правку»), поэтому отбрасывается не пустое,
   * а совпадающее с тем, что уже лежит в словаре.
   */
  const patch = useMemo(() => {
    if (view === null) return [] as readonly (readonly [string, string])[]
    const changed: (readonly [string, string])[] = []
    for (const row of view.rows) {
      const value = draft.get(row.left)
      if (value === undefined || value === row.right) continue
      changed.push([row.left, value])
    }
    return changed
  }, [view, draft])
  const dirty = patch.length

  /** Клетки без перевода: только их и отдаём модели — заполнение не перекрывает готовое. */
  const fillable = useMemo(() => {
    if (view === null) return [] as readonly string[]
    // Строки из одних подстановок и знаков не спрашиваем: переводить в них нечего, а
    // каждый проход тратил на них партию и оставлял те же пустые клетки (см. needsTranslation).
    return view.rows.filter(row => cell(row).trim() === '' && needsTranslation(row.left)).map(row => row.left)
  }, [view, cell])

  const save = (): void => {
    if (view === null || dirty === 0 || busy !== null) return
    setBusy('save')
    void (async () => {
      // Правок бывает больше, чем пролезает в одно тело запроса (набор сообщений при
      // заполнении нового языка): режем по размеру, а не по числу строк. Каждая пачка —
      // законченная запись (правки накладываются на слой), поэтому обрыв на середине
      // оставляет уже записанное записанным, а не откатывает всё.
      const chunks = splitDictionaryPatch(patch)
      const sent: string[] = []
      let last: DictionarySaveResultView | null = null
      try {
        for (const chunk of chunks) {
          const answer = await api<DictionarySaveResultView>('dictionary', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ set, language, entries: chunk }),
          })
          last = answer
          for (const row of chunk) sent.push(row[0])
        }
      } catch (cause) {
        const text = cause instanceof Error ? cause.message : String(cause)
        // Что успело записаться, то записалось: об этом говорят отдельно, чтобы «не вышло»
        // не читалось как «ничего не изменилось».
        if (sent.length > 0) toast.push('success', tt('dictSaved', { n: sent.length, file: last?.file ?? '' }))
        toast.push('error', tt('dictSaveFailed', { error: text }))
        return
      } finally {
        // Таблица продолжает показывать записанное: представление берём из ответа последней
        // пачки, а не перечитываем — иначе «сохранил» и «вижу» расходятся на один запрос.
        if (last !== null) setView(last.view)
        // Записанные клетки возвращаются к слою: иначе снятая правка (пустая клетка)
        // навсегда осталась бы «изменённой» и кнопка сохранения не гасла бы.
        setDraft(current => {
          const next = new Map(current)
          for (const left of sent) next.delete(left)
          return next
        })
        setBusy(null)
      }
      toast.push('success', tt('dictSaved', { n: sent.length, file: last?.file ?? '' }))
    })()
  }

  const cancel = (): void => {
    if (dirty === 0 || busy !== null) return
    setDraft(new Map())
    toast.push('info', tt('dictReverted'))
  }

  /** Уход с экрана: несохранённое теряется, поэтому об этом говорят, а не молчат. */
  const back = (): void => {
    if (dirty > 0) toast.push('info', tt('dictReverted'))
    onClose()
  }

  const fillAi = (): void => {
    if (view === null) return
    // Второе нажатие — остановка: у долгого заполнения должна быть кнопка «хватит».
    if (fill !== null) { stopFill.current = true; return }
    if (busy !== null || fillable.length === 0) return
    const terms = fillable
    const base = new Map(view.rows.map(row => [row.left, row.right]))
    stopFill.current = false
    setBusy('fill')
    setFill({ done: 0, total: terms.length })
    void (async () => {
      let filled = 0
      let sent = 0
      let failure: string | null = null
      // Партии режет общий с сервером предел — по числу терминов и по длине строк: вывод
      // модели растёт вместе со входом, и одна большая партия упиралась в предел вывода,
      // теряя ответ целиком (сорок длинных подсказок набора «сообщения»).
      for (const batch of splitFillBatch(terms)) {
        if (stopFill.current) break
        try {
          const answer = await api<DictionaryFillAnswer>('dictionary-fill', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ set, terms: batch }),
          })
          // Набор переключили, пока партия ехала: её переводы уже чужого словаря.
          if (stopFill.current) break
          setDraft(current => {
            const next = new Map(current)
            for (const [left, right] of answer.translations) {
              // Пишем только в пустую клетку: ни работа человека, ни прошлая партия
              // не перекрываются — иначе повторный проход затирал бы уже принятое.
              if ((next.get(left) ?? base.get(left) ?? '').trim() !== '') continue
              next.set(left, right)
            }
            return next
          })
          filled += answer.translations.length
        } catch (cause) {
          failure = cause instanceof Error ? cause.message : String(cause)
          break
        }
        sent += batch.length
        setFill({ done: sent, total: terms.length })
      }
      stopFill.current = true
      setFill(null)
      setBusy(null)
      if (filled > 0) toast.push('success', tt('dictFillDone', { n: filled }))
      if (failure !== null) toast.push('error', tt('dictFillFailed', { error: failure }))
    })()
  }

  /**
   * Подпись строки (в подсказке, не в колонке): сначала «такого ключа в программе нет» —
   * это важнее источника текста, потому что такую строку человек не ищет, а находит.
   */
  const hintOf = (row: DictionaryRowView): string => row.known === false
    ? tt('dictRowUnkeyed')
    : row.source === 'user' ? tt('dictEdited')
      : row.source === 'delivery' ? tt('dictShipped') : row.source === 'builtin' ? tt('dictBuiltin') : tt('dictNoTranslation')

  /** Сверка либо ничего: сервер старше клиента её не считает (см. `DictionarySetView.stats`). */
  const stats = view?.stats

  // Экран уходит порталом в якорь оверлеев (.overlayHost) вне .panel: сам он fixed, поэтому
  // место якоря не важно, важна лишь чужая область наложения. Якорь ещё не смонтирован —
  // рисуем на месте, без портала: нажатие никогда не должно оставаться без ответа.
  const screen = (
    <div className={styles.dictScreen}
      style={frame === null ? undefined : {
        top: frame.top, left: frame.left, width: frame.width, height: frame.height, right: 'auto', bottom: 'auto',
      }}>
      <div className={styles.dictMenu}>
        <button type="button" className={styles.dictBack} onClick={back}
          title={tt('dictBack')} aria-label={tt('dictBack')}>{'←'}</button>
        <span className={styles.dictTitle}>{tt('dictTitle')}</span>
        <div className={styles.dictMenuRight}>
          <button type="button" className={styles.button}
            disabled={view === null || busy === 'save' || (fill === null && fillable.length === 0)}
            title={fill !== null ? tt('dictFillStop') : fillable.length === 0 ? tt('dictFillHint') : tt('dictFillAiHint')}
            onClick={fillAi}>
            {fill !== null ? tt('dictFillStop') : tt('dictFillAi')}
          </button>
          <button type="button" className={styles.button} disabled={busy !== null || dirty === 0}
            title={dirty === 0 ? tt('dictCancelHint') : undefined} onClick={cancel}>
            {tt('dictCancel')}
          </button>
          <button type="button" className={styles.button} disabled={busy !== null || dirty === 0}
            title={dirty === 0 ? tt('dictSaveHint') : undefined} onClick={save}>
            {busy === 'save' ? tt('dictSaveBusy') : tt('dictSave')}
          </button>
        </div>
      </div>
      <div className={styles.dictBar}>
        {(['panel', 'messages'] as const).map(name => (
          <button key={name} type="button" className={name === set ? styles.dictSetOn : styles.dictSet}
            onClick={() => { setSet(name) }}>
            {name === 'panel' ? tt('dictSetPanel') : tt('dictSetMessages')}
          </button>
        ))}
        <input className={styles.dictFilter} value={query} placeholder={tt('dictFilter')} spellCheck={false}
          onChange={event => { setQuery(event.target.value) }} />
        <span className={styles.dictStatus}>
          {view === null ? tt('dictLoading') : tt('dictRows', { n: view.rows.length })}
          {dirty > 0 && <> · {tt('dictDirty', { n: dirty })}</>}
          {fill !== null && <> · {tt('dictFillRunning', { done: fill.done, total: fill.total })}</>}
          {view !== null && <> · {tt('dictTarget')} <span className={styles.regMono}>{view.files.user}</span></>}
        </span>
      </div>
      {/* Сверка программы с файлом: числа независимы и стоят рядом намеренно —
          совпадение ключей в коде и строк в файле ничего не доказывает, а находки
          (ключ без перевода, строка без ключа) и есть то, ради чего словарь открывают.
          Нажатие на находку — фильтр таблицы, а не отдельный экран. */}
      {stats !== undefined && (
        <div className={styles.dictCheck}>
          <span>{tt('dictCheckProgram', { n: stats.program })}</span>
          <span>{tt('dictCheckFile', { n: stats.file })}</span>
          <button type="button" className={group === 'missing' ? styles.dictChipOn : styles.dictChip}
            disabled={stats.missing === 0 && group !== 'missing'}
            title={tt('dictCheckMissingHint')}
            onClick={() => { setGroup(group === 'missing' ? 'all' : 'missing') }}>
            {tt('dictCheckMissing', { n: stats.missing })}
          </button>
          <button type="button" className={group === 'unkeyed' ? styles.dictChipOn : styles.dictChip}
            disabled={stats.unkeyed === 0 && group !== 'unkeyed'}
            title={tt('dictCheckUnkeyedHint')}
            onClick={() => { setGroup(group === 'unkeyed' ? 'all' : 'unkeyed') }}>
            {tt('dictCheckUnkeyed', { n: stats.unkeyed })}
          </button>
          {group !== 'all' && (
            <button type="button" className={styles.dictChip} onClick={() => { setGroup('all') }}>
              {tt('dictCheckAll')}
            </button>
          )}
        </div>
      )}
      <div className={styles.dictBody}>
        <p className={styles.regNote}>{tt('dictHint', { file: view?.files.user ?? '' })}</p>
        {error !== null
          ? <p className={styles.regBad}>{tt('dictFailed', { error })}</p>
          : view === null
            ? <p className={styles.regNote}>{tt('dictLoading')}</p>
            : rows.length === 0
              ? <p className={styles.regNote}>{tt('dictNoRows')}</p>
              : rows.map(row => (
                <DictionaryRow key={row.left} left={row.left} value={cell(row)} hint={hintOf(row)}
                  placeholder={row.source === 'none' ? tt('dictNoTranslation') : ''}
                  edited={draft.get(row.left) !== undefined && draft.get(row.left) !== row.right}
                  onEdit={edit} />
              ))}
      </div>
    </div>
  )

  const hostNode = host.current
  return hostNode === null ? screen : createPortal(screen, hostNode)
}

/** 导入按钮：与导出同款的独立下拉（置于导出前），两项显式格式入口。
 *  JSON 走 engram_export format=json 的无损回路；Markdown 走服务端回解析（有损，补缺省字段）。
 *  两段式：选文件 → 预览抽屉逐条勾选 → 确认导入（#33：迁移/合并都要先看清再写入）。 */
function ImportButton({ t, scope, toast, onImported }: {
  t: T
  scope: 'user' | 'project' | 'shared'
  toast: ToastController
  /** 导入提交成功后的回调（父组件刷新统计与列表）。 */
  onImported: () => void
}): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [pendingFormat, setPendingFormat] = useState<'json' | 'markdown'>('json')
  const [preview, setPreview] = useState<ImportPreviewView | null>(null)
  // dryRun 响应只带分类，不带原始记录；正式提交要原样回传完整 data，故把解析结果存到 state。
  const [previewSource, setPreviewSource] = useState<unknown>(null)
  const [previewFormat, setPreviewFormat] = useState<'json' | 'markdown'>('json')
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [keepDuplicates, setKeepDuplicates] = useState(false)
  const [busy, setBusy] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (!open) return
    const handler = (event: MouseEvent): void => {
      if (wrapRef.current === null || !wrapRef.current.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', handler)
    return () => { window.removeEventListener('mousedown', handler) }
  }, [open])
  const classLabels: Record<ImportEntryView['classification'], string> = {
    new: t('importClass_new'),
    duplicate: t('importClass_duplicate'),
    conflict: t('importClass_conflict'),
  }
  const pick = (format: 'json' | 'markdown'): void => {
    setOpen(false)
    setPendingFormat(format)
    fileRef.current?.click()
  }
  const handleFile = async (file: File): Promise<void> => {
    // 格式以扩展名为准（菜单项的 accept 只是过滤器）：.md/.markdown 走服务端解析，其余按 JSON。
    const markdown = /\.(?:md|markdown)$/i.test(file.name)
    let data: unknown
    if (markdown) {
      data = await file.text()
    } else {
      try {
        data = JSON.parse(await file.text())
      } catch (error) {
        toast.push('error', t('importReadFailed', { error: error instanceof Error ? error.message : String(error) }))
        return
      }
    }
    const format = markdown ? 'markdown' : 'json'
    const body = JSON.stringify({ data, format, scope, dryRun: true })
    // 前置体量检查：超上限的 payload 别先传一遍再被服务端拒——当场说清上限。
    // 量的是真正要发出去的那串字节；与服务端同一把尺子（src/body-limits.ts），
    // 只差 api() 可能追加的 project 字段那几十字节（真超了服务端会回 413，消息也清楚）。
    if (new TextEncoder().encode(body).byteLength > IMPORT_BODY_LIMIT_BYTES) {
      toast.push('error', t('importTooLarge', { limit: formatBytes(IMPORT_BODY_LIMIT_BYTES) }))
      return
    }
    try {
      const response = await api<{ preview: ImportPreviewView }>('import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
      setPreview(response.preview)
      setPreviewSource(data)
      setPreviewFormat(format)
      setSelected(new Set(response.preview.entries.filter(entry => entry.classification === 'new').map(entry => entry.id)))
      setKeepDuplicates(false)
    } catch (error) {
      toast.push('error', t('importInvalidPayload', { error: error instanceof Error ? error.message : String(error) }))
    }
  }
  const commit = async (): Promise<void> => {
    if (preview === null || busy) return
    setBusy(true)
    const body = JSON.stringify({ data: previewSource, format: previewFormat, scope, selectedIds: [...selected], keepDuplicates })
    // 同一把尺子：提交体比预览体略大（多了 selectedIds），也要先过上限再发。
    if (new TextEncoder().encode(body).byteLength > IMPORT_BODY_LIMIT_BYTES) {
      setBusy(false)
      toast.push('error', t('importTooLarge', { limit: formatBytes(IMPORT_BODY_LIMIT_BYTES) }))
      return
    }
    try {
      const result = await api<ImportResultView>('import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
      setPreview(null)
      toast.push(result.imported === 0 ? 'info' : 'success', t('importDone', {
        imported: result.imported,
        embedded: result.embedded,
        edges: result.edgesLinked,
        dangling: result.edgesDangling,
      }))
      if (result.imported > 0) onImported()
    } catch (error) {
      toast.push('error', error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={styles.exportWrap} ref={wrapRef}>
      <button type="button" className={styles.button} aria-haspopup="menu" aria-expanded={open}
        title={t('import')} aria-label={t('import')}
        onClick={() => { setOpen(value => !value) }}>
        <Icon name="import" className={styles.brandIcon} />
        <span className={styles.exportCaret} aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className={styles.exportMenu} role="menu">
          <button type="button" role="menuitem" className={styles.exportItem} onClick={() => { pick('json') }}>
            <span className={styles.exportItemLabel}>{t('importJson')}</span>
            <span className={styles.exportItemHint}>{t('importJsonHint')}</span>
          </button>
          <button type="button" role="menuitem" className={styles.exportItem} onClick={() => { pick('markdown') }}>
            <span className={styles.exportItemLabel}>{t('importMd')}</span>
            <span className={styles.exportItemHint}>{t('importMdHint')}</span>
          </button>
        </div>
      )}
      <input ref={fileRef} type="file"
        accept={pendingFormat === 'markdown' ? '.md,.markdown,text/markdown' : '.json,application/json'}
        style={{ display: 'none' }}
        aria-label={t('importFilePick')}
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file !== undefined) void handleFile(file)
        }} />
      {preview !== null && (
        <div className={styles.importLayer} role="dialog" aria-label={t('importTitle')}>
          <div className={styles.importScrim} onClick={() => { if (!busy) setPreview(null) }} />
          <div className={styles.drawer}>
            <header className={styles.drawerHead}>
              <div className={styles.drawerTitle}>
                <h3>{t('importTitle')}</h3>
              </div>
              <button type="button" className={styles.drawerClose} aria-label={t('drawerClose')}
                disabled={busy}
                onClick={() => { setPreview(null) }}>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <path d="M2 2 L12 12 M12 2 L2 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
                </svg>
              </button>
            </header>
            <div className={styles.drawerBody}>
              <p className={styles.importSummary}>{t('importSummary', {
                total: preview.entries.length,
                fresh: preview.entries.filter(entry => entry.classification === 'new').length,
                dup: preview.entries.filter(entry => entry.classification === 'duplicate').length,
                conflict: preview.entries.filter(entry => entry.classification === 'conflict').length,
                edges: preview.edgesTotal,
                dangling: preview.edgesDangling,
                entitiesNew: preview.entitiesNew,
                entitiesMerged: preview.entitiesMerged,
              })}</p>
              {preview.redacted === true && (
                <p className={styles.importRedactedNotice}>{t('importRedactedNotice')}</p>
              )}
              <ul className={styles.importList}>
                {preview.entries.map(entry => {
                  const eligible = entry.classification === 'new' || (keepDuplicates && entry.classification === 'duplicate' && entry.id !== entry.duplicateOf)
                  return (
                    <li key={entry.id} className={styles.importRow}>
                      <label className={`${styles.importRowMain} ${eligible ? '' : styles.importRowDisabled}`}>
                        <input type="checkbox" disabled={!eligible || busy}
                          checked={eligible && selected.has(entry.id)}
                          onChange={(event) => {
                            setSelected(previous => {
                              const next = new Set(previous)
                              if (event.target.checked) next.add(entry.id)
                              else next.delete(entry.id)
                              return next
                            })
                          }} />
                        <span className={`${styles.importBadge} ${styles[`importBadge_${entry.classification}`]}`}>
                          {classLabels[entry.classification]}
                        </span>
                        <span className={styles.importContent}>{entry.content}</span>
                      </label>
                    </li>
                  )
                })}
              </ul>
              <label className={styles.importKeepRow}>
                <input type="checkbox" checked={keepDuplicates} disabled={busy}
                  onChange={(event) => { setKeepDuplicates(event.target.checked) }} />
                {t('importKeepDuplicates')}
              </label>
            </div>
            <footer className={styles.importFooter}>
              <button type="button" className={styles.button} disabled={busy}
                onClick={() => { setPreview(null) }}>
                {t('cancel')}
              </button>
              <button type="button" className={`${styles.button} ${styles.importPrimary}`} disabled={busy || selected.size === 0}
                onClick={() => { void commit() }}>
                {busy ? t('importImporting') : t('importConfirm', { n: selected.size })}
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  )
}
/** EngramSection 的 props：渲染器给的 t（locale 席位）+ 可选取用的宿主服务。 */
export type EngramSectionProps = PropsLocale<typeof NS> & {
  /** 宿主工作区服务（缺席时 chip 显示「无工作区信息」，面板其余功能照常）。 */
  readonly workspaces?: WorkspacesLike | undefined
  /** 宿主会话清单服务（用于判定当前会话所属工作区）。 */
  readonly sessions?: SessionsLike | undefined
}

/** 设置页「记忆库」section 主组件（t 由渲染器按 locale: NS 声明合成；面板级语言覆盖在组件内 shadow 之）。 */
export function EngramSection({ t: hostT, workspaces, sessions }: EngramSectionProps): React.ReactElement {
  const toast = useToast()
  /** Открыта ли проверка окна первого запуска: она ничего не записывает. */
  const [panelTest, setPanelTest] = useState(false)
  /** Куда порталом рисуется полноэкранный оверлей панели (правка словаря). */
  const overlayHost = useRef<HTMLDivElement | null>(null)
  /** Язык панели: по умолчанию следует за хостом (lang = hostLang, реактивно к hostT).
   *  Селектор «中 | EN | RU» — ручной override: персистится «library.langMode» = manual
   *  и «library.lang» = выбранный. Вернуться к авто (следовать за хостом) — только
   *  сбросить «library.langMode» (либо добавить пункт «авто» в селектор). */
  const hostLang: PanelLang = hostT('scopeUser') === zh.scopeUser ? 'zh' : hostT('scopeUser') === ru.scopeUser ? 'ru' : 'en'
  const [langMode, setLangMode] = usePersistedState<'auto' | 'manual'>('library.langMode', 'auto', ['auto', 'manual'])
  const [langOverride, setLangOverride] = usePersistedState<PanelLang>('library.lang', hostLang, ['zh', 'en', 'ru'])
  const lang: PanelLang = langMode === 'manual' ? langOverride : hostLang
  const setLang = (next: PanelLang): void => { setLangMode('manual'); setLangOverride(next) }
  const t = useMemo<T>(() => makeT(lang), [lang])
  /** 全局 scope（持久化）：Header 三宫格是唯一切换器，驱动今日速览、各视图卡片、陈展列表与导出。 */
  const [scope, setScope] = usePersistedState<'user' | 'project' | 'shared'>('library.scope', 'user', ['user', 'project', 'shared'])
  /** 库顶 status / kind / q 过滤器（持久化）。 */
  const [status, setStatus] = usePersistedState<string>('library.status', 'all', ['all', 'active', 'archived', 'forgotten'])
  const [kind, setKind] = usePersistedState<string>('library.kind', 'all', ['all', 'fact', 'preference', 'decision', 'episode', 'skill'])
  const [q, setQ] = usePersistedString('library.q', '')
  /** 陈展列表排序（持久化）：time = 开馆时间倒序；tour = 固定巡游路线桩位顺序。 */
  const [sort, setSort] = usePersistedState<'time' | 'tour'>('library.sort', 'time', ['time', 'tour'])
  /** 今日到期条数与 id 集合（Header 角标 + 陈展「今日到期」筛选共用同一次拉取）。 */
  const [dueCount, setDueCount] = useState(0)
  const [dueIds, setDueIds] = useState<ReadonlySet<string>>(new Set())
  /** 陈展「今日到期」筛选：只显示复习调度今天到期的条目。 */
  const [dueOnly, setDueOnly] = useState(false)
  /** 脱敏筛选已合并到顶部 KPI 与 tag 视觉，不再作为过滤器。 */
  const [redacted] = useState('all')
  const [offset, setOffset] = useState(0)
  const [list, setList] = useState<ListResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 行内展开态：互斥的唯一展开条目（review 或 edit）。浮层由 .drawerLayer sticky 钉在滚动区可见顶部，无需滚动定位。 */
  const [expanded, setExpanded] = useState<{ kind: 'review' | 'edit'; record: MemoryRow } | null>(null)
  const [reloadTick, setReloadTick] = useState(0)
  /** 批量选择：条目 id 集合（scope/过滤/翻页/搜索变更时清空）。 */
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  /** 批量遗忘的两段式确认。 */
  const [confirmForget, setConfirmForget] = useState(false)
  /** Tab 视图：today 今日速览 / library 陈展列表 / corridor 走廊与检索 / episodes 往事时间线 / entities 实体词典 / log 管家日志 / backfill 历史回填 / jev Jev 裁决配置。 */
  const [activeTab, setActiveTab] = useState<'today' | 'library' | 'corridor' | 'spiral' | 'episodes' | 'entities' | 'beliefs' | 'log' | 'ops'>('today')
  /** 项目宫殿来源（持久化）：'follow' = 跟随 GUI 当前工作区；其它值 = 固定的 host 分库 dbName。 */
  const [projectMode, setProjectMode] = usePersistedString('library.project', 'follow')
  /** GUI 当前工作区（与侧边栏同一判定）与 host 的项目宫殿清单。 */
  const currentWorkspace = useCurrentWorkspace(workspaces, sessions)
  const [workspaceList, setWorkspaceList] = useState<EngramWorkspacesView | null>(null)
  const workspaceId = currentWorkspace.workspace?.workspaceId ?? ''

  /** 拉取 host 项目宫殿清单（挂载 / 工作区切换 / 固定值变化 / 手动重访）：失败静默，只影响标签与下拉。 */
  useEffect(() => {
    let cancelled = false
    api<EngramWorkspacesView>('workspaces')
      .then((data) => { if (!cancelled) setWorkspaceList(data) })
      .catch(() => { /* 清单失败保持上一次：选择器本身仍可工作（跟随退化为进程默认） */ })
    return () => { cancelled = true }
  }, [workspaceId, projectMode, reloadTick])

  /** 跟随目标：GUI 当前工作区在 host 清单里对应的项目库（匹配不到 = 进程默认库）。 */
  const followedProject = matchFollowTarget(workspaceList, currentWorkspace.workspace)
  /** 实际选择器：follow + 已知工作区 → 该工作区分库；follow + 未知 → null（不注入）。 */
  const projectSelector = projectMode === 'follow' ? followedProject?.dbName ?? null : projectMode
  // 渲染期挂到 api() 的注入点：父先渲染，保证子组件 effect 的首批请求已带上选择器。
  setActiveProjectSelector(projectSelector)
  /** 固定的 dbName 不在 host 清单里（工作区被删除 / 只从会话 cwd 见过）：下拉补一项避免选中态丢失。 */
  const pinnedMissing = projectMode !== 'follow'
    && !(workspaceList?.items ?? []).some(item => item.dbName === projectMode)

  /** 面板级重载信号：清日志后总览遥测要跟着重取，否则瓦片计数停在清理前的旧值。 */
  const reload = useCallback((): void => { setReloadTick(tick => tick + 1) }, [])

  /** 今日速览、健康分构成与房间目录共用一份总览数据（同一路由不重复请求）。 */
  const overview = usePalaceOverview(scope, projectSelector, reloadTick)

  /** 失效选择器的自愈：同一轮只触发一次，回到 follow 后复位（见 api() 的 404 分支）。 */
  const healingRef = useRef(false)
  useEffect(() => {
    setProjectHealHandler((): void => {
      // 只在「固定到某个已失效分库」时自愈；跟随态 404 说明 host 清单与分库不一致，回退只会抖动。
      if (healingRef.current || projectMode === 'follow') return
      healingRef.current = true
      setProjectMode('follow')
      setOffset(0)
      setExpanded(null)
      setSelected(new Set())
      reload()
    })
    return () => { setProjectHealHandler(null) }
  }, [projectMode, reload, setProjectMode])
  useEffect(() => {
    if (projectMode === 'follow') healingRef.current = false
  }, [projectMode])

  /** 刷新今日到期计数与 id 集合（本地回环毫秒级；失败静默归零，不打断面板）。 */
  const refreshDue = useCallback((): void => {
    api<{ items: readonly { id: string }[] }>(`review-due?scope=${scope}&limit=50`)
      .then(data => {
        setDueCount(data.items.length)
        setDueIds(new Set(data.items.map(item => item.id)))
      })
      .catch(() => { setDueCount(0); setDueIds(new Set()) })
  }, [scope, projectSelector])
  useEffect(() => { refreshDue() }, [refreshDue])

  /** 角标点击：切到宫殿陈展并启用「今日到期」筛选（复习调度的消费者是 agent，面板只做观测）。 */
  const goToDue = (): void => {
    setActiveTab('library')
    setDueOnly(true)
  }

  /** 打开详情抽屉：陈展列表已有该行时复用真实行，只有 id 的列表用最小占位行（抽屉自行拉 review）。 */
  const openReview = useCallback((id: string): void => {
    const record = list?.records.find(row => row.id === id)
    setExpanded({
      kind: 'review',
      record: record ?? ({
        id: id as never, scope, kind: 'fact', content: '', importance: 0.5, confidence: 0.5,
        status: 'active', createdAt: Date.now(), accessCount: 0, sourceSessionId: null, sourceRound: null,
      } as MemoryRow),
    })
  }, [list, scope])

  useEffect(() => {
    let cancelled = false
    // q 保留原文（输入法/词组中间空格），只在请求边界 trim——trim 过早会让含空格查询永远打不出来。
    const query = q.trim()
    const qs = new URLSearchParams({
      scope, status, kind, redacted, limit: String(PAGE_SIZE), offset: String(offset),
    })
    if (query !== '') qs.set('q', query)
    if (sort === 'tour') qs.set('sort', 'tour')
    api<ListResult>(`list?${qs.toString()}`)
      .then((data) => { if (!cancelled) { setList(data); setError(null) } })
      .catch((loadError: Error) => { if (!cancelled) setError(loadError.message) })
    return () => { cancelled = true }
  }, [scope, status, kind, redacted, q, sort, offset, reloadTick, projectSelector])

  /** 项目宫殿切换（工作区切换 / 手动固定）：回到第 1 页并清掉跨库无意义的展开与选择态。 */
  const lastProject = useRef(projectSelector)
  useEffect(() => {
    if (lastProject.current === projectSelector) return
    lastProject.current = projectSelector
    setOffset(0)
    setExpanded(null)
    setSelected(new Set())
  }, [projectSelector])

  const act = (route: string, record: MemoryRow): void => {
    api(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: record.id, scope: record.scope }),
    })
      .then(reload)
      .catch((actError: Error) => { toast.push('error', actError.message) })
  }

  const toggle = (expandKind: 'review' | 'edit', record: MemoryRow): void => {
    setExpanded(current => (current !== null && current.kind === expandKind && current.record.id === record.id)
      ? null
      : { kind: expandKind, record })
  }

  const allRecords = list?.records ?? []
  // 「今日到期」筛选是页内视图过滤（复习调度今天到期的 id 白名单）；分页仍按库内全量计算。
  const pageRecords = dueOnly ? allRecords.filter(record => dueIds.has(record.id)) : allRecords
  const selectedRecords = pageRecords.filter(record => selected.has(record.id))
  const forgetable = selectedRecords.filter(record => record.status === 'active').length
  const restorable = selectedRecords.length - forgetable
  const allSelected = pageRecords.length > 0 && pageRecords.every(record => selected.has(record.id))

  const toggleSelect = (id: string): void => {
    setSelected(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const clearSelection = (): void => { setSelected(new Set()); setConfirmForget(false) }

  const toggleAllPage = (): void => {
    setSelected(current => {
      const next = new Set(current)
      if (allSelected) for (const record of pageRecords) next.delete(record.id)
      else for (const record of pageRecords) next.add(record.id)
      return next
    })
  }

  /** 批量执行：逐条调单条 API（回环毫秒级），单条失败不阻塞其余；完成即刷新并清空选择。 */
  const runBatch = (mode: 'forget' | 'restore'): void => {
    const targets = mode === 'forget'
      ? selectedRecords.filter(record => record.status === 'active')
      : selectedRecords.filter(record => record.status !== 'active')
    if (targets.length === 0) return
    void Promise.allSettled(targets.map(target => api(mode, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: target.id, scope: target.scope }),
    }))).then(() => { clearSelection(); reload() })
  }

  const armBatchForget = (): void => {
    // 确认态保持到用户点击确认执行或清空选择，不做自动复位（3 秒窗口曾导致执行落空）。
    if (confirmForget) { runBatch('forget'); return }
    setConfirmForget(true)
  }

  const page = Math.floor(offset / PAGE_SIZE) + 1
  const pages = list === null ? 1 : Math.max(1, Math.ceil(list.total / PAGE_SIZE))
  /** Segmented Control 玻璃指示器位置：根据选中按钮 DOM 测量。 */
  const segRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map())
  const [segIndicator, setSegIndicator] = useState<{ left: number; width: number; opacity: number }>({ left: 0, width: 0, opacity: 0 })
  const measureSeg = useCallback((): void => {
    const node = segRefs.current.get(scope)
    if (node === null || node === undefined) return
    setSegIndicator({ left: node.offsetLeft, width: node.offsetWidth, opacity: 1 })
  }, [scope])
  useEffect(() => {
    measureSeg()
    const onResize = (): void => measureSeg()
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('resize', onResize) }
  }, [measureSeg])

  // 版本握手（审计 F8）：客户端 bundle 可热更新而插件后端进程仍旧（重启前）——
  // v0.8.15 白屏事故正是这种偏斜。挂载时比对一次，不一致即顶部黄横幅提示重启；
  // 旧后端（<0.8.17）没有 /version 路由时静默，维持原状。
  const [versionMismatch, setVersionMismatch] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    api<{ pluginVersion: string }>('version')
      .then(data => { if (!cancelled && data.pluginVersion !== CLIENT_VERSION) setVersionMismatch(data.pluginVersion) })
      .catch(() => { /* 旧后端无此路由：不打扰 */ })
    return () => { cancelled = true }
  }, [])

  return (
    // v0.8+ 主列满宽：.panelRoot 接管纵向滚动（宿主主列可能是 grid 子项不滚动；这里自管滚动后，sticky 浮层定位到 panelRoot 即生效）
    <div className={styles.panelRoot}>
      {/* Хост оверлеев панели: полноэкранные экраны (правка словаря) рисуются порталом сюда.
          Якорь стоит вне .panel намеренно: экран позиционируется fixed, а .panel образует
          собственный контекст наложения (isolation) — изнутри него оверлей не перекрыл бы окно
          целиком. Раньше экран был sticky-слоем в конце карточки обслуживания и оставался
          ниже видимой области при прокрутке: нажатие кнопки выглядело как «ничего не произошло». */}
      <div ref={overlayHost} className={styles.overlayHost} />
      {/* Первый старт: окно выбора языка дворца. Живёт здесь, а не на вкладке «Сегодня»:
          вопрос о языке — не содержимое вкладки, а то, что человек должен увидеть,
          на какой бы вкладке ни открыл панель. */}
      {/* Окно выбора языка дворца открывается только по кнопке «Тест панели».
          Автоматически при входе в плагин его больше нет: пока язык диалогов не определён,
          оно выскакивало при каждом открытии и закрывало собой панель. Язык дворца при этом
          не теряется — его выставляет сама первая реплика человека (observeDialogueLanguage). */}
      {panelTest && (
        <PalaceLanguageAsk t={t} overlayHost={overlayHost} dryRun toast={toast}
          onClose={() => { setPanelTest(false) }} />
      )}
      {versionMismatch !== null && (
        <div className={styles.versionBanner} role="status">
          {t('versionMismatch', { client: CLIENT_VERSION, server: versionMismatch })}
        </div>
      )}
    <div className={styles.panel}>
      {/* 对角双光斑水印由 .panel::before/::after 伪元素绘制，不再占用子元素名额。 */}
      {/* Drawer：sticky 层必须是面板第一个子元素——它位于面板顶部，向下滚动时被滚出头顶即被 sticky
          钉在宿主滚动区可见顶部；放末尾则永远在视口下方、sticky 永不生效（已踩坑）。浮层随视野出现，页面零滚动。 */}
      {expanded !== null && (
        <>
          <div className={styles.drawerScrim} onClick={() => { setExpanded(null) }} />
          <div className={styles.drawerLayer}>
            <aside className={styles.drawer} role="dialog" aria-label={t('drawerTitle')}>
              <header className={styles.drawerHead}>
                <div className={styles.drawerTitle}>
                  <h3>{t('drawerTitle')}</h3>
                  <span title={expanded.record.id}>
                    {`#${expanded.record.id.slice(0, 8)}…`}
                  </span>
                </div>
                <button type="button" className={styles.drawerClose} aria-label={t('drawerClose')}
                  onClick={() => { setExpanded(null) }}>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                    <path d="M2 2 L12 12 M12 2 L2 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
                  </svg>
                </button>
              </header>
              <div className={styles.drawerBody}>
                {expanded.kind === 'review'
                  ? <ReviewBody t={t} recordId={expanded.record.id} scope={expanded.record.scope} project={projectSelector} />
                  : <EditForm t={t} record={expanded.record} onClose={() => { setExpanded(null) }}
                      onSaved={() => { setExpanded(null); reload() }} toast={toast} />}
              </div>
            </aside>
          </div>
        </>
      )}
      {/* Header + Tab 栏吸顶（v0.8.13,#15）：长内容滚动时钉在顶部,内容从下方穿过。 */}
      <div className={styles.panelSticky}>
      {/* Header：单行两端对齐，无任何品牌装饰。
          左：scope 三宫格（当前 scope 在此高亮）；右：今日到期角标 + 重访 + 导出。 */}
      <div className={styles.header}>
        <div className={styles.headerActions}>
          <div className={`${styles.segGroup} ${styles.segScope}`}>
            <span className={styles.segIndicator}
              style={{ left: `${String(segIndicator.left)}px`, width: `${String(segIndicator.width)}px`, opacity: segIndicator.opacity }} />
            {(['user', 'shared', 'project'] as const).map(option => (
              <button key={option} type="button" ref={node => { segRefs.current.set(option, node) }}
                className={scope === option ? `${styles.segItem} ${styles.on}` : styles.segItem}
                onClick={() => { setScope(option); setOffset(0); setExpanded(null); clearSelection() }}>
                <Icon name={option === 'user' ? 'user' : option === 'project' ? 'project' : 'shared'} className={styles.scopeIcon} />
                {t(SCOPE_KEY[option])}
              </button>
            ))}
          </div>
          {/* 项目宫殿工作区下拉：紧贴三宫格同行（仅 project 作用域），替代旧版独占一行的 chip + 下拉 */}
          {scope === 'project' && (
            <SelectField selectClassName={`${styles.input} ${styles.wsSelect}`} value={projectMode}
              ariaLabel={t('projectSwitch')} title={t('projectSwitch')}
              onChange={event => { setProjectMode(event.target.value); setOffset(0); setExpanded(null); clearSelection() }}>
              <option value="follow">{t('projectFollow')}</option>
              {(workspaceList?.items ?? []).map(item => (
                <option key={item.dbName} value={item.dbName}>{projectOptionLabel(t, item)}</option>
              ))}
              {pinnedMissing && (
                <option value={projectMode}>{`${shortDbName(projectMode)} · ${t('projectUnregistered')}`}</option>
              )}
            </SelectField>
          )}
        </div>
        <div className={styles.headerActions}>
          {/* 今日待回忆角标：钟形图标 + 数字 */}
          {dueCount > 0 && (
            <button type="button" className={styles.dueBadge}
              title={t('dueBadgeLabel', { n: dueCount })} aria-label={t('dueBadgeLabel', { n: dueCount })}
              onClick={goToDue}>
              <Icon name="clock" className={styles.dueIcon} />
              {dueCount}
            </button>
          )}
          <button type="button" className={styles.button} title={t('refresh')} aria-label={t('refresh')}
            onClick={() => { reload(); refreshDue() }}>
            <Icon name="refresh" className={styles.brandIcon} />
          </button>
          {/* 语言下拉：面板级中英俄覆盖，与宿主语言设置相互独立；选择持久化在本机。
              用列表而不是三个并排按钮：误点只会展开列表、不会当场换掉语言，且将来
              语言变多时不会把顶栏撑开、挤坏排版。选项写各自语言的本名，任何语言下
              都能认出自己那一条。 */}
          <SelectField selectClassName={`${styles.input} ${styles.langSelect}`} value={lang}
            ariaLabel={t('language')}
            onChange={(event) => { setLang(event.target.value as PanelLang) }}>
            <option value="zh">中文</option>
            <option value="en">English</option>
            <option value="ru">Русский</option>
          </SelectField>
          <ImportButton t={t} scope={scope} toast={toast} onImported={() => { reload(); refreshDue() }} />
          <ExportMenu t={t} scope={scope} project={projectSelector} toast={toast} />
        </div>
      </div>

      {/* 顶部 Tab Bar：八个视图，每个 Tab 项前置线性图标；当前项用 amber→rose 渐变彩条作下划线。
          排序沿用旧版（先管家后陈展与配置）。 */}
      <div className={styles.tabs} role="tablist">
        <button type="button" role="tab"
          className={activeTab === 'today' ? `${styles.tabItem} ${styles.on}` : styles.tabItem}
          aria-selected={activeTab === 'today'}
          onClick={() => { setActiveTab('today') }}>
          <Icon name="today" className={styles.tabIcon} />
          {t('tabToday')}
        </button>
        <button type="button" role="tab"
          className={activeTab === 'library' ? `${styles.tabItem} ${styles.on}` : styles.tabItem}
          aria-selected={activeTab === 'library'}
          onClick={() => { setActiveTab('library') }}>
          <Icon name="library" className={styles.tabIcon} />
          {t('tabLibrary')}
        </button>
        <button type="button" role="tab"
          className={activeTab === 'corridor' ? `${styles.tabItem} ${styles.on}` : styles.tabItem}
          aria-selected={activeTab === 'corridor'}
          onClick={() => { setActiveTab('corridor') }}>
          <Icon name="corridor" className={styles.tabIcon} />
          {t('tabCorridor')}
        </button>
        {/* 回忆螺旋（v0.9.x）：时间型鸟瞰视图，挨着「走廊」语义相邻，鸟瞰集合。 */}
        <button type="button" role="tab"
          className={activeTab === 'spiral' ? `${styles.tabItem} ${styles.on}` : styles.tabItem}
          aria-selected={activeTab === 'spiral'}
          onClick={() => { setActiveTab('spiral') }}>
          <Icon name="spiral" className={styles.tabIcon} />
          {t('tabSpiral')}
        </button>
        <button type="button" role="tab"
          className={activeTab === 'episodes' ? `${styles.tabItem} ${styles.on}` : styles.tabItem}
          aria-selected={activeTab === 'episodes'}
          onClick={() => { setActiveTab('episodes') }}>
          <Icon name="episodes" className={styles.tabIcon} />
          {t('tabEpisodes')}
        </button>
        <button type="button" role="tab"
          className={activeTab === 'entities' ? `${styles.tabItem} ${styles.on}` : styles.tabItem}
          aria-selected={activeTab === 'entities'}
          onClick={() => { setActiveTab('entities') }}>
          <Icon name="entities" className={styles.tabIcon} />
          {t('tabEntities')}
        </button>
        <button type="button" role="tab"
          className={activeTab === 'beliefs' ? `${styles.tabItem} ${styles.on}` : styles.tabItem}
          aria-selected={activeTab === 'beliefs'}
          onClick={() => { setActiveTab('beliefs') }}>
          <Icon name="beliefs" className={styles.tabIcon} />
          {t('tabBeliefs')}
        </button>
        <button type="button" role="tab"
          className={activeTab === 'log' ? `${styles.tabItem} ${styles.on}` : styles.tabItem}
          aria-selected={activeTab === 'log'}
          onClick={() => { setActiveTab('log') }}>
          <Icon name="log" className={styles.tabIcon} />
          {t('tabLog')}
        </button>
        <button type="button" role="tab"
          className={activeTab === 'ops' ? `${styles.tabItem} ${styles.on}` : styles.tabItem}
          aria-selected={activeTab === 'ops'}
          onClick={() => { setActiveTab('ops') }}>
          <Icon name="jev" className={styles.tabIcon} />
          {t('tabOps')}
        </button>
      </div>
      </div>

      {/* Тело вкладки: единственная прокручиваемая область панели. Меню выше в прокрутке
          не участвует, поэтому содержимое физически не может оказаться над ним. */}
      <div className={styles.panelBody}>
      <ViewErrorBoundary key={activeTab} retryLabel={t('retry')} hintLabel={t('viewCrashed')}>
      {activeTab === 'library' && (
        <div className={styles.tabPanel}>
          <PageHeader title={t('tabLibrary')} subtitle={t('pageHeaderLibrarySubtitle')} />
          {/* v0.8.9 工具行收进工具条卡;房间 chips 仍单独一行。 */}
          <div className={styles.toolbarCard}>
            <span className={styles.searchBox}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M16.5 16.5 L21 21" /></svg>
              <input className={`${styles.input} ${styles.search}`} placeholder={t('searchPlaceholder')} value={q}
                onChange={event => { setQ(event.target.value); setOffset(0); setExpanded(null); clearSelection() }} />
            </span>
            <div className={styles.segGroup}>
              {([
                ['all', t('allStatuses')],
                ['active', t('statusActive')],
                ['archived', t('statusArchived')],
                ['forgotten', t('statusForgotten')],
              ] as const).map(([value, label]) => (
                <button key={value} type="button"
                  className={status === value ? `${styles.segItem} ${styles.on}` : styles.segItem}
                  onClick={() => { setStatus(value); setOffset(0); setExpanded(null); clearSelection() }}>
                  {label}
                </button>
              ))}
            </div>
            {/* 今日到期：复习调度今天到期的条目（消费者是 agent，这里只做观测筛选）。
                单独一个按钮不嵌 .segGroup（没有玻璃指示器可滑动）；用 .chip/.chipOn 的视觉语言
                让激活态有清晰品牌色提示，跟其他激活态一致。 */}
            <button type="button" aria-pressed={dueOnly}
              className={dueOnly ? `${styles.chip} ${styles.chipOn}` : styles.chip}
              onClick={() => { setDueOnly(!dueOnly); setOffset(0); setExpanded(null); clearSelection() }}>
              {t('filterDueToday')}
            </button>
            <div className={styles.segGroup}>
              {([['time', t('sortTime')], ['tour', t('sortTour')]] as const).map(([value, label]) => (
                <button key={value} type="button"
                  className={sort === value ? `${styles.segItem} ${styles.on}` : styles.segItem}
                  onClick={() => { setSort(value); setOffset(0); setExpanded(null); clearSelection() }}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className={styles.chipRow}>
            {([
              ['all', t('allKinds')],
              ...KINDS.map(option => [option, kindLabel(t, option)] as const),
            ] as const).map(([value, label]) => (
              <button key={value} type="button" aria-pressed={kind === value}
                className={kind === value ? `${styles.chip} ${styles.chipOn}` : styles.chip}
                onClick={() => { setKind(value); setOffset(0); setExpanded(null); clearSelection() }}>
                {label}
              </button>
            ))}
          </div>

          {selected.size > 0 && (
            <div className={styles.batchBar}>
              <span>{t('selectedCount', { n: selected.size })}</span>
              <button type="button" className={styles.button} onClick={toggleAllPage}>
                {allSelected ? t('deselectAll') : t('selectAll')}
              </button>
              <button type="button" className={styles.button} disabled={restorable === 0}
                onClick={() => runBatch('restore')}>{t('batchRestore', { n: restorable })}</button>
              <button type="button"
                className={confirmForget ? `${styles.button} ${styles.danger}` : styles.button}
                disabled={forgetable === 0}
                onClick={armBatchForget}>
                {confirmForget ? t('batchForgetConfirm', { n: forgetable }) : t('batchForget', { n: forgetable })}
              </button>
              <button type="button" className={styles.button} onClick={clearSelection}>{t('clearSelection')}</button>
            </div>
          )}

          {error !== null && (
            <EmptyState title={t('loadFailed', { msg: error })} hint={t('emptyHint')} />
          )}
          {error === null && list === null && (
            <div className={styles.skeletonList}>
              {[0, 1, 2, 3].map(index => (
                <div key={index} className={styles.skeleton} style={{ animationDelay: `${String(index * 60)}ms` }}><i /><i /><i /></div>
              ))}
            </div>
          )}
          {error === null && list !== null && pageRecords.length === 0 && (
            <EmptyState title={t('empty')} hint={t('emptyHint')} />
          )}

          {pageRecords.length > 0 && (
            <div className={styles.itemList}>
              {pageRecords.map((record, index) => (
                <div key={record.id}
                  className={selected.has(record.id) ? `${styles.item} ${styles.selected}` : styles.item}
                  style={{ animationDelay: `${String(Math.min(index, 12) * 36)}ms` }}>
                  <input type="checkbox" className={styles.itemCheck} checked={selected.has(record.id)}
                    aria-label={record.content.slice(0, 24)} onChange={() => toggleSelect(record.id)} />
                  <div className={styles.itemBody}>
                    <div className={styles.itemTags}>
                      <span className={`${styles.pill} ${styles[`status${record.status.charAt(0).toUpperCase()}${record.status.slice(1)}`] ?? ''}`}>{t(STATUS_KEY[record.status])}</span>
                      <span className={roomPillClass(record.kind)}>{kindLabel(t, record.kind)}</span>
                      {record.slot !== undefined && (
                        <span className={styles.pill}>{record.slot.room}#{record.slot.index}</span>
                      )}
                      {record.content.includes('[REDACTED:') && (
                        <span className={`${styles.pill} ${styles.redacted}`}>{t('tagRedacted')}</span>
                      )}
                      {record.outcome !== undefined && (
                        <span className={`${styles.pill} ${record.outcome === 'success' ? styles.outcomeSuccess : styles.outcomeFailure}`}>
                          {record.outcome === 'success' ? t('tagOutcomeSuccess') : t('tagOutcomeFailure')}
                        </span>
                      )}
                      <span className={styles.itemStamp} title={fmtTime(record.createdAt)}>
                        {t(SCOPE_KEY[record.scope])} · {relTime(t, record.createdAt)}
                      </span>
                    </div>
                    <div className={styles.content}>{record.content}</div>
                    <div className={styles.itemMeta}>
                      <span><b>{t('importance')}</b> {record.importance.toFixed(2)}</span>
                      <span><b>{t('confidence')}</b> {record.confidence.toFixed(2)}</span>
                      <span>{t('accessCount', { n: record.accessCount })}</span>
                      <span>{sourceLabel(t, record)}</span>
                    </div>
                  </div>
                  <div className={styles.itemOps}>
                    <button type="button" className={styles.button}
                      onClick={() => { toggle('review', record) }}>{t('detail')}</button>
                    <button type="button" className={styles.button}
                      onClick={() => { toggle('edit', record) }}>{t('edit')}</button>
                    {record.status === 'active'
                      ? <button type="button" className={styles.button}
                          onClick={() => { act('forget', record) }}>{t('forget')}</button>
                      : <button type="button" className={styles.button}
                          onClick={() => { act('restore', record) }}>{t('restore')}</button>}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className={styles.pager}>
            <button type="button" className={styles.button} disabled={offset === 0} aria-label={t('prevPage')}
              onClick={() => { setOffset(Math.max(0, offset - PAGE_SIZE)); setExpanded(null); clearSelection() }}>‹</button>
            <span>{t('pagerInfo', { page, pages, total: list?.total ?? 0 })}</span>
            <button type="button" className={styles.button} disabled={list === null || offset + PAGE_SIZE >= list.total}
              aria-label={t('nextPage')}
              onClick={() => { setOffset(offset + PAGE_SIZE); setExpanded(null); clearSelection() }}>›</button>
          </div>
        </div>
      )}

      {activeTab === 'today' && (
        <div className={styles.tabPanel}>
          <PageHeader title={t('tabToday')} subtitle={t('pageHeaderTodaySubtitle')} />
          {/* 今日速览：主指标 + 健康环，替代原常驻日报条。 */}
          <TodayHero t={t} overview={overview} dueCount={dueCount} />
          {/* v0.8.1+ 活动热力日历：90 天写入/摄取/修缮分布，GitHub 风的 7×N 网格 */}
          <div className={styles.layout}>
            {/* v0.8.6 dashboard 结构：左宽列 = 半年热力 + 入殿导航；右窄列 = 房间目录 + 翻新清单 + 画像。
                今日到期不再单独成卡：消费者是 agent（review 工具链），面板只在速览条显示计数、在陈展提供筛选。 */}
            <div className={styles.mainCol}>
              <ActivityHeatmap t={t} daily={overview.telemetry === null ? undefined : overview.telemetry.dailyWrites} />
              <section className={styles.section}>
                <div className={styles.sectionHead}>
                  <h4 className={styles.sectionTitle}>{t('tourProposalTitle')}</h4>
                </div>
                <div className={styles.panelCard}>
                  <TourProposalCard t={t} scope={scope} project={projectSelector} onSelect={openReview} />
                </div>
              </section>
              {/* v0.9.1（#19 问题一/二，方案 A）：翻新清单从右下窄栏挪到主列满宽铺开——
                  执行是写操作，长文本理由与记忆原文必须完整可读、就地操作，不再挤在
                  小卡里靠弹窗补全。sideCol 只留纯展示的房间目录与画像。 */}
              <section className={styles.section}>
                <div className={styles.sectionHead}>
                  <h4 className={styles.sectionTitle}>{t('refurbTitle')}</h4>
                </div>
                <div className={styles.panelCard}>
                  <RefurbCard t={t} scope={scope} project={projectSelector} onSelect={openReview} onAfterAction={reload} toast={toast} lang={lang} />
                </div>
              </section>
            </div>
            <aside className={styles.sideCol}>
              <section className={styles.section}>
                <div className={styles.sectionHead}>
                  <h4 className={styles.sectionTitle}>{t('roomsTitle')}</h4>
                  <span className={styles.sectionHint}>{t('roomsHint')}</span>
                </div>
                <div className={styles.panelCard}>
                  <RoomDirectory t={t} byKind={overview.byKind} />
                </div>
              </section>
              <section className={styles.section}>
                <div className={styles.sectionHead}>
                  <h4 className={styles.sectionTitle}>{t('profileTitle')}</h4>
                </div>
                <div className={styles.panelCard}>
                  <ProfileCard t={t} scope={scope} project={projectSelector} />
                </div>
              </section>
            </aside>
          </div>
        </div>
      )}

      {activeTab === 'corridor' && (
        <div className={styles.tabPanel}>
          <PageHeader title={t('tabCorridor')} subtitle={t('pageHeaderCorridorSubtitle')} />
          {/* 纵向堆叠：先看走廊结构（鸟瞰），再进检索实验台；两块都吃满宽度，图与命中行不被压窄。 */}
          <div className={styles.mainCol}>
            <section className={styles.section}>
              <div className={styles.sectionHead}>
                <h4 className={styles.sectionTitle}>{t('sectionCorridor')}</h4>
              </div>
              <div className={styles.panelCard}>
                <CorridorPanel t={t} scope={scope} project={projectSelector} onSelect={openReview}
                  onOpenRoom={kind => { setKind(kind); setOffset(0); setExpanded(null); clearSelection(); setActiveTab('library') }} />
              </div>
            </section>
            <section className={styles.section}>
              <div className={styles.sectionHead}>
                <h4 className={styles.sectionTitle}>{t('benchTitle')}</h4>
                <span className={styles.sectionHint}>{t('benchNote')}</span>
              </div>
              <div className={styles.panelCard}>
                <RecallBench t={t} scope={scope} />
              </div>
            </section>
          </div>
        </div>
      )}

      {activeTab === 'spiral' && (
        <div className={styles.tabPanel}>
          <SpiralPanel t={t} scope={scope} project={projectSelector} reloadTick={reloadTick} />
        </div>
      )}

      {activeTab === 'episodes' && (
        <div className={styles.tabPanel}>
          <PageHeader title={t('tabEpisodes')} subtitle={t('pageHeaderEpisodesSubtitle')} />
          <section className={styles.section}>
            <EpisodeTimelineView t={t} scope={scope} project={projectSelector} reloadTick={reloadTick} />
          </section>
        </div>
      )}

      {activeTab === 'entities' && (
        <div className={styles.tabPanel}>
          <PageHeader title={t('tabEntities')} subtitle={t('pageHeaderEntitiesSubtitle')} />
          <section className={styles.section}>
            <EntityView t={t} scope={scope} project={projectSelector} reloadTick={reloadTick} />
          </section>
        </div>
      )}

      {activeTab === 'beliefs' && (
        <div className={styles.tabPanel}>
          <PageHeader title={t('tabBeliefs')} subtitle={t('pageHeaderBeliefsSubtitle')} />
          <section className={styles.section}>
            <BeliefsView t={t} scope={scope} project={projectSelector} reloadTick={reloadTick} />
          </section>
        </div>
      )}

      {activeTab === 'log' && (
        <div className={styles.tabPanel}>
          <PageHeader title={t('tabLog')} subtitle={t('pageHeaderLogSubtitle')} />
          <LogPanel t={t} telemetry={overview.telemetry} project={projectSelector} onCleared={reload} />
        </div>
      )}

      {activeTab === 'ops' && (
        <div className={styles.tabPanel}>
          <OpsTab t={t} overlayHost={overlayHost} lang={lang} toast={toast}
            onTestPanel={() => { setPanelTest(true) }} />
        </div>
      )}
    </ViewErrorBoundary>
      </div>

      {/* Toast 叠层（右上角，position:fixed 脱离 panel 容器）。 */}
      {toast.viewport}
    </div>
    </div>
  )
}

/**
 * 注册用的薄包装：把**可选取用**的宿主服务经闭包带进 props。
 * 放在 .tsx 里是因为 index.ts 不能写 JSX；服务缺席时照常渲染（chip 显示「无工作区信息」）。
 * 服务按**渲染期现取**（getter 而非实例）：宿主工作区/会话服务可能在插件 apply 之后才挂载。
 * @param services - 取宿主服务的 getter（workspaces / sessions，均可缺席）。
 * @returns 与注册席位兼容的组件（只吃 locale 的 t，其余 props 原样忽略）。
 */
export function bindEngramSection(services: {
  readonly workspaces: () => WorkspacesLike | undefined
  readonly sessions: () => SessionsLike | undefined
}): (props: PropsLocale<typeof NS>) => React.ReactElement {
  return function EngramSectionBound(props: PropsLocale<typeof NS>): React.ReactElement {
    return <EngramSection {...props} workspaces={services.workspaces()} sessions={services.sessions()} />
  }
}
