import type { ReactElement } from 'react'
import styles from './shell.module.css'

export type StatusLevel = 'ok' | 'warn' | 'error' | 'neutral'

export interface StatusItem {
  readonly id: string
  readonly label: string
  readonly level?: StatusLevel
  readonly title?: string
}

interface StatusStripProps {
  readonly items: readonly StatusItem[]
}

export function StatusStrip({ items }: StatusStripProps): ReactElement {
  if (items.length === 0) return <div className={styles.statusStrip} aria-hidden="true" />
  return (
    <div className={styles.statusStrip}>
      {items.map(item => (
        <span key={item.id} className={styles.statusItem} title={item.title}>
          <span className={`${styles.statusDot} ${styles[item.level ?? 'neutral']}`} aria-hidden="true" />
          {item.label}
        </span>
      ))}
    </div>
  )
}
