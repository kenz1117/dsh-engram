/**
 * 入殿导航：会话首轮时主动提议一条入门巡游路线。
 * 设计：取当前会话最近一轮 user/project 的高频 kind + importance × confidence 排序，
 * 给出 3-5 个候选 + 一段邀请语，便于 agent 在首轮回复中直接带入。
 * 不会真正写入记忆，仅作为「开场引导」决策输入。
 * @module @kenz1117/dsh-engram/tour-proposal
 */

import type { EngramScope, MemoryRecord } from './types.ts'

/** 入殿建议结构。 */
export interface TourProposal {
  /** 给 agent 的开场邀请语（已结合宫殿状态动态生成）。 */
  readonly greeting: string
  /** 建议走一趟的记忆（按重要度降序，最多 5 条）。 */
  readonly suggestedStops: readonly MemoryRecord[]
  /** 当前活跃记忆总数（用于邀请语决策：0 条 vs 多于 10 条语气不同）。 */
  readonly activeCount: number
  /** 是否处于「宫殿尚空」状态（邀请语应建议先放第一段记忆）。 */
  readonly empty: boolean
}

/**
 * 构造入殿建议。
 * @param scope - 作用域（user/project；shared 单独处理）
 * @param records - 当前 scope 的 active 条目（已按 importance × confidence 倒序）
 * @param focusKind - 本轮 user 输入的主题（可选；存在时优先选同 kind）
 */
export function buildTourProposal(
  scope: EngramScope,
  records: readonly MemoryRecord[],
  focusKind?: string,
): TourProposal {
  const active = records.filter(r => r.status === 'active')
  const empty = active.length === 0
  const limit = Math.min(5, Math.max(1, active.length))
  const scored = [...active].sort((a, b) => {
    // focus kind 优先，再按 importance × confidence 倒序
    const focusBoost = (record: MemoryRecord): number => focusKind !== undefined && record.kind === focusKind ? 1 : 0
    const scoreA = focusBoost(a) * 1000 + a.importance * a.confidence * 100
    const scoreB = focusBoost(b) * 1000 + b.importance * b.confidence * 100
    return scoreB - scoreA
  }).slice(0, limit)

  const greeting = empty
    ? `[${scope}] 宫殿尚空。建议：先放第一段记忆（例如一条 fact 或 preference），让后续会话有锚点可循。`
    : `[${scope}] 宫殿现存 ${active.length} 条 active 记忆。建议开场巡游：${scored.map((r, i) => `第 ${i + 1} 站「${r.content.slice(0, 24)}${r.content.length > 24 ? '…' : ''}」`).join('；')}。`

  return { greeting, suggestedStops: scored, activeCount: active.length, empty }
}