/**
 * Сторож порядка хуков в клиентских компонентах.
 *
 * Проверяется обещание, которое React не выполняет за нас: в теле компонента нет
 * хука после раннего выхода. Нарушение ловится только в работе — «Minified React
 * error #310» и заглушка «Не удалось отрисовать этот раздел», где кнопка «Повторить»
 * не помогает, потому что порядок хуков не восстанавливается сам (так и было 22.10:
 * таймер окна обслуживания стоял после `if (snapshot === null) return`).
 *
 * Тест держит сторож включённым: правка, которая вернёт ошибку в любом `.tsx`
 * клиента, уронит прогон, а не покажется только в браузере.
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'

/** Сторож — общий с консольной проверкой (`node scripts/check-hook-order.mjs`). */
type HookOrder = {
  readonly findComponents: (dir: string) => readonly string[]
  readonly findViolations: (
    targets: readonly string[],
    root: string,
  ) => readonly { readonly short: string, readonly line: number, readonly after: number, readonly fn: string }[]
}

const clientDir = join(import.meta.dirname, '..', 'src', 'client')

async function loadGate(): Promise<HookOrder> {
  const url = new URL('../scripts/check-hook-order.mjs', import.meta.url).href
  return (await import(url)) as HookOrder
}

describe('порядок хуков в клиенте', () => {
  it('ни один компонент не вызывает хук после раннего выхода', async () => {
    const gate = await loadGate()
    const files = gate.findComponents(clientDir)
    expect(files.length).toBeGreaterThan(0)
    const found = gate.findViolations(files, clientDir)
    // Показываем место находки, а не только число: править нужно конкретную строку.
    expect(found.map(hit => `${hit.short}:${String(hit.line)} после выхода в ${hit.fn}`)).toEqual([])
  })

  it('сторож видит нарушение в образце, а не молчит на любом коде', async () => {
    const gate = await loadGate()
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'hook-order-'))
    try {
      const buggy = join(dir, 'buggy.tsx')
      writeFileSync(buggy, [
        'function Probe({ t }: { readonly t: string }): React.ReactElement {',
        '  const [a, setA] = useState(0)',
        '  const [b] = useState<number | null>(null)',
        '  if (b === null) return <div>{t}</div>',
        '  useEffect(() => { setA(1) }, [])',
        '  return <div>{String(a)}</div>',
        '}',
        '',
      ].join('\n'), 'utf8')
      const clean = join(dir, 'clean.tsx')
      writeFileSync(clean, [
        'function Fine({ t }: { readonly t: string }): React.ReactElement {',
        '  const [b] = useState<number | null>(null)',
        '  useEffect(() => { void b }, [b])',
        '  if (b === null) return <div>{t}</div>',
        '  return <div>{String(b)}</div>',
        '}',
        '',
      ].join('\n'), 'utf8')
      expect(gate.findViolations([buggy], dir).map(hit => hit.fn)).toEqual(['Probe'])
      expect(gate.findViolations([clean], dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
