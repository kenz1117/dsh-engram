import { mkdtemp } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openEngramStore } from '../src/store/sqlite.ts'
import type { EngramStore } from '../src/store/interface.ts'

// Ключи повторной загрузки: журнал чистится вокруг них (см. routes.ts LOG_KEEP_OPS).
const KEEP = ['ingest-done', 'ingest-pending', 'ingest-skip', 'ingest-nothing', 'reflect-pending'] as const

let dir: string
let store: EngramStore

/** Сколько места на диске занимает база вместе с sidecar-файлами (как считает панель). */
function diskBytes(path: string): number {
  return [path, `${path}-wal`, `${path}-shm`].reduce((total, file) => {
    try {
      return total + statSync(file).size
    } catch {
      return total
    }
  }, 0)
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'engram-log-'))
  store = await openEngramStore(join(dir, 'user.db'))
})
afterEach(async () => {
  await store.close()
})

describe('журнал дворца: размер и очистка', () => {
  it('logSize считает строки и объём текста записей', async () => {
    const empty = await store.logSize()
    expect(empty).toEqual({ rows: 0, bytes: 0 })

    await store.audit('ingest-request', 'AUX', 'x'.repeat(100))
    await store.audit('write', 'node-1', null)
    const size = await store.logSize()
    expect(size.rows).toBe(2)
    // Считается текст записей (detail + target_id ок), а не размер файла целиком.
    expect(size.bytes).toBeGreaterThanOrEqual(100 + 'AUX'.length + 'node-1'.length)
  })

  it('clearLog удаляет след, но оставляет ключи повторной загрузки', async () => {
    await store.audit('ingest-request', 'AUX', 'prompt payload')
    await store.audit('write', 'node-1', null)
    await store.audit('ingest-done', 'sess', 'sess:1')
    await store.audit('reflect-pending', 'sess', 'ключ')

    const result = await store.clearLog(KEEP)
    expect(result.deleted).toBe(2)
    // Что-то удалили — вакуум должен состояться (иначе файл остался бы прежнего размера).
    expect(result.vacuumed).toBe(true)
    expect(await store.hasAudit('ingest-done', 'sess:1')).toBe(true)
    expect(await store.hasAudit('reflect-pending', 'ключ')).toBe(true)
    expect(await store.hasAudit('ingest-request', 'AUX')).toBe(false)
    expect((await store.logSize()).rows).toBe(2)
  })

  it('clearLog с пустым списком чистит журнал целиком', async () => {
    await store.audit('ingest-done', 'sess', 'sess:1')
    await store.audit('ingest-request', 'AUX', 'payload')
    const result = await store.clearLog([])
    expect(result.deleted).toBe(2)
    expect((await store.logSize()).rows).toBe(0)
  })

  it('повторная очистка пустого журнала — ноль удалённых, без ошибки', async () => {
    await store.audit('write', 'node-1', null)
    await store.clearLog(KEEP)
    const again = await store.clearLog(KEEP)
    expect(again.deleted).toBe(0)
    // Удалять нечего — вакуум не гоняем (он только раздувает WAL); чекпоинт всё равно
    // освобождает место, поэтому флаг честный: сжатия не было, усечение — было.
    expect(again.vacuumed).toBe(false)
    expect(typeof again.checkpointed).toBe('boolean')
  })

  it('очистка освобождает место на диске: сумма db+wal+shm не растёт', async () => {
    const path = join(dir, 'user.db')
    for (let i = 0; i < 400; i += 1) await store.audit('write', `node-${i}`, 'x'.repeat(400))
    const before = diskBytes(path)
    const result = await store.clearLog(KEEP)
    const after = diskBytes(path)
    expect(result.deleted).toBe(400)
    // Регресс: в WAL-режиме VACUUM писал пересобранную базу в -wal, а главный файл
    // не усекал — сумма файлов на диске после «очистки» только РАСТОЛА.
    expect(after).toBeLessThan(before)
  })

  it('журнал после очистки продолжает писаться', async () => {
    await store.audit('write', 'node-1', null)
    await store.clearLog(KEEP)
    await store.audit('write', 'node-2', null)
    const rows = await store.recentOps(10)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.targetId).toBe('node-2')
  })
})
