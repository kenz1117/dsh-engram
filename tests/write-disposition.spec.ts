import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BAND_MERGE_COSINE, BAND_MERGE_OVERLAP, charBigramJaccard, decideWrite, numbersDiffer } from '../src/write-disposition.ts'
import type { JudgeAnswers, MemoryJudge } from '../src/write-disposition.ts'
import { openEngramStore } from '../src/store/sqlite.ts'
import type { EngramStore } from '../src/store/interface.ts'

let dir: string
let store: EngramStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'engram-disposition-'))
  store = await openEngramStore(join(dir, 'user.db'))
})
afterEach(async () => {
  await store.close()
})

/**
 * 2→4 维单位向量精确控制余弦：与 v = [1,0,0,0] 的余弦恰为首分量 c
 * （|v| = 1，点积 = c）。库内维度必须一致，夹具统一 4 维。
 */
const cosineVector = (c: number): Float32Array => new Float32Array([c, Math.sqrt(1 - c * c), 0, 0])
const NEAREST_VECTOR = new Float32Array([1, 0, 0, 0])

const judgeOf = (ask: () => Promise<JudgeAnswers>): MemoryJudge => ({
  deferMergeAbove: 0.95,
  deferAcceptBelow: 0.05,
  contradictMinProbability: 0.8,
  ask,
})

describe('decideWrite 免 LLM 带内兜底（#55）', () => {
  it('同 kind + 余弦 0.91 + 高字面重叠 → merge 进既有条目（无 judge，纯规则）', async () => {
    const existing = await store.write({ scope: 'user', kind: 'preference', content: '始终用中文回答', embedding: NEAREST_VECTOR })
    // 余弦 0.91 落模糊带（≥ 0.88、< 0.92）：旧实现无 judge 时永远 defer。
    const decision = await decideWrite(store, 'preference', cosineVector(BAND_MERGE_COSINE + 0.01), {
      content: '始终用中文回答，谢谢',
    })
    expect(decision.disposition).toBe('merge')
    if (decision.disposition === 'merge') {
      expect(decision.into.id).toBe(existing.id)
      expect(decision.similarity).toBeGreaterThanOrEqual(BAND_MERGE_COSINE)
      expect(decision.similarity).toBeLessThan(0.92)
    }
  })

  it('同 kind + 余弦 0.91 + 低字面重叠 → 维持 defer（疑似矛盾照旧落库待裁决）', async () => {
    await store.write({ scope: 'user', kind: 'preference', content: '始终用中文回答', embedding: NEAREST_VECTOR })
    const decision = await decideWrite(store, 'preference', cosineVector(0.91), {
      content: '回复请使用中文，不要夹杂外语',
    })
    expect(decision).toMatchObject({ disposition: 'defer' })
  })

  it('数字守卫：数字令牌不同 → 即使字面高度重叠也不兜底合并', async () => {
    await store.write({
      scope: 'user',
      kind: 'fact',
      content: '生产环境数据库端口固定为 8080，代理端口固定为 8081',
      embedding: NEAREST_VECTOR,
    })
    // 字面重叠 0.86 远超 BAND_MERGE_OVERLAP，仅数字不同：修正而非复述。
    const decision = await decideWrite(store, 'fact', cosineVector(0.91), {
      content: '生产环境数据库端口固定为 9090，代理端口固定为 8081',
    })
    expect(decision).toMatchObject({ disposition: 'defer' })
  })

  it('余弦 ≥ MERGE_COSINE 同 kind → 无信号直接 merge 路径不受兜底影响', async () => {
    const existing = await store.write({ scope: 'user', kind: 'fact', content: '测试端口是 8080', embedding: NEAREST_VECTOR })
    const decision = await decideWrite(store, 'fact', cosineVector(0.93), { content: '测试端口是 8080' })
    expect(decision).toMatchObject({ disposition: 'merge', into: existing })
  })

  it('judge 在场判「确属不同」→ accept：judge 优先于兜底规则', async () => {
    await store.write({ scope: 'user', kind: 'preference', content: '始终用中文回答', embedding: NEAREST_VECTOR })
    const judge = judgeOf(async () => ({ same_memory: 0.01 }))
    const decision = await decideWrite(store, 'preference', cosineVector(0.91), {
      judge,
      content: '始终用中文回答，谢谢',
    })
    expect(decision).toEqual({ disposition: 'accept' })
  })

  it('judge 抛错 → 兜底接住 Jev 失败（高重叠照判 merge）', async () => {
    const existing = await store.write({ scope: 'user', kind: 'preference', content: '始终用中文回答', embedding: NEAREST_VECTOR })
    const judge = judgeOf(async () => { throw new Error('jev down') })
    const decision = await decideWrite(store, 'preference', cosineVector(0.91), {
      judge,
      content: '始终用中文回答，谢谢',
    })
    expect(decision.disposition).toBe('merge')
    if (decision.disposition === 'merge') expect(decision.into.id).toBe(existing.id)
  })

  it('守门行为未变：无 embedding → accept；最近邻低于 DEFER_COSINE → accept', async () => {
    const noEmbedding = await decideWrite(store, 'fact', undefined, { content: '任何内容' })
    expect(noEmbedding).toEqual({ disposition: 'accept' })
    await store.write({ scope: 'user', kind: 'fact', content: '向量条目', embedding: NEAREST_VECTOR })
    const belowBand = await decideWrite(store, 'fact', cosineVector(0.7), { content: '无关内容' })
    expect(belowBand).toEqual({ disposition: 'accept' })
  })
})

describe('charBigramJaccard / numbersDiffer', () => {
  it('改写复述的 bigram Jaccard 高，主题相似的不同句子低', () => {
    expect(charBigramJaccard('始终用中文回答', '始终用中文回答，谢谢')).toBeGreaterThanOrEqual(BAND_MERGE_OVERLAP)
    expect(charBigramJaccard('始终用中文回答', '回复请使用中文，不要夹杂外语')).toBeLessThan(BAND_MERGE_OVERLAP)
  })

  it('空白与小写不影响重叠；无 bigram（含单字符）一侧返回 0', () => {
    expect(charBigramJaccard('Use PNPM Workspaces', 'use pnpm workspaces')).toBe(1)
    expect(charBigramJaccard('A', 'ABC')).toBe(0)
    expect(charBigramJaccard('', 'ABC')).toBe(0)
  })

  it('数字令牌守卫：任一数字不同即判异，位置无关', () => {
    expect(numbersDiffer('端口是 8080', '端口是 9090')).toBe(true)
    expect(numbersDiffer('版本 1.2 发布', '发布 1.2 版本')).toBe(false)
    expect(numbersDiffer('无数字', '也没有数字')).toBe(false)
    expect(numbersDiffer('两台 8080 与 9090', '只有 8080')).toBe(true)
  })
})
