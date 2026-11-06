import type { ReactElement } from 'react'
import styles from './shell.module.css'

export interface ContextNavItem<T extends string> {
  readonly id: T
  readonly label: string
  readonly badge?: number
}

interface ContextNavProps<T extends string> {
  readonly label: string
  readonly active: T
  readonly items: readonly ContextNavItem<T>[]
  readonly onChange: (id: T) => void
}

export function ContextNav<T extends string>({ label, active, items, onChange }: ContextNavProps<T>): ReactElement {
  return (
    <fieldset className={styles.contextNav}>
      <legend className={styles.visuallyHidden}>{label}</legend>
      {items.map(item => (
        <button key={item.id} type="button" className={styles.contextItem}
          aria-pressed={item.id === active}
          onClick={() => { onChange(item.id) }}>
          {item.label}
          {item.badge !== undefined && item.badge > 0 ? ` (${String(item.badge)})` : ''}
        </button>
      ))}
    </fieldset>
  )
}
