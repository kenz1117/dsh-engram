import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openEngramStore } from '../src/store/sqlite.ts'
import type { EngramStore } from '../src/store/interface.ts'

let dir: string
let store: EngramStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'engram-injection-'))
  store = await openEngramStore(join(dir, 'user.db'))
})

afterEach(async () => {
  await store.close()
  await rm(dir, { recursive: true, force: true })
})

describe('injection snapshots', () => {
  it('head 列表不携正文，detail 返回完全一致的最终包', async () => {
    const memory = await store.write({ scope: 'user', kind: 'preference', content: '回复使用中文' })
    const packet = '<engram_profile>用户规则</engram_profile>\n\n<engram_memory_context>记忆正文</engram_memory_context>'
    const saved = await store.recordInjection({
      sessionId: 'sess-a',
      packetHash: 'a'.repeat(64),
      packet,
      memoryIds: [memory.id],
      hasCurated: true,
      compactionCount: 2,
    })
    expect(saved.packet).toBe(packet)
    expect(saved.packetBytes).toBe(Buffer.byteLength(packet))

    const items = await store.listInjections({ sessionId: 'sess-a', limit: 50 })
    expect(items).toHaveLength(1)
    expect(items[0]).toEqual({
      id: saved.id,
      sessionId: 'sess-a',
      packetHash: 'a'.repeat(64),
      memoryIds: [memory.id],
      hasCurated: true,
      compactionCount: 2,
      packetBytes: Buffer.byteLength(packet),
      createdAt: saved.createdAt,
    })
    expect('packet' in items[0]!).toBe(false)
    expect(JSON.stringify(items)).not.toContain('记忆正文')

    expect(await store.getInjection(saved.id)).toEqual(saved)
    expect(await store.listInjections({ sessionId: 'sess-b' })).toEqual([])
    expect(await store.getInjection('missing')).toBeUndefined()

    // 366 天班车同口径：阈值前删除，阈值后保留。
    expect(await store.pruneInjections(Date.now() + 1)).toBe(1)
    expect(await store.listInjections({ sessionId: 'sess-a' })).toEqual([])
  })

  it('v13 旧库升级到 v15 后保留记忆并可写快照', async () => {
    const path = join(dir, 'legacy.db')
    const legacy = await openEngramStore(path)
    const old = await legacy.write({ scope: 'user', kind: 'fact', content: 'v13 存量记忆' })
    await legacy.close()

    const raw = new DatabaseSync(path)
    raw.prepare('DROP TABLE injection_snapshots').run()
    raw.prepare("UPDATE meta SET value = '13' WHERE key = 'schema_version'").run()
    raw.close()

    const migrated = await openEngramStore(path)
    expect((await migrated.get(old.id))?.content).toBe('v13 存量记忆')
    const snapshot = await migrated.recordInjection({
      sessionId: 'sess-legacy',
      packetHash: 'b'.repeat(64),
      packet: 'legacy packet',
      memoryIds: [old.id],
      hasCurated: false,
      compactionCount: 0,
    })
    expect((await migrated.getInjection(snapshot.id))?.packet).toBe('legacy packet')
    await migrated.close()

    const check = new DatabaseSync(path, { readOnly: true })
    expect(check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: '15' })
    check.close()
  })
})
