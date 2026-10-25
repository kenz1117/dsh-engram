/**
 * Язык системы: локаль окружения против настоящего языка ОС.
 *
 * Проверяется ровно то, что стоило дорого: приложение, запущенное из Dock,
 * наследует `LANG=C.UTF-8`, Node отдаёт для этого `en-US`, и плагин садился
 * в английский на любой неанглийской машине. C/POSIX — «язык не задан», а не
 * «английский»; настоящий язык macOS лежит в `AppleLocale`.
 */

import { describe, expect, it } from 'vitest'

import { parseLocaleTag, systemLocaleBase } from '../src/i18n/language.ts'

describe('локаль окружения', () => {
  it('C/POSIX — «язык не задан», а не английский', () => {
    expect(parseLocaleTag('C')).toBe('')
    expect(parseLocaleTag('C.UTF-8')).toBe('')
    expect(parseLocaleTag('POSIX')).toBe('')
    expect(parseLocaleTag('posix')).toBe('')
  })

  it('пустая строка и мусор дают пустую строку, а не чужой язык', () => {
    expect(parseLocaleTag('')).toBe('')
    expect(parseLocaleTag('  ')).toBe('')
  })

  it('база отдельно от подтега и кодировки', () => {
    expect(parseLocaleTag('zh_CN.UTF-8')).toBe('zh')
    expect(parseLocaleTag('zh-Hans-CN')).toBe('zh')
    expect(parseLocaleTag('en-US')).toBe('en')
    expect(parseLocaleTag('ru_RU.UTF-8@euro')).toBe('ru')
  })
})

describe('язык системы', () => {
  it('настоящий язык в переменных окружения главнее системных настроек', () => {
    const before = { LC_ALL: process.env.LC_ALL, LC_MESSAGES: process.env.LC_MESSAGES, LANG: process.env.LANG }
    try {
      process.env.LC_ALL = 'ru_RU.UTF-8'
      process.env.LC_MESSAGES = ''
      process.env.LANG = ''
      expect(systemLocaleBase()).toBe('ru')
    } finally {
      for (const [key, value] of [['LC_ALL', before.LC_ALL], ['LC_MESSAGES', before.LC_MESSAGES], ['LANG', before.LANG]] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('C/POSIX в окружении не превращается в английский', () => {
    const before = { LC_ALL: process.env.LC_ALL, LC_MESSAGES: process.env.LC_MESSAGES, LANG: process.env.LANG }
    try {
      process.env.LC_ALL = ''
      process.env.LC_MESSAGES = ''
      process.env.LANG = 'C.UTF-8'
      const detected = systemLocaleBase()
      // На macOS дальше читается AppleLocale (настоящий язык ОС), на прочих
      // платформах — ничего: пустая строка честнее чужого языка.
      expect(detected === '' || /^[a-z]{2,3}$/.test(detected)).toBe(true)
      expect(detected).not.toBe('en')
    } finally {
      for (const [key, value] of [['LC_ALL', before.LC_ALL], ['LC_MESSAGES', before.LC_MESSAGES], ['LANG', before.LANG]] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})
