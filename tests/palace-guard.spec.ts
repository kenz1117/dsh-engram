/**
 * Предохранитель смены языка дворца: состояние на сервере (решение 24.10).
 *
 * До этого окно держалось в панели: панель присылала `from` и `startedAt`, сервер
 * проверял присланное. Проверка от этого не была настоящей — часы и «язык, от которого
 * уходят» приходили от того, кого проверяли. Любой клиент мог прислать `startedAt: now`
 * и назвать любой `from` — и условие выполнялось по построению.
 *
 * Теперь состояние окна живёт на сервере. Проверяется именно это: что окно открыто,
 * что сервер сам помнит его начало, что язык отличается от серверного, и что подделать
 * ничего из этого нельзя.
 */
import { describe, expect, it } from 'vitest'
import { PalaceGuard } from '../src/registry/palace-guard.ts'

const NOW = 1_800_000_000_000

describe('предохранитель смены языка: состояние на сервере', () => {
  it('без открытого окна смена отклоняется — условие не собрано', () => {
    const guard = new PalaceGuard()
    expect(guard.check('fr', NOW, 30)).toEqual({ ok: false, reason: 'no-window' })
  })

  it('окно открыто, язык другой — пропускаем', () => {
    const guard = new PalaceGuard()
    guard.open('ru', NOW - 5_000)
    expect(guard.check('fr', NOW, 30)).toEqual({ ok: true })
  })

  it('язык не изменился — отказ: переписывать настройку тем же значением незачем', () => {
    const guard = new PalaceGuard()
    guard.open('ru', NOW - 1_000)
    expect(guard.check('ru', NOW, 30)).toEqual({ ok: false, reason: 'not-changed' })
  })

  it('не код языка — отказ ещё до всякой записи', () => {
    const guard = new PalaceGuard()
    guard.open('ru', NOW)
    expect(guard.check('Français', NOW, 30).reason).toBe('not-a-code')
    expect(guard.check('', NOW, 30).reason).toBe('not-a-code')
  })

  it('окно истекло — отказ, и это ровно граница в миллисекундах', () => {
    const guard = new PalaceGuard()
    guard.open('ru', NOW - 30_000)
    expect(guard.check('fr', NOW, 30).ok).toBe(true)
    expect(guard.check('fr', NOW + 1, 30).reason).toBe('window')
  })

  it('длина окна берётся из настройки, а не из константы', () => {
    const guard = new PalaceGuard()
    guard.open('ru', NOW - 9_000)
    expect(guard.check('fr', NOW, 10).ok).toBe(true)
    expect(guard.check('fr', NOW, 5).reason).toBe('window')
  })

  it('повторное открытие не продлевает окно', () => {
    // Иначе панель (или кто угодно с доступом к маршруту) обновлял бы начало отсчёта
    // сколько угодно — и окно перестало бы быть окном.
    const guard = new PalaceGuard()
    const first = guard.open('ru', NOW - 29_000)
    const second = guard.open('ru', NOW)
    expect(second.startedAt).toBe(first.startedAt)
    // Окно, открытое 29 секунд назад, в момент NOW ещё живо (остаток 1 секунда) —
    // но продлить его повторным открытием нельзя: итоговое время то же.
    expect(guard.check('fr', NOW, 30).ok).toBe(true)
    expect(guard.check('fr', NOW + 2_000, 30).reason).toBe('window')
  })

  it('после закрытия окно надо открыть заново', () => {
    const guard = new PalaceGuard()
    guard.open('ru', NOW)
    expect(guard.check('fr', NOW, 30).ok).toBe(true)
    guard.close()
    expect(guard.check('fr', NOW, 30)).toEqual({ ok: false, reason: 'no-window' })
  })

  it('сервер помнит язык, на котором стояли базы, — подменить его нечем', () => {
    // Это и есть смысл переноса состояния на сервер: «от чего уходят» — серверное
    // знание, а не присланное поле, которое можно назвать любым.
    const guard = new PalaceGuard()
    guard.open('ru', NOW)
    expect(guard.current()?.from).toBe('ru')
    expect(guard.check('ru', NOW, 30).reason).toBe('not-changed')
  })

  it('при записи выбранного языка требование «язык другой» снимается', () => {
    // Маршрут, который просто пишет выбранный язык (первая настройка): «язык тот же» —
    // не ошибка, а отсутствие изменений. Проверка на отличие живёт в palace-change.
    const guard = new PalaceGuard()
    guard.open('ru', NOW)
    expect(guard.check('ru', NOW, 30).reason).toBe('not-changed')
    expect(guard.check('ru', NOW, 30, { requireChanged: false })).toEqual({ ok: true })
  })

  it('без открытого окна запись выбранного языка тоже отклоняется', () => {
    const guard = new PalaceGuard()
    expect(guard.check('fr', NOW, 30, { requireChanged: false })).toEqual({ ok: false, reason: 'no-window' })
  })

  it('остаток окна считается по серверному началу; без окна — полная длина', () => {
    const guard = new PalaceGuard()
    expect(guard.left(NOW, 30)).toBe(30)
    guard.open('ru', NOW - 4_000)
    expect(guard.left(NOW, 30)).toBe(26)
    expect(guard.left(NOW + 40_000, 30)).toBe(0)
  })
})
