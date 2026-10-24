/**
 * Мост к хостовому сервису настроек: чтение preference интерфейса и запись языка дворца.
 *
 * Зачем мост отдельным модулем: сам сервис — хостовый, в тестах его нет, а правила
 * «какой язык считается объявленным» и «как найти свою запись» проверить хочется
 * без поднятия хоста. Поэтому здесь только формы данных и чистые функции над ними;
 * всё, что требует `ctx`, остаётся в `src/index.ts`.
 *
 * Что известно про сервис (по коду `@deepseek-ai/dsh-settings` и `dsh-client-locale`):
 * - `describe()` отдаёт формы только тех записей, у которых есть volatile-поля,
 *   с ключом `ns` = идентификатор записи в профиле и номером ревизии;
 * - `update(ns, patch, revision)` вливает поля в конфигурацию записи и сохраняет её
 *   в профильном patch; значения применяются на живом фибере без перемонтирования;
 * - интерфейсный язык живёт в записи `locale` в поле `preference`.
 * @module @kenz1117/dsh-engram/settings-bridge
 */

/** Запись настройки языка в `preference` интерфейса. */
export const LOCALE_NAMESPACE = 'locale'

/** Поле, в котором лежит выбранный язык интерфейса. */
export const LOCALE_PREFERENCE_FIELD = 'preference'

/** Поле нашей собственной настройки — по нему находим свою запись в `describe()`. */
export const PALACE_LANGUAGE_FIELD = 'language'

/** Форма записи в том виде, в каком она нужна нам (подмножество ответа `describe()`). */
export interface SettingsEntryView {
  /** Идентификатор записи в профиле. */
  readonly ns: string
  /** Ревизия: её требует `update`, чтобы не затереть чужую правку. */
  readonly revision: number
  /** Живые значения volatile-полей. */
  readonly value?: Record<string, unknown> | undefined
  /** Схема формы: по ней отличаем свою запись от чужой. */
  readonly schema?: { readonly properties?: Record<string, unknown> | undefined } | undefined
}

/** Сервис настроек в узком виде — ровно те два метода, которые нам нужны. */
export interface SettingsServiceView {
  describe(options?: { readonly redactSecrets?: boolean }): readonly SettingsEntryView[]
  update(ns: string, patch: Record<string, unknown>, expectedRevision: number): Promise<void>
}

/**
 * Язык интерфейса из формы записи `locale`.
 * @param entries - ответ `describe()`.
 * @returns Строка `preference` либо `undefined`, если поле не задано.
 */
export function interfacePreference(entries: readonly SettingsEntryView[]): string | undefined {
  const locale = entries.find(entry => entry.ns === LOCALE_NAMESPACE)
  const raw = locale?.value?.[LOCALE_PREFERENCE_FIELD]
  return typeof raw === 'string' && raw !== '' ? raw : undefined
}

/**
 * Найти свою запись: в её форме есть поле языка дворца — и оно там единственное.
 *
 * Ищем не по имени пакета, а по составу формы: идентификатор записи в профиле —
 * дело хоста, и полагаться на конкретную строку значило бы зависеть от того, как
 * пользователь назвал запись.
 *
 * Условие «поле единственное» — защита, а не украшение: у чужого плагина тоже может
 * быть поле `language`, и записать свой язык в его настройку хуже, чем не записать
 * вовсе. Поэтому формы с дополнительными полями не рассматриваются, а если
 * подходящих несколько — не берём никакую. Появится у нас второе volatile-поле,
 * это правило придётся назвать явно, а не расширять догадкой.
 * @param entries - ответ `describe()`.
 * @returns Запись с ревизией либо `undefined`.
 */
export function findPalaceEntry(entries: readonly SettingsEntryView[]): { ns: string; revision: number } | undefined {
  const exact = entries.filter(entry => {
    const fields = Object.keys(entry.schema?.properties ?? {})
    return fields.length === 1 && fields[0] === PALACE_LANGUAGE_FIELD
  })
  const picked = exact.length === 1 ? exact[0] : undefined
  return picked === undefined ? undefined : { ns: picked.ns, revision: picked.revision }
}

/** Причина, по которой язык не записался; `undefined` — записан. */
export type PalaceWriteFailure = string | undefined

/**
 * Записать язык дворца одной попыткой.
 *
 * Форму своего плагина сервис отдаёт только для работающего фибера, поэтому «своей
 * записи нет» — это ещё не приговор: см. `writePalaceLanguageWithRetry`.
 * @param settings - сервис настроек; undefined — сервиса в хосте нет.
 * @param language - язык, который надо записать.
 * @returns Причина отказа либо `undefined`.
 */
export async function writePalaceLanguage(
  settings: SettingsServiceView | undefined,
  language: string,
): Promise<PalaceWriteFailure> {
  if (settings === undefined) return 'settings service is absent — palace language stays for this process only'
  let entries: readonly SettingsEntryView[]
  try {
    entries = settings.describe()
  } catch (error) {
    return `could not read settings forms — ${String(error)}`
  }
  const own = findPalaceEntry(entries)
  if (own === undefined) return 'own settings entry not found — palace language stays for this process only'
  try {
    await settings.update(own.ns, { language }, own.revision)
    return undefined
  } catch (error) {
    return `could not persist palace language — ${String(error)}`
  }
}

/** Ожидание между попытками: подменяется в тестах, чтобы не ждать по-настоящему. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/**
 * Записать язык дворца, повторяя попытку коротким окном.
 *
 * Зачем повтор: `describe()` отдаёт форму только для фибера в состоянии «работает»,
 * а определение языка считается внутри `apply` — то есть до того, как наш плагин
 * стал работающим. Один отказ там означает «ещё рано», а не «записать некуда».
 * Окно ограничено: по его истечении причина уходит вызывающему, и тот говорит в лог,
 * что язык остался на этот процесс. Отмену даёт `stopped` — выгруженный плагин
 * не должен продолжать писать в настройки.
 * @param input - откуда взять сервис, что записать, сколько и с какой паузой пробовать.
 * @returns Причина отказа либо `undefined`.
 */
export async function writePalaceLanguageWithRetry(input: {
  readonly settings: () => SettingsServiceView | undefined
  readonly language: string
  readonly attempts: number
  readonly delayMs: number
  readonly wait?: (ms: number) => Promise<void>
  readonly stopped?: () => boolean
}): Promise<PalaceWriteFailure> {
  const wait = input.wait ?? sleep
  let reason: PalaceWriteFailure = 'no attempts made'
  for (let attempt = 0; attempt < Math.max(1, input.attempts); attempt += 1) {
    if (input.stopped?.() === true) return 'persistence stopped: plugin unloaded'
    reason = await writePalaceLanguage(input.settings(), input.language)
    if (reason === undefined) return undefined
    if (attempt + 1 < input.attempts) await wait(input.delayMs)
  }
  return reason
}
