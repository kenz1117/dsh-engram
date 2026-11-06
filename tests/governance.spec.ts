import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openEngramStore } from '../src/store/sqlite.ts'
import type { EngramStore } from '../src/store/interface.ts'

let dir: string
let store: EngramStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'engram-governance-'))
  store = await openEngramStore(join(dir, 'user.db'))
})

afterEach(async () => {
  await store.close()
  await rm(dir, { recursive: true, force: true })
})

describe('contradiction governance', () => {
  it('lists only active contradicts pairs and preserves stable identity', async () => {
    const first = await store.write({ scope: 'user', kind: 'fact', content: '仓库在杭州' })
    const second = await store.write({ scope: 'user', kind: 'fact', content: '仓库在上海' })
    const archived = await store.write({ scope: 'user', kind: 'fact', content: '旧仓库在北京' })
    await store.linkEdge(first.id, second.id, 'contradicts')
    await store.linkEdge(first.id, archived.id, 'contradicts')
    await store.forget(archived.id)

    const items = await store.listContradictions(50)
    expect(items).toHaveLength(1)
    expect(items[0]?.first.memoryId).toBe(first.memoryId)
    expect(items[0]?.second.memoryId).toBe(second.memoryId)
    expect(items[0]?.createdAt).toBeGreaterThan(0)
  })

  it('dismiss rewrites contradicts to related and writes a governance audit row', async () => {
    const first = await store.write({ scope: 'user', kind: 'fact', content: '偏好命令行' })
    const second = await store.write({ scope: 'user', kind: 'preference', content: '偏好 GUI' })
    await store.linkEdge(first.id, second.id, 'contradicts')

    const result = await store.resolveContradiction({
      firstId: first.id,
      secondId: second.id,
      action: 'dismiss',
    })
    expect(result.dismissed).toBe(true)
    expect(await store.listContradictions(50)).toEqual([])
    const view = await store.review(first.id)
    expect(view?.related.map(id => String(id))).toEqual([String(second.id)])
    expect(view?.contradicts).toEqual([])
    const operations = (await store.recentOps(10)).filter(op => op.op === 'governance')
    expect(operations).toHaveLength(1)
    expect(operations[0]?.detail).toContain('"action":"dismiss"')
  })

  it('forget-loser closes only the named loser and requires an actual pair', async () => {
    const first = await store.write({ scope: 'user', kind: 'fact', content: '端口是 3000' })
    const second = await store.write({ scope: 'user', kind: 'fact', content: '端口是 4000' })
    const unrelated = await store.write({ scope: 'user', kind: 'fact', content: '无关记忆' })
    await store.linkEdge(second.id, first.id, 'contradicts')

    const result = await store.resolveContradiction({
      firstId: first.id,
      secondId: second.id,
      action: 'forget-loser',
      loserId: first.id,
    })
    expect(result.dismissed).toBe(false)
    expect(result.forgotten?.id).toBe(first.id)
    expect((await store.get(first.id))?.status).toBe('forgotten')
    expect((await store.get(second.id))?.status).toBe('active')
    expect((await store.get(unrelated.id))?.status).toBe('active')
    expect(await store.listContradictions(50)).toEqual([])

    await expect(store.resolveContradiction({
      firstId: second.id,
      secondId: unrelated.id,
      action: 'dismiss',
    })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
