/**
 * Мост к настройкам: поиск своей формы и запись языка дворца.
 *
 * Проверяется то, что нельзя увидеть в панели: что запись идёт именно в свою форму
 * (а не в чужую с полем `language`), что отказ «своей формы ещё нет» повторяется
 * коротким окном — сервис отдаёт форму только работающему фиберу, — и что
 * выгруженный плагин перестаёт писать.
 */
import { describe, expect, it } from 'vitest'
import { findPalaceEntry, writePalaceLanguage, writePalaceLanguageWithRetry } from '../src/settings-bridge.ts'
import type { SettingsEntryView, SettingsServiceView } from '../src/settings-bridge.ts'

/** Своя форма: единственное поле — язык дворца. */
const OWN: SettingsEntryView = {
  ns: 'dsh-engram',
  revision: 4,
  schema: { properties: { language: { type: 'string' } } },
  value: { language: 'ru' },
}

/** Чужая форма: поле языка есть, но оно не единственное — это не наша запись. */
const FOREIGN: SettingsEntryView = {
  ns: 'other-plugin',
  revision: 7,
  schema: { properties: { language: { type: 'string' }, caption: { type: 'string' } } },
}

/** Сервис-заглушка: помнит, что у него просили, и отдаёт формы с N-го раза. */
function service(options: {
  readonly entries: () => readonly SettingsEntryView[]
  readonly failUpdate?: string
}): SettingsServiceView & { describes: number; updates: { ns: string; patch: Record<string, unknown>; revision: number }[] } {
  let describes = 0
  const updates: { ns: string; patch: Record<string, unknown>; revision: number }[] = []
  return {
    get describes() { return describes },
    updates,
    describe() {
      describes += 1
      return options.entries()
    },
    async update(ns, patch, revision) {
      if (options.failUpdate !== undefined) throw new Error(options.failUpdate)
      updates.push({ ns, patch, revision })
    },
  }
}

describe('поиск своей формы', () => {
  it('берёт запись, где поле языка единственное', () => {
    expect(findPalaceEntry([FOREIGN, OWN])).toEqual({ ns: 'dsh-engram', revision: 4 })
  })

  it('форм с полем языка несколько и различить их нечем — не берём никакую', () => {
    const twin: SettingsEntryView = { ns: 'twin', revision: 1, schema: { properties: { language: {} } } }
    expect(findPalaceEntry([OWN, twin])).toBeUndefined()
  })

  it('поля языка нет ни в одной форме — плагин в настройках ещё не виден', () => {
    expect(findPalaceEntry([{ ns: 'x', revision: 0, schema: { properties: { theme: {} } } }])).toBeUndefined()
  })
})

describe('запись языка дворца', () => {
  it('пишет в свою запись с её ревизией', async () => {
    const settings = service({ entries: () => [FOREIGN, OWN] })
    expect(await writePalaceLanguage(settings, 'ru')).toBeUndefined()
    expect(settings.updates).toEqual([{ ns: 'dsh-engram', patch: { language: 'ru' }, revision: 4 }])
  })

  it('сервиса нет — говорит причину, а не молчит', async () => {
    expect(await writePalaceLanguage(undefined, 'ru')).toContain('settings service is absent')
  })

  it('нашей формы нет — отказ называет причину', async () => {
    const settings = service({ entries: () => [FOREIGN] })
    expect(await writePalaceLanguage(settings, 'ru')).toContain('own settings entry not found')
    expect(settings.updates).toEqual([])
  })

  it('сбой самого сервиса настроек — тоже причина, а не исключение', async () => {
    const settings = service({ entries: () => [OWN], failUpdate: 'revision conflict' })
    expect(await writePalaceLanguage(settings, 'ru')).toContain('revision conflict')
  })
})

describe('повтор: форма появляется только у работающего фибера', () => {
  it('первая попытка не нашла форму — со второго раза находит и пишет один раз', async () => {
    let call = 0
    const settings = service({ entries: () => (call++ < 1 ? [] : [OWN]) })
    const waits: number[] = []

    const reason = await writePalaceLanguageWithRetry({
      settings: () => settings,
      language: 'ru',
      attempts: 5,
      delayMs: 10,
      wait: async ms => { waits.push(ms) },
    })

    expect(reason).toBeUndefined()
    expect(settings.describes).toBe(2)
    expect(settings.updates).toEqual([{ ns: 'dsh-engram', patch: { language: 'ru' }, revision: 4 }])
    expect(waits).toEqual([10])
  })

  it('окно исчерпано — возвращает причину, попыток ровно столько, сколько заказано', async () => {
    const settings = service({ entries: () => [] })
    const reason = await writePalaceLanguageWithRetry({
      settings: () => settings,
      language: 'ru',
      attempts: 3,
      delayMs: 1,
      wait: async () => {},
    })
    expect(reason).toContain('own settings entry not found')
    expect(settings.describes).toBe(3)
    expect(settings.updates).toEqual([])
  })

  it('выгруженный плагин не пишет в настройки', async () => {
    const settings = service({ entries: () => [OWN] })
    const reason = await writePalaceLanguageWithRetry({
      settings: () => settings,
      language: 'ru',
      attempts: 3,
      delayMs: 1,
      wait: async () => {},
      stopped: () => true,
    })
    expect(reason).toContain('stopped')
    expect(settings.describes).toBe(0)
    expect(settings.updates).toEqual([])
  })
})
