/**
 * 多查询检索增强：辅助 LLM 把查询改写为 ≤3 个互补查询分别检索，
 * 跨查询用 RRF（Reciprocal Rank Fusion）融合排序，并为每个查询保留保底命中。
 * 改写是增强路径：LLM 不可用或失败一律降级为原查询单查。
 * @module @kenz1117/dsh-engram/retrieve/rewrite
 */

import type { SearchHit } from '../types.ts'

/** 改写查询上限（协议内常量：更多查询线性放大检索与强化成本，收益递减）。 */
export const MAX_REWRITE_QUERIES = 3

/** 跨查询 RRF 常数（与单查询内道融合的量级一致）。 */
export const RRF_CONSTANT = 60

/** 改写输出 token 上限（3 个短查询足够）。 */
export const REWRITE_MAX_TOKENS = 200

/** 改写系统指令：只输出 JSON 字符串数组，不回答问题。 */
export const REWRITE_SYSTEM = [
  `把用户输入的检索查询改写为最多 ${MAX_REWRITE_QUERIES} 个互补的检索查询（同义词、上下位概念、不同措辞），用于长期记忆库的语义+关键词混合检索。`,
  '只输出一个 JSON 字符串数组，不要输出 JSON 以外的任何内容；无法改进时输出只含原查询的数组。',
].join('\n')

/**
 * 归一化改写结果：接受字符串或字符串数组，单行化、截断 500 字符、
 * 按小写去重、截到 maxQueries 个；非法项过滤。
 * @param value - 模型输出解析出的 JSON 值。
 * @param maxQueries - 查询数上限。
 * @returns 归一后的查询列表；无有效项时为空数组（调用方降级原查询）。
 */
export function normalizeRewriteQueries(value: unknown, maxQueries: number): string[] {
  const items = typeof value === 'string' ? [value] : Array.isArray(value) ? value : []
  const seen = new Set<string>()
  const queries: string[] = []
  for (const item of items) {
    if (typeof item !== 'string') continue
    const query = item.replace(/\s+/gu, ' ').trim().slice(0, 500)
    if (query === '') continue
    const key = query.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    queries.push(query)
    if (queries.length >= maxQueries) break
  }
  return queries
}

/**
 * 跨查询 RRF 融合：每个检索结果内按名次贡献 1/(rank+1+K) 分，同名次命中
 * 累加；按融合分、首次名次、首次查询序号稳定排序；每个查询的前
 * min(perQueryKeep, limit/查询数) 名保底排在最终结果前部。
 * @param retrievals - 各查询的检索结果（hits 已按各自分数排序）。
 * @param limit - 最终返回条数上限。
 * @param rrfConstant - RRF 常数。
 * @param minPerQuery - 每查询保底名次数（与 limit/查询数取小）。
 * @returns 融合后的命中列表（条目为各查询的原 hit）。
 */
export function mergeQueryResults(
  retrievals: readonly { hits: readonly SearchHit[] }[],
  limit: number,
  rrfConstant: number,
  minPerQuery: number,
): SearchHit[] {
  const entries = new Map<string, { hit: SearchHit; score: number; firstRank: number; firstQueryIndex: number }>()
  for (const [queryIndex, retrieval] of retrievals.entries()) {
    for (const [rank, hit] of retrieval.hits.entries()) {
      const key = hit.record.id
      const add = 1 / (rank + 1 + rrfConstant)
      const existing = entries.get(key)
      if (existing === undefined) {
        entries.set(key, { hit, score: add, firstRank: rank, firstQueryIndex: queryIndex })
        continue
      }
      existing.score += add
      existing.firstRank = Math.min(existing.firstRank, rank)
      existing.firstQueryIndex = Math.min(existing.firstQueryIndex, queryIndex)
      // 同一条目多查询命中：via/score 以各查询中更好的一次为准。
      if (hit.score > existing.hit.score) existing.hit = hit
    }
  }
  const ranked = [...entries.values()].sort((a, b) =>
    b.score - a.score || a.firstRank - b.firstRank || a.firstQueryIndex - b.firstQueryIndex)
  const perQueryKeep = Math.min(minPerQuery, Math.max(1, Math.floor(Math.max(0, limit) / Math.max(1, retrievals.length))))
  const reserved = new Set(retrievals.flatMap(retrieval =>
    retrieval.hits.slice(0, perQueryKeep).map(hit => hit.record.id)))
  return [
    ...ranked.filter(entry => reserved.has(entry.hit.record.id)),
    ...ranked.filter(entry => !reserved.has(entry.hit.record.id)),
  ]
    .slice(0, Math.max(0, limit))
    .map(entry => entry.hit)
}
