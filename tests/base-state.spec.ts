/**
 * Состояние базы и перепись её векторов: правило отдельно от чтения, чтение — на
 * настоящем файле sqlite, а не на заглушке. Проверяем ровно то, что нельзя увидеть
 * глазами в карточке: что область счёта — это область объявления схемы (`status =
 * 'active'`), и что архивные записи с чужой длиной вектора состоянием базы не
 * считаются.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { judgeBase, labelToStamp, languageOfLabels, MODEL_LABEL_KEY } from '../src/registry/base-state.ts'
import type { BaseFacts, BaseTarget, CatalogModel } from '../src/registry/base-state.ts'
import { readBaseCensus } from '../src/registry/base-census.ts'
import type { VectorTableSpec } from '../src/registry/vector-schema.ts'

/** Каталог поставки: две модели, как в `registry/models.json`. */
const CATALOG: readonly CatalogModel[] = [
  { id: 'Xenova/bge-small-zh-v1.5', label: 'bge-small-zh', dimensions: 512 },
  { id: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', label: 'minilm-l12', dimensions: 384 },
]

/** Выбранная модель: русский язык, многоязычная MiniLM. */
const MODEL: CatalogModel = { id: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', label: 'minilm-l12', dimensions: 384 }
const TARGET: BaseTarget = { label: 'ru-minilm-l12', model: MODEL }

function facts(patch: Partial<BaseFacts> = {}): BaseFacts {
  return { exists: true, label: undefined, rows: 10, missing: 0, dims: [{ dims: 384, rows: 10 }], ...patch }
}

function judge(patch: Partial<BaseFacts> = {}, target: BaseTarget = TARGET) {
  return judgeBase({ facts: facts(patch), target, language: 'ru', catalog: CATALOG })
}

describe('состояние базы: семь состояний и одно действие', () => {
  it('1. базы нет — ничего не делаем: её создаёт код автора', () => {
    expect(judge({ exists: false, rows: 0, dims: [] })).toMatchObject({ state: 'absent', action: 'none' })
  })

  it('2. база пустая — метку ставить не на чем', () => {
    expect(judge({ rows: 0, dims: [] })).toMatchObject({ state: 'empty', action: 'none' })
  })

  it('7. метки нет, а длина векторов — это выбранная модель: пишем только метку', () => {
    expect(judge()).toMatchObject({ state: 'no-label', action: 'write-label', model: { id: MODEL.id } })
  })

  it('7. метки нет, а длина называет другую модель: это перевод, а не подпись', () => {
    const verdict = judge({ dims: [{ dims: 512, rows: 10 }] })
    expect(verdict).toMatchObject({ state: 'no-label', action: 'convert', model: { label: 'bge-small-zh' } })
  })

  it('7. размерность вне каталога — модель неизвестна, целевую не угадываем', () => {
    const verdict = judge({ dims: [{ dims: 768, rows: 10 }] })
    expect(verdict).toMatchObject({ state: 'no-label', action: 'convert', model: undefined })
    expect(labelToStamp({
      facts: facts({ dims: [{ dims: 768, rows: 10 }] }),
      target: TARGET,
      language: 'ru',
      catalog: CATALOG,
    })).toBeUndefined()
  })

  it('7. метки нет и длины векторов нет: предполагаем выбранную модель', () => {
    expect(judge({ dims: [], missing: 10 })).toMatchObject({ state: 'no-label', action: 'write-label' })
  })

  it('3. метка про выбранную модель, векторы той же длины — норма', () => {
    expect(judge({ label: 'ru-minilm-l12' })).toMatchObject({ state: 'normal', action: 'none', foreign: 0 })
  })

  it('6. метка про другую модель — перевод на выбранную', () => {
    const verdict = judge({ label: 'zh-bge-small-zh', dims: [{ dims: 512, rows: 10 }] })
    expect(verdict).toMatchObject({ state: 'other-model', action: 'convert' })
  })

  it('5. длина вектора не совпадает с меткой — пересортица, считаем чужие записи', () => {
    const verdict = judge({ label: 'ru-minilm-l12', dims: [{ dims: 384, rows: 8 }, { dims: 512, rows: 2 }] })
    expect(verdict).toMatchObject({ state: 'mixed-dims', action: 'convert', foreign: 2 })
    expect(verdict.dims).toEqual([384, 512])
  })

  it('4. записи без вектора — ремонт, а не перевод', () => {
    expect(judge({ label: 'ru-minilm-l12', missing: 3 })).toMatchObject({ state: 'missing-vectors', action: 'repair' })
  })

  it('порядок проверок: чужая метка важнее пересортицы — иначе чужая модель выглядит порчей', () => {
    const verdict = judge({ label: 'zh-bge-small-zh', dims: [{ dims: 512, rows: 9 }, { dims: 384, rows: 1 }] })
    expect(verdict.state).toBe('other-model')
  })

  it('модель вне каталога: метку собрать нечем, поэтому своё считаем чужим', () => {
    const verdict = judge({ label: 'ru-minilm-l12' }, { label: undefined, model: undefined })
    expect(verdict).toMatchObject({ state: 'other-model', action: 'convert' })
  })

  it('гистограмма не обязана приходить отсортированной: преобладающая длина решает', () => {
    const verdict = judge({ dims: [{ dims: 512, rows: 1 }, { dims: 384, rows: 9 }] })
    expect(verdict).toMatchObject({ state: 'no-label', action: 'write-label', dims: [384, 512] })
  })
})

const SPEC: VectorTableSpec = { table: 'nodes', text: 'content', where: "status = 'active'", vector: 'embedding' }

const roots: string[] = []
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }) })

/** База-заготовка: та же пара таблиц, что у плагина, но без миграций и FTS. */
function fixture(rows: readonly { status: string, dims: number | null }[], version = '13', label?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'engram-base-'))
  roots.push(dir)
  const path = join(dir, 'user.db')
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE nodes (id TEXT PRIMARY KEY, status TEXT NOT NULL, content TEXT NOT NULL, embedding BLOB);
    CREATE TABLE observations (id TEXT PRIMARY KEY, status TEXT NOT NULL, belief TEXT NOT NULL, embedding BLOB);`)
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', version)
  if (label !== undefined) db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(MODEL_LABEL_KEY, label)
  const insert = db.prepare('INSERT INTO nodes (id, status, content, embedding) VALUES (?, ?, ?, ?)')
  rows.forEach((row, index) => {
    insert.run(`n${String(index)}`, row.status, `текст ${String(index)}`, row.dims === null ? null : new Uint8Array(row.dims * 4))
  })
  db.close()
  return path
}

describe('перепись базы: считаем область объявления схемы, а не всю таблицу', () => {
  it('архивные записи с чужой длиной и без вектора в счёт не идут', async () => {
    const path = fixture([
      { status: 'active', dims: 384 },
      { status: 'active', dims: 384 },
      { status: 'active', dims: 384 },
      { status: 'active', dims: null },
      { status: 'archived', dims: 512 },
      { status: 'archived', dims: 512 },
      { status: 'archived', dims: null },
    ], '13', 'ru-minilm-l12')

    const census = await readBaseCensus({ path, specs: [SPEC], schemaVersion: 13 })
    expect(census.problems).toEqual([])
    expect(census.checkable).toBe(true)
    expect(census.facts).toMatchObject({ exists: true, label: 'ru-minilm-l12', rows: 4, missing: 1 })
    expect(census.facts.dims).toEqual([{ dims: 384, rows: 3 }])
  })

  it('метки в базе нет — так и говорим, а не выдумываем её', async () => {
    const census = await readBaseCensus({ path: fixture([{ status: 'active', dims: 384 }]), specs: [SPEC], schemaVersion: 13 })
    expect(census.facts.label).toBeUndefined()
    expect(census.facts.rows).toBe(1)
  })

  it('объявление описывает другую версию базы — состояние не проверяем', async () => {
    const census = await readBaseCensus({ path: fixture([{ status: 'active', dims: 384 }], '12'), specs: [SPEC], schemaVersion: 13 })
    expect(census.checkable).toBe(false)
    expect(census.problems.map(problem => problem.kind)).toEqual(['schema-version'])
  })

  it('файла нет — это «базы нет», а не ошибка чтения', async () => {
    const census = await readBaseCensus({
      path: join(mkdtempSync(join(tmpdir(), 'engram-base-missing-')), 'user.db'),
      specs: [SPEC],
      schemaVersion: 13,
    })
    expect(census).toMatchObject({ checkable: true, problems: [] })
    expect(census.facts).toMatchObject({ exists: false, rows: 0 })
  })

  it('объявление называет таблицу, которой нет — говорим, а не молчим нулём', async () => {
    const census = await readBaseCensus({
      path: fixture([{ status: 'active', dims: 384 }]),
      specs: [{ table: 'beliefs', text: 'belief', where: null, vector: 'embedding' }],
      schemaVersion: 13,
    })
    expect(census.problems.map(problem => problem.kind)).toEqual(['no-table'])
  })
})

describe('язык баз по меткам (решение 21.10)', () => {
  it('все подписаны одним языком — он и есть', () => {
    expect(languageOfLabels(['ru-minilm-l12', 'ru-minilm-l12'])).toBe('ru')
  })

  it('база без метки не мешает: метки нет — не мнение, а его отсутствие', () => {
    expect(languageOfLabels([null, 'zh-bge-small-zh'])).toBe('zh')
  })

  it('базы на разных языках — mixed, а не «какая-нибудь из них»', () => {
    expect(languageOfLabels(['ru-minilm-l12', 'en-minilm-l12'])).toBe('mixed')
  })

  it('метки нет ни у одной базы (и баз нет вовсе) — сверять нечего', () => {
    expect(languageOfLabels([])).toBe(null)
    expect(languageOfLabels([null, null])).toBe(null)
  })

  it('метка без нашего языка впереди — не язык', () => {
    // Метка формата `<язык>-<модель>`: строка без языка не доказывает ни одного из трёх.
    expect(languageOfLabels(['minilm-l12'])).toBe(null)
  })

  it('язык вне тройки читается по коду: fr — это fr, а не «метки нет»', () => {
    // Решение 21.10: языки берутся из реестра, а не из закрытого списка трёх.
    expect(languageOfLabels(['fr-minilm-l12'])).toBe('fr')
    expect(languageOfLabels(['fr-minilm-l12', 'de-minilm-l12'])).toBe('mixed')
  })

  it('подтег языка срезается до основного кода: zh-Hans-… — это zh', () => {
    expect(languageOfLabels(['zh-Hans-minilm-l12'])).toBe('zh')
  })
})

/**
 * Подпись при открытии (решение 22.10): метку ставит не только кнопка.
 *
 * Отличие от `judgeBase` ровно в пустой базе: правило карточки говорит «ставить не на
 * чем» — и это верно для кнопки, которой нечего чинить. При открытии наоборот: в пустую
 * базу сейчас пойдёт запись этой моделью, и без метки она до первой починки числилась бы
 * «требует ремонта». Всё остальное решает то же правило, что у кнопки.
 */
describe('метка при открытии базы', () => {
  const stamp = (patch: Partial<BaseFacts> = {}, target: BaseTarget = TARGET): string | undefined =>
    labelToStamp({ facts: facts(patch), target, language: 'ru', catalog: CATALOG })

  it('пустая база подписывается сразу — в неё будет писать эта модель', () => {
    expect(stamp({ rows: 0, dims: [] })).toBe('ru-minilm-l12')
  })

  it('непустая база на целевой модели подписывается', () => {
    expect(stamp()).toBe('ru-minilm-l12')
  })

  it('чужая модель — это перевод, а не подпись', () => {
    expect(stamp({ dims: [{ dims: 512, rows: 10 }] })).toBeUndefined()
  })

  it('уже подписанная база не трогается', () => {
    expect(stamp({ label: 'ru-minilm-l12' })).toBeUndefined()
  })

  it('базы нет — подписывать нечего', () => {
    expect(stamp({ exists: false, rows: 0, dims: [] })).toBeUndefined()
  })

  it('метки для выбранной модели нет — подписывать нечем', () => {
    expect(stamp({}, { label: undefined, model: undefined })).toBeUndefined()
  })
})
