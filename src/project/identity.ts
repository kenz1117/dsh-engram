/**
 * 项目标识：git origin URL 归一化 → sha256 短哈希分库名；无 git 或无 origin 时
 * 回退完整 cwd 哈希。纯文件读（.git/config、worktree 的 gitdir/commondir
 * 指针），不起子进程。启动时负责旧库文件向新标识的 rename 迁移。
 * @module @kenz1117/dsh-engram/project/identity
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { LegacyMigrationPolicy } from '../config.ts'

/** 项目标识解析结果。 */
export interface ProjectIdentity {
  readonly cwd: string
  /** 分库文件名（`project-<hash>.db`）。 */
  readonly dbName: string
  /** 标识来源：git origin 归一化哈希，或 cwd 兜底。 */
  readonly source: 'origin' | 'cwd'
  /** cwd 兜底算法的库文件名（v0.4 旧命名，迁移与兜底共用）。 */
  readonly legacyDbName: string
}

/** renamed = 已迁移；kept-both = 并存；deferred = 保留旧库；already-migrated = 已有归属记录；none = 无需迁移。 */
export type MigrationOutcome = 'renamed' | 'kept-both' | 'none' | 'deferred' | 'already-migrated'

/** v0.4 旧命名：cwd 的 hex 编码前 24 位（只覆盖 cwd 前 12 UTF-8 字节，同前缀目录会撞库）。保留仅供迁移识别。 */
export function legacyProjectDbName(cwd: string): string {
  return `project-${Buffer.from(cwd).toString('hex').slice(0, 24)}.db`
}

/**
 * 无 git 时的 cwd 命名：cwd 全量 sha256 前 24 位。
 * 旧算法只取 cwd 前 12 UTF-8 字节，`C:\Users\Adm…` 这类同前缀目录会共用同一个库；
 * 新算法对每个目录唯一，启动时把旧库 rename 迁移到新名（见 migrateProjectDb）。
 */
export function cwdProjectDbName(cwd: string): string {
  return `project-${createHash('sha256').update(cwd).digest('hex').slice(0, 24)}.db`
}

/**
 * 归一化 git origin URL：去协议与凭证、host 小写、去尾部 `.git` 与 `/`，
 * 使 `git@github.com:a/b.git` 与 `https://github.com/a/b` 等价。无法解析返回 undefined。
 */
export function normalizeOriginUrl(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  // SCP-like 形式（git@host:path）：host 取 @ 与 : 之间，路径取 : 之后。
  const scp = /^[^@\s]+@([^:\s]+):(.+)$/.exec(trimmed)
  let host: string
  let path: string
  if (scp !== null) {
    host = scp[1]!
    path = scp[2]!
  } else {
    // 无协议的裸 host/path 补 https:// 以便 URL 解析（凭证由解析器自动剥离）。
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`
    try {
      const url = new URL(withScheme)
      host = url.host
      path = url.pathname
    } catch {
      return undefined
    }
  }
  // 统一成 `host/path`：SCP 形式的路径不带前导 /，URL 形式的带，先剥再拼。
  const normalizedPath = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/+$/, '')
  if (host === '' || normalizedPath === '') return undefined
  return `${host.toLowerCase()}/${normalizedPath}`
}

/**
 * 定位真 git config：`.git` 为目录时取其 config；为文件（worktree/submodule）时
 * 沿 `gitdir:` 指针找到 gitdir，再沿其中的 `commondir` 指针回到主 git 目录。
 * 任一环节缺失返回 undefined。
 */
export function resolveGitConfigPath(cwd: string): string | undefined {
  const dotGit = join(cwd, '.git')
  let stat
  try {
    stat = statSync(dotGit)
  } catch {
    return undefined
  }
  if (stat.isDirectory()) {
    return existsSync(join(dotGit, 'config')) ? join(dotGit, 'config') : undefined
  }
  if (!stat.isFile()) return undefined
  const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))
  if (pointer === null) return undefined
  const gitdir = resolve(cwd, pointer[1]!.trim())
  // worktree 的 gitdir 是主仓库 .git/worktrees/<name>，真 config 在 commondir 指向的主 git 目录。
  let common = gitdir
  try {
    const commondir = readFileSync(join(gitdir, 'commondir'), 'utf8').trim()
    if (commondir !== '') common = resolve(gitdir, commondir)
  } catch {
    // 无 commondir 文件：gitdir 即真 git 目录（如 submodule 场景）。
  }
  const configPath = join(common, 'config')
  return existsSync(configPath) ? configPath : undefined
}

/** 从 git config 文本提取 `[remote "origin"]` 段的 url（手写 INI 行解析，不引依赖）。 */
export function readOriginUrl(configPath: string): string | undefined {
  let text: string
  try {
    text = readFileSync(configPath, 'utf8')
  } catch {
    return undefined
  }
  let inOrigin = false
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('[')) {
      inOrigin = /^\[remote\s+"origin"\]$/i.test(trimmed)
      continue
    }
    if (inOrigin) {
      const entry = /^url\s*=\s*(.+)$/.exec(trimmed)
      if (entry !== null) return entry[1]!.trim()
    }
  }
  return undefined
}

/**
 * 解析项目标识：origin URL 归一化后取 sha256 hex 前 24 位；无 git、无 origin
 * 或 URL 无法解析时回退 cwd 全量哈希命名。
 */
export function resolveProjectIdentity(cwd: string): ProjectIdentity {
  const legacyDbName = legacyProjectDbName(cwd)
  const configPath = resolveGitConfigPath(cwd)
  const origin = configPath === undefined ? undefined : readOriginUrl(configPath)
  const normalized = origin === undefined ? undefined : normalizeOriginUrl(origin)
  if (normalized === undefined) return { cwd, dbName: cwdProjectDbName(cwd), source: 'cwd', legacyDbName }
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 24)
  return { cwd, dbName: `project-${hash}.db`, source: 'origin', legacyDbName }
}

/** JSON sidecar records a completed claim; never used as a path to open a database. */
export interface MigrationPointer {
  readonly migratedTo: string
  readonly claimedByCwd: string
  readonly claimedAt: string
}

export function readMigrationPointer(dbDir: string, identity: ProjectIdentity): MigrationPointer | undefined {
  const path = join(dbDir, `${identity.legacyDbName}.migrated-to`)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null
    || !('migratedTo' in value) || typeof value.migratedTo !== 'string'
    || !/^project-[0-9a-f]{24}\.db$/.test(value.migratedTo)
    || !('claimedByCwd' in value) || typeof value.claimedByCwd !== 'string'
    || !('claimedAt' in value) || typeof value.claimedAt !== 'string'
    || !Number.isFinite(Date.parse(value.claimedAt))) {
    throw new Error(`dsh-engram: invalid migration pointer ${path}; inspect it manually`)
  }
  return value as MigrationPointer
}

/**
 * Eager keeps the existing rename policy, recording its ambiguous ownership in JSON.
 * Conservative leaves legacy bytes untouched; the caller may open an empty new store.
 * Coexisting databases are never merged or overwritten. This is not a cross-process lock
 * or an atomic transaction across the rename and sidecar write: stop other hosts first.
 */
export function migrateProjectDb(
  dbDir: string, identity: ProjectIdentity, policy: LegacyMigrationPolicy = 'eager',
): MigrationOutcome {
  if (identity.dbName === identity.legacyDbName) return 'none'
  const next = join(dbDir, identity.dbName)
  const legacy = join(dbDir, identity.legacyDbName)
  const hasNext = existsSync(next)
  const hasLegacy = existsSync(legacy)
  if (hasNext && hasLegacy) return 'kept-both'
  // Preserve previous claims even if a legacy file is later restored from backup.
  const pointer = readMigrationPointer(dbDir, identity)
  if (pointer !== undefined) {
    if (hasLegacy || pointer.migratedTo !== identity.dbName) return 'already-migrated'
    return 'none'
  }
  if (!hasNext && hasLegacy) {
    if (policy === 'conservative') return 'deferred'
    renameSync(legacy, next)
    try {
      writeFileSync(`${legacy}.migrated-to`, JSON.stringify({
        migratedTo: identity.dbName,
        claimedByCwd: identity.cwd,
        claimedAt: new Date().toISOString(),
      } satisfies MigrationPointer) + '\n', { flag: 'wx', mode: 0o600 })
    } catch (error) {
      // Do not attempt a rollback that could overwrite a concurrently restored old file.
      throw new Error(`dsh-engram: renamed ${identity.legacyDbName} to ${identity.dbName}, but could not record migration; inspect both paths before retrying`, { cause: error })
    }
    return 'renamed'
  }
  return 'none'
}

/** Shared guidance for plugin boot and session-cwd migration checks. */
export function migrationWarning(dbDir: string, identity: ProjectIdentity, outcome: MigrationOutcome): string | undefined {
  const names = `旧库 ${identity.legacyDbName}；新库 ${identity.dbName}`
  const manual = '人工处理前请停止相关宿主并备份所有数据库及 sidecar；新库可能已写入记忆，请勿直接覆盖，先用 engram_review / engram_export 审核并人工重新归属'
  switch (outcome) {
    case 'none': return undefined
    case 'renamed':
      return `[dsh-engram] 项目记忆库已迁移（${names}），已记录 .migrated-to；旧库可能包含同前缀目录的记忆。${manual}`
    case 'kept-both':
      return `[dsh-engram] 新旧项目记忆库并存，未合并或移动（${names}）。${manual}`
    case 'deferred':
      return `[dsh-engram] conservative 模式暂缓旧库迁移（${names}）；旧库保持不变，将打开新的空库。${manual}`
    case 'already-migrated': {
      const pointer = readMigrationPointer(dbDir, identity)
      return `[dsh-engram] 旧库已有迁移记录（${names}）：${JSON.stringify(pointer)}；先前迁移的库可能含有当前目录的记忆。${manual}`
    }
  }
}
