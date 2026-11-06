import type { ReactElement } from 'react'
import styles from './ui.module.css'

interface IdentityBadgeProps {
  readonly memoryId: string
  readonly revisionId?: string
  readonly memoryLabel?: string
  readonly revisionLabel?: string
}

export function IdentityBadge({ memoryId, revisionId, memoryLabel, revisionLabel }: IdentityBadgeProps): ReactElement {
  return (
    <div className={styles.identity}>
      <code title={memoryId}>{memoryLabel === undefined ? memoryId : `${memoryLabel} ${memoryId}`}</code>
      {revisionId !== undefined && (
        <code title={revisionId}>{revisionLabel === undefined ? revisionId : `${revisionLabel} ${revisionId}`}</code>
      )}
    </div>
  )
}
