/**
 * Объявление схемы данных: какие таблицы несут векторы и по какому условию.
 *
 * Перечень векторных таблиц не должен жить в коде: добавление таблицы у автора
 * иначе молча выпадает из всех наших операций (перевод базы, ремонт, проверка
 * состояния). Объявление лежит данными — `registry/schema.json` — и читается
 * теми же правилами, что каталог моделей: поставка обязательна, пользовательский
 * слой (`<dbDir>/registry/schema.json`) её перекрывает.
 *
 * Из объявления берётся ровно то, что нельзя вывести из `PRAGMA`: поле с текстом
 * (`properties.vector.text`) и условие участия строк (`properties.vector.where`);
 * поле вектора выводится — это единственное поле типа BLOB в строке таблицы.
 * Ведение файла — автору (см. план, блок Б, Б.10).
 *
 * У каждой таблицы есть классификация `role`: `user` — несёт пользовательские
 * векторы и участвует в конвертации; `service` — служебная (например, FTS-тени),
 * в обработку не идёт. Служебные таблицы перечислены в файле как наглядный пример
 * того, что обходчик схемы пропускает помеченное без анализа содержимого.
 *
 * @module @kenz1117/dsh-engram/registry/vector-schema
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RegistryProblem } from './registry-file.ts'
import { packageRoot } from './root.ts'

/** Одна векторная таблица в том виде, в каком её понимают операции с базой. */
export interface VectorTableSpec {
  readonly table: string
  /** Поле, из которого читается текст для эмбеддинга. */
  readonly text: string
  /** Условие участия строк (фрагмент SQL) или null — участвуют все строки. */
  readonly where: string | null
  /** Поле, куда пишется вектор (единственное поле типа BLOB). */
  readonly vector: string
}

/** Что получилось прочитать из объявления. */
export interface LoadedVectorSchema {
  /** Версия схемы, под которую написано объявление; не объявлена — undefined. */
  readonly schemaVersion: number | undefined
  readonly specs: readonly VectorTableSpec[]
  /** Прочитанные файлы, в порядке наложения: поставка, затем пользователь. */
  readonly files: readonly string[]
  readonly problems: readonly RegistryProblem[]
}

/** Прочитать файл; отсутствие необязательного файла — не претензия. */
function readText(path: string, problems: RegistryProblem[], required: boolean): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      if (required) problems.push({ file: path, kind: 'missing', detail: 'объявление схемы не найдено' })
      return undefined
    }
    problems.push({ file: path, kind: 'unreadable', detail: code ?? String(error) })
    return undefined
  }
}

/** Разобрать одну строку таблицы: свойства вектора и поле вектора. */
function specOf(table: string, entry: unknown, file: string, problems: RegistryProblem[]): VectorTableSpec | undefined {
  if (typeof entry !== 'object' || entry === null) {
    problems.push({ file, kind: 'badShape', detail: `${table}: строка таблицы не объект` })
    return undefined
  }
  const row = entry as { role?: unknown, properties?: { vector?: { text?: unknown; where?: unknown } }, fields?: Record<string, unknown> }
  // Служебная таблица помечена role: service — не несёт векторы, в обработку не идёт.
  if (row.role === 'service') return undefined
  const vector = row.properties?.vector
  if (vector === undefined) {
    // user-таблица без объявления вектора — претензия, а не молчаливый пропуск.
    if (row.role === 'user') {
      problems.push({ file, kind: 'badField', detail: `${table}: role: user, но нет properties.vector` })
    }
    return undefined
  }
  const text = vector.text
  if (typeof text !== 'string' || text === '') {
    problems.push({ file, kind: 'badField', detail: `${table}: properties.vector.text не назван` })
    return undefined
  }
  if (vector.where !== null && vector.where !== undefined && typeof vector.where !== 'string') {
    problems.push({ file, kind: 'badField', detail: `${table}: properties.vector.where не строка и не null` })
    return undefined
  }
  const blobs = Object.entries(row.fields ?? {})
    .filter(([, type]) => typeof type === 'string' && type.toUpperCase().includes('BLOB'))
    .map(([field]) => field)
  if (blobs.length !== 1) {
    problems.push({
      file,
      kind: 'badField',
      detail: `${table}: полей BLOB ${blobs.length} (${blobs.join(', ') || '—'}) — неясно, куда писать вектор`,
    })
    return undefined
  }
  return { table, text, where: (vector.where as string | null | undefined) ?? null, vector: blobs[0]! }
}

/**
 * Загрузить объявление схемы. Чистое чтение: база и сеть не нужны, исключений не бросает.
 * @param sources - каталог данных (там же, где базы и пользовательские словари) и корень пакета.
 * @returns список векторных таблиц и претензии к файлу; файла нет — список пуст.
 */
export function loadVectorSchema(sources: { readonly dbDir: string; readonly packageRoot?: string }): LoadedVectorSchema {
  const root = sources.packageRoot ?? packageRoot()
  const problems: RegistryProblem[] = []
  const files: string[] = []
  const specs = new Map<string, VectorTableSpec>()
  let schemaVersion: number | undefined

  const layers: readonly { path: string; required: boolean }[] = [
    { path: join(root, 'registry', 'schema.json'), required: true },
    { path: join(sources.dbDir, 'registry', 'schema.json'), required: false },
  ]

  for (const layer of layers) {
    const text = readText(layer.path, problems, layer.required)
    if (text === undefined) continue
    files.push(layer.path)
    let parsed: unknown
    try {
      const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
      parsed = JSON.parse(body)
    } catch (error) {
      problems.push({ file: layer.path, kind: 'badJson', detail: error instanceof Error ? error.message : String(error) })
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) {
      problems.push({ file: layer.path, kind: 'badShape', detail: 'корень не объект' })
      continue
    }
    const body = parsed as { schemaVersion?: unknown, tables?: unknown }
    if (typeof body.schemaVersion === 'number' && Number.isInteger(body.schemaVersion)) {
      schemaVersion = body.schemaVersion
    }
    if (typeof body.tables !== 'object' || body.tables === null) {
      problems.push({ file: layer.path, kind: 'badShape', detail: 'нет объекта tables' })
      continue
    }
    for (const [table, entry] of Object.entries(body.tables)) {
      const spec = specOf(table, entry, layer.path, problems)
      if (spec !== undefined) specs.set(table, spec)
    }
  }

  return { schemaVersion, specs: [...specs.values()], files, problems }
}
