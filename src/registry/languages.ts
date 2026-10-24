/**
 * Реестр языков: какие языки дворца плагин знает и откуда берёт их тексты.
 *
 * Список языков — данные, а не константа в коде. Это следствие того же правила,
 * что и у каталога моделей: язык добавляется файлом, а не пересборкой. Раньше
 * тройка `zh|en|ru` была вбита в TypeScript в четырёх местах (проверка настройки,
 * разбор метки базы, список в панели, набор в `language.ts`), и четвёртый язык
 * требовал правки кода в каждом из них.
 *
 * Что здесь есть у языка, кроме кода:
 * - `label` — как язык называется человеку в списке выбора;
 * - `builtin` — есть ли у плагина вшитый серверный набор текстов. Вшитых два
 *   (`zh` — авторский, `en` — образец полноты), остальные приходят словарём
 *   `<dbDir>/i18n/<код>.txt`. Признак нужен не для красоты: без него нельзя
 *   отличить «язык есть, но переводов нет» от «языка нет вовсе».
 *
 * Разбор не бросает исключений — как и разбор каталога моделей: странность
 * становится замечанием, а строка либо принимается, либо пропускается. Список
 * без файла не пуст: действует встроенный набор, иначе плагин потерял бы язык
 * из-за отсутствующего файла поставки.
 *
 * @module @kenz1117/dsh-engram/registry/languages
 */

// Форма кода и встроенный набор живут в i18n/language.ts: там же, где решается,
// каким языком говорит серверная половина. Здесь — только реестр поверх них.
import { BUILTIN_LANGUAGES, isLanguageCode } from '../i18n/language.ts'

/** Одна строка реестра языков. */
export interface LanguageRecord {
  /** Код языка — то, что попадает в настройку `language` и в метку базы. */
  readonly code: string
  /** Как язык называется человеку в списке выбора. */
  readonly label: string
  /** Есть ли вшитый серверный набор текстов (иначе — словарь из файла). */
  readonly builtin: boolean
}

/** Замечание к файлу реестра: что не так и в чём (виды те же, что у реестра моделей). */
export interface LanguageIssue {
  readonly kind: 'badJson' | 'badShape' | 'badField' | 'duplicateLanguage'
  readonly detail: string
}

/** Что получилось разобрать. */
export interface ParsedLanguages {
  /** Языки в порядке объявления; при отсутствии файла — встроенный набор. */
  readonly languages: readonly LanguageRecord[]
  readonly issues: readonly LanguageIssue[]
}

/** Встроенный набор: он же действует, когда файла нет. */
function builtinRecords(): LanguageRecord[] {
  return BUILTIN_LANGUAGES.map(code => ({
    code,
    label: code,
    // Вшитые наборы есть только у двух языков: русский приходит файлом.
    builtin: code === 'zh' || code === 'en',
  }))
}

/**
 * Разобрать реестр языков.
 * @param text - содержимое `languages.json`; пустая строка равна «файла нет».
 * @returns принятые языки и замечания; исключений не бросает.
 */
export function parseLanguages(text: string): ParsedLanguages {
  const issues: LanguageIssue[] = []
  const trimmed = text.trim()
  if (trimmed === '') return { languages: builtinRecords(), issues }

  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch (error) {
    issues.push({ kind: 'badJson', detail: error instanceof Error ? error.message : String(error) })
    return { languages: builtinRecords(), issues }
  }

  const rows = (raw as { languages?: unknown } | null)?.languages
  if (!Array.isArray(rows)) {
    issues.push({ kind: 'badShape', detail: 'нет массива languages' })
    return { languages: builtinRecords(), issues }
  }

  const seen = new Set<string>()
  const languages: LanguageRecord[] = []
  for (const row of rows) {
    const record = row as { code?: unknown; label?: unknown; builtin?: unknown } | null
    const code = typeof record?.code === 'string' ? record.code : undefined
    if (code === undefined || !isLanguageCode(code)) {
      issues.push({ kind: 'badField', detail: `код: ${String(code)}` })
      continue
    }
    if (seen.has(code)) {
      issues.push({ kind: 'duplicateLanguage', detail: code })
      continue
    }
    seen.add(code)
    const label = typeof record?.label === 'string' && record.label.trim() !== '' ? record.label.trim() : code
    languages.push({ code, label, builtin: record?.builtin === true })
  }

  // Пустой объявленный список — не «языков нет», а испорченный файл: без языков
  // плагин не сможет назвать ни одного дворца, поэтому берём встроенный набор.
  if (languages.length === 0) {
    issues.push({ kind: 'badShape', detail: 'список языков пуст' })
    return { languages: builtinRecords(), issues }
  }
  return { languages, issues }
}

