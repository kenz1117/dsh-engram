import type { ReactElement } from 'react'
import styles from './ui.module.css'

interface DataStateProps {
  readonly title: string
  readonly hint?: string
  readonly retryLabel?: string
  readonly onRetry?: () => void
}

export function DataState({ title, hint, retryLabel, onRetry }: DataStateProps): ReactElement {
  return (
    <div className={styles.dataState}>
      <b>{title}</b>
      {hint !== undefined && <span>{hint}</span>}
      {onRetry !== undefined && retryLabel !== undefined && (
        <div className={styles.dataActions}>
          <button type="button" className={styles.segmentedItem} onClick={onRetry}>{retryLabel}</button>
        </div>
      )}
    </div>
  )
}
