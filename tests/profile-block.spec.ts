import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { EngramError } from '../src/types.ts'
import { openEngramStore } from '../src/store/sqlite.ts'
import type { EngramStore } from '../src/store/interface.ts'
import { createEngramTools } from '../src/tools/create.ts'

/** 工具执行的可调用视图：只保留 execute，exec 参数收窄为真实 ToolRunContext。 */
type ExecutableTool = { execute: (args: unknown, exec: ToolRunContext) => Promise<unknown> }

let dir: string
let store: EngramStore
let tools: Map<string, ExecutableTool>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'engram-profile-block-'))
  store = await openEngramStore(join(dir, 'user.db'))
  tools = new Map<string, ExecutableTool>(
    createEngramTools({
      openStore: async () => store,
      resolveProjectStore: async () => store,
      embedder: Promise.resolve(undefined),
      call: undefined,
      routeOverride: undefined,
      queryRewrite: false,
      exportDir: join(dir, 'exports'),
    }).map(tool => [tool.name, tool]),
  )
})
afterEach(async () => {
  await store.close()
})

/** 测试假执行上下文：execute 不读 agent 字段（profile_edit 不碰会话），只给 signal。 */
const fakeExec = {
  agent: { id: 'sess-1', session: { id: 'sess-1', snapshotEvents: () => [] } },
  signal: new AbortController().signal,
} as unknown as ToolRunContext

describe('profile_blocks 存储层', () => {
  it('首次创建产生 v1；后续编辑版本递增', async () => {
    const first = await store.saveProfileBlock('user', undefined, '用户偏好简体中文', 'edit')
    expect(first.version).toBe(1)
    const second = await store.saveProfileBlock('user', first.version, '用户偏好简体中文；时区上海', 'edit')
    expect(second.version).toBe(2)
    const current = await store.getProfileBlock('user')
    expect(current?.content).toBe('用户偏好简体中文；时区上海')
    expect(current?.version).toBe(2)
  })

  it('乐观锁：已有 block 时缺 expectedVersion 或版本不匹配都 VERSION_CONFLICT', async () => {
    const first = await store.saveProfileBlock('user', undefined, 'v1', 'edit')
    await expect(store.saveProfileBlock('user', undefined, '重创建', 'edit'))
      .rejects.toThrowError(EngramError)
    await expect(store.saveProfileBlock('user', first.version + 5, '过期编辑', 'edit'))
      .rejects.toThrowError(EngramError)
    // 冲突后当前态不被污染。
    expect((await store.getProfileBlock('user'))?.content).toBe('v1')
    // 尚无 block 时带 expectedVersion 也冲突。
    await expect(store.saveProfileBlock('project', 1, '无中生有', 'edit')).rejects.toThrowError(EngramError)
  })

  it('空内容 loud 失败', async () => {
    await expect(store.saveProfileBlock('user', undefined, '   ', 'edit')).rejects.toThrowError(EngramError)
  })

  it('版本链只增不改：rollback 追加新版本，历史可查', async () => {
    const v1 = await store.saveProfileBlock('user', undefined, '第一版', 'edit')
    const v2 = await store.saveProfileBlock('user', v1.version, '第二版', 'edit')
    // 回滚到 v1 的内容：作为 v3 追加（source=rollback），历史不改写。
    const restored = await store.saveProfileBlock('user', v2.version, v1.content, 'rollback')
    expect(restored.version).toBe(3)
    expect(restored.content).toBe('第一版')
    const versions = await store.listProfileBlockVersions('user', 10)
    expect(versions.map(version => version.version)).toEqual([3, 2, 1])
    expect(versions.map(version => version.source)).toEqual(['rollback', 'edit', 'edit'])
    // 先 await 再取字段：`await promise()?.content` 会在 await 前对 Promise 取属性，恒为 undefined。
    const v1Row = await store.getProfileBlockVersion('user', 1)
    expect(v1Row?.content).toBe('第一版')
    expect(v1Row?.source).toBe('edit')
    expect(await store.getProfileBlockVersion('user', 99)).toBeUndefined()
  })

  it('scope 隔离：user 与 project 的 block 互不可见', async () => {
    await store.saveProfileBlock('user', undefined, '私人画像', 'edit')
    expect(await store.getProfileBlock('project')).toBeUndefined()
    expect(await store.listProfileBlockVersions('shared', 10)).toEqual([])
  })

  it('purge 清理画像表', async () => {
    await store.saveProfileBlock('user', undefined, '将被清除', 'edit')
    await store.purge()
    expect(await store.getProfileBlock('user')).toBeUndefined()
    expect(await store.listProfileBlockVersions('user', 10)).toEqual([])
  })

  it('schema_version 降到 6 的旧库重开时自动迁移出画像表，旧数据完好', async () => {
    const path = join(dir, 'migrate.db')
    const legacy = await openEngramStore(path)
    await legacy.write({ scope: 'user', kind: 'fact', content: '旧库数据' })
    await legacy.close()
    const { DatabaseSync } = await import('node:sqlite')
    const raw = new DatabaseSync(path)
    raw.prepare("UPDATE meta SET value = '6' WHERE key = 'schema_version'").run()
    raw.close()
    const migrated = await openEngramStore(path)
    try {
      expect(await migrated.topActive('user', 10)).toHaveLength(1)
      // 迁移后画像表可用（从 v1 起步）。
      const block = await migrated.saveProfileBlock('user', undefined, '迁移后创建', 'edit')
      expect(block.version).toBe(1)
    } finally {
      await migrated.close()
    }
  })
})

describe('engram_profile_edit 工具', () => {
  it('view 空态提示创建方式', async () => {
    const result = await tools.get('engram_profile_edit')!.execute({ action: 'view' }, fakeExec) as { text: string }
    expect(result.text).toContain('暂无 curated 画像')
  })

  it('edit 创建 v1 并审计 op_log；再次 edit 走乐观锁', async () => {
    const created = await tools.get('engram_profile_edit')!.execute(
      { action: 'edit', content: '用户偏好简体中文' }, fakeExec) as { text: string }
    expect(created.text).toContain('v1')
    const updated = await tools.get('engram_profile_edit')!.execute(
      { action: 'edit', content: '用户偏好简体中文；拒绝 Emoji', expectedVersion: 1 }, fakeExec) as { text: string }
    expect(updated.text).toContain('v2')
    // 编辑记录入 op_log：op=profile-edit、target_id=scope。
    const ops = await store.recentOps(5)
    const profileOps = ops.filter(op => op.op === 'profile-edit')
    expect(profileOps).toHaveLength(2)
    expect(profileOps[0]!.targetId).toBe('user')
    expect(JSON.parse(profileOps[0]!.detail ?? '{}')).toMatchObject({ action: 'edit', fromVersion: 1, toVersion: 2 })
    // 首次创建的审计行 fromVersion 为 null。
    expect(JSON.parse(profileOps[1]!.detail ?? '{}')).toMatchObject({ action: 'edit', fromVersion: null, toVersion: 1 })
  })

  it('edit 版本冲突 loud 报错', async () => {
    await tools.get('engram_profile_edit')!.execute({ action: 'edit', content: 'v1' }, fakeExec)
    await expect(tools.get('engram_profile_edit')!.execute(
      { action: 'edit', content: '过期编辑', expectedVersion: 7 }, fakeExec)).rejects.toThrow(/冲突/)
  })

  it('rollback 把历史版本内容作为新版本写入并审计 restoredFrom', async () => {
    await tools.get('engram_profile_edit')!.execute({ action: 'edit', content: '第一版' }, fakeExec)
    await tools.get('engram_profile_edit')!.execute({ action: 'edit', content: '第二版', expectedVersion: 1 }, fakeExec)
    const rolled = await tools.get('engram_profile_edit')!.execute(
      { action: 'rollback', toVersion: 1 }, fakeExec) as { text: string }
    expect(rolled.text).toContain('v1')
    expect(rolled.text).toContain('v3')
    expect((await store.getProfileBlock('user'))?.content).toBe('第一版')
    const ops = await store.recentOps(3)
    expect(JSON.parse(ops[0]!.detail ?? '{}')).toMatchObject({ action: 'rollback', fromVersion: 2, toVersion: 3, restoredFrom: 1 })
  })

  it('rollback 目标版本不存在时报错；edit 缺 content 报错', async () => {
    await expect(tools.get('engram_profile_edit')!.execute({ action: 'rollback', toVersion: 9 }, fakeExec))
      .rejects.toThrow(/不存在|尚无/)
    await expect(tools.get('engram_profile_edit')!.execute({ action: 'edit' }, fakeExec))
      .rejects.toThrow(/content/)
  })
})
