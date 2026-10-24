/**
 * Язык дворца: чистые правила определения — без обращения к сервисам и файлам.
 *
 * Зачем отдельный модуль: по решению 20.10.2026 язык дворца — не настройка «на посмотреть»,
 * а полуавтоматический выключатель, который дворец выставляет сам. Здесь собраны правила,
 * по которым он это делает: из чего берётся сигнал, чей голос главнее и когда решение
 * не принимается вовсе, а спрашивается пользователь.
 *
 * Порядок веса источников (сверху вниз), записан в плане, В.02:
 *   1. `dialogue` — язык, на котором человек ведёт диалог: сильнейший источник;
 *   2. `packs`    — установленные языковые пакеты;
 *   3. `windows`  — локаль Windows;
 *   4. `interface`— активный `preference` интерфейса (слабый: переключается свободно);
 *   5. `fallback` — сигналов нет вовсе: `en`.
 *
 * Отдельно — `conflict`: сигналы среды разошлись между собой, и диалога, который их
 * перевесил бы, нет. Тогда язык не выставляется молча: пользователю задаётся вопрос.
 * @module @kenz1117/dsh-engram/i18n/palace-language
 */

import { FALLBACK_LANGUAGE, type EngramLanguage } from './language.ts'

/** Источники сигнала в порядке убывания веса. */
export const LANGUAGE_SOURCES = ['dialogue', 'packs', 'windows', 'interface', 'fallback'] as const

/** Один сигнал: откуда он и на какой язык указывает. */
export type LanguageSource = typeof LANGUAGE_SOURCES[number]

/** Сигнал языка дворца. */
export interface LanguageSignal {
  /** Откуда взят сигнал. */
  readonly source: LanguageSource
  /** На какой язык указывает. */
  readonly language: EngramLanguage
}

/** Решение о языке дворца вместе с его обоснованием. */
export interface LanguageDecision {
  /** Итоговый язык: старший по весу сигнал либо `en`, если сигналов нет. */
  readonly language: EngramLanguage
  /** Источник, который решил. */
  readonly source: LanguageSource
  /** Сигналы среды разошлись, перевешивающего диалога нет — решает пользователь. */
  readonly conflict: boolean
  /**
   * Решение опирается на сильнейший источник — диалог, а не на среду.
   *
   * Только такое решение дворец записывает сам: локаль машины и preference интерфейса
   * слишком слабы, чтобы молча назначить язык дворца (он держит модель, инструкции и
   * язык новых записей). Нет опоры — спрашиваем человека в панели (В.02).
   */
  readonly grounded: boolean
  /** Все собранные сигналы, в порядке веса. */
  readonly signals: readonly LanguageSignal[]
}

/** Минимальная доля доминирующего языка в диалоге, чтобы считать его голосом человека. */
const DIALOGUE_SHARE = 0.6

/** Минимум букв в выборке реплик: на «привет» и «ok» язык не определяем. */
const DIALOGUE_MIN_LETTERS = 40

/** Символы, по которым различаются письменности интересующих нас языков. */
const CYRILLIC = /[\u0400-\u04FF]/gu
const HAN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/gu
const LATIN = /[A-Za-z]/gu

/** Сколько знаков каждого письма в строке. */
function scriptCounts(text: string): { ru: number; zh: number; en: number } {
  return {
    ru: (text.match(CYRILLIC) ?? []).length,
    zh: (text.match(HAN) ?? []).length,
    en: (text.match(LATIN) ?? []).length,
  }
}

/**
 * Язык одной реплики по преобладающему письму.
 * Не «перевод текста», а грубая сортировка: кириллица → ru, иероглифы → zh, латиница → en.
 * @param text - реплика человека.
 * @returns Язык либо `undefined`, если букв слишком мало или письменности перемешаны.
 */
export function scriptLanguage(text: string): EngramLanguage | undefined {
  const counts = scriptCounts(text)
  const total = counts.ru + counts.zh + counts.en
  if (total < 3) return undefined
  const best = Math.max(counts.ru, counts.zh, counts.en)
  // Ничья между письменностями — сигнала нет: реплика вроде «ok, спасибо» ничего не решает.
  const leaders = (['ru', 'zh', 'en'] as const).filter(language => counts[language] === best)
  if (leaders.length !== 1) return undefined
  return leaders[0]
}

/**
 * Доминирующий язык выборки реплик.
 * @param texts - реплики человека в произвольном порядке.
 * @returns Язык и его долю либо `undefined`, если реплик мало или язык не выделяется.
 */
export function dominantLanguage(texts: readonly string[]): { language: EngramLanguage; share: number } | undefined {
  let letters = 0
  // Голосуют три письменности, а не три языка: ключ — язык сценария, и он может
  // быть любым, что вернул `scriptLanguage`. Поэтому словарь счётчиков — по строке,
  // а чтение идёт через `?? 0`.
  const votes: Record<string, number> = { ru: 0, zh: 0, en: 0 }
  for (const text of texts) {
    const counts = scriptCounts(text)
    letters += counts.ru + counts.zh + counts.en
    const language = scriptLanguage(text)
    if (language !== undefined) votes[language] = (votes[language] ?? 0) + 1
  }
  if (letters < DIALOGUE_MIN_LETTERS) return undefined
  const total = (votes.ru ?? 0) + (votes.zh ?? 0) + (votes.en ?? 0)
  if (total === 0) return undefined
  const best = Math.max(votes.ru ?? 0, votes.zh ?? 0, votes.en ?? 0)
  const leaders = (['ru', 'zh', 'en'] as const).filter(language => (votes[language] ?? 0) === best)
  if (leaders.length !== 1) return undefined
  const winner = leaders[0]
  if (winner === undefined) return undefined
  const share = best / total
  return share >= DIALOGUE_SHARE ? { language: winner, share } : undefined
}

/**
 * Что делать с языком дворца — три случая, названные в решении 21.10.
 *
 * `auto` — опора есть и спорить не о чем: диалоги идут на нашем языке, базы на нём же
 * или их ещё нет, — дворец настраивается сам. `ask` — реплик человека не было, опоры
 * нет: спрашиваем в окне. `mismatch` — диалоги на одном языке, базы на другом: это
 * расхождение, его тоже решает человек в том же окне.
 */
export type PalaceCase = 'auto' | 'ask' | 'mismatch'

/**
 * Случай языка дворца по двум наблюдениям.
 *
 * Базы без метки (`null`) не считаются ни согласием, ни расхождением: спорить с ними
 * не о чем, а «нет метки» — отдельное состояние карточки обслуживания (Б.01), не язык.
 * Базы на разных языках (`mixed`) — расхождение: одна установка не может жить на двух
 * языках одновременно.
 * @param dialogue - язык диалогов; null — реплик ещё не было.
 * @param bases - язык баз по меткам; null — метки нет ни у одной, `mixed` — разные.
 * @returns Случай из трёх.
 */
export function palaceCase(dialogue: EngramLanguage | null, bases: EngramLanguage | 'mixed' | null): PalaceCase {
  if (dialogue === null) return 'ask'
  return bases === null || bases === dialogue ? 'auto' : 'mismatch'
}

/**
 * Решить язык дворца по собранным сигналам.
 *
 * Правило простое и повторяет план: побеждает старший по весу. Расхождением (`conflict`)
 * считается только случай, когда диалог молчит, а сигналы среды указывают на разные языки, —
 * тогда решает пользователь. Наличие диалога снимает вопрос: человек уже показал язык.
 * @param signals - сигналы в любом порядке; вес берётся из их вида.
 * @param options - настройки решателя.
 * @param options.allowFallback - выдавать ли `en`, когда сигналов нет (по умолчанию да).
 * @returns Решение с обоснованием.
 */
export function decideLanguage(
  signals: readonly LanguageSignal[],
  options: { readonly allowFallback?: boolean } = {},
): LanguageDecision {
  const ranked = [...signals].sort(
    (left, right) => LANGUAGE_SOURCES.indexOf(left.source) - LANGUAGE_SOURCES.indexOf(right.source),
  )
  const dialogue = ranked.find(signal => signal.source === 'dialogue')
  const environment = ranked.filter(signal => signal.source !== 'dialogue' && signal.source !== 'fallback')
  const conflict = dialogue === undefined
    && new Set(environment.map(signal => signal.language)).size > 1
  const winner = ranked[0]
  if (winner !== undefined) {
    return {
      language: winner.language,
      source: winner.source,
      conflict,
      grounded: !conflict && winner.source === 'dialogue',
      signals: ranked,
    }
  }
  return {
    language: FALLBACK_LANGUAGE,
    source: 'fallback',
    conflict,
    grounded: false,
    signals: options.allowFallback === false ? [] : [{ source: 'fallback', language: FALLBACK_LANGUAGE }],
  }
}
