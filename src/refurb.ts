/**
 * 翻新清单：每周扫描 active 条目，按规则生成建议（合并 / 迁移 / 降级 / 拆分）。
 * 建议不直接执行，仅生成预览；UI 或 engram_audit_refurb 工具读取预览，用户逐条确认。
 * @module @kenz1117/dsh-engram/refurb
 */

import type { EngramScope, MemoryRecord } from './types.ts'

/** 单条翻新建议的动议。 */
export type RefurbAction = 'merge' | 'demote' | 'review' | 'split'

/** 一条翻新建议。 */
export interface RefurbSuggestion {
  readonly action: RefurbAction
  /** 主要记忆 id（用户确认后聚焦此 id）。 */
  readonly primaryId: string
  /** 合并场景：候选副本 id 列表。 */
  readonly candidates: readonly string[]
  readonly scope: EngramScope
  /** 给 agent / 用户的决策理由（中文，≤80 字）。 */
  readonly reason: string
  /** 建议置信度 0-1（高 = 强烈建议立即执行；低 = 仅提示）。 */
  readonly confidence: number
}

/** 翻新参数（按需调阈值；缺省用历史经验值）。 */
export interface RefurbOptions {
  /** active 条目少于该数时不出任何建议（默认 8）：小库样本太少，逐条命中噪声大于价值。 */
  readonly minActive: number
  /** importance 低于该值的 active 条目建议降级（默认 0.2）。 */
  readonly demoteBelow: number
  /** lastAccessedAt 早于该天数的条目建议复习（默认 60）。 */
  readonly staleDays: number
  /** 同 scope 中同 kind 内容前 20 字相同的对子建议合并（默认 0）。 */
  readonly duplicateTitleWindow: number
}

/** 缺省参数。 */
export const DEFAULT_REFURB_OPTIONS: RefurbOptions = {
  minActive: 8,
  demoteBelow: 0.2,
  staleDays: 60,
  duplicateTitleWindow: 0,
}

/**
 * 扫描一组 active 条目，按规则生成翻新建议。
 * 仅扫描同 scope 内的内容；跨 scope 的相似合并留给上层判定。
 * active 条目少于 `options.minActive` 时返回空列表：小库样本太少，逐条命中噪声大于价值。
 */
export function gatherRefurbSuggestions(
  records: readonly MemoryRecord[],
  options: RefurbOptions = DEFAULT_REFURB_OPTIONS,
): readonly RefurbSuggestion[] {
  const suggestions: RefurbSuggestion[] = []
  const now = Date.now()
  const active = records.filter(r => r.status === 'active')
  // 小库早退：样本太少时（尤其门牌规则）几乎逐条命中，噪声大于价值。
  if (active.length < options.minActive) return []
  const byScope = new Map<EngramScope, MemoryRecord[]>()
  for (const record of active) {
    const list = byScope.get(record.scope) ?? []
    list.push(record)
    byScope.set(record.scope, list)
  }
  // 规则 1：低重要性 + 长期未访问 → 降级。
  for (const record of active) {
    const daysSinceAccess = (now - record.lastAccessedAt) / 86_400_000
    if (record.importance < options.demoteBelow && daysSinceAccess > options.staleDays) {
      suggestions.push({
        action: 'demote',
        primaryId: record.id,
        candidates: [],
        scope: record.scope,
        reason: `重要性 ${record.importance.toFixed(2)} < ${options.demoteBelow} 且 ${Math.floor(daysSinceAccess)} 天未访问，建议降级为 archived。`,
        confidence: 0.7,
      })
    }
  }
  // 规则 2：同 scope 同 kind 且内容前缀重复 → 合并候选。
  for (const [scope, list] of byScope) {
    const byKind = new Map<string, MemoryRecord[]>()
    for (const record of list) {
      const bucket = byKind.get(record.kind) ?? []
      bucket.push(record)
      byKind.set(record.kind, bucket)
    }
    for (const [, items] of byKind) {
      if (items.length < 2) continue
      const seen = new Set<string>()
      for (const record of items) {
        const key = record.content.slice(0, 20)
        if (seen.has(key)) continue
        seen.add(key)
        const dupes = items.filter(other => other.id !== record.id && other.content.startsWith(key))
        if (dupes.length > 0) {
          suggestions.push({
            action: 'merge',
            primaryId: record.id,
            candidates: dupes.map(d => d.id),
            scope,
            reason: `与 ${dupes.length} 条记忆内容前 20 字重复，建议蒸馏合并。`,
            confidence: 0.6,
          })
        }
      }
    }
  }
  // 规则 3：从未访问但重要性 ≥ 0.7 → 复习（用户可能忘记这条）。
  for (const record of active) {
    if (record.accessCount === 0 && record.importance >= 0.7) {
      suggestions.push({
        action: 'review',
        primaryId: record.id,
        candidates: [],
        scope: record.scope,
        reason: `重要性 ${record.importance.toFixed(2)} 但从未被参观，可能埋没在走廊，建议复习。`,
        confidence: 0.5,
      })
    }
  }
  // 规则 4：content 长度 > 400 → 拆分。
  for (const record of active) {
    if (record.content.length > 400) {
      suggestions.push({
        action: 'split',
        primaryId: record.id,
        candidates: [],
        scope: record.scope,
        reason: `内容长度 ${record.content.length} > 400，建议拆为多条独立记忆。`,
        confidence: 0.6,
      })
    }
  }
  // 规则 5（门牌纪律）：无门牌或门牌分 < 0.5 → 补挂/重写铭牌（唯一 · 差异化 · 带日期）。
  for (const record of active) {
    const score = record.imageryScore
    if (score !== undefined && score >= 0.5) continue
    const slot = record.slot === undefined ? '' : `${record.slot.room}#${record.slot.index} `
    suggestions.push({
      action: 'review',
      primaryId: record.id,
      candidates: [],
      scope: record.scope,
      reason: score === undefined
        ? `${slot}未挂门牌：宫殿纪律要求每个标记唯一、差异化、带日期，建议用 engram_update 的 placard 参数补挂。`
        : `${slot}门牌得分 ${score.toFixed(2)} < 0.5（不合唯一/差异化/带日期纪律），建议重写铭牌。`,
      confidence: 0.4,
    })
  }
  return suggestions
}