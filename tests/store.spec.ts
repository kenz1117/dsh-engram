import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openEngramStore } from '../src/store/sqlite.ts'
import { asMemoryId } from '../src/types.ts'
import type { EngramStore } from '../src/store/interface.ts'

let dir: string
let store: EngramStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'engram-'))
  store = await openEngramStore(join(dir, 'user.db'))
})
afterEach(async () => {
  await store.close()
})

describe('EngramStore (sqlite)', () => {
  it('write 后可 get，字段完整', async () => {
    const record = await store.write({ scope: 'user', kind: 'preference', content: '用户偏好简体中文回复', importance: 0.8 })
    const fetched = await store.get(record.id)
    expect(fetched?.content).toBe('用户偏好简体中文回复')
    expect(fetched?.status).toBe('active')
    expect(fetched?.accessCount).toBe(0)
    expect(fetched?.sourceSessionId).toBeNull()
  })

  it('空 content loud 失败', async () => {
    await expect(store.write({ scope: 'user', kind: 'fact', content: '   ' })).rejects.toThrow(/content/)
  })

  it('FTS 检索命中中文 2 字查询', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '项目使用 pnpm 管理依赖' })
    const result = await store.search({ text: 'pnpm', scopes: ['user'] }, undefined)
    expect(result.degraded).toBe(true)
    expect(result.hits.length).toBe(1)
    expect(result.hits[0]!.via).toBe('fts')
  })

  it('中文 2 字查询命中（2-gram 切词）', async () => {
    await store.write({ scope: 'user', kind: 'decision', content: '部署端口改为 4000' })
    const result = await store.search({ text: '端口', scopes: ['user'] }, undefined)
    expect(result.hits.length).toBe(1)
  })

  it('向量道与 FTS 道融合，via=both 且 degraded=false', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: 'alpha 内容说明', embedding: new Float32Array(512).fill(0.1) })
    const vec = new Float32Array(512).fill(0.1)
    const result = await store.search({ text: 'alpha', scopes: ['user'] }, vec)
    expect(result.degraded).toBe(false)
    expect(result.hits[0]!.via).toBe('both')
  })

  it('向量道低于语义门槛的条目不出现', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '完全无关的内容词', embedding: new Float32Array(512).fill(0.4) })
    // 查询与内容无共享 2-gram，且查询向量与内容向量方向相反（余弦 < 门槛）。
    const vec = new Float32Array(512).fill(-0.4)
    const result = await store.search({ text: '量子纠缠', scopes: ['user'] }, vec)
    expect(result.hits).toHaveLength(0)
  })

  it('update 建立 supersedes 链且旧条目退出检索', async () => {
    const old = await store.write({ scope: 'user', kind: 'fact', content: '端口是 3000' })
    const next = await store.update({ id: old.id, scope: 'user', kind: 'fact', content: '端口改为 4000' })
    expect((await store.get(old.id))?.status).toBe('archived')
    const result = await store.search({ text: '端口', scopes: ['user'] }, undefined)
    expect(result.hits.map(hit => hit.record.id)).toEqual([next.id])
    expect(result.hits[0]!.record.content).toContain('4000')
  })

  it('update 不存在的条目 loud 失败', async () => {
    await expect(store.update({ id: asMemoryId('nope'), scope: 'user', kind: 'fact', content: 'x' })).rejects.toThrow(/不存在/)
  })

  it('forget/restore 往返', async () => {
    const record = await store.write({ scope: 'user', kind: 'fact', content: '待删除条目' })
    expect((await store.forget(record.id)).status).toBe('forgotten')
    expect(await store.get(record.id)).toBeDefined()
    expect((await store.restore(record.id)).status).toBe('active')
    const result = await store.search({ text: '待删除', scopes: ['user'] }, undefined)
    expect(result.hits).toHaveLength(1)
  })

  it('检索命中会强化访问计数', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '访问计数条目' })
    await store.search({ text: '访问计数', scopes: ['user'] }, undefined)
    const result = await store.search({ text: '访问计数', scopes: ['user'] }, undefined)
    expect(result.hits[0]!.record.accessCount).toBe(1)
  })

  it('topActive 按 importance 倒序', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '低重要性', importance: 0.2 })
    await store.write({ scope: 'user', kind: 'fact', content: '高重要性', importance: 0.9 })
    const top = await store.topActive(1)
    expect(top[0]!.content).toBe('高重要性')
  })

  it('timeline 按 createdAt 倒序且 topic 过滤', async () => {
    const a = await store.write({ scope: 'user', kind: 'episode', content: '事件 A 描述' })
    await new Promise(resolve => setTimeout(resolve, 3))
    const b = await store.write({ scope: 'user', kind: 'episode', content: '事件 B 描述' })
    const rows = await store.timeline({ scopes: ['user'] })
    expect(rows.map(row => row.id)).toEqual([b.id, a.id])
    const filtered = await store.timeline({ scopes: ['user'], topic: 'B' })
    expect(filtered.map(row => row.id)).toEqual([b.id])
  })

  it('purge 物理清空', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '将被清除' })
    await store.purge()
    const result = await store.search({ text: '清除', scopes: ['user'] }, undefined)
    expect(result.hits).toHaveLength(0)
    expect(await store.topActive(10)).toHaveLength(0)
  })

  it('schema 版本不兼容时拒绝打开', async () => {
    const path = join(dir, 'bad.db')
    const bad = await openEngramStore(path)
    await bad.close()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(path)
    db.prepare("UPDATE meta SET value = '999' WHERE key = 'schema_version'").run()
    db.close()
    await expect(openEngramStore(path)).rejects.toThrow(/schema/i)
  })

  it('asMemoryId 品牌化 id 可透传 get', async () => {
    const record = await store.write({ scope: 'user', kind: 'fact', content: '品牌 id' })
    expect((await store.get(asMemoryId(record.id)))?.id).toBe(record.id)
  })
})
