/**
 * Корень пакета — общий для всех файлов, которые читаются с диска при работе:
 * словарей (`i18n/`) и реестров (`registry/`).
 *
 * От `'..'` считать нельзя: в исходниках модуль лежит на два уровня ниже корня
 * (`src/registry/`, `src/i18n/`), а в сборке — на один (`lib/`). Поэтому
 * поднимаемся до первого каталога с `package.json`: правило одно и для
 * репозитория, и для установки.
 *
 * @module @kenz1117/dsh-engram/registry/root
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Насколько высоко подниматься в поисках `package.json`. */
const ROOT_SEARCH_DEPTH = 6

/** Каталог, в котором лежит `package.json` пакета. */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < ROOT_SEARCH_DEPTH; depth += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return dir
}
