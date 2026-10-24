/**
 * Словарь переводов серверных сообщений, читаемый из файла.
 *
 * Тексты сообщений живут в коде английским набором (`./catalog/*`), переводы —
 * в файлах `i18n/<язык>.txt`. Слева стоит ровно та строка, что написана в коде
 * (набор `en`), справа — её перевод; отображение строится по тексту, а не по
 * ключу, поэтому словарь можно править, не зная внутренних имён ключей.
 *
 * Формат строки: `<слева><TAB><справа>`. Экранирование:
 * `\\` — обратный слэш, `\n` — перевод строки, `\r` — CR, `\t` — таб,
 * `\s` — значимый пробел на краю поля, `\/` — косая черта, которой иначе
 * начиналась бы строка-комментарий. Таб выбран разделителем потому, что
 * пробелы встречаются в текстах постоянно, а табы — нет.
 *
 * Строка, начинающаяся с `//`, — комментарий; пустые строки пропускаются;
 * файл может быть в CRLF и с BOM. Разбор не бросает исключений: любая
 * странность попадает в отчёт о дефектах, а сама строка либо принимается,
 * либо пропускается. Неполный словарь безопасен — недостающая строка просто
 * не участвует, и сообщение остаётся английским.
 *
 * Пустая правая часть — не всегда дефект: заготовка словаря состоит из строк
 * «ключ + пустой перевод». Разбирать так можно только слой, который принадлежит
 * человеку (см. `ParseDictionaryOptions`); в поставке та же строка — дефект.
 *
 * @module @kenz1117/dsh-engram/i18n/dictionary
 */

/** Вид дефекта строки словаря. */
export type DictionaryIssueKind =
  | 'noTab'
  | 'emptyLeft'
  | 'emptyRight'
  | 'badEscape'
  | 'placeholderMismatch'
  | 'duplicate'

/** Жалоба на строку словаря. */
export interface DictionaryIssue {
  /** Номер строки в файле, с единицы. */
  readonly line: number
  readonly kind: DictionaryIssueKind
  /** Человекочитаемое пояснение: что именно не так. */
  readonly detail: string
}

/**
 * Как разбирать файл.
 *
 * Пользовательский слой вправе хранить строку «ключ + пустой перевод»: так лежит
 * заготовка словаря, которую пишет кнопка «Создать», и так выглядит строка, в которую
 * человек ещё не вписал перевод. Поставка так не вправе: там пустая правая часть —
 * дефект файла, и он обязан быть назван, а не проглочен.
 */
export interface ParseDictionaryOptions {
  /** Принимать строку без перевода как строку с ключом (по умолчанию — претензия). */
  readonly keepEmptyRight?: boolean
}

/** Разобранный словарь. */
export interface ParsedDictionary {
  /** Английский текст → перевод. При повторе побеждает последняя строка. */
  readonly entries: ReadonlyMap<string, string>
  /**
   * Левые части всех принятых строк, включая строки без перевода.
   *
   * `entries` отвечает на вопрос «какой текст показать», а `keys` — «какая строка
   * есть в файле». Это разные вопросы: заготовка словаря состоит из ключей без
   * переводов, и «строки нет» должно отличаться от «строка есть, перевода нет».
   */
  readonly keys: ReadonlySet<string>
  /** Дефекты; пустой список — файл чистый. */
  readonly issues: readonly DictionaryIssue[]
  /** Сколько строк данных (не комментариев и не пустых) удалось принять. */
  readonly accepted: number
  /** Сколько строк данных встретилось всего. */
  readonly seen: number
}

/** Раскрытие экранированной последовательности. */
const UNESCAPE: Readonly<Record<string, string>> = {
  '\\': '\\',
  n: '\n',
  r: '\r',
  t: '\t',
  s: ' ',
  '/': '/',
}

/**
 * Набор подстановок `{name}` в тексте — для сверки сторон.
 *
 * Класс букв — юникодный, а не `\w`: переводчик, набравший `{счёт}` вместо
 * `{count}`, должен получить замечание, а не тишину. Подстановка в
 * `messages.ts` остаётся ASCII (`\w`), потому что имена параметров в коде
 * латинские: такая строка всё равно не подставится и будет видна как есть.
 */
function placeholders(text: string): string {
  const names = new Set<string>()
  for (const match of text.matchAll(/\{([\p{L}\p{N}_]+)\}/gu)) {
    const name = match[1]
    if (name !== undefined) names.add(name)
  }
  return [...names].sort().join(',')
}

/**
 * Раскрыть экранирование поля.
 * Неизвестная последовательность остаётся как есть и попадает в `bad`:
 * показать `\q` в переводе полезнее, чем молча его проглотить.
 */
function unescapeField(field: string): { value: string; bad: readonly string[] } {
  if (!field.includes('\\')) return { value: field, bad: [] }
  const bad: string[] = []
  let value = ''
  for (let i = 0; i < field.length; i += 1) {
    const char = field[i]
    if (char !== '\\') {
      value += char
      continue
    }
    const next = field[i + 1]
    const expanded = next === undefined ? undefined : UNESCAPE[next]
    if (expanded === undefined) {
      bad.push(next === undefined ? '\\' : `\\${next}`)
      value += char
      continue
    }
    value += expanded
    i += 1
  }
  return { value, bad }
}

/**
 * Разобрать файл словаря.
 * Чистый разбор без ввода-вывода: тексты читает вызывающий.
 */
export function parseDictionary(text: string, options?: ParseDictionaryOptions): ParsedDictionary {
  const keepEmptyRight = options?.keepEmptyRight === true
  const entries = new Map<string, string>()
  const keys = new Set<string>()
  const issues: DictionaryIssue[] = []
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const rawLines = body.split('\n')
  let seen = 0

  for (let index = 0; index < rawLines.length; index += 1) {
    const lineNo = index + 1
    const raw = rawLines[index] ?? ''
    // CRLF: единственный CR в конце строки — разделитель, а не текст.
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.trim() === '') continue
    if (line.startsWith('//')) continue

    seen += 1
    const tab = line.indexOf('\t')
    if (tab < 0) {
      issues.push({ line: lineNo, kind: 'noTab', detail: line.slice(0, 80) })
      continue
    }

    const left = unescapeField(line.slice(0, tab))
    const right = unescapeField(line.slice(tab + 1))
    if (left.bad.length > 0) {
      issues.push({ line: lineNo, kind: 'badEscape', detail: `слева: ${left.bad.join(' ')}` })
    }
    if (right.bad.length > 0) {
      issues.push({ line: lineNo, kind: 'badEscape', detail: `справа: ${right.bad.join(' ')}` })
    }
    if (left.value === '') {
      issues.push({ line: lineNo, kind: 'emptyLeft', detail: 'пустая левая часть' })
      continue
    }
    if (right.value === '') {
      // Строка без перевода: в поставке это дефект, в пользовательском слое — заготовка.
      if (!keepEmptyRight) {
        issues.push({ line: lineNo, kind: 'emptyRight', detail: left.value.slice(0, 60) })
        continue
      }
      if (keys.has(left.value)) {
        issues.push({ line: lineNo, kind: 'duplicate', detail: left.value.slice(0, 60) })
      }
      keys.add(left.value)
      continue
    }
    if (placeholders(left.value) !== placeholders(right.value)) {
      issues.push({
        line: lineNo,
        kind: 'placeholderMismatch',
        detail: `{${placeholders(left.value)}} против {${placeholders(right.value)}}: ${left.value.slice(0, 60)}`,
      })
    }
    if (keys.has(left.value)) {
      issues.push({ line: lineNo, kind: 'duplicate', detail: left.value.slice(0, 60) })
    }
    keys.add(left.value)
    entries.set(left.value, right.value)
  }

  return { entries, keys, issues, accepted: keys.size, seen }
}
