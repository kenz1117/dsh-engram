import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { distillMemories } from '../src/flywheel/distill.ts'
import { openEngramStore } from '../src/store/sqlite.ts'
import type { EngramStore } from '../src/store/interface.ts'

let dir: string
let store: EngramStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'engram-distill-'))
  store = await openEngramStore(join(dir, 'user.db'))
})
afterEach(async () => {
  await store.close()
})

const ROUTE = { provider: 'deepseek', model: 'deepseek-v4-flash' }

describe('distillMemories', () => {
  it('条目不足 2 时直接返回', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '唯一一条' })
    const outcome = await distillMemories({
      store,
      embedder: undefined,
      scope: 'user',
      call: async () => '[]',
      logRequest: () => undefined,
      route: ROUTE,
      signal: new AbortController().signal,
    })
    expect(outcome.distilled).toBe(0)
  })

  it('有效簇合并：新条目 active、旧条目 archived、supersedes 链成立', async () => {
    const a = await store.write({ scope: 'user', kind: 'fact', content: '项目构建用 pnpm', confidence: 0.6 })
    const b = await store.write({ scope: 'user', kind: 'fact', content: '依赖安装用 pnpm 安装', confidence: 0.4 })
    const outcome = await distillMemories({
      store,
      embedder: undefined,
      scope: 'user',
      call: async () => JSON.stringify([
        { content: '项目统一使用 pnpm 管理与安装依赖', kind: 'skill', importance: 0.8, supersedes: [String(a.id), String(b.id)] },
      ]),
      logRequest: () => undefined,
      route: ROUTE,
      signal: new AbortController().signal,
    })
    expect(outcome.distilled).toBe(1)
    expect(outcome.superseded).toBe(2)
    expect((await store.get(a.id))?.status).toBe('archived')
    expect((await store.get(b.id))?.status).toBe('archived')
    const merged = await store.topActive('user', 10)
    expect(merged).toHaveLength(1)
    expect(merged[0]!.content).toBe('项目统一使用 pnpm 管理与安装依赖')
    expect(merged[0]!.kind).toBe('skill')
    // 置信度继承簇内均值 (0.6 + 0.4) / 2
    expect(merged[0]!.confidence).toBeCloseTo(0.5, 5)
  })

  it('supersedes 引用输入集之外的 id 时跳过该组', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '甲条目' })
    await store.write({ scope: 'user', kind: 'fact', content: '乙条目' })
    const outcome = await distillMemories({
      store,
      embedder: undefined,
      scope: 'user',
      call: async () => JSON.stringify([
        { content: '非法合并', kind: 'skill', importance: 0.8, supersedes: ['not-a-real-id'] },
      ]),
      logRequest: () => undefined,
      route: ROUTE,
      signal: new AbortController().signal,
    })
    expect(outcome.distilled).toBe(0)
    expect(outcome.superseded).toBe(0)
    expect(await store.topActive('user', 10)).toHaveLength(2)
  })

  it('LLM 输出不可解析时返回 0 且不抛错', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '甲' })
    await store.write({ scope: 'user', kind: 'fact', content: '乙' })
    const outcome = await distillMemories({
      store,
      embedder: undefined,
      scope: 'user',
      call: async () => '乱输出',
      logRequest: () => undefined,
      route: ROUTE,
      signal: new AbortController().signal,
    })
    expect(outcome.distilled).toBe(0)
    expect(await store.topActive('user', 10)).toHaveLength(2)
  })
})
