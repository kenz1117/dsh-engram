/**
 * 历史会话回填：把 dsh 持久化的历史会话逐轮摄取进记忆宫殿。
 *
 * 设计要点：
 * 1. **复用实时摄取管线**——内层直接调用 `ingestPreviousTurn` 的 `slice=<turn>` 模式，
 *    提炼、脱敏、防回声、幂等键全部沿用，不另建管线；
 * 2. **按会话 cwd 分库**——历史会话写进它自己项目的库（`writeScope: 'project'`），
 *    避免跨项目内容串库；无 cwd 的会话只能进 user 库（默认仍跳过）；
 * 3. **先估算后执行**——估算给出「候选会话数 / 规则内轮数 / 真正待处理轮数」，
 *    并在估算阶段避免创建空库；
 * 4. **成本可控**——时间窗、单会话轮数、单次总轮数三重限额 + 复用摄取节流
 *    （低活动/寒暄/禁记跳过）+ 显式触发（不做后台自动跑）；
 * 5. **可中断续跑**——幂等键是 (sessionId, turn)，中断后重跑只补未完成的轮次；
 *    历史条目写入不进入 SM-2 复习队列（否则一次性回填会淹没今日待回忆）。
 * @module @kenz1117/dsh-engram/ingest/history
 */

import type { ResolvedHistoryRules } from '../config.ts'
import type { EngramEmbedder } from '../embedder/interface.ts'
import type { LlmRoute, SessionEventLike } from '../llm/client.ts'
import type { EngramStore } from '../store/interface.ts'
import type { EngramScope } from '../types.ts'
import { INGEST_DONE_OP, encodeTurnKey, ingestPreviousTurn } from './hook.ts'
import type { IngestDeps, IngestMode } from './hook.ts'

/** 历史会话 header 的窄视图（session-persistence 的 SessionHeader 子集，只依赖用到的字段）。 */
export interface HistorySessionHeader {
  /** 会话 id（字符串形式）。 */
  readonly id: string
  /** 创建时间（Unix 毫秒）。 */
  readonly createdAt: number
  /** 会话所属工作目录；缺失 = 无法归属项目分库。 */
  readonly cwd?: string | undefined
  /** 是否为种子会话（脚手架生成，无真实内容）。 */
  readonly isSeeded?: boolean | undefined
  /** 来源标记；`subagent` = 子代理会话（噪声，默认跳过）。 */
  readonly origin?: string | undefined
}

/** 历史会话日志来源（sessionPersistence 的窄视图；宿主侧经只读句柄 open/read 读取）。 */
export interface HistoryLogSource {
  /** 列出全部已持久化会话的 header（宿主接口不分页不过滤）。 */
  list(signal?: AbortSignal): Promise<readonly HistorySessionHeader[]>
  /** 读取单个会话的完整事件日志。 */
  load(id: string): Promise<{ events: readonly unknown[] }>
}

/** 回填规则覆盖项（面板/工具按次传入；未给字段沿用配置默认值）。 */
export interface HistoryBackfillRules {
  readonly days?: number
  readonly maxTurnsPerSession?: number
  readonly maxTotalTurns?: number
  readonly includeSubagents?: boolean
  readonly includeSeeded?: boolean
  readonly includeNoCwd?: boolean
  /** 辅助调用模型的 provider（与 model 成对给出；缺省用当前可用路由）。 */
  readonly provider?: string
  /** 辅助调用模型的 model id（与 provider 成对给出）。 */
  readonly model?: string
}

/** 被规则排除的会话计数（面板解释「为什么只有 N 个候选」）。 */
export interface HistorySkipCounts {
  /** 子代理会话。 */
  readonly subagent: number
  /** 种子会话。 */
  readonly seeded: number
  /** 无 cwd 会话。 */
  readonly noCwd: number
  /** 早于时间窗。 */
  readonly tooOld: number
  /** 日志读取失败（文件损坏/编码不匹配）。 */
  readonly unreadable: number
}

/** 估算结果：先看数，再决定跑不跑。 */
export interface HistoryEstimate {
  /** 本次生效的完整规则（默认值与覆盖项合并后的结果）。 */
  readonly rules: ResolvedHistoryRules
  /** 通过过滤的候选会话数。 */
  readonly candidates: number
  /** 规则内可摄取的轮数（按单会话与总轮数上限截断后）。 */
  readonly eligibleTurns: number
  /** 真正待处理的轮数（已扣掉此前已摄取的轮次）。 */
  readonly pendingTurns: number
  /** 此前已摄取、本次会自动跳过的轮数。 */
  readonly alreadyIngested: number
  /** 被规则排除的会话计数。 */
  readonly skipped: HistorySkipCounts
  /** 是否因总轮数上限被截断（还有候选会话没排进来）。 */
  readonly truncated: boolean
  /** 环境不支持时的说明（source 缺失）；有值时其余字段无意义。 */
  readonly unavailable?: string
}

/** 执行进度（面板轮询 / 工具输出用）。 */
export interface HistoryRunProgress {
  /** 状态；failed = 整批因环境/依赖错误中断（单轮失败只计入 turnsFailed）。 */
  readonly state: 'running' | 'done' | 'cancelled' | 'failed'
  /** 候选会话总数。 */
  readonly sessionsTotal: number
  /** 已处理会话数。 */
  readonly sessionsDone: number
  /** 计划处理的轮数。 */
  readonly turnsPlanned: number
  /** 已完成处理的轮数（含跳过与失败）。 */
  readonly turnsDone: number
  /** 本轮运行写入的记忆条数。 */
  readonly memoriesWritten: number
  /** 因节流/无内容/已摄取而跳过的轮数。 */
  readonly turnsSkipped: number
  /** 失败轮数。 */
  readonly turnsFailed: number
  /** 跳过原因分布（如 low-activity / chitchat / no-user-content / already-ingested）。 */
  readonly skipReasons: Readonly<Record<string, number>>
  /** 当前正在处理的会话 id。 */
  readonly currentSession?: string | undefined
}

/** 执行结果。 */
export interface HistoryRunResult extends HistoryRunProgress {
  /** 失败明细（面板展示前 N 条）。 */
  readonly failures: readonly { sessionId: string; turn: number; reason: string }[]
}

/** 历史回填的依赖。 */
export interface HistoryBackfillDeps {
  /** 会话日志来源；undefined = 当前环境不提供持久化（功能不可用，如 headless）。 */
  readonly source: HistoryLogSource | undefined
  /** 按会话 cwd 打开（必要时创建）目标分库。 */
  readonly resolveStore: (cwd: string) => Promise<EngramStore>
  /** 按会话 cwd 打开已存在的目标分库；库文件不存在返回 undefined（估算用，避免创建空库）。 */
  readonly resolveExistingStore: (cwd: string) => Promise<EngramStore | undefined>
  /** user 分库打开器（无 cwd 会话的落点）。 */
  readonly openUserStore: () => Promise<EngramStore>
  /** user 分库若已存在则打开，否则 undefined（估算用，避免创建空库）。 */
  readonly resolveExistingUserStore: () => Promise<EngramStore | undefined>
  readonly embedder: Promise<EngramEmbedder | undefined>
  readonly mode: Exclude<IngestMode, 'off'>
  readonly routeOverride: LlmRoute | undefined
  readonly call: IngestDeps['call']
  readonly logRequest: IngestDeps['logRequest']
  /** 时间基准（测试可注入）。 */
  readonly now?: () => number
}

/** 参与处理的会话（含按 cwd 解析出的落点）。 */
interface CandidateSession {
  readonly header: HistorySessionHeader
  readonly events: readonly SessionEventLike[]
  /** 规则内允许处理的轮次号（升序，已按单会话上限取最近若干轮）。 */
  readonly turns: readonly number[]
  /** 目标分库打开器。 */
  readonly openStore: () => Promise<EngramStore>
  /** 写入的作用域标记（有 cwd → project，无 cwd → user）。 */
  readonly writeScope: EngramScope
  /** 该会话的唯一键（同 cwd 的库内幂等；无 cwd 用固定标记）。 */
  readonly storeKey: string
}

const DAY_MS = 86_400_000
/** 估算时并发读取的会话数（读取是 IO，适度并发；摄取阶段始终串行）。 */
const ESTIMATE_CONCURRENCY = 4

/**
 * 合并规则：默认值来自 Config，覆盖项来自面板/工具；总轮数上限是硬顶（只能调低）。
 * @param defaults - 配置默认规则。
 * @param overrides - 本次覆盖项。
 * @returns 生效规则。
 * @throws 覆盖项越界时抛错（与配置校验同界）。
 */
export function mergeHistoryRules(defaults: ResolvedHistoryRules, overrides: HistoryBackfillRules): ResolvedHistoryRules {
  const days = overrides.days ?? defaults.days
  if (!Number.isInteger(days) || days < 0 || days > 3650) throw new Error('historyBackfill: days 必须是 [0, 3650] 的整数（0 = 不限）')
  const maxTurnsPerSession = overrides.maxTurnsPerSession ?? defaults.maxTurnsPerSession
  if (!Number.isInteger(maxTurnsPerSession) || maxTurnsPerSession < 1 || maxTurnsPerSession > 500) {
    throw new Error('historyBackfill: maxTurnsPerSession 必须是 [1, 500] 的整数')
  }
  const maxTotalTurns = overrides.maxTotalTurns ?? defaults.maxTotalTurns
  if (!Number.isInteger(maxTotalTurns) || maxTotalTurns < 1 || maxTotalTurns > 5000) {
    throw new Error('historyBackfill: maxTotalTurns 必须是 [1, 5000] 的整数')
  }
  // 辅助模型必须成对给（只给一半是配置错误，loud 失败而不是静默忽略）。
  const hasProvider = overrides.provider !== undefined && overrides.provider !== ''
  const hasModel = overrides.model !== undefined && overrides.model !== ''
  if (hasProvider !== hasModel) {
    throw new Error('historyBackfill: provider 与 model 必须成对提供')
  }
  return {
    days,
    maxTurnsPerSession,
    // 硬顶：本次请求不能突破配置上限。
    maxTotalTurns: Math.min(maxTotalTurns, defaults.maxTotalTurns),
    includeSubagents: overrides.includeSubagents ?? defaults.includeSubagents,
    includeSeeded: overrides.includeSeeded ?? defaults.includeSeeded,
    includeNoCwd: overrides.includeNoCwd ?? defaults.includeNoCwd,
  }
}

/** 事件流里的轮次号（按出现顺序，缺 data.turn 的 turn/start 忽略）。 */
function turnNumbers(events: readonly SessionEventLike[]): number[] {
  const turns: number[] = []
  for (const event of events) {
    if (event.type !== 'turn/start') continue
    const turn = (event.data as { turn?: unknown } | null)?.turn
    if (typeof turn === 'number' && Number.isFinite(turn)) turns.push(turn)
  }
  return turns
}

/** 单个会话的日志是否读取成功（失败返回 undefined，调用方计入 unreadable）。 */
async function loadSession(source: HistoryLogSource, id: string): Promise<readonly SessionEventLike[] | undefined> {
  try {
    const loaded = await source.load(id)
    return loaded.events as unknown as readonly SessionEventLike[]
  } catch {
    // 文件损坏或格式不匹配：跳过该会话，不中断整批。
    return undefined
  }
}

/** 过滤结果：候选会话（含事件与轮次）+ 排除计数 + 是否被总上限截断。 */
interface SelectResult {
  readonly candidates: CandidateSession[]
  readonly skipped: HistorySkipCounts
  readonly truncated: boolean
}

/**
 * 枚举并筛选可回填的会话：过滤子代理/种子/无 cwd/超窗，按单会话与总轮数上限截断。
 * @param deps - 历史回填依赖。
 * @param rules - 生效规则。
 * @returns 候选会话与排除统计。
 */
async function selectSessions(deps: HistoryBackfillDeps, rules: ResolvedHistoryRules): Promise<SelectResult> {
  const source = deps.source
  if (source === undefined) return { candidates: [], skipped: { subagent: 0, seeded: 0, noCwd: 0, tooOld: 0, unreadable: 0 }, truncated: false }
  const now = (deps.now ?? Date.now)()
  const headers = await source.list()
  const skipped = { subagent: 0, seeded: 0, noCwd: 0, tooOld: 0, unreadable: 0 }
  /** 时间窗内、需要读日志的 header（按创建时间倒序，先处理最近的）。 */
  const kept: HistorySessionHeader[] = []
  for (const header of [...headers].sort((a, b) => b.createdAt - a.createdAt)) {
    if (header.origin === 'subagent' && !rules.includeSubagents) { skipped.subagent += 1; continue }
    if (header.isSeeded === true && !rules.includeSeeded) { skipped.seeded += 1; continue }
    if ((header.cwd === undefined || header.cwd === '') && !rules.includeNoCwd) { skipped.noCwd += 1; continue }
    if (rules.days > 0 && header.createdAt < now - rules.days * DAY_MS) { skipped.tooOld += 1; continue }
    kept.push(header)
  }
  // 读取日志 + 计算轮次（有限并发，避免一次性读爆 IO）。
  const loaded: (CandidateSession | undefined)[] = []
  for (let i = 0; i < kept.length; i += ESTIMATE_CONCURRENCY) {
    const batch = kept.slice(i, i + ESTIMATE_CONCURRENCY)
    const settled = await Promise.all(batch.map(async (header): Promise<CandidateSession | undefined> => {
      const events = await loadSession(source, header.id)
      if (events === undefined) { skipped.unreadable += 1; return undefined }
      // 单会话上限：取最近的 N 轮（历史越近越有价值）。
      const all = turnNumbers(events)
      const turns = all.slice(Math.max(0, all.length - rules.maxTurnsPerSession))
      if (turns.length === 0) return undefined
      const cwd = header.cwd
      return (cwd === undefined || cwd === '')
        ? { header, events, turns, openStore: deps.openUserStore, writeScope: 'user', storeKey: 'user' }
        : {
            header,
            events,
            turns,
            openStore: () => deps.resolveStore(cwd),
            writeScope: 'project',
            storeKey: cwd,
          }
    }))
    loaded.push(...settled)
  }
  // 总轮数上限：按会话倒序累计，填满即停（超出部分标记截断）。
  const candidates: CandidateSession[] = []
  let budget = rules.maxTotalTurns
  let truncated = false
  for (const candidate of loaded) {
    if (candidate === undefined) continue
    if (budget <= 0) { truncated = true; continue }
    const allowed = candidate.turns.slice(Math.max(0, candidate.turns.length - budget))
    if (allowed.length < candidate.turns.length) truncated = true
    candidates.push({ ...candidate, turns: allowed })
    budget -= allowed.length
  }
  return { candidates, skipped, truncated }
}

/** 环境不支持读取历史会话时的统一说明。 */
const UNAVAILABLE_REASON = '当前环境未挂载会话持久化服务（会话日志不可读，例如 headless 组合），无法回填历史会话'

/**
 * 估算：候选会话数、规则内轮数、以及扣掉已摄取后的真正待处理轮数。
 * 估算阶段只在库文件已存在时打开目标库（不创建空库、不写入）。
 * @param deps - 历史回填依赖。
 * @param defaults - 配置默认规则。
 * @param overrides - 本次覆盖项。
 * @returns 估算结果；环境不支持时 `unavailable` 有值。
 */
export async function estimateHistoryBackfill(
  deps: HistoryBackfillDeps,
  defaults: ResolvedHistoryRules,
  overrides: HistoryBackfillRules = {},
): Promise<HistoryEstimate> {
  const rules = mergeHistoryRules(defaults, overrides)
  if (deps.source === undefined) {
    return { rules, candidates: 0, eligibleTurns: 0, pendingTurns: 0, alreadyIngested: 0, skipped: { subagent: 0, seeded: 0, noCwd: 0, tooOld: 0, unreadable: 0 }, truncated: false, unavailable: UNAVAILABLE_REASON }
  }
  const { candidates, skipped, truncated } = await selectSessions(deps, rules)
  let eligibleTurns = 0
  let alreadyIngested = 0
  for (const candidate of candidates) {
    eligibleTurns += candidate.turns.length
    // 只查「已存在」的库：从未用过的项目 cwd 不因估算而产生空库文件。
    const store = candidate.writeScope === 'user'
      ? await deps.resolveExistingUserStore()
      : await deps.resolveExistingStore(candidate.storeKey)
    if (store === undefined) continue
    for (const turn of candidate.turns) {
      if (await store.hasAudit(INGEST_DONE_OP, encodeTurnKey(candidate.header.id, turn))) alreadyIngested += 1
    }
  }
  return {
    rules,
    candidates: candidates.length,
    eligibleTurns,
    pendingTurns: eligibleTurns - alreadyIngested,
    alreadyIngested,
    skipped,
    truncated,
  }
}

/**
 * 执行回填：逐会话、逐轮调用实时摄取管线；单轮失败只记录并继续，中断后重跑只补未完成轮次。
 * @param deps - 历史回填依赖。
 * @param defaults - 配置默认规则。
 * @param overrides - 本次覆盖项。
 * @param onProgress - 进度回调（每个会话结束时调用一次）。
 * @param signal - 取消信号（面板「暂停」/工具超时）。
 * @returns 运行结果。
 */
export async function runHistoryBackfill(
  deps: HistoryBackfillDeps,
  defaults: ResolvedHistoryRules,
  overrides: HistoryBackfillRules,
  onProgress: (progress: HistoryRunProgress) => void,
  signal: AbortSignal,
): Promise<HistoryRunResult> {
  const rules = mergeHistoryRules(defaults, overrides)
  const { candidates } = deps.source === undefined
    ? { candidates: [] as CandidateSession[] }
    : await selectSessions(deps, rules)
  // 规则显式指定辅助模型时覆盖默认路由；否则沿用 deps 的路由（配置覆盖 > 当前在用的模型）。
  const routeOverride = overrides.provider !== undefined && overrides.model !== undefined
    ? { provider: overrides.provider, model: overrides.model }
    : deps.routeOverride
  const failures: { sessionId: string; turn: number; reason: string }[] = []
  /** 内部可变累加器（对外以只读的 HistoryRunProgress 暴露）。 */
  const progress: {
    state: HistoryRunProgress['state']
    sessionsTotal: number
    sessionsDone: number
    turnsPlanned: number
    turnsDone: number
    memoriesWritten: number
    turnsSkipped: number
    turnsFailed: number
    skipReasons: Record<string, number>
    currentSession?: string | undefined
  } = {
    state: 'running',
    sessionsTotal: candidates.length,
    sessionsDone: 0,
    turnsPlanned: candidates.reduce((sum, candidate) => sum + candidate.turns.length, 0),
    turnsDone: 0,
    memoriesWritten: 0,
    turnsSkipped: 0,
    turnsFailed: 0,
    skipReasons: {},
  }
  onProgress({ ...progress })
  for (const candidate of candidates) {
    if (signal.aborted) break
    for (const turn of candidate.turns) {
      if (signal.aborted) break
      try {
        const outcome = await ingestPreviousTurn({
          events: candidate.events,
          sessionId: candidate.header.id,
          turn,
          slice: turn,
          openStore: () => candidate.openStore(),
          embedder: deps.embedder,
          mode: deps.mode,
          routeOverride,
          call: deps.call,
          logRequest: deps.logRequest,
          signal,
          // 历史轮次同样节流（省调用），且写入不进入复习调度。
          throttle: true,
          history: true,
          writeScope: candidate.writeScope,
        })
        progress.memoriesWritten += outcome.written
        if (outcome.skipped !== null) {
          progress.turnsSkipped += 1
          progress.skipReasons[outcome.skipped] = (progress.skipReasons[outcome.skipped] ?? 0) + 1
        }
      } catch (error) {
        // 单轮失败（限流/超时/解析失败）不中断整批；重跑时该轮会再试。
        progress.turnsFailed += 1
        failures.push({ sessionId: candidate.header.id, turn, reason: error instanceof Error ? error.message : String(error) })
      }
      progress.turnsDone += 1
    }
    progress.sessionsDone += 1
    onProgress({ ...progress, currentSession: candidate.header.id })
  }
  const state = signal.aborted ? 'cancelled' : 'done'
  onProgress({ ...progress, state })
  return { ...progress, state, failures }
}
