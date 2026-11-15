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
    expect(outcome.vectorsWithout).toBe(0)
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
    // Эмбеддера не было — продукт записан без вектора, и дистилляция об этом говорит
    // прямо, а не оставляет человеку гадать, почему база требует ремонта (случай 22.10).
    expect(outcome.vectorsWithout).toBe(1)
    expect(outcome.vectorsAttached).toBe(0)
    expect((await store.get(a.id))?.status).toBe('archived')
    expect((await store.get(b.id))?.status).toBe('archived')
    const merged = await store.topActive('user', 10)
    expect(merged).toHaveLength(1)
    expect(merged[0]!.content).toBe('项目统一使用 pnpm 管理与安装依赖')
    expect(merged[0]!.kind).toBe('skill')
    // 置信度继承簇内均值 (0.6 + 0.4) / 2
    expect(merged[0]!.confidence).toBeCloseTo(0.5, 5)
  })

  it('эмбеддер есть — продукт уходит с вектором, и счёт это подтверждает', async () => {
    const a = await store.write({ scope: 'user', kind: 'fact', content: 'память пишется в sqlite', confidence: 0.6 })
    const b = await store.write({ scope: 'user', kind: 'fact', content: 'векторы считает эмбеддер', confidence: 0.6 })
    const outcome = await distillMemories({
      store,
      // Четыре измерения — своя длина, а не 384: важна не модель, а факт вектора.
      embedder: {
        model: 'test-4',
        embed: async texts => texts.map(() => new Float32Array([0.5, 0.5, 0.5, 0.5])),
        close: async () => undefined,
      },
      scope: 'user',
      call: async () => JSON.stringify([
        { content: 'память и векторы живут вместе', kind: 'skill', importance: 0.7, supersedes: [String(a.id), String(b.id)] },
      ]),
      logRequest: () => undefined,
      route: ROUTE,
      signal: new AbortController().signal,
    })
    expect(outcome.distilled).toBe(1)
    expect(outcome.vectorsAttached).toBe(1)
    expect(outcome.vectorsWithout).toBe(0)
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

/** 与 finishError 的 max-tokens 同形：isMaxTokensError 按 code 识别。 */
const MAX_TOKENS_ERROR = Object.assign(new Error('辅助调用输出达到 maxTokens 上限'), { code: 'LLM_MAX_TOKENS' })

describe('distillMemories 分批与输出预算自愈（#55）', () => {
  const distill = (call: (userText: string) => Promise<string>, logRequests: string[] = []) => distillMemories({
    store,
    embedder: undefined,
    scope: 'user',
    call: params => call(params.userText),
    logRequest: data => { logRequests.push(data.userText) },
    route: ROUTE,
    signal: new AbortController().signal,
  })
  const writeMany = async (count: number) => {
    for (let i = 0; i < count; i += 1) await store.write({ scope: 'user', kind: 'fact', content: `条目${i}` })
  }

  it('取材超过单批上限时分批调用：每批一次辅助调用、日志逐批记录', async () => {
    await writeMany(12) // 10 + 2 → 两批（topActive 新到在前：第一批 条目11..条目2，第二批 条目1、条目0）
    const logRequests: string[] = []
    const outcome = await distill(async () => '[]', logRequests)
    expect(logRequests).toHaveLength(2)
    // 每批的取材列表只含本批条目（LLM 只见过本批 id）。
    const sizes = logRequests.map(text => (text.match(/^\[/gm) ?? []).length)
    expect(sizes).toEqual([10, 2])
    expect(logRequests[0]).not.toContain('条目0')
    expect(logRequests[1]).toContain('条目0')
    // 空数组是合法回答（无可合并簇）：不失败、不计 failed。
    expect(outcome).toMatchObject({ input: 12, distilled: 0, superseded: 0, failed: 0 })
    expect(await store.topActive('user', 20)).toHaveLength(12)
  })

  it('整批输出超预算对半递归重试：两半各自独立调用并照常蒸馏', async () => {
    const a = await store.write({ scope: 'user', kind: 'fact', content: '甲条目' })
    const b = await store.write({ scope: 'user', kind: 'fact', content: '乙条目' })
    let calls = 0
    const outcome = await distill(async userText => {
      calls += 1
      if (calls === 1) throw MAX_TOKENS_ERROR // 整批（2 条）第一次调用超预算
      // 每半只引用自己批内的 id（LLM 只见过本批）。
      const ids = [...userText.matchAll(/\[([0-9a-f-]+)\]/g)].map(match => match[1])
      if (ids.length === 0) return '[]'
      return JSON.stringify([{ content: '合并产物', kind: 'skill', importance: 0.8, supersedes: ids }])
    })
    expect(calls).toBe(3) // 整批 + 两半
    expect(outcome).toMatchObject({ input: 2, distilled: 2, superseded: 2, failed: 0 })
    expect((await store.get(a.id))?.status).toBe('archived')
    expect((await store.get(b.id))?.status).toBe('archived')
  })

  it('对半到单片仍超输出预算：该条计入 failed 并保持 active，不再空烧', async () => {
    await writeMany(2)
    let calls = 0
    const outcome = await distill(async () => {
      calls += 1
      throw MAX_TOKENS_ERROR
    })
    expect(calls).toBe(3) // 整批 + 两个单片
    expect(outcome).toMatchObject({ input: 2, distilled: 0, superseded: 0, failed: 2 })
    expect(await store.topActive('user', 10)).toHaveLength(2)
  })

  it('解析失败只丢该批（整批计入 failed），其余批次照常蒸馏', async () => {
    await writeMany(12) // 第一批 10 条乱输出；第二批 2 条按本批 id 正常合并
    const outcome = await distill(async userText => {
      const ids = [...userText.matchAll(/\[([0-9a-f-]+)\]/g)].map(match => match[1])
      if (ids.length >= 10) return '乱输出'
      return JSON.stringify([{ content: '尾部合并', kind: 'skill', importance: 0.8, supersedes: ids }])
    })
    expect(outcome).toMatchObject({ input: 12, distilled: 1, superseded: 2, failed: 10 })
    expect(await store.topActive('user', 20)).toHaveLength(11)
  })

  it('非输出预算错误原样上抛：整次失败由工具层报给模型', async () => {
    await writeMany(2)
    await expect(distill(async () => { throw new Error('network down') })).rejects.toThrow('network down')
    // 失败的取材未被归档。
    expect(await store.topActive('user', 10)).toHaveLength(2)
  })
})
