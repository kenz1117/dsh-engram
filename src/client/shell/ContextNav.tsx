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

/**
 * 工作面内的二级导航：一排下划线页签。
 * 用 <nav aria-label> 而不是 <fieldset>+<legend>：图例是可见文本，
 * 会和页眉的工作面标题重复一次（0.13.1 之前的「记忆」出现两遍就是这么来的）。
 */
export function ContextNav<T extends string>({ label, active, items, onChange }: ContextNavProps<T>): ReactElement {
  return (
    <nav className={styles.contextNav} aria-label={label}>
      {items.map(item => (
        <button key={item.id} type="button" className={styles.contextItem}
          aria-pressed={item.id === active}
          onClick={() => { onChange(item.id) }}>
          {item.label}
          {item.badge !== undefined && item.badge > 0 ? ` (${String(item.badge)})` : ''}
        </button>
      ))}
    </nav>
  )
}
