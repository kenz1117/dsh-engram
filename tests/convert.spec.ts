/**
 * Пересчёт векторов: что именно берётся в работу и что получается на выходе.
 *
 * Проверяется на настоящем файле sqlite, а не на заглушке: план читает базу сам,
 * и «какие строки не стоят на целевой длине» — вопрос к базе, а не к тесту.
 * Область счёта берётся из объявления схемы (`status = 'active'`): архивная запись
 * с чужой длиной — не забота пересчёта, и это видно только на живом файле.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { planBaseVectors, runVectorConvert, vectorConversionComplete } from '../src/registry/convert.ts'
import type { VectorTableSpec } from '../src/registry/vector-schema.ts'
import type { EngramEmbedder } from '../src/embedder/interface.ts'
import type { VectorTarget } from '../src/store/interface.ts'

const DIRS: string[] = []
afterEach(() => {
  for (const dir of DIRS.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Объявление: nodes считает только active, observations — все строки. */
const SPECS: readonly VectorTableSpec[] = [
  { table: 'nodes', text: 'content', where: "status = 'active'", vector: 'embedding' },
  { table: 'observations', text: 'belief', where: null, vector: 'embedding' },
]

const TARGET_BYTES = 384 * 4

interface FixtureRow {
  readonly id: string
  readonly status: string
  readonly text: string
  /** Длина вектора в числах; null — вектора нет. */
  readonly dims: number | null
}

function fixture(rows: readonly FixtureRow[], observations: readonly FixtureRow[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'engram-convert-'))
  DIRS.push(dir)
  const path = join(dir, 'user.db')
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE nodes (id TEXT PRIMARY KEY, status TEXT NOT NULL, content TEXT NOT NULL, embedding BLOB);
    CREATE TABLE observations (id TEXT PRIMARY KEY, status TEXT NOT NULL, belief TEXT NOT NULL, embedding BLOB);`)
  const insertNode = db.prepare('INSERT INTO nodes (id, status, content, embedding) VALUES (?, ?, ?, ?)')
  for (const row of rows) insertNode.run(row.id, row.status, row.text, row.dims === null ? null : new Uint8Array(row.dims * 4))
  const insertObservation = db.prepare('INSERT INTO observations (id, status, belief, embedding) VALUES (?, ?, ?, ?)')
  for (const row of observations) insertObservation.run(row.id, row.status, row.text, row.dims === null ? null : new Uint8Array(row.dims * 4))
  db.close()
  return path
}

/** Эмбеддер-заглушка: вектор нужной длины, в котором лежит номер текста. */
function fakeEmbedder(dimensions = 384): EngramEmbedder & { calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    model: 'fake',
    async embed(texts: readonly string[]): Promise<Float32Array[]> {
      calls.push([...texts])
      return texts.map((_, index) => new Float32Array(dimensions).fill(index))
    },
    async close(): Promise<void> {},
  }
}

describe('план пересчёта: кто именно нуждается в векторе', () => {
  it('берёт пустой вектор, чужую длину и пропускает строки вне области схемы', async () => {
    const path = fixture(
      [
        { id: 'n1', status: 'active', text: 'правильная', dims: 384 },
        { id: 'n2', status: 'active', text: 'без вектора', dims: null },
        { id: 'n3', status: 'active', text: 'чужая длина', dims: 512 },
        { id: 'n4', status: 'archived', text: 'архив', dims: 512 },
      ],
      [{ id: 'o1', status: 'active', text: 'убеждение', dims: null }],
    )

    const plan = await planBaseVectors({ path, specs: SPECS, targetBytes: TARGET_BYTES })
    expect(plan.problems).toEqual([])
    expect(plan.empty).toBe(0)
    expect(plan.rows.map(row => row.id)).toEqual(['n2', 'n3', 'o1'])
    // Поле вектора у каждой таблицы своё — оно приходит из объявления, не из кода.
    expect(plan.rows.map(row => row.vector)).toEqual(['embedding', 'embedding', 'embedding'])
  })

  it('пустой текст считается отдельно: пересчитывать не из чего', async () => {
    const plan = await planBaseVectors({
      path: fixture([
        { id: 'n1', status: 'active', text: '   ', dims: null },
        { id: 'n2', status: 'active', text: 'есть текст', dims: null },
      ]),
      specs: SPECS,
      targetBytes: TARGET_BYTES,
    })
    expect(plan.empty).toBe(1)
    expect(plan.rows.map(row => row.id)).toEqual(['n2'])
  })

  it('базы нет и таблицы нет — названы, а не спрятаны за нулём', async () => {
    const missing = await planBaseVectors({
      path: join(mkdtempSync(join(tmpdir(), 'engram-convert-missing-')), 'user.db'),
      specs: SPECS,
      targetBytes: TARGET_BYTES,
    })
    expect(missing.problems.map(problem => problem.kind)).toEqual(['absent'])

    const noTable = await planBaseVectors({
      path: fixture([{ id: 'n1', status: 'active', text: 'текст', dims: null }]),
      specs: [{ table: 'beliefs', text: 'belief', where: null, vector: 'embedding' }],
      targetBytes: TARGET_BYTES,
    })
    expect(noTable.problems.map(problem => problem.kind)).toEqual(['no-table'])
  })
})

describe('пересчёт: партии, запись и честный отказ', () => {
  it('пишет вектор каждой строке плана партиями', async () => {
    const path = fixture([
      { id: 'n1', status: 'active', text: 'раз', dims: null },
      { id: 'n2', status: 'active', text: 'два', dims: null },
      { id: 'n3', status: 'active', text: 'три', dims: null },
    ])
    const plan = await planBaseVectors({ path, specs: SPECS, targetBytes: TARGET_BYTES })
    const written: VectorTarget[] = []
    const embedder = fakeEmbedder()

    const result = await runVectorConvert({
      plan,
      embedder,
      dimensions: 384,
      write: async targets => { written.push(...targets); return targets.length },
      batch: 2,
    })

    expect(result).toEqual({ converted: 3, empty: 0, failed: [] })
    expect(written.map(target => target.id)).toEqual(['n1', 'n2', 'n3'])
    // Партиями, а не одним вызовом: предел вывода модели не должен решать судьбу всей базы.
    expect(embedder.calls.map(call => call.length)).toEqual([2, 1])
  })

  it('эмбеддер вернул не по вектору на текст — партия не пишется', async () => {
    const path = fixture([
      { id: 'n1', status: 'active', text: 'раз', dims: null },
      { id: 'n2', status: 'active', text: 'два', dims: null },
    ])
    const plan = await planBaseVectors({ path, specs: SPECS, targetBytes: TARGET_BYTES })
    const broken: EngramEmbedder = {
      model: 'broken',
      async embed(): Promise<Float32Array[]> { return [new Float32Array(384)] },
      async close(): Promise<void> {},
    }
    const written: VectorTarget[] = []

    const result = await runVectorConvert({
      plan,
      embedder: broken,
      dimensions: 384,
      write: async targets => { written.push(...targets); return targets.length },
    })

    expect(result.converted).toBe(0)
    expect(written).toEqual([])
    expect(result.failed.map(row => row.id)).toEqual(['n1', 'n2'])
  })

  it('смешанные размерности в ответе — вся партия не пишется, ошибка у конкретной строки', async () => {
    const path = fixture([
      { id: 'n1', status: 'active', text: 'раз', dims: null },
      { id: 'n2', status: 'active', text: 'два', dims: null },
    ])
    const plan = await planBaseVectors({ path, specs: SPECS, targetBytes: TARGET_BYTES })
    const broken: EngramEmbedder = {
      model: 'broken-dimensions',
      async embed(): Promise<Float32Array[]> { return [new Float32Array(384), new Float32Array(512)] },
      async close(): Promise<void> {},
    }
    const written: VectorTarget[] = []

    const result = await runVectorConvert({
      plan,
      embedder: broken,
      dimensions: 384,
      write: async targets => { written.push(...targets); return targets.length },
    })

    expect(result.converted).toBe(0)
    expect(written).toEqual([])
    expect(result.failed.map(row => row.id)).toEqual(['n1', 'n2'])
    expect(result.failed[0]?.error).toContain('смешанные размерности')
    expect(result.failed[1]?.error).toContain('512 измерений вместо 384')
    expect(vectorConversionComplete(plan, result)).toBe(false)
  })

  it('сбой записи партии не уносит остальные', async () => {
    const path = fixture([
      { id: 'n1', status: 'active', text: 'раз', dims: null },
      { id: 'n2', status: 'active', text: 'два', dims: null },
      { id: 'n3', status: 'active', text: 'три', dims: null },
    ])
    const plan = await planBaseVectors({ path, specs: SPECS, targetBytes: TARGET_BYTES })

    const result = await runVectorConvert({
      plan,
      embedder: fakeEmbedder(),
      batch: 1,
      dimensions: 384,
      write: async targets => {
        if (targets[0]?.id === 'n2') throw new Error('база занята')
        return targets.length
      },
    })

    expect(result.converted).toBe(2)
    expect(result.failed).toEqual([{ table: 'nodes', id: 'n2', error: 'база занята' }])
  })
})
