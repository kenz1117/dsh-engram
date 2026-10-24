/**
 * Состояние базы дворца: на чём она стоит и что с ней будет делать кнопка.
 *
 * Разбор отделён от чтения базы и от отрисовки: здесь только правило, по которому
 * факты о базе превращаются в одно из семи состояний и в одно действие. Правило
 * должно быть одно — и оно должно жить там, где принимается решение, а не в
 * разметке карточки и не в двух местах сразу.
 *
 * Факты (метка из `meta`, число записей, длины векторов) приносит `./base-census`,
 * ожидание (какая метка и какая модель должны быть) — `./models` плюс выбор модели
 * в `src/embedder/select.ts`. Здесь нет ни базы, ни реестра, ни языка интерфейса:
 * поэтому правило проверяется тестом без диска и без sqlite.
 *
 * Область счёта состояний 4 и 5 — область объявления схемы (`registry/schema.json`):
 * у `nodes` это `status = 'active'`, у `observations` — все строки. Ровно эту область
 * читает поиск (`status = 'active' AND embedding IS NOT NULL`), поэтому запись вне
 * области без вектора дефектом не считается: вектора ей не нужны.
 *
 * @module @kenz1117/dsh-engram/registry/base-state
 */

import { isLanguageCode, type EngramLanguage } from '../i18n/language.ts'
import { bindingLabel } from './models.ts'

/**
 * Ключ `meta`, под которым в базе лежит метка модели: значение вида `ru-minilm-l12`.
 *
 * Метка — единственное, что мы пишем в чужую базу (решение 20.10): ни размерности,
 * ни времени. Размерность следует из каталога по метке, а копия дала бы второй
 * источник правды, который рано или поздно разойдётся с первым.
 */
export const MODEL_LABEL_KEY = 'model_label'

/**
 * Язык, на котором стоят базы дворца, — по меткам `meta.model_label` (решение 21.10).
 *
 * Метка — единственное место, где записано «чья это база» (`bindingLabel`), поэтому
 * читается она, а не длина вектора. Правило живёт рядом с форматом метки: если метка
 * когда-нибудь изменится, здесь и надо будет править.
 *
 * Три исхода: язык (все подписанные базы на нём), `mixed` (подписаны разными языками —
 * одна установка не может жить на двух языках одновременно) и `null` (метки нет ни
 * у одной базы: сверять нечего, спорить не о чем).
 * @param labels - метки баз; null у базы без метки.
 * @returns Язык баз, `mixed` либо `null`.
 */
export function languageOfLabels(labels: readonly (string | null)[]): EngramLanguage | 'mixed' | null {
  const found = new Set<EngramLanguage>()
  for (const label of labels) {
    if (label === null) continue
    // Язык — это часть метки до первого дефиса; всё, что дальше, — имя модели, и
    // оно языком не является (правило 21.10: «название модели тут не показатель»).
    // Режем именно по первому дефису, потому что дефисы есть и в метке модели
    // (`ru-minilm-l12`), и в подтеге языка (`zh-Hans` — тогда останется `zh`).
    const cut = label.indexOf('-')
    if (cut <= 0) continue
    const code = label.slice(0, cut)
    if (!isLanguageCode(code)) continue
    found.add(code)
  }
  if (found.size === 0) return null
  const [first] = [...found]
  return found.size === 1 && first !== undefined ? first : 'mixed'
}

/** Состояние базы; перечень заморожен на семи (см. план, блок Б). */
export type BaseStateId =
  /** 1. Базы нет: файла ещё не создали (создаёт код автора при подключении). */
  | 'absent'
  /** 2. База пустая: записей в области схемы нет — метку ставить не на чем. */
  | 'empty'
  /** 3. Норма: метка есть, она про выбранную модель, все векторы той же длины. */
  | 'normal'
  /** 4. Часть записей без вектора. */
  | 'missing-vectors'
  /** 5. Пересортица: длина вектора не совпадает с меткой. */
  | 'mixed-dims'
  /** 6. Метка есть, но модель не та, которой будем писать. */
  | 'other-model'
  /** 7. Метки нет. */
  | 'no-label'

/** Что делает кнопка при этом состоянии. */
export type BaseActionId =
  /** Ничего: состояние либо норма, либо ещё не наше дело. */
  | 'none'
  /** Записать метку модели — единственное, что мы пишем в базу на этом этапе. */
  | 'write-label'
  /** Пересчёт векторов на целевую модель (этап 2 блока Б). */
  | 'convert'
  /** Дозаполнить векторы записям без вектора (этап 2 блока Б). */
  | 'repair'

/** Сколько записей какой длины: гистограмма области схемы. */
export interface DimCount {
  readonly dims: number
  readonly rows: number
}

/** Что фактически лежит в базе. Приносится `./base-census`, здесь не добывается. */
export interface BaseFacts {
  /** Файл базы существует. */
  readonly exists: boolean
  /** Метка из `meta`; нет ключа — undefined. */
  readonly label: string | undefined
  /** Записей в области объявления схемы. */
  readonly rows: number
  /** Из них без вектора. */
  readonly missing: number
  /** Длины векторов в области схемы (порядок не важен — правило упорядочит само). */
  readonly dims: readonly DimCount[]
}

/** Строка каталога моделей в том виде, в каком она нужна правилу. */
export interface CatalogModel {
  readonly id: string
  readonly label: string | undefined
  /** Объявленная размерность; у удалённой модели её нет. */
  readonly dimensions: number | undefined
}

/** Чего мы ждём от базы: метка и модель, которой пишем. */
export interface BaseTarget {
  /** Метка базы для выбранной модели и языка (`ru-minilm-l12`); нечем собрать — undefined. */
  readonly label: string | undefined
  readonly model: CatalogModel | undefined
}

/** Разбор базы: состояние, действие и числа, из которых это следует. */
export interface BaseVerdict {
  readonly state: BaseStateId
  readonly action: BaseActionId
  /** Метка, которая лежит в базе; нет — undefined. */
  readonly label: string | undefined
  /** Метка, которую плагин поставит или ожидает. */
  readonly target: string | undefined
  readonly rows: number
  readonly missing: number
  /** Записей области с длиной, отличной от ожидаемой. */
  readonly foreign: number
  /** Длины векторов по убыванию числа записей. */
  readonly dims: readonly number[]
  /** Модель, которой, по данным, заполнена база (при отсутствии метки — предполагаемая). */
  readonly model: CatalogModel | undefined
}

/** Гистограмма по убыванию: преобладающая длина — первая (она же «чья это база»). */
function histogram(dims: readonly DimCount[]): readonly DimCount[] {
  return [...dims]
    .filter(row => Number.isInteger(row.dims) && row.dims > 0 && row.rows > 0)
    .sort((left, right) => right.rows - left.rows || left.dims - right.dims)
}

/**
 * Предположить модель по данным: длина векторов называет модель однозначно, пока
 * в каталоге ровно одна модель такой длины. Совпадение с целевой моделью главнее
 * порядка в каталоге — «предположили то же, чем и пишем» не должно зависеть от
 * того, как отсортирован файл каталога.
 * @param catalog - строки каталога.
 * @param dims - преобладающая длина векторов базы; неизвестна — undefined.
 * @param target - выбранная модель (кандидат по умолчанию).
 * @returns предполагаемая модель; ни одна не подходит — целевая (или undefined).
 */
export function guessModel(
  catalog: readonly CatalogModel[],
  dims: number | undefined,
  target: CatalogModel | undefined,
): CatalogModel | undefined {
  if (dims === undefined) return target
  const fits = catalog.filter(row => row.dimensions === dims)
  if (fits.length === 0) return target
  return fits.find(row => row.id === target?.id) ?? fits[0]
}

/**
 * Разобрать состояние базы по фактам.
 *
 * Порядок проверок — от «нечего решать» к «всё в порядке»: нет базы, пустая база,
 * нет метки (её надо поставить, и только потом судить о векторах), чужая метка,
 * пересортица, записи без вектора, норма. Порядок важен: пересортицу нельзя
 * объявлять раньше, чем выяснится, чья это база, иначе чужая модель будет
 * выглядеть как испорченные векторы.
 * @param input - факты о базе, ожидание и каталог моделей для предположения.
 * @returns состояние, действие и числа, из которых они следуют.
 */
export function judgeBase(input: {
  readonly facts: BaseFacts
  readonly target: BaseTarget
  readonly language: string
  readonly catalog: readonly CatalogModel[]
}): BaseVerdict {
  const { facts, target, language, catalog } = input
  const dims = histogram(facts.dims)
  const majority = dims[0]?.dims
  const base = {
    label: facts.label,
    target: target.label,
    rows: facts.rows,
    missing: facts.missing,
    dims: dims.map(row => row.dims),
  }

  if (!facts.exists) {
    return { ...base, state: 'absent', action: 'none', foreign: 0, model: undefined }
  }
  if (facts.rows === 0) {
    return { ...base, state: 'empty', action: 'none', foreign: 0, model: target.model }
  }

  // Метки нет: сначала предполагаем модель по длине векторов, и только если
  // предположение совпало с той моделью, которой пишем, — метка ставится молча,
  // без пересчёта. Иначе это перевод базы, а не подпись.
  if (facts.label === undefined || facts.label === '') {
    const guessed = guessModel(catalog, majority, target.model)
    const same = guessed !== undefined && target.model !== undefined && guessed.id === target.model.id
    return { ...base, state: 'no-label', action: same ? 'write-label' : 'convert', foreign: 0, model: guessed }
  }

  const byLabel = catalog.find(row => row.label !== undefined && bindingLabel(language, row.label) === facts.label)
  if (target.label === undefined || facts.label !== target.label) {
    return {
      ...base,
      state: 'other-model',
      action: 'convert',
      foreign: countForeign(dims, byLabel?.dimensions),
      model: byLabel ?? target.model,
    }
  }

  const expected = (byLabel ?? target.model)?.dimensions
  const foreign = countForeign(dims, expected)
  if (foreign > 0) {
    return { ...base, state: 'mixed-dims', action: 'convert', foreign, model: byLabel ?? target.model }
  }
  if (facts.missing > 0) {
    return { ...base, state: 'missing-vectors', action: 'repair', foreign: 0, model: byLabel ?? target.model }
  }
  return { ...base, state: 'normal', action: 'none', foreign: 0, model: byLabel ?? target.model }
}

/**
 * Записей чужой длины. Ожидаемая длина известна (метка указывает на строку
 * каталога) — считаем всё, что ей не равно; неизвестна — считаем всё, кроме
 * преобладающей: «чужое» тогда определяют сами данные.
 */
function countForeign(dims: readonly DimCount[], expected: number | undefined): number {
  if (expected !== undefined) {
    return dims.reduce((sum, row) => (row.dims === expected ? sum : sum + row.rows), 0)
  }
  return dims.slice(1).reduce((sum, row) => sum + row.rows, 0)
}

/**
 * Какую метку поставить базе при открытии — молча, без человека и без кнопки.
 *
 * Без этого подписывала только починка, и любая новая база жила без метки до первого
 * нажатия «Выполнить», а карточка всё это время честно называла её «требует ремонта»
 * (решение 22.10: база подписывается при создании).
 *
 * Пустая база получает метку сразу: писать в неё будет та самая модель, и спорить
 * не с чем. У непустой базы решает то же правило, что у кнопки (`judgeBase`):
 * подпись ставится только когда данные уже лежат на целевой модели. Чужая модель или
 * пересортица векторов метки не получают — там нужен пересчёт, а подпись соврала бы.
 * @param input - свежие факты о базе (до записи) и ожидание по метке.
 * @returns метка для `meta`; undefined — подписывать нечего.
 */
export function labelToStamp(input: {
  readonly facts: BaseFacts
  readonly target: BaseTarget
  readonly language: string
  readonly catalog: readonly CatalogModel[]
}): string | undefined {
  const { facts, target } = input
  if (!facts.exists || target.label === undefined) return undefined
  if (facts.label !== undefined && facts.label !== '') return undefined
  if (facts.rows === 0) return target.label
  return judgeBase(input).action === 'write-label' ? target.label : undefined
}
