import { useEffect, useRef } from 'react'
import type { ReactElement, ReactNode } from 'react'
import styles from './ui.module.css'

interface DialogProps {
  readonly title: string
  readonly closeLabel: string
  readonly onClose: () => void
  readonly children: ReactNode
}

export function Dialog({ title, closeLabel, onClose, children }: DialogProps): ReactElement {
  const surface = useRef<HTMLDivElement | null>(null)
  const opener = useRef<Element | null>(null)

  useEffect(() => {
    opener.current = document.activeElement
    const focusables = surface.current?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    focusables?.[0]?.focus()
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      if (opener.current instanceof HTMLElement) opener.current.focus()
    }
  }, [onClose])

  const trapFocus = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Tab') return
    const nodes = Array.from(surface.current?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? [])
      .filter(node => node.offsetParent !== null)
    if (nodes.length === 0) return
    const first = nodes[0]!
    const last = nodes[nodes.length - 1]!
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
  }

  return (
    <div className={styles.dialogScrim}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label={title}
        ref={surface} onKeyDown={trapFocus} onClick={event => { event.stopPropagation() }}>
        <header className={styles.dialogHead}>
          <h3 className={styles.dialogTitle}>{title}</h3>
          <button type="button" className={styles.dialogClose} aria-label={closeLabel}
            onClick={onClose}>×</button>
        </header>
        <div className={styles.dialogBody}>{children}</div>
      </div>
    </div>
  )
}
