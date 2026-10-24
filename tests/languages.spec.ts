/**
 * Реестр языков: разбор файла и встроенный набор.
 *
 * Смысл проверок один — язык добавляется данными. Поэтому файл должен приниматься
 * как есть, испорченный файл не должен оставлять плагин без языков вовсе, а
 * встроенный набор обязан совпадать с тем, с чем плагин приходит на самом деле.
 */

import { describe, expect, it } from 'vitest'

import { parseLanguages } from '../src/registry/languages.ts'

describe('реестр языков: встроенный набор', () => {
  it('без файла действует встроенная тройка, и у двух языков есть вшитый набор', () => {
    const parsed = parseLanguages('')
    expect(parsed.languages.map(record => record.code)).toEqual(['zh', 'en', 'ru'])
    expect(parsed.issues).toEqual([])
    const builtin = parsed.languages.filter(record => record.builtin).map(record => record.code)
    expect(builtin).toEqual(['zh', 'en'])
  })
})

describe('реестр языков: разбор файла', () => {
  it('язык вне тройки объявляется данными и приходит со своей подписью', () => {
    const parsed = parseLanguages(JSON.stringify({
      formatVersion: 1,
      languages: [
        { code: 'ru', label: 'Русский', builtin: false },
        { code: 'fr', label: 'Français', builtin: false },
      ],
    }))
    expect(parsed.issues).toEqual([])
    expect(parsed.languages).toEqual([
      { code: 'ru', label: 'Русский', builtin: false },
      { code: 'fr', label: 'Français', builtin: false },
    ])
  })

  it('без подписи язык называется своим кодом, а не пустой строкой', () => {
    const parsed = parseLanguages(JSON.stringify({ languages: [{ code: 'de' }] }))
    expect(parsed.languages).toEqual([{ code: 'de', label: 'de', builtin: false }])
  })

  it('испорченный JSON не оставляет плагин без языков', () => {
    const parsed = parseLanguages('{ не json')
    expect(parsed.languages.map(record => record.code)).toEqual(['zh', 'en', 'ru'])
    expect(parsed.issues.map(issue => issue.kind)).toEqual(['badJson'])
  })

  it('нет массива languages — то же: замечание и встроенный набор', () => {
    const parsed = parseLanguages(JSON.stringify({ formatVersion: 1 }))
    expect(parsed.languages.map(record => record.code)).toEqual(['zh', 'en', 'ru'])
    expect(parsed.issues.map(issue => issue.kind)).toEqual(['badShape'])
  })

  it('пустой список — не «языков нет», а испорченный файл', () => {
    const parsed = parseLanguages(JSON.stringify({ languages: [] }))
    expect(parsed.languages.map(record => record.code)).toEqual(['zh', 'en', 'ru'])
    expect(parsed.issues.map(issue => issue.kind)).toEqual(['badShape'])
  })

  it('код не в форме языка отбрасывается построчно, остальные остаются', () => {
    const parsed = parseLanguages(JSON.stringify({
      languages: [
        { code: 'FR', label: 'Французский' },
        { code: 'fr', label: 'Français' },
      ],
    }))
    expect(parsed.languages.map(record => record.code)).toEqual(['fr'])
    expect(parsed.issues.map(issue => issue.kind)).toEqual(['badField'])
  })

  it('повтор кода не дублирует язык: побеждает первая строка', () => {
    const parsed = parseLanguages(JSON.stringify({
      languages: [
        { code: 'ru', label: 'Русский' },
        { code: 'ru', label: 'Русский (второй)' },
      ],
    }))
    expect(parsed.languages).toEqual([{ code: 'ru', label: 'Русский', builtin: false }])
    expect(parsed.issues.map(issue => issue.kind)).toEqual(['duplicateLanguage'])
  })
})
