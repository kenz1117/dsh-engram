/**
 * Заполнение словаря с помощью модели: собрать запрос и разобрать ответ.
 *
 * Клетки словаря переводит вспомогательная модель: панель отдаёт английские строки
 * набора, получает переводы на язык набора и кладёт их в черновик таблицы. Ключ
 * словаря — сама английская строка, поэтому в запрос уходит она же: перевод
 * сопоставляется по точному совпадению, а не по позиции (модель вправе пропустить
 * строку или ответить короче).
 *
 * Запросы режутся на партии (см. `FILL_BATCH`): ответ на сотни терминов сразу
 * приходит с обрывами и потерями, а партию видно в прогрессе и можно прервать.
 * Резка — у вызывающего (панель): здесь только «одна партия → переводы».
 *
 * @module @kenz1117/dsh-engram/i18n/dictionary-ai
 */

import type { EngramLanguage } from './language.ts'
import { message } from './messages.ts'
import { EngramError } from '../types.ts'
import { FILL_REQUEST_MAX, needsTranslation } from './dictionary-limits.ts'

/**
 * Язык в запросе: модель должна понимать, на какой язык переводить.
 * Имя английское — это метаязык инструкции, а не тот, на который переводим.
 */
const LANGUAGE_NAMES: Readonly<Record<EngramLanguage, string>> = {
  en: 'English',
  ru: 'Russian',
  zh: 'Chinese',
}

/** Что отправляем модели: системная инструкция и данные. */
export interface FillPrompt {
  readonly system: string
  readonly userText: string
}

/** Пара «английская строка → перевод»: тот же вид, что у правок из панели. */
export type FillPair = readonly [string, string]

/**
 * Сколько принятых пар уходит модели как словарь терминов.
 *
 * Словарь — это подсказка о том, что уже принято, а не второй запрос: два десятка
 * строк хватает, чтобы модель держала одни и те же слова в соседних партиях, и мало,
 * чтобы запрос вырос вдвое.
 */
export const GLOSSARY_MAX_PAIRS = 20

/** Предел длины словаря терминов: он едет в том же запросе, что и партия. */
export const GLOSSARY_MAX_CHARS = 900

/**
 * Словарь устоявшихся терминов для запроса.
 *
 * Собирается из того, что в наборе уже переведено: при повторном заполнении это
 * переводы поставки, при первом проходе по новому языку — переводы прошлых партий.
 * Модель получает их как «уже принято» и не выбирает для того же понятия другое слово
 * в следующей партии. Берутся короткие строки: понятие живёт в подписи, а не в
 * многострочной подсказке.
 * @param rows - строки набора с уже непустым правым столбцом.
 * @param limit - предел числа пар.
 * @param maxChars - предел суммы символов пары.
 * @returns пары в порядке возрастания длины английской строки.
 */
export function glossaryPairs(
  rows: readonly { readonly left: string, readonly right: string }[],
  limit: number = GLOSSARY_MAX_PAIRS,
  maxChars: number = GLOSSARY_MAX_CHARS,
): readonly FillPair[] {
  const ready = rows
    .filter(row => row.right.trim() !== '' && row.right.trim() !== row.left.trim())
    .filter(row => !row.left.includes('\n') && !row.right.includes('\n'))
    .slice()
    .sort((a, b) => a.left.length - b.left.length)
  const pairs: FillPair[] = []
  let size = 0
  for (const row of ready) {
    if (pairs.length >= limit) break
    const chars = row.left.length + row.right.length + 6
    if (pairs.length > 0 && size + chars > maxChars) break
    pairs.push([row.left, row.right])
    size += chars
  }
  return pairs
}

/**
 * Запрос на перевод партии терминов.
 *
 * Требования к ответу перечислены в инструкции явно: слева — строка байт в байт как
 * дана (иначе перевод не с чем сопоставить), подстановки `{имя}` остаются как есть
 * (панель подставляет их потом), ответ — только JSON-массив пар.
 *
 * Данные уходят объектом с двумя ключами, а не голым массивом: `strings` — то, что
 * надо перевести, `glossary` — уже принятые пары. Голый массив оставлял модели только
 * один источник слов, и в соседних партиях одно понятие получало разные переводы;
 * ключи называют роль каждой части, поэтому двусмысленности в запросе нет.
 * @param terms - английские строки набора.
 * @param language - язык, на который переводим.
 * @param glossary - уже принятые пары (см. `glossaryPairs`); пусто — словаря нет.
 * @returns системная инструкция и JSON-объект с терминами и словарём.
 */
export function fillPrompt(
  terms: readonly string[],
  language: EngramLanguage,
  glossary: readonly FillPair[] = [],
): FillPrompt {
  // Языка вне вшитой таблицы имён может не быть — тогда называем его кодом.
  const name = LANGUAGE_NAMES[language] ?? language
  return {
    system: message('llm.dictionaryFillSystem', { language: name }),
    userText: JSON.stringify({ strings: terms, glossary }, null, 1),
  }
}

/** Кусок текста между первой открывающей и последней закрывающей скобкой: проза вокруг не мешает. */
function jsonSlice(text: string, open: string, close: string): string | undefined {
  const start = text.indexOf(open)
  const end = text.lastIndexOf(close)
  if (start < 0 || end <= start) return undefined
  return text.slice(start, end + 1)
}

/** Разобранные JSON-значения ответа: массив и/или объект — что в нём оказалось. */
function jsonValues(text: string): unknown[] {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const candidate = (fenced?.[1] ?? text).trim()
  const values: unknown[] = []
  for (const [open, close] of [['[', ']'], ['{', '}']] as const) {
    const slice = jsonSlice(candidate, open, close)
    if (slice === undefined) continue
    try {
      const parsed: unknown = JSON.parse(slice)
      if (typeof parsed === 'object' && parsed !== null) values.push(parsed)
    } catch {
      // Кусок не разобрался (проза со скобкой, обрыв на пределе вывода) — пробуем другой.
    }
  }
  return values
}

/**
 * Законченные скобочные отрезки текста — на любой глубине, включая вложенные.
 *
 * Нужны, когда ответ оборван на пределе вывода: целиком он не парсится (нет последней
 * скобки), а готовые пары внутри уже есть. Баланс скобок считается с учётом строк,
 * поэтому скобка внутри перевода отрезок не рвёт.
 * @param text - ответ модели.
 * @returns значения всех отрезков, которые разобрались как JSON.
 */
function completeSegments(text: string): unknown[] {
  const out: unknown[] = []
  const stack: string[] = []
  const starts: number[] = []
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') { inString = true; continue }
    if (char === '[' || char === '{') {
      stack.push(char === '[' ? ']' : '}')
      starts.push(index)
      continue
    }
    if (char !== ']' && char !== '}') continue
    if (stack.length === 0 || stack[stack.length - 1] !== char) {
      // Проза со скобкой: баланс потерян, всё накопленное — уже не пара.
      stack.length = 0
      starts.length = 0
      continue
    }
    stack.pop()
    const start = starts.pop()
    if (start === undefined) continue
    try {
      out.push(JSON.parse(text.slice(start, index + 1)))
    } catch {
      // Внутри не JSON (проза или оборванная строка) — отрезок не наш.
    }
  }
  return out
}

/** Пара из двух строк: массив `["english", "перевод"]` или объект с двумя значениями. */
function pairOf(value: unknown): readonly [unknown, unknown] | undefined {
  if (Array.isArray(value)) return value.length === 2 ? [value[0], value[1]] : undefined
  if (typeof value !== 'object' || value === null) return undefined
  const strings = Object.values(value)
  return strings.length === 2 ? [strings[0], strings[1]] : undefined
}

/**
 * Пары, которые можно спасти из ответа любой формы.
 *
 * Сюда попадает то, чего не взял основной разбор: оборванный массив пар (`[["a","b"],
 * ["c","d"],["e` — внешние скобки не закрылись) и оборванная карта (`{"a":"б","c":`).
 * Строки карты восстанавливаются через JSON.parse по самой записи, поэтому escape-
 * последовательности разбираются так же, как в целом ответе.
 * @param text - ответ модели.
 * @returns найденные пары в порядке текста; пригодность проверяет вызывающий.
 */
function salvagePairs(text: string): readonly (readonly [unknown, unknown])[] {
  const out: (readonly [unknown, unknown])[] = []
  for (const value of completeSegments(text)) {
    const pair = pairOf(value)
    if (pair !== undefined) out.push(pair)
  }
  const entry = /"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g
  for (let match = entry.exec(text); match !== null; match = entry.exec(text)) {
    const left = match[1]
    const right = match[2]
    if (left === undefined || right === undefined) continue
    try {
      out.push([JSON.parse(`"${left}"`), JSON.parse(`"${right}"`)])
    } catch {
      // Битая escape-последовательность: такую строку не восстановить.
    }
  }
  return out
}

/**
 * Разобрать ответ модели в пары «строка → перевод».
 *
 * Форма ответа не наша забота: инструкция просит массив пар, но модель отвечает и картой,
 * и списком переводов по порядку, и объектами со своими именами полей («term/translation»,
 * «source/target»). Терять из-за формы весь ответ нельзя — человек нажал «Заполнить ИИ»
 * и ждёт переводов, а не объяснений. Поэтому принимается любой из этих видов, а решение
 * о пригодности пары одно и то же: строка должна быть из запроса, перевод непустой и не
 * равный английскому тексту (совпадение значит «перевести не удалось», и записывать его
 * как перевод нельзя — тогда «уже переведено» не отличить от «перевода нет»).
 * @param text - ответ модели.
 * @param terms - то, что спрашивали: ответ вне списка не принимается.
 * @returns пары в порядке ответа модели.
 */
export function parseFillAnswer(text: string, terms: readonly string[]): readonly FillPair[] {
  const asked = new Set(terms)
  const out: FillPair[] = []
  const seen = new Set<string>()

  const accept = (left: unknown, right: unknown): void => {
    if (typeof left !== 'string' || typeof right !== 'string') return
    if (!asked.has(left) || seen.has(left)) return
    const value = right.trim()
    if (value === '' || value === left) return
    seen.add(left)
    out.push([left, value])
  }

  /** Список переводов по порядку запроса: модель отвечает и так, без левых строк. */
  const byOrder = (list: readonly unknown[]): void => {
    if (list.length !== terms.length || !list.every(item => typeof item === 'string')) return
    list.forEach((item, index) => { accept(terms[index], item) })
  }

  /** Карта: ключ — английская строка (или обёртка с массивом переводов внутри). */
  const fromRecord = (record: Record<string, unknown>, depth: number): void => {
    for (const [left, right] of Object.entries(record)) {
      if (typeof right === 'string') { accept(left, right); continue }
      if (Array.isArray(right)) { byOrder(right); continue }
      if (depth > 0 && typeof right === 'object' && right !== null) {
        fromRecord(right as Record<string, unknown>, depth - 1)
      }
    }
  }

  /**
   * Объект вместо пары: имена полей не угадываем — берём ту строку, которая совпала
   * со спрошенной. Так принимается и `{"term": "...", "translation": "..."}`, и
   * `{"source": "...", "target": "..."}`, и `{"English string": "перевод"}`.
   */
  const fromItem = (item: Record<string, unknown>): void => {
    const strings = Object.values(item).filter((value): value is string => typeof value === 'string')
    if (strings.length === 2) {
      const [first, second] = strings as [string, string]
      if (asked.has(first) && !asked.has(second)) accept(first, second)
      else if (asked.has(second) && !asked.has(first)) accept(second, first)
      return
    }
    if (strings.length === 1) {
      const only = Object.entries(item)[0]
      if (only !== undefined && typeof only[1] === 'string') accept(only[0], only[1])
    }
  }

  for (const value of jsonValues(text)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (Array.isArray(item)) accept(item[0], item[1])
        else if (typeof item === 'object' && item !== null) fromItem(item as Record<string, unknown>)
      }
      // Одна пара без внешнего массива: `["English", "перевод"]`.
      if (out.length === 0 && value.length === 2) accept(value[0], value[1])
      if (out.length === 0) byOrder(value)
      continue
    }
    fromRecord(value as Record<string, unknown>, 1)
  }
  // Оборванный ответ: целиком он не разобрался, но готовые пары в тексте есть — берём их.
  // Порядок здесь уже не важен, повторно принятое отсекает `seen`.
  for (const [left, right] of salvagePairs(text)) accept(left, right)
  return out
}

/** Короткий срез ответа для сообщения об ошибке: без него «переводов нет» — тупик. */
export function answerSnippet(text: string, limit = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

/**
 * Проверка партии перед запросом: пустая партия — не ошибка, а отсутствие работы.
 * @param terms - английские строки партии.
 * @returns нормализованный список терминов.
 */
export function fillBatch(terms: readonly string[]): readonly string[] {
  const list: string[] = []
  const seen = new Set<string>()
  for (const term of terms) {
    const value = term.trim()
    if (value === '' || seen.has(value)) continue
    // Строки из одних подстановок переводить нечего — см. needsTranslation.
    if (!needsTranslation(value)) continue
    seen.add(value)
    list.push(value)
  }
  if (list.length > FILL_REQUEST_MAX) {
    throw new EngramError('DICTIONARY_FILL_TOO_MANY', message('llm.dictionaryFillTooMany', {
      n: String(list.length),
      max: String(FILL_REQUEST_MAX),
    }))
  }
  return list
}
