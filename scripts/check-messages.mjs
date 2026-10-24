#!/usr/bin/env node
/**
 * Проверка словаря служебных сообщений.
 *
 * Сборка (tsdown) типы не проверяет, поэтому опечатка в ключе проходит молча и
 * вылезает уже в бою — как ключ вместо текста. Эта проверка ловит:
 *   1. ключ запрошен кодом, но не объявлен в английском наборе (образец полноты);
 *   2. ключ объявлен, но нигде не запрашивается (мусор в словаре);
 *   3. ключ объявлен дважды;
 *   4. нет китайского перевода либо он лишний;
 *   5. дефекты словаря `i18n/ru.txt`, где переводы и живут: битая строка,
 *      отсутствующий перевод, лишняя строка, китайский внутри русского текста,
 *      внутреннее имя поля вместо наружного параметра.
 *
 * В коде остались два набора: английский (образец полноты и источник ключей) и
 * китайский (авторские формулировки). Русский — только файлом: слева в нём
 * английский текст, справа перевод (формат — src/i18n/dictionary.ts).
 *
 * Запуск: node scripts/check-messages.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SRC = resolve(import.meta.dirname, '..', 'src')
const CATALOG = join(SRC, 'i18n', 'catalog')
// Языки, чьи наборы лежат в коде. Русский — файлом, см. DICT ниже.
const LANGS = ['zh', 'en']
const DICT = resolve(import.meta.dirname, '..', 'i18n', 'ru.txt')

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (name.endsWith('.ts')) out.push(full)
  }
  return out
}

// 1. Ключи, запрошенные кодом.
// Ключ может стоять не только вторым аргументом: встречается и тернарное выражение
// (`scope === 'user' ? 'a.b' : 'c.d'`), поэтому берём все строки-ключи из аргументов.
const KEY_SHAPE = /^[a-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/

/** Текст аргументов вызова, начиная с позиции сразу после открывающей скобки. */
function callArguments(text, start) {
  let depth = 1
  let index = start
  let quote = ''
  while (index < text.length && depth > 0) {
    const ch = text[index]
    if (quote !== '') {
      if (ch === '\\') { index += 2; continue }
      if (ch === quote) quote = ''
      index += 1
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; index += 1; continue }
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    index += 1
  }
  return text.slice(start, index - 1)
}

const used = new Map()
for (const file of walk(SRC)) {
  if (file.startsWith(CATALOG)) continue
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(/\b(?:messageIn|message)\s*\(/g)) {
    const args = callArguments(text, match.index + match[0].length)
    for (const key of args.matchAll(/'([^']+)'/g)) {
      if (!KEY_SHAPE.test(key[1])) continue
      if (!used.has(key[1])) used.set(key[1], [])
      const where = file.slice(SRC.length + 1)
      if (!used.get(key[1]).includes(where)) used.get(key[1]).push(where)
    }
  }
}

// 2. Объявленные ключи — импортом модулей: так разбор не зависит от форматирования.
const merged = { zh: {}, en: {} }
const duplicates = []
for (const name of readdirSync(CATALOG)) {
  if (!name.endsWith('.ts')) continue
  const mod = await import(pathToFileURL(join(CATALOG, name)).href)
  for (const lang of LANGS) {
    const entries = mod[lang]
    if (entries === undefined) {
      duplicates.push(`модуль ${name}: нет набора ${lang}`)
      continue
    }
    for (const key of Object.keys(entries)) {
      if (Object.hasOwn(merged[lang], key)) duplicates.push(`ключ ${key} объявлен дважды (${lang})`)
      merged[lang][key] = entries[key]
    }
  }
}

const problems = []
const report = (kind, text) => problems.push({ kind, text })

for (const text of duplicates) report('duplicate', text)
for (const [key, where] of used) {
  if (!Object.hasOwn(merged.en, key)) report('missing-en', `запрошен, но не объявлен в en: ${key} — ${where.join(', ')}`)
}
for (const key of Object.keys(merged.en)) {
  if (!used.has(key)) report('unused', `объявлен, но пока не запрошен кодом: ${key}`)
}
for (const key of Object.keys(merged.en)) {
  if (!Object.hasOwn(merged.zh, key)) report('missing-lang', `нет перевода zh: ${key}`)
}
for (const key of Object.keys(merged.zh)) {
  if (!Object.hasOwn(merged.en, key)) report('extra-lang', `лишний ключ в zh (нет в en): ${key}`)
}

// Русский словарь: файл, ключ — английский текст из кода (см. src/i18n/dictionary.ts).
const { parseDictionary } = await import(pathToFileURL(join(SRC, 'i18n', 'dictionary.ts')).href)
let dictionary
try {
  dictionary = parseDictionary(readFileSync(DICT, 'utf8'))
} catch (error) {
  report('dictionary', `не прочитан словарь ${DICT}: ${error.message}`)
}
/** Английский текст → русский перевод. */
const ruTexts = new Map()
if (dictionary !== undefined) {
  for (const issue of dictionary.issues) report('dictionary', `стр.${issue.line} ${issue.kind}: ${issue.detail}`)
  // Один английский текст может обслуживать несколько ключей — сообщаем все.
  const keysByText = new Map()
  for (const [key, text] of Object.entries(merged.en)) {
    if (!keysByText.has(text)) keysByText.set(text, [])
    keysByText.get(text).push(key)
  }
  for (const [text, keys] of keysByText) {
    const ru = dictionary.entries.get(text)
    if (ru === undefined) report('missing-lang', `нет перевода ru: ${keys.join(', ')} — ${text.slice(0, 70)}`)
    else ruTexts.set(text, ru)
  }
  for (const text of dictionary.entries.keys()) {
    if (!keysByText.has(text)) report('extra-lang', `лишняя строка ru (такого английского текста нет в коде): ${text.slice(0, 70)}`)
  }
}

// Китайский, забытый внутри английского или русского значения, и расхождение
// подстановок {..} между языками: и то и другое проходит сборку молча.
// Русский сверяется с английским по подстановкам уже в разборщике словаря
// (`placeholderMismatch`), поэтому здесь его сравнивать с китайским незачем.
const HAN = /[\u4e00-\u9fff]/
const placeholders = (value) => [...String(value).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(',')
for (const key of Object.keys(merged.en)) {
  const english = merged.en[key]
  const zh = placeholders(merged.zh[key] ?? '')
  if (HAN.test(english)) report('chinese-left', `китайский остался в en: ${key} — ${english}`)
  const own = placeholders(english)
  if (own !== zh) report('placeholders', `разные подстановки в en: ${key} — zh[${zh}] en[${own}]`)
  const ru = ruTexts.get(english)
  if (ru !== undefined && HAN.test(ru)) report('chinese-left', `китайский остался в ru: ${key} — ${ru}`)
}

// Имена внутренних полей, просочившиеся в текст сообщения как имя параметра.
// Случай A-16 (2026-10-11): misc.placardImprovementHint во всех трёх языках велел
// прикрепить табличку «параметром imagery», хотя наружный параметр называется placard,
// а imagery — внутреннее имя поля (ImageryLabel, колонка imagery_json). Вызов с imagery
// проходит без единой ошибки и молча проглатывается, табличка не прикрепляется.
const INTERNAL_NAMES = /\b(imagery|imageryScore|imagery_json|imagery_score|slot_room|slot_index|ease_factor|interval_days|next_review_at|emotionalValence|sensoryTags)\b/
// Общее правило: идентификатор в стиле snake_case подозрителен, потому что публичная
// словарная пара — только имена инструментов (engram_*) и значения перечисления nextStrategy.
// Всё остальное в snake_case — почти наверняка внутреннее имя поля.
const SNAKE_NAME = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g
const PUBLIC_SNAKE = new Set(['search_keyword', 'search_room', 'search_timeline', 'ask_user'])
// tourNoImagery — исключение: там «imagery» (в русском «образ») это авторское слово для
// понятия «мысленный образ», а не имя параметра.
const FIELD_EXCEPTIONS = new Set(['tool.tourNoImagery'])
for (const key of Object.keys(merged.en)) {
  if (FIELD_EXCEPTIONS.has(key)) continue
  for (const [lang, value] of [['en', merged.en[key]], ['zh', merged.zh[key]], ['ru', ruTexts.get(merged.en[key])]]) {
    if (value === undefined) continue
    const internal = INTERNAL_NAMES.exec(String(value))
    if (internal !== null) {
      report('internal-field', `внутреннее имя «${internal[1]}» в тексте (${lang}): ${key} — ${value}`)
      continue
    }
    const snakes = [...String(value).matchAll(SNAKE_NAME)]
      .map((match) => match[0])
      .filter((name) => !name.startsWith('engram_') && !PUBLIC_SNAKE.has(name))
    if (snakes.length > 0) report('internal-field', `похоже на внутреннее имя «${snakes[0]}» в тексте (${lang}): ${key} — ${value}`)
  }
}

// Соответствие имён между половинами плагина: причины пропуска извлечения.
// Случай A-18 (2026-10-11): панель ждала ключ `unparsable`, а конвейер возвращал
// `unparseable-output` — пара не находилась, и панель показывала сырое английское
// значение вместо перевода. Здесь мы больше не держим отдельный список причин:
// берём то, что конвейер реально выдаёт (литералы в hook.ts), и требуем, чтобы
// каждая такая причина переводилась панелью. Обратное направление (панель
// переводит причину, которой в конвейере нет) — предупреждение, потому что часть
// веток вычисляется выражениями и разбор по литералам может не увидеть причину.
const hookText = readFileSync(join(SRC, 'ingest', 'hook.ts'), 'utf8')
const produced = new Set()
for (const line of hookText.split('\n')) {
  const at = line.indexOf('skipped:')
  if (at === -1) continue
  // Сравнения вида `typeof x === 'number'` дают литерал, который причиной не является.
  const expression = line.slice(at).replace(/typeof\s+\w+\s*===\s*'[^']*'/g, '')
  for (const literal of expression.matchAll(/'([a-z][a-z-]*)'/g)) produced.add(literal[1])
}
// throttleDecision возвращает причину напрямую, минуя поле skipped.
const throttleStart = hookText.indexOf('export function throttleDecision')
if (throttleStart !== -1) {
  const body = hookText.slice(throttleStart)
  for (const literal of body.slice(0, body.indexOf('\n}')).matchAll(/'([a-z][a-z-]*)'/g)) produced.add(literal[1])
}
const panelText = readFileSync(join(SRC, 'client', 'EngramPanel.tsx'), 'utf8')
const mapStart = panelText.indexOf('const SKIP_KEY')
const mapEnd = mapStart === -1 ? -1 : panelText.indexOf('\n}', mapStart)
if (mapStart === -1 || mapEnd === -1) {
  report('skip-key', 'не нашёл таблицу SKIP_KEY в src/client/EngramPanel.tsx — проверка потеряла опору')
} else {
  const skipMap = panelText.slice(mapStart, mapEnd)
  const mapped = new Set()
  for (const entry of skipMap.matchAll(/(?:'([a-z][a-z-]*)'|([a-z][a-z-]*))\s*:/g)) mapped.add(entry[1] ?? entry[2])
  for (const reason of produced) {
    if (mapped.has(reason)) continue
    report('skip-key', `панель не переводит причину пропуска «${reason}» — пара не найдётся, пользователь увидит сырое значение`)
  }
  for (const reason of mapped) {
    if (produced.has(reason)) continue
    report('skip-key-extra', `панель переводит причину «${reason}», которой нет среди выдаваемых в hook.ts`)
  }
  if (produced.size === 0) report('skip-key', 'не нашёл ни одной причины пропуска в hook.ts — проверка потеряла опору')
}

// Словарь панели (client/locales): ключ, объявленный, но нигде не запрошенный, — тот же
// мусор, что и на сервере, только проверки у него до сих пор не было. Ключи панели
// встречаются не только в вызовах `t('...')`: их держат таблицы вида KIND_KEY, где имя
// стоит строкой, — поэтому ищем ключ в кавычках по всей клиентской половине, а сам union
// EngramKey (объявление) из поиска исключаем: иначе каждый ключ «запрошен» собой.
const CLIENT = join(SRC, 'client')
/** Обход клиентской половины: здесь кроме .ts лежат .tsx, и без них проверка слепа. */
function walkClient(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walkClient(full))
    else if (name.endsWith('.ts') || name.endsWith('.tsx')) out.push(full)
  }
  return out
}
const panelIndexPath = join(CLIENT, 'locales', 'index.ts')
const panelIndex = readFileSync(panelIndexPath, 'utf8')
const panelUnion = /export type EngramKey[\s\S]*?\r?\n\r?\n/.exec(panelIndex)
const panelKeys = panelUnion === null
  ? []
  : [...panelUnion[0].matchAll(/\|\s*'([^']+)'/g)].map(match => match[1])
let panelCode = ''
for (const file of walkClient(CLIENT)) {
  const text = readFileSync(file, 'utf8')
  panelCode += `${file === panelIndexPath && panelUnion !== null ? text.replace(panelUnion[0], '') : text}\n`
}
const panelUnused = panelKeys.filter(key =>
  // Две формы обращения: строкой в вызове и свойством словаря (`DICTS[lang].key`).
  !new RegExp(`'${key}'|\\.${key}\\b`).test(panelCode))
if (panelUnion === null) report('panel-unused', 'не нашёл union EngramKey в src/client/locales/index.ts — проверка потеряла опору')
for (const key of panelUnused) report('panel-unused', `объявлен в словаре панели, но нигде не запрошен: ${key}`)

const TITLES = {
  'missing-en': 'запрошен кодом, но не объявлен в en',
  'missing-lang': 'нет перевода',
  'extra-lang': 'лишний ключ (нет в en)',
  duplicate: 'ключ объявлен дважды',
  dictionary: 'дефект словаря i18n/ru.txt',
  'chinese-left': 'китайский остался в en/ru',
  placeholders: 'расходятся подстановки {..}',
  'internal-field': 'внутреннее имя поля в тексте сообщения',
  'skip-key': 'причина пропуска без перевода в панели',
  'skip-key-extra': 'панель переводит причину, которой конвейер не выдаёт',
  unused: 'объявлен, но пока не запрошен кодом',
  'panel-unused': 'объявлен в словаре панели, но нигде не запрошен',
}
// «Пока не запрошен» — это нормальное промежуточное состояние: словарь пишут
// раньше, чем переписывают вызовы. Провалом считаются только остальные виды расхождений.
const ORDER = ['missing-en', 'missing-lang', 'extra-lang', 'duplicate', 'dictionary', 'chinese-left', 'placeholders', 'internal-field', 'skip-key', 'skip-key-extra', 'unused', 'panel-unused']
const WARNINGS = new Set(['unused', 'skip-key-extra', 'panel-unused'])
const critical = problems.filter((problem) => !WARNINGS.has(problem.kind))

// Числа печатаются раздельно: ключи и тексты — разные величины. Один английский
// текст может обслуживать несколько ключей, и тогда «en 486» против «ru 483» — не
// недостача перевода, а три общих текста. Раньше строка смешивала счёт ключей со
// счётом текстов, и разница в три выглядела как непереведённые сообщения.
const enKeys = Object.keys(merged.en).length
const zhKeys = Object.keys(merged.zh).length
const enByText = new Map()
for (const [key, text] of Object.entries(merged.en)) {
  if (!enByText.has(text)) enByText.set(text, [])
  enByText.get(text).push(key)
}
console.log(`запрошено кодом: ${used.size} ключей`)
console.log(`объявлено: en ${enKeys} ключей / ${enByText.size} текстов, zh ${zhKeys} ключей / ${new Set(Object.values(merged.zh)).size} текстов, ru ${ruTexts.size} текстов (файл i18n/ru.txt)`)
const sharedTexts = [...enByText].filter(([, keys]) => keys.length > 1)
if (sharedTexts.length > 0) {
  console.log(`  общих текстов: ${sharedTexts.length} — один английский текст обслуживает несколько ключей`)
  for (const [text, keys] of sharedTexts.slice(0, 12)) console.log(`   «${text.slice(0, 60)}» → ${keys.join(', ')}`)
  if (sharedTexts.length > 12) console.log(`   ... и ещё ${sharedTexts.length - 12}`)
}
for (const kind of ORDER) {
  const group = problems.filter((problem) => problem.kind === kind)
  if (group.length === 0) continue
  console.log(`\n${TITLES[kind]}: ${group.length}`)
  // Имена печатаются все: список нужен как рабочий, а не как счётчик.
  for (const item of group) console.log('  ' + item.text)
}

if (critical.length === 0) {
  console.log('\nкритичных расхождений нет')
} else {
  console.log(`\nкритичных расхождений: ${critical.length}`)
  process.exitCode = 1
}
