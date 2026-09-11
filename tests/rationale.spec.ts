import { describe, expect, it } from 'vitest'
import { buildSelectionRationale, wrapWithRationale } from '../src/selection-rationale.ts'
import { asMemoryId } from '../src/types.ts'
import type { MemoryRecord } from '../src/types.ts'

const NOW = Date.now()

/** 测试用 MemoryRecord 工厂。 */
function makeRecord(overrides: Partial<MemoryRecord> & { id?: string; content?: string } = {}): MemoryRecord {
  return {
    id: asMemoryId(overrides.id ?? '00000000-0000-0000-0000-000000000001'),
    scope: overrides.scope ?? 'user',
    kind: overrides.kind ?? 'fact',
    content: overrides.content ?? '测试房间',
    importance: overrides.importance ?? 0.5,
    confidence: overrides.confidence ?? 0.5,
    status: overrides.status ?? 'active',
    // exactOptionalPropertyTypes：可选 outcome 仅在有值时写入（Partial 读取带 undefined）。
    ...(overrides.outcome !== undefined ? { outcome: overrides.outcome } : {}),
    createdAt: overrides.createdAt ?? NOW - 86_400_000,
    lastAccessedAt: overrides.lastAccessedAt ?? NOW - 30 * 86_400_000,
    accessCount: overrides.accessCount ?? 0,
    sourceSessionId: overrides.sourceSessionId ?? null,
    sourceRound: overrides.sourceRound ?? null,
    sourceSeq: overrides.sourceSeq ?? null,
  }
}

describe('注入归因 buildSelectionRationale', () => {
  it('空记录返回空串', () => {
    expect(buildSelectionRationale([])).toBe('')
  })

  it('单条无任何理由标注「基础入选」', () => {
    const r = buildSelectionRationale([makeRecord({})])
    expect(r).toContain('<engram_selection_rationale>')
    expect(r).toContain('基础入选')
    expect(r).toContain('测试房间')
  })

  it('recent：lastAccessedAt 在 7 天内', () => {
    const r = buildSelectionRationale([makeRecord({ lastAccessedAt: NOW - 2 * 86_400_000 })])
    expect(r).toContain('近期被参观')
    expect(r).not.toContain('基础入选')
  })

  it('bright：importance × confidence ≥ 0.7', () => {
    const r = buildSelectionRationale([makeRecord({ importance: 0.9, confidence: 0.9 })])
    expect(r).toContain('地标明亮')
  })

  it('corridor-hit：accessCount ≥ 5', () => {
    const r = buildSelectionRationale([makeRecord({ accessCount: 10 })])
    expect(r).toContain('走廊常客')
  })

  it('strong-evidence：outcome=success', () => {
    const r = buildSelectionRationale([makeRecord({ outcome: 'success' })])
    expect(r).toContain('管家验证有效')
  })

  it('多个原因用 / 分隔', () => {
    const r = buildSelectionRationale([makeRecord({
      importance: 0.9, confidence: 0.9, accessCount: 10, outcome: 'success',
    })])
    expect(r).toContain('地标明亮 / 走廊常客 / 管家验证有效')
  })
})

describe('wrapWithRationale', () => {
  it('空记录时直接返回画像文本', () => {
    expect(wrapWithRationale('Profile text', [])).toBe('Profile text')
  })

  it('有记录时把归因块拼到画像前', () => {
    const out = wrapWithRationale('## User memory profile', [makeRecord({})])
    expect(out.startsWith('<engram_selection_rationale>')).toBe(true)
    expect(out).toContain('## User memory profile')
  })
})
