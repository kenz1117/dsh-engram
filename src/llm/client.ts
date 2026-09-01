/**
 * 辅助 LLM 调用客户端：封装 ctx.llm.stream + BlockAssembler，路由从会话日志解析。
 * 遵守 model-visible ⟺ logged：每次辅助调用的完整请求由调用方 append 到会话日志。
 * @module @kenz1117/dsh-engram/llm/client
 */

import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { EngramError } from '../types.ts'

/** 一次辅助调用的模型路由。 */
export interface LlmRoute {
  readonly provider: string
  readonly model: string
}

/** 摄取/蒸馏可读的事件最小形状（会话日志事件的运行时窄化视图）。 */
export interface SessionEventLike {
  readonly type: string
  readonly data: unknown
  readonly time?: number
  readonly seq?: number
}

/** 从会话事件流解析最近一条模型路由（request/header → header.config）。 */
export function routeFromEvents(events: readonly SessionEventLike[]): LlmRoute | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type !== 'request/header') continue
    const config = (event.data as { header?: { config?: { provider?: unknown; model?: unknown } } } | null)?.header?.config
    if (typeof config?.provider === 'string' && typeof config?.model === 'string' && config.provider !== '' && config.model !== '') {
      return { provider: config.provider, model: config.model }
    }
  }
  return undefined
}

/** 从模型输出提取 JSON 数组：剥 Markdown 代码栅栏后解析；无有效数组返回 undefined。 */
export function parseJsonArray(text: string): unknown[] | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const candidate = (fenced?.[1] ?? text).trim()
  const start = candidate.indexOf('[')
  const end = candidate.lastIndexOf(']')
  if (start < 0 || end <= start) return undefined
  try {
    const parsed: unknown = JSON.parse(candidate.slice(start, end + 1))
    return Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** 终止原因转错误（session-title-llm 同款语义）。 */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'stop':
      return undefined
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens':
      return new Error('dsh-engram: 辅助调用输出达到 maxTokens 上限')
    case 'tool-calls':
      return new Error('dsh-engram: 辅助调用意外请求工具')
    default:
      return new Error(`dsh-engram: 不支持的终止原因 "${String((finish as { kind?: unknown }).kind)}"`)
  }
}

/**
 * 一次辅助 LLM 调用：流式收集文本输出。
 * @param ctx - 提供 llm 服务的上下文。
 * @param params.route - 模型路由（来自日志解析或显式配置）。
 * @param params.system - 系统指令。
 * @param params.userText - 用户侧 JSON 框定输入。
 * @param params.sessionId - 归属会话 id 字符串（调用方来自 agent.session.id，内部转 branded）。
 * @param params.maxTokens - 输出上限。
 * @param params.purpose - 用途标记（宿主 purpose 枚举未开放第三方注册，运行时经 cast 传入，
 *   token-meter 归因由 sessionId/provider/model 承载）。
 * @param params.signal - 取消信号。
 * @returns 模型输出全文。
 */
export async function streamText(
  ctx: Context,
  params: {
    route: LlmRoute
    system: string
    userText: string
    sessionId: string
    maxTokens: number
    purpose: string
    signal: AbortSignal
  },
): Promise<string> {
  const messages: Message[] = [{
    role: 'user',
    content: [{ type: 'text', text: params.userText }],
    source: { kind: 'plugin', plugin: 'dsh-engram' },
  }] as unknown as Message[]
  const options: GenerateOptions = {
    provider: params.route.provider,
    model: params.route.model,
    messages,
    system: params.system,
    maxTokens: params.maxTokens,
    sessionId: params.sessionId as never as NonNullable<GenerateOptions['sessionId']>,
    purpose: params.purpose as NonNullable<GenerateOptions['purpose']>,
    signal: params.signal,
  }
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(options)) {
    assembler.push(chunk)
  }
  const terminalError = finishError(assembler.finish)
  if (terminalError !== undefined) throw terminalError
  const text = assembler.blocks()
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
  if (text.trim() === '') throw new EngramError('LLM_EMPTY_OUTPUT', '辅助调用返回空输出')
  return text
}
