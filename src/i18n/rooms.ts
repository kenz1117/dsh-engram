/**
 * Человекочитаемые имена комнат.
 *
 * Идентификатор комнаты («fact-3») — это ДАННЫЕ: он лежит в поле slot_room каждой
 * записи и языка не несёт. Имя для показа берётся отсюда по языку вывода, поэтому
 * смена языка не переписывает память, а добавление языка — это добавление строк
 * в таблицу ниже.
 *
 * @module @kenz1117/dsh-engram/i18n/rooms
 */

import type { EngramLanguage } from './language.ts'

/** Базовый идентификатор → имя. Ключи совпадают с KIND_ROOM_IDS из palace/slots.ts. */
const BASE_LABELS: Readonly<Record<EngramLanguage, Readonly<Record<string, string>>>> = {
  zh: {
    fact: '事实厅',
    preference: '偏好阁',
    decision: '决策堂',
    episode: '往事廊',
    skill: '技法坊',
  },
  en: {
    fact: 'Fact Hall',
    preference: 'Preference Pavilion',
    decision: 'Decision Chamber',
    episode: 'Episode Gallery',
    skill: 'Skill Workshop',
  },
  ru: {
    fact: 'Зал фактов',
    preference: 'Павильон предпочтений',
    decision: 'Зал решений',
    episode: 'Галерея прошлого',
    skill: 'Мастерская приёмов',
  },
}

/** Разбор «fact-3» на основу и номер комнаты. */
function splitRoom(roomId: string): { base: string; suffix: string } {
  const match = /^(.*?)-(\d+)$/.exec(roomId)
  if (match === null) return { base: roomId, suffix: '' }
  return { base: match[1] ?? roomId, suffix: `-${match[2]}` }
}

/**
 * «fact-3» → «Зал фактов-3».
 * Неизвестный идентификатор возвращается как есть: показать идентификатор лучше,
 * чем пустую подпись.
 */
export function roomLabel(roomId: string, language: EngramLanguage): string {
  const { base, suffix } = splitRoom(roomId)
  // Языка может не быть в наборе названий (новый язык, для которого ещё нет
  // словаря): тогда комната называется идентификатором, а не пустой строкой.
  const label = BASE_LABELS[language]?.[base]
  return label === undefined ? roomId : `${label}${suffix}`
}

/**
 * Базовый идентификатор комнаты, к которому относится ввод пользователя.
 * Понимает и идентификатор («fact», «fact-2»), и человеческое имя на любом языке
 * («зал фактов», «Fact Hall») — чтобы поиск по комнате работал при любой настройке.
 * Возвращает undefined, если ввод ни на что не похож.
 */
export function resolveRoomInput(input: string): string | undefined {
  const value = input.trim()
  if (value === '') return undefined
  const { base, suffix } = splitRoom(value)
  for (const labels of Object.values(BASE_LABELS)) {
    if (labels[base] !== undefined) return `${base}${suffix}`
    for (const [id, label] of Object.entries(labels)) {
      if (label.toLowerCase() === value.toLowerCase()) return id
      if (`${label}${suffix}`.toLowerCase() === value.toLowerCase()) return `${id}${suffix}`
    }
  }
  return undefined
}

/** Известные идентификаторы комнат (для подсказок в описаниях инструментов). */
export function knownRoomIds(language: EngramLanguage): readonly string[] {
  return Object.keys(BASE_LABELS[language] ?? {})
}
