import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRemoteEmbedder } from '../src/embedder/remote.ts'

/**
 * OpenAI-совместимый эмбеддер на подставном `fetch`.
 *
 * Сеть здесь не нужна и не должна быть нужна: проверяется наша сторона протокола
 * (адрес, тело, заголовки, разбор ответа и вид ошибки), а не чужой сервис.
 * Первый вызов у каждой сборки — пробный: так устроен сам модуль.
 */

interface Call {
  readonly url: string
  readonly body: { model: string, input: string[] }
  readonly headers: Record<string, string>
}

const OPTIONS = { model: 'text-embedding-3-small', baseUrl: 'https://api.test/v1/' } as const

function stubFetch(reply: (call: Call, index: number) => Response | Promise<Response>): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const call: Call = {
      url,
      body: JSON.parse(String(init.body)) as { model: string, input: string[] },
      headers: { ...(init.headers as Record<string, string>) },
    }
    calls.push(call)
    return reply(call, calls.length - 1)
  })
  return calls
}

function vectors(rows: { index?: number, embedding: number[] }[]): Response {
  return new Response(JSON.stringify({ data: rows }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Ответ на пробный запрос: один единичный вектор. */
function probe(): Response {
  return vectors([{ index: 0, embedding: [1, 0] }])
}

/** Ответ на рабочий запрос: единичный вектор на каждый текст. */
function perText(call: Call): Response {
  return vectors(call.body.input.map((_, index) => ({ index, embedding: [1, 0] })))
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.ENGRAM_TEST_KEY
})

describe('createRemoteEmbedder', () => {
  it('при сборке шлёт пробный запрос на {baseUrl}/embeddings и снимает лишний слэш', async () => {
    const calls = stubFetch(probe)
    await createRemoteEmbedder(OPTIONS)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.test/v1/embeddings')
    expect(calls[0]!.body.model).toBe('text-embedding-3-small')
    expect(calls[0]!.body.input).toHaveLength(1)
  })

  it('возвращает единичные векторы и восстанавливает порядок по index', async () => {
    stubFetch((_call, index) => index === 0
      ? probe()
      : vectors([
        { index: 1, embedding: [0, 2] },
        { index: 0, embedding: [3, 4] },
      ]))
    const embedder = await createRemoteEmbedder(OPTIONS)
    const [first, second] = await embedder.embed(['a', 'b'])
    expect(first).toHaveLength(2)
    expect(first![0]).toBeCloseTo(0.6, 5)
    expect(first![1]).toBeCloseTo(0.8, 5)
    expect(second![0]).toBeCloseTo(0, 5)
    expect(second![1]).toBeCloseTo(1, 5)
  })

  it('без index берёт порядок ответа как есть', async () => {
    stubFetch((_call, index) => index === 0
      ? probe()
      : vectors([{ embedding: [1, 1] }, { embedding: [0, 1] }]))
    const embedder = await createRemoteEmbedder(OPTIONS)
    const [first, second] = await embedder.embed(['a', 'b'])
    expect(first![0]).toBeCloseTo(Math.SQRT1_2, 3)
    expect(first![1]).toBeCloseTo(Math.SQRT1_2, 3)
    expect(second![0]).toBeCloseTo(0, 5)
    expect(second![1]).toBeCloseTo(1, 5)
  })

  it('режет запрос по batchSize, а не отправляет всё одним телом', async () => {
    const calls = stubFetch((call, index) => index === 0 ? probe() : perText(call))
    const embedder = await createRemoteEmbedder({ ...OPTIONS, batchSize: 2 })
    const result = await embedder.embed(['a', 'b', 'c'])
    expect(result).toHaveLength(3)
    // пробный + 2 + 1
    expect(calls.map(call => call.body.input.length)).toEqual([1, 2, 1])
  })

  it('пустой список текстов не ходит в сеть', async () => {
    const calls = stubFetch(probe)
    const embedder = await createRemoteEmbedder(OPTIONS)
    expect(await embedder.embed([])).toEqual([])
    expect(calls).toHaveLength(1) // только пробный
  })

  it('число векторов не совпало с числом текстов — ошибка, а не укороченный ответ', async () => {
    stubFetch((_call, index) => index === 0 ? probe() : vectors([{ index: 0, embedding: [1, 0] }]))
    const embedder = await createRemoteEmbedder(OPTIONS)
    await expect(embedder.embed(['a', 'b'])).rejects.toMatchObject({ code: 'EMBEDDER_REMOTE_FAILED' })
  })

  it('тело не JSON — наш код ошибки, а не SyntaxError наружу', async () => {
    stubFetch((_call, index) => index === 0
      ? probe()
      : new Response('<html>service page</html>', { status: 200 }))
    const embedder = await createRemoteEmbedder(OPTIONS)
    const failure = await embedder.embed(['a']).catch((error: unknown) => error) as { name?: string, code?: string }
    expect(failure).toMatchObject({ name: 'EngramError', code: 'EMBEDDER_REMOTE_FAILED' })
  })

  it('пустой вектор в ответе — ошибка', async () => {
    stubFetch((_call, index) => index === 0 ? probe() : vectors([{ index: 0, embedding: [] }]))
    const embedder = await createRemoteEmbedder(OPTIONS)
    await expect(embedder.embed(['a'])).rejects.toMatchObject({ code: 'EMBEDDER_REMOTE_FAILED' })
  })

  it('HTTP-ошибка несёт статус и начало тела ответа', async () => {
    stubFetch((_call, index) => index === 0
      ? probe()
      : new Response('invalid api key', { status: 401 }))
    const embedder = await createRemoteEmbedder(OPTIONS)
    const failure = await embedder.embed(['a']).catch((error: unknown) => error) as { code?: string, message: string }
    expect(failure.code).toBe('EMBEDDER_REMOTE_FAILED')
    expect(failure.message).toContain('401')
    expect(failure.message).toContain('invalid api key')
  })

  it('недоступный или медленный эндпоинт — ошибка при сборке, а не при первой записи', async () => {
    stubFetch(() => Promise.reject(new DOMException('The operation was aborted.', 'TimeoutError')))
    await expect(createRemoteEmbedder(OPTIONS)).rejects.toMatchObject({ code: 'EMBEDDER_REMOTE_FAILED' })
  })

  it('ключ из конфигурации уходит в Authorization, без ключа заголовка нет', async () => {
    const withKey = stubFetch(probe)
    await createRemoteEmbedder({ ...OPTIONS, apiKey: 'secret-config' })
    expect(withKey[0]!.headers.Authorization).toBe('Bearer secret-config')

    vi.unstubAllGlobals()
    const withoutKey = stubFetch(probe)
    await createRemoteEmbedder(OPTIONS)
    expect(withoutKey[0]!.headers.Authorization).toBeUndefined()
  })

  it('ключ из переменной окружения читается в момент запроса, а не при сборке', async () => {
    process.env.ENGRAM_TEST_KEY = 'first'
    const calls = stubFetch(probe)
    const embedder = await createRemoteEmbedder({ ...OPTIONS, apiKeyEnv: 'ENGRAM_TEST_KEY', apiKey: 'conf' })
    expect(calls[0]!.headers.Authorization).toBe('Bearer first')

    process.env.ENGRAM_TEST_KEY = 'second'
    await embedder.embed(['a'])
    expect(calls[1]!.headers.Authorization).toBe('Bearer second')
  })

  it('переменная окружения главнее ключа из конфигурации, пустая — уступает ему', async () => {
    process.env.ENGRAM_TEST_KEY = 'from-env'
    const calls = stubFetch(probe)
    await createRemoteEmbedder({ ...OPTIONS, apiKeyEnv: 'ENGRAM_TEST_KEY', apiKey: 'conf' })
    expect(calls[0]!.headers.Authorization).toBe('Bearer from-env')

    process.env.ENGRAM_TEST_KEY = ''
    vi.unstubAllGlobals()
    const fallback = stubFetch(probe)
    await createRemoteEmbedder({ ...OPTIONS, apiKeyEnv: 'ENGRAM_TEST_KEY', apiKey: 'conf' })
    expect(fallback[0]!.headers.Authorization).toBe('Bearer conf')
  })
})
