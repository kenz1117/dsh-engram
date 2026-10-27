/**
 * HTTP-клиент модели Jev (System One): задаёт пачке «Noul»-вопросов (да/нет) по
 * одному тексту состояния и получает вероятности. Формат запроса — JSON вида
 * state/questions (POST на адрес соединения), он не совместим с OpenAI-chat,
 * поэтому роутинг через хостовый `ctx.llm` невозможен и клиент остаётся свой.
 *
 * Реквизиты соединения (адрес, ключ, модель) клиент не хранит и не читает сам:
 * их собирает мост `./host.ts` из данных хоста DSH — так провайдер и токен
 * вводятся ровно в одном месте, у хоста.
 *
 * Сетевой сбой, не-2xx, отсутствие полей в ответе — всё бросает ошибку наверх,
 * а вызывающий по каждой точке молча откатывается к чистым правилам.
 * @module @kenz1117/dsh-engram/jev/client
 */

import type { ResolvedJevConfig } from '../config.ts'
import type { JudgeQuestion, JudgeAnswers, MemoryJudge } from '../write-disposition.ts'
import type { JevConnection } from './host.ts'

/** Тело ответа по одному вопросу (потребляем только поле вероятности `noul`). */
interface JevAnswerBody {
  noul?: unknown
}

/** Вид отказа связи: панель показывает его словом, чтобы «ключ не принят» не путать с «молчит». */
export type JevFailureKind = 'http' | 'network' | 'timeout' | 'shape'

/**
 * Отказ вызова Jev с разобранной причиной.
 *
 * Класс, а не строка: панель показывает не только текст ошибки, но и вид отказа и
 * HTTP-код — по ним видно, чинить ключ, сеть или протокол. Раньше всё это приходилось
 * угадывать по тексту сообщения.
 */
export class JevCallError extends Error {
  readonly kind: JevFailureKind
  /** HTTP-код ответа; у сетевого отказа и тайм-аута кода нет. */
  readonly status: number | undefined

  constructor(kind: JevFailureKind, message: string, status?: number) {
    super(message)
    this.name = 'JevCallError'
    this.kind = kind
    this.status = status
  }
}

/**
 * Причина отказа из брошенного значения: тайм-аут отличается от сети по имени ошибки,
 * всё остальное — сеть (fetch отверг соединение, DNS, TLS).
 * @param error - то, что попало в catch.
 * @returns вид отказа для панели.
 */
function failureKind(error: unknown): JevFailureKind {
  if (error instanceof JevCallError) return error.kind
  const name = error instanceof Error ? error.name : ''
  return name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network'
}

/**
 * Задать Noul-вопросы эндпоинту System One и получить вероятности.
 * @param connection - собранное соединение (адрес, ключ, модель, тайм-аут).
 * @param state - текст состояния, по которому идёт суждение (например, две записи рядом).
 * @param questions - список Noul-вопросов; пустой список возвращает пустой результат без запроса.
 * @param signal - внешний сигнал отмены; складывается с тайм-аутом из connection.timeoutMs.
 * @returns идентификатор вопроса → вероятность Noul (0-1; число и есть убеждённость).
 * @throws при сетевом сбое, не-2xx, отсутствии `answers`, пропуске ответа или не-числе вне 0-1.
 */
export async function askNoul(
  connection: JevConnection,
  state: string,
  questions: readonly JudgeQuestion[],
  signal: AbortSignal = new AbortController().signal,
): Promise<JudgeAnswers> {
  if (questions.length === 0) return {}
  let response: Response
  try {
    response = await fetch(connection.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${connection.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: connection.model,
        state,
        questions: Object.fromEntries(questions.map(question => [question.id, {
          type: 'noul',
          instructions: question.instructions,
        }])),
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(connection.timeoutMs)]),
    })
  } catch (error) {
    throw new JevCallError(failureKind(error), error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) {
    throw new JevCallError('http', `jev: HTTP ${response.status} from ${connection.endpoint}`, response.status)
  }
  const payload = (await response.json()) as { answers?: Record<string, JevAnswerBody> | null }
  if (payload.answers === undefined || payload.answers === null) {
    throw new JevCallError('shape', 'jev: response missing answers')
  }
  const result: Record<string, number> = {}
  for (const question of questions) {
    const noul = payload.answers[question.id]?.noul
    if (typeof noul !== 'number' || !Number.isFinite(noul) || noul < 0 || noul > 1) {
      throw new JevCallError('shape', `jev: answer "${question.id}" is not a noul probability`)
    }
    result[question.id] = noul
  }
  return result
}

/**
 * Собрать судью для конвейеров записи и инструментов из разрешённой конфигурации.
 *
 * Реквизиты соединения берутся у хоста лениво — при первом вопросе этого судьи —
 * и запоминаются на время его жизни: одна операция задаёт десятки вопросов, а
 * чтение конфигурации провайдера и секрета — это обращения к сервисам хоста.
 * Помнится только удачная сборка: неудачную следующая попытка повторяет, иначе
 * разовый сбой сервиса хоста залипал бы на всю жизнь судьи.
 *
 * @param config - разрешённая конфигурация Jev (включая три порога).
 * @param resolveConnection - сборщик соединения из данных хоста; строка = текст ошибки.
 * @returns реализация MemoryJudge; ask не принимает внешний сигнал отмены, только тайм-аут.
 */
export function createMemoryJudge(
  config: ResolvedJevConfig,
  resolveConnection: () => Promise<JevConnection | string>,
): MemoryJudge {
  let cached: JevConnection | undefined
  let attempt: Promise<JevConnection | string> | undefined
  const connection = async (): Promise<JevConnection | string> => {
    if (cached !== undefined) return cached
    // Параллельные вопросы одной операции делят одну попытку, а не собирают каждый своё.
    attempt ??= resolveConnection()
    const resolved = await attempt
    attempt = undefined
    if (typeof resolved === 'string') return resolved
    cached = resolved
    return resolved
  }
  return {
    deferMergeAbove: config.deferMergeAbove,
    deferAcceptBelow: config.deferAcceptBelow,
    contradictMinProbability: config.contradictMinProbability,
    ask: async (state, questions) => {
      const resolved = await connection()
      // Провайдер, модель или ключ недоступны: ошибка уходит наверх, и вызывающий
      // молча откатывается к чистым правилам — тот же путь, что при сетевом сбое.
      if (typeof resolved === 'string') throw new Error(resolved)
      return askNoul(resolved, state, questions)
    },
  }
}

/** Итог проверки связи: ok = адрес доступен и вернул корректную вероятность Noul. */
export interface JevConnectionTestResult {
  readonly ok: boolean
  readonly elapsedMs: number
  readonly probability: number | undefined
  readonly error: string | undefined
  /** HTTP-код ответа; у сетевого отказа и тайм-аута его нет. */
  readonly status: number | undefined
  /** Вид отказа: http / network / timeout / shape; удачная проверка — undefined. */
  readonly kind: JevFailureKind | undefined
}

/**
 * Проверка связи: минимальный ping-вопрос на эндпоинт — проверяет, что связка
 * «провайдер + модель + ключ» рабочая. Она же и есть проверка «модель действительно
 * Jev»: обычная чат-модель на запрос System One вероятностью не ответит.
 * Не бросает ошибку — причина возвращается полем error, чтобы панель её показала.
 * @param connection - проверяемое соединение (вызывающий уже собрал его из данных хоста).
 */
export async function testJevConnection(connection: JevConnection): Promise<JevConnectionTestResult> {
  const startedAt = Date.now()
  try {
    const answers = await askNoul(connection, 'Connectivity test: this state exists.', [{
      id: 'ping',
      instructions: 'This is a connectivity test. Return any probability between 0 and 1.',
    }])
    return {
      ok: true,
      elapsedMs: Date.now() - startedAt,
      probability: answers.ping,
      error: undefined,
      status: 200,
      kind: undefined,
    }
  } catch (error) {
    return {
      ok: false,
      elapsedMs: Date.now() - startedAt,
      probability: undefined,
      error: error instanceof Error ? error.message : String(error),
      status: error instanceof JevCallError ? error.status : undefined,
      kind: failureKind(error),
    }
  }
}
