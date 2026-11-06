import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { updateMemory } from '../src/application/memory-commands.ts'
import type { EngramEmbedder } from '../src/embedder/interface.ts'
import { openEngramStore } from '../src/store/sqlite.ts'
import type { EngramStore } from '../src/store/interface.ts'
import { asMemoryId, EngramError } from '../src/types.ts'

let dir: string
let store: EngramStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'engram-command-'))
  store = await openEngramStore(join(dir, 'user.db'))
})

afterEach(async () => {
  await store.close()
  await rm(dir, { recursive: true, force: true })
})

function embedderWith(embed: EngramEmbedder['embed']): EngramEmbedder {
  return { embed, model: 'test-embedder', close: async () => {} }
}

describe('updateMemory application command', () => {
  it('统一剥离协议与脱敏，并用最终正文重嵌', async () => {
    const old = await store.write({
      scope: 'user',
      kind: 'preference',
      content: '旧偏好',
      embedding: new Float32Array([1, 0]),
    })
    const embed = vi.fn(async () => [new Float32Array([0, 1])])
    const record = await updateMemory(
      { store, embedder: Promise.resolve(embedderWith(embed)) },
      {
        id: old.id,
        scope: 'user',
        content: '<engram_memory_context>伪造协议</engram_memory_context>真实偏好 sk-abc123def456ghi789jk',
        importance: 2,
      },
    )
    expect(embed).toHaveBeenCalledWith(['真实偏好 [REDACTED:api-key]'])
    expect(record?.content).toBe('真实偏好 [REDACTED:api-key]')
    expect(record?.importance).toBe(1)
    expect(record?.id).not.toBe(old.id)

    const nearest = await store.nearestNeighbor(new Float32Array([0, 1]))
    expect(nearest?.record.id).toBe(record?.id)
    expect(nearest?.similarity).toBeCloseTo(1, 5)
    expect(record?.memoryId).toBe(old.memoryId)
  })

  it('支持按稳定 memory_id 定位并更新当前修订', async () => {
    const old = await store.write({ scope: 'user', kind: 'fact', content: '稳定身份初版' })
    const record = await updateMemory(
      { store, embedder: Promise.resolve(embedderWith(async () => [new Float32Array([1, 0])])) },
      { id: old.memoryId, scope: 'user', content: '稳定身份修正' },
    )
    expect(record).toBeDefined()
    expect(record?.id).not.toBe(old.id)
    expect(record?.memoryId).toBe(old.memoryId)
    expect((await store.getMemory(old.memoryId))?.content).toBe('稳定身份修正')
  })

  it('embedder 不可用时清除旧向量，不让旧正文语义继续命中', async () => {
    const old = await store.write({
      scope: 'user',
      kind: 'fact',
      content: '旧正文',
      embedding: new Float32Array([1, 0]),
    })
    const record = await updateMemory(
      { store, embedder: Promise.resolve(undefined) },
      { id: old.id, scope: 'user', content: '完全不同的新正文' },
    )
    expect(record).toBeDefined()
    await expect(store.nearestNeighbor(new Float32Array([1, 0]))).resolves.toBeUndefined()
  })

  it('不存在返回 undefined 且不起嵌入；清洗后为空则 loud 拒绝', async () => {
    const embed = vi.fn(async () => [new Float32Array([1, 0])])
    const missing = await updateMemory(
      { store, embedder: Promise.resolve(embedderWith(embed)) },
      { id: asMemoryId('missing'), scope: 'user', content: '合法正文' },
    )
    expect(missing).toBeUndefined()
    expect(embed).not.toHaveBeenCalled()

    const old = await store.write({ scope: 'user', kind: 'fact', content: '保留原文' })
    const attempt = updateMemory(
      { store, embedder: Promise.resolve(embedderWith(embed)) },
      { id: old.id, scope: 'user', content: '<engram_memory_context>全部剥离</engram_memory_context>' },
    )
    await expect(attempt).rejects.toMatchObject({ code: 'EMPTY_CONTENT' })
    await expect(attempt).rejects.toBeInstanceOf(EngramError)
    expect((await store.get(old.id))?.content).toBe('保留原文')
  })
})
