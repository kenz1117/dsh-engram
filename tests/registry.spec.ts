import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findProjectPalace, listProjectPalaces, pathTitle } from '../src/project/registry.ts'
import { resolveProjectIdentity } from '../src/project/identity.ts'

const ORIGIN_CONFIG = [
  '[core]',
  '\trepositoryformatversion = 0',
  '[remote "origin"]',
  '\turl = git@github.com:kenz1117/dsh-engram.git',
].join('\n')

/** 造一个带 origin 的仓库目录（同 origin 的目录会映射到同一个项目宫殿）。 */
async function makeRepo(originUrl: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'engram-reg-'))
  await mkdir(join(dir, '.git'), { recursive: true })
  await writeFile(join(dir, '.git', 'config'), `${ORIGIN_CONFIG.replace('git@github.com:kenz1117/dsh-engram.git', originUrl)}\n`)
  return dir
}

describe('pathTitle', () => {
  it('取末段，Win/POSIX 分隔符都认，容忍尾部斜杠', () => {
    expect(pathTitle('G:\\GitWork\\dsh-engram')).toBe('dsh-engram')
    expect(pathTitle('/home/u/proj/')).toBe('proj')
    expect(pathTitle('C:\\')).toBe('C:')
  })
})

describe('listProjectPalaces', () => {
  it('注册表工作区在前、会话 cwd 其次、进程目录兜底', async () => {
    const workspace = await makeRepo('git@github.com:a/b.git')
    const sessionOnly = await mkdtemp(join(tmpdir(), 'engram-reg-sess-'))
    const palaces = listProjectPalaces({
      workspaces: [{ id: 'ws-1', path: workspace, title: '甲项目' }],
      sessionCwds: [sessionOnly],
      processCwd: 'C:\\Users\\Administrator',
    })
    expect(palaces.map(palace => palace.kind)).toEqual(['workspace', 'session', 'process'])
    expect(palaces[0]).toMatchObject({ title: '甲项目', source: 'origin', workspaceId: 'ws-1', path: workspace })
    expect(palaces[1]!.dbName).toBe(resolveProjectIdentity(sessionOnly).dbName)
    expect(palaces[2]!.title).toContain('进程目录')
  })

  it('同一仓库的两个 worktree 共用一个宫殿；进程目录与工作区重合也去重', async () => {
    const workspace = await makeRepo('git@github.com:a/b.git')
    const twin = await makeRepo('https://github.com/a/b')
    const palaces = listProjectPalaces({
      workspaces: [
        { id: 'ws-1', path: workspace, title: '主仓' },
        { id: 'ws-2', path: twin, title: '副本' },
      ],
      sessionCwds: [workspace, twin],
      processCwd: workspace,
    })
    expect(palaces).toHaveLength(1)
    expect(palaces[0]).toMatchObject({ kind: 'workspace', title: '主仓' })
  })

  it('空标题回退目录末段；空路径被跳过', async () => {
    const workspace = await makeRepo('git@github.com:a/b.git')
    const palaces = listProjectPalaces({
      workspaces: [{ id: 'ws-1', path: workspace, title: '' }, { id: 'ws-2', path: '', title: '空' }],
      sessionCwds: [],
      processCwd: 'C:\\tmp',
    })
    expect(palaces[0]!.title).toBe(pathTitle(workspace))
    expect(palaces[0]!.workspaceId).toBe('ws-1')
    expect(palaces.some(palace => palace.workspaceId === 'ws-2')).toBe(false)
  })
})

describe('findProjectPalace', () => {
  it('按 dbName 命中；未知 dbName 返回 undefined（路由据此回 404）', async () => {
    const workspace = await makeRepo('git@github.com:a/b.git')
    const palaces = listProjectPalaces({
      workspaces: [{ id: 'ws-1', path: workspace, title: '甲' }],
      sessionCwds: [],
      processCwd: 'C:\\Users\\Administrator',
    })
    const dbName = resolveProjectIdentity(workspace).dbName
    expect(findProjectPalace(palaces, { dbName })?.title).toBe('甲')
    expect(findProjectPalace(palaces, { dbName: 'project-000000000000000000000000.db' })).toBeUndefined()
  })

  it('按 cwd 命中未知目录时临时合成一个 session 项；不给选择器时回进程兜底', async () => {
    const workspace = await makeRepo('git@github.com:a/b.git')
    const stranger = await mkdtemp(join(tmpdir(), 'engram-reg-stranger-'))
    const palaces = listProjectPalaces({
      workspaces: [{ id: 'ws-1', path: workspace, title: '甲' }],
      sessionCwds: [],
      processCwd: 'C:\\Users\\Administrator',
    })
    const byCwd = findProjectPalace(palaces, { cwd: stranger })
    expect(byCwd).toMatchObject({ kind: 'session', dbName: resolveProjectIdentity(stranger).dbName })
    expect(findProjectPalace(palaces, {})?.kind).toBe('process')
  })
})
