/**
 * 召回占位：摄取切片中记忆召回类工具（engram_search 等）的输出替换为占位文本，
 * 阻断"记忆 → 摄取 → 新记忆 → 更强召回"的回声室循环。变换是防御性的：
 * 当前 collectTexts 只读用户/助手文本，工具结果本就不进摄取；一旦未来扩展
 * 摄取范围，该变换保证召回内容不会回流成新记忆。
 * @module @kenz1117/dsh-engram/security/recall
 */

import type { SessionEventLike } from '../llm/client.ts'

/** 召回类工具名单：输出含既有记忆正文、重新入库只会自我强化的工具。 */
export const RECALL_TOOL_NAMES: ReadonlySet<string> = new Set(['engram_search', 'engram_review', 'engram_timeline'])

/** 判断工具名是否为召回类工具。 */
export function isRecallToolName(name: unknown): boolean {
  return typeof name === 'string' && RECALL_TOOL_NAMES.has(name)
}

/** 切片中是否出现过召回类工具调用（摄取附注的触发条件）。 */
export function hasRecallToolCalls(events: readonly SessionEventLike[]): boolean {
  return events.some(event => {
    if (event.type !== 'tool/call') return false
    return isRecallToolName((event.data as { name?: unknown } | null)?.name)
  })
}

/** 生成召回占位文本（与 Memmy 的 omitted-from-capture 格式一致）。 */
export function recallPlaceholder(name: unknown): string {
  return `[engram memory result omitted from capture: ${isRecallToolName(name) ? name : 'engram_memory'}]`
}

/**
 * 把事件切片中召回工具的 tool/result 文本块替换为占位文本。
 * 工具名从切片内的 tool/call 事件建立 callId → name 映射后回查；
 * 无映射或非召回工具的结果原样保留。
 * @param events - 摄取切片事件（只读）。
 * @returns 原数组（无召回调用）或替换后的新数组。
 */
export function omitRecallToolResults(events: readonly SessionEventLike[]): readonly SessionEventLike[] {
  const callNames = new Map<string, string>()
  let hasRecall = false
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    const data = event.data as { callId?: unknown; name?: unknown } | null
    if (typeof data?.callId === 'string' && typeof data.name === 'string') {
      callNames.set(data.callId, data.name)
      if (isRecallToolName(data.name)) hasRecall = true
    }
  }
  if (!hasRecall) return events
  return events.map(event => {
    if (event.type !== 'tool/result') return event
    const data = event.data as {
      callId?: unknown
      message?: { content?: { content?: { type?: unknown; text?: unknown }[] }[] } | null
    } | null
    const name = typeof data?.callId === 'string' ? callNames.get(data.callId) : undefined
    if (data === null || data === undefined || name === undefined || !isRecallToolName(name)) return event
    // tool/result 的 message.content 是内容段数组，每段 .content 是内容块数组；
    // 只把 text 块的文本换成占位，结构原样保留。
    const message = data.message
    if (message === null || message === undefined) return event
    return {
      ...event,
      data: {
        ...data,
        message: {
          ...message,
          content: (message.content ?? []).map(segment => ({
            ...segment,
            content: (segment.content ?? []).map(block =>
              block?.type === 'text' ? { ...block, text: recallPlaceholder(name) } : block),
          })),
        },
      },
    }
  })
}
