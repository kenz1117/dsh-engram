/**
 * dsh-engram：DeepSeek Harness 跨会话长期记忆插件（host 半）。
 * 注册 5 个 engram_ 工具，并在会话开始时注入用户级画像摘要。
 * @module @kenz1117/dsh-engram
 */

import { mkdir } from 'node:fs/promises'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig } from './config.ts'
import type { EngramConfig, ResolvedEngramConfig } from './config.ts'
import { createLocalEmbedder } from './embedder/local.ts'
import type { EngramEmbedder } from './embedder/interface.ts'
import { openEngramStore } from './store/sqlite.ts'
import type { EngramStore } from './store/interface.ts'
import { createEngramTools } from './tools/create.ts'
import type { EngramScope } from './types.ts'

/** Cordis 插件名（loader 诊断与注入 source 使用）。 */
export const name = 'dsh-engram'

/** 必需服务：工具注册表。 */
export const inject = ['tools']

/** Loader 读取的配置校验面（cordis.yml config 字段）。 */
export { Config } from './config.ts'
export type { EngramConfig } from './config.ts'

/** 会话开始注入的画像渲染：top-N 高重要性 user 记忆一行一条。 */
export function renderProfile(topN: readonly { kind: string; content: string }[]): string {
  return [
    'User memory profile (dsh-engram, cross-session):',
    ...topN.map(record => `- [${record.kind}] ${record.content}`),
    'Use engram_search to recall details; use engram_save to persist new facts.',
  ].join('\n')
}

/**
 * agent/pre-step waterfall：每轮第一步注入画像。必须调用 next() 委托链路；
 * reject 决策原样透传，记忆库为空或非首轮时不追加消息。
 */
async function preStep(
  openStore: (scope: EngramScope) => Promise<EngramStore>,
  resolved: ResolvedEngramConfig,
  { step }: { agent: Agent; step: number },
  next: () => Promise<PreStepDecision>,
): Promise<PreStepDecision> {
  const decision = await next()
  if (decision.kind === 'reject') return decision
  if (step !== 1) return decision
  const store = await openStore('user')
  const top = await store.topActive('user', resolved.profileTopN)
  if (top.length === 0) return decision
  const text = renderProfile(top)
  return {
    ...decision,
    messages: [
      ...decision.messages,
      createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name, text }] },
      }),
    ],
  }
}

/**
 * 插件体：预热分库与嵌入器，注册工具与画像注入。
 * @param ctx - host 上下文。
 * @param config - cordis.yml 传入的可选配置；非法值在加载时 loud 失败。
 */
export function apply(ctx: Context, config: EngramConfig = {}): void {
  const resolved = resolveConfig(config)
  void mkdir(resolved.dbDir, { recursive: true, mode: 0o700 })

  // 分库懒打开：user 恒打开；project 库按进程工作目录命名（同项目跨会话共享）。
  const projectDbName = `project-${Buffer.from(process.cwd()).toString('hex').slice(0, 24)}.db`
  const stores = new Map<EngramScope, Promise<EngramStore>>()
  const openStore = (scope: EngramScope): Promise<EngramStore> => {
    const existing = stores.get(scope)
    if (existing !== undefined) return existing
    const path = scope === 'user' ? `${resolved.dbDir}/user.db` : `${resolved.dbDir}/${projectDbName}`
    const created = openEngramStore(path)
    stores.set(scope, created)
    return created
  }

  // 嵌入器可选：下载/加载失败不阻塞插件加载，检索降级纯关键词并在结果中标记。
  const embedder: Promise<EngramEmbedder | undefined> = createLocalEmbedder(resolved.modelCacheDir, resolved.hfEndpoint)
    .catch((error: unknown) => {
      console.warn('[dsh-engram] 嵌入器不可用，检索降级为纯关键词模式：', error)
      return undefined
    })
  void embedder

  for (const tool of createEngramTools({ openStore, embedder })) {
    ctx.tools.register(tool)
  }

  if (resolved.injectProfile) {
    ctx.on('agent/pre-step', (payload, next) => preStep(openStore, resolved, payload, next), { prepend: true })
  }
}
