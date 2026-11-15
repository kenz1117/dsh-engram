import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FOLD_COSINE, foldNearDuplicates } from '../src/fold.ts'
import { openEngramStore } from '../src/store/sqlite.ts'
import type { EngramStore } from '../src/store/interface.ts'
import { asMemoryId } from '../src/types.ts'
import type { MemoryId } from '../src/types.ts'

let dir: string
let store: EngramStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'engram-fold-'))
  store = await openEngramStore(join(dir, 'user.db'))
})
afterEach(async () => {
  await store.close()
})

/** 2 维向量精确控制余弦：与 [1,0] 的余弦恰为首分量 c（|v| = 1，点积 = c）。 */
const vecAt = (c: number): Float32Array => new Float32Array([c, Math.sqrt(1 - c * c)])
const UNIT = vecAt(1)

describe('foldNearDuplicates 注入端折叠（#55）', () => {
  it('同 kind 余弦 ≥ 阈值：折叠进 importance 更高的簇头（候选按 importance 降序）', async () => {
    const head = await store.write({ scope: 'user', kind: 'preference', content: '始终用中文回答', importance: 0.9, embedding: UNIT })
    const restated = await store.write({ scope: 'user', kind: 'preference', content: '始终用中文回答，谢谢', importance: 0.5, embedding: vecAt(0.95) })
    const vectors = await store.vectorsFor([head.memoryId, restated.memoryId])
    const result = foldNearDuplicates([head, restated], vectors)
    expect(result.kept).toHaveLength(1)
    expect(result.kept[0]!.record.id).toBe(head.id)
    expect(result.kept[0]!.foldedCount).toBe(1)
    expect(result.kept[0]!.foldedIds).toEqual([restated.id])
    expect(result.foldedCount).toBe(1)
  })

  it('跨 kind 不折叠：余弦再高也各占槽位', async () => {
    const preference = await store.write({ scope: 'user', kind: 'preference', content: '始终用中文回答', embedding: UNIT })
    const fact = await store.write({ scope: 'user', kind: 'fact', content: '会话用中文进行', embedding: vecAt(0.97) })
    const vectors = await store.vectorsFor([preference.memoryId, fact.memoryId])
    const result = foldNearDuplicates([preference, fact], vectors)
    expect(result.kept).toHaveLength(2)
    expect(result.foldedCount).toBe(0)
  })

  it('无向量条目不可比较，一律保留（先到、后到都当簇头）', async () => {
    const vectorized = await store.write({ scope: 'user', kind: 'preference', content: '始终用中文回答', embedding: UNIT })
    const unvectorized = await store.write({ scope: 'user', kind: 'preference', content: '始终用中文回答，谢谢' })
    // 顺序一：无向量在后。
    const vectors = await store.vectorsFor([vectorized.memoryId])
    const tail = foldNearDuplicates([vectorized, unvectorized], vectors)
    expect(tail.kept).toHaveLength(2)
    // 顺序二：无向量在前，后续向量条目也无法与它比较。
    const head = foldNearDuplicates([unvectorized, vectorized], vectors)
    expect(head.kept).toHaveLength(2)
    expect(head.foldedCount).toBe(0)
  })

  it('阈值边界：余弦 1.0 折叠；0.89 不折叠；自定义阈值收紧后 0.95 也不折叠', async () => {
    const base = await store.write({ scope: 'user', kind: 'fact', content: '构建用 pnpm', embedding: UNIT })
    const twin = await store.write({ scope: 'user', kind: 'fact', content: '构建统一用 pnpm', embedding: vecAt(1) })
    const near = await store.write({ scope: 'user', kind: 'fact', content: '构建尽量用 pnpm', embedding: vecAt(0.89) })
    const mid = await store.write({ scope: 'user', kind: 'fact', content: '构建都用 pnpm', embedding: vecAt(0.95) })
    const vectors = await store.vectorsFor([base.memoryId, twin.memoryId, near.memoryId, mid.memoryId])
    expect(foldNearDuplicates([base, twin], vectors).foldedCount).toBe(1)
    expect(foldNearDuplicates([base, near], vectors).foldedCount).toBe(0)
    // 默认阈值下 0.95 折叠；收紧到 0.99 后不再折叠。
    expect(foldNearDuplicates([base, mid], vectors).foldedCount).toBe(1)
    expect(foldNearDuplicates([base, mid], vectors, 0.99).foldedCount).toBe(0)
    expect(FOLD_COSINE).toBe(0.9)
  })

  it('向量缺位的 id 不可比较照当簇头，其余成对仍折叠', async () => {
    const a = await store.write({ scope: 'user', kind: 'preference', content: '内容甲', embedding: UNIT })
    const b = await store.write({ scope: 'user', kind: 'preference', content: '内容甲的改写', embedding: vecAt(0.99) })
    const c = await store.write({ scope: 'user', kind: 'preference', content: '内容乙', embedding: UNIT })
    // 只带 a、c 的向量：b 缺位 → 自己当簇头；c 与 a 同向量 → 折进 a。
    const partial = new Map<MemoryId, Float32Array>([[a.memoryId, UNIT], [c.memoryId, UNIT]])
    const result = foldNearDuplicates([a, b, c], partial)
    expect(result.kept).toHaveLength(2)
    expect(result.kept[0]!.record.id).toBe(a.id)
    expect(result.kept[0]!.foldedIds).toEqual([c.id])
    expect(result.kept[1]!.record.id).toBe(b.id)
    expect(result.kept[1]!.foldedCount).toBe(0)
  })
})

describe('vectorsFor 存储向量读取', () => {
  it('按 memoryId 返回原向量；无向量/缺位 id 静默缺位', async () => {
    const a = await store.write({ scope: 'user', kind: 'fact', content: '条目甲', embedding: new Float32Array([0.5, -0.5]) })
    const b = await store.write({ scope: 'user', kind: 'fact', content: '条目乙', embedding: new Float32Array([1, 2]) })
    const bare = await store.write({ scope: 'user', kind: 'fact', content: '条目丙（无向量）' })
    const vectors = await store.vectorsFor([a.memoryId, b.memoryId, bare.memoryId, asMemoryId('missing-id')])
    expect(vectors.size).toBe(2)
    expect(Array.from(vectors.get(a.memoryId)!)).toEqual([0.5, -0.5])
    expect(Array.from(vectors.get(b.memoryId)!)).toEqual([1, 2])
    expect(vectors.has(bare.memoryId)).toBe(false)
    expect(vectors.has(asMemoryId('missing-id'))).toBe(false)
    expect((await store.vectorsFor([])).size).toBe(0)
  })

  it('读取保持读取：confidence/accessCount/lastAccessedAt 不动', async () => {
    const a = await store.write({ scope: 'user', kind: 'fact', content: '条目甲', embedding: UNIT })
    const before = await store.get(a.id)
    await store.vectorsFor([a.memoryId])
    const after = await store.get(a.id)
    expect(after).toEqual(before)
  })
})
