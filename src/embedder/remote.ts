/**
 * OpenAI 兼容端点嵌入器：`POST {baseUrl}/embeddings`。
 *
 * 端点既可以是公开的嵌入服务，也可以是局域网内的推理服务器（LM Studio、Ollama、vLLM）。
 * 对插件而言区别只在 baseUrl 的取值：「本地/远程」的边界是部署决定，不是代码决定，
 * 因此实现只有一份。
 *
 * 密钥只从配置或环境变量读取：不进入日志、不进入错误文本、不进入诊断字段 model。
 * @module @kenz1117/dsh-engram/embedder/remote
 */

import { recordEmbedAttempt } from './stats.ts'
import { message } from '../i18n/messages.ts'
import { EngramError } from '../types.ts'
import type { EngramEmbedder } from './interface.ts'

/** 单次请求的文本条数上限：过大的批通常被服务端整体拒绝。 */
const DEFAULT_BATCH_SIZE = 32

/** 单次请求的超时毫秒数。 */
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * 加载期试探请求的正文：只用来验证端点可达且模型存在，不参与任何检索。
 * 用 ASCII 常量而不是 message()：这段文字发往外部服务，不是给人看的界面文本。
 */
const PROBE_TEXT = 'dsh-engram: embedder probe'

/** 远程嵌入器创建参数。 */
export interface RemoteEmbedderOptions {
  /** 模型标识，原样传给服务端（例如 text-embedding-3-small）。 */
  readonly model: string
  /** 端点根地址，形如 https://api.example.com/v1——实现自己补 /embeddings。 */
  readonly baseUrl: string
  /** Bearer 密钥；空值表示端点不需要鉴权（局域网内常见）。 */
  readonly apiKey?: string | undefined
  /** 环境变量的名字；每次请求时读取，优先于 `apiKey`。 */
  readonly apiKeyEnv?: string | undefined
  /** 单次请求的文本条数上限；默认 32。 */
  readonly batchSize?: number
  /** 单次请求的超时；默认 30000 毫秒。 */
  readonly timeoutMs?: number
}

/** 响应的最小形状：只取需要的字段，其余忽略。 */
interface EmbeddingsResponse {
  data?: { index?: number; embedding?: number[] }[]
}

/**
 * 把向量归一到单位长度。
 *
 * 接口承诺归一化向量，这同时消除了余弦与点积的差别：范数非零时两者相等。
 * 零向量原样返回——调用方把它当作「没有信号」。
 */
function toUnitVector(values: readonly number[]): Float32Array {
  const out = new Float32Array(values.length)
  let sumSquares = 0
  for (let i = 0; i < values.length; i++) sumSquares += values[i]! * values[i]!
  if (sumSquares === 0) return out
  const scale = 1 / Math.sqrt(sumSquares)
  for (let i = 0; i < values.length; i++) out[i] = values[i]! * scale
  return out
}

/**
 * 创建远程嵌入器。
 *
 * 创建时先发一次试探请求：端点不可达、密钥错误、模型缺失都在加载期暴露，
 * 调用方据此把检索降级为纯关键词，而不是等到第一次写入才失败。
 *
 * @param options - 端点参数。
 * @returns 就绪的 EngramEmbedder。
 * @throws EngramError(code=EMBEDDER_REMOTE_FAILED) 试探请求失败。
 */
export async function createRemoteEmbedder(options: RemoteEmbedderOptions): Promise<EngramEmbedder> {
  const endpoint = `${options.baseUrl.replace(/\/+$/, '')}/embeddings`
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  /**
   * 请求头在每次请求时组装，而不是在创建时确定：变量名由配置给出，值却可能
   * 在运行中变化（轮换密钥、注入到测试环境），换密钥不该要求重启插件。
   */
  const requestHeaders = (): Record<string, string> => {
    const fromEnv = options.apiKeyEnv === undefined || options.apiKeyEnv === ''
      ? undefined
      : process.env[options.apiKeyEnv]
    const apiKey = fromEnv !== undefined && fromEnv !== '' ? fromEnv : options.apiKey
    if (apiKey === undefined || apiKey === '') return headers
    return { ...headers, Authorization: `Bearer ${apiKey}` }
  }

  /** 单次请求；服务端给了 index 就按 index 还原顺序。 */
  const request = async (texts: readonly string[]): Promise<Float32Array[]> => {
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: requestHeaders(),
        body: JSON.stringify({ model: options.model, input: [...texts], encoding_format: 'float' }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new EngramError(
        'EMBEDDER_REMOTE_FAILED',
        message('store.embedderRemoteUnreachable', { baseUrl: options.baseUrl, timeoutMs }),
        { cause: error },
      )
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new EngramError(
        'EMBEDDER_REMOTE_FAILED',
        message('store.embedderRemoteHttp', {
          status: response.status,
          detail: detail === '' ? '' : `: ${detail.slice(0, 200)}`,
        }),
      )
    }
    let payload: EmbeddingsResponse | undefined
    try {
      payload = await response.json() as EmbeddingsResponse
    } catch (error) {
      // 非 JSON 正文是「对端不是嵌入服务」的答复，不是解析器崩溃：外面应该看到
      // 我们的错误码，否则调用方无法把它与自己的代码错误区分开。
      throw new EngramError('EMBEDDER_REMOTE_FAILED', message('store.embedderRemoteBody'), { cause: error })
    }
    const data = payload?.data
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new EngramError(
        'EMBEDDER_REMOTE_FAILED',
        message('store.embedderRemoteCount', {
          received: Array.isArray(data) ? data.length : message('store.embedderRemoteCountNa'),
          expected: texts.length,
        }),
      )
    }
    const ordered = data.every(item => typeof item.index === 'number')
      ? [...data].sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
      : data
    return ordered.map(item => {
      const values = item.embedding
      if (!Array.isArray(values) || values.length === 0) {
        throw new EngramError('EMBEDDER_REMOTE_FAILED', message('store.embedderRemoteEmpty'))
      }
      return toUnitVector(values)
    })
  }

  const embed = async (texts: readonly string[]): Promise<Float32Array[]> => {
    if (texts.length === 0) return []
    // 失败可见性（issue #60）：与本地实现同一套进程级计数；加载期试探请求
    // 也走这里，算一次真实尝试。
    recordEmbedAttempt(false)
    try {
      const vectors: Float32Array[] = []
      for (let start = 0; start < texts.length; start += batchSize) {
        vectors.push(...await request(texts.slice(start, start + batchSize)))
      }
      return vectors
    } catch (error) {
      recordEmbedAttempt(true, error)
      throw error
    }
  }

  // 试探请求走的是与工作调用完全相同的路径：这里不另设「连接检查」，
  // 免得检查与实际请求行为分叉。
  await embed([PROBE_TEXT])

  return {
    model: options.model,
    embed,
    // 本地没有需要释放的资源：连接由运行时池化。
    close: async () => { /* 无可释放 */ },
  }
}
