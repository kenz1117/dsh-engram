/**
 * 召回输出的字符预算：单条与总量双重截断，控制记忆正文占用的模型上下文
 * （协议内定值，对齐同类记忆插件的单轮召回配额，非部署可变项）。
 * @module @kenz1117/dsh-engram/retrieve/budget
 */

/** 单条召回行最大字符数（超长截断加省略号）。 */
export const RECALL_PER_ITEM_CHARS = 1200

/** 单次召回输出正文的总字符预算（含 id 与元信息行）。 */
export const RECALL_TOTAL_CHARS = 4800

/**
 * 截断单条文本到 maxChars（超长加省略号）。
 * @param text - 原文。
 * @param maxChars - 上限，默认 RECALL_PER_ITEM_CHARS。
 */
export function truncateItem(text: string, maxChars: number = RECALL_PER_ITEM_CHARS): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`
}

/**
 * 总量预算内贪心装填行（保序；某行装不下时继续尝试更短的后续行），
 * 被跳过的行计数并在末尾追加提示行。
 * @param lines - 候选行（已按相关性排序）。
 * @param totalBudget - 总字符预算，默认 RECALL_TOTAL_CHARS。
 * @returns 装填后的行；有丢弃时末尾含「另有 N 条…」提示。
 */
export function enforceBudget(lines: readonly string[], totalBudget: number = RECALL_TOTAL_CHARS): string[] {
  const kept: string[] = []
  let used = 0
  let dropped = 0
  for (const line of lines) {
    if (used + line.length > totalBudget) {
      dropped += 1
      continue
    }
    kept.push(line)
    used += line.length
  }
  if (dropped > 0) kept.push(`（另有 ${dropped} 条未展示：缩小查询范围或降低 limit 后重试）`)
  return kept
}
