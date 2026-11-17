import { afterEach, describe, expect, it, vi } from 'vitest'
import { askChat, createMemoryJudge, JevCallError, parseChatAnswers, testJevConnection } from '../src/jev/client.ts'
import type { JevConnection } from '../src/jev/host.ts'

/**
 * #59 chat 通道：askChat / parseChatAnswers / 分派逻辑的离线测试。
 * System One 端点没有公共实现，E2E 真连不了——chat 通道全部用 stubFetch mock 覆盖：
 * happy path、围栏/扁平形状容错、shape 拒绝、非 2xx 上游摘录、opencode 会话头随协议生效。
 */

/** chat 协议的测试连接：endpoint 已是完整 chat/completions 地址（host 侧推导好）。 */
const chatConnection: JevConnection = {
  endpoint: 'https://chat.test/v1/chat/completions',
  apiKey: 'chat-key',
  model: 'gpt-4o',
  timeoutMs: 3000,
  protocol: 'chat',
}

/** 标准聊天响应：choices[0].message.content 承载模型答复，usage 等字段应被忽略。 */
function chatReply(content: string): unknown {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    usage: { prompt_tokens: 10, completion_tokens: 5 },
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
  }
}

/** stub 全局 fetch：返回固定 JSON 与状态码，返回 mock 供断言请求形状。 */
function stubFetch(payload: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), { status }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseChatAnswers：聊天输出的容错解析', () => {
  const ids = ['same_memory'] as const

  // 契约形状：{answers:{qid:{p}}}（主契约），以及 p/noul/probability 三个字段名都认。
  it('标准契约 {answers:{qid:{p}}} 直接解析', () => {
    expect(parseChatAnswers('{"answers":{"same_memory":{"p":0.7}}}', [...ids]))
      .toEqual({ same_memory: 0.7 })
  })

  it('字段名 noul 与 probability 与直接数值三种兼容形状都收', () => {
    expect(parseChatAnswers('{"answers":{"same_memory":{"noul":0.6}}}', [...ids]))
      .toEqual({ same_memory: 0.6 })
    expect(parseChatAnswers('{"answers":{"same_memory":{"probability":0.4}}}', [...ids]))
      .toEqual({ same_memory: 0.4 })
    expect(parseChatAnswers('{"answers":{"same_memory":0.2}}', [...ids]))
      .toEqual({ same_memory: 0.2 })
    // 扁平契约：没有 answers 包裹。
    expect(parseChatAnswers('{"same_memory":0.9}', [...ids]))
      .toEqual({ same_memory: 0.9 })
  })

  it('```json 围栏与 prose 包裹都能剥出 JSON', () => {
    expect(parseChatAnswers('```json\n{"answers":{"same_memory":{"p":0.7}}}\n```', [...ids]))
      .toEqual({ same_memory: 0.7 })
    expect(parseChatAnswers('Here is my judgment:\n{"answers":{"same_memory":{"p":0.3}}}\nHope this helps!', [...ids]))
      .toEqual({ same_memory: 0.3 })
    // 围栏本身不是合法 JSON（截断）时退回首尾大括号切片。
    expect(parseChatAnswers('```json\nnoise {"answers":{"same_memory":{"p":0.1}}} tail\n```', [...ids]))
      .toEqual({ same_memory: 0.1 })
  })

  it('多问题逐一取数', () => {
    const content = '{"answers":{"a":{"p":0},"b":{"p":1},"c":{"p":0.5}}}'
    expect(parseChatAnswers(content, ['a', 'b', 'c'])).toEqual({ a: 0, b: 1, c: 0.5 })
  })

  it('拆不出 JSON、形状不认识、缺失、非数都抛 JevCallError(shape)', () => {
    const cases: readonly string[] = [
      'I refuse to answer.', // 没有 JSON
      'not {broken json', // 有大括号但拆不出对象
      '{"answers":[]}', // answers 不是对象且扁平层也没有问题键
      '{"answers":{"same_memory":"high"}}', // 非数
      '{"answers":{"other":{"p":0.5}}}', // 缺了被问的问题
      '{"unwrapped":{"same_memory":{"p":0.5}}}', // 无 answers 包裹且键对不上
    ]
    for (const content of cases) {
      try {
        parseChatAnswers(content, [...ids])
        expect.unreachable(`should have thrown for: ${content}`)
      } catch (error) {
        expect(error).toBeInstanceOf(JevCallError)
        expect((error as JevCallError).kind).toBe('shape')
      }
    }
  })

  it('边界值 0 与 1 合法,负数与大于 1 拒绝', () => {
    expect(parseChatAnswers('{"answers":{"q":{"p":0}}}', ['q'])).toEqual({ q: 0 })
    expect(parseChatAnswers('{"answers":{"q":{"p":1}}}', ['q'])).toEqual({ q: 1 })
    expect(() => parseChatAnswers('{"answers":{"q":{"p":-0.1}}}', ['q'])).toThrow(JevCallError)
    expect(() => parseChatAnswers('{"answers":{"q":{"p":1.5}}}', ['q'])).toThrow(JevCallError)
  })
})

describe('askChat：标准 chat completions 请求', () => {
  it('happy path:POST 端点带模型与温度 0,按契约解析概率', async () => {
    const fetchMock = stubFetch(chatReply('{"answers":{"same_memory":{"p":0.7}}}'))
    const answers = await askChat(chatConnection, '状态文本', [{ id: 'same_memory', instructions: '同一事实吗' }])
    expect(answers).toEqual({ same_memory: 0.7 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://chat.test/v1/chat/completions')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer chat-key')
    const body = JSON.parse(init.body as string) as {
      model: string
      temperature: number
      messages: { role: string; content: string }[]
    }
    expect(body.model).toBe('gpt-4o')
    expect(body.temperature).toBe(0)
    expect(body.messages).toHaveLength(2)
    expect(body.messages[0]?.role).toBe('system')
    expect(body.messages[1]?.role).toBe('user')
    // state 与逐问题 instructions 都在 user prompt 里，输出契约也在。
    expect(body.messages[1]?.content).toContain('状态文本')
    expect(body.messages[1]?.content).toContain('同一事实吗')
    expect(body.messages[1]?.content).toContain('"same_memory"')
  })

  it('空问题列表短路,不发请求', async () => {
    const fetchMock = stubFetch(chatReply('{}'))
    const answers = await askChat(chatConnection, 's', [])
    expect(answers).toEqual({})
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('响应缺 choices 或 message.content 抛 JevCallError(shape)', async () => {
    stubFetch({ choices: [] })
    await expect(askChat(chatConnection, 's', [{ id: 'q', instructions: 'i' }]))
      .rejects.toThrow(/missing choices\[0\]\.message\.content/)
    stubFetch({ choices: [{ message: {} }] })
    await expect(askChat(chatConnection, 's', [{ id: 'q', instructions: 'i' }]))
      .rejects.toThrow(/missing choices\[0\]\.message\.content/)
  })

  it('回答不合契约(拒绝输出 JSON)抛 JevCallError(shape)', async () => {
    stubFetch(chatReply('The answer is yes, I am sure.'))
    const caught: unknown = await askChat(chatConnection, 's', [{ id: 'q', instructions: 'i' }]).catch(
      (reason: unknown) => reason,
    )
    expect(caught).toBeInstanceOf(JevCallError)
    expect((caught as JevCallError).kind).toBe('shape')
  })

  it('非 2xx 带上游响应体摘录,kind=http 且带状态码', async () => {
    stubFetch({ error: { message: 'Insufficient funds' } }, 402)
    const caught: unknown = await askChat(chatConnection, 's', [{ id: 'q', instructions: 'i' }]).catch(
      (reason: unknown) => reason,
    )
    expect(caught).toBeInstanceOf(JevCallError)
    const error = caught as JevCallError
    expect(error.kind).toBe('http')
    expect(error.status).toBe(402)
    expect(error.message).toContain('HTTP 402')
    expect(error.message).toContain('Insufficient funds')
  })

  it('网络失败 kind=network;超时按错误名分辨 kind=timeout', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    const network: unknown = await askChat(chatConnection, 's', [{ id: 'q', instructions: 'i' }]).catch(
      (reason: unknown) => reason,
    )
    expect((network as JevCallError).kind).toBe('network')
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    }))
    const timeout: unknown = await askChat(chatConnection, 's', [{ id: 'q', instructions: 'i' }]).catch(
      (reason: unknown) => reason,
    )
    expect((timeout as JevCallError).kind).toBe('timeout')
  })

  // opencode 的 chat/completions 也是它家服务：会话头规则随协议同样生效（#46）。
  it('opencode 端点带 x-opencode-session 头,别家端点不发', async () => {
    const opencode: JevConnection = { ...chatConnection, endpoint: 'https://opencode.ai/v1/chat/completions' }
    const fetchMock = stubFetch(chatReply('{"answers":{"q":{"p":0.5}}}'))
    await askChat(opencode, 's', [{ id: 'q', instructions: 'i' }])
    expect(((fetchMock.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>)['x-opencode-session'])
      .toBeDefined()
    const other = stubFetch(chatReply('{"answers":{"q":{"p":0.5}}}'))
    await askChat(chatConnection, 's', [{ id: 'q', instructions: 'i' }])
    expect(((other.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>)['x-opencode-session'])
      .toBeUndefined()
  })
})

describe('按协议分派：createMemoryJudge.ask 与 testJevConnection', () => {
  it('judge.ask 在 chat 连接上走 chat 通道并返回概率', async () => {
    const judge = createMemoryJudge(
      {
        enabled: true,
        provider: 'chat-provider',
        model: 'gpt-4o',
        endpoint: undefined,
        protocol: 'chat',
        timeoutMs: 3000,
        deferMergeAbove: 0.85,
        deferAcceptBelow: 0.15,
        contradictMinProbability: 0.8,
      },
      async () => chatConnection,
    )
    const fetchMock = stubFetch(chatReply('{"answers":{"q":{"p":0.42}}}'))
    await expect(judge.ask('s', [{ id: 'q', instructions: 'i' }])).resolves.toEqual({ q: 0.42 })
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string) as {
      messages: unknown[]
    }
    // 走的是 messages 形状的 chat 请求,而不是 state/questions 的 System One 请求。
    expect(Array.isArray(body.messages)).toBe(true)
  })

  it('systemone 连接仍走 askNoul(state/questions 形状)', async () => {
    const judge = createMemoryJudge(
      {
        enabled: true,
        provider: 'p',
        model: 'jev-1',
        endpoint: undefined,
        protocol: 'systemone',
        timeoutMs: 3000,
        deferMergeAbove: 0.85,
        deferAcceptBelow: 0.15,
        contradictMinProbability: 0.8,
      },
      async () => ({
        endpoint: 'https://jev.test/v1/systemone',
        apiKey: 'k',
        model: 'jev-1',
        timeoutMs: 3000,
        protocol: 'systemone' as const,
      }),
    )
    const fetchMock = stubFetch({ answers: { q: { noul: 0.3 } } })
    await expect(judge.ask('s', [{ id: 'q', instructions: 'i' }])).resolves.toEqual({ q: 0.3 })
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string) as {
      state?: unknown
      messages?: unknown
    }
    expect(body.state).toBe('s')
    expect(body.messages).toBeUndefined()
  })

  it('testJevConnection(chat):ping 说明带输出契约,成功回 ok 与概率', async () => {
    const fetchMock = stubFetch(chatReply('{"answers":{"ping":{"p":0.5}}}'))
    const result = await testJevConnection(chatConnection)
    expect(result.ok).toBe(true)
    expect(result.probability).toBe(0.5)
    expect(result.error).toBeUndefined()
    // ping 的问题文案协议感知：chat 说明里写明 JSON 契约。
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string) as {
      messages: { role: string; content: string }[]
    }
    const user = body.messages.find(message => message.role === 'user')?.content ?? ''
    expect(user).toContain('"ping"')
    expect(user).toContain('{"answers":{"ping":{"p":')
  })

  it('testJevConnection(chat):失败不抛错,error/kind 照常带出', async () => {
    stubFetch({}, 401)
    const result = await testJevConnection(chatConnection)
    expect(result.ok).toBe(false)
    expect(result.probability).toBeUndefined()
    expect(result.error).toContain('HTTP 401')
    expect(result.kind).toBe('http')
    expect(result.status).toBe(401)
  })
})
