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

export function StatusStrip({ items }: StatusStripProps): ReactElement | null {
  // 没有要报的事就不占一条：空条只会让人以为漏了东西。
  if (items.length === 0) return null
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
