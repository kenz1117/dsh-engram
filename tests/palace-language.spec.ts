/**
 * Язык дворца: правила определения и мост к настройкам хоста.
 *
 * Проверяем то, что решает судьбу языка, а не косметику: по какому письму узнаётся
 * реплика, когда выборка молчит, чей голос главнее и когда дворец обязан спросить
 * человека вместо того, чтобы решать самому.
 */

import { describe, expect, it } from 'vitest'
import { decideLanguage, dominantLanguage, palaceCase, scriptLanguage } from '../src/i18n/palace-language.ts'
import { collectLanguageSignals } from '../src/language-signals.ts'
import { findPalaceEntry, interfacePreference, type SettingsEntryView } from '../src/settings-bridge.ts'

describe('язык реплики по письму', () => {
  it('кириллица — русский, иероглифы — китайский, латиница — английский', () => {
    expect(scriptLanguage('Дворец памяти отвечает на русском')).toBe('ru')
    expect(scriptLanguage('记忆宫殿用中文回答')).toBe('zh')
    expect(scriptLanguage('The palace answers in English')).toBe('en')
  })

  it('короткая реплика и смесь письменностей сигнала не дают', () => {
    expect(scriptLanguage('ok')).toBeUndefined()
    expect(scriptLanguage('ok да')).toBeUndefined()
  })
})

describe('доминирующий язык выборки', () => {
  const ru = 'Сегодня мы разбирали язык дворца и правила определения.'
  const en = 'Today we discussed the palace language and the rules for it.'
  const zh = '今天我们讨论了宫殿语言以及它的判定规则。'

  it('уверенное большинство становится сигналом', () => {
    expect(dominantLanguage([ru, ru, en])?.language).toBe('ru')
  })

  it('ничья и слишком короткая выборка сигнала не дают', () => {
    expect(dominantLanguage([ru, en])).toBeUndefined()
    expect(dominantLanguage(['привет', 'ok'])).toBeUndefined()
    expect(dominantLanguage([])).toBeUndefined()
  })

  it('три языка в равных долях — сигнала нет', () => {
    expect(dominantLanguage([ru, en, zh])).toBeUndefined()
  })
})

describe('решение о языке дворца', () => {
  it('диалог главнее среды', () => {
    const decision = decideLanguage([
      { source: 'windows', language: 'en' },
      { source: 'interface', language: 'en' },
      { source: 'dialogue', language: 'ru' },
    ])
    expect(decision.language).toBe('ru')
    expect(decision.source).toBe('dialogue')
    expect(decision.conflict).toBe(false)
    // Опора есть: решение можно записывать в конфигурацию самим.
    expect(decision.grounded).toBe(true)
  })

  it('среда разошлась без диалога — это конфликт, решает человек', () => {
    const decision = decideLanguage([
      { source: 'windows', language: 'ru' },
      { source: 'interface', language: 'en' },
    ])
    expect(decision.conflict).toBe(true)
    // Язык всё равно называется — но как предложение, а не как решение.
    expect(decision.language).toBe('ru')
    expect(decision.source).toBe('windows')
    expect(decision.grounded).toBe(false)
  })

  it('среда согласна — решения нет только у диалога', () => {
    const decision = decideLanguage([
      { source: 'windows', language: 'ru' },
      { source: 'interface', language: 'ru' },
    ])
    expect(decision.conflict).toBe(false)
    expect(decision.language).toBe('ru')
    // Среда согласна с собой, но она не голос человека: сами такое не записываем.
    expect(decision.grounded).toBe(false)
  })

  it('сигналов нет вовсе — записывать нечего, спрашиваем человека', () => {
    const decision = decideLanguage([])
    expect(decision.source).toBe('fallback')
    expect(decision.grounded).toBe(false)
  })

  it('сигналов нет вовсе — английский с честным источником', () => {
    const decision = decideLanguage([])
    expect(decision.language).toBe('en')
    expect(decision.source).toBe('fallback')
  })
})

describe('три случая языка дворца (решение 21.10)', () => {
  it('баз ещё нет, диалоги на русском — настраиваемся сами', () => {
    expect(palaceCase('ru', null)).toBe('auto')
  })

  it('базы на языке диалогов — тоже сами, без окна', () => {
    expect(palaceCase('ru', 'ru')).toBe('auto')
  })

  it('базы на другом языке — расхождение, решает человек', () => {
    expect(palaceCase('ru', 'en')).toBe('mismatch')
  })

  it('базы на разных языках — тоже расхождение', () => {
    expect(palaceCase('ru', 'mixed')).toBe('mismatch')
  })

  it('реплик не было — опоры нет, спрашиваем', () => {
    expect(palaceCase(null, null)).toBe('ask')
    // Даже если базы что-то знают: язык диалогов сильнее, а его нет — спрашиваем.
    expect(palaceCase(null, 'en')).toBe('ask')
  })
})

describe('сбор сигналов: локаль машины как есть', () => {
  it('локаль без нашего языка не подменяется английским', async () => {
    // Решение сведёт «fr» к английскому (словаря нет), но панель первого старта
    // должна знать настоящий язык: иначе французу предустановят английский как «его».
    const collected = await collectLanguageSignals({ systemLocale: () => 'en', systemLocaleTag: () => 'fr' })
    expect(collected.machine).toBe('fr')
    expect(collected.decision.language).toBe('en')
  })

  it('локаль, прочитать не удалось — пустая строка, а не догадка', async () => {
    const collected = await collectLanguageSignals({ systemLocaleTag: () => '' })
    expect(collected.machine).toBe('')
  })
})

describe('мост к настройкам хоста', () => {
  const locale: SettingsEntryView = {
    ns: 'locale',
    revision: 3,
    value: { preference: 'ru' },
    schema: { properties: { preference: {} } },
  }
  const own: SettingsEntryView = {
    ns: 'dsh-engram',
    revision: 7,
    value: { language: 'ru' },
    schema: { properties: { language: {} } },
  }

  it('preference интерфейса читается из записи locale', () => {
    expect(interfacePreference([locale, own])).toBe('ru')
    expect(interfacePreference([own])).toBeUndefined()
    expect(interfacePreference([{ ...locale, value: {} }])).toBeUndefined()
  })

  it('своя запись находится по единственному полю language', () => {
    expect(findPalaceEntry([locale, own])).toEqual({ ns: 'dsh-engram', revision: 7 })
  })

  it('чужой формы с тем же полем не трогаем, если однозначности нет', () => {
    const other: SettingsEntryView = {
      ns: 'other-plugin',
      revision: 1,
      value: { language: 'en' },
      schema: { properties: { language: {} } },
    }
    expect(findPalaceEntry([other, own])).toBeUndefined()
    expect(findPalaceEntry([locale])).toBeUndefined()
  })
})
