/**
 * Memory Spiral · 回忆螺旋（v0.9.x 视觉升级 · 落地自 prototypes/visual-upgrade.html #spiral）。
 * 时间型鸟瞰：全部记忆按时间排成对数螺旋，中心 = 现在，越外越旧。
 * 半径 = log(1 + 天数差)，色相 = kind，亮度 = importance × confidence。
 *
 * 设计要点：
 * - viewBox 锁 600×380 的稳定坐标系，让重渲不抖动；外层 div 用 100% + aspect-ratio 自适应。
 * - 节点定位在 effect 里一次算好，避免每次 render 重排。
 * - hover 仅靠 SVG <title>，零 JS —— 与 CorridorMap 同款「零悬停状态管理」约定。
 * - 中心「现在」用品牌渐变 ring + 小实心圆，强调时间锚点。
 *
 * 该组件**不直接拉数据**——父组件负责 fetch + 错误态，传 records 进来。
 * 这样 SpiralMap 保持纯渲染，方便复用与测试，也避免在多个组件里复制 api() 闭包。
 * @module @kenz1117/dsh-engram/client/SpiralMap
 */

import { useMemo } from 'react'
import type { ReactElement } from 'react'
import { KIND_COLOR } from './CorridorMap.tsx'
import type { EngramKey } from './locales/index.ts'
import styles from './spiral.module.css'

/** 时间线端点返回的单条记忆（与 /api/engram/timeline 的 records 字段对齐）。
 *  客户端只取渲染需要的字段；服务端给得更多但我们用不到就忽略。 */
export interface SpiralRecord {
  readonly id: string
  readonly kind: string
  readonly content: string
  readonly importance: number
  readonly confidence: number
  readonly accessCount: number
  readonly createdAt: number
  readonly slot?: { readonly room: string; readonly index: number }
}

/** 面板级翻译函数（与 EngramPanel 内 makeT 同款）：用 EngramKey 联合保证拼写校验。 */
type T = (key: EngramKey, params?: Record<string, unknown>) => string

export interface SpiralMapProps {
  readonly t: T
  readonly records: readonly SpiralRecord[]
  /** 时间窗（毫秒）：null = 全部；正数 = 仅看最近 N 毫秒。 */
  readonly windowMs: number | null
}

/** 坐标系常量。viewBox 600×380 居中 (300,190)。 */
const VB_W = 600
const VB_H = 380
const CX = VB_W / 2
const CY = VB_H / 2
/** 最大半径（留给「中心 = 现在」标识圈和最外圈留白）。 */
const R_MAX = 150
/** 时间窗外的记忆径向截断到此半径（避免一条远古记忆把整图压扁）。 */
const R_CAP = R_MAX
/** 节点半径上下限。 */
const R_DOT_MIN = 2.2
const R_DOT_MAX = 7.5

/** 把天数差转成径向距离（对数尺度：log(1 + d) 让远近分层更明显）。 */
function daysToRadius(days: number): number {
  if (days <= 0) return 8
  const r = 10 + Math.log1p(days) * 14
  return Math.min(R_CAP, r)
}

/** 节点半径：访问频次为底，重要性 × 置信度为增益，避免太满。 */
function dotRadius(rec: SpiralRecord): number {
  const base = Math.sqrt(rec.accessCount + 1) * 1.2
  const boost = rec.importance * rec.confidence * 2.4
  return Math.min(R_DOT_MAX, Math.max(R_DOT_MIN, base + boost))
}

/** 节点不透明度：重要性 × 置信度，0.18 是最低可见度（暗色主题下不至于全黑）。 */
function dotOpacity(rec: SpiralRecord): number {
  return Math.max(0.18, Math.min(1, rec.importance * rec.confidence * 1.15 + 0.18))
}

/** SpiralMap：SVG 螺旋本体 + 节点 hover tooltip + 中心「现在」标识。 */
export function SpiralMap({ t, records, windowMs }: SpiralMapProps): ReactElement {
  const now = Date.now()
  const positioned = useMemo(() => {
    const filtered = windowMs === null
      ? records
      : records.filter(rec => now - rec.createdAt <= windowMs)
    // 按时间排序：最新在内圈 → theta 用 index 均匀散开（视觉上呈现螺旋臂）。
    const sorted = [...filtered].sort((a, b) => b.createdAt - a.createdAt)
    return sorted.map((rec, index) => {
      const days = (now - rec.createdAt) / 86_400_000
      const r = daysToRadius(days)
      // 总数 N 时把整圈 2π 等分；轻微黄金角偏移避免相邻节点堆叠。
      const theta = sorted.length === 0 ? 0 : (index / sorted.length) * 2 * Math.PI
      return {
        id: rec.id,
        x: CX + r * Math.cos(theta),
        y: CY + r * Math.sin(theta),
        radius: dotRadius(rec),
        opacity: dotOpacity(rec),
        kind: rec.kind,
        content: rec.content,
        createdAt: rec.createdAt,
        accessCount: rec.accessCount,
      }
    })
  }, [records, windowMs, now])

  return (
    <div className={styles.wrap}>
      <svg className={styles.canvas} viewBox={`0 0 ${String(VB_W)} ${String(VB_H)}`} role="img" aria-label={t('spiralAriaLabel')}>
        <defs>
          {/* 中心品牌渐变 ring：amber→rose，与面板 --brand-grad-line 同源。 */}
          <radialGradient id="spiralCenterGrad" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#F59E0B" />
            <stop offset="55%" stopColor="#FB923C" />
            <stop offset="100%" stopColor="#F43F5E" />
          </radialGradient>
        </defs>
        {/* 外圈装饰：最远记忆所在的圆，提示时间跨度极限（虚线 + 极淡）。 */}
        <circle cx={CX} cy={CY} r={R_MAX} fill="none" stroke="currentColor" strokeWidth={1} strokeDasharray="2 4" opacity={0.18} />
        {/* 中圈：30 天等距标记。 */}
        <circle cx={CX} cy={CY} r={daysToRadius(30)} fill="none" stroke="currentColor" strokeWidth={1} opacity={0.1} />
        {/* 中心「现在」：品牌渐变实心圆 + ring。 */}
        <circle cx={CX} cy={CY} r={14} fill="none" stroke="url(#spiralCenterGrad)" strokeWidth={2} opacity={0.5} />
        <circle cx={CX} cy={CY} r={6} fill="url(#spiralCenterGrad)" />
        <text x={CX} y={CY + 24} textAnchor="middle" className={styles.centerLabel}>{t('spiralCenterLabel')}</text>
        {/* 节点：每个记忆一个 <circle>，hover 弹 SVG <title>。 */}
        {positioned.map(node => (
          <circle key={node.id}
            cx={node.x} cy={node.y} r={node.radius}
            fill={KIND_COLOR[node.kind] ?? 'var(--dsw-alias-label-tertiary)'}
            opacity={node.opacity}>
            <title>{`${node.kind} · ${node.accessCount}× · ${formatDate(node.createdAt)}\n${truncate(node.content, 80)}`}</title>
          </circle>
        ))}
      </svg>
      <aside className={styles.side}>
        <h4 className={styles.sideTitle}>{t('spiralSideTitle')}</h4>
        <div className={styles.legend}>
          {Object.entries(KIND_COLOR).map(([kind, color]) => (
            <div key={kind} className={styles.legendItem}>
              <span className={styles.legendDot} style={{ background: color }} />
              <span>{kind}</span>
            </div>
          ))}
        </div>
        <div className={styles.stats}>
          <div className={styles.stat}>
            <div className={styles.statLabel}>{t('spiralStatEarliest')}</div>
            <div className={styles.statValue}>{formatDate(earliestAt(positioned) ?? now)}</div>
          </div>
          <div className={styles.stat}>
            <div className={styles.statLabel}>{t('spiralStatSpan')}</div>
            <div className={styles.statValue}>{formatSpan(spanDays(positioned, now))}</div>
          </div>
          <div className={styles.stat}>
            <div className={styles.statLabel}>{t('spiralStatCenter')}</div>
            <div className={`${styles.statValue} ${styles.statAccent}`}>{formatDate(now)}</div>
          </div>
          <div className={styles.stat}>
            <div className={styles.statLabel}>{t('spiralStatRadius')}</div>
            <div className={`${styles.statValue} ${styles.statFaint}`}>log(1 + 天数差)</div>
          </div>
          <div className={styles.stat}>
            <div className={styles.statLabel}>{t('spiralStatCount')}</div>
            <div className={styles.statValue}>{positioned.length}</div>
          </div>
        </div>
      </aside>
    </div>
  )
}

function earliestAt(nodes: readonly { createdAt: number }[]): number | null {
  if (nodes.length === 0) return null
  let min = Number.POSITIVE_INFINITY
  for (const node of nodes) { if (node.createdAt < min) min = node.createdAt }
  return min
}

function spanDays(nodes: readonly { createdAt: number }[], now: number): number {
  const earliest = earliestAt(nodes)
  if (earliest === null) return 0
  return Math.max(0, (now - earliest) / 86_400_000)
}

function formatDate(ms: number): string {
  const d = new Date(ms)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${String(yyyy)}-${mm}-${dd}`
}

function formatSpan(days: number): string {
  if (days < 1) return '<1d'
  if (days < 60) return `${Math.round(days)}d`
  if (days < 365) return `${(days / 30).toFixed(1)}mo`
  return `${(days / 365).toFixed(1)}y`
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}