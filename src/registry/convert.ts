/**
 * Пересчёт векторов базы: перевод на выбранную модель и ремонт записей без вектора.
 *
 * Оба действия — одна операция. «Перевести» значит пересчитать вектор каждой строке,
 * которая стоит не на целевой модели; «починить» — пересчитать вектор там, где его нет.
 * Критерий в обоих случаях один и тот же: строка области объявления схемы, у которой
 * вектор пуст или его длина не равна ожидаемой. Разница только в том, что при переводе
 * после этого меняется метка модели, а при ремонте метка уже верна — и это решает
 * вызывающий, а не этот модуль.
 *
 * Что откуда берётся:
 *   - какие таблицы несут векторы и по какому условию — `registry/schema.json`
 *     (см. `./vector-schema`), в коде перечня таблиц нет;
 *   - из какого поля читается текст — оттуда же (`properties.vector.text`);
 *   - ожидаемая длина — из каталога моделей, а не числом в коде.
 *
 * Пишет вызывающий: соединение у базы одно, и оно живёт в хранилище
 * (`EngramStore.rewriteVectors`). Поэтому здесь только чтение, нарезка на партии и
 * вызов эмбеддера — то же самое, чем база наполняется при обычной записи.
 *
 * @module @kenz1117/dsh-engram/registry/convert
 */

import { existsSync } from 'node:fs'
import type { EngramEmbedder } from '../embedder/interface.ts'
import type { VectorTarget } from '../store/interface.ts'
import type { VectorTableSpec } from './vector-schema.ts'

/** Партия эмбеддинга: столько текстов уходит в модель за один вызов. */
export const CONVERT_BATCH = 16

/** Строка, которой нужен новый вектор. */
export interface VectorPlanRow {
  readonly table: string
  /** Поле вектора в этой таблице: у каждой таблицы оно своё. */
  readonly vector: string
  readonly id: string
  /** Текст, который пойдёт в модель; ровно то поле, из которого читает обычная запись. */
  readonly text: string
}

/** Что нашлось в базе. */
export interface VectorPlan {
  /** Строки под пересчёт, в порядке обхода схемы. */
  readonly rows: readonly VectorPlanRow[]
  /** Сколько строк нуждаются в векторе, но текста в них нет: пересчитывать не из чего. */
  readonly empty: number
  /** Чего не хватило, чтобы спланировать: таблицы нет, поля нет, база нечитаема. */
  readonly problems: readonly { readonly kind: string, readonly detail: string }[]
}

/** Итог пересчёта. */
export interface ConvertResult {
  /** Строк получило новый вектор. */
  readonly converted: number
  /** Строк пропущено из-за пустого текста. */
  readonly empty: number
  /** Партии, на которых эмбеддер не справился: текст и причина. */
  readonly failed: readonly { readonly table: string, readonly id: string, readonly error: string }[]
}

/** Имя таблицы или поля в SQL: в кавычках, кавычка внутри удваивается. */
function quoted(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}

/**
 * Спланировать пересчёт: какие строки базы не стоят на целевой длине вектора.
 *
 * Читается отдельным соединением в режиме «только чтение» — так же, как осмотр базы
 * (`./base-census`). Писателя у базы один, и он не здесь.
 * @param input - путь к базе, объявление векторов и ожидаемая длина вектора в байтах.
 * @returns строки под пересчёт, число строк без текста и претензии к базе.
 */
export async function planBaseVectors(input: {
  readonly path: string
  readonly specs: readonly VectorTableSpec[]
  readonly targetBytes: number
}): Promise<VectorPlan> {
  if (!existsSync(input.path)) return { rows: [], empty: 0, problems: [{ kind: 'absent', detail: input.path }] }

  const { DatabaseSync } = await import('node:sqlite')
  const problems: { kind: string, detail: string }[] = []
  const rows: VectorPlanRow[] = []
  let empty = 0
  let db: InstanceType<typeof DatabaseSync> | undefined
  try {
    db = new DatabaseSync(input.path, { readOnly: true })
    db.exec('PRAGMA busy_timeout = 2000')

    for (const spec of input.specs) {
      const cols = (db.prepare(`PRAGMA table_info(${quoted(spec.table)})`).all() as unknown as { name: string }[])
        .map(column => column.name)
      if (cols.length === 0) {
        problems.push({ kind: 'no-table', detail: spec.table })
        continue
      }
      if (!cols.includes(spec.vector) || !cols.includes(spec.text) || !cols.includes('id')) {
        problems.push({ kind: 'no-field', detail: spec.table })
        continue
      }
      const scope = spec.where === null ? '1 = 1' : `(${spec.where})`
      const vector = quoted(spec.vector)
      const selected = db.prepare(
        `SELECT id, ${quoted(spec.text)} AS text FROM ${quoted(spec.table)}
          WHERE ${scope} AND (${vector} IS NULL OR length(${vector}) != ?)`,
      ).all(input.targetBytes) as unknown as { id: string, text: string | null }[]
      for (const row of selected) {
        const text = (row.text ?? '').trim()
        // Пустой текст — не ошибка пересчёта, а факт: строке не из чего строить вектор.
        // Такие строки называются числом, а не молча пропускаются.
        if (text === '') {
          empty += 1
          continue
        }
        rows.push({ table: spec.table, vector: spec.vector, id: row.id, text })
      }
    }
  } catch (error) {
    problems.push({ kind: 'unreadable', detail: error instanceof Error ? error.message : String(error) })
  } finally {
    try {
      db?.close()
    } catch {
      // Закрытие read-only соединения чинить нечем.
    }
  }

  return { rows, empty, problems }
}

/**
 * Пересчитать векторы по плану.
 *
 * Партиями, а не одним вызовом: вывод модели растёт вместе со входом, и один
 * сбой эмбеддера не должен уносить весь пересчёт. Сбой партии попадает в `failed`
 * построчно, остальные партии продолжаются — это ремонт, а не миграция «всё или ничего».
 * @param input - план, эмбеддер, запись векторов и (для тестов) размер партии.
 * @returns сколько получило вектор, сколько пропущено и что не далось.
 */
export async function runVectorConvert(input: {
  readonly plan: VectorPlan
  readonly embedder: EngramEmbedder
  readonly write: (targets: readonly VectorTarget[]) => Promise<number>
  readonly batch?: number
}): Promise<ConvertResult> {
  const batch = input.batch ?? CONVERT_BATCH
  const failed: { table: string, id: string, error: string }[] = []
  let converted = 0

  for (let start = 0; start < input.plan.rows.length; start += batch) {
    const slice = input.plan.rows.slice(start, start + batch)
    let vectors: Float32Array[]
    try {
      vectors = await input.embedder.embed(slice.map(row => row.text))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      for (const row of slice) failed.push({ table: row.table, id: row.id, error: reason })
      continue
    }
    if (vectors.length !== slice.length) {
      // Эмбеддер обязан вернуть вектор на каждый текст. Разошлось — партию не пишем:
      // приписать чужой вектор строке хуже, чем оставить её без вектора.
      const reason = `эмбеддер вернул ${vectors.length} векторов на ${slice.length} текстов`
      for (const row of slice) failed.push({ table: row.table, id: row.id, error: reason })
      continue
    }
    const targets: VectorTarget[] = slice.map((row, index) => ({
      table: row.table,
      vector: row.vector,
      id: row.id,
      embedding: vectors[index]!,
    }))
    try {
      converted += await input.write(targets)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      for (const row of slice) failed.push({ table: row.table, id: row.id, error: reason })
    }
  }

  return { converted, empty: input.plan.empty, failed }
}
