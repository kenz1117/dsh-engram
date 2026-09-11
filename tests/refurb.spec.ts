/**
 * 翻新清单扫描：阈值早退与三类规则命中（降级 / 复习 / 拆分 / 门牌）。
 * 只构造扫描实际读取的字段，其余走 MemoryRecord 的测试替身默认值。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_REFURB_OPTIONS, gatherRefurbSuggestions } from '../src/refurb.ts'
import type { EngramKind, MemoryRecord } from '../src/types.ts'

/** 一条 active 记忆的测试替身：默认不触发任何规则（门牌已挂、近期访问过、内容不长）。 */
function memory(id: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: id as unknown as MemoryRecord['id'],
    scope: 'user',
    kind: 'fact' as EngramKind,
    content: `记忆 ${id}`,
    importance: 0.5,
    confidence: 0.8,
    status: 'active',
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    accessCount: 2,
    sourceSessionId: null,
    sourceRound: null,
    sourceSeq: null,
    imageryScore: 0.9,
    ...overrides,
  }
}

/** 凑够 minActive 条不触发任何规则的记忆。 */
function fillers(count: number): MemoryRecord[] {
  return Array.from({ length: count }, (_, index) => memory(`f${String(index)}`))
}

describe('翻新清单扫描', () => {
  it('active 少于 minActive 时不出建议（小库噪声防线）', () => {
    // 这些条目若被扫描本会命中门牌纪律规则——早退后应为空，测试才有区分力。
    const small = Array.from(
      { length: DEFAULT_REFURB_OPTIONS.minActive - 1 },
      (_, index) => memory(`m${String(index)}`, { imageryScore: 0.2 }),
    )
    expect(gatherRefurbSuggestions(small)).toHaveLength(0)
  })

  it('达到 minActive 后按门牌纪律逐条给出补挂建议', () => {
    const records = Array.from(
      { length: DEFAULT_REFURB_OPTIONS.minActive },
      (_, index) => memory(`m${String(index)}`, { imageryScore: 0.2 }),
    )
    const suggestions = gatherRefurbSuggestions(records)
    expect(suggestions).toHaveLength(DEFAULT_REFURB_OPTIONS.minActive)
    expect(suggestions.every(suggestion => suggestion.action === 'review')).toBe(true)
  })

  it('低重要性且长期未访问的条目建议降级', () => {
    const stale = memory('old', { importance: 0.1, lastAccessedAt: Date.now() - 200 * 86_400_000 })
    const suggestions = gatherRefurbSuggestions([stale, ...fillers(DEFAULT_REFURB_OPTIONS.minActive - 1)])
    expect(suggestions.map(suggestion => suggestion.action)).toEqual(['demote'])
    expect(suggestions[0]?.primaryId).toBe('old')
  })

  it('超长内容建议拆分、从未访问的高重要性条目建议复习', () => {
    const long = memory('long', { content: 'x'.repeat(401) })
    const buried = memory('buried', { importance: 0.8, accessCount: 0 })
    const suggestions = gatherRefurbSuggestions([long, buried, ...fillers(DEFAULT_REFURB_OPTIONS.minActive - 2)])
    expect(suggestions.map(suggestion => suggestion.action).sort()).toEqual(['review', 'split'])
  })
})
