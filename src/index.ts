/**
 * dsh-engram：DeepSeek Harness 跨会话长期记忆插件（host 半）。
 * 注册 10 个 engram_ 工具、会话开始注入用户画像、自动摄取上一轮对话、
 * 蒸馏/衰减飞轮与审计能力。
 * @module @kenz1117/dsh-engram
 */

import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig } from './config.ts'
import type { EngramConfig, ResolvedEngramConfig } from './config.ts'
import { createLocalEmbedder } from './embedder/local.ts'
import type { EngramEmbedder } from './embedder/interface.ts'
import { FINAL_INGEST_TIMEOUT_MS, ingestFinalTurn, ingestPreviousTurn, replayPendingIngests } from './ingest/hook.ts'
import { runConsolidation } from './consolidation/run.ts'
import type { IngestRequestEventData } from './ingest/hook.ts'
import { parseJsonArray, routeFromEvents, streamText } from './llm/client.ts'
import type { LlmRoute, SessionEventLike } from './llm/client.ts'
import { registerEngramRoutes } from './routes.ts'
import { migrateProjectDb, resolveProjectIdentity } from './project/identity.ts'
import { openEngramStore } from './store/sqlite.ts'
import type { EngramStore } from './store/interface.ts'
import { createEngramTools } from './tools/create.ts'
import { currentUserRequestText, renderMemoryPacket } from './security/sanitize.ts'
import { wrapWithRationale } from './selection-rationale.ts'
import type { EngramScope, Slot } from './types.ts'

/** Cordis 插件名（loader 诊断与注入 source 使用）。 */
export const name = 'dsh-engram'

/** 插件版本（与 package.json 同步，写进备份 _meta.json）。 */
export const VERSION = '0.7.2'

/** 必需服务：工具注册表与 LLM 流式端点（摄取/蒸馏的辅助调用）。 */
export const inject = ['tools', 'llm']

/** Loader 读取的配置校验面（cordis.yml config 字段）。 */
export { Config } from './config.ts'
export type { EngramConfig } from './config.ts'

/** 画像渲染结果：text 为注入文本；overflow 为未获得整行的条目（压缩候选）。 */
export interface ProfileRender {
  readonly text: string
  readonly overflow: readonly { id: string; kind: string; content: string }[]
}

/**
 * 会话开始注入的画像渲染：按重要性降序在 token 预算内整行装填（估算 ceil(len/4)，
 * 超预算的行跳过不截断、继续试更短行）；装不下的条目降级为索引行（#id + 前 40 字），
 * 索引行也装不下的折成末尾 `+N more; use engram_search` 计数行。
 * @param records - 候选条目（调用方已按重要性排序、按条数截断）。
 * @param tokenBudget - 整段画像的 token 预算（含首尾固定行）。
 * @returns 渲染文本与溢出条目（调用方可用辅助 LLM 压缩后重渲染）。
 */
export function renderProfileDetailed(
  records: readonly { id: string; kind: string; content: string; slot?: Slot }[],
  tokenBudget: number,
): ProfileRender {
  const estimate = (text: string): number => Math.ceil(text.length / 4)
  // 主厅：常驻核心记忆层（每次会话都在场），行内带宫殿坐标（房间 #桩位）让 agent 有位置感。
  const header = 'User memory profile (dsh-engram, cross-session) — Grand Hall (always present):'
  const footer = 'Use engram_search to recall details (pass room to search inside one room); use engram_save to persist new facts.'
  let remaining = Math.max(0, tokenBudget - estimate(header) - estimate(footer))
  const lines: string[] = []
  const overflow: { id: string; kind: string; content: string }[] = []
  for (const record of records) {
    const slot = record.slot === undefined ? '' : ` ${record.slot.room}#${record.slot.index}`
    const line = `- [${record.kind}]${slot} ${record.content}`
    const cost = estimate(line)
    if (cost <= remaining) {
      lines.push(line)
      remaining -= cost
    } else {
      overflow.push(record)
    }
  }
  let more = 0
  for (const record of overflow) {
    const line = `- [${record.kind}] #${record.id} ${record.content.slice(0, 40)}…`
    const cost = estimate(line)
    if (cost <= remaining) {
      lines.push(line)
      remaining -= cost
    } else {
      more += 1
    }
  }
  if (more > 0) lines.push(`+${more} more; use engram_search`)
  return { text: [header, ...lines, footer].join('\n'), overflow }
}

/**
 * 会话开始注入的画像渲染（只取文本；溢出明细见 renderProfileDetailed）。
 * @param records - 候选条目（调用方已按重要性排序、按条数截断）。
 * @param tokenBudget - 整段画像的 token 预算（含首尾固定行）。
 * @returns 注入文本。
 */
export function renderProfile(
  records: readonly { id: string; kind: string; content: string }[],
  tokenBudget: number,
): string {
  return renderProfileDetailed(records, tokenBudget).text
}

/** 压缩辅助调用的输出 token 上限（40 字 × 若干条，短输出足够）。 */
const COMPRESS_MAX_TOKENS = 800
/** 压缩辅助调用超时：压缩在 pre-step 关键路径上，必须限时防阻塞首轮请求。 */
const COMPRESS_TIMEOUT_MS = 8000

const COMPRESS_SYSTEM = [
  '把记忆条目压缩为更短的一句话表述（每条不超过 40 个字符），保留可跨会话复用的关键信息（事实、偏好、决策、方法）。',
  '只输出一个 JSON 数组，每项形如 {"id": "原样返回的id", "content": "压缩后表述"}，条目数量与 id 必须与输入一一对应。',
  '不要输出 JSON 以外的任何内容。',
].join('\n')

/**
 * 画像超预算的辅助压缩：把装不下的条目交给辅助 LLM 压短，返回 id → 压缩文本。
 * 任何失败（无路由、输出不可解析、超时、调用异常）返回 undefined，调用方
 * 降级回索引行装填。压缩请求审计到 user 库 op_log（model-visible ⟺ logged：
 * 压缩产物本身会随注入消息进会话日志）。
 */
async function compressProfileOverflow(
  ctx: Context,
  agent: Agent,
  routeOverride: LlmRoute | undefined,
  overflow: readonly { id: string; kind: string; content: string }[],
  signal: AbortSignal,
): Promise<Map<string, string> | undefined> {
  try {
    const events = agent.session.snapshotEvents() as unknown as readonly SessionEventLike[]
    const route = routeOverride ?? routeFromEvents(events)
    if (route === undefined) return undefined
    const userText = JSON.stringify(overflow.map(record => ({ id: record.id, content: record.content })))
    const raw = await streamText(ctx, {
      route,
      system: COMPRESS_SYSTEM,
      userText,
      maxTokens: COMPRESS_MAX_TOKENS,
      purpose: 'engram-compress',
      sessionId: agent.session.id,
      signal: AbortSignal.any([signal, AbortSignal.timeout(COMPRESS_TIMEOUT_MS)]),
    })
    const parsed = parseJsonArray(raw)
    if (parsed === undefined) return undefined
    const ids = new Set(overflow.map(record => record.id))
    const compressed = new Map<string, string>()
    for (const item of parsed) {
      const entry = item as { id?: unknown; content?: unknown }
      if (typeof entry.id !== 'string' || typeof entry.content !== 'string') continue
      // 只接受输入清单里的 id 与非空且确实更短的压缩结果。
      if (!ids.has(entry.id) || entry.content.trim() === '' || entry.content.length >= overflow.find(record => record.id === entry.id)!.content.length) continue
      compressed.set(entry.id, entry.content.trim())
    }
    return compressed.size > 0 ? compressed : undefined
  } catch {
    // 压缩是增强路径：失败一律降级回现有索引行装填。
    return undefined
  }
}

/**
 * agent/pre-step waterfall：每轮第一步注入画像（内容与上次相同则跳过重复注入）；
 * 同时 fire-and-forget 触发上一轮的自动摄取（不阻塞请求）；进程内首次第一步
 * 重放待补做的末轮摄取。必须调用 next() 委托链路；reject 决策原样透传，
 * 记忆库为空或非首轮时不追加消息。
 */
async function preStep(
  ctx: Context,
  openStore: (scope: EngramScope) => Promise<EngramStore>,
  resolved: ResolvedEngramConfig,
  embedder: Promise<EngramEmbedder | undefined>,
  state: { pendingReplayed: boolean; lastProfileAgent: string | null; lastProfileHash: string | null },
  logRequest: (data: IngestRequestEventData) => void,
  { agent, step, turn, signal }: { agent: Agent; step: number; turn: number; signal: AbortSignal },
  next: () => Promise<PreStepDecision>,
): Promise<PreStepDecision> {
  const decision = await next()
  if (decision.kind === 'reject') return decision
  const mode = resolved.ingest
  if (step === 1 && mode !== 'off') {
    // 重放待补做的末轮摄取（上次会话 disposed 失败/超时的 pending 键）。
    if (!state.pendingReplayed) {
      state.pendingReplayed = true
      void replayPendingIngests({
        openStore: () => openStore('user'),
        resolveEvents: makeEventResolver(ctx, agent),
        embedder,
        mode,
        routeOverride: resolved.routeOverride,
        call: params => streamText(ctx, { ...params, sessionId: agent.session.id }),
        logRequest,
        signal,
      }).catch((error: unknown) => {
        console.warn('[dsh-engram] 待补做摄取重放失败（保留 pending，不影响对话）：', error)
      })
    }
    // 自动摄取：新一轮第一步读上一轮日志。异步执行，失败仅告警计数。
    if (turn > 1) {
      void ingestPreviousTurn({
        events: agent.session.snapshotEvents() as unknown as readonly SessionEventLike[],
        sessionId: String(agent.id),
        turn,
        openStore: () => openStore('user'),
        embedder,
        mode,
        routeOverride: resolved.routeOverride,
        call: params => streamText(ctx, { ...params, sessionId: agent.session.id }),
        logRequest,
        signal,
      }).catch((error: unknown) => {
        console.warn('[dsh-engram] 本轮自动摄取失败（已跳过，不影响对话）：', error)
      })
    }
  }
  if (step !== 1) return decision
  const store = await openStore('user')
  const top = await store.topActive('user', resolved.profileTopN)
  if (top.length === 0) return decision
  // 今日待回忆提示（检索练习调度）：有到期条目时在画像末尾附一行，引导 agent 主动自测。
  // user + project 两库合并计数；50 为计数上限（超过显示 50+）。
  const dueTotal = resolved.reviewScheduling
    ? (await Promise.all((['user', 'project'] as const).map(async scope =>
        (await openStore(scope)).dueReviews(Date.now(), 50)))).reduce((sum, rows) => sum + rows.length, 0)
    : 0
  const detailed = renderProfileDetailed(top, resolved.injectTokenBudget)
  let text = detailed.text
  // 超预算压缩：装不下的条目交给辅助 LLM 压短后重渲染；失败保持索引行降级不变。
  if (detailed.overflow.length > 0) {
    const compressed = await compressProfileOverflow(ctx, agent, resolved.routeOverride, detailed.overflow, signal)
    if (compressed !== undefined) {
      // 辅助请求审计（压缩产物随注入消息进会话日志；请求本身落 op_log 供归因）。
      void openStore('user').then(auditStore => auditStore.audit('compress-request', 'AUX', JSON.stringify({ count: detailed.overflow.length }))).catch(() => { /* 审计失败不影响注入 */ })
      text = renderProfileDetailed(
        top.map(record => {
          const shorter = compressed.get(record.id)
          return shorter === undefined ? record : { ...record, content: shorter }
        }),
        resolved.injectTokenBudget,
      ).text
    }
  }
  // 注入去重：同一会话内画像文本与上次相同时跳过（上一轮注入仍在上下文里）；
  // 新会话（lastProfileAgent 不同）必须注入，即使文本与上个会话相同。due 行纳入 hash 输入。
  const dueLine = dueTotal === 0
    ? ''
    : `\nPalace review due today: ${dueTotal}${dueTotal >= 50 ? '+' : ''} memories. Use engram_review_queue for active recall (recall beats re-reading).`
  const textWithRationale = wrapWithRationale(text, top) + dueLine
  const hash = createHash('sha256').update(textWithRationale).digest('hex')
  if (state.lastProfileAgent === String(agent.id) && hash === state.lastProfileHash) return decision
  state.lastProfileAgent = String(agent.id)
  state.lastProfileHash = hash
  // 画像包协议标签：记忆条目是不可信历史上下文；当前请求取本轮 admitted 消息的最后一个文本块。
  const packet = renderMemoryPacket(text, 'turn_start', currentUserRequestText(decision.messages))
  return {
    ...decision,
    messages: [
      ...decision.messages,
      createUserMessage({
        content: [{ type: 'text', text: packet }],
        source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name, text: packet }] },
      }),
    ],
  }
}

/**
 * pending 重放的事件源解析器：pending 属于当前会话时直接用其事件快照；
 * 其余会话经可选的 sessionPersistence 服务读持久化日志（服务缺席或读取失败
 * 返回 undefined，pending 保留到下次，不报错）。
 */
function makeEventResolver(ctx: Context, agent: Agent): (sessionId: string) => Promise<readonly SessionEventLike[] | undefined> {
  return async sessionId => {
    if (sessionId === String(agent.id)) {
      return agent.session.snapshotEvents() as unknown as readonly SessionEventLike[]
    }
    // 可选服务，engram 不硬依赖：缺席时跨会话 pending 保留到该会话被恢复。
    const persistence = ctx.get('sessionPersistence' as never) as
      { load(id: string): Promise<{ events: readonly unknown[] }> } | undefined
    if (persistence === undefined) return undefined
    try {
      const loaded = await persistence.load(sessionId)
      return loaded.events as unknown as readonly SessionEventLike[]
    } catch {
      return undefined
    }
  }
}

/**
 * 插件体：预热分库与嵌入器，注册 10 个工具、画像注入、自动摄取与衰减调度。
 * @param ctx - host 上下文。
 * @param config - cordis.yml 传入的可选配置；非法值在加载时 loud 失败。
 */
export function apply(ctx: Context, config: EngramConfig = {}): void {
  const resolved = resolveConfig(config)
  mkdirSync(resolved.dbDir, { recursive: true, mode: 0o700 })

  // 项目标识：git origin 归一化哈希 → cwd 编码兜底；旧库存在时同目录 rename 迁移。
  const identity = resolveProjectIdentity(process.cwd())
  const migration = migrateProjectDb(resolved.dbDir, identity)
  if (migration === 'renamed') {
    console.warn(`[dsh-engram] 项目记忆库已从 cwd 命名迁移到 git origin 标识：${identity.dbName}`)
  } else if (migration === 'kept-both') {
    console.warn(`[dsh-engram] 检测到新旧两个项目记忆库并存，未合并（保留新库 ${identity.dbName}；旧库 ${identity.legacyDbName} 请人工处理后删除）`)
  }

  // 检索排序 boost 参数：显式 resolve 自配置，注入两个分库。
  const rankBoost = {
    recencyWeight: resolved.rankRecencyWeight,
    proofWeight: resolved.rankProofWeight,
    decayAfterDays: resolved.decayAfterDays,
  }

  // 分库懒打开：user 恒打开；project 库按项目标识命名（同仓库跨会话共享）。
  const stores = new Map<EngramScope, Promise<EngramStore>>()
  const openStore = (scope: EngramScope): Promise<EngramStore> => {
    const existing = stores.get(scope)
    if (existing !== undefined) return existing
    const path = scope === 'user'
      ? join(resolved.dbDir, 'user.db')
      : scope === 'shared'
        ? join(resolved.dbDir, 'shared.db')
        : join(resolved.dbDir, identity.dbName)
    const created = openEngramStore(path, rankBoost, {
      autoSlot: resolved.autoSlot,
      reviewScheduling: resolved.reviewScheduling,
    })
      // 存量排桩：首次打开时幂等补齐（slot_room 为空的 active 条目按 kind 分房、创建时间定序）。
      .then(async store => {
        const assigned = await store.backfillSlots(room => {
          console.warn(`[dsh-engram] 房间已满，自动开新房「${room}」（可在管理面板翻新清单中人工拆分/命名）`)
        })
        if (assigned > 0) console.warn(`[dsh-engram] 存量记忆排桩完成：${assigned} 条已钉入宫殿（${path}）`)
        return store
      })
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
    queryRewrite: resolved.queryRewrite,
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
    registerEngramRoutes(webCtx, {
      openStore,
      exportDir: `${resolved.dbDir}/exports`,
      mirrorDir: `${resolved.dbDir}/palaces`,
      dbDir: resolved.dbDir,
      pluginVersion: VERSION,
      embedder,
    })
  })

  // 辅助请求写 engram 自己的操作日志（下游插件禁止向会话日志写未知事件类型）。
  const logIngestRequest = (data: IngestRequestEventData): void => {
    void openStore('user').then(store => store.audit('ingest-request', 'AUX', JSON.stringify(data))).catch(() => { /* 审计失败不影响摄取 */ })
  }

  if (resolved.injectProfile || resolved.ingest !== 'off') {
    const state = { pendingReplayed: false, lastProfileAgent: null, lastProfileHash: null }
    ctx.on('agent/pre-step', (payload, next) => preStep(ctx, openStore, resolved, embedder, state, logIngestRequest, payload, next), { prepend: true })
  }

  if (resolved.ingest !== 'off') {
    // 末轮摄取闭环：disposed 是 fire-and-forget 观察器（宿主不等待），5 秒超时；
    // 失败/超时由 ingestFinalTurn 落 pending 键，下次会话首次 pre-step 重放补做。
    // 必须挂 .catch：宿主把未处理的 rejection 当致命错误（installFailLoud → process.exit），
    // 而 dispose 时会话事件源可能已 detach——任何逃逸异常都会变成整个 DSH 进程退出。
    ctx.on('session/disposed', (session) => {
      const mode = resolved.ingest
      if (mode === 'off') return
      void ingestFinalTurn({
        events: session.snapshotEvents() as unknown as readonly SessionEventLike[],
        sessionId: String(session.id),
        turn: 0,
        slice: 'last',
        openStore: () => openStore('user'),
        embedder,
        mode,
        routeOverride: resolved.routeOverride,
        call: params => streamText(ctx, { ...params, sessionId: session.id }),
        logRequest: logIngestRequest,
        signal: AbortSignal.timeout(FINAL_INGEST_TIMEOUT_MS),
      }).catch((error: unknown) => {
        console.warn('[dsh-engram] 会话结束的末轮摄取异常（不影响对话）：', error)
      })
    })
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

  // 闭馆整理调度：启动一次 + 每日一次；嵌入不可用时仅归档 + 启发式去重，整理结果写 op_log 'consolidation'。
  const runConsolidateOnce = async (): Promise<void> => {
    try {
      const store = await openStore('user')
      const report = await runConsolidation(store, embedder, {
        olderThanDays: resolved.decayAfterDays,
        importanceBelow: resolved.decayImportanceBelow,
      })
      console.log(`[dsh-engram] 闭馆整理完成：归档 ${String(report.archived)}，合并 ${String(report.merged)}，跳过 ${String(report.skipped)}（${String(report.tookMs)} ms）`)
    } catch (error) {
      console.warn('[dsh-engram] 闭馆整理失败（不影响对话）：', error)
    }
  }
  void runConsolidateOnce()
  ctx.effect(
    () => {
      const timer = setInterval(() => { void runConsolidateOnce() }, 24 * 60 * 60 * 1000)
      return () => { clearInterval(timer) }
    },
    'dsh-engram: consolidation timer',
  )
}
