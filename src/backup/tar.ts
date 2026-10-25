/**
 * 宫殿备份与恢复：把当前 user/project 两库的 .db + 元信息打包成单一 .tar.gz 文件；
 * 恢复时校验 tar 内的 _meta.json schema 版本并覆盖原库（恢复前自动备份现状为 .before-restore-<ts>）。
 * 设计原则：
 * 1. tar 内文件路径用相对形式 `palace.db` / `palace-<scope>.db` / `_meta.json`，避免暴露绝对路径。
 * 2. 元信息必须含 schema_version（与插件同构），恢复时若不匹配返回明确的兼容错误而不是默默覆盖。
 * 3. 整个过程失败原子：恢复前若任何前置校验失败，原库不动。
 * @module @kenz1117/dsh-engram/backup/tar
 */

import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { gunzip, createGzip } from 'node:zlib'
import { promisify } from 'node:util'
import { createTarPack, endTarPack, extractTar } from './tar-stream.ts'
import { message } from '../i18n/messages.ts'
import type { EngramScope } from '../types.ts'

const gunzipAsync = promisify<Buffer, Buffer>(gunzip)

/** tar 包内 _meta.json 的 schema 版本（与插件 schema 升级解耦，独立计数）。 */
export const BACKUP_SCHEMA_VERSION = 1

/** 备份元信息（在 _meta.json 中序列化）。 */
export interface BackupMeta {
  readonly schemaVersion: number
  readonly pluginVersion: string
  readonly exportedAt: number
  readonly scopes: readonly { readonly scope: EngramScope; readonly recordCount: number; readonly edgeCount: number }[]
}

export interface BackupResult {
  readonly archivePath: string
  readonly meta: BackupMeta
  readonly bytes: number
}

/**
 * 创建备份：把 dbDir 下所有 *.db 与 `_meta.json` 一起打包成 .tar.gz。
 * @param dbDir - 插件数据目录（含 user.db / project-*.db）。
 * @param pluginVersion - 写进 _meta.json 的插件版本（与 package.json 同步）。
 */
export async function createBackup(dbDir: string, pluginVersion: string): Promise<BackupResult> {
  await mkdir(dbDir, { recursive: true, mode: 0o700 })
  const tempDir = await mkdtemp(join(dbDir, '.backup-tmp-'))
  try {
    const files = (await readdir(dbDir)).filter(name => name.endsWith('.db'))
    // 局部可变数组构建，最终以只读契约（BackupMeta['scopes']）对外。
    const scopes: { scope: EngramScope; recordCount: number; edgeCount: number }[] = []
    const entries: { name: string; data: Buffer }[] = []
    for (const name of files) {
      const path = join(dbDir, name)
      const statResult = await stat(path)
      if (!statResult.isFile()) continue
      const snapshot = join(tempDir, name)
      await snapshotDatabase(path, snapshot)
      entries.push({ name, data: await readFileBuffer(snapshot) })
      // 简化：仅记录文件名，不读取每条记录数（恢复端会自己 inspect）。
      scopes.push({ scope: name === 'user.db' ? 'user' : 'project', recordCount: 0, edgeCount: 0 })
    }
    const meta: BackupMeta = {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      pluginVersion,
      exportedAt: Date.now(),
      scopes,
    }
    entries.push({ name: '_meta.json', data: Buffer.from(JSON.stringify(meta, null, 2), 'utf8') })
    const stamp = new Date().toISOString().replaceAll(':', '-').slice(0, 19)
    const archivePath = join(dbDir, `palace-backup-${stamp}.tar.gz`)
    await writeTarGz(archivePath, entries)
    return { archivePath, meta, bytes: (await stat(archivePath)).size }
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

/** VACUUM INTO 生成含 WAL 已提交内容的单文件一致性快照，不复制正在变化的 sidecar。 */
async function snapshotDatabase(source: string, destination: string): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite')
  let db: InstanceType<typeof DatabaseSync> | undefined
  try {
    db = new DatabaseSync(source, { readOnly: true })
    db.exec('PRAGMA busy_timeout = 5000')
    db.prepare('VACUUM INTO ?').run(destination)
  } finally {
    db?.close()
  }
}

/** 异步读文件为 Buffer（小文件路径，备份场景可接受）。 */
async function readFileBuffer(path: string): Promise<Buffer> {
  const { readFile } = await import('node:fs/promises')
  return readFile(path)
}

/**
 * 把 entries 写入 .tar.gz。tar 头由本模块自带实现（避免引入 tar 依赖），gzip 用 zlib.createGzip。
 */
async function writeTarGz(outPath: string, entries: ReadonlyArray<{ name: string; data: Buffer }>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const sink = createWriteStream(outPath, { mode: 0o600 })
    sink.on('error', reject)
    sink.on('finish', () => resolve())
    const gz = createGzip()
    gz.on('error', reject)
    gz.pipe(sink)
    for (const entry of entries) createTarPack(gz, entry.name, entry.data)
    endTarPack(gz)
    gz.end()
  })
}

/** 恢复选项：是否在覆盖前把现有 db 重命名为 .before-restore-<ts>（默认开）。 */
export interface RestoreOptions {
  readonly keepCurrent?: boolean
}

/** 恢复结果摘要。 */
export interface RestoreResult {
  readonly restored: readonly string[]
  readonly archiveMeta: BackupMeta
}

/**
 * 从 .tar.gz 恢复：解包到临时目录 → 校验 _meta.json → 把 .db 文件原子搬到 dbDir。
 * 任何前置校验失败抛错，原 dbDir 不变。
 */
export async function restoreBackup(archivePath: string, dbDir: string, options: RestoreOptions = {}): Promise<RestoreResult> {
  await mkdir(dbDir, { recursive: true, mode: 0o700 })
  const tempDir = await mkdtemp(join(dbDir, '.restore-tmp-'))
  try {
    await untarGz(archivePath, tempDir)
    const metaRaw = await readFileBuffer(join(tempDir, '_meta.json')).then(buf => buf.toString('utf8'))
    const meta = JSON.parse(metaRaw) as BackupMeta
    if (meta.schemaVersion !== BACKUP_SCHEMA_VERSION) {
      throw new Error(message('store.backupSchemaMismatch', { found: meta.schemaVersion, expected: BACKUP_SCHEMA_VERSION }))
    }
    if (typeof meta.pluginVersion !== 'string' || meta.pluginVersion === '') {
      throw new Error(message('store.backupMetaMissingPluginVersion'))
    }

    const incoming: string[] = []
    for (const name of (await readdir(tempDir)).filter(n => n.endsWith('.db'))) {
      const path = join(tempDir, name)
      if (!(await stat(path)).isFile()) continue
      await validateDatabase(path, name)
      incoming.push(name)
    }
    if (incoming.length === 0) throw new Error(message('store.backupNoDatabases'))

    // keepCurrent=false 只表示成功后不保留旧副本；替换期间仍须可回滚。
    const stamp = `${new Date().toISOString().replaceAll(':', '-').slice(0, 19)}-${randomUUID()}`
    const current: { readonly path: string; readonly backup: string }[] = []
    for (const name of await readdir(dbDir)) {
      if (!/\.db(?:-wal|-shm|-journal)?$/.test(name)) continue
      const path = join(dbDir, name)
      if (!(await stat(path)).isFile()) continue
      const backup = options.keepCurrent === false
        ? join(tempDir, `.current-${name}`)
        : `${path}.before-restore-${stamp}`
      current.push({ path, backup })
    }

    const moved: { readonly path: string; readonly backup: string }[] = []
    const installed: string[] = []
    try {
      for (const item of current) {
        await rename(item.path, item.backup)
        moved.push(item)
      }
      for (const name of incoming) {
        const target = join(dbDir, name)
        await rename(join(tempDir, name), target)
        installed.push(target)
      }
      return { restored: installed, archiveMeta: meta }
    } catch (error) {
      const rollbackErrors: unknown[] = []
      for (const target of installed.reverse()) {
        try { await rm(target, { force: true }) } catch (rollbackError) { rollbackErrors.push(rollbackError) }
      }
      for (const item of moved.reverse()) {
        try { await rename(item.backup, item.path) } catch (rollbackError) { rollbackErrors.push(rollbackError) }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError([error, ...rollbackErrors], 'restore failed and rollback was incomplete')
      }
      throw error
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

/** 覆盖前只读验证 SQLite 完整性和 Engram 最小结构，不在暂存库上执行迁移。 */
async function validateDatabase(path: string, name: string): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite')
  let db: InstanceType<typeof DatabaseSync> | undefined
  try {
    db = new DatabaseSync(path, { readOnly: true })
    const integrity = db.prepare('PRAGMA integrity_check').all() as unknown as { integrity_check: string }[]
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('meta', 'nodes')").all() as unknown as { name: string }[]
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
      throw new Error(integrity.map(row => row.integrity_check).join('; ') || 'integrity_check returned no result')
    }
    if (!tables.some(row => row.name === 'meta') || !tables.some(row => row.name === 'nodes')) {
      throw new Error('required tables meta/nodes are missing')
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(message('store.backupInvalidDatabase', { name, reason }), { cause: error })
  } finally {
    try { db?.close() } catch { /* 只读校验连接的关闭失败不覆盖原始错误。 */ }
  }
}

/** 解 .tar.gz 到目标目录：先解压到 buffer，再 inline 解 tar。 */
async function untarGz(archivePath: string, destDir: string): Promise<void> {
  const compressed = await readFileBuffer(archivePath)
  const tar = await gunzipAsync(compressed)
  await extractTar(tar, destDir)
}
