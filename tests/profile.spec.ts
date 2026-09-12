import { describe, expect, it } from 'vitest'
import { renderProfile, renderProfileDetailed } from '../src/index.ts'
import { estimateTokens } from '../src/token.ts'

const HEADER = 'User memory profile (dsh-engram, cross-session) — Grand Hall (always present):'
const FOOTER = 'Use engram_search to recall details (pass room to search inside one room); use engram_save to persist new facts.'
const est = estimateTokens
const OVERHEAD = est(HEADER) + est(FOOTER)

const record = (id: string, kind: string, content: string) => ({ id, kind, content })

describe('renderProfile 预算装填', () => {
  it('预算充足时全部整行装填', () => {
    const text = renderProfile([
      record('id-1', 'preference', '偏好简体中文'),
      record('id-2', 'fact', '在开发记忆插件'),
    ], 1024)
    const lines = text.split('\n')
    expect(lines[0]).toBe(HEADER)
    expect(lines.at(-1)).toBe(FOOTER)
    expect(text).toContain('- [preference] 偏好简体中文')
    expect(text).toContain('- [fact] 在开发记忆插件')
    expect(text).not.toContain('#id-')
    expect(text).not.toContain('more; use engram_search')
  })

  it('整行超预算跳过该行，继续装更短的行；跳过的降级为索引行', () => {
    const long = record('id-long', 'fact', '长'.repeat(400))
    const short = record('id-short', 'fact', '短条目')
    const shortLine = `- [fact] ${short.content}`
    const indexLine = `- [fact] #id-long ${'长'.repeat(40)}…`
    // 预算 = 固定行 + 短行 + 一条索引行 + 末尾计数行（计数行也占预算）。
    const budget = OVERHEAD + est(shortLine) + est(indexLine) + est('+1 more; use engram_search')
    const text = renderProfile([long, short], budget)
    expect(text).toContain(shortLine)
    expect(text).toContain(indexLine)
    expect(text).not.toContain('长'.repeat(41))
  })

  it('索引行也装不下时折成末尾 +N more 计数行', () => {
    // 余量 8 token：条目整行装不进，但足够容纳末尾计数行（计数行占预算）。
    const text = renderProfile([
      record('id-1', 'fact', '这是一条比较长的中文记忆条目内容'),
      record('id-2', 'fact', '这是另一条比较长的中文记忆条目内容'),
    ], OVERHEAD + 8)
    expect(text).toContain('+2 more; use engram_search')
    expect(text).not.toContain('这是一条比较长的中文记忆条目内容')
    expect(text).not.toContain('#id-1')
  })

  it('中英混合按 CJK 口径估算，边界精确', () => {
    const mixed = record('id-mix', 'fact', 'abcd中文混合')
    const line = `- [fact] ${mixed.content}`
    expect(est(line)).toBeGreaterThan(Math.ceil(line.length / 4))
    // 恰好够整行时装入；少 1 个 token 就整行跳过（索引行更长也装不下，折成计数行）。
    const cost = est(line)
    expect(renderProfile([mixed], OVERHEAD + cost)).toContain(line)
    const degraded = renderProfile([mixed], OVERHEAD + cost - 1)
    expect(degraded).not.toContain(line)
    expect(degraded).toContain('+1 more; use engram_search')
  })

  it('中文条目按 CJK 口径受预算约束（长度/4 口径会超支数倍）', () => {
    const records = Array.from({ length: 5 }, (_, index) => record(`id-${index}`, 'fact', '中'.repeat(200)))
    const text = renderProfile(records, 1024)
    expect(estimateTokens(text)).toBeLessThanOrEqual(1024)
    // 200 汉字 = 300 token，1024 预算装不下 5 条，必然出现索引行或计数行。
    expect(text).toMatch(/#id-|more; use engram_search/)
  })
})

describe('renderProfileDetailed 溢出明细', () => {
  it('溢出条目在 overflow 中按序返回，文本含计数行', () => {
    const overflowRecord = record('id-overflow', 'fact', '较长的一条中文记忆内容')
    // 余量 8 token：整行装不下，扣掉计数行后仍不足索引行，故只剩计数行。
    const detailed = renderProfileDetailed([overflowRecord], OVERHEAD + 8)
    expect(detailed.overflow.map(item => item.id)).toEqual(['id-overflow'])
    expect(detailed.overflow[0]!.kind).toBe('fact')
    expect(detailed.overflow[0]!.content).toBe('较长的一条中文记忆内容')
    expect(detailed.text).toContain('+1 more; use engram_search')
  })

  it('全部装下时 overflow 为空', () => {
    const detailed = renderProfileDetailed([record('id-1', 'fact', '条目一')], 1024)
    expect(detailed.overflow).toEqual([])
    expect(detailed.text).toContain('- [fact] 条目一')
    expect(detailed.text).not.toContain('more; use engram_search')
  })

  it('压缩后重渲染：压短的条目整行装入，overflow 清空', () => {
    const compressed = '压缩后的短句'
    // 预算恰好容纳压缩后的整行（CJK 口径：6 个汉字 9 token + 15 个窄字符 3.75 token）。
    const budget = OVERHEAD + est(`- [preference] ${compressed}`)
    const first = renderProfileDetailed([record('id-1', 'preference', '很长的原始条目'.repeat(10))], budget)
    expect(first.overflow).toHaveLength(1)
    // 模拟辅助 LLM 压缩后的重渲染。
    const recomposed = first.overflow.map(item => ({ ...item, content: compressed }))
    const second = renderProfileDetailed(recomposed, budget)
    expect(second.overflow).toEqual([])
    expect(second.text).toContain(`- [preference] ${compressed}`)
  })
})
