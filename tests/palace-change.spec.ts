/**
 * Собранное условие смены языка дворца: одна формула на панель и сервер.
 *
 * Проверяются обещания, на которых держится кнопка «Выполнить»: смена языка проходит
 * только когда язык действительно другой и окно с первого события ещё не истекло;
 * запрос «смени язык сразу, мимо условия» не проходит; истёкшее окно не продлевается
 * ни началом из будущего, ни бесконечным числом вместо времени.
 *
 * Времена подставляются явно: проверка про окно, а не про часы машины.
 */
import { describe, expect, it } from 'vitest'
import { checkPalaceChange, windowLeft } from '../src/registry/palace-change.ts'

const NOW = 1_800_000_000_000

describe('собранное условие смены языка', () => {
  it('язык другой и окно свежее — пропускаем', () => {
    const verdict = checkPalaceChange({ language: 'fr', from: 'ru', startedAt: NOW - 5_000 }, NOW, 30)
    expect(verdict).toEqual({ ok: true })
  })

  it('тот же язык — менять нечего, отказ ещё до всякой записи', () => {
    // Иначе «Выполнить» переписывало бы настройку тем же значением и считалось успехом.
    const verdict = checkPalaceChange({ language: 'ru', from: 'ru', startedAt: NOW - 1_000 }, NOW, 30)
    expect(verdict).toEqual({ ok: false, reason: 'not-changed' })
  })

  it('не код языка — отказ: перепутанное имя не должно попасть в настройку', () => {
    expect(checkPalaceChange({ language: 'Français', from: 'ru', startedAt: NOW }, NOW, 30).reason).toBe('not-a-code')
    expect(checkPalaceChange({ language: '', from: 'ru', startedAt: NOW }, NOW, 30).reason).toBe('not-a-code')
  })

  it('окно истекло — отказ, и это ровно граница в миллисекундах', () => {
    expect(checkPalaceChange({ language: 'fr', from: 'ru', startedAt: NOW - 30_000 }, NOW, 30).ok).toBe(true)
    expect(checkPalaceChange({ language: 'fr', from: 'ru', startedAt: NOW - 30_001 }, NOW, 30).reason).toBe('window')
  })

  it('начало окна из будущего или не время — отказ: так окно продлевалось бы вечно', () => {
    expect(checkPalaceChange({ language: 'fr', from: 'ru', startedAt: NOW + 1_000 }, NOW, 30).reason).toBe('not-a-window')
    expect(checkPalaceChange({ language: 'fr', from: 'ru', startedAt: Number.NaN }, NOW, 30).reason).toBe('not-a-window')
    expect(checkPalaceChange({ language: 'fr', from: 'ru', startedAt: 0 }, NOW, 30).reason).toBe('not-a-window')
  })

  it('длина окна берётся из настройки, а не из константы', () => {
    // Пользователь просил менять её без пересборки: «минута это много, 30 сек».
    expect(checkPalaceChange({ language: 'fr', from: 'ru', startedAt: NOW - 9_000 }, NOW, 10).ok).toBe(true)
    expect(checkPalaceChange({ language: 'fr', from: 'ru', startedAt: NOW - 11_000 }, NOW, 10).reason).toBe('window')
  })

  it('остаток окна для подписи считается и не уходит в минус', () => {
    expect(windowLeft(NOW - 4_000, NOW, 30)).toBe(26)
    expect(windowLeft(NOW - 40_000, NOW, 30)).toBe(0)
    expect(windowLeft(NOW, NOW, 30)).toBe(30)
  })
})
