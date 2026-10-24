/**
 * Языкозависимые образцы распознавания ввода.
 *
 * Часть правил плагина — не текст для человека, а **образцы**, по которым он узнаёт
 * содержание: слова-метки перед значением секрета, слова чистой болтовни, формы запрета
 * «не запоминай». Автор написал их под китайский язык, поэтому для русского пользователя
 * они срабатывали вхолостую: «пароль: …» уходил в память открытым текстом, «не запоминай
 * это» запись не отменяло.
 *
 * Образцы живут здесь, а не в самих проверках: это языковые данные, и меняться они должны
 * вместе с языковым пакетом. Логику проверок мы при этом **не переписываем** — она признана
 * продуманной (см. F-10 плана доработок).
 *
 * **Какие языки действуют.** Английский (язык отката, к которому сходится вся цепочка
 * плагина) плюс действующий язык. У английского второе слагаемое совпадает с первым,
 * так что правило одно, а не два.
 *
 * **Что сюда не попадает.** Форматы, не зависящие от языка интерфейса, — PEM, `Bearer`,
 * `sk-…`, `ghp_…`, `AKIA…`, телефоны и документы — остаются в `security/redact.ts`
 * включёнными всегда: номер телефона не перестаёт быть номером оттого, что интерфейс
 * переключили на другой язык. Критичная терминология тоже не переводится — см. §4
 * «ПРАВИЛА РАБОТЫ.md».
 *
 * @module @kenz1117/dsh-engram/i18n/patterns
 */

import { FALLBACK_LANGUAGE, type EngramLanguage } from './language.ts'
import { messageLanguage } from './messages.ts'

/**
 * Языки, образцы которых действуют при данном языке интерфейса.
 * @param language - действующий язык; по умолчанию — язык процесса.
 * @returns английский плюс действующий язык; у английского — только он.
 */
export function activePatternLanguages(language: EngramLanguage = messageLanguage()): readonly EngramLanguage[] {
  return language === FALLBACK_LANGUAGE ? [FALLBACK_LANGUAGE] : [FALLBACK_LANGUAGE, language]
}

/**
 * Значение секрета, строгий вариант: ASCII-токен без пробелов, от 4 символов.
 *
 * Кириллица и иероглифы сюда не подходят намеренно. Именно поэтому «пароль: неверный»
 * и «密码不能是中文» не дают ложных срабатываний: после метки идёт слово, а не токен.
 * Обратная сторона принята сознательно — секрет, записанный кириллицей, не вычищается.
 */
const SECRET_VALUE_STRICT = '[A-Za-z0-9!@#$%^&*()_+=\\[\\]{}<>/?\\\\|`~.-]{4,}'

/**
 * Значение по правилу автора для английского: кавычки либо непрерывный фрагмент
 * до разделителя. Оставлено дословно: английское правило требует явного `=` или `:`,
 * поэтому строгий класс значения ему не нужен, а смена образца изменила бы поведение
 * для английского пользователя.
 */
const SECRET_VALUE_EN = `("[^"\\n]*"|'[^'\\n]*'|[^'",;\\s)\\]}]+)`

/**
 * Образец метки секрета и тип, которым помечается найденное значение.
 * Тип хранится рядом с образцом, потому что у китайского правила он авторский
 * (`password`), а у английского другой (`secret-value`) — выравнивать их значило бы
 * менять то, что видно при разборе.
 */
export interface RedactLabelPattern {
  /** Регексп: первая группа — метка, вторая — значение. */
  readonly pattern: RegExp
  /** Тип для пометки `[REDACTED:<kind>]`. */
  readonly kind: string
}

/**
 * Метка секрета вместе с разделителем. Первая группа — сама метка (она остаётся в пометке
 * `[REDACTED:…]`, чтобы при разборе было видно, что именно нашли), вторая — значение.
 *
 * Границы слова у каждого языка свои: `\b` в JavaScript опирается на ASCII, поэтому для
 * кириллицы он не работает вовсе — там стоят явные просмотры назад и вперёд.
 */
const REDACT_LABEL: Readonly<Record<EngramLanguage, RedactLabelPattern>> = {
  zh: {
    pattern: new RegExp(`(密码|口令)[是为:：\\s]{0,3}(${SECRET_VALUE_STRICT})`, 'g'),
    kind: 'password',
  },
  en: {
    pattern: new RegExp(`\\b(password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|auth[_-]?token)\\b\\s*[=:]\\s*${SECRET_VALUE_EN}`, 'gi'),
    kind: 'secret-value',
  },
  ru: {
    pattern: new RegExp(`(?<![А-Яа-яЁёA-Za-z])(пароль|пароли|токен|секрет|ключ|логин|пользователь|имя пользователя)(?![А-Яа-яЁёA-Za-z])\\s*[=:]\\s*(${SECRET_VALUE_STRICT})`, 'gi'),
    kind: 'secret-value',
  },
}

/** Хвостовая пунктуация: после болтовни допустимы только знаки и пробелы. */
const TRAILING = '[!！,.，。?？~…\\s]*'

/**
 * Слова чистой болтовни: сообщение целиком состоит из них. Список намеренно узкий —
 * срабатывание **пропускает сообщение целиком**, а это молчаливая потеря записи, то есть
 * ровно та неисправность, с которой началась вся работа. При сомнении — записывать.
 */
const CHITCHAT_RE: Readonly<Record<EngramLanguage, RegExp>> = {
  zh: new RegExp(`^(?:你好|您好|嗨|哈喽|谢谢|感谢|好的|在吗|收到|辛苦了)${TRAILING}$`, 'iu'),
  en: new RegExp(`^(?:hello|hi|hey|thanks|thank you|ok|okay)${TRAILING}$`, 'iu'),
  ru: new RegExp(`^(?:привет|здравствуй|здравствуйте|добрый день|добрый вечер|доброе утро|спасибо|благодарю|ок|хорошо|понял|понятно|ясно|ага|угу|на связи)${TRAILING}$`, 'iu'),
}

/**
 * Явный запрет запоминать. В отличие от болтовни ищется **в любом месте** сообщения:
 * пользователь может оговориться в середине фразы. Отрицание обязательно — «запомни это»
 * означает обратное, и путать их нельзя.
 */
const NO_CAPTURE_RE: Readonly<Record<EngramLanguage, RegExp>> = {
  zh: /(?:不要|别|不用|无需)(?:把这?[个件些条]?|把上一?轮|把刚才)?(?:记|存)(?:住|录|下来|进去|到记忆|进记忆)/i,
  en: /don'?t\s+(?:remember|record|save)\s+(?:this|that|it)/i,
  ru: /не\s+(?:надо|нужно)\s+(?:это\s+)?(?:запоминать|записывать|сохранять)|не\s+(?:запоминай|запоминайте|запомни|записывай|записывайте|запиши|сохраняй|сохраняйте|сохрани)/i,
}

/** Экранирование слова перед подстановкой в регексп. */
function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Слова-метки, добавленные пользователем. Действуют **всегда**, независимо от языка:
 * пользователь добавляет их именно потому, что набора пакета не хватило, — в том числе
 * для языка, не совпадающего с языком интерфейса.
 */
let extraWords: readonly string[] = []
let extraWordsPattern: RedactLabelPattern | undefined

/**
 * Задать слова пользователя. Вызывается один раз при сборке плагина, из настроек.
 * @param words - список слов-меток; пустые и пробельные отбрасываются.
 */
export function setExtraRedactWords(words: readonly string[]): void {
  extraWords = words.map((word) => word.trim()).filter((word) => word !== '')
  extraWordsPattern = extraWords.length === 0
    ? undefined
    : {
        pattern: new RegExp(`(?:${extraWords.map(escapeForRegex).join('|')})\\s*[=:]\\s*(${SECRET_VALUE_STRICT})`, 'gi'),
        kind: 'secret-value',
      }
}

/** Слова пользователя, действующие сейчас (для проверок и показа). */
export function extraRedactWords(): readonly string[] {
  return extraWords
}

/**
 * Образцы меток секретов, действующие при данном языке.
 * @param language - действующий язык; по умолчанию — язык процесса.
 */
export function redactLabelPatterns(language: EngramLanguage = messageLanguage()): readonly RedactLabelPattern[] {
  // Набора для языка может не быть (новый язык без образцов): такие языки просто
  // не дают образцов, и молча пропускать их — правильно, подставлять чужие — нет.
  const patterns = activePatternLanguages(language)
    .map((lang) => REDACT_LABEL[lang])
    .filter((pattern): pattern is RedactLabelPattern => pattern !== undefined)
  return extraWordsPattern === undefined ? patterns : [...patterns, extraWordsPattern]
}

/**
 * Образцы «сообщение целиком есть болтовня».
 * @param language - действующий язык; по умолчанию — язык процесса.
 */
export function chitchatPatterns(language: EngramLanguage = messageLanguage()): readonly RegExp[] {
  return activePatternLanguages(language)
    .map((lang) => CHITCHAT_RE[lang])
    .filter((pattern): pattern is RegExp => pattern !== undefined)
}

/**
 * Образцы явного запрета запоминать.
 * @param language - действующий язык; по умолчанию — язык процесса.
 */
export function noCapturePatterns(language: EngramLanguage = messageLanguage()): readonly RegExp[] {
  return activePatternLanguages(language)
    .map((lang) => NO_CAPTURE_RE[lang])
    .filter((pattern): pattern is RegExp => pattern !== undefined)
}
