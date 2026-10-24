/**
 * Словари в файлах: два набора текстов — сообщения и панель.
 *
 * Набор задаётся именем файла (`<язык>.txt` и `panel.<язык>.txt`), а формат,
 * слои и правила разбора у них общие. Проверяется именно это: что панель читает
 * свой файл, что пользовательский слой главнее поставки и что отсутствие файла —
 * не ошибка, а «словаря нет».
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadMessageDictionary, loadPanelDictionary } from '../src/i18n/dictionary-file.ts'
import { messageIn, setMessageDictionary } from '../src/i18n/messages.ts'

/** Каталог поставки и каталог данных с указанными файлами словарей. */
async function makeRoots(files: {
  readonly shipped?: Readonly<Record<string, string>>
  readonly user?: Readonly<Record<string, string>>
}): Promise<{ packageRoot: string; dbDir: string }> {
  const packageRoot = await mkdtemp(join(tmpdir(), 'engram-dict-'))
  const dbDir = await mkdtemp(join(tmpdir(), 'engram-dict-db-'))
  for (const [dir, set] of [[join(packageRoot, 'i18n'), files.shipped], [join(dbDir, 'i18n'), files.user]] as const) {
    if (set === undefined) continue
    await mkdir(dir, { recursive: true })
    for (const [name, text] of Object.entries(set)) await writeFile(join(dir, name), text)
  }
  return { packageRoot, dbDir }
}

const MESSAGES = 'Hello\tПривет\n'
const PANEL = 'Model and dictionaries\tМодель и словари (панель)\n'

describe('словарь панели читается своим файлом', () => {
  it('наборы не смешиваются: у каждого свой файл', async () => {
    const roots = await makeRoots({ shipped: { 'ru.txt': MESSAGES, 'panel.ru.txt': PANEL } })
    const messages = loadMessageDictionary({ language: 'ru', ...roots })
    const panel = loadPanelDictionary({ language: 'ru', ...roots })
    expect(messages.entries.get('Hello')).toBe('Привет')
    expect(messages.entries.has('Model and dictionaries')).toBe(false)
    expect(panel.entries.get('Model and dictionaries')).toBe('Модель и словари (панель)')
    expect(panel.entries.has('Hello')).toBe(false)
    expect(panel.files.map(file => file.split(/[\\/]/).pop())).toEqual(['panel.ru.txt'])
  })

  it('пользовательский слой главнее поставки, а его отсутствие — не ошибка', async () => {
    const roots = await makeRoots({
      shipped: { 'panel.ru.txt': PANEL },
      user: { 'panel.ru.txt': 'Model and dictionaries\tМодель и словари (правка)\n' },
    })
    const panel = loadPanelDictionary({ language: 'ru', ...roots })
    expect(panel.entries.get('Model and dictionaries')).toBe('Модель и словари (правка)')
    expect(panel.files).toHaveLength(2)

    const onlyShipped = await makeRoots({ shipped: { 'panel.ru.txt': PANEL } })
    const alone = loadPanelDictionary({ language: 'ru', ...onlyShipped })
    expect(alone.problems).toEqual([])
    expect(alone.files).toHaveLength(1)
  })

  it('строка без перевода: в поставке дефект, в слое человека — заготовка', async () => {
    // Поставка — часть выпуска: пустая правая часть там означает поломку файла.
    const shipped = await makeRoots({ shipped: { 'panel.ru.txt': 'Model and dictionaries\t\n' } })
    const broken = loadPanelDictionary({ language: 'ru', ...shipped })
    expect(broken.problems.map(problem => problem.kind)).toEqual(['emptyRight'])
    expect(broken.entries.size).toBe(0)

    // Файл человека — заготовка словаря: строка есть, перевода ещё нет, и это не ошибка.
    const own = await makeRoots({ user: { 'panel.ru.txt': 'Model and dictionaries\t\n' } })
    const blank = loadPanelDictionary({ language: 'ru', ...own })
    expect(blank.problems).toEqual([])
    expect(blank.keys.has('Model and dictionaries')).toBe(true)
    // Показать при этом нечего: текста нет, и он остаётся английским.
    expect(blank.entries.has('Model and dictionaries')).toBe(false)
  })

  it('нет файлов — нет словаря: пустая карта без претензий', async () => {
    const roots = await makeRoots({})
    const panel = loadPanelDictionary({ language: 'ru', ...roots })
    expect(panel.entries.size).toBe(0)
    expect(panel.problems).toEqual([])
    expect(panel.files).toEqual([])
  })

  it('поставляемые словари панели и сообщений на месте и разбираются без претензий', async () => {
    const roots = await makeRoots({})
    const shipped = join(import.meta.dirname, '..')
    const messages = loadMessageDictionary({ language: 'ru', dbDir: roots.dbDir, packageRoot: shipped })
    const panel = loadPanelDictionary({ language: 'ru', dbDir: roots.dbDir, packageRoot: shipped })
    expect(messages.entries.size).toBeGreaterThan(0)
    expect(panel.entries.size).toBeGreaterThan(0)
    expect(messages.problems).toEqual([])
    expect(panel.problems).toEqual([])
  })
})

/**
 * Язык, которого не было в прежней тройке. Вшитого набора у него нет — значит
 * тексты приходят файлом, а нет файла — остаются английские. Это и есть обещание
 * «язык добавляется данными» (В.09): новый язык не требует ни правки TypeScript,
 * ни отказа от работы, пока словаря нет.
 */
describe('язык без вшитого набора: словарь файлом, иначе английский', () => {
  it('файл в каталоге данных читается как обычный слой', async () => {
    const roots = await makeRoots({ user: { 'fr.txt': 'Hello\tBonjour\n' } })
    const messages = loadMessageDictionary({ language: 'fr', ...roots })
    expect(messages.problems).toEqual([])
    expect(messages.entries.get('Hello')).toBe('Bonjour')
    expect(messages.files.map(file => file.split(/[\\/]/).pop())).toEqual(['fr.txt'])
  })

  it('файла нет — сообщение остаётся английским, а не пустым', async () => {
    const roots = await makeRoots({})
    const messages = loadMessageDictionary({ language: 'fr', ...roots })
    expect(messages.entries.size).toBe(0)
    expect(messages.problems).toEqual([])
    setMessageDictionary('fr', messages.entries)
    // Цепочка отката: набора `fr` в коде нет и словаря нет — значит английский текст.
    expect(messageIn('fr', 'misc.mirrorPalacePersonal')).toBe(messageIn('en', 'misc.mirrorPalacePersonal'))
    setMessageDictionary('fr', undefined)
  })
})
