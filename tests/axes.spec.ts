/**
 * Оси разделены: язык интерфейса ↔ язык дворца ↔ данные.
 *
 * Это долг из В.06, выделенный в отдельную задачу В.10. Смысл проверок — не
 * пересказать код, а доказать три вещи, которые человек иначе принимает на веру:
 *
 * 1. переключение языка интерфейса не двигает ни язык дворца, ни модель;
 * 2. смена языка дворца не переписывает уже записанное: база становится «чужой
 *    моделью» и просит пересчёта, но её содержимое и метка остаются прежними;
 * 3. недособранное условие (окно истекло, кнопка не нажата) ничего не пишет:
 *    план пересчёта — чтение, и после него в базе те же строки и те же векторы.
 *
 * Метка незнакомого языка проверяется здесь же: `fr-minilm-l12` — это язык `fr`,
 * а не «метки нет» (вторая часть В.10, возможная только после В.09).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveLocalModel } from '../src/embedder/select.ts'
import { decideLanguage } from '../src/i18n/palace-language.ts'
import { judgeBase, languageOfLabels } from '../src/registry/base-state.ts'
import type { CatalogModel } from '../src/registry/base-state.ts'
import { planBaseVectors } from '../src/registry/convert.ts'
import type { LoadedRegistry } from '../src/registry/registry-file.ts'
import type { VectorTableSpec } from '../src/registry/vector-schema.ts'

const DIRS: string[] = []
afterEach(() => {
  for (const dir of DIRS.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Каталог из двух моделей: китайская (512) и многоязычная (384). */
const MINILM: CatalogModel = { id: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', label: 'minilm-l12', dimensions: 384 }
const BGE: CatalogModel = { id: 'Xenova/bge-small-zh-v1.5', label: 'bge-small-zh', dimensions: 512 }
const CATALOG: readonly CatalogModel[] = [MINILM, BGE]

/**
 * Реестр, у которого китайский привязан к китайской модели, а всё остальное —
 * к многоязычной. Это и есть проверка «модель идёт от языка дворца»: язык задаёт
 * строку привязки, и никакой другой оси в выборе модели нет.
 */
function registry(): LoadedRegistry {
  return {
    models: new Map([
      [MINILM.id, { id: MINILM.id, label: 'minilm-l12', pooling: 'mean', dtype: 'q8', dimensions: 384, languages: [] }],
      [BGE.id, { id: BGE.id, label: 'bge-small-zh', pooling: 'mean', dtype: 'q8', dimensions: 512, languages: ['zh'] }],
    ]),
    bindings: new Map([['zh', BGE.id], ['*', MINILM.id]]),
    defaultLanguage: 'en',
    languages: [
      { code: 'zh', label: '中文', builtin: true },
      { code: 'en', label: 'English', builtin: true },
      { code: 'ru', label: 'Русский', builtin: false },
    ],
    problems: [],
    files: [],
  }
}

describe('ось «интерфейс»: переключение языка не двигает дворец', () => {
  it('одного preference интерфейса мало: на нём решение не держится', () => {
    const decision = decideLanguage([{ source: 'interface', language: 'zh' }])
    // Язык назван, но опоры нет: `grounded` — это ответ на вопрос «можно ли
    // записать решение молча». Preference интерфейса переключается свободно,
    // поэтому записывать по нему язык дворца нельзя (решение 21.10).
    expect(decision.language).toBe('zh')
    expect(decision.source).toBe('interface')
    expect(decision.grounded).toBe(false)
  })

  it('голос диалога главнее интерфейса: переключили интерфейс — дворец остался', () => {
    const decision = decideLanguage([
      { source: 'interface', language: 'zh' },
      { source: 'dialogue', language: 'ru' },
    ])
    expect(decision.language).toBe('ru')
    expect(decision.source).toBe('dialogue')
    expect(decision.grounded).toBe(true)
  })

  it('модель выбирается по языку дворца, а не по интерфейсу', () => {
    const loaded = registry()
    // Один и тот же реестр, разный язык дворца — разные модели. Языка интерфейса
    // в выборе модели нет вовсе: у `resolveLocalModel` его нет среди аргументов.
    expect(resolveLocalModel(loaded, 'zh', undefined, undefined)?.id).toBe(BGE.id)
    expect(resolveLocalModel(loaded, 'ru', undefined, undefined)?.id).toBe(MINILM.id)
    expect(resolveLocalModel(loaded, 'ru', undefined, undefined)?.label).toBe('ru-minilm-l12')
  })
})

describe('ось «язык дворца»: смена языка не переписывает записанное', () => {
  it('база, подписанная прежним языком, становится «чужой моделью» и просит пересчёта', () => {
    const verdict = judgeBase({
      facts: { exists: true, label: 'ru-minilm-l12', rows: 3, missing: 0, dims: [{ dims: 384, rows: 3 }] },
      target: { label: 'fr-minilm-l12', model: MINILM },
      // Язык дворца переключили на французский: метка, которую мы теперь ждём, другая.
      language: 'fr',
      catalog: CATALOG,
    })
    expect(verdict.state).toBe('other-model')
    expect(verdict.action).toBe('convert')
    // Правило только читает: метка в базе осталась прежней, ничего не переписано.
    expect(verdict.label).toBe('ru-minilm-l12')
    expect(verdict.rows).toBe(3)
  })

  it('незнакомый язык в метке читается как язык, а не как «метки нет»', () => {
    expect(languageOfLabels(['fr-minilm-l12'])).toBe('fr')
    // Метка французского дворца — законная метка: база на своей модели и в норме,
    // а не «без метки». Это и есть вторая часть В.10, ставшая возможной после В.09.
    const verdict = judgeBase({
      facts: { exists: true, label: 'fr-minilm-l12', rows: 2, missing: 0, dims: [{ dims: 384, rows: 2 }] },
      target: { label: 'fr-minilm-l12', model: MINILM },
      language: 'fr',
      catalog: CATALOG,
    })
    expect(verdict.state).toBe('normal')
    expect(verdict.action).toBe('none')
  })
})

/** База с двумя активными записями: вектор прежней модели (512) и запись без вектора. */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'engram-axes-'))
  DIRS.push(dir)
  const path = join(dir, 'user.db')
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE nodes (id TEXT PRIMARY KEY, status TEXT NOT NULL, content TEXT NOT NULL, embedding BLOB);`)
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('model_label', 'ru-bge-small-zh')
  const insert = db.prepare('INSERT INTO nodes (id, status, content, embedding) VALUES (?, ?, ?, ?)')
  insert.run('n1', 'active', 'первая запись', new Uint8Array(512 * 4))
  insert.run('n2', 'active', 'вторая запись', null)
  db.close()
  return path
}

describe('недособранное условие ничего не пишет', () => {
  it('план пересчёта — чтение: после него те же строки, тексты и векторы', async () => {
    const path = fixture()
    const specs: readonly VectorTableSpec[] = [
      { table: 'nodes', text: 'content', where: "status = 'active'", vector: 'embedding' },
    ]
    const plan = await planBaseVectors({ path, specs, targetBytes: 384 * 4 })
    expect(plan.problems).toEqual([])
    // Обе записи в плане: у первой чужая длина, у второй вектора нет вовсе.
    expect(plan.rows.map(row => row.id)).toEqual(['n1', 'n2'])

    const db = new DatabaseSync(path)
    const rows = db.prepare('SELECT id, content, length(embedding) AS bytes FROM nodes ORDER BY id').all()
    const label = db.prepare('SELECT value FROM meta WHERE key = ?').get('model_label')
    db.close()

    // Содержимое, метка и векторы — как были: план ничего не записал.
    expect(rows).toEqual([
      { id: 'n1', content: 'первая запись', bytes: 512 * 4 },
      { id: 'n2', content: 'вторая запись', bytes: null },
    ])
    expect(label).toEqual({ value: 'ru-bge-small-zh' })
  })
})