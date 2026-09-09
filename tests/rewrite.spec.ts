import { describe, expect, it } from 'vitest'
import {
  MAX_REWRITE_QUERIES, RRF_CONSTANT,
  mergeQueryResults, normalizeRewriteQueries,
} from '../src/retrieve/rewrite.ts'
import { asMemoryId } from '../src/types.ts'
import type { MemoryRecord, SearchHit } from '../src/types.ts'

/** 构造最小 MemoryRecord（融合只读 id）。 */
const record = (id: string): MemoryRecord => ({
  id: asMemoryId(id),
  scope: 'user',
  kind: 'fact',
  content: `内容 ${id}`,
  importance: 0.5,
  confidence: 0.5,
  status: 'active',
  createdAt: 0,
  lastAccessedAt: 0,
  accessCount: 0,
  sourceSessionId: null,
  sourceRound: null,
  sourceSeq: null,
})

const hit = (id: string, score = 1): SearchHit => ({ record: record(id), score, via: 'fts' })

describe('normalizeRewriteQueries', () => {
  it('接受字符串数组并按小写去重', () => {
    expect(normalizeRewriteQueries(['用户偏好', '用户 偏好', ' 用户偏好 '], 3)).toEqual(['用户偏好', '用户 偏好'])
  })

  it('接受单个字符串输入', () => {
    expect(normalizeRewriteQueries('原始查询', 3)).toEqual(['原始查询'])
  })

  it('过滤非法项并截到上限', () => {
    const items = ['a', 42, null, 'b', 'c', 'd', 'e']
    expect(normalizeRewriteQueries(items, MAX_REWRITE_QUERIES)).toEqual(['a', 'b', 'c'])
  })

  it('空白折叠、500 字符截断、空项丢弃', () => {
    const long = `${'x'.repeat(600)} y`
    const result = normalizeRewriteQueries([long, '   '], 3)
    expect(result[0]).toHaveLength(500)
    expect(result[0]).not.toContain(' y')
    expect(result).toHaveLength(1)
  })

  it('非字符串/非数组输入返回空数组', () => {
    expect(normalizeRewriteQueries(undefined, 3)).toEqual([])
    expect(normalizeRewriteQueries({ query: 'x' }, 3)).toEqual([])
  })
})

describe('mergeQueryResults', () => {
  it('跨查询命中累加 RRF 分并排前', () => {
    // a 在两个查询都是第 1 名：2/(60+1)；b、c 各只在一个查询出现。
    const merged = mergeQueryResults(
      [{ hits: [hit('a'), hit('b')] }, { hits: [hit('a'), hit('c')] }],
      8, RRF_CONSTANT, 1,
    )
    expect(merged[0]!.record.id).toBe('a')
    expect(merged).toHaveLength(3)
  })

  it('融合分相同时按首次名次、首次查询序号稳定排序', () => {
    // b 只在查询 1 第 2 名，c 只在查询 2 第 2 名：分同为 1/62，b 的 firstQueryIndex 更小。
    const merged = mergeQueryResults(
      [{ hits: [hit('a'), hit('b')] }, { hits: [hit('a'), hit('c')] }],
      8, RRF_CONSTANT, 0,
    )
    expect(merged.map(h => h.record.id)).toEqual(['a', 'b', 'c'])
  })

  it('每查询保底命中排在结果前部', () => {
    // 查询 2 的第 1 名 d 融合分低于 a，但作为保底（minPerQuery=1）排到 a 之前。
    const merged = mergeQueryResults(
      [{ hits: [hit('a'), hit('b'), hit('c')] }, { hits: [hit('d'), hit('e')] }],
      8, RRF_CONSTANT, 1,
    )
    expect(merged.slice(0, 2).map(h => h.record.id)).toEqual(['a', 'd'])
  })

  it('limit 截断最终结果', () => {
    const merged = mergeQueryResults(
      [{ hits: [hit('a'), hit('b'), hit('c')] }, { hits: [hit('d'), hit('e')] }],
      3, RRF_CONSTANT, 1,
    )
    expect(merged).toHaveLength(3)
  })

  it('空 retrievals 返回空列表', () => {
    expect(mergeQueryResults([], 8, RRF_CONSTANT, 1)).toEqual([])
    expect(mergeQueryResults([{ hits: [] }], 8, RRF_CONSTANT, 1)).toEqual([])
  })
})
