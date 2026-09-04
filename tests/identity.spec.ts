import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  legacyProjectDbName, migrateProjectDb, normalizeOriginUrl, resolveProjectIdentity,
} from '../src/project/identity.ts'

const ORIGIN_CONFIG = [
  '[core]',
  '\trepositoryformatversion = 0',
  '[remote "origin"]',
  '\turl = git@github.com:kenz1117/dsh-engram.git',
  '\tfetch = +refs/heads/*:refs/remotes/origin/*',
].join('\n')

/** 造一个带 origin 的普通仓库目录。 */
async function makeRepo(originUrl: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'engram-id-'))
  await mkdir(join(dir, '.git'), { recursive: true })
  await writeFile(join(dir, '.git', 'config'), ORIGIN_CONFIG.replace('git@github.com:kenz1117/dsh-engram.git', originUrl))
  return dir
}

describe('normalizeOriginUrl', () => {
  it('等价类归一化一致：scp / https / 凭证 / 大写 host / 尾缀', () => {
    const expected = 'github.com/kenz1117/dsh-engram'
    expect(normalizeOriginUrl('git@github.com:kenz1117/dsh-engram.git')).toBe(expected)
    expect(normalizeOriginUrl('https://github.com/kenz1117/dsh-engram')).toBe(expected)
    expect(normalizeOriginUrl('https://user:token@github.com/kenz1117/dsh-engram.git')).toBe(expected)
    expect(normalizeOriginUrl('ssh://git@GitHub.com/kenz1117/dsh-engram/')).toBe(expected)
    expect(normalizeOriginUrl('github.com/kenz1117/dsh-engram.git/')).toBe(expected)
  })

  it('不同仓库归一化不同', () => {
    expect(normalizeOriginUrl('https://github.com/a/b')).not.toBe(normalizeOriginUrl('https://github.com/a/c'))
  })

  it('无法解析时返回 undefined', () => {
    expect(normalizeOriginUrl('')).toBeUndefined()
    expect(normalizeOriginUrl('   ')).toBeUndefined()
  })
})

describe('resolveProjectIdentity', () => {
  it('普通仓库：origin 归一化的 sha256 前 24 位命名', async () => {
    const dir = await makeRepo('git@github.com:kenz1117/dsh-engram.git')
    const identity = resolveProjectIdentity(dir)
    expect(identity.source).toBe('origin')
    expect(identity.dbName).toMatch(/^project-[0-9a-f]{24}\.db$/)
    // 同一 origin 的不同 URL 形式得到同一库名。
    const twin = await makeRepo('https://github.com/kenz1117/dsh-engram')
    expect(resolveProjectIdentity(twin).dbName).toBe(identity.dbName)
    // 旧命名保留用于迁移。
    expect(identity.legacyDbName).toBe(legacyProjectDbName(dir))
  })

  it('worktree：.git 文件沿 gitdir + commondir 指针找到主仓库 config', async () => {
    // 主仓库：repo/.git/config 带 origin；worktree：wt/.git 文件指向 repo/.git/worktrees/wt1。
    const repo = await makeRepo('https://github.com/kenz1117/dsh-engram')
    const wtGitdir = join(repo, '.git', 'worktrees', 'wt1')
    await mkdir(wtGitdir, { recursive: true })
    await writeFile(join(wtGitdir, 'commondir'), '../..\n')
    const wt = await mkdtemp(join(tmpdir(), 'engram-wt-'))
    await writeFile(join(wt, '.git'), `gitdir: ${wtGitdir}\n`)
    const identity = resolveProjectIdentity(wt)
    expect(identity.source).toBe('origin')
    expect(identity.dbName).toBe(resolveProjectIdentity(repo).dbName)
  })

  it('无 .git 或 .git 无 origin 时回退 cwd 旧算法', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'engram-nogit-'))
    const identity = resolveProjectIdentity(bare)
    expect(identity.source).toBe('cwd')
    expect(identity.dbName).toBe(legacyProjectDbName(bare))

    const noOrigin = await mkdtemp(join(tmpdir(), 'engram-noorigin-'))
    await mkdir(join(noOrigin, '.git'), { recursive: true })
    await writeFile(join(noOrigin, '.git', 'config'), '[core]\n\tbare = false\n')
    expect(resolveProjectIdentity(noOrigin).source).toBe('cwd')
  })
})

describe('migrateProjectDb', () => {
  it('origin 库不存在且旧库存在 → rename 迁移', async () => {
    const dir = await makeRepo('git@github.com:kenz1117/dsh-engram.git')
    const identity = resolveProjectIdentity(dir)
    const dbDir = await mkdtemp(join(tmpdir(), 'engram-mig-'))
    await writeFile(join(dbDir, identity.legacyDbName), 'old-data')
    expect(migrateProjectDb(dbDir, identity)).toBe('renamed')
    expect(existsSync(join(dbDir, identity.dbName))).toBe(true)
    expect(existsSync(join(dbDir, identity.legacyDbName))).toBe(false)
  })

  it('新旧库并存 → 不动文件', async () => {
    const dir = await makeRepo('git@github.com:kenz1117/dsh-engram.git')
    const identity = resolveProjectIdentity(dir)
    const dbDir = await mkdtemp(join(tmpdir(), 'engram-mig-'))
    await writeFile(join(dbDir, identity.legacyDbName), 'old-data')
    await writeFile(join(dbDir, identity.dbName), 'new-data')
    expect(migrateProjectDb(dbDir, identity)).toBe('kept-both')
    expect(existsSync(join(dbDir, identity.legacyDbName))).toBe(true)
    expect(existsSync(join(dbDir, identity.dbName))).toBe(true)
  })

  it('cwd 兜底标识或两库都不存在 → 无迁移', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'engram-nogit-'))
    const dbDir = await mkdtemp(join(tmpdir(), 'engram-mig-'))
    expect(migrateProjectDb(dbDir, resolveProjectIdentity(bare))).toBe('none')
    const repo = await makeRepo('git@github.com:kenz1117/dsh-engram.git')
    expect(migrateProjectDb(dbDir, resolveProjectIdentity(repo))).toBe('none')
  })
})
