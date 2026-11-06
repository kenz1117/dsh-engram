#!/usr/bin/env node
/**
 * Проверка соответствия CSS-классов разметке.
 *
 * CSS Modules не проверяются типами: `styles.foo` напечатается как строка, а
 * если правила для `.foo` нет — className станет "undefined" или класс просто
 * не применится. Один раз так снесли базовое правило `.item` (сетка строки
 * списка) вместе с половиной файла — и это не поймал ни один тест.
 *
 * Что проверяем:
 *   1. каждый класс, который разметка берёт у CSS-модуля, имеет правило
 *      в каком-нибудь *.module.css клиента;
 *   2. в клиентских стилях нет классов, которые никто не использует
 *      (информация, не ошибка: чистка стилей — отдельная задача).
 *
 * Запуск: node scripts/check-css-classes.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = 'src/client'

/** Рекурсивно собирает файлы по расширению. */
function collect(dir, exts) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...collect(full, exts))
    else if (exts.some(ext => name.endsWith(ext))) out.push(full)
  }
  return out
}

const styleFiles = collect(SRC, ['.css'])
const sourceFiles = collect(SRC, ['.ts', '.tsx'])

// 1. Какие классы вообще объявлены (в любом модуле клиента).
const declared = new Set()
for (const file of styleFiles) {
  const css = readFileSync(file, 'utf8')
  for (const match of css.matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)) declared.add(match[1])
}

// 2. Какие классы берёт разметка.
const used = new Map()
for (const file of sourceFiles) {
  const text = readFileSync(file, 'utf8')
  const found = new Set()
  for (const match of text.matchAll(/styles\.([A-Za-z][A-Za-z0-9_]*)/g)) found.add(match[1])
  for (const match of text.matchAll(/styles\[`([A-Za-z]+)[$`]/g)) found.add(match[1])
  for (const name of found) {
    if (!used.has(name)) used.set(name, [])
    used.get(name).push(file)
  }
}

// Динамические имена (styles[`status${x}`]) требуют не точного класса,
// а хотя бы одного правила с таким префиксом.
const dynamic = new Set()
for (const file of sourceFiles) {
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(/styles\[`([A-Za-z]+)\$\{/g)) dynamic.add(match[1])
}
const hasPrefix = name => [...declared].some(declaredName => declaredName.startsWith(name))

const missing = [...used.entries()].filter(([name]) => {
  if (declared.has(name)) return false
  if (dynamic.has(name)) return !hasPrefix(name)
  return true
}).sort()
if (missing.length > 0) {
  for (const [name, files] of missing) {
    console.error(`  нет правила для класса «${name}» — его берёт ${[...new Set(files)].join(', ')}`)
  }
  console.error(`пропущено классов без правил: ${missing.length}`)
  process.exit(1)
}

// 3. Информация: объявленные, но не используемые классы (чистка — отдельная задача).
const unused = [...declared].filter(name => !used.has(name)).sort()
console.log(`классов в стилях: ${declared.size}; используется разметкой: ${used.size}; без правил: 0`)
if (unused.length > 0) {
  console.log(`объявлено, но не используется (${unused.length}): ${unused.join(', ')}`)
}
