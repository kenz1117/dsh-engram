import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { openEngramStore } from '../src/store/sqlite.ts'
import type { EngramStore } from '../src/store/interface.ts'
import { createEngramTools } from '../src/tools/create.ts'

/** 工具执行的可调用视图：只保留 execute，exec 参数收窄为真实 ToolRunContext。 */
type ExecutableTool = { execute: (args: unknown, exec: ToolRunContext) => Promise<unknown> }

let dir: string
let store: EngramStore
let tools: Map<string, ExecutableTool>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'engram-tools-'))
  store = await openEngramStore(join(dir, 'user.db'))
  tools = new Map<string, ExecutableTool>(
    createEngramTools({ openStore: async () => store, embedder: Promise.resolve(undefined) })
      .map(tool => [tool.name, tool]),
  )
})
afterEach(async () => {
  await store.close()
})

/** 测试假执行上下文：只填 execute 实际读取的字段（agent id、signal）。 */
const fakeExec = { agent: { id: 'sess-1' }, signal: new AbortController().signal } as unknown as ToolRunContext

describe('engram tools', () => {
  it('engram_save 写入并回显来源会话', async () => {
    const result = await tools.get('engram_save')!.execute(
      { content: '用户偏好深色主题', kind: 'preference', importance: 0.7, scope: 'user' }, fakeExec)
    expect((result as { id: string }).id).toBeTruthy()
    const records = await store.topActive(10)
    const saved = records.find(record => record.content === '用户偏好深色主题')
    expect(saved?.sourceSessionId).toBe('sess-1')
    expect(saved?.kind).toBe('preference')
  })

  it('engram_search 返回命中与降级标记', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '部署在 4000 端口' })
    const result = await tools.get('engram_search')!.execute({ query: '端口', scope: 'user' }, fakeExec) as { degraded: boolean; text: string }
    expect(result.degraded).toBe(true)
    expect(result.text).toContain('4000')
    expect(result.text).toContain('id=')
  })

  it('engram_search 无命中时返回无命中文案', async () => {
    const result = await tools.get('engram_search')!.execute({ query: '毫无干系', scope: 'user' }, fakeExec) as { text: string }
    expect(result.text).toBe('无命中')
  })

  it('engram_update 走 supersedes 链', async () => {
    const saved = await store.write({ scope: 'user', kind: 'decision', content: '选 pnpm' })
    const result = await tools.get('engram_update')!.execute(
      { id: saved.id, content: '改用 npm', scope: 'user', kind: 'decision' }, fakeExec) as { id: string; superseded: string }
    expect(result.id).not.toBe(saved.id)
    expect(result.superseded).toBe(saved.id)
  })

  it('engram_update 不存在的 id 报错并提示 scope', async () => {
    await expect(tools.get('engram_update')!.execute(
      { id: 'nope', content: 'x', scope: 'user' }, fakeExec)).rejects.toThrow(/scope/)
  })

  it('engram_forget 后 engram_search 不再命中', async () => {
    const saved = await store.write({ scope: 'user', kind: 'fact', content: '临时令牌 abc123' })
    await tools.get('engram_forget')!.execute({ id: saved.id, scope: 'user' }, fakeExec)
    const result = await tools.get('engram_search')!.execute({ query: '令牌', scope: 'user' }, fakeExec) as { text: string }
    expect(result.text).not.toContain('abc123')
  })

  it('engram_timeline 时间倒序', async () => {
    const a = await store.write({ scope: 'user', kind: 'episode', content: '事件 A 描述' })
    await new Promise(resolve => setTimeout(resolve, 3))
    const b = await store.write({ scope: 'user', kind: 'episode', content: '事件 B 描述' })
    const result = await tools.get('engram_timeline')!.execute({ scope: 'user' }, fakeExec) as { text: string }
    expect(result.text.indexOf(b.id)).toBeLessThan(result.text.indexOf(a.id))
  })

  it('engram_timeline 非法时间 loud 失败', async () => {
    await expect(tools.get('engram_timeline')!.execute({ scope: 'user', since: 'not-a-date' }, fakeExec)).rejects.toThrow(/since/)
  })

  it('嵌入可用时 engram_save 存向量、engram_search 走语义道', async () => {
    // 确定性伪嵌入器：向量 = 内容首字符码点归一化，保证同内容同向量。
    const pseudo = {
      model: 'pseudo',
      embed: async (texts: readonly string[]) => texts.map(text => {
        const vector = new Float32Array(512)
        vector[0] = text.charCodeAt(0) % 128 / 128
        vector[1] = 1
        return vector
      }),
      close: async () => undefined,
    }
    const withEmbedder = new Map<string, ExecutableTool>(
      createEngramTools({ openStore: async () => store, embedder: Promise.resolve(pseudo) })
        .map(tool => [tool.name, tool]),
    )
    await withEmbedder.get('engram_save')!.execute({ content: '记忆甲内容', kind: 'fact', scope: 'user' }, fakeExec)
    const result = await withEmbedder.get('engram_search')!.execute({ query: '记忆甲内容', scope: 'user' }, fakeExec) as { degraded: boolean; text: string }
    expect(result.degraded).toBe(false)
    expect(result.text).toContain('记忆甲内容')
  })

  it('工具集恰为 5 个且名字正确', () => {
    expect([...tools.keys()].sort()).toEqual([
      'engram_forget', 'engram_save', 'engram_search', 'engram_timeline', 'engram_update',
    ])
  })
})
