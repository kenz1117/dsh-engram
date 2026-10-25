/**
 * dsh-engram：DeepSeek Harness 跨会话长期记忆插件（host 半）。
 * 注册 18 个 engram_ 工具、会话开始注入画像（curated block 优先于派生画像）、
 * 自动摄取上一轮对话、蒸馏/衰减飞轮与审计能力。
 * @module @kenz1117/dsh-engram
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'

// v4 消息源类型收编：本插件未声明裸名 kind，DSH v3→v4 迁移把本插件的历史源
// 统一改写为 `plugin:<包名>` 前缀形状（并去掉 plugin 字段），写入端沿用同一形状。
// 模式键声明合并让 MessageSource 联合收编该前缀，注入处无需类型断言。
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    [kind: `plugin:${string}`]: { kind: `plugin:${string}` } & ContextFormed
  }
}
import { readLanguageSetting, resolveConfig } from './config.ts'
import type { EngramConfig, ResolvedEngramConfig } from './config.ts'
import { describeDictionaryProblems, loadMessageDictionary, loadPanelDictionary, readDictionaryLayer } from './i18n/dictionary-file.ts'
import type { LoadedDictionary } from './i18n/dictionary-file.ts'
import { applyDictionaryPatch, dictionaryPaths, layerOverrides, readDictionarySet, writeDictionarySet } from './i18n/dictionary-edit.ts'
import { DICTIONARY_SETS, dictionaryTerms, PANEL_BUILTIN_LANGUAGES } from './i18n/dictionary-terms.ts'
import { FILL_MAX_TOKENS, FILL_SPLIT_DEPTH, FILL_TIMEOUT_MS, splitFillBatch } from './i18n/dictionary-limits.ts'
import { answerSnippet, fillBatch, fillPrompt, glossaryPairs, parseFillAnswer } from './i18n/dictionary-ai.ts'
import type { FillPair } from './i18n/dictionary-ai.ts'
import { describeRegistryProblems, loadRegistry } from './registry/registry-file.ts'
import type { LoadedRegistry } from './registry/registry-file.ts'
import type { EngramLanguage } from './i18n/language.ts'
import { pickLanguage } from './i18n/language.ts'
import { dominantLanguage, palaceCase } from './i18n/palace-language.ts'
import { collectLanguageSignals } from './language-signals.ts'
import { interfacePreference, writePalaceLanguage, writePalaceLanguageWithRetry, type SettingsServiceView } from './settings-bridge.ts'
import { message, messageIn, setMessageDictionary, setMessageLanguage } from './i18n/messages.ts'
import { setExtraRedactWords } from './i18n/patterns.ts'
import { roomLabel } from './i18n/rooms.ts'
import { createEmbedder, resolveBaseTarget, resolveLocalModel } from './embedder/select.ts'
import type { LocalModelChoice } from './embedder/select.ts'
import type { EngramEmbedder } from './embedder/interface.ts'
import { FINAL_INGEST_TIMEOUT_MS, ensureSessionSummary, ingestFinalTurn, ingestPreviousTurn, ingestWriteRouting, lastTurnNumber, replayPendingIngests, userTexts } from './ingest/hook.ts'
import { estimateHistoryBackfill, runHistoryBackfill } from './ingest/history.ts'
import type {
  HistoryBackfillDeps, HistoryBackfillRules, HistoryEstimate, HistoryLogSource, HistoryRunProgress, HistoryRunResult,
  HistorySessionHeader,
} from './ingest/history.ts'
import { runConsolidation } from './consolidation/run.ts'
import { reflectObservations } from './consolidation/reflect.ts'
import type { IngestRequestEventData } from './ingest/hook.ts'
import { parseJsonArray, routeFromEvents, streamText } from './llm/client.ts'
import type { LlmRoute, SessionEventLike } from './llm/client.ts'
import { registerEngramRoutes } from './routes.ts'
import type { BaseConvertResult, BaseLabelResult, BaseView, DictionarySaveResult, ProjectPalaceView, RegistryView, RouteDeps } from './routes.ts'
import { judgeBase, labelToStamp, languageOfLabels, MODEL_LABEL_KEY } from './registry/base-state.ts'
import type { CatalogModel } from './registry/base-state.ts'
import { readBaseCensus } from './registry/base-census.ts'
import { planBaseVectors, runVectorConvert, vectorConversionComplete } from './registry/convert.ts'
import { PalaceGuard } from './registry/palace-guard.ts'
import { loadVectorSchema } from './registry/vector-schema.ts'
import { migrateProjectDb, migrationWarning, resolveProjectIdentity } from './project/identity.ts'
import { findProjectPalace, listProjectPalaces } from './project/registry.ts'
import type { ProjectPalace, WorkspaceRef } from './project/registry.ts'
import { openEngramStore } from './store/sqlite.ts'
import type { EngramStore } from './store/interface.ts'
import { createEngramTools } from './tools/create.ts'
import { resolveJevField } from './jev/runtime.ts'
import { readJevCatalog, readProviderModels, resolveJevConnection } from './jev/host.ts'
import { currentUserRequestText, renderMemoryPacket, renderProfilePacket } from './security/sanitize.ts'
import { wrapWithRationale } from './selection-rationale.ts'
import { buildAssessReminder, evidenceBatches } from './retrieve/evidence.ts'
import { estimateTokens } from './token.ts'
import { EngramError } from './types.ts'
import type { EngramScope, Slot } from './types.ts'

/** Cordis 插件名（loader 诊断与注入 source 使用）。 */
export const name = 'dsh-engram'

/** 插件版本：单一来源 = package.json（审计 F9：手写常量已漂移到 0.7.6，备份 _meta.json 随之记错版本）。 */
import pluginPackageJson from '../package.json' with { type: 'json' }
export const VERSION: string = pluginPackageJson.version

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
 * @param language - 房间名的显示语言（房间里存的是标识符，不是文本）。
 * @param itemBudget - 分级递减的单条正文预算（缺省用 DEFAULT_ITEM_BUDGET；配置面在 resolveConfig）。
 * @returns 渲染文本与溢出条目（调用方可用辅助 LLM 压缩后重渲染）。
 */
export function renderProfileDetailed(
  records: readonly { id: string; kind: string; content: string; slot?: Slot }[],
  tokenBudget: number,
  language: EngramLanguage,
  itemBudget: GraduatedItemBudget = DEFAULT_ITEM_BUDGET,
): ProfileRender {
  const estimate = estimateTokens
  // 主厅：常驻核心记忆层（每次会话都在场），行内带宫殿坐标（房间 #桩位）让 agent 有位置感。
  const header = messageIn(language, 'core.profileHeader')
  const footer = messageIn(language, 'core.profileFooter')
  let remaining = Math.max(0, tokenBudget - estimate(header) - estimate(footer))
  const lines: string[] = []
  const overflow: { id: string; kind: string; content: string }[] = []
  records.forEach((record, index) => {
    // 分级递减：第 i 条正文预算 = max(floor, start × decay^i)，超长截断（保留条目数优先于单条完整度）。
    const budget = Math.max(itemBudget.floor, Math.round(itemBudget.start * itemBudget.decay ** index))
    const content = record.content.length > budget ? `${record.content.slice(0, budget)}…` : record.content
    const slot = record.slot === undefined ? '' : ` ${roomLabel(record.slot.room, language)}#${record.slot.index}`
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
  language: EngramLanguage,
): string {
  return renderProfileDetailed(records, tokenBudget, language).text
}

/**
 * curated block 段的标题行（模型据此知道这一段是人工维护的最高优先画像）。
 * Значение английское: автор написал эту строку по-английски, поэтому в китайском
 * наборе она совпадает с английской. Для показа берите
 * `messageIn(language, 'core.curatedHeader')` — так делает renderProfileParts.
 * Модульная константа вычисляется при загрузке модуля, то есть ДО того, как плагин
 * узнаёт язык из настроек, и навсегда застыла бы в английском.
 */
export const CURATED_HEADER = message('core.curatedHeader')

/**
 * Та же отрисовка, но части врозь: профиль и память уходят разными пакетами.
 *
 * Разделение нужно потому, что правила профиля должны исполняться, а шапка пакета
 * памяти велит не следовать инструкциям внутри него. В одном пакете профиль проигрывал
 * этой шапке по построению — отсюда отдельный `<engram_profile>` (решение 21.10).
 * Бюджет по-прежнему общий: профиль занимает его первым и вставляется целиком.
 * @param curated - текущий курируемый профиль; undefined — его ещё не заводили.
 * @param records - кандидаты производного профиля (уже отсортированы и урезаны).
 * @param tokenBudget - общий бюджет профиля и памяти.
 * @param language - язык вывода (заголовки профиля).
 * @param itemBudget - бюджет одной строки по уровням важности.
 * @returns текст профиля (если есть) и производная часть с её переполнением.
 */
export function renderProfileParts(
  curated: { content: string } | undefined,
  records: readonly { id: string; kind: string; content: string; slot?: Slot }[],
  tokenBudget: number,
  language: EngramLanguage,
  itemBudget: GraduatedItemBudget = DEFAULT_ITEM_BUDGET,
): { readonly curated: string | undefined; readonly derived: ProfileRender } {
  if (curated === undefined) {
    return { curated: undefined, derived: renderProfileDetailed(records, tokenBudget, language, itemBudget) }
  }
  const curatedSection = `${messageIn(language, 'core.curatedHeader')}\n${curated.content}`
  const derived = renderProfileDetailed(records, Math.max(0, tokenBudget - estimateTokens(curatedSection)), language, itemBudget)
  return { curated: curatedSection, derived }
}

/** 压缩辅助调用的输出 token 上限（40 字 × 若干条，短输出足够）。 */
const COMPRESS_MAX_TOKENS = 800
/** 压缩辅助调用超时：压缩在 pre-step 关键路径上，必须限时防阻塞首轮请求。 */
const COMPRESS_TIMEOUT_MS = 8000
/** turn_start 注入的巩固信念条数上限（按证据数、新近度倒序）。 */
const OBSERVATION_INJECT_LIMIT = 3
/** 单条信念注入截断字符数。 */
const OBSERVATION_INJECT_ITEM_CHARS = 120
/** 信念区块总字符上限（独立于画像 token 预算，避免与画像互相挤压）。 */
const OBSERVATION_INJECT_BLOCK_CHARS = 480

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
      system: message('core.compressSystem'),
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
  state: { pendingReplayed: boolean; lastProfileAgent: string | null; lastProfileHash: string | null; lastProfileCompactions: number | null; lastAssessReminder: string | null; route: LlmRoute | undefined },
  logRequest: (data: IngestRequestEventData) => void,
  onDialogueLanguage: (language: EngramLanguage) => void,
  { agent, step, turn, signal }: { agent: Agent; step: number; turn: number; signal: AbortSignal },
  next: () => Promise<PreStepDecision>,
): Promise<PreStepDecision> {
  const decision = await next()
  if (decision.kind === 'reject') return decision
  // Язык дворца смотрит на диалоги (решение 21.10): реплики человека лежат в событиях
  // текущей сессии — для этого не нужно читать журналы, которые стоят сотни мегабайт.
  // Реплик может ещё не быть (первый ход) — тогда сигнала просто нет.
  const observed = dominantLanguage(userTexts(agent.session.snapshotEvents() as unknown as readonly SessionEventLike[]))
  if (observed !== undefined) onDialogueLanguage(observed.language)
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
        // Провайдер Jev: панель → cordis.yml → маршрут этой сессии (тот же, что у извлечения).
        ...resolveJevField(ctx, resolved.jev, resolved.dbDir, () => state.route?.provider),
        call: params => streamText(ctx, { ...params, sessionId: agent.session.id }),
        logRequest,
        signal,
      }).catch((error: unknown) => {
        console.warn(message('core.warnReplayPendingFailed'), error)
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
        // Провайдер Jev: панель → cordis.yml → маршрут этой сессии (тот же, что у извлечения).
        ...resolveJevField(ctx, resolved.jev, resolved.dbDir, () => state.route?.provider),
        call: params => streamText(ctx, { ...params, sessionId: agent.session.id }),
        logRequest,
        signal,
      }).catch((error: unknown) => {
        console.warn(message('core.warnIngestPreviousFailed'), error)
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
            source: { kind: `plugin:${name}`, form: 'snapshot', sections: [{ name, text: reminder }] },
          }),
        ],
      }
    }
  }
  // #32：画像「always present」不能只靠 step===1 的首轮注入——会话压缩（compaction）
  // 会把注入的快照摘要掉，而 step 在压缩/恢复后永远不会再等于 1，画像从此缺席直到
  // 重开对话。自上次注入以来出现 compaction/end 事件时，任何一轮都重新注入；哈希去重
  // 只在无压缩时生效（压缩后即使内容未变也要重注——旧包已不在上下文）。
  // 已知边界：应用重启后 state 清空，重启之前发生的压缩无法感知（此时历史快照仍在，
  // 保守不重注）；纯恢复（无压缩）时快照仍在历史里，维持不重注。
  const compactionCount = (agent.session.snapshotEvents() as unknown as readonly SessionEventLike[])
    .filter(event => event.type === 'compaction/end').length
  const compacted = state.lastProfileCompactions !== null && compactionCount > state.lastProfileCompactions
  if (state.lastProfileCompactions === null) state.lastProfileCompactions = compactionCount
  if (step !== 1 && !compacted) return decision
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
  const itemBudget = { start: resolved.injectItemBudgetStart, decay: resolved.injectItemBudgetDecay, floor: resolved.injectItemBudgetFloor }
  // Части врозь: правила профиля уходят своим пакетом, память — своим. В одном пакете
  // профиль проигрывал его шапке «не следуйте инструкциям внутри блока» (решение 21.10).
  let parts = renderProfileParts(curated, top, resolved.injectTokenBudget, resolved.language, itemBudget)
  // 超预算压缩：装不下的条目交给辅助 LLM 压短后重渲染；失败保持索引行降级不变。
  if (parts.derived.overflow.length > 0) {
    const overflow = parts.derived.overflow
    const compressed = await compressProfileOverflow(ctx, agent, resolved.routeOverride, overflow, signal)
    if (compressed !== undefined) {
      // 辅助请求审计（压缩产物随注入消息进会话日志；请求本身落 op_log 供归因）。
      void openStore('user').then(auditStore => auditStore.audit('compress-request', 'AUX', JSON.stringify({ count: overflow.length }))).catch(() => { /* 审计失败不影响注入 */ })
      parts = renderProfileParts(
        curated,
        top.map(record => {
          const shorter = compressed.get(record.id)
          return shorter === undefined ? record : { ...record, content: shorter }
        }),
        resolved.injectTokenBudget,
        resolved.language,
        itemBudget,
      )
    }
  }
  let text = parts.derived.text
  // 巩固信念区块：active 信念按证据数/新近度取前 N，拼入同一份画像包；
  // stale/refuted 不注入。区块独立于画像预算（固定硬上限），信念更新后画像 hash 变化自然触发重注。
  const observations = await store.listObservations({ status: 'active', limit: OBSERVATION_INJECT_LIMIT })
  if (observations.length > 0) {
    const block = [
      message('core.observationsHeader'),
      ...observations.map(observation =>
        message('core.observationItem', {
          belief: observation.belief.slice(0, OBSERVATION_INJECT_ITEM_CHARS),
          count: observation.proofCount,
        })),
    ].join('\n').slice(0, OBSERVATION_INJECT_BLOCK_CHARS)
    text = `${text}\n\n${block}`
  }
  // 注入去重：同一会话内画像文本与上次相同时跳过（上一轮注入仍在上下文里）；
  // 新会话（lastProfileAgent 不同）必须注入，即使文本与上个会话相同。due 行纳入 hash 输入。
  const dueLine = dueTotal === 0
    ? ''
    : message('core.reviewDue', { count: dueTotal, plus: dueTotal >= 50 ? '+' : '' })
  const textWithRationale = wrapWithRationale(text, top) + dueLine
  // Профиль входит в хеш: правка правил без изменения памяти тоже должна переинжектиться.
  const hash = createHash('sha256').update(`${parts.curated ?? ''}\n${textWithRationale}`).digest('hex')
  if (!compacted && state.lastProfileAgent === String(agent.id) && hash === state.lastProfileHash) return decision
  state.lastProfileAgent = String(agent.id)
  state.lastProfileHash = hash
  state.lastProfileCompactions = compactionCount
  // 画像包协议标签：记忆条目是不可信历史上下文；当前请求取本轮 admitted 消息的最后一个文本块。
  // Правила профиля идут отдельным пакетом и первыми: это указания человека, а не память,
  // и шапка пакета памяти к ним не относится (решение 21.10).
  const requestText = currentUserRequestText(decision.messages)
  const memoryPacket = renderMemoryPacket(text, 'turn_start', requestText)
  const packet = parts.curated === undefined
    ? memoryPacket
    : `${renderProfilePacket(parts.curated)}\n\n${memoryPacket}`
  return {
    ...decision,
    messages: [
      ...decision.messages,
      createUserMessage({
        content: [{ type: 'text', text: packet }],
        source: { kind: `plugin:${name}`, form: 'snapshot', sections: [{ name, text: packet }] },
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
 * Снимок обслуживания: чем выбрана модель и из каких файлов это следует.
 *
 * Собирается один раз при сборке плагина, потому что все источники — реестр,
 * оба словаря, разрешённый язык — читаются один раз и дальше не меняются.
 * Панель получает готовый ответ и ничего не выводит сама: правило выбора модели
 * должно быть одно, и жить оно должно там, где модель выбирается, а не в отрисовке.
 * @param input - прочитанные реестр и словари, язык, признак удалённой модели и выбор модели.
 * @returns JSON-совместимый снимок для `GET registry`.
 */
function registrySnapshot(input: {
  readonly registry: LoadedRegistry
  readonly language: string
  /** Язык дворца: чем определён и были ли расхождения сигналов. */
  readonly palace: RegistryView['palace']
  /** Длина окна собранного условия (настройка `palaceChangeWindowSec`). */
  readonly palaceChangeWindowSec: number
  readonly remote: boolean
  readonly model: LocalModelChoice | undefined
  readonly messages: LoadedDictionary
  readonly panel: LoadedDictionary
  /** Языки моделей, у которых файл словаря уже есть (см. `dictionaryLanguages`). */
  readonly dictionaryLanguages: readonly string[]
}): RegistryView {
  const dictionary = (name: string, loaded: LoadedDictionary): RegistryView['dictionaries'][number] => ({
    name,
    files: loaded.files,
    entries: loaded.entries.size,
    problems: loaded.problems.map(problem => ({
      file: problem.file,
      line: problem.line,
      kind: problem.kind,
      detail: problem.detail,
    })),
  })
  return {
    language: input.language,
    palace: input.palace,
    defaultLanguage: input.registry.defaultLanguage ?? null,
    palaceChangeWindowSec: input.palaceChangeWindowSec,
    // Языки — тем же ответом, что и модели с привязками: список выбора в панели
    // обязан приходить от реестра, а не из своей копии в сборке клиента.
    languages: input.registry.languages.map(row => ({ code: row.code, label: row.label, builtin: row.builtin })),
    dictionaryLanguages: [...input.dictionaryLanguages],
    remote: input.remote,
    resolved: input.model === undefined ? null : {
      id: input.model.id,
      label: input.model.label ?? null,
      source: input.model.source,
      pooling: input.model.pooling,
      dtype: input.model.dtype,
    },
    models: [...input.registry.models.values()].map(row => ({
      id: row.id,
      label: row.label ?? null,
      pooling: row.pooling,
      dtype: row.dtype,
      dimensions: row.dimensions ?? null,
      languages: [...row.languages],
    })),
    bindings: [...input.registry.bindings].map(([language, model]) => ({ language, model })),
    files: input.registry.files,
    problems: input.registry.problems.map(problem => ({
      file: problem.file,
      kind: problem.kind,
      detail: problem.detail,
    })),
    dictionaries: [dictionary('messages', input.messages), dictionary('panel', input.panel)],
  }
}

/** Хостовый сервис настроек: живёт отдельно от плагина и может отсутствовать. */
function settingsOf(ctx: Context): SettingsServiceView | undefined {
  return ctx.get('settings' as never) as SettingsServiceView | undefined
}

/** Сколько раз пробуем записать язык дворца и с какой паузой (окно ~3 с). */
const PALACE_WRITE_ATTEMPTS = 20
const PALACE_WRITE_DELAY_MS = 150

/**
 * Записать выбранный язык дворца в конфигурацию плагина.
 *
 * Одна реализация на два повода: определение на первом старте и явный выбор в панели.
 * Пишем через хостовый сервис настроек: он кладёт значение в профильный patch, то есть
 * ровно в конфигурацию плагина, и применяет его на живом фибере volatile-путём —
 * без перемонтирования. Если сервиса или своей записи нет, язык остаётся на этот
 * процесс и на следующий старт не переживает: об этом говорим вызывающему, а не молчим.
 * @param ctx - контекст плагина.
 * @param language - выбранный язык дворца.
 * @returns Причина отказа; undefined — запись удалась.
 */


/**
 * Записать определённый язык дворца, не задерживая старт плагина.
 *
 * Повтор и сам отказ живут в мосте (`settings-bridge.ts`): там же, где поиск своей
 * формы. Здесь только привязка к контексту — где взять сервис и когда остановиться.
 * @param ctx - контекст плагина.
 * @param language - определённый язык дворца.
 */
function persistPalaceLanguage(ctx: Context, language: EngramLanguage): void {
  let stopped = false
  ctx.effect(() => {
    void writePalaceLanguageWithRetry({
      settings: () => settingsOf(ctx),
      language,
      attempts: PALACE_WRITE_ATTEMPTS,
      delayMs: PALACE_WRITE_DELAY_MS,
      stopped: () => stopped,
    }).then(reason => {
      if (reason !== undefined) console.warn(`dsh-engram: ${reason}`)
    })
    return () => { stopped = true }
  }, 'dsh-engram: palace language persistence')
}

/**
 * 插件体：预热分库与嵌入器，注册 10 个工具、画像注入、自动摄取与衰减调度。
 * @param ctx - host 上下文。
 * @param config - cordis.yml 传入的可选配置；非法值在加载时 loud 失败。
 */
export async function apply(ctx: Context, config: EngramConfig = {}): Promise<void> {
  const resolvedConfig = resolveConfig(config)
  // Реестры читаются до языка: умолчание пакета живёт в привязках (см. src/registry),
  // а от языка уже зависят и словарь, и шаблоны сообщений. Чтение чистое — файлы без
  // сети, — поэтому порядок ничего не стоит.
  const registry = loadRegistry({ dbDir: resolvedConfig.dbDir })
  /** Что записано в настройке: `auto` — решения о языке дворца ещё нет. */
  const languageSetting = readLanguageSetting(config.language)
  let language = pickLanguage(languageSetting, registry.defaultLanguage)
  // Язык дворца определяется полуавтоматически (В.02): если решения нет, дворец
  // смотрит на preference интерфейса и локаль машины и записывает СВОЙ язык —
  // конкретным значением, а не «auto». Разошлись сигналы среды — не выставляем
  // ничего: спросим пользователя в панели.
  //
  // Журналы сессий здесь больше не читаются (решение 20.10): журнал читается целиком,
  // и на живых данных это сотни мегабайт кучи на каждом старте ради сорока реплик.
  let determination: Awaited<ReturnType<typeof collectLanguageSignals>> | undefined
  if (languageSetting === undefined || languageSetting === 'auto') {
    determination = await collectLanguageSignals({
      readInterfacePreference: async () => {
        const settings = settingsOf(ctx)
        return settings === undefined ? undefined : interfacePreference(settings.describe())
      },
    })
    if (!determination.decision.conflict) language = determination.decision.language
  }
  // Настройка главнее умолчания, умолчание — главнее системной локали (см.
  // src/i18n/language.ts): «наш язык» должен зависеть от объявленного выпуска, а не
  // от машины, на которой плагин запущен.
  const resolved: ResolvedEngramConfig = { ...resolvedConfig, language, languageSetting }
  // Запись решения — отдельным тиком, когда фибер уже поднялся: правка конфигурации
  // на стартующем фибере пошла бы обычным путём (перемонтирование посреди apply),
  // а на живом идёт volatile-путём — значение меняется на ходу, плагин не грузится заново.
  // Записываем сами только то решение, у которого есть опора — голос диалога.
  // Локаль машины и preference интерфейса для этого слишком слабы: язык дворца держит
  // модель, инструкции и язык новых записей, поэтому в остальных случаях спрашиваем
  // человека в панели (В.02), а до ответа считаем по тем же слабым сигналам.
  if (determination !== undefined && determination.decision.grounded) {
    const decided = determination.decision.language
    ctx.effect(() => {
      const timer = setTimeout(() => { persistPalaceLanguage(ctx, decided) }, 0)
      return () => { clearTimeout(timer) }
    }, 'dsh-engram: palace language persistence')
  }
  // Язык служебных сообщений — один на процесс. Помощник message() зовут десятки
  // функций, и протаскивать язык в каждую было бы куда грубее, чем задать его здесь
  // один раз при сборке плагина (см. src/i18n/messages.ts).
  setMessageLanguage(resolved.language)
  // Переводы: файл словаря накладывается поверх наборов из кода (см. src/i18n/dictionary-file.ts).
  // Нет файла — работаем на коде. Дефектные строки пропускаются: это чтение, а не запись,
  // и падать из-за словаря незачем — но о них говорим, иначе правка «молча не работает».
  const dictionary = loadMessageDictionary({ language: resolved.language, dbDir: resolved.dbDir })
  setMessageDictionary(resolved.language, dictionary.entries)
  if (dictionary.problems.length > 0) {
    console.warn(message('misc.warnDictionaryProblems', {
      count: dictionary.problems.length,
      sample: describeDictionaryProblems(dictionary.problems),
    }))
  }
  // Реестры: каталог моделей и привязки «язык → модель» (см. src/registry). Каталог
  // кладёт поставка, привязки перекрывает слой пользователя. Прочитано выше, до языка;
  // здесь только претензии — в прежнем порядке, после словарных.
  if (registry.problems.length > 0) {
    console.warn(message('misc.warnRegistryProblems', {
      count: registry.problems.length,
      sample: describeRegistryProblems(registry.problems),
    }))
  }
  // Словарь панели — тот же механизм, другой файл (`i18n/panel.<язык>.txt`): тексты
  // интерфейса должны правиться без пересборки так же, как тексты сообщений. Панель
  // забирает его тем же ответом, что и снимок обслуживания, и накладывает поверх
  // словарей, вшитых в сборку.
  const panelDictionary = loadPanelDictionary({ language: resolved.language, dbDir: resolved.dbDir })
  if (panelDictionary.problems.length > 0) {
    console.warn(message('misc.warnDictionaryProblems', {
      count: panelDictionary.problems.length,
      sample: describeDictionaryProblems(panelDictionary.problems),
    }))
  }
  // Снимок обслуживания: что выбрано, по какому правилу и из каких файлов это следует.
  // Собирается один раз при сборке плагина — реестр и словари читаются один раз и
  // дальше не меняются, а панель показывает именно это состояние, а не свежий опрос.
  // Выбор модели считается здесь, а не внутри снимка: та же строка нужна карточке баз —
  // она называет метку, которой подписываются базы (`ru-minilm-l12`), и разойтись эти
  // два места не должны.
  const localModel = resolveLocalModel(registry, resolved.language, resolved.embedder.localModel, resolved.embedder.localPooling)
  /** Снимок обслуживания по прочитанным словарям: собирается заново после правки из панели. */
  /**
   * Язык дворца в снимке обслуживания. Здесь всегда null: язык диалога появляется
   * посреди работы, поэтому снимок панели собирается на каждый запрос (`palaceView`),
   * а это — заготовка для остальных чтений снимка.
   */
  const palaceLanguageView: RegistryView['palace'] = null
  /**
   * Языки, у которых файл словаря уже есть: в поставке или у человека.
   *
   * Проверяем файлы, а не разбор: вопрос ровно один — «словарь заведён или нет», и ответ
   * даёт наличие файла в любом из двух наборов. Разбор читал бы мегабайты ради признака.
   */
  const languagesWithDictionary = (codes: readonly string[]): readonly string[] => codes.filter(code =>
    DICTIONARY_SETS.some(set => {
      const paths = dictionaryPaths({ set, language: code as EngramLanguage, dbDir: resolved.dbDir })
      return existsSync(paths.delivery) || existsSync(paths.user)
    }))
  /** Языки, объявленные моделями реестра: из них панель выбирает, чему заводить словарь. */
  const modelLanguages = (): readonly string[] => [...new Set(
    [...registry.models.values()].flatMap(row => row.languages),
  )]
  const snapshotView = (messages: LoadedDictionary, panel: LoadedDictionary): RegistryView => registrySnapshot({
    registry,
    language: resolved.language,
    palace: palaceLanguageView,
    palaceChangeWindowSec: resolved.palaceChangeWindowSec,
    remote: resolved.embedder.remote !== undefined,
    model: localModel,
    messages,
    panel,
    dictionaryLanguages: languagesWithDictionary(modelLanguages()),
  })
  let registryView = snapshotView(dictionary, panelDictionary)
  /**
   * Перечитать словари и применить их заново.
   *
   * Вызывается после правки из панели (см. routes.ts, POST dictionary): файл — это
   * то, что видит и серверная половина, и панель. Серверные сообщения берут словарь
   * из модульной переменной (см. ./i18n/messages), панель — из снимка обслуживания,
   * поэтому обновить нужно оба места, и без перезапуска плагина.
   * @returns свежий снимок обслуживания.
   */
  const reloadDictionaries = (): RegistryView => {
    const messages = loadMessageDictionary({ language: resolved.language, dbDir: resolved.dbDir })
    const panel = loadPanelDictionary({ language: resolved.language, dbDir: resolved.dbDir })
    setMessageDictionary(resolved.language, messages.entries)
    registryView = snapshotView(messages, panel)
    return registryView
  }
  // Объявление схемы данных: какие таблицы несут векторы и по какому условию. Читается
  // один раз — это реестр, а не состояние базы. Без него состояние баз не проверяется:
  // судить о векторах по догадке мы не будем, и об этом скажет карточка.
  const vectorSchema = loadVectorSchema({ dbDir: resolved.dbDir })
  if (vectorSchema.problems.length > 0) {
    console.warn(message('misc.warnRegistryProblems', {
      count: vectorSchema.problems.length,
      sample: describeRegistryProblems(vectorSchema.problems),
    }))
  }
  /** Каталог моделей в том виде, в каком его понимает правило состояния базы. */
  const catalogModels: readonly CatalogModel[] = [...registry.models.values()]
    .map(row => ({ id: row.id, label: row.label, dimensions: row.dimensions }))
  /**
   * Язык, под который считаются метки и пересчёт баз.
   *
   * Меняется вместе со сменой языка дворца, не дожидаясь перезапуска: собранное условие
   * существует ровно для того, чтобы язык и базы менялись одним действием. Если бы здесь
   * остался язык, прочитанный при сборке плагина, «Выполнить» записало бы новый язык, а
   * базы подписало и пересчитало под старый — и человек получил бы ровно то расхождение,
   * от которого условие защищает.
   */
  let basesLanguage: EngramLanguage = resolved.language
  /**
   * Предохранитель смены языка: одно окно на процесс, состояние — в памяти.
   *
   * Окно живёт минуту и имеет смысл, пока живёт процесс; переживать перезапуск ему
   * незачем, а запись на диск превращала бы проверку в ещё одну вещь, которую надо
   * обслуживать (решение 24.10).
   */
  const palaceGuard = new PalaceGuard()
  /** Ожидание базы под текущий язык: пересчитывается, а не берётся из сборки плагина. */
  const baseTargetNow = (): {
    readonly label: string | undefined
    readonly model: { readonly id: string, readonly label: string | undefined, readonly dimensions: number | undefined } | undefined
  } => resolveBaseTarget(registry, basesLanguage, resolved.embedder)
  // Слова пользователя для вычистки секретов. Действуют поверх языковых наборов и
  // независимо от языка: пользователь добавляет их как раз потому, что пакета не хватило
  // (см. src/i18n/patterns.ts, настройка redactWords).
  setExtraRedactWords(resolved.redactWords)
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

  /**
   * Подписать базу меткой модели при открытии.
   *
   * Метку ставила только починка — и всякая новая база жила без неё до нажатия кнопки,
   * а карточка честно звала это «база требует ремонта» (решение 22.10: подписывать при
   * создании). Правило то же, что у кнопки — `labelToStamp`, чтобы второй правды о
   * метке не завелось. Пустой базе метка тоже пишется: писать в неё будет эта модель.
   *
   * Ошибка чтения или записи метки не мешает открытию: база просто останется без метки,
   * как было до этой строки, и о том говорится в журнал.
   * @param dbName - имя файла базы в каталоге данных.
   * @param store - уже открытое хранилище этой базы (метку пишем через него).
   */
  const stampLabelOnOpen = async (dbName: string, store: EngramStore): Promise<void> => {
    const target = baseTargetNow()
    if (target.label === undefined) return
    try {
      const census = await readBaseCensus({
        path: join(resolved.dbDir, dbName),
        specs: vectorSchema.specs,
        schemaVersion: vectorSchema.schemaVersion,
      })
      if (!census.checkable) return
      // Читать не удалось (битый файл, таблицы нет, база заперта писателем) — фактов
      // нет, и подписывать «на всякий случай» нельзя: пустая на вид база может
      // оказаться чужой, просто нечитаемой в этот момент.
      if (census.problems.length > 0) return
      const label = labelToStamp({ facts: census.facts, target, language: basesLanguage, catalog: catalogModels })
      if (label === undefined) return
      await store.writeMeta(MODEL_LABEL_KEY, label)
    } catch (error) {
      console.warn(message('core.warnLabelStampFailed', { file: dbName }), error)
    }
  }

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
          console.warn(message('core.warnRoomFull', { room }))
        })
        if (assigned > 0) console.warn(message('core.warnSlotsBackfilled', { count: assigned, path }))
        await stampLabelOnOpen(dbName, store)
        return store
      })
    // 审计 F17：打开失败（SCHEMA_INCOMPATIBLE / 迁移中断 / 文件损坏）不缓存 rejection——
    // 否则盘上修复后进程内也永远拿不到重试机会。
    created.catch(() => { stores.delete(dbName) })
    stores.set(dbName, created)
    return created
  }

  const openStore = (scope: EngramScope): Promise<EngramStore> => openDb(
    scope === 'user' ? 'user.db' : scope === 'shared' ? 'shared.db' : identity.dbName,
  )

  /**
   * 关闭并清空全部分库缓存。两个用途：
   *  - 卸载/重启时释放连接（不关会在 Windows 上锁住 .db 文件，目录删不掉）；
   *  - 审计 F16：restore 备份后 rename 换掉了 .db 的 inode，缓存连接仍指向旧文件——
   *    继续写入会落进 .before-restore-* 且重启后静默丢失。restore 成功后必须调用，
   *    让下一次访问按恢复后的文件重新打开。
   */
  const closeStores = async (): Promise<void> => {
    await Promise.allSettled([...stores.values()].map(async pending => {
      try {
        await (await pending).close()
      } catch {
        // 关闭失败无补救动作（连接会随进程退出释放）。
      }
    }))
    stores.clear()
  }

  ctx.effect(() => () => closeStores(), 'dsh-engram: close stores')

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
  // 后端由配置选择：本地离线模型或 OpenAI 兼容端点。
  const embedder: Promise<EngramEmbedder | undefined> = createEmbedder(resolved, registry)
    .catch((error: unknown) => {
      console.warn(message('core.warnEmbedderUnavailable'), error)
      return undefined
    })
  void embedder
  // Эмбеддер держит ONNX-инстанс и память под модель: при выгрузке плагина его надо
  // отпустить, иначе перемонтирование оставляет в процессе ещё один живой инстанс,
  // а память под модель не возвращается. Закрываем независимо от того, успел ли он
  // загрузиться: обещание разрешается в undefined, если модель не поднялась.
  ctx.effect(() => () => {
    void embedder.then(active => active?.close()).catch(() => { /* закрытие не чинится */ })
  }, 'dsh-engram: close embedder')

  // 辅助请求写 engram 自己的操作日志（下游插件禁止向会话日志写未知事件类型）。
  const logIngestRequest = (data: IngestRequestEventData): void => {
    void openStore('user').then(store => store.audit('ingest-request', 'AUX', JSON.stringify(data))).catch(() => { /* 审计失败不影响摄取 */ })
  }

  // preStep 的可变状态：route 记录当前会话在用的路由，历史回填优先复用它。
  const preStepState: {
    pendingReplayed: boolean
    lastProfileAgent: string | null
    lastProfileHash: string | null
    lastProfileCompactions: number | null
    lastAssessReminder: string | null
    route: LlmRoute | undefined
  } = { pendingReplayed: false, lastProfileAgent: null, lastProfileHash: null, lastProfileCompactions: null, lastAssessReminder: null, route: undefined }

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

  /** Имя файла базы → чья она. Имена задаёт сам плагин, поэтому разбор по имени точен. */
  const scopeOfBaseFile = (file: string): BaseView['scope'] =>
    file === 'user.db' ? 'user' : file === 'shared.db' ? 'shared' : 'project'

  /**
   * Состояние каждой базы дворца для карточки обслуживания.
   *
   * Считается на каждый запрос: метку меняет кнопка в этой же карточке, и старая
   * картинка после неё была бы враньём. Базы читаются отдельным read-only
   * соединением (см. `registry/base-census.ts`) — карточка не открывает чужие базы
   * через хранилище и ничего в них не меняет.
   */
  const baseStates = async (): Promise<{ bases: readonly BaseView[], pendingBases: number }> => {
    const palaces = await projectPalaces()
    const titles = new Map(palaces.map(palace => [palace.dbName, palace.title]))
    const files = readdirSync(resolved.dbDir).filter(name => name.endsWith('.db')).sort()
    const bases: BaseView[] = []
    for (const file of files) {
      const census = await readBaseCensus({
        path: join(resolved.dbDir, file),
        specs: vectorSchema.specs,
        schemaVersion: vectorSchema.schemaVersion,
      })
      const scope = scopeOfBaseFile(file)
      // Объявление схемы описывает другую версию — состояние не проверяем и не
      // выдумываем: карточка покажет «не проверено» и причину.
      const verdict = census.checkable
        ? judgeBase({ facts: census.facts, target: baseTargetNow(), language: basesLanguage, catalog: catalogModels })
        : undefined
      bases.push({
        file,
        scope,
        title: scope === 'project' ? titles.get(file) ?? null : null,
        label: census.facts.label ?? null,
        targetLabel: baseTargetNow().label ?? null,
        state: verdict?.state ?? null,
        action: verdict?.action ?? null,
        rows: verdict?.rows ?? census.facts.rows,
        missing: verdict?.missing ?? census.facts.missing,
        foreign: verdict?.foreign ?? 0,
        dims: verdict?.dims ?? [],
        checked: census.checkable,
        problems: census.problems.map(problem => ({ kind: problem.kind, detail: problem.detail })),
      })
    }
    const present = new Set(files)
    return { bases, pendingBases: palaces.filter(palace => !present.has(palace.dbName)).length }
  }

  /**
   * Что замечено о языке дворца в этой сессии: язык диалога и принято ли уже решение.
   *
   * Живёт в процессе, а не в базе: язык диалога — наблюдение над текущей сессией,
   * и после перезапуска его заново даст первая же реплика человека.
   */
  const dialogueWatch = { language: undefined as EngramLanguage | undefined, decided: false }

  /**
   * Дворец выставляет язык сам, когда опора — диалог (решение 21.10, случаи 1–2):
   * диалоги есть, базы или нет, или они на том же языке — тогда просто настраиваемся
   * на язык диалогов и не о чем рассуждать. Спрашиваем человека только когда опоры нет
   * (`ask`) или базы стоят на другом языке (`mismatch`) — это дело окна в панели.
   *
   * Записываем один раз за процесс: если язык уже пришёл из настройки, наблюдение
   * только запоминается для панели, а конфигурация не трогается.
   * @param language - язык, на котором говорит человек.
   */
  const observeDialogueLanguage = (language: EngramLanguage): void => {
    dialogueWatch.language = language
    if (dialogueWatch.decided) return
    dialogueWatch.decided = true
    if (languageSetting !== undefined && languageSetting !== 'auto') return
    void (async () => {
      const { bases } = await baseStates()
      const standing = languageOfLabels(bases.map(base => base.label))
      // Базы на другом языке — не наше решение: это расхождение, его показывает окно.
      if (standing !== null && standing !== language) return
      const reason = await writePalaceLanguageWithRetry({
        settings: () => settingsOf(ctx),
        language,
        attempts: PALACE_WRITE_ATTEMPTS,
        delayMs: PALACE_WRITE_DELAY_MS,
      })
      if (reason !== undefined) console.warn(`dsh-engram: ${reason}`)
    })().catch((error: unknown) => {
      console.warn('dsh-engram: palace language persistence failed', error)
    })
  }

  /**
   * Язык дворца глазами панели: на чём основано решение и какой случай из трёх (21.10).
   *
   * Считается на каждый запрос, а не при сборке плагина: язык диалога появляется
   * посреди работы, а метку базы меняет кнопка в соседней карточке.
   * @param bases - состояния баз на момент запроса.
   * @returns Снимок для панели либо null, когда решать нечего.
   */
  const palaceLanguageState = (bases: readonly BaseView[]): RegistryView['palace'] => {
    // Язык пришёл из настройки — решать нечего, окно не нужно.
    if (languageSetting !== undefined && languageSetting !== 'auto') return null
    const dialogue = dialogueWatch.language ?? null
    const standing = languageOfLabels(bases.map(base => base.label))
    const state = palaceCase(dialogue, standing)
    return {
      setting: resolved.languageSetting ?? null,
      source: determination?.decision.source ?? 'fallback',
      conflict: determination?.decision.conflict ?? false,
      machine: determination?.machine ?? '',
      dialogue,
      bases: standing,
      state,
    }
  }

  /**
   * Поставить метку модели всем базам, которым она нужна.
   *
   * Пишем ровно одну строку в `meta` и только туда (решение 20.10): ни размерности,
   * ни времени. Идём через хранилище плагина, а не вторым соединением: у базы должен
   * быть один писатель в процессе — иначе два соединения начнут спорить за блокировку,
   * а кеш соединений останется со старым представлением о файле.
   */
  const writeBaseLabels = async (): Promise<BaseLabelResult> => {
    const written: { file: string, label: string }[] = []
    const failed: { file: string, error: string }[] = []
    if (baseTargetNow().label === undefined) return { written, failed }
    const { bases } = await baseStates()
    for (const base of bases) {
      if (base.action !== 'write-label' || base.targetLabel === null) continue
      try {
        const store = await openDb(base.file)
        await store.writeMeta(MODEL_LABEL_KEY, base.targetLabel)
        written.push({ file: base.file, label: base.targetLabel })
      } catch (error) {
        failed.push({ file: base.file, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return { written, failed }
  }

  /**
   * Пересчитать векторы базам, которые стоят не на целевой модели или растеряли их.
   *
   * Одно действие на два состояния (`convert` и `repair`): критерий у них общий —
   * строка области объявления схемы, у которой вектор пуст или его длина не равна
   * ожидаемой. Метка ставится только там, где после пересчёта она перестала быть
   * верной; у ремонта она уже верна, и трогать её незачем.
   *
   * Эмбеддер тот же, чем плагин пишет векторы при обычной записи: иначе «пересчитали»
   * означало бы «посчитали другой моделью» — и база тихо перестала бы быть ровной.
   * Длина вектора берётся из каталога: у модели без объявленной размерности пересчёт
   * не начинается, потому что проверять его было бы не на чем.
   */
  const convertBases = async (): Promise<BaseConvertResult> => {
    const result: { converted: number, empty: number, written: { file: string, label: string }[], failed: { file: string, table: string | null, error: string }[] } = {
      converted: 0,
      empty: 0,
      written: [],
      failed: [],
    }
    const dimensions = baseTargetNow().model?.dimensions
    if (dimensions === undefined) return result
    const active = await embedder
    if (active === undefined) {
      result.failed.push({ file: '*', table: null, error: message('store.embedderModelUnresolved') })
      return result
    }
    const { bases } = await baseStates()
    for (const base of bases) {
      if (base.action !== 'convert' && base.action !== 'repair') continue
      try {
        const plan = await planBaseVectors({
          path: join(resolved.dbDir, base.file),
          specs: vectorSchema.specs,
          targetBytes: dimensions * 4,
        })
        for (const problem of plan.problems) {
          result.failed.push({ file: base.file, table: null, error: `${problem.kind} — ${problem.detail}` })
        }
        // Через хранилище, а не вторым соединением: у базы один писатель в процессе.
        const store = await openDb(base.file)
        const outcome = await runVectorConvert({
          plan,
          embedder: active,
          dimensions,
          write: targets => store.rewriteVectors(targets),
        })
        result.converted += outcome.converted
        result.empty += outcome.empty
        for (const failure of outcome.failed) {
          result.failed.push({ file: base.file, table: failure.table, error: failure.error })
        }
        // Метка после полного пересчёта: частичный успех, пустой текст или проблема
        // чтения означает, что старую метку надо сохранить до следующего полного прохода.
        if (base.targetLabel !== null && base.targetLabel !== base.label
          && vectorConversionComplete(plan, outcome) && (outcome.converted > 0 || plan.rows.length === 0)) {
          await store.writeMeta(MODEL_LABEL_KEY, base.targetLabel)
          result.written.push({ file: base.file, label: base.targetLabel })
        }
      } catch (error) {
        result.failed.push({ file: base.file, table: null, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return result
  }

  /**
   * Правка словарей из панели: чтение набора и запись пользовательского слоя.
   *
   * Пишем в каталог данных (`<dbDir>/i18n/<имя>`), а не в пакет: файл поставки
   * принадлежит выпуску плагина, и правка в нём потерялась бы при первом же
   * обновлении. После записи словари перечитываются и применяются заново —
   * серверные сообщения сразу, панель по свежему снимку обслуживания.
   */
  const dictionaryDeps: RouteDeps['dictionary'] = {
    read: (set, language) => readDictionarySet({ set, language: language ?? resolved.language, dbDir: resolved.dbDir }),
    write: (set, patch, language): DictionarySaveResult => {
      const sources = { set, language: language ?? resolved.language, dbDir: resolved.dbDir }
      // Панель присылает только изменённые клетки: накладываем их на текущий слой, чтобы
      // не тронутые человеком строки не стёрлись и запрос остался соразмерен правке.
      // Текущий слой берём вместе со строками заготовки: иначе первое же сохранение
      // выбросило бы из файла все ключи, которые ещё не перевели.
      const current = layerOverrides(readDictionaryLayer(dictionaryPaths(sources).user, { keepEmptyRight: true }))
      const written = writeDictionarySet({ ...sources, entries: applyDictionaryPatch(current, patch) })
      // Перечитываем словари до снимка набора: панель должна увидеть то, что записали.
      reloadDictionaries()
      return { set, ...written, view: readDictionarySet(sources) }
    },
    /**
     * Заготовка словаря нового языка: оба набора, заголовок и все ключи без переводов.
     *
     * Файл с одним заголовком был бы пустым местом: человек открыл бы таблицу и увидел
     * ключи программы, которых в файле нет, — то есть не заготовку, а её отсутствие.
     * Поэтому в файл ложатся ровно термины набора с пустой правой частью, в порядке
     * таблицы: файл можно править и вне панели, и он же — мера полноты словаря.
     */
    create: language => DICTIONARY_SETS.map(set => {
      const blank = new Map<string, string>()
      for (const left of dictionaryTerms(set)) blank.set(left, '')
      const written = writeDictionarySet({ set, language, dbDir: resolved.dbDir, entries: blank })
      return { set, file: written.file, lines: written.written, bytes: written.bytes }
    }),
  }

  /**
   * Заполнение словаря моделью: одна партия английских строк → переводы.
   *
   * Маршрут берётся так же, как у прочих вспомогательных вызовов: переопределение из
   * настроек главнее модели текущей сессии (панель — не сессия, своего маршрута у неё
   * нет). Запрос модели пишется в op_log тем же способом, что у соседей: обещание
   * «что видел пользователь — то и записано» не должно зависеть от того, откуда вызов.
   *
   * Вместе с партией уходит словарь уже принятых переводов (`glossaryPairs`): без него
   * модель в каждой следующей партии выбирала для того же понятия другое слово, и
   * словарь переставал быть словарём. Словарь пополняется принятыми парами по ходу
   * прохода, поэтому первый проход по новому языку держит терминологию так же, как
   * повторное заполнение по готовому набору.
   */
  const dictionaryFillDeps: RouteDeps['dictionaryFill'] = async (set, rawTerms) => {
    const terms = fillBatch(rawTerms)
    const route = resolved.routeOverride ?? preStepState.route
    if (terms.length === 0) {
      return { set, provider: route?.provider ?? '', model: route?.model ?? '', translations: [] }
    }
    if (route === undefined) throw new EngramError('DICTIONARY_FILL_NO_ROUTE', message('llm.dictionaryFillNoRoute'))
    const sources = { set, language: resolved.language, dbDir: resolved.dbDir }
    const known = readDictionarySet(sources).rows
    let glossary: readonly FillPair[] = glossaryPairs(known)
    // Партия режется по числу и по длине строк (`splitFillBatch`): вывод модели растёт вместе
    // со входом, а предел вывода один на ответ — сорок длинных подсказок упирались в него и
    // теряли ответ целиком. Режем здесь, а не только в панели: тогда любой вызывающий получает
    // переводы на всё, что спросил.
    const translations: (readonly [string, string])[] = []
    let emptyAnswer: string | undefined
    /**
     * Перевести одну партию; упёрлись в предел вывода — делим партию и пробуем снова.
     *
     * Обрыв на пределе вывода — не ошибка словаря, а слишком длинное рассуждение модели:
     * живой прогон 21.10 дал партию из 21 строки, где рассуждение съело весь потолок и
     * ни одна пара не дописалась. Раньше такая партия останавливала всё заполнение
     * («модель достигла предела»), и человек видел недоделанный словарь. Половина партии
     * просит вдвое меньше вывода, поэтому повтор почти всегда проходит; глубина — два
     * деления, дальше это уже отдельная строка, и упорство там бесполезно.
     */
    const fillOne = async (batch: readonly string[], depth: number): Promise<void> => {
      const prompt = fillPrompt(batch, resolved.language, glossary)
      void openStore('user')
        .then(store => store.audit('dictionary-fill-request', 'AUX', JSON.stringify({
          route, set, language: resolved.language, terms: batch, maxTokens: FILL_MAX_TOKENS,
        })))
        .catch(() => { /* аудит не должен ломать заполнение */ })
      let text: string
      try {
        text = await streamText(ctx, {
          route,
          system: prompt.system,
          userText: prompt.userText,
          // Своей сессии у панели нет: пустой id — как у исторического бэкфилла (см. buildHistoryDeps).
          sessionId: '',
          maxTokens: FILL_MAX_TOKENS,
          purpose: 'engram-dictionary-fill',
          signal: AbortSignal.timeout(FILL_TIMEOUT_MS),
        })
      } catch (error) {
        // Ответ оборвался на пределе вывода: целые пары из начала ответа спасаем (ошибка
        // предела приносит недосказанный текст, см. llm/client.ts).
        const partial = (error as { partialText?: string }).partialText
        const salvaged = partial === undefined ? [] : parseFillAnswer(partial, batch)
        if (salvaged.length > 0) {
          translations.push(...salvaged)
          return
        }
        if (depth < FILL_SPLIT_DEPTH && batch.length > 1) {
          const half = Math.ceil(batch.length / 2)
          await fillOne(batch.slice(0, half), depth + 1)
          await fillOne(batch.slice(half), depth + 1)
          return
        }
        throw error
      }
      // Ответ модели пишется в журнал: без него «переводов нет» не разобрать, а обещание
      // «что видел пользователь — то и записано» иначе не выполняется. Срез — чтобы журнал
      // не пух от многострочных подсказок.
      void openStore('user')
        .then(store => store.audit('dictionary-fill-answer', 'AUX', answerSnippet(text, 2000)))
        .catch(() => { /* аудит не должен ломать заполнение */ })
      const parsed = parseFillAnswer(text, batch)
      // Партия без переводов — та же история, что обрыв: модель не справилась с объёмом.
      if (parsed.length === 0) {
        if (depth < FILL_SPLIT_DEPTH && batch.length > 1) {
          const half = Math.ceil(batch.length / 2)
          await fillOne(batch.slice(0, half), depth + 1)
          await fillOne(batch.slice(half), depth + 1)
          return
        }
        emptyAnswer ??= text
        return
      }
      translations.push(...parsed)
      // Принятые пары становятся словарём для следующих партий: понятие, названное в
      // одной партии, называется тем же словом и в следующей.
      glossary = glossaryPairs([
        ...known,
        ...translations.map(([left, right]) => ({ left, right })),
      ])
    }
    // Партия режется по числу и по длине строк (`splitFillBatch`): вывод модели растёт вместе
    // со входом, а предел вывода один на ответ — сорок длинных подсказок упирались в него и
    // теряли ответ целиком. Режем здесь, а не только в панели: тогда любой вызывающий получает
    // переводы на всё, что спросил.
    for (const batch of splitFillBatch(terms)) await fillOne(batch, 0)
    if (translations.length === 0) {
      // В сообщении — срез ответа: без него «модель не дала переводов» не разобрать.
      throw new EngramError('DICTIONARY_FILL_EMPTY', message('llm.dictionaryFillEmptyAnswer', {
        snippet: answerSnippet(emptyAnswer ?? ''),
      }))
    }
    return { set, provider: route.provider, model: route.model, translations }
  }

  /**
   * Языки интерфейса, которые приходят словарём из файла.
   *
   * Хост знает только те языки, которые ему объявили плагины, поэтому язык, добавленный
   * файлом реестра и словарём, без этой строки оставался бы в списке выбора дворца и
   * отсутствовал в списке языков интерфейса. Сюда попадают только языки без вшитого
   * набора панели: у `zh`, `en` и `ru` словарь приходит кодом клиента, и второй слой
   * из файла спорил бы с ним, а не дополнял.
   */
  const localePacksDeps: RouteDeps['localePacks'] = () => registry.languages
    .filter(row => !PANEL_BUILTIN_LANGUAGES.includes(row.code))
    .map(row => ({
      code: row.code,
      label: row.label,
      entries: Object.fromEntries(loadPanelDictionary({ language: row.code, dbDir: resolved.dbDir }).entries),
    }))
    // Язык без единого слова не объявляем: пустой словарь превратил бы переключатель
    // в пункт, который ничего не меняет, — человек решил бы, что язык не сработал.
    .filter(pack => Object.keys(pack.entries).length > 0)

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
    ...resolveJevField(ctx, resolved.jev, resolved.dbDir, () => (resolved.routeOverride ?? preStepState.route)?.provider),
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
        return { ok: false, reason: message('core.backfillBusy') }
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
          console.warn(message('core.warnHistoryBackfillFailed'), error)
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
    // 面板覆盖免缓存装配：поставщик судьи читает jev-config.json в момент вызова инструмента,
    // поэтому сохранение в панели действует сразу, без перезапуска DSH.
    // Читатель маршрута ленивый: инструменты регистрируются до первой сессии, и
    // провайдер берётся в момент вопроса, а не в момент регистрации.
    ...resolveJevField(ctx, resolved.jev, resolved.dbDir, () => preStepState.route?.provider),
    queryRewrite: resolved.queryRewrite,
    exportDir: `${resolved.dbDir}/exports`,
    language: resolved.language,
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
      closeStores,
      projects: projectsDeps,
      exportDir: `${resolved.dbDir}/exports`,
      mirrorDir: `${resolved.dbDir}/palaces`,
      dbDir: resolved.dbDir,
      pluginVersion: VERSION,
      language: resolved.language,
      registry: () => registryView,
      dictionaryLanguages: languagesWithDictionary,
      baseStates,
      palaceLanguage: palaceLanguageState,
      writeBaseLabels,
      convertBases,
      writePalaceLanguage: async (language: string) => {
        const reason = await writePalaceLanguage(settingsOf(ctx), language)
        // Язык записан — с этого момента базы подписываются и пересчитываются под него,
        // не дожидаясь перезапуска: иначе «Выполнить» оставило бы базы на прежнем языке.
        if (reason === undefined) basesLanguage = language
        return reason === undefined ? { ok: true, language } : { ok: false, language, error: reason }
      },
      palaceChangeWindowSec: resolved.palaceChangeWindowSec,
      // Предохранитель смены языка живёт на сервере: он сам помнит, когда открылось окно и
      // на каком языке стояли базы в этот момент. Клиент больше не присылает ни начала
      // отсчёта, ни «языка, от которого уходят» — проверяется состояние, а не присланное
      // (решение 24.10 после ревью #36).
      palaceGuard,
      palaceCurrentLanguage: async () => basesLanguage,
      dictionary: dictionaryDeps,
      dictionaryFill: dictionaryFillDeps,
      localePacks: localePacksDeps,
      convertAvailable: true,
      embedder,
      // Настройки Jev для панели: база из cordis.yml, каталог файла перекрытия и мост
      // к хосту — список провайдеров DSH и сборка соединения с их адресом и ключом.
      jev: {
        base: resolved.jev,
        dbDir: resolved.dbDir,
        host: {
          catalog: () => readJevCatalog(ctx),
          models: provider => readProviderModels(ctx, provider),
          connection: (provider, model, timeoutMs, endpoint) =>
            resolveJevConnection(ctx, provider, model, timeoutMs, endpoint),
        },
      },
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
    ctx.on('agent/pre-step', (payload, next) => preStep(ctx, openStore, openStoreForProjectCwd, resolved, embedder, preStepState, logIngestRequest, observeDialogueLanguage, payload, next), { prepend: true })
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
        ...resolveJevField(ctx, resolved.jev, resolved.dbDir, () => (resolved.routeOverride ?? routeFromEvents(events))?.provider),
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
          console.warn(message('core.warnDisposeFinalFailed'), error)
        })
    })
  }

  if (resolved.reflect !== 'off') {
    // 信念巩固：disposed 是 fire-and-forget 观察器。auto 后台巩固（user 库 + cwd 已建库的项目库）；
    // suggest 只登记 reflect-pending（出口是 engram_reflect 工具）。与末轮摄取相互独立——
    // reflect 取材幂等（已成为信念证据的记忆排除），并发漏抓由下次会话结束或手动调用补。
    // 必须就地吞掉所有异常：宿主把未处理 rejection 当致命错误（见上一个 disposed 监听）。
    ctx.on('session/disposed', (session) => {
      // dispose 后事件源可能 detach：事件快照与 cwd 在同步段取一次。
      const events = session.snapshotEvents() as unknown as readonly SessionEventLike[]
      const sessionId = String(session.id)
      const cwd = sessionCwd(session)
      const route = resolved.routeOverride ?? routeFromEvents(events)
      const targets: { scope: EngramScope; open: () => Promise<EngramStore> }[] = [
        { scope: 'user', open: () => openStore('user') },
      ]
      // 项目宫殿仅处理库文件已存在的，避免为一次性 cwd 建空库（与衰减调度同纪律）。
      if (cwd !== undefined && existsSync(join(resolved.dbDir, dbNameForCwd(cwd)))) {
        targets.push({ scope: 'project', open: () => openStoreForProjectCwd(cwd) })
      }
      void (async () => {
        for (const target of targets) {
          try {
            const store = await target.open()
            if (resolved.reflect === 'suggest') {
              const detail = JSON.stringify({ scope: target.scope, sessionId })
              if (!await store.hasAudit('reflect-pending', detail)) {
                await store.audit('reflect-pending', 'AUX', detail)
              }
              continue
            }
            // auto：会话没有模型请求时取不到路由，跳过本次（下次会话补）。
            if (route === undefined) continue
            const outcome = await reflectObservations({
              store,
              embedder: await embedder,
              scope: target.scope,
              call: params => streamText(ctx, { ...params, sessionId: session.id }),
              logRequest: data => {
                void store.audit('reflect-request', 'AUX', JSON.stringify(data)).catch(() => { /* 审计失败不影响巩固 */ })
              },
              route,
              signal: AbortSignal.timeout(FINAL_INGEST_TIMEOUT_MS),
            })
            if (outcome.formed + outcome.refined + outcome.confirmed + outcome.refuted > 0) {
              console.log(message('core.logReflectDone', {
                scope: target.scope,
                formed: outcome.formed,
                refined: outcome.refined,
                confirmed: outcome.confirmed,
                refuted: outcome.refuted,
              }))
            }
          } catch (error) {
            console.warn(message('core.warnReflectFailed', { scope: target.scope }), error)
          }
        }
      })()
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
      targets.push({ label: message('core.decayTargetProject', { title: palace.title }), open: () => openDb(palace.dbName) })
    }
    for (const target of targets) {
      const archived = await (await target.open()).decay({
        importanceBelow: resolved.decayImportanceBelow,
        olderThanDays: resolved.decayAfterDays,
      })
      if (archived > 0) console.warn(message('core.warnDecayArchived', { label: target.label, count: archived }))
    }
  }
  void runDecay().catch((error: unknown) => {
    console.warn(message('core.warnDecayStartupFailed'), error)
  })
  ctx.effect(
    () => {
      const timer = setInterval(() => {
        void runDecay().catch((error: unknown) => {
          console.warn(message('core.warnDecayPeriodicFailed'), error)
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
      console.log(message('core.logConsolidationDone', {
        archived: report.archived,
        merged: report.merged,
        skipped: report.skipped,
        ms: report.tookMs,
      }))
    } catch (error) {
      console.warn(message('core.warnConsolidationFailed'), error)
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
