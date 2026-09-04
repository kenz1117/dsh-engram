import { describe, expect, it } from 'vitest'
import { renderProfile } from '../src/index.ts'

const HEADER = 'User memory profile (dsh-engram, cross-session):'
const FOOTER = 'Use engram_search to recall details; use engram_save to persist new facts.'
const est = (text: string): number => Math.ceil(text.length / 4)
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
    const budget = OVERHEAD + est(shortLine) + est(indexLine)
    const text = renderProfile([long, short], budget)
    expect(text).toContain(shortLine)
    expect(text).toContain(indexLine)
    expect(text).not.toContain('长'.repeat(41))
  })

  it('索引行也装不下时折成末尾 +N more 计数行', () => {
    const text = renderProfile([
      record('id-1', 'fact', '条目一'),
      record('id-2', 'fact', '条目二'),
    ], OVERHEAD)
    expect(text).toContain('+2 more; use engram_search')
    expect(text).not.toContain('条目一')
    expect(text).not.toContain('#id-1')
  })

  it('中英混合按字符串长度估算（ceil(len/4)），边界精确', () => {
    const mixed = record('id-mix', 'fact', 'abcd中文混合')
    const line = `- [fact] ${mixed.content}`
    expect(est(line)).toBe(5)
    // 恰好够 5 token 时整行装入；少 1 个就整行跳过（索引行更长也装不下，折成计数行）。
    expect(renderProfile([mixed], OVERHEAD + 5)).toContain(line)
    const degraded = renderProfile([mixed], OVERHEAD + 4)
    expect(degraded).not.toContain(line)
    expect(degraded).toContain('+1 more; use engram_search')
  })
})
