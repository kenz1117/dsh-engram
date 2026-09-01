/**
 * REAL-composition coverage：测试用 cordis.yml 经真实 Loader 装载
 * webserver + system-prompt + tools + llm 替身 + dsh-engram，HTTP 断言
 * 管理页与 /api/engram/* 全链路（列表/统计/修正/遗忘/导出/回环写守卫），
 * 以及 9 个工具注册与 fiber 卸载（HMR 安全）。替身只用于外部网络
 *（fetch 一律拒绝，嵌入器立即降级——降级路径本身是被测行为的一部分）
 * 与 llm 辅助调用端点。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { openEngramStore } from '../src/store/sqlite.ts'
import * as Engram from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

beforeEach(() => {
  // 外网一律拒绝（嵌入模型下载立即失败，插件按设计降级）；本地回环放行给 API 断言用 fetch。
  const realFetch = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.startsWith('http://127.0.0.1')) return realFetch(input, init)
    throw new Error(`offline in test: ${url}`)
  }))
})

afterEach(async () => {
  await context?.fiber?.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllGlobals()
})

/** llm 服务替身：辅助调用端点存在但不可用（摄取/蒸馏运行时失败路径不属于本测试）。 */
const llmDouble = {
  name: 'test-engram-llm',
  apply(ctx: Context): void {
    ctx.provide('llm', {
      stream: async function* () {
        throw new Error('llm offline in test')
      },
    } as never)
  },
}

const EXPECTED_TOOLS = [
  'engram_distill', 'engram_export', 'engram_forget', 'engram_review', 'engram_save',
  'engram_search', 'engram_stats', 'engram_timeline', 'engram_update',
]

/** 在宿主打开分库前写入种子记忆（同进程先后连接，时序安全）。 */
async function seedMemories(dbPath: string): Promise<{ keep: string; dropped: string }> {
  const store = await openEngramStore(dbPath)
  const keep = (await store.write({ scope: 'user', kind: 'preference', content: '种子偏好：回复用简体中文', importance: 0.8 })).id
  const dropped = (await store.write({ scope: 'user', kind: 'fact', content: '种子事实：将被遗忘', importance: 0.5 })).id
  await store.close()
  return { keep, dropped }
}

/** 六行 cordis.yml（webserver + system-prompt + tools + llm 替身 + engram）经真实 Loader 启动。 */
async function loadComposition(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-engram-'))
  const dbPath = join(root, 'engram', 'user.db')
  await seedMemories(dbPath)
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: 'virtual:engram-llm'",
    "- name: '@kenz1117/dsh-engram'",
    '  config:',
    `    dbDir: '${join(root, 'engram')}'`,
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['virtual:engram-llm', llmDouble],
    ['@kenz1117/dsh-engram', Engram],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  // 注入子 fiber（webServer 就绪后注册路由）的完成等待。
  await new Promise(resolve => setTimeout(resolve, 300))
  return context
}

/** GET/POST one engram API path; returns status and the parsed JSON body. */
async function call(port: number, method: 'GET' | 'POST', path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; json: unknown; text: string; contentType: string }> {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } }),
    ...(body === undefined && headers !== undefined ? { headers } : {}),
  })
  const text = await response.text()
  let json: unknown
  try { json = JSON.parse(text) } catch { json = undefined }
  return { status: response.status, json, text, contentType: response.headers.get('content-type') ?? '' }
}

describe('dsh-engram real Loader composition', () => {
  it('装载后 9 个工具可见，engram 行卸载后消失', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const names = () => loaded.tools.schemas().map(schema => schema.name)
    for (const expected of EXPECTED_TOOLS) {
      expect(names()).toContain(expected)
    }

    // HMR 安全：卸载 engram 行后 9 个工具全部释放（tools 服务仍在，其余工具不受影响）。
    const entry = [...loaded.loader.entries()]
      .find(candidate => candidate.options.name === '@kenz1117/dsh-engram')
    expect(entry).toBeDefined()
    await entry!.fiber?.dispose()
    for (const expected of EXPECTED_TOOLS) {
      expect(names()).not.toContain(expected)
    }
  })

  it('管理页与 API 全链路：页面/统计/列表/更新/遗忘/恢复/导出/回环写守卫', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const port = loaded.webServer.port

    // 独立管理页已移除（v0.4.0 起 UI 走设置页 tab）：/engram 不再服务。
    const page = await call(port, 'GET', '/engram')
    expect(page.status).toBe(404)

    // 统计：两库 parts，user 库有种子 2 条。
    const stats = await call(port, 'GET', '/api/engram/stats')
    expect(stats.status).toBe(200)
    const userPart = (stats.json as { parts: { scope: string; stats: { total: number } }[] }).parts
      .find(part => part.scope === 'user')
    expect(userPart?.stats.total).toBe(2)

    // 列表：种子数据可见（管理视图含全部状态）。
    const list = await call(port, 'GET', '/api/engram/list?scope=user&limit=10')
    expect(list.status).toBe(200)
    expect((list.json as { total: number }).total).toBe(2)

    // 更新：走取代链（旧条目 archived、新条目 active）。
    const dropped = (list.json as { records: { id: string; content: string }[] }).records
      .find(record => record.content === '种子事实：将被遗忘')
    expect(dropped).toBeDefined()
    const updated = await call(port, 'POST', '/api/engram/update', {
      id: dropped!.id, scope: 'user', content: '修正后的种子事实', importance: 0.7,
    })
    expect(updated.status).toBe(200)
    const afterUpdate = await call(port, 'GET', '/api/engram/list?scope=user&status=archived')
    expect((afterUpdate.json as { total: number }).total).toBe(1)

    // 遗忘/恢复。
    const forgotten = await call(port, 'POST', '/api/engram/forget', { id: dropped!.id, scope: 'user' })
    expect(forgotten.status).toBe(200)
    const restored = await call(port, 'POST', '/api/engram/restore', { id: dropped!.id, scope: 'user' })
    expect((restored.json as { record: { status: string } }).record.status).toBe('active')

    // 审计视图：来源链与操作日志。
    const review = await call(port, 'GET', `/api/engram/review?scope=user&id=${encodeURIComponent(dropped!.id)}`)
    expect(review.status).toBe(200)
    expect((review.json as { operations: unknown[] }).operations.length).toBeGreaterThan(0)

    // 导出：markdown 下载。
    const exported = await call(port, 'GET', '/api/engram/export?scope=user&format=markdown')
    expect(exported.status).toBe(200)
    expect(exported.contentType).toContain('text/markdown')
    expect(exported.text).toContain('种子偏好')

    // 回环写守卫：跨站 Origin 的 POST 被 403 拒绝。
    const evil = await call(port, 'POST', '/api/engram/forget',
      { id: dropped!.id, scope: 'user' }, { origin: 'https://evil.example' })
    expect(evil.status).toBe(403)
  })

  it('未知配置键经 Loader 装载 loud 失败', { timeout: 60_000 }, async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-engram-bad-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-host-webserver'",
      '  config:',
      "    host: '127.0.0.1'",
      '    port: 0',
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: 'virtual:engram-llm'",
      "- name: '@kenz1117/dsh-engram'",
      '  config:',
      '    noSuchField: 1',
      '',
    ].join('\n'))
    const bad = new Context()
    bad.baseUrl = pathToFileURL(root).href + '/'
    await bad.plugin(Loader)
    bad.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-host-webserver', HttpServer],
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['virtual:engram-llm', llmDouble],
      ['@kenz1117/dsh-engram', Engram],
    ])
    bad.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof bad.loader.internal>
    // loud 失败：未知配置键在 loader.create 阶段同步抛出（fail loud，不静默跳过）。
    await expect(bad.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })).rejects.toThrow(/unknown config key/)
  })
})
