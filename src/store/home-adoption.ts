/**
 * 旧数据目录的收编（#51）：DSH_HOME 迁移之后，别让记忆库分裂成两份。
 *
 * 背景：数据目录默认值此前写死 `~/.dsh/engram`，不看宿主的 `$DSH_HOME`。把 home
 * 搬到别的盘之后，插件的数据仍然静默留在旧盘上；人以为在用新盘，其实读的是旧盘。
 * 默认值改成跟 `$DSH_HOME` 之后又来一个坑：旧盘上的库会被留在原地，插件却开始读
 * 新盘——于是「库不见了」。这里做的就是把那一份搬到新盘去。
 *
 * 规矩：
 *   - 显式配置了 `dbDir` 的人自己说了算，这里一个字都不动；
 *   - 目标目录已经有库 → 两边都有数据，不自动合并，保留旧目录继续用（人的记忆在那儿），
 *     并明确报出两个路径让人处理；
 *   - 搬运失败 → 仍然用旧目录。数据看不见比数据待在新盘上更糟；
 *   - 跨盘（EXDEV）先复制到临时目录、逐个文件核对大小，确认无误才改名并删旧，
 *     任何一步出错都不删旧目录。
 *
 * @module @kenz1117/dsh-engram/store/home-adoption
 */

import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 旧库迁移策略：与 `legacyMigration` 同一档。 */
export type AdoptionPolicy = 'eager' | 'conservative'

export type AdoptionOutcome =
  /** 无需收编：目标就是旧目录，或旧目录里没有库。 */
  | 'none'
  /** 同盘重命名搬走。 */
  | 'moved'
  /** 跨盘复制（核对后删旧）。 */
  | 'copied'
  /** 保守档：保留旧目录，等人来处理。 */
  | 'deferred'
  /** 两边都有库：不动，但报出来。 */
  | 'kept-both'
  /** 搬运失败：仍用旧目录。 */
  | 'failed'

export interface AdoptionPlan {
  /** 实际应当使用的目录。 */
  readonly dbDir: string
  /** 旧目录（收编来源）。 */
  readonly legacyDbDir: string
  readonly outcome: AdoptionOutcome
  /** 失败原因（仅 failed 时有）。 */
  readonly detail?: string | undefined
}

/** 目录里是否有数据库文件（记忆库本体；只有字典/模型不算“有库”）。 */
function hasDatabase(dir: string): boolean {
  if (!existsSync(dir)) return false
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return false
  }
  return entries.some(name => name.endsWith('.db'))
}

/** 目录是否为空（没有任何条目）。 */
function isEmptyDir(dir: string): boolean {
  if (!existsSync(dir)) return true
  try {
    return readdirSync(dir).length === 0
  } catch {
    return false
  }
}

/** 递归列出相对路径与字节数（复制后的核对依据）。 */
function fileSizes(dir: string): Map<string, number> {
  const out = new Map<string, number>()
  const walk = (current: string, prefix: string): void => {
    for (const name of readdirSync(current)) {
      const full = join(current, name)
      const rel = prefix === '' ? name : `${prefix}/${name}`
      const stat = statSync(full)
      if (stat.isDirectory()) walk(full, rel)
      else out.set(rel, stat.size)
    }
  }
  walk(dir, '')
  return out
}

/** 两份目录的文件清单与大小是否一致。 */
function sameContent(a: string, b: string): boolean {
  const left = fileSizes(a)
  const right = fileSizes(b)
  if (left.size !== right.size) return false
  for (const [name, size] of left) {
    if (right.get(name) !== size) return false
  }
  return true
}

/**
 * 决定并（必要时）执行旧目录收编。
 * @param target - 新数据目录（`$DSH_HOME/engram` 或显式配置）。
 * @param legacy - 旧默认目录（`~/.dsh/engram`）。
 * @param policy - 迁移策略：`eager` 自动搬，`conservative` 只报不动。
 * @returns 实际应使用的目录与搬运结果。
 */
export function adoptLegacyDbDir(options: {
  readonly target: string
  readonly legacy: string
  readonly policy: AdoptionPolicy
}): AdoptionPlan {
  const { target, legacy, policy } = options
  const base = { legacyDbDir: legacy }
  if (target === legacy) return { ...base, dbDir: target, outcome: 'none' }
  if (!hasDatabase(legacy)) return { ...base, dbDir: target, outcome: 'none' }
  if (hasDatabase(target)) {
    // 两边都有库：旧目录里是迁移前积累的记忆，先继续用它，别让人以为记忆凭空消失。
    return { ...base, dbDir: legacy, outcome: 'kept-both' }
  }
  if (policy === 'conservative') return { ...base, dbDir: legacy, outcome: 'deferred' }

  try {
    // 同盘：目录改名是原子的。目标目录存在但没有库时先挪开（它多半是空壳）。
    if (isEmptyDir(target) && existsSync(target)) rmSync(target, { recursive: true, force: true })
    renameSync(legacy, target)
    return { ...base, dbDir: target, outcome: 'moved' }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EXDEV') {
      return { ...base, dbDir: legacy, outcome: 'failed', detail: error instanceof Error ? error.message : String(error) }
    }
  }

  // 跨盘：先复制到临时目录，核对无误再改名，最后才删旧。
  const staging = `${target}.adopting`
  try {
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(join(staging, '..'), { recursive: true })
    cpSync(legacy, staging, { recursive: true, errorOnExist: true, force: false })
    if (!sameContent(legacy, staging)) {
      throw new Error('copied tree differs from the source (file list or size mismatch)')
    }
    rmSync(target, { recursive: true, force: true })
    renameSync(staging, target)
    rmSync(legacy, { recursive: true, force: true })
    return { ...base, dbDir: target, outcome: 'copied' }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    return {
      ...base,
      dbDir: legacy,
      outcome: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}
