/**
 * Язык вывода — серверная половина плагина.
 *
 * Клиентская половина язык не выбирает: она отдаёт хосту свои словари
 * (см. src/client/locales), а нужный выбирает рендерер по настройке языка DSH.
 * У серверной половины такого сервиса нет — тексты инструментов формируются
 * задолго до отрисовки, — поэтому язык определяется здесь: из настройки плагина,
 * а при значении «auto» — из системной локали.
 *
 * Язык — это **код**, а не член закрытого перечня: `zh`, `en`, `ru`, `fr`,
 * `zh-Hans`. Какие языки плагин знает, решает реестр (`registry/languages.json`,
 * см. ../registry/languages), а здесь живёт только синтаксис кода и поведение по
 * умолчанию. Прежняя тройка `zh|en|ru`, вбитая в TypeScript, снята 21.10: из-за
 * неё четвёртый язык нельзя было добавить данными, а не пересборкой.
 *
 * @module @kenz1117/dsh-engram/i18n/language
 */

import { execFileSync } from 'node:child_process'

/** Код языка: две-три латинские буквы, при желании с подтегами (`zh-Hans`). */
const LANGUAGE_CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/

/**
 * Языки, с которыми плагин приходит: они же действуют, если реестра языков нет.
 *
 * Два из них со вшитыми наборами текстов (`zh` — авторский, `en` — образец
 * полноты), `ru` приходит словарём из файла.
 */
export const BUILTIN_LANGUAGES: readonly string[] = ['zh', 'en', 'ru']

/** Язык вывода: код языка вида `ru` или `zh-Hans`. */
export type EngramLanguage = string

/** Язык, когда системный не распознан или набора для него нет. */
export const FALLBACK_LANGUAGE: EngramLanguage = 'en'

/** Настройка языка: конкретный язык либо автоопределение. */
export type LanguageSetting = 'auto' | EngramLanguage

/**
 * Проверка, что строка — код языка, а не произвольный текст.
 *
 * Это проверка **формы**, а не согласия реестра: «fr» проходит здесь даже если
 * языка дворца с таким кодом ещё нет. Согласие реестра проверяет тот, у кого
 * реестр под рукой (`registry/registry-file.ts`), а форма нужна везде.
 */
export function isLanguageCode(value: string): boolean {
  return LANGUAGE_CODE.test(value)
}

/**
 * Локаль из строки окружения или из системных настроек: `zh_CN.UTF-8` → `zh`.
 *
 * Две тонкости, из-за которых это отдельная функция, а не `split` на месте:
 *
 * 1. **C/POSIX — это «язык не задан», а не «английский».** Node и ICU отдают для
 *    `LANG=C.UTF-8` локаль `en-US`, и плагин на этом садился в английский на любой
 *    неанглийской машине: приложение, запущенное из Finder, наследует именно
 *    `LANG=C.UTF-8`. Пустая строка здесь — честный ответ «прочитать не удалось»,
 *    и решает вызывающий, а не подстановка чужого языка.
 * 2. **База отдельно от подтега.** `zh-Hans-CN` → `zh`, `sr-Latn` → `sr`.
 *
 * @param tag - строка локали в любом из обычных видов.
 * @returns код языка либо пустая строка, если языка в строке нет.
 */
export function parseLocaleTag(tag: string): string {
  const base = tag
    .trim()
    .split('.')[0]
    ?.split('@')[0]
    ?.replace('_', '-')
    .split('-')[0]
    ?.toLowerCase() ?? ''
  if (base === '' || base === 'c' || base === 'posix') return ''
  return base
}

/**
 * Язык системы macOS: тот, что человек выставил в настройках ОС.
 *
 * Читать приходится именно оттуда, а не из переменных процесса: у приложения,
 * запущенного из Dock, переменных нет вовсе (`LANG=C.UTF-8` — это «не задано»),
 * и настоящий язык живёт в `AppleLocale`.
 *
 * @returns код языка либо пустая строка, если прочитать не удалось.
 */
function appleLocaleBase(): string {
  try {
    const out = execFileSync('defaults', ['read', '-g', 'AppleLocale'], {
      encoding: 'utf8',
      timeout: 800,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return parseLocaleTag(out.trim())
  } catch {
    return ''
  }
}

/**
 * Настоящий язык системы, а не локаль процесса.
 *
 * Порядок чтения: переменные окружения (если в них **настоящий** язык — их
 * ставили руками, и это более узкое намерение, чем настройка ОС), затем на macOS
 * — `AppleLocale`, затем — локаль по умолчанию из ICU (`Intl`): на Windows ICU
 * берёт её из `GetUserDefaultLocaleName`, и это единственный надёжный источник —
 * `LC_ALL`/`LC_MESSAGES`/`LANG` там обычно не заданы вовсе (issue #39: без этой
 * ступени китайская Windows читалась как пустая строка и падала в умолчание
 * поставки, снося готовую 512-мерную базу на 384-мерную модель).
 *
 * Нужна там, где важно не «каким словарём мы располагаем», а на каком языке человек
 * на самом деле работает: панель первого старта подставляет язык локали в выбор,
 * а если такого языка у дворца нет — предлагает отдельный выбор «другой язык»
 * (решение 21.10). Здесь ничего не подменяется умолчанием: пустая строка значит
 * «прочитать не удалось», и вызывающий решает сам.
 */
export function systemLocaleBase(): string {
  const fromEnv = parseLocaleTag(process.env.LC_ALL ?? process.env.LC_MESSAGES ?? process.env.LANG ?? '')
  if (fromEnv !== '') return fromEnv
  if (process.platform === 'darwin') {
    const apple = appleLocaleBase()
    if (apple !== '') return apple
  }
  return icuLocaleBase()
}

/**
 * Локаль по умолчанию из ICU: Node (full-icu) резолвит её из настроек ОС —
 * на Windows это региональный формат пользователя (`GetUserDefaultLocaleName`),
 * на Linux/macOS — соответствующие системные источники. Отличать от «локали
 * процесса» больше не нужно: здесь это как раз источник последней надежды, когда
 * переменные окружения пусты, а своего чтения у платформы нет.
 */
export function icuLocaleBase(): string {
  try {
    return parseLocaleTag(Intl.DateTimeFormat().resolvedOptions().locale)
  } catch {
    return ''
  }
}

/**
 * Язык системы. Берётся из Intl: «ru-RU» → «ru».
 * Язык без вшитого набора сводится к языку по умолчанию: показывать пустые
 * подписи хуже, чем показать английские. Реестр здесь не читается — этот слой
 * отвечает только за тексты, которые у плагина действительно есть.
 */
export function systemLanguage(): EngramLanguage {
  const base = systemLocaleBase()
  return BUILTIN_LANGUAGES.includes(base) ? base : FALLBACK_LANGUAGE
}

/** Итоговый язык вывода: «auto» разворачивается в системный язык. */
export function resolveLanguage(setting: LanguageSetting): EngramLanguage {
  return setting === 'auto' ? systemLanguage() : setting
}

/**
 * Язык вывода с учётом умолчания пакета.
 *
 * Настройка главнее умолчания: её назвал пользователь, и «auto» в ней — тоже его
 * выбор, а не отсутствие выбора. Умолчание пакета (служебное поле `default`
 * реестра привязок) главнее системной локали: иначе язык зависел бы от машины,
 * на которой плагин запущен, а не от того, что объявлено выпуском. Умолчание, для
 * которого выпуск не везёт текстов, не принимается — показать английские подписи
 * лучше, чем объявленные, но пустые. Ни настройки, ни умолчания — «auto», то есть
 * язык системы.
 *
 * Почему «с чем приходим», а не «что объявлено в реестре языков»: умолчание — это
 * обещание выпуска, и оно не может опережать поставку. Новый язык приходит явным
 * выбором языка дворца, а не подстановкой из привязок.
 * @param setting - настройка `language`; undefined, если её не задавали.
 * @param packaged - объявленное умолчание пакета; undefined, если его нет.
 * @returns язык вывода; отсутствие поля возвращает поведение к «auto».
 */
export function pickLanguage(setting: LanguageSetting | undefined, packaged: string | undefined): EngramLanguage {
  if (setting !== undefined) return resolveLanguage(setting)
  if (packaged !== undefined && BUILTIN_LANGUAGES.includes(packaged)) return packaged
  return resolveLanguage('auto')
}
