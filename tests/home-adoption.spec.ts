import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { adoptLegacyDbDir } from '../src/store/home-adoption.ts'

/**
 * 旧数据目录收编（#51）：DSH_HOME 迁移之后，记忆库不能静默分裂成两份。
 */

const temps: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

/** 造一个「有库」的目录：user.db + 一个模型缓存文件。 */
function dirWithDatabase(path: string): string {
  mkdirSync(join(path, 'models'), { recursive: true })
  writeFileSync(join(path, 'user.db'), 'db-bytes')
  writeFileSync(join(path, 'models', 'model.onnx'), 'weights')
  return path
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

describe('旧数据目录收编（#51）', () => {
  it('旧目录有库、目标为空：同盘改名搬走，数据一字不少', () => {
    const root = tempDir('engram-adopt-')
    const legacy = dirWithDatabase(join(root, 'old-engram'))
    const target = join(root, 'new-engram')

    const plan = adoptLegacyDbDir({ target, legacy, policy: 'eager' })

    expect(plan.outcome).toBe('moved')
    expect(plan.dbDir).toBe(target)
    expect(existsSync(legacy)).toBe(false)
    expect(readFileSync(join(target, 'user.db'), 'utf8')).toBe('db-bytes')
    expect(existsSync(join(target, 'models', 'model.onnx'))).toBe(true)
  })

  it('旧目录只有字典与模型、没有 .db：不算「有库」，不搬', () => {
    const root = tempDir('engram-adopt-')
    const legacy = join(root, 'old-engram')
    mkdirSync(join(legacy, 'models'), { recursive: true })
    writeFileSync(join(legacy, 'models', 'model.onnx'), 'weights')
    const target = join(root, 'new-engram')

    const plan = adoptLegacyDbDir({ target, legacy, policy: 'eager' })

    expect(plan.outcome).toBe('none')
    expect(plan.dbDir).toBe(target)
    expect(existsSync(legacy)).toBe(true)
  })

  it('两边都有库：不自动合并，继续用旧目录并报出两个路径', () => {
    const root = tempDir('engram-adopt-')
    const legacy = dirWithDatabase(join(root, 'old-engram'))
    const target = dirWithDatabase(join(root, 'new-engram'))

    const plan = adoptLegacyDbDir({ target, legacy, policy: 'eager' })

    expect(plan.outcome).toBe('kept-both')
    expect(plan.dbDir).toBe(legacy)
    expect(existsSync(legacy)).toBe(true)
    expect(existsSync(target)).toBe(true)
  })

  it('conservative 档：只报不动，继续用旧目录', () => {
    const root = tempDir('engram-adopt-')
    const legacy = dirWithDatabase(join(root, 'old-engram'))
    const target = join(root, 'new-engram')

    const plan = adoptLegacyDbDir({ target, legacy, policy: 'conservative' })

    expect(plan.outcome).toBe('deferred')
    expect(plan.dbDir).toBe(legacy)
    expect(existsSync(legacy)).toBe(true)
    expect(existsSync(target)).toBe(false)
  })

  it('目标目录存在但是空壳：先挪开再改名，旧目录不留残骸', () => {
    const root = tempDir('engram-adopt-')
    const legacy = dirWithDatabase(join(root, 'old-engram'))
    const target = join(root, 'new-engram')
    mkdirSync(target, { recursive: true })

    const plan = adoptLegacyDbDir({ target, legacy, policy: 'eager' })

    expect(plan.outcome).toBe('moved')
    expect(plan.dbDir).toBe(target)
    expect(readFileSync(join(target, 'user.db'), 'utf8')).toBe('db-bytes')
  })

  it('目标就是旧目录：什么都不做', () => {
    const root = tempDir('engram-adopt-')
    const same = dirWithDatabase(join(root, 'engram'))

    const plan = adoptLegacyDbDir({ target: same, legacy: same, policy: 'eager' })

    expect(plan.outcome).toBe('none')
    expect(plan.dbDir).toBe(same)
    expect(existsSync(join(same, 'user.db'))).toBe(true)
  })

  it('旧目录不存在：不需要收编', () => {
    const root = tempDir('engram-adopt-')
    const target = join(root, 'new-engram')

    const plan = adoptLegacyDbDir({ target, legacy: join(root, 'old-engram'), policy: 'eager' })

    expect(plan.outcome).toBe('none')
    expect(plan.dbDir).toBe(target)
  })
})
