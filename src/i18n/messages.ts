/**
 * Словарь служебных сообщений серверной половины.
 *
 * Клиентская половина переводится средствами хоста (`ctx.locale`), но у серверной
 * такого сервиса нет: тексты инструментов и промптов формируются до отрисовки.
 * Поэтому язык здесь разрешается один раз при сборке плагина (ключ `language`,
 * по умолчанию — язык системы) и держится в модульной переменной: сообщения
 * разбросаны по десяткам функций, и протаскивать язык через каждую дороже, чем
 * хранить одно значение на процесс.
 *
 * Логика отката повторяет хостовую: цепочка сходится к английскому, поэтому
 * английский набор — образец полноты, а русский может быть неполным.
 *
 * Ключи сгруппированы по областям и лежат в `./catalog/*`.
 *
 * Переводы, которые должно быть можно править без пересборки, живут не в коде,
 * а в файлах `i18n/<язык>.txt` (`./dictionary`, `./dictionary-file`). Словарь
 * накладывается поверх набора по английскому тексту и главнее его: код держит
 * английские формулировки, файл — переводы.
 *
 * @module @kenz1117/dsh-engram/i18n/messages
 */

import { FALLBACK_LANGUAGE, type EngramLanguage } from './language.ts'
import { en as enCore, zh as zhCore } from './catalog/core.ts'
import { en as enLlm, zh as zhLlm } from './catalog/llm.ts'
import { en as enMisc, zh as zhMisc } from './catalog/misc.ts'
import { en as enStore, zh as zhStore } from './catalog/store.ts'
import { en as enTool, zh as zhTool } from './catalog/tool.ts'

/** Подстановки в шаблон: `{name}` заменяется значением. */
export type MessageParams = Readonly<Record<string, string | number>>

const EN = { ...enCore, ...enLlm, ...enMisc, ...enStore, ...enTool }
const ZH = { ...zhCore, ...zhLlm, ...zhMisc, ...zhStore, ...zhTool }

/** Ключ сообщения. Английский набор — образец полноты. */
export type MessageKey = keyof typeof EN

// В коде остались только два набора: английский (образец полноты и источник
// ключей) и китайский (авторские формулировки). Остальные языки приходят
// словарём из файла — см. `./dictionary`.
const CATALOG: Readonly<Partial<Record<EngramLanguage, Readonly<Record<string, string>>>>> = {
  zh: ZH,
  en: EN,
}

/**
 * Обратный указатель «английская строка → ключ»: словарь ключуется текстом, а не
 * именем ключа (см. ./dictionary), поэтому правке из панели нужен именно он.
 * При повторе текста побеждает первый ключ.
 */
const EN_BY_TEXT = ((): ReadonlyMap<string, string> => {
  const index = new Map<string, string>()
  for (const [key, text] of Object.entries(EN)) if (!index.has(text)) index.set(text, key)
  return index
})()

/**
 * Уникальные английские строки всех серверных сообщений — термины словаря.
 * Порядок — порядок объявления в наборах: он же порядок таблицы правки,
 * поэтому строки одной области остаются рядом.
 */
export function messageVocabulary(): readonly string[] {
  const seen = new Set<string>()
  const list: string[] = []
  for (const text of Object.values(EN)) {
    if (seen.has(text)) continue
    seen.add(text)
    list.push(text)
  }
  return list
}

/**
 * Вшитый перевод английской строки сообщения.
 * `undefined` — во вшитых наборах перевода нет (у русского его нет вовсе: он
 * приходит словарём из файла), и текст остаётся английским.
 */
export function messageBuiltin(language: EngramLanguage, source: string): string | undefined {
  const key = EN_BY_TEXT.get(source)
  if (key === undefined) return undefined
  return CATALOG[language]?.[key]
}

let current: EngramLanguage = FALLBACK_LANGUAGE

/**
 * Словарь перевода: язык, к которому он относится, и карта «английский текст → перевод».
 * Привязка к языку обязательна: `messageIn` зовут и с явным языком (зеркало, панель),
 * и словарь одного языка не должен подменять текст другого.
 */
let dictionary: { readonly language: EngramLanguage; readonly entries: ReadonlyMap<string, string> } | undefined

/**
 * Задать язык служебных сообщений.
 * Вызывается один раз при сборке плагина; дальше язык на процесс не меняется.
 */
export function setMessageLanguage(language: EngramLanguage): void {
  current = language
}

/**
 * Задать словарь перевода поверх наборов из кода.
 * Вызывается один раз там же, где задаётся язык; пустая карта равна «словаря нет».
 */
export function setMessageDictionary(language: EngramLanguage, entries: ReadonlyMap<string, string> | undefined): void {
  dictionary = entries === undefined || entries.size === 0 ? undefined : { language, entries }
}

/** Язык, на котором сейчас говорит серверная половина. */
export function messageLanguage(): EngramLanguage {
  return current
}

/** Подстановка параметров; неизвестный параметр остаётся в шаблоне как есть. */
function fill(template: string, params: MessageParams): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name]
    return value === undefined ? whole : String(value)
  })
}

/**
 * Сообщение на заданном языке.
 * Порядок отката: словарь перевода (по английскому тексту) → набор из кода →
 * английский текст; неизвестный ключ возвращается как есть — лучше показать
 * ключ, чем пустую строку.
 */
export function messageIn(language: EngramLanguage, key: MessageKey, params?: MessageParams): string {
  const source: string | undefined = EN[key]
  if (source === undefined) return key
  // Набор из кода есть не для каждого языка; нет набора — остаётся английский текст.
  const table = CATALOG[language]
  // Словарь главнее набора из кода, но только для своего языка: правка файла
  // меняет сообщение без пересборки, а пропавшая строка языка не ломает.
  const translated = dictionary?.language === language ? dictionary.entries.get(source) : undefined
  const template: string = translated ?? table?.[key] ?? source
  return params === undefined ? template : fill(template, params)
}

/** Сообщение на текущем языке процесса. */
export function message(key: MessageKey, params?: MessageParams): string {
  return messageIn(current, key, params)
}
