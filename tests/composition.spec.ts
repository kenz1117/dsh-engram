/**
 * REAL-composition coverage：测试用 cordis.yml 经真实 Loader 装载
 * system-prompt + tools + llm 替身 + dsh-engram，断言 9 个 engram_ 工具可见、
 * fiber 卸载后消失（HMR 安全）。替身只用于外部网络（fetch 一律拒绝，嵌入器
 * 立即降级——降级路径本身是被测行为的一部分）与 llm 辅助调用端点。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as Engram from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

beforeEach(() => {
  // 外网一律拒绝：嵌入模型下载立即失败，插件按设计降级为纯关键词检索。
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    throw new Error(`offline in test: ${String(input)}`)
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

/** 四行 cordis.yml（system-prompt + tools + llm 替身 + engram）经真实 Loader 启动。 */
async function loadComposition(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-engram-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
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
  return context
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

  it('未知配置键经 Loader 装载 loud 失败', { timeout: 60_000 }, async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-engram-bad-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
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
