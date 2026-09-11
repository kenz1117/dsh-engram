import { describe, expect, it } from 'vitest'
import { RECALL_PER_ITEM_CHARS, RECALL_TOTAL_CHARS, enforceBudget, truncateItem } from '../src/retrieve/budget.ts'

describe('truncateItem 单条截断', () => {
  it('短文本原样返回', () => {
    expect(truncateItem('短条目')).toBe('短条目')
    expect(truncateItem('a'.repeat(RECALL_PER_ITEM_CHARS))).toBe('a'.repeat(RECALL_PER_ITEM_CHARS))
  })

  it('超长截断并加省略号', () => {
    const text = '长'.repeat(RECALL_PER_ITEM_CHARS + 100)
    const out = truncateItem(text)
    expect(out).toHaveLength(RECALL_PER_ITEM_CHARS + 1)
    expect(out.endsWith('…')).toBe(true)
  })

  it('自定义上限生效', () => {
    expect(truncateItem('abcdef', 3)).toBe('abc…')
  })
})

describe('enforceBudget 总量装填', () => {
  it('全部装得下时原样保序返回', () => {
    const lines = ['第一行', '第二行', '第三行']
    expect(enforceBudget(lines, 100)).toEqual(lines)
  })

  it('装不下的行被跳过并计数，末尾追加提示行', () => {
    const lines = ['a'.repeat(60), 'b'.repeat(60), 'c'.repeat(60)]
    const out = enforceBudget(lines, 90)
    expect(out).toEqual([lines[0], `（另有 2 条未展示：缩小查询范围或降低 limit 后重试）`])
  })

  it('某行装不下时继续尝试更短的后续行', () => {
    const lines = ['x'.repeat(90), '短行', 'y'.repeat(90)]
    const out = enforceBudget(lines, 100)
    expect(out).toEqual([lines[0], '短行', `（另有 1 条未展示：缩小查询范围或降低 limit 后重试）`])
  })

  it('空输入返回空数组（无提示行）', () => {
    expect(enforceBudget([], 100)).toEqual([])
  })

  it('默认预算为协议内定值', () => {
    expect(RECALL_TOTAL_CHARS).toBe(4800)
    expect(RECALL_PER_ITEM_CHARS).toBe(1200)
  })
})
