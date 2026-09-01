/**
 * dsh-engram：DeepSeek Harness 跨会话长期记忆插件（host 半）。
 * 注册 9 个 engram_ 工具、会话开始注入用户画像、自动摄取上一轮对话、
 * 蒸馏/衰减飞轮与审计能力。
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
import { ingestPreviousTurn } from './ingest/hook.ts'
import type { IngestRequestEventData } from './ingest/hook.ts'
import { streamText } from './llm/client.ts'
import type { SessionEventLike } from './llm/client.ts'
import { registerEngramRoutes } from './routes.ts'
import { openEngramStore } from './store/sqlite.ts'
import type { EngramStore } from './store/interface.ts'
import { createEngramTools } from './tools/create.ts'
import type { EngramScope } from './types.ts'

/** Cordis 插件名（loader 诊断与注入 source 使用）。 */
export const name = 'dsh-engram'

/** 必需服务：工具注册表与 LLM 流式端点（摄取/蒸馏的辅助调用）。 */
export const inject = ['tools', 'llm']

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
 * agent/pre-step waterfall：每轮第一步注入画像；同时 fire-and-forget 触发
 * 上一轮的自动摄取（不阻塞请求）。必须调用 next() 委托链路；reject 决策
 * 原样透传，记忆库为空或非首轮时不追加消息。
 */
async function preStep(
  ctx: Context,
  openStore: (scope: EngramScope) => Promise<EngramStore>,
  resolved: ResolvedEngramConfig,
  embedder: Promise<EngramEmbedder | undefined>,
  { agent, step, turn, signal }: { agent: Agent; step: number; turn: number; signal: AbortSignal },
  next: () => Promise<PreStepDecision>,
): Promise<PreStepDecision> {
  const decision = await next()
  if (decision.kind === 'reject') return decision
  // 自动摄取：新一轮第一步读上一轮日志。异步执行，失败仅告警计数。
  if (step === 1 && resolved.ingest !== 'off' && turn > 1) {
    void ingestPreviousTurn({
      events: agent.session.events as unknown as readonly SessionEventLike[],
      sessionId: String(agent.id),
      turn,
      openStore: () => openStore('user'),
      embedder,
      mode: resolved.ingest,
      routeOverride: resolved.routeOverride,
      call: params => streamText(ctx, { ...params, sessionId: agent.session.id }),
      // 辅助请求写 engram 自己的操作日志（下游插件禁止向会话日志写未知事件类型）。
      logRequest: (data: IngestRequestEventData) => {
        void openStore('user').then(store => store.audit('ingest-request', 'AUX', JSON.stringify(data))).catch(() => { /* 审计失败不影响摄取 */ })
      },
      signal,
    }).catch((error: unknown) => {
      console.warn('[dsh-engram] 本轮自动摄取失败（已跳过，不影响对话）：', error)
    })
  }
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
 * 插件体：预热分库与嵌入器，注册 9 个工具、画像注入、自动摄取与衰减调度。
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

  for (const tool of createEngramTools({
    openStore,
    embedder,
    call: callParams => streamText(ctx, { ...callParams, sessionId: callParams.sessionId ?? '' }),
    routeOverride: resolved.routeOverride,
    exportDir: `${resolved.dbDir}/exports`,
  })) {
    ctx.tools.register(tool)
  }

  // 管理面板（可选）：webServer 就绪后注册 /engram 页面与 /api/engram/* 接口。
  // 注入子 fiber 在无 webServer 的组合（headless）下保持等待，不阻塞主装载，
  // 工具/画像注入/摄取/衰减等其余能力不受影响。
  ctx.inject(['webServer'], (webCtx) => {
    // 必须用注入回调的子 ctx：ctx.webServer 属性代理拓扑敏感，
    // 外层 ctx 未依赖 webServer 时属性不可用。
    registerEngramRoutes(webCtx, { openStore, exportDir: `${resolved.dbDir}/exports` })
  })

  if (resolved.injectProfile || resolved.ingest !== 'off') {
    ctx.on('agent/pre-step', (payload, next) => preStep(ctx, openStore, resolved, embedder, payload, next), { prepend: true })
  }

  // 衰减调度：启动即跑一次，此后每 24 小时一次；低重要性且长期未访问的条目归档（可恢复）。
  const runDecay = async (): Promise<void> => {
    for (const scope of ['user', 'project'] as const) {
      const archived = await (await openStore(scope)).decay({
        importanceBelow: resolved.decayImportanceBelow,
        olderThanDays: resolved.decayAfterDays,
      })
      if (archived > 0) console.warn(`[dsh-engram] 衰减调度：${scope} 库归档 ${archived} 条低价值记忆（可在 engram_review 查证）`)
    }
  }
  void runDecay().catch((error: unknown) => {
    console.warn('[dsh-engram] 启动衰减调度失败（跳过）：', error)
  })
  ctx.effect(
    () => {
      const timer = setInterval(() => {
        void runDecay().catch((error: unknown) => {
          console.warn('[dsh-engram] 周期衰减调度失败（跳过）：', error)
        })
      }, 24 * 60 * 60 * 1000)
      return () => { clearInterval(timer) }
    },
    'dsh-engram: decay timer',
  )
}
