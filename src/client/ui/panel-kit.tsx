/**
 * 面板共用件：翻译签名、kind 标签、房间色相、select 包装与空态。
 * 独立成模块的理由：EngramPanel 与 views/* 都要用它们，而 client 半按 CJS 闭包工厂打包，
 * 视图回引 EngramPanel 会形成循环依赖（闭包产物里表现为「用到时还是 undefined」）。
 * @module @kenz1117/dsh-engram/client/ui/panel-kit
 */

import type { ReactElement, ReactNode } from 'react'
import styles from '../panel.module.css'
import { KIND_KEY, type EngramKey } from '../locales/index.ts'

/** 面板内翻译函数签名（宿主 locale 席位渲染器的窄化视图）。 */
export type T = (key: EngramKey, params?: Record<string, unknown>) => string

/** 记忆种类枚举（数据层英文值，显示层走词典）。 */
export const KINDS = ['fact', 'preference', 'decision', 'episode', 'skill'] as const

/** 房间色相类（panel.module.css 的 .roomFact 等）；未知 kind 回退通用的 .kind。 */
const ROOM_CLASS: Record<string, string> = {
  fact: 'roomFact',
  preference: 'roomPreference',
  decision: 'roomDecision',
  episode: 'roomEpisode',
  skill: 'roomSkill',
}

/** kind 数据值 → 本地化标签（未知值回退原文）。 */
export function kindLabel(t: T, kind: string): string {
  const key = KIND_KEY[kind]
  return key === undefined ? kind : t(key)
}

/** 房间 pill 的类名：按 kind 取色相类，未知 kind 回退通用品牌色。 */
export function roomPillClass(kind: string): string {
  return `${styles.pill} ${styles[ROOM_CLASS[kind] ?? 'kind'] ?? ''}`
}

/** 房间色相类名（图表节点等需要直接取类名时使用）。 */
export function roomClass(kind: string): string {
  return styles[ROOM_CLASS[kind] ?? ''] ?? ''
}

/** 统一的 <select> 包装：内联 SVG 箭头 + focus-within 时变品牌色。 */
export function SelectField({ selectClassName, value, onChange, children, ariaLabel, title }: {
  readonly selectClassName: string | undefined
  readonly value: string
  readonly onChange: (event: React.ChangeEvent<HTMLSelectElement>) => void
  readonly children: ReactNode
  readonly ariaLabel?: string | undefined
  readonly title?: string | undefined
}): ReactElement {
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

/** 空态插画：宫殿剪影 + 标题 + 提示。 */
export function EmptyState({ title, hint }: { title: string; hint?: string | undefined }): ReactElement {
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

/** 页面头部：标题 + 副标题 + actions。满宽主列需要页面身份感（工作面不再只靠 tab 行认路）。 */
export function PageHeader({ title, subtitle, actions }: {
  title: string
  subtitle?: string | undefined
  actions?: ReactNode | undefined
}): ReactElement {
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
