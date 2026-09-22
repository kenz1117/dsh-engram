/**
 * Jev System One 模型 HTTP 客户端：对一段状态文本并行提问多个 Noul（是否）判断，
 * 返回问题 id → 概率。API 形状是 state/questions JSON（POST {baseUrl}/v1/systemone），
 * 非 OpenAI chat 兼容，无法经宿主 ctx.llm 路由，因此独立成 HTTP 客户端。
 * 网络失败、非 2xx、响应缺失字段都向上抛错，由调用方逐点降级回纯规则判定。
 * @module @kenz1117/dsh-engram/jev/client
 */

import type { ResolvedJevConfig } from '../config.ts'
import type { JudgeQuestion, JudgeAnswers, MemoryJudge } from '../write-disposition.ts'

/** Jev 响应里单个问题的答案体（只消费 Noul 原语的 noul 字段）。 */
interface JevAnswerBody {
  noul?: unknown
}

/**
 * 调用 Jev /v1/systemone 端点并行回答 Noul 问题。
 * @param config - 已解析的 Jev 子配置（调用方先判 enabled）。
 * @param state - 待判断的状态文本（如两条记忆正文的对照）。
 * @param questions - Noul 问题列表；空列表直接返回空结果，不发请求。
 * @param signal - 外部取消信号；与配置超时信号合并监听，超时按配置 timeoutMs 兜底。
 * @returns 问题 id → Noul 概率（0-1，数字即信念）。
 * @throws 网络、非 2xx、响应缺 answers、答案缺失或非 0-1 数字时抛错。
 */
export async function askNoul(
  config: ResolvedJevConfig,
  state: string,
  questions: readonly JudgeQuestion[],
  signal: AbortSignal = new AbortController().signal,
): Promise<JudgeAnswers> {
  if (questions.length === 0) return {}
  const response = await fetch(new URL('/v1/systemone', config.baseUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey ?? ''}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      state,
      questions: Object.fromEntries(questions.map(question => [question.id, {
        type: 'noul',
        instructions: question.instructions,
      }])),
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
  })
  if (!response.ok) {
    throw new Error(`jev: HTTP ${response.status} from ${config.baseUrl}`)
  }
  const payload = (await response.json()) as { answers?: Record<string, JevAnswerBody> | null }
  if (payload.answers === undefined || payload.answers === null) {
    throw new Error('jev: response missing answers')
  }
  const result: Record<string, number> = {}
  for (const question of questions) {
    const noul = payload.answers[question.id]?.noul
    if (typeof noul !== 'number' || !Number.isFinite(noul) || noul < 0 || noul > 1) {
      throw new Error(`jev: answer "${question.id}" is not a noul probability`)
    }
    result[question.id] = noul
  }
  return result
}

/**
 * 从已解析配置构建可注入摄取与工具链路的判断器。
 * @param config - 已解析的 Jev 子配置（含三阈值）。
 * @returns MemoryJudge 实现；ask 不接收外部取消信号，仅受配置超时约束。
 */
export function createMemoryJudge(config: ResolvedJevConfig): MemoryJudge {
  return {
    deferMergeAbove: config.deferMergeAbove,
    deferAcceptBelow: config.deferAcceptBelow,
    contradictMinProbability: config.contradictMinProbability,
    ask: (state, questions) => askNoul(config, state, questions),
  }
}

/** 连接测试结果：ok = 端点可达且返回了合法 Noul 概率；失败时 error 给原因。 */
export interface JevConnectionTestResult {
  readonly ok: boolean
  readonly elapsedMs: number
  readonly probability: number | undefined
  readonly error: string | undefined
}

/**
 * 连接测试：向端点发一个最小 ping 问题，验证 baseUrl/model/apiKey 三者组合可用。
 * 不抛错——失败原因以 error 字段返回，供面板直接展示。
 * @param config - 待测试的生效配置（enabled 不参与判断；apiKey/baseUrl/model 用调用方给的值）。
 */
export async function testJevConnection(config: ResolvedJevConfig): Promise<JevConnectionTestResult> {
  const startedAt = Date.now()
  try {
    const answers = await askNoul(config, 'Connectivity test: this state exists.', [{
      id: 'ping',
      instructions: 'This is a connectivity test. Return any probability between 0 and 1.',
    }])
    return { ok: true, elapsedMs: Date.now() - startedAt, probability: answers['ping'], error: undefined }
  } catch (error) {
    return {
      ok: false,
      elapsedMs: Date.now() - startedAt,
      probability: undefined,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
