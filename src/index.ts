/**
 * dsh-engram：DeepSeek Harness 跨会话长期记忆插件（host 半）。
 * 注册 18 个 engram_ 工具、会话开始注入画像（curated block 优先于派生画像）、
 * 自动摄取上一轮对话、蒸馏/衰减飞轮与审计能力。
 * @module @kenz1117/dsh-engram
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig } from './config.ts'
import type { EngramConfig, ResolvedEngramConfig } from './config.ts'
import { createLocalEmbedder } from './embedder/local.ts'
import type { EngramEmbedder } from './embedder/interface.ts'
import { FINAL_INGEST_TIMEOUT_MS, ensureSessionSummary, ingestFinalTurn, ingestPreviousTurn, ingestWriteRouting, lastTurnNumber, replayPendingIngests } from './ingest/hook.ts'
import { estimateHistoryBackfill, runHistoryBackfill } from './ingest/history.ts'
import type {
  HistoryBackfillDeps, HistoryBackfillRules, HistoryEstimate, HistoryLogSource, HistoryRunProgress, HistoryRunResult,
  HistorySessionHeader,
} from './ingest/history.ts'
import { runConsolidation } from './consolidation/run.ts'
import type { IngestRequestEventData } from './ingest/hook.ts'
import { parseJsonArray, routeFromEvents, streamText } from './llm/client.ts'
import type { LlmRoute, SessionEventLike } from './llm/client.ts'
import { registerEngramRoutes } from './routes.ts'
import type { ProjectPalaceView, RouteDeps } from './routes.ts'
import { migrateProjectDb, migrationWarning, resolveProjectIdentity } from './project/identity.ts'
import { findProjectPalace, listProjectPalaces } from './project/registry.ts'
import type { ProjectPalace, WorkspaceRef } from './project/registry.ts'
import { openEngramStore } from './store/sqlite.ts'
import type { EngramStore } from './store/interface.ts'
import { createEngramTools } from './tools/create.ts'
import { resolveJevField } from './jev/runtime.ts'
import { currentUserRequestText, renderMemoryPacket } from './security/sanitize.ts'
import { wrapWithRationale } from './selection-rationale.ts'
import { buildAssessReminder, evidenceBatches } from './retrieve/evidence.ts'
import { estimateTokens } from './token.ts'
import type { EngramScope, Slot } from './types.ts'

/** Cordis 插件名（loader 诊断与注入 source 使用）。 */
export const name = 'dsh-engram'

/** 插件版本（与 package.json 同步，写进备份 _meta.json）。 */
export const VERSION = '0.7.6'

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

/** 分级递减的单条正文预算：第 i 条预算 = max(floor, round(start × decay^i))。 */
export interface GraduatedItemBudget {
  /** 首条正文字符预算。 */
  readonly start: number
  /** 逐条递减系数。 */
  readonly decay: number
  /** 下限字符预算。 */
  readonly floor: number
}

/** 分级递减预算默认值（配置缺省时由 resolveConfig 显式落地，同值于此）。 */
export const DEFAULT_ITEM_BUDGET: GraduatedItemBudget = { start: 160, decay: 0.9, floor: 24 }

/**
 * 会话开始注入的画像渲染：按重要性降序装填，单条正文按分级递减预算截断
 * （首条 160 字、逐条 ×0.9、下限 24 字——排名越靠后单条越短，平滑降级替代
 * 整条降级索引行）；token 预算（估算见 estimateTokens：中文按 1.5 token/字、
 * 其余按 4 字符/token）是外层硬约束：截断后仍装不下的条目先以 40 字索引行
 * 兜底，索引行也装不下的折成末尾 `+N more; use engram_search` 计数行；计数行同样占用预算。
 * @param records - 候选条目（调用方已按重要性排序、按条数截断）。
 * @param tokenBudget - 整段画像的 token 预算（含首尾固定行）。
 * @param itemBudget - 分级递减的单条正文预算（缺省用 DEFAULT_ITEM_BUDGET；配置面在 resolveConfig）。
 * @returns 渲染文本与溢出条目（调用方可用辅助 LLM 压缩后重渲染）。
 */
export function renderProfileDetailed(
  records: readonly { id: string; kind: string; content: string; slot?: Slot }[],
  tokenBudget: number,
  itemBudget: GraduatedItemBudget = DEFAULT_ITEM_BUDGET,
): ProfileRender {
  const estimate = estimateTokens
  // 主厅：常驻核心记忆层（每次会话都在场），行内带宫殿坐标（房间 #桩位）让 agent 有位置感。
  const header = 'User memory profile (dsh-engram, cross-session) — Grand Hall (always present):'
  const footer = 'Use engram_search to recall details (pass room to search inside one room); use engram_save to persist new facts.'
  let remaining = Math.max(0, tokenBudget - estimate(header) - estimate(footer))
  const lines: string[] = []
  const overflow: { id: string; kind: string; content: string }[] = []
  records.forEach((record, index) => {
    // 分级递减：第 i 条正文预算 = max(floor, start × decay^i)，超长截断（保留条目数优先于单条完整度）。
    const budget = Math.max(itemBudget.floor, Math.round(itemBudget.start * itemBudget.decay ** index))
    const content = record.content.length > budget ? `${record.content.slice(0, budget)}…` : record.content
    const slot = record.slot === undefined ? '' : ` ${record.slot.room}#${record.slot.index}`
    const line = `- [${record.kind}]${slot} ${content}`
    const cost = estimate(line)
    if (cost <= remaining) {
      lines.push(line)
      remaining -= cost
    } else {
      overflow.push(record)
    }
  })
  let more = 0
  // 末尾计数行同样占预算：先按最大位数预留再装索引行，否则补行后总量会超出预算。
  // 预算小到连预留都放不下时（remaining 转负）不输出计数行，保证总量不超承诺。
  remaining -= overflow.length === 0 ? 0 : estimate(`+${overflow.length} more; use engram_search`)
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
  if (more > 0 && remaining >= 0) lines.push(`+${more} more; use engram_search`)
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

/** curated block 段的标题行（模型据此知道这一段是人工维护的最高优先画像）。 */
export const CURATED_HEADER =
  'Curated profile (user-maintained via engram_profile_edit; authoritative over derived facts):'

/**
 * 画像渲染（curated 优先）：有 curated block 时其全文置于派生画像之前（模型可见的
 * 第一段），并先从 token 预算中扣除自身占用，剩余预算才给派生条目装填；派生段
 * 照旧走分级递减与索引行/计数行降级。curated 是用户显式维护的意志，即使超出剩余
 * 预算也完整注入（与 due 行同理）；block 缺省时等同 renderProfileDetailed。
 * @param curated - 当前态 curated block；undefined = 尚未编辑过。
 * @param records - 派生画像候选条目（调用方已按重要性排序、按条数截断）。
 * @param tokenBudget - 整段画像的 token 预算（curated 段与派生段共享）。
 * @param itemBudget - 分级递减的单条正文预算（透传 renderProfileDetailed）。
 * @returns 渲染文本与派生段的溢出条目。
 */
export function renderProfileWithCurated(
  curated: { content: string } | undefined,
  records: readonly { id: string; kind: string; content: string; slot?: Slot }[],
  tokenBudget: number,
  itemBudget: GraduatedItemBudget = DEFAULT_ITEM_BUDGET,
): ProfileRender {
  if (curated === undefined) return renderProfileDetailed(records, tokenBudget, itemBudget)
  const curatedSection = `${CURATED_HEADER}\n${curated.content}`
  const detailed = renderProfileDetailed(records, Math.max(0, tokenBudget - estimateTokens(curatedSection)), itemBudget)
  return { text: `${curatedSection}\n${detailed.text}`, overflow: detailed.overflow }
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
  openStoreForProjectCwd: (cwd: string) => Promise<EngramStore>,
  resolved: ResolvedEngramConfig,
  embedder: Promise<EngramEmbedder | undefined>,
  state: { pendingReplayed: boolean; lastProfileAgent: string | null; lastProfileHash: string | null; lastAssessReminder: string | null; route: LlmRoute | undefined },
  logRequest: (data: IngestRequestEventData) => void,
  { agent, step, turn, signal }: { agent: Agent; step: number; turn: number; signal: AbortSignal },
  next: () => Promise<PreStepDecision>,
): Promise<PreStepDecision> {
  const decision = await next()
  if (decision.kind === 'reject') return decision
  // 记录当前会话在用的路由：历史回填优先复用它——历史日志里的 provider/model 是当年的，
  // 在当前环境可能已不可用（如换过提供商），用当前模型才跑得通。
  if (step === 1) {
    const currentRoute = resolved.routeOverride ?? routeFromEvents(agent.session.snapshotEvents() as unknown as readonly SessionEventLike[])
    if (currentRoute !== undefined) state.route = currentRoute
  }
  const mode = resolved.ingest
  // 写入路由：本会话有 cwd 时默认进项目宫殿、逐条采纳模型的 scope 判定；无 cwd 只能进私人宫殿。
  const routing = ingestWriteRouting(sessionCwd(agent.session), openStoreForProjectCwd, openStore)
  if (step === 1 && mode !== 'off') {
    // 重放待补做的末轮摄取（上次会话 disposed 失败/超时的 pending 键）。
    if (!state.pendingReplayed) {
      state.pendingReplayed = true
      void replayPendingIngests({
        openStore: () => openStore('user'),
        resolveSession: makeSessionResolver(ctx, agent),
        resolveStore: openStoreForProjectCwd,
        embedder,
        mode,
        routeOverride: resolved.routeOverride,
        ...resolveJevField(resolved.jev, resolved.dbDir),
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
        openAuditStore: () => openStore('user'),
        ...routing,
        embedder,
        mode,
        routeOverride: resolved.routeOverride,
        ...resolveJevField(resolved.jev, resolved.dbDir),
        call: params => streamText(ctx, { ...params, sessionId: agent.session.id }),
        logRequest,
        signal,
      }).catch((error: unknown) => {
        console.warn('[dsh-engram] 本轮自动摄取失败（已跳过，不影响对话）：', error)
      })
    }
  }
  if (step !== 1 && resolved.assessReminder) {
    // 证据门收尾提醒：本会话存在未判定批次时在下一步开始前提醒（插件层注入，
    // 不动 agent-loop）；同一文本不重复注入，判定完成或批次清空后自然停发。
    const sessionId = String(agent.session.id)
    const pending = evidenceBatches.pendingBatches(sessionId).length
    const reminder = buildAssessReminder(pending, evidenceBatches.insufficientStreak(sessionId))
    if (reminder !== undefined && reminder !== state.lastAssessReminder) {
      state.lastAssessReminder = reminder
      return {
        ...decision,
        messages: [
          ...decision.messages,
          createUserMessage({
            content: [{ type: 'text', text: reminder }],
            source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name, text: reminder }] },
          }),
        ],
      }
    }
  }
  if (step !== 1) return decision
  const store = await openStore('user')
  // curated block：engram_profile_edit 维护的画像段，优先于自动派生画像注入。
  const curated = await store.getProfileBlock('user')
  const top = await store.topActive('user', resolved.profileTopN)
  if (top.length === 0 && curated === undefined) return decision
  // 今日待回忆提示（检索练习调度）：有到期条目时在画像末尾附一行，引导 agent 主动自测。
  // user + project 两库合并计数；50 为计数上限（超过显示 50+）。
  const dueTotal = resolved.reviewScheduling
    ? (await Promise.all((['user', 'project'] as const).map(async scope =>
        (await openStore(scope)).dueReviews(Date.now(), 50)))).reduce((sum, rows) => sum + rows.length, 0)
    : 0
  const detailed = renderProfileWithCurated(
    curated,
    top,
    resolved.injectTokenBudget,
    { start: resolved.injectItemBudgetStart, decay: resolved.injectItemBudgetDecay, floor: resolved.injectItemBudgetFloor },
  )
  let text = detailed.text
  // 超预算压缩：装不下的条目交给辅助 LLM 压短后重渲染；失败保持索引行降级不变。
  if (detailed.overflow.length > 0) {
    const compressed = await compressProfileOverflow(ctx, agent, resolved.routeOverride, detailed.overflow, signal)
    if (compressed !== undefined) {
      // 辅助请求审计（压缩产物随注入消息进会话日志；请求本身落 op_log 供归因）。
      void openStore('user').then(auditStore => auditStore.audit('compress-request', 'AUX', JSON.stringify({ count: detailed.overflow.length }))).catch(() => { /* 审计失败不影响注入 */ })
      text = renderProfileWithCurated(
        curated,
        top.map(record => {
          const shorter = compressed.get(record.id)
          return shorter === undefined ? record : { ...record, content: shorter }
        }),
        resolved.injectTokenBudget,
        { start: resolved.injectItemBudgetStart, decay: resolved.injectItemBudgetDecay, floor: resolved.injectItemBudgetFloor },
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
 * 会话持久化服务的窄视图：新版 dsh 只有句柄式 `open`/`read`（`load(id)` 已移除），
 * 且 `list()` 返回快照（header 在 `snapshot.header` 上）而非 header 数组。
 * 本插件不硬依赖 @deepseek-ai/dsh-session-persistence，只按运行时形状取用。
 */
interface PersistenceReadHandle {
  /** 读取一段连续日志；缺省参数 = 从 0 读到末尾。 */
  read(offset?: number, length?: number): Promise<{ events: readonly unknown[] }>
  /** 会话 header（真实句柄必给；测试替身可能省略）——取 cwd 决定补做轮次写进哪座项目宫殿。 */
  readonly header?: { readonly cwd?: string | undefined } | undefined
  /** 释放句柄（幂等；不释放会在后端持有本地资源）。 */
  close(): Promise<void>
}

/** 持久化服务的最小视图（只用到 list 与只读 open）。 */
interface PersistenceServiceView {
  /** 列出全部已持久化会话的快照（宿主接口不分页不过滤）。 */
  list(options?: { signal?: AbortSignal }): Promise<readonly { header: HistorySessionHeader }[]>
  /** 只读打开一个已持久化会话；不取写所有权，可与活跃写入者并存。 */
  open(id: string, access: 'read'): Promise<PersistenceReadHandle>
}

/**
 * 会话工作目录（决定它的记忆进哪座项目宫殿）。
 * 真实 `Session.header` 恒在；测试替身可能省略 header，故按可选形状读取。
 * @param session - 会话（或替身）对象。
 * @returns cwd；取不到时 undefined（该会话的回退口径是私人宫殿）。
 */
function sessionCwd(session: { readonly header?: { readonly cwd?: string | undefined } | undefined } | undefined): string | undefined {
  const cwd = session?.header?.cwd
  return cwd === undefined || cwd === '' ? undefined : cwd
}

/**
 * 只读打开会话日志 → 交给调用方读取 → 必关闭句柄。
 * close 失败不掩盖读取结果（读取成功而 close 失败时仍返回成功值）。
 * @param persistence - 持久化服务视图。
 * @param sessionId - 目标会话 id。
 * @param use - 句柄使用回调。
 * @returns 回调结果。
 */
async function withReadHandle<T>(
  persistence: PersistenceServiceView,
  sessionId: string,
  use: (handle: PersistenceReadHandle) => Promise<T>,
): Promise<T> {
  const handle = await persistence.open(sessionId, 'read')
  try {
    return await use(handle)
  } finally {
    await handle.close().catch(() => { /* 关闭失败无补救动作 */ })
  }
}

/**
 * pending 重放的会话解析器：pending 属于当前会话时直接用其事件快照与 cwd；
 * 其余会话经可选的 sessionPersistence 服务（只读句柄）读持久化日志与 header.cwd
 * （服务缺席或读取失败返回 undefined，pending 保留到下次，不报错）。
 */
function makeSessionResolver(
  ctx: Context,
  agent: Agent,
): (sessionId: string) => Promise<{ events: readonly SessionEventLike[]; cwd?: string | undefined } | undefined> {
  return async sessionId => {
    if (sessionId === String(agent.id)) {
      return {
        events: agent.session.snapshotEvents() as unknown as readonly SessionEventLike[],
        cwd: sessionCwd(agent.session),
      }
    }
    // 可选服务，engram 不硬依赖：缺席时跨会话 pending 保留到该会话被恢复。
    const persistence = ctx.get('sessionPersistence' as never) as PersistenceServiceView | undefined
    if (persistence === undefined) return undefined
    try {
      return await withReadHandle(persistence, sessionId, async handle => ({
        events: (await handle.read()).events as readonly SessionEventLike[],
        cwd: sessionCwd(handle),
      }))
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

  // 项目标识：git origin 归一化哈希 → 完整 cwd 哈希；按配置检查旧库迁移。
  const identity = resolveProjectIdentity(process.cwd())
  const migration = migrateProjectDb(resolved.dbDir, identity, resolved.legacyMigration)
  const warning = migrationWarning(resolved.dbDir, identity, migration)
  if (warning !== undefined) console.warn(warning)

  // 检索排序 boost 参数：显式 resolve 自配置，注入两个分库。
  const rankBoost = {
    recencyWeight: resolved.rankRecencyWeight,
    proofWeight: resolved.rankProofWeight,
    decayAfterDays: resolved.decayAfterDays,
  }

  // 分库懒打开：按分库文件名缓存连接（user / shared / project-<hash>；项目库按标识命名，同仓库跨会话共享）。
  const stores = new Map<string, Promise<EngramStore>>()

  /** 打开（或复用）一个分库文件；首次打开时幂等补齐存量排桩。 */
  const openDb = (dbName: string): Promise<EngramStore> => {
    const existing = stores.get(dbName)
    if (existing !== undefined) return existing
    const path = join(resolved.dbDir, dbName)
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
    stores.set(dbName, created)
    return created
  }

  const openStore = (scope: EngramScope): Promise<EngramStore> => openDb(
    scope === 'user' ? 'user.db' : scope === 'shared' ? 'shared.db' : identity.dbName,
  )

  // 卸载/重启时关闭已打开的分库连接：不关会在 Windows 上锁住 .db 文件
  // （插件卸载后目录删不掉、备份/迁移也可能失败）。disposer 返回 promise，宿主会等它完成。
  ctx.effect(() => () => Promise.allSettled(
    [...stores.values()].map(async pending => {
      try {
        await (await pending).close()
      } catch {
        // 关闭失败无补救动作（连接会随进程退出释放）。
      }
    }),
  ), 'dsh-engram: close stores')

  /** cwd → 分库文件名（历史回填会对每个历史 cwd 解析一次，避免重复读 git 元数据）。 */
  const cwdDbNames = new Map<string, string>()
  /**
   * 按任意 cwd 的项目标识打开分库（历史回填专用）：历史会话写进它自己项目的库，
   * 而不是当前工作目录的库——否则跨项目内容会串库。
   * @param cwd - 历史会话 header 里记录的 cwd。
   * @returns 该 cwd 对应项目分库的连接。
   */
  /** cwd → 分库文件名（缓存，避免重复读 git 元数据与重复迁移检查）。 */
  const dbNameForCwd = (cwd: string): string => {
    const cached = cwdDbNames.get(cwd)
    if (cached !== undefined) return cached
    const projectIdentity = resolveProjectIdentity(cwd)
    // 会话 cwd 同样应用旧库迁移策略；结果与告警按 cwd 缓存。
    const migration = migrateProjectDb(resolved.dbDir, projectIdentity, resolved.legacyMigration)
    const warning = migrationWarning(resolved.dbDir, projectIdentity, migration)
    if (warning !== undefined) console.warn(warning)
    cwdDbNames.set(cwd, projectIdentity.dbName)
    return projectIdentity.dbName
  }

  const openStoreForProjectCwd = (cwd: string): Promise<EngramStore> => openDb(dbNameForCwd(cwd))

  /**
   * 工具调用期的项目分库解析：按会话 cwd 归属（缺省回退插件进程目录）。
   * 面板「项目」scope、工具读写与自动摄取的 project 落点因此同一口径。
   */
  const resolveProjectStore = (cwd: string | undefined): Promise<EngramStore> =>
    cwd === undefined ? openStore('project') : openStoreForProjectCwd(cwd)

  // 嵌入器可选：下载/加载失败不阻塞插件加载，检索降级纯关键词并在结果中标记。
  const embedder: Promise<EngramEmbedder | undefined> = createLocalEmbedder(resolved.modelCacheDir, resolved.hfEndpoint)
    .catch((error: unknown) => {
      console.warn('[dsh-engram] 嵌入器不可用，检索降级为纯关键词模式：', error)
      return undefined
    })
  void embedder

  // 辅助请求写 engram 自己的操作日志（下游插件禁止向会话日志写未知事件类型）。
  const logIngestRequest = (data: IngestRequestEventData): void => {
    void openStore('user').then(store => store.audit('ingest-request', 'AUX', JSON.stringify(data))).catch(() => { /* 审计失败不影响摄取 */ })
  }

  // preStep 的可变状态：route 记录当前会话在用的路由，历史回填优先复用它。
  const preStepState: {
    pendingReplayed: boolean
    lastProfileAgent: string | null
    lastProfileHash: string | null
    lastAssessReminder: string | null
    route: LlmRoute | undefined
  } = { pendingReplayed: false, lastProfileAgent: null, lastProfileHash: null, lastAssessReminder: null, route: undefined }

  // ---- 历史会话回填：把 dsh 持久化的历史会话逐轮摄取进宫殿（面板「历史回填」tab / engram_ingest_history）----
  /** 会话持久化服务（可选；缺席时历史回填不可用）。 */
  const persistenceService = (): HistoryLogSource | undefined => {
    const persistence = ctx.get('sessionPersistence' as never) as PersistenceServiceView | undefined
    if (persistence === undefined) return undefined
    return {
      // header 现在嵌在快照里，取消参数也从位置参数改为 { signal }（无信号时不传该键）。
      list: async signal => (await persistence.list(signal === undefined ? undefined : { signal })).map(snapshot => snapshot.header),
      // 日志经只读句柄读取（打开 → 读完 → 必关闭）；读取失败原样抛出，调用方计 unreadable。
      load: id => withReadHandle(persistence, id, async handle => ({ events: (await handle.read()).events })),
    }
  }

  /** user 分库若已存在则打开（估算用：不因估算产生空库文件）。 */
  const openUserStoreIfExists = (): Promise<EngramStore | undefined> =>
    existsSync(join(resolved.dbDir, 'user.db')) ? openStore('user') : Promise.resolve(undefined)

  // ---- 项目宫殿清单：面板「项目」scope 随 GUI 工作区切换与显示（host 半数据源）----
  /** 宿主机工作区注册表（可选服务：缺席时降级为「会话 cwd + 进程目录」两级清单）。 */
  const workspaceRefs = (): WorkspaceRef[] => {
    const registry = ctx.get('workspaceRegistry' as never) as
      | { list(): readonly { id: unknown; path: unknown; title: unknown }[] }
      | undefined
    if (registry === undefined) return []
    try {
      return registry.list()
        .filter(workspace => typeof workspace.path === 'string' && workspace.path !== '')
        .map(workspace => ({
          id: String(workspace.id),
          path: workspace.path as string,
          title: typeof workspace.title === 'string' ? workspace.title : '',
        }))
    } catch {
      // 注册表不可用（未初始化/实现变更）：按无注册表降级，不影响面板其余功能。
      return []
    }
  }

  /** 只按会话 cwd 认领的分库上限（按会话新旧取最近的若干，避免历史 cwd 把清单撑爆）。 */
  const SESSION_CWD_PALACE_LIMIT = 30

  /**
   * 会话 header 里出现过的 cwd：历史回填建的库也能在面板里被认领。
   * 按会话创建时间倒序取最近的 N 个（新的在前，去重后截断）。
   */
  const sessionCwds = async (): Promise<string[]> => {
    const source = persistenceService()
    if (source === undefined) return []
    try {
      const headers = await source.list()
      const ordered = [...headers].sort((a, b) => b.createdAt - a.createdAt)
      const cwds: string[] = []
      const seen = new Set<string>()
      for (const header of ordered) {
        const cwd = header.cwd
        if (cwd === undefined || cwd === '' || seen.has(cwd)) continue
        seen.add(cwd)
        cwds.push(cwd)
        if (cwds.length >= SESSION_CWD_PALACE_LIMIT) break
      }
      return cwds
    } catch {
      return []
    }
  }

  /** 项目宫殿清单（现算、零状态）：注册表工作区 → 会话 cwd → 进程目录兜底，按分库名去重。 */
  const projectPalaces = async (): Promise<ProjectPalace[]> =>
    listProjectPalaces({ workspaces: workspaceRefs(), sessionCwds: await sessionCwds(), processCwd: process.cwd() })

  /** 面板视图：补 exists 与 active 计数（库文件不存在时不打开，避免为工作区建空库）。 */
  const palaceView = async (palace: ProjectPalace): Promise<ProjectPalaceView> => {
    const exists = existsSync(join(resolved.dbDir, palace.dbName))
    let memories: number | null = null
    if (exists) {
      try {
        memories = (await (await openDb(palace.dbName)).stats()).active
      } catch {
        memories = null
      }
    }
    return {
      dbName: palace.dbName,
      title: palace.title,
      path: palace.path ?? null,
      kind: palace.kind,
      source: palace.source,
      workspaceId: palace.workspaceId ?? null,
      exists,
      memories,
    }
  }

  const projectsDeps: RouteDeps['projects'] = {
    list: async () => Promise.all((await projectPalaces()).map(async palace => palaceView(palace))),
    open: async selector => {
      const palaces = await projectPalaces()
      const palace = selector === undefined
        ? findProjectPalace(palaces, {})
        : palaces.find(candidate => candidate.dbName === selector)
      if (palace === undefined) return undefined
      return { store: await openDb(palace.dbName), project: await palaceView(palace) }
    },
  }

  /** 组装历史回填依赖；source 每次现取，兼容持久化服务在插件之后挂载的组合。 */
  const buildHistoryDeps = (): HistoryBackfillDeps => ({
    source: persistenceService(),
    resolveStore: openStoreForProjectCwd,
    openUserStore: () => openStore('user'),
    resolveExistingUserStore: openUserStoreIfExists,
    embedder,
    // 回填必须走提炼管线：ingest=off 的部署也允许手工回填，按最省的 light 档提炼。
    mode: resolved.ingest === 'off' ? 'light' : resolved.ingest,
    // 优先用当前可用路由（配置覆盖 > 当前会话在用的模型）——历史日志里的旧 provider/model 可能已不可用。
    routeOverride: resolved.routeOverride ?? preStepState.route,
    // 辅助调用归属：审计经 logRequest 带会话 id 落 op_log，streamText 只需一个稳定标识。
    call: callParams => streamText(ctx, { ...callParams, sessionId: '' }),
    logRequest: logIngestRequest,
    // 面板覆盖免缓存装配：每次回填运行时读 jev-config.json，面板保存立即生效。
    ...resolveJevField(resolved.jev, resolved.dbDir),
  })

  /** 回填任务（进程内单例；面板轮询它的进度，工具同步等待自己的那一次运行）。 */
  let backfillJob:
    | { controller: AbortController; progress: HistoryRunProgress; failures: HistoryRunResult['failures']; error?: string }
    | undefined

  /** 历史回填对外接口：面板路由（异步 job）与工具（同步运行）共用。 */
  const historyApi = {
    /** 已注册的 provider 与模型清单（面板「辅助模型」下拉的数据源）。 */
    models: async (): Promise<{
      providers: { id: string; name: string; models: { id: string; name: string }[] }[]
      failures: string[]
    }> => {
      const llm = ctx.get('llm' as never) as
        | {
            listProviders(): readonly { id: string; name: string }[]
            listModels(provider: string): Promise<readonly { id: string; name: string }[]>
          }
        | undefined
      if (llm === undefined) return { providers: [], failures: [] }
      const failures: string[] = []
      const providers = await Promise.all(llm.listProviders().map(async (provider) => {
        try {
          const models = await llm.listModels(provider.id)
          return { id: provider.id, name: provider.name, models: models.map(model => ({ id: model.id, name: model.name })) }
        } catch (error) {
          // 单个 provider 列举失败（如远端不可达）不影响其余分组。
          failures.push(`${provider.id}: ${error instanceof Error ? error.message : String(error)}`)
          return { id: provider.id, name: provider.name, models: [] }
        }
      }))
      return { providers, failures }
    },
    estimate: (rules: HistoryBackfillRules): Promise<HistoryEstimate> =>
      estimateHistoryBackfill(buildHistoryDeps(), resolved.historyBackfill, rules),
    run: (rules: HistoryBackfillRules, signal: AbortSignal): Promise<HistoryRunResult> =>
      runHistoryBackfill(buildHistoryDeps(), resolved.historyBackfill, rules, () => { /* 同步运行不对外播报进度 */ }, signal),
    /** 启动后台回填；已有任务在跑时拒绝（面板按钮据此禁用）。 */
    start: (rules: HistoryBackfillRules): { ok: boolean; reason?: string } => {
      if (backfillJob !== undefined && backfillJob.progress.state === 'running') {
        return { ok: false, reason: '已有回填任务正在运行，请先暂停或等待完成' }
      }
      const controller = new AbortController()
      const job: NonNullable<typeof backfillJob> = {
        controller,
        failures: [],
        progress: {
          state: 'running', sessionsTotal: 0, sessionsDone: 0, turnsPlanned: 0,
          turnsDone: 0, memoriesWritten: 0, turnsSkipped: 0, turnsFailed: 0, skipReasons: {},
        },
      }
      backfillJob = job
      void runHistoryBackfill(
        buildHistoryDeps(), resolved.historyBackfill, rules,
        progress => { job.progress = progress },
        controller.signal,
      )
        .then((result) => { job.progress = result; job.failures = result.failures })
        .catch((error: unknown) => {
          // 整批失败（如枚举会话出错）：置 failed 并保留已累计进度，不抛给宿主。
          console.warn('[dsh-engram] 历史回填失败：', error)
          job.progress = { ...job.progress, state: 'failed' }
          job.error = error instanceof Error ? error.message : String(error)
        })
      return { ok: true }
    },
    cancel: (): void => { backfillJob?.controller.abort() },
    /** 当前任务快照；从未跑过时返回 idle 占位。 */
    status: (): { progress: HistoryRunProgress; failures: HistoryRunResult['failures']; error?: string } => ({
      progress: backfillJob?.progress ?? {
        state: 'done', sessionsTotal: 0, sessionsDone: 0, turnsPlanned: 0,
        turnsDone: 0, memoriesWritten: 0, turnsSkipped: 0, turnsFailed: 0, skipReasons: {},
      },
      failures: backfillJob?.failures ?? [],
      ...(backfillJob?.error === undefined ? {} : { error: backfillJob.error }),
    }),
  }

  // 工具注册（历史回填的估算/执行由 historyApi 提供；project scope 按会话 cwd 归属解析）。
  for (const tool of createEngramTools({
    openStore,
    resolveProjectStore,
    embedder,
    call: callParams => streamText(ctx, { ...callParams, sessionId: callParams.sessionId ?? '' }),
    routeOverride: resolved.routeOverride,
    // 面板覆盖免缓存装配：工具每次调用时读 jev-config.json，面板保存立即生效。
    ...resolveJevField(resolved.jev, resolved.dbDir),
    queryRewrite: resolved.queryRewrite,
    exportDir: `${resolved.dbDir}/exports`,
    historyBackfill: { estimate: historyApi.estimate, run: historyApi.run },
  })) {
    ctx.tools.register(tool)
  }

  // 管理面板（可选）：webServer 就绪后注册管理页与 /api/engram/* 接口。
  // 注入子 fiber 在无 webServer 的组合（headless）下保持等待，不阻塞主装载，
  // 工具/画像注入/摄取/衰减等其余能力不受影响。
  ctx.inject(['webServer'], (webCtx) => {
    // 必须用注入回调的子 ctx：ctx.webServer 属性代理拓扑敏感，
    // 外层 ctx 未依赖 webServer 时属性不可用。
    registerEngramRoutes(webCtx, {
      openStore,
      projects: projectsDeps,
      exportDir: `${resolved.dbDir}/exports`,
      mirrorDir: `${resolved.dbDir}/palaces`,
      dbDir: resolved.dbDir,
      pluginVersion: VERSION,
      embedder,
      // Jev 面板配置：yml 基线 + dbDir（覆盖文件路径派生），读写全走 jev/runtime 纯函数。
      jev: { base: resolved.jev, dbDir: resolved.dbDir },
      history: {
        estimate: historyApi.estimate,
        start: historyApi.start,
        cancel: historyApi.cancel,
        status: historyApi.status,
        models: historyApi.models,
        defaults: resolved.historyBackfill,
      },
    })
  })

  if (resolved.injectProfile || resolved.ingest !== 'off') {
    ctx.on('agent/pre-step', (payload, next) => preStep(ctx, openStore, openStoreForProjectCwd, resolved, embedder, preStepState, logIngestRequest, payload, next), { prepend: true })
  }

  // 会话结束即释放该会话的证据批次（进程内注册表，避免长驻进程累积）。
  ctx.on('session/disposed', (session) => {
    evidenceBatches.clear(String(session.id))
  })

  if (resolved.ingest !== 'off') {
    // 末轮摄取闭环：disposed 是 fire-and-forget 观察器（宿主不等待），5 秒超时；
    // 失败/超时由 ingestFinalTurn 落 pending 键，下次会话首次 pre-step 重放补做。
    // 必须挂 .catch：宿主把未处理的 rejection 当致命错误（installFailLoud → process.exit），
    // 而 dispose 时会话事件源可能已 detach——任何逃逸异常都会变成整个 DSH 进程退出。
    ctx.on('session/disposed', (session) => {
      const mode = resolved.ingest
      if (mode === 'off') return
      // dispose 后事件源可能 detach：事件快照与 cwd 在同步段取一次，摄取与摘要共用。
      const events = session.snapshotEvents() as unknown as readonly SessionEventLike[]
      const sessionId = String(session.id)
      const cwd = sessionCwd(session)
      void ingestFinalTurn({
        events,
        sessionId,
        turn: 0,
        slice: 'last',
        openStore: () => openStore('user'),
        openAuditStore: () => openStore('user'),
        // 末轮补做同样按该会话的 cwd 落项目宫殿并逐条判 scope。
        ...ingestWriteRouting(cwd, openStoreForProjectCwd, openStore),
        embedder,
        mode,
        routeOverride: resolved.routeOverride,
        ...resolveJevField(resolved.jev, resolved.dbDir),
        call: params => streamText(ctx, { ...params, sessionId: session.id }),
        logRequest: logIngestRequest,
        signal: AbortSignal.timeout(FINAL_INGEST_TIMEOUT_MS),
      })
        // 末轮摄取完成后收尾生成整场会话的一句话摘要：摄取失败（null）通常意味着
        // LLM 不可达，摘要同样会失败，不再起调用。摘要用独立 5 秒预算，不吃摄取的超时额度。
        .then(outcome => {
          if (outcome === null) return undefined
          return ensureSessionSummary({
            events,
            sessionId,
            // 摘要落会话主库（与历史回填口径一致）：有 cwd 落该项目库，无 cwd 落 user 库。
            openStore: () => (cwd === undefined ? openStore('user') : openStoreForProjectCwd(cwd)),
            call: params => streamText(ctx, { ...params, sessionId: session.id }),
            logRequest: logIngestRequest,
            mode,
            routeOverride: resolved.routeOverride,
            signal: AbortSignal.timeout(FINAL_INGEST_TIMEOUT_MS),
            round: lastTurnNumber(events),
          })
        })
        .catch((error: unknown) => {
          console.warn('[dsh-engram] 会话结束的收尾处理异常（不影响对话）：', error)
        })
    })
  }

  // 衰减调度：启动即跑一次，此后每 24 小时一次；低重要性且长期未访问的条目归档（可恢复）。
  const runDecay = async (): Promise<void> => {
    const targets: { label: string; open: () => Promise<EngramStore> }[] = [
      { label: 'user', open: () => openStore('user') },
    ]
    // 项目宫殿可能不止一个（每个工作区一个）：只处理库文件已存在的，避免为工作区建空库。
    for (const palace of await projectPalaces()) {
      if (!existsSync(join(resolved.dbDir, palace.dbName))) continue
      targets.push({ label: `project「${palace.title}」`, open: () => openDb(palace.dbName) })
    }
    for (const target of targets) {
      const archived = await (await target.open()).decay({
        importanceBelow: resolved.decayImportanceBelow,
        olderThanDays: resolved.decayAfterDays,
      })
      if (archived > 0) console.warn(`[dsh-engram] 衰减调度：${target.label} 库归档 ${archived} 条低价值记忆（可在 engram_review 查证）`)
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
