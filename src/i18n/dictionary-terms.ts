/**
 * Словарь как список терминов: что показывать в таблице правки и что стоит справа.
 *
 * Слева в таблице — английская строка ровно в том виде, в каком она написана в коде
 * (набор `en`): по ней словарь и находит перевод (см. ./dictionary). Поэтому список
 * терминов — это уникальные английские строки набора, а не ключи: у панели 435 ключей
 * и 416 уникальных строк, и строки-близнецы правятся одной клеткой.
 *
 * Наборы берутся там, где живут тексты: панель — из вшитых наборов клиента
 * (`src/client/locales`), серверные сообщения — из `./catalog/*`. Оба набора —
 * данные без зависимостей, поэтому сервер читает их напрямую: список терминов
 * должен быть один, а не скопированный рядом.
 *
 * @module @kenz1117/dsh-engram/i18n/dictionary-terms
 */

import { en as panelEn } from '../client/locales/en.ts'
import { ru as panelRu } from '../client/locales/ru.ts'
import { zh as panelZh } from '../client/locales/zh.ts'
import type { EngramLanguage } from './language.ts'
import { messageBuiltin, messageVocabulary } from './messages.ts'

/** Наборы словаря: у каждого свой файл, потому что одинаковые английские строки в них значат разное. */
export type DictionarySet = 'messages' | 'panel'

/** Наборы в порядке показа: сначала панель (её правят чаще), затем серверные сообщения. */
export const DICTIONARY_SETS: readonly DictionarySet[] = ['panel', 'messages']

/** Проверка набора из запроса: чужое имя не должно попадать в путь файла. */
export function isDictionarySet(value: unknown): value is DictionarySet {
  return value === 'panel' || value === 'messages'
}

/** Вшитые наборы панели по языкам: чем переводится строка, если файлов нет. */
const PANEL_PACKS: Readonly<Partial<Record<EngramLanguage, Readonly<Record<string, string>>>>> = {
  en: panelEn,
  ru: panelRu,
  zh: panelZh,
}

/**
 * Языки, чьи тексты панели вшиты в сборку клиента.
 *
 * Их словарь приходит кодом (`ctx.locale.register`), а не файлом: `fr` и любой
 * следующий язык приходят файлом `<dbDir>/i18n/panel.<код>.txt` и объявляются хосту
 * при запуске (см. src/client/index.ts). Список — здесь, чтобы сервер и панель
 * считали вшитыми одни и те же языки и не спорили о том, чей словарь главнее.
 */
export const PANEL_BUILTIN_LANGUAGES: readonly EngramLanguage[] = ['zh', 'en', 'ru']

/** Уникальные строки в порядке первого появления: словарь ключуется текстом. */
function unique(values: readonly string[]): readonly string[] {
  const seen = new Set<string>()
  const list: string[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    list.push(value)
  }
  return list
}

/**
 * Обратный указатель «английская строка → ключ» набора панели.
 * При повторе побеждает первый ключ: словарь всё равно один на оба, и выбрать
 * между ними нечем — об этом говорит `panelTwinTerms` для теста и отчёта.
 */
const panelByText = ((): ReadonlyMap<string, string> => {
  const index = new Map<string, string>()
  for (const [key, text] of Object.entries(panelEn)) if (!index.has(text)) index.set(text, key)
  return index
})()

/**
 * Английские строки, у которых в наборе панели больше одного ключа и вшитые
 * переводы этих ключей расходятся. Такая клетка правит сразу оба места — это не
 * ошибка формата, но знать о ней нужно: строка таблицы выглядит как одна строка.
 * @returns строки, где вшитые переводы ключей-близнецов не совпадают.
 */
export function panelTwinTerms(): readonly string[] {
  const byText = new Map<string, string[]>()
  for (const [key, text] of Object.entries(panelEn)) {
    const keys = byText.get(text)
    if (keys === undefined) byText.set(text, [key])
    else keys.push(key)
  }
  const twins: string[] = []
  for (const [text, keys] of byText) {
    if (keys.length < 2) continue
    const values = new Set(keys.map(key => panelRu[key as keyof typeof panelRu]))
    if (values.size > 1) twins.push(text)
  }
  return twins
}

/** Термины набора — левый столбец таблицы правки. */
export function dictionaryTerms(set: DictionarySet): readonly string[] {
  return set === 'panel' ? unique(Object.values(panelEn)) : messageVocabulary()
}

/**
 * Вшитый перевод термина.
 * `undefined` — вшитого перевода нет, и текст остаётся английским: клетка правки
 * пустая, а не заполненная английским (иначе «уже переведено» не отличить от «нет перевода»).
 */
export function dictionaryBuiltin(set: DictionarySet, language: EngramLanguage, left: string): string | undefined {
  if (set === 'messages') return messageBuiltin(language, left)
  const key = panelByText.get(left)
  return key === undefined ? undefined : PANEL_PACKS[language]?.[key]
}
