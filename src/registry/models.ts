/**
 * Реестр моделей и таблица привязок: разбор JSON, отдельно от чтения с диска.
 *
 * Оба реестра лежат в JSON, потому что их пишет не человек: каталог моделей
 * кладёт поставка, привязки — интерфейс по выбору пользователя. Поля берутся по
 * именам, поэтому добавление или удаление поля не сдвигает соседей, а номер
 * версии формата лежит внутри файла и позволяет понять, что файл старый.
 *
 * Кроме строк у привязок есть корневое поле `default` — служебное умолчание
 * пакета: язык, который пакет считает своим. Оно решает, на каком языке плагин
 * говорит, когда пользователь не выбрал язык сам, поэтому его значение и есть
 * умолчание выпуска. Поле временное: когда выбор языка перейдёт интерфейсу, оно
 * станет лишним и его отсутствие вернёт поведение к «auto». У `*` роль другая —
 * это подстановка на случай, когда для языка нет своей строки.
 *
 * Разбор не бросает исключений: любая странность становится замечанием, а
 * строка либо принимается, либо пропускается. Пропуск строки каталога не
 * смертелен — пострадает только выбор этой модели; пропуск строки привязок
 * означает, что язык останется на умолчании.
 *
 * @module @kenz1117/dsh-engram/registry/models
 */

import type { ModelDtype, PoolingMode } from '../embedder/local.ts'
import { isLanguageCode } from '../i18n/language.ts'

/** Способы сведения токенов, которые понимает разбор. */
const POOLING_MODES: readonly PoolingMode[] = ['mean', 'cls']

/** Виды весов, которые понимает разбор (множество transformers.js). */
const DTYPES: readonly ModelDtype[] = ['q8', 'fp32', 'fp16', 'int8', 'uint8', 'q4', 'q4f16', 'bnb4']

/**
 * Метка модели: буквы, цифры, точка, дефис, подчёркивание; до 24 знаков.
 *
 * Предел не косметический: метка ложится в запись о базе и в отчёты, поэтому
 * она должна быть короткой настолько, чтобы её читали целиком, и не содержать
 * пробелов и разделителей строк. Имя с косой чертой или заглавными буквами
 * выдаёт, что в метку положили идентификатор — это замечание, а не норма.
 */
const MODEL_LABEL = /^[a-z0-9][a-z0-9._-]{0,23}$/

/**
 * Метка базы: код языка и имя модели через дефис — `ru-minilm-l12`, `zh-bge-small-zh`.
 *
 * Язык входит в метку потому, что одна и та же многоязычная модель обслуживает
 * несколько языков, и запись о базе должна отвечать «чья это база», не заставляя
 * читателя сопоставлять её со строкой привязок.
 *
 * Собирается здесь, а не в файле привязок: там подстановка `*` — одна строка, а
 * меток из неё получается столько, сколько языков на неё опирается.
 * @param language - код языка базы.
 * @param label - метка модели из каталога (имя самой модели, без языка).
 * @returns метка базы, например `ru-minilm-l12`.
 */
export function bindingLabel(language: string, label: string): string {
  return `${language}-${label}`
}

/** Код языка в привязках: `*` — все остальные, иначе код вида `zh` или `zh-Hans`. */
const LANGUAGE_CODE = /^(\*|[a-z]{2,3}(-[A-Za-z0-9]{2,8})*)$/

/**
 * Код языка без подстановки: умолчанием пакета `*` быть не может — это не язык,
 * а строка «для всех остальных».
 */
const LANGUAGE_ONLY = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/

/**
 * Одна строка каталога моделей.
 *
 * Здесь только свойства самой модели. Всё, что относится к машине или к
 * развёртыванию — каталог кэша, зеркало загрузки, адрес удалённого конца,
 * размер пакета, таймаут, — живёт в настройках: это свойства не модели, и в
 * строке они продублировались бы в каждой строке и разъехались.
 */
export interface ModelRecord {
  readonly id: string
  /**
   * Короткая метка модели — то, чем модель называется в записи о базе.
   *
   * Полный идентификатор (`Xenova/paraphrase-multilingual-MiniLM-L12-v2`) в
   * запись о базе не помещается и человеку ничего не говорит. Метка — это имя
   * самой модели, без языка: одна и та же многоязычная модель служит и русскому,
   * и английскому, поэтому язык в неё зашивать нельзя — язык живёт в привязках.
   */
  readonly label: string | undefined
  readonly pooling: PoolingMode
  readonly dtype: ModelDtype
  /**
   * Объявленная размерность вектора.
   *
   * У локальной модели её можно объявить заранее и упредить несовпадение с уже
   * записанными векторами. У удалённой модели длину вектора задаёт сервер,
   * объявить её нечем — там размерность узнаётся по первому ответу, поэтому
   * поле необязательное.
   */
  readonly dimensions: number | undefined
  /**
   * Языки, которые модель умеет. Пустой список — модель языков не объявила (так
   * бывает у удалённой: обоих её концов не знает никто).
   */
  readonly languages: readonly string[]
}

/** Вид замечания к реестру. */
export type RegistryIssueKind =
  | 'badJson'
  | 'badShape'
  | 'badField'
  | 'futureVersion'
  | 'duplicateId'
  | 'duplicateLabel'
  | 'duplicateLanguage'
  | 'unknownModel'
  | 'unknownLanguage'

/** Замечание к реестру. */
export interface RegistryIssue {
  readonly kind: RegistryIssueKind
  /** Что именно не так, с указанием места. */
  readonly detail: string
}

/** Разобранный каталог моделей. */
export interface ParsedModels {
  /** Идентификатор модели → её свойства. */
  readonly models: ReadonlyMap<string, ModelRecord>
  readonly issues: readonly RegistryIssue[]
}

/** Разобранная таблица привязок. */
export interface ParsedBindings {
  /** Код языка → идентификатор модели. */
  readonly bindings: ReadonlyMap<string, string>
  /** Объявленное умолчание пакета; поле нечитаемо — undefined. */
  readonly default: string | undefined
  readonly issues: readonly RegistryIssue[]
}

/** Разбор корневого объекта: снять BOM, разобрать JSON, убедиться, что это объект. */
function rootObject(text: string, issues: RegistryIssue[]): Record<string, unknown> | undefined {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch (error) {
    issues.push({ kind: 'badJson', detail: error instanceof Error ? error.message : String(error) })
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push({ kind: 'badShape', detail: 'корень — не объект' })
    return undefined
  }
  return value as Record<string, unknown>
}

/** Номер версии формата, который понимает этот код. */
const SUPPORTED_FORMAT_VERSION = 1

/**
 * Сверить номер версии формата внутри файла.
 *
 * Файл новее кода означает, что его писал более новый плагин: читать его
 * наугад опаснее, чем сказать об этом. Отсутствие номера ошибкой не считается —
 * файл без номера считается первой версией.
 */
function checkVersion(root: Record<string, unknown>, issues: RegistryIssue[]): void {
  const value = root.formatVersion
  if (value === undefined) return
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    issues.push({ kind: 'badField', detail: `formatVersion = ${String(value)}` })
    return
  }
  if (value > SUPPORTED_FORMAT_VERSION) {
    issues.push({ kind: 'futureVersion', detail: `formatVersion ${value} > ${SUPPORTED_FORMAT_VERSION}` })
  }
}

/** Поле-массив внутри корневого объекта. */
function arrayField(
  root: Record<string, unknown>,
  name: string,
  issues: RegistryIssue[],
): readonly unknown[] | undefined {
  const value = root[name]
  if (!Array.isArray(value)) {
    issues.push({ kind: 'badShape', detail: `поле ${name} — не массив` })
    return undefined
  }
  return value
}

/** Непустое строковое поле. */
function textField(row: Record<string, unknown>, name: string): string | undefined {
  const value = row[name]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Умолчание пакета: код языка без подстановки. Нечитаемое поле становится
 * замечанием и пропускается — тогда язык берётся по системной локали, как до
 * появления поля.
 */
function defaultField(root: Record<string, unknown>, issues: RegistryIssue[]): string | undefined {
  const value = root.default
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !LANGUAGE_ONLY.test(value)) {
    issues.push({ kind: 'badField', detail: `default = ${String(value)}` })
    return undefined
  }
  return value
}

/** Разобрать каталог моделей. */
export function parseModels(text: string): ParsedModels {
  const issues: RegistryIssue[] = []
  const models = new Map<string, ModelRecord>()
  const root = rootObject(text, issues)
  if (root === undefined) return { models, issues }
  checkVersion(root, issues)
  const rows = arrayField(root, 'models', issues)
  if (rows === undefined) return { models, issues }

  rows.forEach((row, index) => {
    const at = `models[${index}]`
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      issues.push({ kind: 'badShape', detail: `${at} — не объект` })
      return
    }
    const record = row as Record<string, unknown>
    const id = textField(record, 'id')
    if (id === undefined) {
      issues.push({ kind: 'badField', detail: `${at}.id — не непустая строка` })
      return
    }
    // Метка необязательна: без неё модель зовётся идентификатором. Но если она
    // написана не по форме, строку не принимаем — по метке база находит модель,
    // и молчаливая подмена метки на идентификатор сломала бы эту связь тихо.
    const label = record.label
    if (label !== undefined && (typeof label !== 'string' || !MODEL_LABEL.test(label))) {
      issues.push({ kind: 'badField', detail: `${at}.label = ${String(label)}` })
      return
    }
    if (label !== undefined) {
      for (const existing of models.values()) {
        if (existing.label === label) {
          issues.push({ kind: 'duplicateLabel', detail: label })
          return
        }
      }
    }
    const pooling = textField(record, 'pooling')
    if (pooling === undefined || !POOLING_MODES.includes(pooling as PoolingMode)) {
      issues.push({ kind: 'badField', detail: `${at}.pooling = ${pooling ?? '—'}` })
      return
    }
    const dtype = textField(record, 'dtype')
    if (dtype === undefined || !DTYPES.includes(dtype as ModelDtype)) {
      issues.push({ kind: 'badField', detail: `${at}.dtype = ${dtype ?? '—'}` })
      return
    }
    const dimensions = record.dimensions
    if (dimensions !== undefined && (typeof dimensions !== 'number' || !Number.isInteger(dimensions) || dimensions <= 0)) {
      issues.push({ kind: 'badField', detail: `${at}.dimensions = ${String(dimensions)}` })
      return
    }
    /**
     * Языки, которые модель умеет: их объявляет сама модель, как размерность и
     * сведение. Список необязателен — удалённая модель языков не объявляет.
     *
     * Нужен затем, чтобы панель предлагала завести словарь для языка, который
     * действительно есть чем считать: иначе в выборе оказались бы языки, которых
     * модель не знает, и векторы для них ничего не значили бы.
     */
    const rawLanguages = record.languages
    const languages: string[] = []
    if (rawLanguages !== undefined) {
      if (!Array.isArray(rawLanguages)) {
        issues.push({ kind: 'badField', detail: `${at}.languages — не массив` })
        return
      }
      for (const code of rawLanguages) {
        // Кривой код — замечание, а не отказ строке: остальные языки модели целы.
        if (typeof code !== 'string' || !isLanguageCode(code)) {
          issues.push({ kind: 'badField', detail: `${at}.languages = ${String(code)}` })
          continue
        }
        if (!languages.includes(code)) languages.push(code)
      }
    }
    if (models.has(id)) {
      issues.push({ kind: 'duplicateId', detail: id })
      return
    }
    models.set(id, {
      id,
      label: label as string | undefined,
      pooling: pooling as PoolingMode,
      dtype: dtype as ModelDtype,
      dimensions: dimensions as number | undefined,
      languages,
    })
  })

  return { models, issues }
}

/** Разобрать таблицу привязок. */
export function parseBindings(text: string): ParsedBindings {
  const issues: RegistryIssue[] = []
  const bindings = new Map<string, string>()
  const root = rootObject(text, issues)
  if (root === undefined) return { bindings, default: undefined, issues }
  checkVersion(root, issues)
  const fallback = defaultField(root, issues)
  const rows = arrayField(root, 'bindings', issues)
  if (rows === undefined) return { bindings, default: fallback, issues }

  rows.forEach((row, index) => {
    const at = `bindings[${index}]`
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      issues.push({ kind: 'badShape', detail: `${at} — не объект` })
      return
    }
    const record = row as Record<string, unknown>
    const language = textField(record, 'language')
    if (language === undefined || !LANGUAGE_CODE.test(language)) {
      issues.push({ kind: 'badField', detail: `${at}.language = ${language ?? '—'}` })
      return
    }
    const model = textField(record, 'model')
    if (model === undefined) {
      issues.push({ kind: 'badField', detail: `${at}.model — не непустая строка` })
      return
    }
    // Повтор языка: побеждает последняя строка — так пользовательский слой
    // правит поставку, и так же ведёт себя словарь.
    if (bindings.has(language)) {
      issues.push({ kind: 'duplicateLanguage', detail: language })
    }
    bindings.set(language, model)
  })

  return { bindings, default: fallback, issues }
}

/** Сверить привязки с каталогом: привязка на модель, которой нет, не работает. */
export function checkBindingModels(
  models: ReadonlyMap<string, ModelRecord>,
  bindings: ReadonlyMap<string, string>,
): RegistryIssue[] {
  const issues: RegistryIssue[] = []
  for (const [language, model] of bindings) {
    if (!models.has(model)) {
      issues.push({ kind: 'unknownModel', detail: `${language} → ${model}` })
    }
  }
  return issues
}
