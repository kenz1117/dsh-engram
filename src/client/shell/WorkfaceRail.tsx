import type { ReactElement, ReactNode } from 'react'
import styles from './shell.module.css'

export type Workface = 'today' | 'recall' | 'memory' | 'governance' | 'replay' | 'system'

export interface WorkfaceItem {
  readonly id: Workface
  readonly label: string
  readonly icon?: ReactNode
  readonly badge?: number
}

interface WorkfaceRailProps {
  readonly label: string
  readonly active: Workface
  readonly items: readonly WorkfaceItem[]
  readonly onChange: (workface: Workface) => void
}

function onKeyDown(event: React.KeyboardEvent<HTMLElement>, active: Workface, items: readonly WorkfaceItem[], onChange: (id: Workface) => void): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  event.preventDefault()
  const ids = items.map(item => item.id)
  const index = ids.indexOf(active)
  if (index === -1) return
  const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1
  const next = items[(index + step + ids.length) % ids.length]
  if (next !== undefined) onChange(next.id)
}

export function WorkfaceRail({ label, active, items, onChange }: WorkfaceRailProps): ReactElement {
  return (
    <nav className={styles.rail} aria-label={label}
      onKeyDown={event => { onKeyDown(event, active, items, onChange) }}>
      <p className={styles.railLabel}>{label}</p>
      {items.map(item => (
        <button key={item.id} type="button" className={styles.railItem}
          aria-current={item.id === active} onClick={() => { onChange(item.id) }}>
          {item.icon}
          <span>{item.label}</span>
          {item.badge !== undefined && item.badge > 0 && <span>{` (${String(item.badge)})`}</span>}
        </button>
      ))}
    </nav>
  )
}
