import { describe, expect, it } from 'vitest'
import { estimateTokens } from '../src/token.ts'

describe('estimateTokens', () => {
  it('空串为 0', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('非 CJK 文本按 4 字符 1 token 向上取整', () => {
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })

  it('中文按 1.5 token/字', () => {
    expect(estimateTokens('中文')).toBe(3)
    expect(estimateTokens('中文混合')).toBe(6)
  })

  it('全角标点与假名一并按宽字符计', () => {
    expect(estimateTokens('，。！')).toBe(5)
    expect(estimateTokens('カタカナ')).toBe(6)
  })

  it('中英混合按两类分别累加', () => {
    // 13 个窄字符（3.25 token）+ 4 个汉字（6 token）= 9.25 → 10。
    expect(estimateTokens('- [fact] abcd中文混合')).toBe(10)
  })

  it('emoji 按码点计一次，不按代理对的 code unit 计数', () => {
    expect(estimateTokens('🙂')).toBe(1)
    expect(estimateTokens('🙂🙂🙂🙂🙂')).toBe(2)
  })

  it('中文文本的估算高于长度除以 4 的口径', () => {
    const text = '记忆宫殿的桩位系统'
    expect(estimateTokens(text)).toBe(14)
    expect(estimateTokens(text)).toBeGreaterThan(Math.ceil(text.length / 4))
  })
})
