/**
 * Факты о базе дворца: что в ней лежит — только чтение.
 *
 * Открываем базу отдельным соединением в режиме «только чтение» и намеренно не
 * идём через хранилище плагина: у хранилища открытие базы — это миграции,
 * раскладка незанятых записей по комнатам (backfillSlots) и кеш соединений, то
 * есть запись. Карточка обслуживания смотрит на чужую базу, в том числе на ту,
 * которую плагин в этом процессе ещё не открывал,
 * и ничего в ней менять при этом не должна. Read-only соединение гарантирует это
 * самим sqlite, а не нашей аккуратностью.
 *
 * Считаем только область объявления схемы (`registry/schema.json`): у `nodes` это
 * `status = 'active'`. Ровно эту область читает поиск, поэтому запись вне области
 * без вектора — не дефект: векторов ей не нужно.
 *
 * @module @kenz1117/dsh-engram/registry/base-census
 */

import { existsSync } from 'node:fs'
import { MODEL_LABEL_KEY, languageOfLabels, type BaseFacts, type DimCount } from './base-state.ts'
import type { VectorTableSpec } from './vector-schema.ts'

/** Претензия к базе: почему факты неполные. */
export interface BaseCensusProblem {
  readonly kind: 'unreadable' | 'no-table' | 'no-field' | 'schema-version'
  readonly detail: string
}

/** Что удалось прочитать из базы. */
export interface BaseCensus {
  readonly facts: BaseFacts
  /** Версия схемы самой базы (`meta.schema_version`); нет записи — undefined. */
  readonly schemaVersion: number | undefined
  /** Объявление схемы описывает эту версию базы — можно судить о векторах. */
  readonly checkable: boolean
  readonly problems: readonly BaseCensusProblem[]
}

/** Имя таблицы или поля в SQL: в кавычках, кавычка внутри удваивается. */
function quoted(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}

/** Собрать гистограмму длин: несколько таблиц складываются в одну картину базы. */
function mergeDims(into: Map<number, number>, rows: { dims: number, rows: number }[]): void {
  for (const row of rows) into.set(row.dims, (into.get(row.dims) ?? 0) + row.rows)
}

/**
 * Прочитать факты о базе.
 *
 * Файла нет — это состояние «базы нет», а не ошибка: базу создаёт код автора.
 * Битую базу или базу, объявление о которой расходится с её содержимым, не
 * угадываем: возвращаем то, что прочитали, и говорим, что именно не сошлось.
 * @param input - путь к файлу базы, объявление векторов и его версия схемы.
 * @returns факты, признак проверяемости и претензии.
 */
export async function readBaseCensus(input: {
  readonly path: string
  readonly specs: readonly VectorTableSpec[]
  readonly schemaVersion: number | undefined
}): Promise<BaseCensus> {
  const problems: BaseCensusProblem[] = []
  const dims = new Map<number, number>()
  let rows = 0
  let missing = 0

  if (!existsSync(input.path)) {
    return {
      facts: { exists: false, label: undefined, rows: 0, missing: 0, dims: [] },
      schemaVersion: undefined,
      checkable: true,
      problems,
    }
  }

  const { DatabaseSync } = await import('node:sqlite')
  let db: InstanceType<typeof DatabaseSync> | undefined
  let label: string | undefined
  let baseVersion: number | undefined
  try {
    db = new DatabaseSync(input.path, { readOnly: true })
    db.exec('PRAGMA busy_timeout = 2000')

    const meta = db.prepare('SELECT key, value FROM meta').all() as unknown as { key: string, value: string }[]
    label = meta.find(row => row.key === MODEL_LABEL_KEY)?.value
    const version = meta.find(row => row.key === 'schema_version')?.value
    baseVersion = version === undefined ? undefined : Number(version)

    for (const spec of input.specs) {
      const cols = (db.prepare(`PRAGMA table_info(${quoted(spec.table)})`).all() as unknown as { name: string }[])
        .map(column => column.name)
      if (cols.length === 0) {
        problems.push({ kind: 'no-table', detail: spec.table })
        continue
      }
      if (!cols.includes(spec.vector) || !cols.includes(spec.text)) {
        problems.push({ kind: 'no-field', detail: spec.table })
        continue
      }
      const scope = spec.where === null ? '1 = 1' : `(${spec.where})`
      const vector = quoted(spec.vector)
      const table = quoted(spec.table)
      rows += (db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${scope}`).get() as unknown as { c: number }).c
      missing += (db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${scope} AND ${vector} IS NULL`).get() as unknown as { c: number }).c
      const hist = db.prepare(
        `SELECT length(${vector}) / 4 AS dims, COUNT(*) AS c FROM ${table}
          WHERE ${scope} AND ${vector} IS NOT NULL GROUP BY dims`,
      ).all() as unknown as { dims: number, c: number }[]
      mergeDims(dims, hist.map(row => ({ dims: row.dims, rows: row.c })))
    }
  } catch (error) {
    problems.push({ kind: 'unreadable', detail: error instanceof Error ? error.message : String(error) })
    label = undefined
  } finally {
    try {
      db?.close()
    } catch {
      // Закрытие read-only соединения чинить нечем.
    }
  }

  const checkable = input.schemaVersion === undefined
    || baseVersion === undefined
    || input.schemaVersion === baseVersion
  if (!checkable) {
    problems.push({
      kind: 'schema-version',
      // Формат — машиночитаемый, без слов: панель показывает эту строку человеку
      // на своём языке, и русская фраза здесь всплывала бы посреди китайского
      // интерфейса. Версии — единственное, что в ней было.
      detail: `v${String(baseVersion)}→v${String(input.schemaVersion)}`,
    })
  }

  const facts: BaseFacts = {
    exists: true,
    label,
    rows,
    missing,
    dims: [...dims].map(([value, count]): DimCount => ({ dims: value, rows: count })),
  }
  return { facts, schemaVersion: baseVersion, checkable, problems }
}

/**
 * Язык, на котором стоит база, — по метке `meta.model_label`, лёгкое чтение.
 *
 * Отдельно от `readBaseCensus`: выбору модели при сборке плагина (issue #39) нужен
 * только язык существующей базы, а не полная опись векторов. Те же гарантии, что и
 * у описи: read-only соединение, отсутствие файла — «базы нет», а не ошибка,
 * любая проблема чтения — `undefined`, а не догадка.
 * @param path - путь к файлу базы.
 * @returns код языка из метки либо undefined (файла нет, метки нет, читать не удалось).
 */
export async function readStoreLanguageLabel(path: string): Promise<string | undefined> {
  if (!existsSync(path)) return undefined
  const { DatabaseSync } = await import('node:sqlite')
  let db: InstanceType<typeof DatabaseSync> | undefined
  try {
    db = new DatabaseSync(path, { readOnly: true })
    db.exec('PRAGMA busy_timeout = 2000')
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(MODEL_LABEL_KEY) as unknown as { value: string } | undefined
    if (row === undefined) return undefined
    // Правило разбора одно на весь формат метки — `languageOfLabels`; локальная копия
    // здесь рано или поздно разошлась бы с ним (например, по подтегам вроде zh-Hans).
    const language = languageOfLabels([row.value])
    return typeof language === 'string' ? language : undefined
  } catch {
    return undefined
  } finally {
    try { db?.close() } catch { /* Закрытие read-only соединения чинить нечем. */ }
  }
}
