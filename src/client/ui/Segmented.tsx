import type { ReactElement } from 'react'
import styles from './ui.module.css'

export interface SegmentedItem<T extends string> {
  readonly id: T
  readonly label: string
  readonly disabled?: boolean
}

interface SegmentedProps<T extends string> {
  readonly label: string
  readonly value: T
  readonly items: readonly SegmentedItem<T>[]
  readonly onChange: (id: T) => void
}

export function Segmented<T extends string>({ label, value, items, onChange }: SegmentedProps<T>): ReactElement {
  return (
    <fieldset className={styles.segmented}>
      <legend className={styles.visuallyHidden}>{label}</legend>
      {items.map(item => (
        <button key={item.id} type="button" className={styles.segmentedItem}
          aria-pressed={item.id === value} disabled={item.disabled === true}
          onClick={() => { onChange(item.id) }}>
          {item.label}
        </button>
      ))}
    </fieldset>
  )
}
