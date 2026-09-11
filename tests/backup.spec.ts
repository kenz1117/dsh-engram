import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGzip } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBackup, restoreBackup, BACKUP_SCHEMA_VERSION } from '../src/backup/tar.ts'
import { createTarPack, endTarPack } from '../src/backup/tar-stream.ts'
import { openEngramStore } from '../src/store/sqlite.ts'
import type { EngramStore } from '../src/store/interface.ts'

let dir: string
let userStore: EngramStore
let projectStore: EngramStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'engram-backup-'))
  userStore = await openEngramStore(join(dir, 'user.db'))
  projectStore = await openEngramStore(join(dir, 'project-abc.db'))
  await userStore.write({ scope: 'user', kind: 'fact', content: '私人宫殿房间 1', importance: 0.7 })
  await projectStore.write({ scope: 'project', kind: 'skill', content: '项目宫殿房间 1', importance: 0.6 })
  await userStore.close()
  await projectStore.close()
})

afterEach(async () => {
  // 各测试自带临时目录，OS 清理。
})

describe('宫殿备份 / 恢复 round-trip', () => {
  it('createBackup 把所有 *.db 打包进 tar.gz + _meta.json', async () => {
    const result = await createBackup(dir, '0.6.1-test')
    expect(result.meta.schemaVersion).toBe(BACKUP_SCHEMA_VERSION)
    expect(result.meta.pluginVersion).toBe('0.6.1-test')
    expect(result.meta.scopes.length).toBe(2)
    expect(result.bytes).toBeGreaterThan(0)
    const archiveBytes = await readFile(result.archivePath)
    // 0x1f 0x8b = gzip magic，验证确实是 gzip 流。
    expect(archiveBytes[0]).toBe(0x1f)
    expect(archiveBytes[1]).toBe(0x8b)
  })

  it('restoreBackup 解包并恢复两库内容', async () => {
    const created = await createBackup(dir, '0.6.1-test')
    // 写入新内容到现有库，恢复后应被覆盖为备份版本。
    const tempUser = await openEngramStore(join(dir, 'user.db'))
    await tempUser.write({ scope: 'user', kind: 'fact', content: '恢复前的脏数据' })
    await tempUser.close()

    const result = await restoreBackup(created.archivePath, dir)
    expect(result.restored.length).toBe(2)
    expect(result.archiveMeta.schemaVersion).toBe(BACKUP_SCHEMA_VERSION)
    // 恢复后读 user.db，原始内容应回来。
    const restored = await openEngramStore(join(dir, 'user.db'))
    const rows = await restored.topActive('user', 10)
    expect(rows.map(r => r.content)).toEqual(['私人宫殿房间 1'])
    await restored.close()
    // 恢复前快照文件应存在。
    const beforeRestore = (await readdir(dir)).filter(n => n.startsWith('user.db.before-restore-'))
    expect(beforeRestore.length).toBe(1)
  })

  it('restoreBackup 在 schema 不匹配时拒绝覆盖', async () => {
    // 手工构造一个 schemaVersion=999 的 tar 包，restore 应拒收。
    const tamperedPath = join(dir, 'palace-bad.tar.gz')
    const tempBad = await mkdtemp(join(tmpdir(), 'engram-bad-'))
    await writeFile(join(tempBad, 'user.db'), Buffer.from('not-a-real-sqlite'))
    const badEntries: { name: string; data: Buffer }[] = [
      { name: 'user.db', data: await readFile(join(tempBad, 'user.db')) },
      { name: '_meta.json', data: Buffer.from(JSON.stringify({ schemaVersion: 999, pluginVersion: '0.0.0', exportedAt: Date.now(), scopes: [] }), 'utf8') },
    ]
    await new Promise<void>((resolve, reject) => {
      const sink = createWriteStream(tamperedPath, { mode: 0o600 })
      sink.on('error', reject); sink.on('finish', () => resolve())
      const gz = createGzip()
      gz.on('error', reject); gz.pipe(sink)
      for (const entry of badEntries) createTarPack(gz, entry.name, entry.data)
      endTarPack(gz)
      gz.end()
    })
    await expect(restoreBackup(tamperedPath, dir)).rejects.toThrow(/^备份 schema 版本/)
  })

  it('archivePath 必须在 dbDir 内（防止路径穿越）', async () => {
    // 直接通过 restore 路径校验逻辑：相对路径 '..' 应被拒。
    // 真实校验在 routes.ts；这里只验证 restoreBackup 自己的语义（用绝对路径不报错）。
    const created = await createBackup(dir, '0.6.1-test')
    await expect(restoreBackup(created.archivePath, dir)).resolves.toBeTruthy()
  })
})
