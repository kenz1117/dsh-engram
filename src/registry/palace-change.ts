/**
 * Собранное условие смены языка дворца: три события в одном окне.
 *
 * По решению 20–21.10 смена языка дворца и пересчёт баз — одно осознанное действие:
 * человек выбирает язык, снимает предохранитель и нажимает «Выполнить». Пока окно идёт,
 * все три решения живы; окно истекло — выбор возвращается к языку, на котором стоят
 * базы, а предохранитель встаёт обратно.
 *
 * Живёт отдельным модулем, потому что решают двое: панель (что показывать и когда
 * сбрасывать) и сервер (принимать ли запрос). Формула должна быть одна, иначе панель
 * и сервер разойдутся в том, что считать «вовремя», и человек получит отказ на кнопке,
 * которая по виду была готова.
 *
 * @module @kenz1117/dsh-engram/registry/palace-change
 */

import { isLanguageCode } from '../i18n/language.ts'

/** Что присылает панель: какое решение принято и когда началось окно. */
export interface PalaceChangeRequest {
  /** Язык, который выбран сейчас. */
  readonly language: string
  /** Язык, на котором стоят базы, — то, от чего уходим. */
  readonly from: string
  /** Момент первого из трёх событий (мс). Отсчёт окна идёт с него. */
  readonly startedAt: number
}

/** Чем кончилось разбирательство: пропускать или нет и почему. */
export interface PalaceChangeVerdict {
  readonly ok: boolean
  /**
   * Причина отказа: `not-a-code` — не код языка; `not-changed` — язык тот же, менять
   * нечего; `not-a-window` — начало окна не похоже на время; `window` — окно истекло.
   * Панель по этой причине подсказывает, чего не хватает, а не молчит.
   */
  readonly reason?: 'not-a-code' | 'not-changed' | 'not-a-window' | 'window'
}

/**
 * Проверить собранное условие.
 *
 * Проверяются все три решения, и ни одно нельзя подразумевать: язык должен быть кодом
 * и отличаться от текущего (иначе это не смена), начало окна — быть настоящим временем
 * не в будущем, а окно — не истечь. Предохранитель и кнопку сервер не видит, поэтому
 * панель обязана прислать начало окна: без него запрос неотличим от «смени язык сейчас
 * же, мимо условия», и такой запрос не принимается.
 * @param request - что прислала панель.
 * @param now - текущее время, мс (в тестах подменяется).
 * @param windowSec - длина окна из настройки `palaceChangeWindowSec`.
 * @returns пропускать ли и почему нет.
 */
export function checkPalaceChange(
  request: PalaceChangeRequest,
  now: number,
  windowSec: number,
): PalaceChangeVerdict {
  if (!isLanguageCode(request.language)) return { ok: false, reason: 'not-a-code' }
  if (request.language === request.from) return { ok: false, reason: 'not-changed' }
  const started = request.startedAt
  // Начало окна в будущем — не наше время: так запрос можно было бы «продлить» навсегда.
  if (!Number.isFinite(started) || started <= 0 || started > now) return { ok: false, reason: 'not-a-window' }
  const windowMs = Math.max(1, Math.round(windowSec)) * 1000
  if (now - started > windowMs) return { ok: false, reason: 'window' }
  return { ok: true }
}

/**
 * Сколько секунд осталось от окна: панель показывает это человеку.
 * @param startedAt - момент первого события, мс.
 * @param now - текущее время, мс.
 * @param windowSec - длина окна из настройки.
 * @returns остаток в секундах, не меньше нуля.
 */
export function windowLeft(startedAt: number, now: number, windowSec: number): number {
  const left = Math.round((windowSec * 1000 - (now - startedAt)) / 1000)
  return left > 0 ? left : 0
}
