import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import styles from './ui.module.css'

interface ConfirmButtonProps {
  readonly label: string
  readonly confirmLabel: string
  readonly onConfirm: () => void
  readonly disabled?: boolean
  readonly className?: string
  readonly title?: string
  readonly resetMs?: number
}

/** Two-click destructive confirmation; resets when blurred or after a generous timeout. */
export function ConfirmButton({
  label, confirmLabel, onConfirm, disabled = false, className = '', title, resetMs = 6000,
}: ConfirmButtonProps): ReactElement {
  const [armed, setArmed] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => { if (timer.current !== undefined) window.clearTimeout(timer.current) }, [])

  const click = (): void => {
    if (!armed) {
      setArmed(true)
      timer.current = window.setTimeout(() => { setArmed(false) }, resetMs)
      return
    }
    if (timer.current !== undefined) window.clearTimeout(timer.current)
    setArmed(false)
    onConfirm()
  }

  return (
    <button type="button" title={title}
      className={`${className} ${armed ? styles.confirmArmed : ''}`.trim()}
      disabled={disabled} onClick={click}
      onBlur={() => { setArmed(false) }}>
      {armed ? confirmLabel : label}
    </button>
  )
}
