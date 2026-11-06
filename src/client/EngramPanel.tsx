/**
 * 记忆库设置面板：统计卡片、过滤列表、批量操作、编辑（取代链）、遗忘/恢复、导出。
 * 数据经回环 API（/api/engram/*）读写；详情与编辑为条目下方行内展开
 * （不嵌套弹窗）；文案全部走宿主 locale 词典（zh/en），语言切换自动
 * 重渲染；数据层英文枚举（status/kind/op）只在显示层映射；内容节点
 * 一律 DOM/JSX 构建（防 XSS）。
 * @module @kenz1117/dsh-engram/client/EngramPanel
 */

import { Component, Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import styles from './panel.module.css'
import { KIND_KEY, type NS, ru, zh, type EngramKey } from './locales/index.ts'
import { useToast, type ToastController } from './Toast.tsx'
import { ContextNav } from './shell/ContextNav.tsx'
import { StatusStrip } from './shell/StatusStrip.tsx'
import { WorkfaceRail, type Workface } from './shell/WorkfaceRail.tsx'
import shellStyles from './shell/shell.module.css'
import { GovernanceView } from './views/GovernanceView.tsx'
import { RecallView } from './views/RecallView.tsx'
import { RecordsPanel, type RecordsRequest } from './views/memory/RecordsPanel.tsx'
import { PalaceLanguageAsk, SystemView, type SystemSection } from './views/system/SystemView.tsx'
import { CorridorPanel, SpiralPanel } from './views/memory/AtlasPanel.tsx'
import { EntityView } from './views/memory/EntitiesPanel.tsx'
import { EpisodeTimelineView } from './views/memory/TimelinePanel.tsx'
import { ConfirmButton } from './ui/ConfirmButton.tsx'
import { EmptyState, kindLabel, KINDS, LoadFailedLine, Metric, PageHeader, roomClass, roomPillClass, SelectField, type T } from './ui/panel-kit.tsx'
import {
  fmtTime,
  formatBytes,
  formatOpDetail,
  type MemoryRow,
  opLabel,
  relTime,
  REL_KEY,
  type ReviewView,
  SCOPE_KEY,
  sourceLabel,
  STATUS_KEY,
  type TelemetrySnapshot,
} from './ui/model.ts'
import { usePersistedState, usePersistedString } from './UiStorage.ts'
import { IMPORT_BODY_LIMIT_BYTES } from '../body-limits.ts'
import pluginPackageJson from '../../package.json' with { type: 'json' }

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
  // 工作面图标（0.13）
  search: <><circle cx="11" cy="11" r="7" /><path d="M16.5 16.5 L21 21" /></>,
  shield: <><path d="M12 3 L20 6 V12 C20 16.5 16.5 20 12 21 C7.5 20 4 16.5 4 12 V6 Z" /><path d="M9 12l2 2 4-4" /></>,
  replay: <><path d="M4 12a8 8 0 0113.7-5.7L21 9" /><path d="M21 4v5h-5" /><path d="M20 12a8 8 0 01-13.7 5.7L3 15" /><path d="M3 20v-5h5" /></>,
  gear: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" /></>,
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

/** 面板内部传递的翻译函数（渲染器按注册的 locale 声明合成的 t 的窄化签名）。 */
// 面板级词典合成与俄语复数抽到 translate.ts（审计批次 3）：纯函数零 react 依赖，
// client 测试直接可测。此处 re-export 维持既有引用面。
export { makeT, ruPluralForm } from './translate.ts'
import { makeT, type PanelLang } from './translate.ts'

import { api, setActiveProjectSelector, setProjectHealHandler } from './rpc.ts'
import { useApi } from './useApi.ts'
// 请求出口与项目作用域注入抽到 rpc.ts（审计批次 3）：useApi 复用 api() 不构成循环导入。
// api / setActiveProjectSelector / setProjectHealHandler 在此 re-export，组件内的既有
// 调用点与测试都不必改 import 来源。
export { api, setActiveProjectSelector, setProjectHealHandler } from './rpc.ts'

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

/** 速览指标：大数 + 小标签 + sparkline + delta 行（v0.8.8 对齐设计稿 #sparkline）。 */

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
  const stableId = record.memoryId ?? record.id
  return (
    <div className={styles.reviewGrid}>
      <div>
        <dl className={styles.attrGrid}>
          <dt>{t('identityStable')}</dt>
          <dd><code className={styles.identityCode} title={stableId}>{stableId}</code></dd>
          <dt>{t('identityRevision')}</dt>
          <dd><code className={styles.identityCode} title={record.id}>{record.id}</code></dd>
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
            <p className={styles.sectionHint}>{t('identityRevisionNote')}</p>
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

/* ---------- 版本卡 + 更多作品（画像下方的插件自述与同作者广告位）：全部为外链导航（新窗），不取数 ---------- */

/** 发布元信息（版本卡）：包名/版本取自包 package.json 单一来源；仓库链接由 repository.url 归一化。 */
const PLUGIN_REPO_URL: string = pluginPackageJson.repository.url.replace(/^git\+/, '').replace(/\.git$/, '')
const PLUGIN_NPM_URL = `https://www.npmjs.com/package/${pluginPackageJson.name}`
const PLUGIN_AUTHOR_URL = 'https://github.com/kenz1117'
const PLUGIN_LICENSE = 'MIT'

/**
 * 版本卡：包名 + 版本 tag + 一句话定位 + 作者/仓库/npm/许可证 2×2 元信息。
 * 版本号与版本握手横幅同源（包 package.json），不存在第二处可失同步的版本常量。
 */
function PluginCard({ t }: { t: T }): React.ReactElement {
  return (
    <div className={styles.pluginCard}>
      <div className={styles.pluginHead}>
        <span className={styles.pluginGlyph} aria-hidden="true">
          <svg className={styles.pluginGlyphIcon} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M4 21h16" />
            <path d="M6 21v-8.5L12 7l6 5.5V21" />
            <path d="M12 7V4" />
            <path d="M10 21v-4a2 2 0 0 1 4 0v4" />
          </svg>
        </span>
        <div className={styles.pluginTitle}>
          <div className={styles.pluginNameRow}>
            <span className={styles.pluginName}>{pluginPackageJson.name}</span>
            <span className={styles.pluginTag}>{`v${CLIENT_VERSION}`}</span>
          </div>
          <p className={styles.pluginDesc}>{t('aboutDesc')}</p>
        </div>
      </div>
      <div className={styles.pluginMeta}>
        <div className={styles.pluginMetaItem}>
          <span className={styles.pluginMetaLabel}>{t('aboutAuthor')}</span>
          <a className={styles.pluginMetaLink} href={PLUGIN_AUTHOR_URL} target="_blank" rel="noreferrer">KenZ (kenz1117)</a>
        </div>
        <div className={styles.pluginMetaItem}>
          <span className={styles.pluginMetaLabel}>{t('aboutRepo')}</span>
          <a className={styles.pluginMetaLink} href={PLUGIN_REPO_URL} target="_blank" rel="noreferrer">GitHub</a>
        </div>
        <div className={styles.pluginMetaItem}>
          <span className={styles.pluginMetaLabel}>{t('aboutNpm')}</span>
          <a className={styles.pluginMetaLink} href={PLUGIN_NPM_URL} target="_blank" rel="noreferrer">{pluginPackageJson.name}</a>
        </div>
        <div className={styles.pluginMetaItem}>
          <span className={styles.pluginMetaLabel}>{t('aboutLicense')}</span>
          <span className={styles.pluginMetaVal}>{PLUGIN_LICENSE}</span>
        </div>
      </div>
    </div>
  )
}

/**
 * 更多作品：同作者的两个配套插件（usage-billing / rainbowspeak），整行外链新窗。
 * 虹语行的图标用真彩虹渐变描边——产品即彩虹，广告位即演示；账单行走账单色徽章。
 * 与 usage-billing 面板「设置-关于」的同名广告位互为镜像（那边推荐本插件与虹语）。
 */
function MoreWorksCard({ t }: { t: T }): React.ReactElement {
  return (
    <div className={styles.moreWorks}>
      <a className={styles.moreWorkRow} href="https://github.com/kenz1117/dsh-ui-usage-billing" target="_blank" rel="noreferrer">
        <span className={`${styles.moreWorkGlyph} ${styles.moreWorkGlyphBilling}`} aria-hidden="true">
          <svg className={styles.moreWorkGlyphIcon} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
            <path d="M9.5 8h5" />
            <path d="M9.5 12h5" />
          </svg>
        </span>
        <span className={styles.moreWorkText}>
          <span className={styles.moreWorkName}>{t('adBillingName')}</span>
          <span className={styles.moreWorkDesc}>{t('adBillingDesc')}</span>
        </span>
        <svg className={styles.moreWorkArrow} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M7 17L17 7" />
          <path d="M9 7h8v8" />
        </svg>
      </a>
      <a className={`${styles.moreWorkRow} ${styles.moreWorkRowRainbow}`} href="https://github.com/kenz1117/dsh-ui-rainbowspeak" target="_blank" rel="noreferrer">
        <span className={`${styles.moreWorkGlyph} ${styles.moreWorkGlyphRainbow}`} aria-hidden="true">
          <svg className={styles.moreWorkGlyphIcon} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <defs>
              <linearGradient id="engram-ad-rainbow" x1="3" y1="18" x2="21" y2="9" gradientUnits="userSpaceOnUse">
                <stop offset="0" stopColor="#e0533f" />
                <stop offset="0.28" stopColor="#e0a33f" />
                <stop offset="0.52" stopColor="#4ba05a" />
                <stop offset="0.76" stopColor="#3b6ef5" />
                <stop offset="1" stopColor="#a45cf0" />
              </linearGradient>
            </defs>
            <path d="M3 18a9 9 0 0 1 18 0" fill="none" stroke="url(#engram-ad-rainbow)" />
            <path d="M7 18a5 5 0 0 1 10 0" fill="none" stroke="url(#engram-ad-rainbow)" />
            <path d="M10.5 18a1.5 1.5 0 0 1 3 0" fill="none" stroke="url(#engram-ad-rainbow)" />
          </svg>
        </span>
        <span className={styles.moreWorkText}>
          <span className={styles.moreWorkName}>{t('adRainbowName')}</span>
          <span className={styles.moreWorkDesc}>{t('adRainbowDesc')}</span>
        </span>
        <svg className={styles.moreWorkArrow} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M7 17L17 7" />
          <path d="M9 7h8v8" />
        </svg>
      </a>
    </div>
  )
}

/** 加载失败行（紧凑）：文案 + 重试按钮，用于卡片内失败态；整页失败态用 EmptyState。
 *  #S3（审计）：禁止 catch 里把失败伪装成空态——失败与健康必须可区分。 */

/** 视图级错误边界（审计 §1.1）：单个页签渲染异常降级为错误卡 + 重载按钮，
 *  不再放大成宿主 slot 错误边界那种「整面板白屏且无恢复 UI」。
 *  key=工作面 + 二级视图：切换即换边界实例，错误不跨视图扩散；重试经 remount 重新拉取。
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
                    {suggestion.action === 'demote'
                      ? (
                        <ConfirmButton className={`${styles.refurbExec} ${styles.button}`} disabled={busy}
                          label={t('refurbExecute')} confirmLabel={t('refurbConfirmDemote')}
                          onConfirm={() => { execute(suggestion) }} />
                      )
                      : suggestion.action === 'merge'
                        ? suggestion.candidates.length + 1 < 2
                          ? (
                            <button type="button" className={`${styles.refurbExec} ${styles.button}`} disabled={busy}
                              onClick={() => { toast.push('warning', t('refurbMergeEmpty')) }}>{t('refurbExecute')}</button>
                          )
                          : (
                            <ConfirmButton className={`${styles.refurbExec} ${styles.button}`} disabled={busy}
                              label={t('refurbExecute')}
                              confirmLabel={t('refurbConfirmMerge', { n: suggestion.candidates.length + 1 })}
                              onConfirm={() => { execute(suggestion) }} />
                          )
                        : (
                          <button type="button" className={`${styles.refurbExec} ${styles.button}`} disabled={busy}
                            onClick={() => { execute(suggestion) }}>{t('refurbExecute')}</button>
                        )}
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
 * 卡片按状态给操作：作废（→ refuted，两次点击确认，同日志清理模式）与
 * 恢复（→ active，直发）；成功后局部刷新列表并弹 Toast，失败只弹错误。
 */
function BeliefsView({ t, scope, project, reloadTick, toast }: {
  t: T
  scope: 'user' | 'project' | 'shared'
  /** 项目宫殿选择器（仅用于重载依赖；注入在 api() 里做）。 */
  project: string | null
  reloadTick: number
  toast: ToastController
}): React.ReactElement {
  const [status, setStatus] = useState<'all' | 'active' | 'stale' | 'refuted'>('all')
  const [data, setData] = useState<{ items: readonly BeliefRow[]; total: number } | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  /** 展开证据链的信念 id（null = 全部收起）。 */
  const [openId, setOpenId] = useState<string | null>(null)
  const [evidence, setEvidence] = useState<readonly MemoryRow[] | null>(null)
  const [evidenceBusy, setEvidenceBusy] = useState(false)
  /** 本视图私有的重载信号：作废/恢复成功后 bump，让 useEffect 重拉列表（不惊动父级 reloadTick）。 */
  const [localTick, setLocalTick] = useState(0)
  /** 列表取数中（含动作成功后的刷新）：动作按钮统一禁用，避免在半新数据上重复操作。 */
  const [listBusy, setListBusy] = useState(false)
  /** 提交中的动作 `${beliefId}:${target}`；null = 空闲。提交期间禁用所有动作按钮防双击重发。 */
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  /** 待二次确认的作废目标 `${beliefId}:refuted`（两次点击模式，同日志清理 confirmClear）。 */
  const [confirmKey, setConfirmKey] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setListBusy(true)
    const params = new URLSearchParams({ scope })
    if (status !== 'all') params.set('status', status)
    api<{ items: readonly BeliefRow[]; total: number }>(`observations?${params.toString()}`)
      .then(d => { if (!cancelled) { setData(d); setFailed(null) } })
      .catch((err: Error) => { if (!cancelled) setFailed(err.message) })
      .finally(() => { if (!cancelled) setListBusy(false) })
    return () => { cancelled = true }
  }, [scope, project, status, reloadTick, localTick])

  /** 展开/收起证据链：ids 逗号拼 query（上限 50，store 端截断兜底）；切换时清旧证据。 */
  const toggleEvidence = (row: BeliefRow): void => {
    if (openId === row.id) { setOpenId(null); setEvidence(null); return }
    setOpenId(row.id)
    setEvidence(null)
    setConfirmKey(null)
    setEvidenceBusy(true)
    api<{ items: readonly MemoryRow[] }>(`observation-evidence?scope=${scope}&ids=${encodeURIComponent(row.sourceIds.join(','))}`)
      .then(d => { setEvidence(d.items); setEvidenceBusy(false); setFailed(null) })
      .catch((err: Error) => { setFailed(err.message); setEvidenceBusy(false) })
  }

  /**
   * 作废/恢复（POST observation-status）：作废是破坏性语义走两次点击确认，
   * 恢复直发。scope 用行自带的（shared 合并视图里行可能来自另一侧库）；
   * project 选择器由 api() 在 body.scope === 'project' 时自动注入。成功后
   * bump localTick 重拉列表（filtered 视图里行会按新状态正确出现/消失）。
   */
  const setBeliefStatus = (row: BeliefRow, target: 'active' | 'refuted'): void => {
    const busyKey = `${row.id}:${target}`
    if (target === 'refuted' && confirmKey !== busyKey) { setConfirmKey(busyKey); return }
    setConfirmKey(null)
    setActionBusy(busyKey)
    api<{ ok: boolean }>('observation-status', {
      method: 'POST',
      body: JSON.stringify({ id: row.id, status: target, scope: row.scope }),
    })
      .then(() => {
        setActionBusy(null)
        setLocalTick(tick => tick + 1)
        toast.push('success', t(target === 'refuted' ? 'beliefRefuteDone' : 'beliefRestoreDone'))
      })
      .catch((err: Error) => {
        setActionBusy(null)
        toast.push('error', t('beliefActionFailed', { msg: err.message }))
      })
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
            onClick={() => { setStatus(value); setOpenId(null); setEvidence(null); setConfirmKey(null) }}>
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
            {row.status !== 'refuted' && (
              <button type="button" disabled={listBusy || actionBusy !== null}
                className={confirmKey === `${row.id}:refuted` ? `${styles.button} ${styles.danger}` : styles.button}
                onClick={() => { setBeliefStatus(row, 'refuted') }}>
                {confirmKey === `${row.id}:refuted` ? t('beliefRefuteConfirm') : t('beliefRefute')}
              </button>
            )}
            {row.status !== 'active' && (
              <button type="button" disabled={listBusy || actionBusy !== null} className={styles.button}
                onClick={() => { setBeliefStatus(row, 'active') }}>
                {t('beliefRestore')}
              </button>
            )}
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
          <span className={`${styles.roomSwatch} ${roomClass(kind)}`} aria-hidden="true" />
          <span>{kindLabel(t, kind)}</span>
          <b className={styles.roomCount}>{byKind[kind] ?? 0}</b>
        </div>
      ))}
    </div>
  )
}

/** 宫殿遥测：最近 7 天 op_log 聚合（写 / 摄取 / 整理 / 闭环等计数）。 */

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

/** Durable jobs 的只读投影；payload 不进面板，避免把实现细节/大对象拖进 UI。 */
interface JobSummaryView {
  readonly id: string
  readonly kind: string
  readonly status: 'queued' | 'running' | 'done' | 'dead'
  readonly attempts: number
  readonly maxAttempts: number
  readonly lastError: string | null
}

interface JobsView {
  readonly available: boolean
  readonly summary: { readonly total: number; readonly queued: number; readonly running: number; readonly done: number; readonly dead: number }
  readonly items: readonly JobSummaryView[]
}

/** 治理待办只取计数；完整双侧队列仍在治理工作面展示。 */
interface GovernanceSummaryView {
  readonly items: readonly unknown[]
  readonly total: number
}

/**
 * 控制台待办：jobs 是插件级队列；governance 跟随当前 scope。
 * 分开拉取，任一失败不拖倒另一个事实源。
 */
/**
 * 后端尚未提供该路由（插件进程比客户端旧）：这是版本偏斜，不是数据错误。
 * 面板要如实说「不可用」，而不是把 unknown route 当成故障甩给人看。
 */
function isMissingRoute(reason: unknown): boolean {
  const message = reason instanceof Error ? reason.message : String(reason)
  return message.includes('unknown route') || message.includes('HTTP 404')
}

/**
 * 控制台待办：jobs 是插件级队列；governance 跟随当前 scope。
 * 两个事实源分开取，任一缺失都不拖倒另一个。
 */
function useConsoleAttention(scope: 'user' | 'project' | 'shared', project: string | null, reloadTick = 0): {
  jobs: JobsView | null
  /** 后端没有作业队列路由（进程版本落后）：显示「不可用」而不是失败。 */
  jobsUnavailable: boolean
  governanceTotal: number | null
  failed: string | null
} {
  const [state, setState] = useState<{
    jobs: JobsView | null
    jobsUnavailable: boolean
    governanceTotal: number | null
    failed: string | null
  }>({
    jobs: null, jobsUnavailable: false, governanceTotal: null, failed: null,
  })
  // biome-ignore lint/correctness/useExhaustiveDependencies: project 只作重载信号——实际选择器由 api() 在渲染期注入，scope=project 命中不同分库时需重新取数
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [jobsResult, governanceResult] = await Promise.allSettled([
        api<JobsView>('jobs?limit=20'),
        api<GovernanceSummaryView>(`governance?scope=${scope}&limit=50`),
      ])
      if (cancelled) return
      const jobs = jobsResult.status === 'fulfilled' ? jobsResult.value : null
      const jobsUnavailable = jobsResult.status === 'rejected' && isMissingRoute(jobsResult.reason)
      const governanceTotal = governanceResult.status === 'fulfilled' ? governanceResult.value.total : null
      const failure = jobsResult.status === 'rejected' && !jobsUnavailable
        ? jobsResult.reason
        : governanceResult.status === 'rejected' ? governanceResult.reason : null
      setState({
        jobs,
        jobsUnavailable,
        governanceTotal,
        failed: failure === null ? null : failure instanceof Error ? failure.message : String(failure),
      })
    })()
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

const ATTENTION_TONE_CLASS = {
  neutral: '',
  warn: 'attention_warn',
  error: 'attention_error',
} as const

function TodayHero({ t, overview, dueCount, attention }: {
  t: T
  overview: ReturnType<typeof usePalaceOverview>
  dueCount: number
  attention: ReturnType<typeof useConsoleAttention>
}): React.ReactElement {
  const { stats, telemetry, health, failed } = overview
  if (failed !== null) {
    return <section className={styles.panelCard}><div className={styles.expandLoading}>{t('teleFailed')}：{failed}</div></section>
  }
  if (telemetry === null) {
    return <section className={styles.panelCard}><div className={styles.expandLoading}>{t('teleLoading')}</div></section>
  }
  const counts = telemetry.counts
  // 只有真实日序列才画 sparkline；0.13 起不再用合成曲线冒充趋势。
  const sparkWrites = (telemetry.dailyWrites ?? []).slice(-30).map(d => d.count)
  const exposures = counts.searchExposures ?? 0
  const answered = counts.reviewAnswers
  const jobs = attention.jobs
  const attentionItems = [
    ...(attention.governanceTotal !== null && attention.governanceTotal > 0
      ? [{ id: 'governance', label: t('attentionGovernance', { n: attention.governanceTotal }), tone: 'warn' as const }]
      : []),
    ...(jobs !== null && jobs.summary.dead > 0
      ? [{ id: 'jobs-dead', label: t('attentionJobsDead', { n: jobs.summary.dead }), tone: 'error' as const }]
      : []),
    ...(jobs !== null && jobs.summary.queued > 0
      ? [{ id: 'jobs-queued', label: t('attentionJobsQueued', { n: jobs.summary.queued }), tone: 'neutral' as const }]
      : []),
  ]
  return (
    <section className={styles.panelCard}>
      <div className={styles.hero}>
        <div className={styles.heroMetrics}>
          <Metric label={t('kpiTotal')} value={stats?.total ?? 0}
            spark={sparkWrites} color="var(--room-episode)"
            delta={t('heroDelta7d', { n: counts.writes })} deltaTone={counts.writes > 0 ? 'up' : 'flat'} />
          <Metric label={t('kpiActive')} value={stats?.active ?? 0}
            delta={t('heroDeltaForgotten', { n: stats?.forgotten ?? 0 })} deltaTone="flat" />
          <Metric label={t('kpiSignal')} value={`${String(Math.round((stats?.signalRatio ?? 0) * 100))}%`}
            delta={t('heroDeltaRedacted', { n: stats?.redacted ?? 0 })} deltaTone="flat" />
          <Metric label={t('kpiDue')} value={dueCount}
            tone={dueCount > 0 ? 'error' : undefined}
            delta={answered > 0 ? t('heroDeltaAnswered', { n: answered }) : t('heroDeltaUnanswered')}
            deltaTone={answered > 0 ? 'up' : 'flat'} />
        </div>
        <div className={styles.ringCard}>
          <HealthRing score={health?.overall ?? 0} label={t('healthLabel')} />
        </div>
      </div>
      <div className={styles.attentionStrip} role="status">
        {attention.failed !== null && <span>{t('attentionFailed')}: {attention.failed}</span>}
        {attention.failed === null && attentionItems.length === 0 && !attention.jobsUnavailable && <span>{t('attentionEmpty')}</span>}
        {attentionItems.map(item => (
          <span key={item.id} className={`${styles.attentionItem} ${styles[ATTENTION_TONE_CLASS[item.tone]]}`}>{item.label}</span>
        ))}
        {(attention.jobsUnavailable || (jobs !== null && !jobs.available))
          && <span className={styles.attentionItem}>{t('attentionJobsUnavailable')}</span>}
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
          <span className={styles.heroStat}>
            <span className={styles.heroStatLabel}>{t('kpiExposures')}</span>
            <span className={styles.heroStatValue}>{exposures}</span>
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

/** 宿主已注册的 provider 与模型清单（GET /api/engram/models）。 */

/** 历史回填任务状态（GET /api/engram/history-backfill/status）。 */

/** 跳过原因（摄取管线的英文枚举）→ 词典键。 */

/** 跳过原因的本地化标签（未知枚举回退原值）。 */

/**
 * 历史回填：导入规则由用户选择（时间窗 / 轮数上限 / 三类会话过滤），
 * 先估算（零成本）再执行；运行中每 1.5 秒轮询进度，可暂停续做。
 */

/** Модель в подсказках поля (из настроек провайдера). */

/** Провайдер DSH с шаблоном адреса System One и моделями из своих настроек. */

/** Jev panel view (response body of GET/POST /api/engram/jev-config). The provider and its key live in DSH; nothing secret is echoed here. */

/**
 * Замер связи Jev: то, что печатает строка состояния под переключателем.
 *
 * Хранится у человека (localStorage), а не в процессе сервера: «когда проверяли и чем
 * кончилось» — это наблюдение панели, и после перезапуска DSH оно остаётся правдой,
 * пока не устареет по времени. Поэтому в записи лежат и параметры замера: строка
 * говорит, чем мерили, а не чем померили бы сейчас.
 */

/** Разбор сохранённого замера: битое значение — «не проверялось», а не падение панели. */

/** Хост из адреса: строка состояния печатает «куда проверяли», а не URL с путём. */

/**
 * Jev verdict configuration: the panel only chooses which provider and model do the adjudicating,
 * plus the timeout. The provider list, the endpoint template and the API key all come from the host —
 * the key never reaches this panel and is never stored by the plugin, so there is exactly one place
 * in DSH where providers and tokens are configured. The endpoint field is pre-filled from the chosen
 * provider's template but stays editable, and the model field accepts any name (the "load models"
 * button asks the provider for its live list and offers it as suggestions).
 */

/** 近期裁决观测行视图（GET /api/engram/jev-observations 的 items 元素）。 */

/** verdict → 徽标文案键（动态模板字符串在 EngramKey union 下不可静态检查，改用映射表）。 */

/**
 * 近期裁决观测：轮询 /api/engram/jev-observations（1.5s），展示判定结果 / Jev 是否给出答案 /
 * 耗时 / 回落原因，帮助排查「这条为什么被搁置」。数据只存进程内存，重启清空。
 */

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

/** Одна база дворца в ответе `registry` (host 侧 BaseView). */

/** GET /api/engram/registry 的返回（host 侧 RegistryView，字段名与响应一一对应）。 */

/**
 * Языки дворца, которые можно выбрать: приходят с сервера (`GET registry`).
 *
 * Своего списка в клиенте нет намеренно. Раньше здесь лежала копия тройки
 * `zh|en|ru`, и язык, добавленный файлом `registry/languages.json`, появлялся на
 * сервере, но не в списке выбора — то есть «язык как данные» не доходил до человека.
 */

/**
 * Код языка по форме: две-три латинские буквы, при желании с подтегами (`zh-Hans`).
 *
 * Повторяет проверку сервера (`i18n/language.ts`, `isLanguageCode`). Нужен здесь
 * для одного случая — четвёртый выбор передаёт локаль машины как есть (`fr`), и
 * отправлять на сервер строку, которую он заведомо отвергнет, незачем.
 */

/**
 * Окно предохранителя до ответа сервера, секунды.
 *
 * Рабочее значение — настройка `palaceChangeWindowSec`: она приходит в снимке
 * обслуживания, и по ней же считает сервер. Это число нужно только для первой
 * отрисовки окна проверки, пока снимок не пришёл, — и совпадает с умолчанием настройки.
 */

/**
 * Состояние базы → ключ文案: динамическая строка под union `EngramKey` статически
 * не проверяется, поэтому таблица, а не шаблон. Состояния приходят с сервера теми
 * же именами, что в `registry/base-state.ts`.
 */

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

/**
 * Блок «Язык дворца и базы»: состояние памяти (язык, модель, каждая база) и действия
 * над ним — сменить язык, починить векторы.
 *
 * Отдельная карточка, а не половина одной общей: таблицы моделей и баз живут в широкой
 * колонке, словари — в узкой. Снимок обслуживания приходит сверху, общий.
 */

/**
 * Блок «Язык Плагина»: язык самой панели, её словари и заведение нового.
 */

/**
 * Вкладка «Обслуживание»: четыре инструмента на двух колонках — как на главной.
 *
 * Слева (широкая колонка) то, чему нужна ширина: язык дворца с таблицами моделей и баз
 * и догрузка истории. Справа (узкая, липкая) то, что помещается: словари панели и裁决.
 * Снимок обслуживания один на обе карточки — читать его дважды незачем.
 */

/** Наборы словаря: имена те же, что на сервере (см. src/i18n/dictionary-terms.ts). */

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

/** Строка таблицы правки (ответ GET /api/engram/dictionary). */

/**
 * Сверка программы с файлом (считает сервер при каждом открытии словаря).
 *
 * `program` и `file` — две независимые величины: ключи в коде и строки в файле.
 * Совпадение чисел ничего не доказывает, поэтому рядом стоят находки — ключ без
 * перевода и строка без ключа.
 */

/** Набор словаря, каким его видит таблица: термины, слои файлов, претензии разбора и сверка. */

/**
 * Счётчик одного набора в блоке «Язык Плагина»: набор, ключ его названия и то, что
 * прочитано с диска. Отдельный вид, потому что название берётся из словаря панели, а
 * не приходит с сервера: сервер знает имена наборов, а не их подписи.
 */

/**
 * Сколько строк набора заполнено: правая клетка непустая.
 *
 * Пустая клетка — не «пустой перевод», а «правки нет»: тогда показывается текст
 * поставки или вшитый набор. Поэтому «заполнено» — это ровно те строки, у которых
 * перевод есть, и сравнивать их надо с числом терминов набора.
 */

/**
 * Ответ POST dictionary: куда легли правки и как набор выглядит после записи.
 * Представление приходит тем же ответом — таблица обязана показывать записанное.
 */

/** Ответ POST dictionary-fill: переводы партии и маршрут, который отвечал. */

/**
 * Строка таблицы правки: английский термин слева, клетка перевода справа.
 *
 * memo — не украшение: терминов больше четырёхсот, и без него правка одной клетки
 * перерисовывала бы весь список. Сравниваются только значение и признак правки.
 */

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
/** 注入回放列表行（host `/injections` 的 head-only 结构）。 */
interface InjectionSnapshotHeadView {
  readonly id: string
  readonly sessionId: string
  readonly packetHash: string
  readonly memoryIds: readonly string[]
  readonly hasCurated: boolean
  readonly compactionCount: number
  readonly packetBytes: number
  readonly createdAt: number
}

/** 注入回放详情（host `/injection` 按 id 返回完整 packet）。 */
interface InjectionSnapshotView extends InjectionSnapshotHeadView {
  readonly packet: string
}

/** 包大小用人类可读单位；审计字段保持原始字节数，不在此换算后冒充精确值。 */
function replayBytes(n: number): string {
  if (n < 1024) return `${String(n)} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`
}

/** 截短哈希用于列表识别；完整哈希在详情里展示，避免列表行横向溢出。 */
function replayHashShort(hash: string): string {
  return hash.length <= 12 ? hash : `${hash.slice(0, 12)}…`
}

/**
 * 上下文回放工作面（0.12.0）：列表只取 head，正文按 id 按需读取。
 * 事实源是 `injection_snapshots.packet`；这里不做“相似重建”，避免回放 UI 与模型所见分叉。
 */
function ContextReplayView({ t, scope, reloadTick }: {
  readonly t: T
  readonly scope: 'user' | 'project' | 'shared'
  readonly reloadTick: number
}): React.ReactElement {
  const [session, setSession] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<InjectionSnapshotView | null>(null)
  const [detailFailed, setDetailFailed] = useState<string | null>(null)
  const query = session.trim()
  const listPath = query === ''
    ? `injections?scope=${scope}&limit=50&tick=${String(reloadTick)}`
    : `injections?scope=${scope}&sessionId=${encodeURIComponent(query)}&limit=50&tick=${String(reloadTick)}`
  const { data, failed } = useApi<{ items: readonly InjectionSnapshotHeadView[] }>(listPath)
  const items = data?.items ?? []

  useEffect(() => {
    if (selected === null) {
      setDetail(null)
      setDetailFailed(null)
      return
    }
    let cancelled = false
    api<InjectionSnapshotView>(`injection?scope=${scope}&id=${encodeURIComponent(selected)}`)
      .then((packetDetail) => { if (!cancelled) { setDetail(packetDetail); setDetailFailed(null) } })
      .catch((loadError: unknown) => {
        if (!cancelled) setDetailFailed(loadError instanceof Error ? loadError.message : String(loadError))
      })
    return () => { cancelled = true }
  }, [selected, scope])

  return (
    <div className={styles.tabPanel}>
      <PageHeader title={t('workfaceReplay')} subtitle={t('pageHeaderReplaySubtitle')} />
      <div className={styles.toolbarCard}>
        <label className={styles.toolbarRow}>
          <span className={styles.fieldLabel}>{t('replayFilterLabel')}</span>
          <input className={`${styles.input} ${styles.search}`} placeholder={t('replayFilterPlaceholder')}
            value={session} onChange={(event) => { setSession(event.target.value); setSelected(null) }} />
        </label>
        <span className={styles.toolbarCount}>{t('replayCount', { n: items.length })}</span>
      </div>

      {failed !== null && <div className={styles.empty}>{t('replayFailed')}</div>}
      {failed === null && items.length === 0 && <EmptyState title={t('replayEmpty')} />}

      <div className={styles.replayList}>
        {items.map(item => {
          const open = selected === item.id
          return (
            <article key={item.id} className={open ? `${styles.replayCard} ${styles.on}` : styles.replayCard}>
              <header className={styles.replayHead}>
                <div className={styles.replayTitle}>
                  <strong>{fmtTime(item.createdAt)}</strong>
                  <span>{item.sessionId}</span>
                </div>
                <div className={styles.replayBadges}>
                  <span>{replayBytes(item.packetBytes)}</span>
                  <span>{replayHashShort(item.packetHash)}</span>
                  {item.hasCurated && <span>{t('replayCurated')}</span>}
                </div>
              </header>
              <div className={styles.replayMeta}>
                <span>{t('replayMemories')}: {String(item.memoryIds.length)}</span>
                <span>{t('replayCompactions')}: {String(item.compactionCount)}</span>
              </div>
              <button type="button" className={styles.button} aria-expanded={open}
                onClick={() => { setSelected(current => current === item.id ? null : item.id) }}>
                {open ? t('replayClose') : t('replayOpen')}
              </button>

              {open && (
                <section className={styles.replayDetail} aria-live="polite">
                  <h4>{t('replayMetaTitle')}</h4>
                  {detailFailed !== null && <p>{detailFailed}</p>}
                  {detailFailed === null && detail === null && <p>{t('loading')}</p>}
                  {detail !== null && (
                    <>
                      <dl className={styles.replayMetaGrid}>
                        <dt>{t('replaySession')}</dt><dd>{detail.sessionId}</dd>
                        <dt>{t('replayHash')}</dt><dd className={styles.replayHash}>{detail.packetHash}</dd>
                        <dt>{t('replaySize')}</dt><dd>{replayBytes(detail.packetBytes)}</dd>
                        <dt>{t('replayMemories')}</dt>
                        <dd>
                          {detail.memoryIds.length === 0 ? '—' : detail.memoryIds.map(id => (
                            <code key={id}>{id}</code>
                          ))}
                        </dd>
                      </dl>
                      <h4>{t('replayPacketTitle')}</h4>
                      <pre className={styles.replayPacket}>{detail.packet}</pre>
                      <p className={styles.replayNote}>{t('replayExactNote')}</p>
                    </>
                  )}
                </section>
              )}
            </article>
          )
        })}
      </div>
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
  /** 0.13：Records 面板的一次性过滤请求（角标「今日到期」/Atlas 房间跳转）。 */
  const [recordsRequest, setRecordsRequest] = useState<RecordsRequest>(null)
  /** 今日到期条数与 id 集合（Header 角标 + 陈展「今日到期」筛选共用同一次拉取）。 */
  const [dueCount, setDueCount] = useState(0)
  const [dueIds, setDueIds] = useState<ReadonlySet<string>>(new Set())
  /** 行内展开态：互斥的唯一展开条目（review 或 edit）。浮层由 .drawerLayer sticky 钉在滚动区可见顶部，无需滚动定位。 */
  const [expanded, setExpanded] = useState<{ kind: 'review' | 'edit'; record: MemoryRow } | null>(null)
  const [reloadTick, setReloadTick] = useState(0)
  /** 0.13 工作面：today 总览 / recall 召回 / memory 记忆 / governance 治理 / replay 回放 / system 系统。 */
  const [activeWorkface, setActiveWorkface] = useState<Workface>('today')
  /** 工作面内的二级视图：每个工作面有自己的二级导航，不把所有能力抬到一级。 */
  const [memoryTab, setMemoryTab] = useState<'records' | 'timeline' | 'entities' | 'atlas'>('records')
  const [governanceTab, setGovernanceTab] = useState<'conflicts' | 'beliefs'>('conflicts')
  const [systemTab, setSystemTab] = useState<SystemSection>('runtime')
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
  /** 控制台待办：jobs/governance 独立事实源，Today 与后续治理面共用。 */
  const attention = useConsoleAttention(scope, projectSelector, reloadTick)

  /** 失效选择器的自愈：同一轮只触发一次，回到 follow 后复位（见 api() 的 404 分支）。 */
  const healingRef = useRef(false)
  useEffect(() => {
    setProjectHealHandler((): void => {
      // 只在「固定到某个已失效分库」时自愈；跟随态 404 说明 host 清单与分库不一致，回退只会抖动。
      if (healingRef.current || projectMode === 'follow') return
      healingRef.current = true
      setProjectMode('follow')
      setExpanded(null)
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

  /** 角标点击：切到记忆工作面的条目列表并启用「今日到期」筛选（复习调度的消费者是 agent，面板只做观测）。 */
  const goToDue = (): void => {
    setActiveWorkface('memory')
    setMemoryTab('records')
    setRecordsRequest({ kind: 'due' })
  }

  /** 打开详情抽屉：只有 id 时用最小占位行（抽屉自行拉 review 补齐正文与关系）。 */
  const openReview = useCallback((id: string): void => {
    setExpanded({
      kind: 'review',
      record: {
        id: id as never, scope, kind: 'fact', content: '', importance: 0.5, confidence: 0.5,
        status: 'active', createdAt: Date.now(), accessCount: 0, sourceSessionId: null, sourceRound: null,
      } as MemoryRow,
    })
  }, [scope])

  /** 行内展开（review / edit）：抽屉层留在面板根部，行内点击只切内容。 */
  const toggleRecord = useCallback((record: MemoryRow, kind: 'review' | 'edit'): void => {
    setExpanded(current => (current !== null && current.kind === kind && current.record.id === record.id)
      ? null
      : { kind, record })
  }, [])

  /** Records 面板已消费请求（清空宿主侧的一次性请求，避免重复应用）。 */
  const clearRecordsRequest = useCallback((): void => { setRecordsRequest(null) }, [])

  /** 项目宫殿切换（工作区切换 / 手动固定）：回到第 1 页并清掉跨库无意义的展开与选择态。 */
  const lastProject = useRef(projectSelector)
  useEffect(() => {
    if (lastProject.current === projectSelector) return
    lastProject.current = projectSelector
    setExpanded(null)
  }, [projectSelector])

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

  // 0.13 console shell: six stable workfaces, each with its own secondary navigation.
  const workfaceItems = [
    { id: 'today' as Workface, label: t('workfaceToday'), icon: <Icon name="today" /> },
    { id: 'recall' as Workface, label: t('workfaceRecall'), icon: <Icon name="search" /> },
    { id: 'memory' as Workface, label: t('workfaceMemory'), icon: <Icon name="library" /> },
    { id: 'governance' as Workface, label: t('workfaceGovernance'), icon: <Icon name="shield" /> },
    { id: 'replay' as Workface, label: t('workfaceReplay'), icon: <Icon name="replay" /> },
    { id: 'system' as Workface, label: t('workfaceSystem'), icon: <Icon name="gear" /> },
  ]
  const changeWorkface = (workface: Workface): void => {
    setActiveWorkface(workface)
    setExpanded(null)
  }
  /** 二级导航：只有多视图的工作面才有；其余工作面自带标题与工具条。 */
  const memoryContextItems = [
    { id: 'records' as const, label: t('memoryRecords') },
    { id: 'timeline' as const, label: t('memoryTimeline') },
    { id: 'entities' as const, label: t('memoryEntities') },
    { id: 'atlas' as const, label: t('memoryAtlas') },
  ]
  const governanceContextItems = [
    { id: 'conflicts' as const, label: t('governanceConflicts') },
    { id: 'beliefs' as const, label: t('governanceBeliefs') },
  ]
  const systemContextItems = [
    { id: 'runtime' as const, label: t('systemRuntime') },
    { id: 'storage' as const, label: t('systemStorage') },
    { id: 'models' as const, label: t('systemModels') },
    { id: 'backfill' as const, label: t('tabBackfill') },
    { id: 'jev' as const, label: t('tabJev') },
    { id: 'logs' as const, label: t('tabLog') },
  ]
  // 状态条只报「需要人知道的事」：作用域由 Header 三宫格表达，不在这里重复。
  const statusItems = [
    ...(projectMode === 'project' && projectSelector !== null
      ? [{ id: 'project', label: projectSelector, level: 'neutral' as const }]
      : []),
    ...(versionMismatch !== null
      ? [{ id: 'version', label: t('versionMismatch', { client: CLIENT_VERSION, server: versionMismatch }), level: 'warn' as const }]
      : []),
  ]

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
                onClick={() => { setScope(option); setExpanded(null) }}>
                <Icon name={option === 'user' ? 'user' : option === 'project' ? 'project' : 'shared'} className={styles.scopeIcon} />
                {t(SCOPE_KEY[option])}
              </button>
            ))}
          </div>
          {/* 项目宫殿工作区下拉：紧贴三宫格同行（仅 project 作用域），替代旧版独占一行的 chip + 下拉 */}
          {scope === 'project' && (
            <SelectField selectClassName={`${styles.input} ${styles.wsSelect}`} value={projectMode}
              ariaLabel={t('projectSwitch')} title={t('projectSwitch')}
              onChange={event => { setProjectMode(event.target.value); setExpanded(null) }}>
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

      </div>

      {/* 0.13 console shell: workface rail + per-workface secondary navigation. */}
      <div className={shellStyles.console}>
        <WorkfaceRail label={t('navWorkfaces')} active={activeWorkface}
          items={workfaceItems} onChange={changeWorkface} />
        <div className={shellStyles.consoleBody}>
          <StatusStrip items={statusItems} />
          {activeWorkface === 'memory' && (
            <ContextNav label={t('workfaceMemory')} active={memoryTab}
              items={memoryContextItems} onChange={setMemoryTab} />
          )}
          {activeWorkface === 'governance' && (
            <ContextNav label={t('workfaceGovernance')} active={governanceTab}
              items={governanceContextItems} onChange={setGovernanceTab} />
          )}
          {activeWorkface === 'system' && (
            <ContextNav label={t('workfaceSystem')} active={systemTab}
              items={systemContextItems} onChange={setSystemTab} />
          )}
          {/* Тело вкладки: единственная прокручиваемая область панели. Меню выше в прокрутке
              не участвует, поэтому содержимое физически не может оказаться над ним. */}
          <div className={styles.panelBody}>
      <ViewErrorBoundary key={`${activeWorkface}:${memoryTab}:${governanceTab}:${systemTab}`} retryLabel={t('retry')} hintLabel={t('viewCrashed')}>
      {activeWorkface === 'memory' && memoryTab === 'records' && (
        <div className={styles.tabPanel}>
          <PageHeader title={t('workfaceMemory')} subtitle={t('pageHeaderLibrarySubtitle')} />
          <RecordsPanel t={t} scope={scope} project={projectSelector} reloadTick={reloadTick}
            dueIds={dueIds} onToggle={toggleRecord} onChanged={reload} toast={toast}
            request={recordsRequest} onRequestApplied={clearRecordsRequest} />
        </div>
      )}

      {activeWorkface === 'today' && (
        <div className={styles.tabPanel}>
          <PageHeader title={t('tabToday')} subtitle={t('pageHeaderTodaySubtitle')} />
          {/* 今日速览：主指标 + 健康环，替代原常驻日报条。 */}
          <TodayHero t={t} overview={overview} dueCount={dueCount} attention={attention} />
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
              {/* 版本卡：包名/版本/作者/仓库/npm/许可证自述；版本与握手横幅同源。 */}
              <section className={styles.section}>
                <div className={styles.panelCard}>
                  <PluginCard t={t} />
                </div>
              </section>
              {/* 更多作品：同作者两个配套插件的外链广告位（与 usage-billing 面板互为镜像）。 */}
              <section className={styles.section}>
                <div className={styles.sectionHead}>
                  <h4 className={styles.sectionTitle}>{t('moreWorksTitle')}</h4>
                </div>
                <div className={styles.panelCard}>
                  <MoreWorksCard t={t} />
                </div>
              </section>
            </aside>
          </div>
        </div>
      )}

      {activeWorkface === 'memory' && memoryTab === 'atlas' && (
        <div className={styles.tabPanel}>
          <PageHeader title={t('workfaceMemory')} subtitle={t('pageHeaderCorridorSubtitle')} />
          {/* Atlas：结构鸟瞰与时间螺旋同属「可视化」——它们是记忆库里的模块，不是导航语言。 */}
          <div className={styles.mainCol}>
            <section className={styles.section}>
              <div className={styles.sectionHead}>
                <h4 className={styles.sectionTitle}>{t('sectionCorridor')}</h4>
              </div>
              <div className={styles.panelCard}>
                <CorridorPanel t={t} scope={scope} project={projectSelector} onSelect={openReview}
                  onOpenRoom={kind => { setRecordsRequest({ kind: 'room', value: kind }); setMemoryTab('records') }} />
              </div>
            </section>
            <section className={styles.section}>
              <div className={styles.panelCard}>
                <SpiralPanel t={t} scope={scope} project={projectSelector} reloadTick={reloadTick} />
              </div>
            </section>
          </div>
        </div>
      )}

      {activeWorkface === 'recall' && (
        <div className={styles.tabPanel}>
          <PageHeader title={t('workfaceRecall')} subtitle={t('pageHeaderRecallSubtitle')} />
          <section className={styles.section}>
            <RecallView t={t} scope={scope} onSelect={openReview} />
          </section>
        </div>
      )}

      {activeWorkface === 'governance' && governanceTab === 'conflicts' && (
        <div className={styles.tabPanel}>
          <PageHeader title={t('workfaceGovernance')} subtitle={t('pageHeaderGovernanceSubtitle')} />
          <section className={styles.section}>
            <GovernanceView t={t} scope={scope} reloadTick={reloadTick} onChanged={reload} />
          </section>
        </div>
      )}

      {activeWorkface === 'replay' && <ContextReplayView t={t} scope={scope} reloadTick={reloadTick} />}

      {activeWorkface === 'memory' && memoryTab === 'timeline' && (
        <div className={styles.tabPanel}>
          <PageHeader title={t('workfaceMemory')} subtitle={t('pageHeaderEpisodesSubtitle')} />
          <section className={styles.section}>
            <EpisodeTimelineView t={t} scope={scope} project={projectSelector} reloadTick={reloadTick} />
          </section>
        </div>
      )}

      {activeWorkface === 'memory' && memoryTab === 'entities' && (
        <div className={styles.tabPanel}>
          <PageHeader title={t('workfaceMemory')} subtitle={t('pageHeaderEntitiesSubtitle')} />
          <section className={styles.section}>
            <EntityView t={t} scope={scope} project={projectSelector} reloadTick={reloadTick} />
          </section>
        </div>
      )}

      {activeWorkface === 'governance' && governanceTab === 'beliefs' && (
        <div className={styles.tabPanel}>
          <PageHeader title={t('workfaceGovernance')} subtitle={t('pageHeaderBeliefsSubtitle')} />
          <section className={styles.section}>
            <BeliefsView t={t} scope={scope} project={projectSelector} reloadTick={reloadTick} toast={toast} />
          </section>
        </div>
      )}

      {activeWorkface === 'system' && (
        <div className={styles.tabPanel}>
          <PageHeader title={t('workfaceSystem')} subtitle={t('pageHeaderSystemSubtitle')} />
          <SystemView t={t} section={systemTab} overlayHost={overlayHost} lang={lang} toast={toast}
            onTestPanel={() => { setPanelTest(true) }} telemetry={overview.telemetry}
            reloadTick={reloadTick} onCleared={reload} />
        </div>
      )}
    </ViewErrorBoundary>
          </div>
        </div>
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
