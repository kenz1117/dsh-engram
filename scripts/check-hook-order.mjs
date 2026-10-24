#!/usr/bin/env node
/**
 * Сторож порядка хуков: находит хук, стоящий в теле компонента ПОСЛЕ раннего выхода
 * (`if (...) return ...`), то есть в ветке, где хуков меньше, чем в другой.
 *
 * Зачем: React сообщает об этом только в работе — «Minified React error #310» и заглушка
 * «Не удалось отрисовать этот раздел» с кнопкой «Повторить», которая не помогает, потому
 * что порядок хуков не восстанавливается сам. Сборка и `tsc` такое пропускают молча.
 *
 * Проверка статическая и грубая: считаем ФИГУРНЫЕ скобки (круглые не в счёт: они обнуляют
 * глубину ещё в сигнатуре), ищем хуки и `return` на первом уровне тела функции. Ложные
 * срабатывания возможны там, где разметка написана функции-обёрткой промежуточно, поэтому
 * находка читается глазами, а не гасится на месте.
 *
 * Запуск:  node scripts/check-hook-order.mjs [файл...]
 * Экспорт: scanFile(путь), findViolations(каталоги) — используется и тестом.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { argv } from 'node:process'

const HOOK = /(?:\buse(?:State|Effect|Memo|Ref|Callback|LayoutEffect|SyncExternalStore|Context)\b|\buseToast\s*\()/
const FUNC = /^\s*(?:export\s+)?function\s+([A-Za-z0-9_$]+)|^\s*const\s+([A-Za-z0-9_$]+)\s*=\s*(?:memo\s*\(|\(|<)/

/**
 * Маска строк, шаблонов и строчных комментариев: скобки и слова `return` внутри текста
 * не должны участвовать в счёте. Блочные комментарии остаются как есть — в них нет
 * `useEffect(` в начале строки, а маскировать их — значит гадать о продолжении строки.
 */
function mask(line) {
  let out = ''
  let quote = null
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    const next = line[i + 1]
    if (quote !== null) {
      if (ch === '\\') { i += 1; continue }
      if (ch === quote) { quote = null; out += ch; continue }
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; continue }
    if (ch === '/' && next === '/') break
    out += ch
  }
  return out
}

/** Находки в одном файле: строка хука, имя функции, строка раннего выхода. */
export function scanFile(file) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  const findings = []
  let fn = null        // имя функции, тело которой читаем
  let pending = null   // объявление найдено, ждём фигурную скобку тела вне круга скобок
  let depth = 0        // вложенность фигурных скобок тела
  let paren = 0        // вложенность круглых: `({ a })` в сигнатуре — ещё не тело
  let early = null

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    const code = mask(raw)

    if (fn === null && pending === null) {
      const match = FUNC.exec(code)
      if (match !== null) pending = match[1] ?? match[2]
    }

    // `if (x) return <div/>` одной строкой — тоже ранний выход.
    if (fn !== null && depth === 1 && /\bif\s*\(/.test(code) && /\breturn\b/.test(code)) {
      if (early === null) early = index + 1
    }
    if (fn !== null && depth === 1 && /^\s*return\b/.test(code) && !/\bif\b/.test(code)) {
      // `return (` на первом уровне — конец разметки: ниже хуков быть не должно.
      if (early === null) early = index + 1
    }
    if (fn !== null && depth === 1 && HOOK.test(code) && early !== null) {
      findings.push({ file, line: index + 1, fn, after: early, text: raw.trim().slice(0, 110) })
    }

    for (const ch of code) {
      if (ch === '(') paren += 1
      else if (ch === ')') paren = Math.max(0, paren - 1)
      else if (ch === '{') {
        if (pending !== null && depth === 0 && paren === 0) { fn = pending; pending = null }
        depth += 1
      } else if (ch === '}') {
        depth -= 1
        if (fn !== null && depth <= 0) { fn = null; depth = 0; early = null }
      }
    }
  }
  return findings
}

/** Все `.tsx` под каталогом. */
export function findComponents(dir) {
  const found = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) found.push(...findComponents(path))
    else if (/\.tsx$/.test(name)) found.push(path)
  }
  return found
}

/** Находки по списку каталогов-файлов; `root` — для коротких путей в выводе. */
export function findViolations(targets, root) {
  return targets.flatMap(file => scanFile(file).map(hit => ({ ...hit, short: relative(root, hit.file) })))
}

// Запуск из консоли — только когда этот файл и есть точка входа: при импорте тестом
// нижняя часть молчит.
const selfPath = resolve(fileURLToPath(import.meta.url))
const isMain = argv[1] !== undefined && resolve(argv[1]) === selfPath

if (isMain) {
  const root = resolve(import.meta.dirname, '..', 'src', 'client')
  const targets = argv.length > 2 ? argv.slice(2).map(p => resolve(p)) : findComponents(root)
  const all = findViolations(targets, root)
  if (all.length === 0) {
    console.log(`hook-order: чисто, проверено файлов ${String(targets.length)}`)
  } else {
    for (const hit of all) {
      console.log(`${hit.short}:${String(hit.line)} — хук после выхода (строка ${String(hit.after)}) в ${hit.fn}\n    ${hit.text}`)
    }
    console.log(`hook-order: находок ${String(all.length)}`)
    process.exit(1)
  }
}
