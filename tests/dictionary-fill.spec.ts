/**
 * Заполнение словаря моделью: что уходит в запрос и что принимается из ответа.
 *
 * Проверяются обещания, на которых держится кнопка «Заполнить ИИ». Первое: в запрос
 * уходит ровно то, что просили перевести, — английские строки набора, без ключей и без
 * выдумок. Второе: из ответа берётся только то, что можно положить в словарь: строки
 * вне запроса, пустой перевод и перевод, повторяющий английский текст, отбрасываются —
 * иначе «перевода нет» перестало бы отличаться от «уже переведено». Третье: партия
 * ограничена по размеру, потому что ответ на сотни терминов не проверить на полноту.
 *
 * Термины берутся из настоящих наборов: словарь ключуется английской строкой, и
 * выдуманная строка проверяла бы не тот механизм, который работает в жизни.
 */
import { describe, expect, it } from 'vitest'
import { answerSnippet, fillBatch, fillPrompt, glossaryPairs, parseFillAnswer } from '../src/i18n/dictionary-ai.ts'
import { FILL_REQUEST_MAX, needsTranslation, splitFillBatch } from '../src/i18n/dictionary-limits.ts'
import { messageVocabulary } from '../src/i18n/messages.ts'

/** Настоящие английские строки набора сообщений: короткие и однострочные — их читать. */
const TERMS = messageVocabulary().filter(term => term.length > 3 && term.length < 40 && !term.includes('\n')).slice(0, 3)
const FIRST = TERMS[0] ?? ''
const SECOND = TERMS[1] ?? ''

describe('запрос на перевод партии', () => {
  it('термины уходят как JSON, а язык — словом, а не кодом', () => {
    const prompt = fillPrompt(TERMS, 'ru')
    // Модель должна видеть сами строки: по ним она и отвечает парами.
    for (const term of TERMS) expect(prompt.userText).toContain(JSON.stringify(term).slice(1, -1))
    expect(prompt.system).toContain('Russian')
    expect(prompt.system).not.toContain('{language}')
  })

  it('подстановки в инструкции остаются подстановками', () => {
    // {name} в тексте инструкции — пример подстановки, которую модель обязана сохранить
    // в переводе. Подставься он сам (как {language}) — требование исчезло бы из запроса.
    const prompt = fillPrompt(TERMS, 'zh')
    expect(prompt.system).toContain('{name}')
    expect(prompt.system).toContain('Chinese')
  })
})

describe('ответ модели принимается только пригодным для словаря', () => {
  it('пары берутся, чужие строки и пустое — нет', () => {
    const answer = JSON.stringify([
      [FIRST, 'Первый перевод'],
      ['Строка которой нет в коде', 'Не наше'],
      [SECOND, '   '],
      [FIRST, 'Повтор'],
    ])
    expect(parseFillAnswer(answer, [FIRST, SECOND])).toEqual([[FIRST, 'Первый перевод']])
  })

  it('перевод, повторяющий английский текст, не записывается', () => {
    // Это ответ «перевести не удалось»: записать его как перевод значит потерять
    // отличие «уже переведено» от «перевода нет».
    expect(parseFillAnswer(JSON.stringify([[FIRST, FIRST]]), [FIRST])).toEqual([])
  })

  it('ответ-карта принимается наравне с ответом-массивом', () => {
    // Модель отвечает то списком пар, то объектом; терять из-за формы весь ответ незачем.
    const answer = `\`\`\`json\n{${JSON.stringify(FIRST)}: "Из карты"}\n\`\`\``
    expect(parseFillAnswer(answer, [FIRST])).toEqual([[FIRST, 'Из карты']])
  })

  it('ответ без JSON не приносит пар, а не падает', () => {
    expect(parseFillAnswer('Извините, не могу перевести.', [FIRST])).toEqual([])
  })

  it('список переводов по порядку принимается, когда пар нет', () => {
    // Инструкция просит пары, но модель вправе ответить только переводами — в том же
    // порядке, в каком пришли термины. Терять такой ответ из-за формы нельзя.
    const answer = JSON.stringify(['Первый перевод', 'Второй перевод'])
    expect(parseFillAnswer(answer, [FIRST, SECOND])).toEqual([[FIRST, 'Первый перевод'], [SECOND, 'Второй перевод']])
    // А если переводам не хватает длины — это не тот список, и пары не выдумываются.
    expect(parseFillAnswer(JSON.stringify(['Первый перевод']), [FIRST, SECOND])).toEqual([])
  })

  it('объекты со своими именами полей принимаются по совпадению строки', () => {
    // Имена полей модель выбирает сама: важно не имя, а то, какая из строк — спрошенная.
    const answer = JSON.stringify([
      { term: FIRST, translation: 'Первый перевод' },
      { source: SECOND, target: 'Второй перевод' },
      { term: 'чужая строка', translation: 'не наше' },
    ])
    expect(parseFillAnswer(answer, [FIRST, SECOND])).toEqual([[FIRST, 'Первый перевод'], [SECOND, 'Второй перевод']])
  })

  it('обёртка с массивом переводов разворачивается', () => {
    const answer = JSON.stringify({ translations: ['Первый перевод', 'Второй перевод'] })
    expect(parseFillAnswer(answer, [FIRST, SECOND])).toEqual([[FIRST, 'Первый перевод'], [SECOND, 'Второй перевод']])
  })

  it('одна пара без внешнего массива принимается', () => {
    expect(parseFillAnswer(JSON.stringify([FIRST, 'Первый перевод']), [FIRST])).toEqual([[FIRST, 'Первый перевод']])
  })

  it('срез ответа для ошибки схлопывает переводы строк и обрезается', () => {
    expect(answerSnippet('  a\n\n b  ')).toBe('a b')
    const long = 'я'.repeat(300)
    expect(answerSnippet(long, 200).endsWith('…')).toBe(true)
    expect(answerSnippet(long, 200).length).toBe(201)
  })

  it('оборванный массив: пары, дописанные до обрыва, спасаются', () => {
    // Предел вывода обрезает ответ на середине, и целиком он не парсится. Раньше из-за
    // этого терялся весь ответ, хотя модель уже написала первые пары.
    const answer = `[${JSON.stringify([FIRST, 'Первый перевод'])},${JSON.stringify([SECOND, 'Второй перевод'])},["оборванная стро`
    expect(parseFillAnswer(answer, [FIRST, SECOND])).toEqual([[FIRST, 'Первый перевод'], [SECOND, 'Второй перевод']])
  })

  it('оборванная карта: записи до обрыва тоже спасаются', () => {
    const answer = `{${JSON.stringify(FIRST)}: "Из карты", ${JSON.stringify(SECOND)}: "оборванный перев`
    expect(parseFillAnswer(answer, [FIRST, SECOND])).toEqual([[FIRST, 'Из карты']])
  })

  it('проза со скобками пар не выдумывает', () => {
    expect(parseFillAnswer('Не могу [перевести] {это}', [FIRST])).toEqual([])
  })
})

describe('словарь устоявшихся терминов едет вместе с партией', () => {
  it('в запросе названы обе части: что переводить и что уже принято', () => {
    // Раньше уходил голый массив строк, и в соседних партиях одно понятие получало
    // разные переводы. Теперь у каждой части есть имя, и двусмысленности в запросе нет.
    const prompt = fillPrompt([FIRST], 'ru', [[SECOND, 'Второй перевод']])
    const payload = JSON.parse(prompt.userText) as { strings: string[], glossary: [string, string][] }
    expect(payload.strings).toEqual([FIRST])
    expect(payload.glossary).toEqual([[SECOND, 'Второй перевод']])
  })

  it('без словаря запрос всё равно разбирается: пустой список, а не пропущенный ключ', () => {
    const payload = JSON.parse(fillPrompt([FIRST], 'ru').userText) as { glossary: unknown[] }
    expect(payload.glossary).toEqual([])
  })

  it('в словарь берутся только принятые пары: пустое, английское и многострочное — нет', () => {
    const rows = [
      { left: 'B', right: 'Б' },
      { left: 'A', right: '  ' },
      { left: 'C', right: 'C' },
      { left: 'multi\nline', right: 'многострочный' },
      { left: 'D', right: 'Г' },
    ]
    // Порядок — по длине английской строки: понятие живёт в короткой подписи.
    expect(glossaryPairs(rows).map(pair => pair[0])).toEqual(['B', 'D'])
  })

  it('пределы словаря соблюдаются: и по числу пар, и по длине', () => {
    const rows = Array.from({ length: 10 }, (_item, index) => ({ left: `term ${String(index)}`, right: `термин ${String(index)}` }))
    expect(glossaryPairs(rows, 3).length).toBe(3)
    // Длинные строки не помещаются в предел — словарь не растёт сверх него.
    expect(glossaryPairs(rows, 10, 20).length).toBe(1)
  })
})

describe('партия режется по числу терминов и по длине строк', () => {
  it('короткие строки режутся по числу', () => {
    const terms = Array.from({ length: 45 }, (_item, index) => `t${String(index)}`)
    expect(splitFillBatch(terms, 10, 10_000).map(chunk => chunk.length)).toEqual([10, 10, 10, 10, 5])
    expect(splitFillBatch([])).toEqual([])
  })

  it('длинные строки режутся по длине, а не по числу', () => {
    // Сорок длинных подсказок — это уже не партия: ответ на них упирается в предел вывода.
    const long = 'x'.repeat(500)
    expect(splitFillBatch([long, long, long, long], 40, 1000).map(chunk => chunk.length)).toEqual([1, 1, 1, 1])
  })

  it('строка длиннее предела уходит в партию одна, а не теряется', () => {
    const huge = 'y'.repeat(5000)
    expect(splitFillBatch([huge, 'short'], 40, 1000)).toEqual([[huge], ['short']])
  })
})

describe('партия ограничена и очищена', () => {
  it('пустое и повтор убираются, порядок сохраняется', () => {
    expect(fillBatch(['A', ' ', 'B', 'A', ' C '])).toEqual(['A', 'B', 'C'])
  })

  it('строки из одних подстановок не спрашиваются: переводить в них нечего', () => {
    // Такие строки живут в наборе сообщений («{reason} {count}», «, », «…») и каждый
    // проход уходили в запрос, оставляя ту же пустую клетку.
    expect(needsTranslation('{reason} {count}')).toBe(false)
    expect(needsTranslation(', ')).toBe(false)
    expect(needsTranslation('—')).toBe(false)
    expect(needsTranslation('{name} (id={id})')).toBe(true)
    expect(needsTranslation('- {belief} ({count} sources)')).toBe(true)
    expect(fillBatch(['{reason} {count}', '{n} suggestions', ', '])).toEqual(['{n} suggestions'])
  })

  it('слишком большая партия отклоняется до запроса', () => {
    const many = Array.from({ length: FILL_REQUEST_MAX + 1 }, (_item, index) => `term ${String(index)}`)
    // Текст ошибки зависит от языка процесса, поэтому проверяется код, а не формулировка.
    let caught: unknown
    try {
      fillBatch(many)
    } catch (error) {
      caught = error
    }
    expect((caught as { code?: string } | undefined)?.code).toBe('DICTIONARY_FILL_TOO_MANY')
  })
})
