/**
 * HTTP-клиент судьи Jev, два протокола (поле `protocol` соединения):
 *
 *   `systemone` — приватный эндпоинт System One (`askNoul`): пачка «Noul»-вопросов
 *   (да/нет) по одному тексту состояния, формат state/questions (POST на адрес
 *   соединения), ответ `{answers:{qid:{noul}}}`. Понимают только Jev-модели.
 *
 *   `chat` — любой OpenAI-совместимый chat completions (`askChat`): те же вопросы
 *   уезжают обычным prompt'ом (system — инструкция отвечать только JSON, user —
 *   состояние + инструкции вопросов + контракт ответа `{"answers":{"qid":{"p"}}}`),
 *   разбор ответа терпим к markdown-заборам и прозе вокруг JSON (#59: чат-модель
 *   нельзя заставить вернуть ровно протокол, поэтому контракт держит клиент).
 *
 * Оба пути дают одно и то же: вопрос id → вероятность 0-1. Реквизиты соединения
 * (адрес, ключ, модель) клиент не хранит и не читает сам: их собирает мост
 * `./host.ts` из данных хоста DSH — так провайдер и токен вводятся ровно в одном
 * месте, у хоста.
 *
 * Сетевой сбой, не-2xx, отсутствие полей в ответе — всё бросает ошибку наверх,
 * а вызывающий по каждой точке молча откатывается к чистым правилам.
 * @module @kenz1117/dsh-engram/jev/client
 */

import { randomUUID } from 'node:crypto'
import type { ResolvedJevConfig } from '../config.ts'
import type { JudgeQuestion, JudgeAnswers, MemoryJudge } from '../write-disposition.ts'
import type { JevConnection } from './host.ts'

/**
 * opencode.ai 系端点的稳定会话头（#46）：Go 通道对缺该头的 System One 请求一律
 * 400 MissingSessionID。进程内生成一次、全程稳定（opencode 文档要求「每次对话带
 * 稳定的 x-opencode-session」；插件即一个客户端）。
 */
const OPENCODE_SESSION_ID = randomUUID()

/** 端点是否属于 opencode.ai（该家要求 x-opencode-session；别家不发多余的头）。 */
function isOpencodeEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname
    return host === 'opencode.ai' || host.endsWith('.opencode.ai')
  } catch {
    return false
  }
}

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
 * 从上游错误响应体提取可读摘录（#46）：JSON 时取 error.message（兼容 {error:{message}}
 * 与 {type:'error',error:{...}} 两种形状），非 JSON 取原文截断。空体返回空串。
 */
function jevUpstreamDetail(body: string): string {
  if (body.trim() === '') return ''
  const excerpt = (text: string): string => (text.length > 200 ? `${text.slice(0, 200)}…` : text)
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } }
    const upstream = typeof parsed.error?.message === 'string' ? parsed.error.message : body
    return ` — ${excerpt(upstream.trim())}`
  } catch {
    return ` — ${excerpt(body.trim())}`
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
        ...(isOpencodeEndpoint(connection.endpoint) ? { 'x-opencode-session': OPENCODE_SESSION_ID } : {}),
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
    // #46：带上游响应体摘录——「失败（HTTP）」不给排查线索，MissingSessionID /
    // Model is unavailable / Insufficient funds 三种处境的可操作信息全在上游消息里。
    const body = await response.text().catch(() => '')
    throw new JevCallError('http', `jev: HTTP ${response.status} from ${connection.endpoint}${jevUpstreamDetail(body)}`, response.status)
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
 * 拆出聊天模型回答里的 JSON 对象（#59 chat 协议）：聊天模型输出不可控——可能带
 * ```json 围栏、可能 JSON 前后挂说明文，甚至两者都有。步骤：
 *   1) 剥围栏与 prose：直接 JSON.parse；失败则取首个 `{` 到最后一个 `}` 之间的片段；
 *   2) 兼容三种形状：{answers:{qid:{p|noul|probability}}} / {answers:{qid: 数}} /
 *      {qid: 数}（末一种是无 answers 包裹的扁平契约）；
 *   3) 每个问题取数：仅收 [0,1] 内的有限数值；缺失/非数/越界由调用方按 shape 拒绝。
 * 导出以便单测直接覆盖解析容错，不必走网络。
 * @param content - 聊天模型返回的 message.content 原文。
 * @param questionIds - 期望回答的问题 id（缺一不可，逐一校验）。
 * @returns 问题 id → 概率 (0-1)。
 * @throws JevCallError('shape')：拆不出 JSON、形状不认识、答案缺失或越界。
 */
export function parseChatAnswers(content: string, questionIds: readonly string[]): Record<string, number> {
  // 剥 ```json …``` 围栏（```/JSON/大小写变体都算）：围栏内若恰好是合法 JSON 就直接用。
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(content)
  const candidate = fenced !== null ? fenced[1] ?? '' : content
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch {
    // prose 包着 JSON：取首个 { 到最后一个 }——最外层对象，忽略两侧解释文。
    const start = content.indexOf('{')
    const end = content.lastIndexOf('}')
    if (start === -1 || end <= start) {
      throw new JevCallError('shape', 'jev: chat answer contains no JSON object')
    }
    try {
      parsed = JSON.parse(content.slice(start, end + 1))
    } catch {
      throw new JevCallError('shape', 'jev: chat answer is not valid JSON')
    }
  }
  const root = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : undefined
  const answers = root !== undefined && root.answers !== undefined && root.answers !== null
    && typeof root.answers === 'object' && !Array.isArray(root.answers)
    ? root.answers as Record<string, unknown>
    : root
  if (answers === undefined) {
    throw new JevCallError('shape', 'jev: chat answer is not a recognised shape')
  }
  const result: Record<string, number> = {}
  for (const id of questionIds) {
    // 三种形状统一成一个取数视图：{p|noul|probability} 对象、直接数值。
    const entry = answers[id]
    const holder = entry !== null && typeof entry === 'object' && !Array.isArray(entry)
      ? entry as Record<string, unknown>
      : undefined
    const value = holder !== undefined
      ? holder.p ?? holder.noul ?? holder.probability
      : entry
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new JevCallError('shape', `jev: chat answer "${id}" is not a probability in [0, 1]`)
    }
    result[id] = value
  }
  return result
}

/** 裁决问题的 user prompt：状态文本 + 逐问题指令 + 输出契约（chat 协议与 askNoul 同一语义）。 */
function chatUserPrompt(state: string, questions: readonly JudgeQuestion[]): string {
  const lines = questions.map(question => `- "${question.id}": ${question.instructions}`)
  return [
    'State to judge:',
    state,
    '',
    'Questions (answer each one):',
    ...lines,
    '',
    'Respond with JSON only, no prose, matching exactly this contract:',
    `{"answers":{${questions.map(question => `"${question.id}":{"p":<0-1>}`).join(',')}}}`,
    'where each "p" is your probability (0 to 1) that the answer to the question is "yes".',
  ].join('\n')
}

/**
 * 向任何 OpenAI 兼容 chat completions 端点提出同一批 Noul 问题（#59 chat 通道）：
 * 问题作为普通 prompt 发出，响应按 JSON 契约解析。聊天模型无法强制其输出精确协议，
 * 因此解析带容错（见 `parseChatAnswers`）；凡不合契约的一律抛 JevCallError('shape')。
 * @param connection - 已组装的连接；endpoint 是完整的 …/chat/completions 地址。
 * @param state - 进行判断的状态文本。
 * @param questions - 问题列表；空列表直接返回空结果，不发请求。
 * @param signal - 外部取消信号；与 connection.timeoutMs 的超时合并。
 * @returns 问题 id → 概率 (0-1)。
 * @throws 网络失败、非 2xx、choices 为空、缺 message.content 或答复不合契约时抛错。
 */
export async function askChat(
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
        // opencode 的 chat/completions 是同一家服务：稳定会话头规则同样适用（#46）。
        ...(isOpencodeEndpoint(connection.endpoint) ? { 'x-opencode-session': OPENCODE_SESSION_ID } : {}),
      },
      body: JSON.stringify({
        model: connection.model,
        temperature: 0,
        messages: [
          { role: 'system', content: 'You are a memory adjudication judge. Answer with JSON only — no prose, no markdown fences around the whole reply. The JSON must match the contract given in the user message exactly.' },
          { role: 'user', content: chatUserPrompt(state, questions) },
        ],
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(connection.timeoutMs)]),
    })
  } catch (error) {
    throw new JevCallError(failureKind(error), error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) {
    // 与 askNoul 同一错误口径：HTTP 码 + 上游响应体摘录（#46）。
    const body = await response.text().catch(() => '')
    throw new JevCallError('http', `jev: HTTP ${response.status} from ${connection.endpoint}${jevUpstreamDetail(body)}`, response.status)
  }
  const payload = (await response.json()) as {
    choices?: readonly { message?: { content?: unknown } }[] | null
  }
  const content = payload.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    throw new JevCallError('shape', 'jev: chat response missing choices[0].message.content')
  }
  return parseChatAnswers(content, questions.map(question => question.id))
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
      // 按连接的协议分派：systemone 走私有 state/questions，chat 走 OpenAI 兼容端点。
      return resolved.protocol === 'chat'
        ? askChat(resolved, state, questions)
        : askNoul(resolved, state, questions)
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
 * «провайдер + модель + ключ» рабочая. Она же и есть проверка протокола: для
 * systemone обычная чат-модель вероятностью не ответит; для chat — модель обязана
 * вернуть контракт JSON, что тоже проверяется этим же запросом.
 * Не бросает ошибку — причина возвращается полем error, чтобы панель её показала.
 * @param connection - проверяемое соединение (вызывающий уже собрал его из данных хоста).
 */
export async function testJevConnection(connection: JevConnection): Promise<JevConnectionTestResult> {
  const startedAt = Date.now()
  // ping 文案按协议分派：systemone 沿用原说明；chat 把输出契约直接写进问题里，
  // 让不懂契约的模型在这一步就现出原形。
  const ping = connection.protocol === 'chat'
    ? {
        id: 'ping',
        instructions: 'This is a connectivity test. Answer with JSON only, matching {"answers":{"ping":{"p":<0-1>}}} — return any probability between 0 and 1.',
      }
    : {
        id: 'ping',
        instructions: 'This is a connectivity test. Return any probability between 0 and 1.',
      }
  try {
    const answers = connection.protocol === 'chat'
      ? await askChat(connection, 'Connectivity test: this state exists.', [ping])
      : await askNoul(connection, 'Connectivity test: this state exists.', [ping])
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
