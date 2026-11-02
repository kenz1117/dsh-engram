/**
 * 信念巩固（Reflect）：把尚未成为任何信念证据的原始记忆交辅助 LLM 巩固为一句话信念
 * （observation），并对被新证据波及的 stale 信念做新鲜度复核。
 *
 * 与 flywheel/distill 的区别：蒸馏是「合并归档」（旧记忆进 supersedes 链后消失于 active），
 * 巩固是「抽象叠加」（原始记忆全部保留，信念是带证据引用的额外一层；同一主题经向量近邻
 * 归并持续细化同一条，而非反复新增）。
 *
 * 四个动作：
 * - form   ：从新证据形成信念；向量近邻达到阈值时并入既有信念（refine），否则新建
 * - refine ：重写 stale 信念的表述并并入新证据（status 回 active）
 * - still  ：stale 信念经证据复核仍成立（仅刷新复核时间）
 * - refute ：stale 信念被证据否定（status 置 refuted，保留证据链供审计）
 * @module @kenz1117/dsh-engram/consolidation/reflect
 */

import { isMaxTokensError, parseJsonArray } from '../llm/client.ts'
import type { LlmRoute } from '../llm/client.ts'
import type { EngramEmbedder } from '../embedder/interface.ts'
import type { EngramStore } from '../store/interface.ts'
import type { EngramScope, MemoryId, MemoryRecord, ObservationId } from '../types.ts'
import { asMemoryId, asObservationId } from '../types.ts'
import { message } from '../i18n/messages.ts'

/** 取材池大小：从 active 记忆按 importance/confidence 倒序扫描的上限。 */
const REFLECT_POOL = 300
/** 单次巩固喂给 LLM 的新证据条数上限（协议内常量：单次辅助调用的可控上下文）。 */
const REFLECT_MAX_INPUT = 30
/** 单次 LLM 调用的候选分片大小（#45：30 条候选一次调用必然超输出预算整批丢弃；分片后单片失败只丢该片）。 */
const REFLECT_CHUNK = 10
/** 候选原文截断字符数（#45：与 stale 证据的 REFLECT_EVIDENCE_SLICE 同纪律——候选此前整篇进 prompt）。 */
const REFLECT_CANDIDATE_SLICE = 200
/** 单次喂给 LLM 的待复核 stale 信念上限。 */
const REFLECT_MAX_STALE = 5
/** 单条 stale 信念附带的证据原文条数上限。 */
const REFLECT_STALE_EVIDENCE_LIMIT = 6
/** stale 证据原文截断字符数（控制总上下文）。 */
const REFLECT_EVIDENCE_SLICE = 120
/** 输出预算按批量缩放：底价 + 单动作配额，封顶 8000（#45 实测 10 动作需 ~8000；推理模型的
    reasoning_tokens 计入 completion 预算，固定 900 对 30 动作必然截断）。 */
const REFLECT_TOKENS_BASE = 400
const REFLECT_TOKENS_PER_ACTION = 500
const REFLECT_TOKENS_CAP = 8000
/** 信念向量近邻归并阈值：新信念与既有信念余弦达到该值则并入同一条（持续细化）。 */
const REFLECT_MERGE_THRESHOLD = 0.9
/** 新鲜度阈值：新证据与既有信念余弦达到该值（低于归并阈值，语义更宽）则把信念标 stale 待复核。 */
const REFLECT_STALE_THRESHOLD = 0.86

/**
 * Системная инструкция закрепления: текст живёт в словаре (`llm.reflectSystem`),
 * берётся в момент вызова. Маркеры секций подставляются теми же ключами, что и
 * сборка материала ниже, — инструкция и материал обязаны называть их одинаково.
 */
function reflectSystemPrompt(): string {
  return message('llm.reflectSystem', {
    newMark: message('llm.reflectMarkerNewMemories'),
    reviewMark: message('llm.reflectMarkerBeliefs'),
  })
}

/** 巩固辅助调用的日志事件负载。 */
export interface ReflectRequestEventData {
  readonly route: LlmRoute
  readonly scope: EngramScope
  readonly candidateCount: number
  readonly staleCount: number
  readonly maxTokens: number
}

/** 巩固结果摘要。 */
export interface ReflectOutcome {
  /** 取材池扫描条数。 */
  readonly pool: number
  /** 本次喂入的新证据条数。 */
  readonly candidates: number
  /** 本次喂入的待复核信念条数。 */
  readonly staleReviewed: number
  /** 新建信念数。 */
  readonly formed: number
  /** 并入既有/细化 stale 信念的次数。 */
  readonly refined: number
  /** 复核维持数。 */
  readonly confirmed: number
  /** 复核否定数。 */
  readonly refuted: number
  /** 无效动作跳过数（引用越界/字段缺失）。 */
  readonly skipped: number
  /**
   * 整批丢弃的候选数（#45 失败可见性）：所在分片输出超预算且对半到单片仍超限、
   * 或解析失败时，该片候选计入此处。0 = 无丢弃。这些候选未被巩固（无信念引用），
   * 下次巩固仍会取材。
   */
  readonly dropped: number
}

/**
 * 巩固输出预算：底价 + 按本片动作数缩放，封顶 REFLECT_TOKENS_CAP。#45 实测 10 动作需
 * ~8000 tokens；推理模型的 reasoning_tokens 计入 completion 预算，固定小预算对大批必然
 * 截断——预算必须随喂入量走，而不是拍一个常数。
 */
function reflectMaxTokens(actionCount: number): number {
  return Math.min(REFLECT_TOKENS_CAP, REFLECT_TOKENS_BASE + REFLECT_TOKENS_PER_ACTION * actionCount)
}

/**
 * 单片巩固的确定性失败（#45 分片自愈的内部信号）：max-tokens 由调用层对半递归重试，
 * unparseable 由调用层把该片候选计入 dropped。网络等瞬时错误不用它承载、原样上抛
 * （整批失败仍由 reflectObservations 抛给调用层，由调用层决定是否落 pending）。
 */
class ReflectBatchFailure extends Error {
  constructor(readonly reason: 'unparseable' | 'max-tokens') {
    super('reflect-batch-failure')
    this.name = 'ReflectBatchFailure'
  }
}

/** 巩固依赖。 */
export interface ReflectDeps {
  readonly store: EngramStore
  /** 嵌入器；undefined 时不做近邻归并，form 一律新建信念。 */
  readonly embedder: EngramEmbedder | undefined
  readonly scope: EngramScope
  /** 辅助 LLM 调用（index.ts 用 ctx.llm.stream 构造）。 */
  readonly call: (params: { route: LlmRoute; system: string; userText: string; maxTokens: number; purpose: string; signal: AbortSignal }) => Promise<string>
  readonly logRequest: (data: ReflectRequestEventData) => void
  readonly route: LlmRoute
  readonly signal: AbortSignal
}

/**
 * 执行一次信念巩固。纯异步：LLM/解析失败抛错（调用层决定是否落 pending），
 * 单条动作的写入失败计入 skipped 不中断整批。
 */
export async function reflectObservations(deps: ReflectDeps): Promise<ReflectOutcome> {
  // 对外字段 readonly；函数内用 satisfies 保留可变字面量类型做累加，返回时结构兼容只读接口。
  const outcome = {
    pool: 0, candidates: 0, staleReviewed: 0, formed: 0, refined: 0, confirmed: 0, refuted: 0, skipped: 0, dropped: 0,
  } satisfies ReflectOutcome

  // 1. 取材：active 池中排除已被 active/stale 信念引用为证据的记忆（幂等——已巩固不重复）。
  const pool = await deps.store.topActive(deps.scope, REFLECT_POOL)
  outcome.pool = pool.length
  const known = await deps.store.listObservations({ limit: 1000 })
  const evidenced = new Set<string>()
  for (const observation of known) {
    if (observation.status === 'refuted') continue
    for (const sourceId of observation.sourceIds) evidenced.add(String(sourceId))
  }
  const candidates = pool.filter(record => !evidenced.has(String(record.id))).slice(0, REFLECT_MAX_INPUT)

  // 2. 新鲜度扫描（嵌入可用）：新证据与某 active 信念近邻达到 stale 阈值时，先把信念标 stale，
  // 与本次材料一起交给 LLM 复核（先对原始事实验证，再决定维持/细化/否定）。
  if (deps.embedder !== undefined && candidates.length > 0) {
    const vectors = await deps.embedder.embed(candidates.map(record => record.content))
    const staleMarks = new Set<string>()
    for (const vector of vectors) {
      if (vector === undefined) continue
      const nearest = await deps.store.nearestObservation(vector)
      if (nearest !== undefined
        && nearest.record.status === 'active'
        && nearest.similarity >= REFLECT_STALE_THRESHOLD) {
        staleMarks.add(String(nearest.record.id))
      }
    }
    for (const id of staleMarks) {
      try {
        await deps.store.markObservationStale(asObservationId(id))
      } catch {
        /* 标记失败不阻断巩固（该信念保持 active，下次扫描再试） */
      }
    }
  }

  const stale = (await deps.store.listObservations({ status: 'stale', limit: REFLECT_MAX_STALE }))
  outcome.candidates = candidates.length
  outcome.staleReviewed = stale.length
  if (candidates.length === 0 && stale.length === 0) return outcome

  // 2. 组装与调用按 REFLECT_CHUNK 分片（#45）：单片失败（输出超预算对半到单片仍超限、
  //    解析失败）只丢该片并计入 dropped——信念巩固对超长候选自愈、失败可见；stale 复核搭
  //    第一片的车（动作只能引用本片上下文里出现过的 id）。
  const staleIds = new Set(stale.map(observation => String(observation.id)))
  /**
   * 单片巩固：组装（候选原文截断）→调用（预算按批量缩放）→解析→逐动作落库。
   * 输出超预算抛 ReflectBatchFailure('max-tokens') 供上层对半递归；解析失败抛
   * ReflectBatchFailure('unparseable') 由上层计入 dropped；网络等错误原样上抛。
   */
  const applySlice = async (slice: readonly MemoryRecord[], includeStale: boolean): Promise<void> => {
    const sliceIds = new Set(slice.map(record => String(record.id)))
    const sections: string[] = []
    if (slice.length > 0) {
      const lines = slice.map(record => `[${String(record.id)}] (${record.kind}, importance ${record.importance.toFixed(2)}) ${record.content.slice(0, REFLECT_CANDIDATE_SLICE)}`)
      sections.push(`${message('llm.reflectMarkerNewMemories')}\n${lines.join('\n')}`)
    }
    if (includeStale && stale.length > 0) {
      const blocks: string[] = []
      for (const observation of stale) {
        const evidenceRecords = await deps.store.getMany(observation.sourceIds.slice(0, REFLECT_STALE_EVIDENCE_LIMIT))
        const evidence = evidenceRecords
          .map(record => `  - ${record.content.slice(0, REFLECT_EVIDENCE_SLICE)}`)
          .join('\n')
        blocks.push(`${message('llm.reflectStaleLine', {
          id: String(observation.id),
          count: String(observation.proofCount),
          belief: observation.belief,
        })}\n${evidence}`)
      }
      sections.push(`${message('llm.reflectMarkerBeliefs')}\n${blocks.join('\n')}`)
    }
    const userText = sections.join('\n\n')
    // 预算按动作数缩放：候选 + 搭车的 stale 复核都是动作（漏计 stale 会让 stale-only
    // 调用只剩底价预算，复核必然截断且不可见）。
    const maxTokens = reflectMaxTokens(slice.length + (includeStale ? stale.length : 0))
    deps.logRequest({
      route: deps.route,
      scope: deps.scope,
      candidateCount: slice.length,
      staleCount: includeStale ? stale.length : 0,
      maxTokens,
    })
    let raw: string
    try {
      raw = await deps.call({
        route: deps.route,
        system: reflectSystemPrompt(),
        userText,
        maxTokens,
        purpose: 'engram-reflect',
        signal: deps.signal,
      })
    } catch (error) {
      // 输出超预算（finishError 的 LLM_MAX_TOKENS）归一为分片信号交上层对半递归；
      // 网络等瞬时错误原样上抛（整批失败由调用层决定是否落 pending）。
      if (isMaxTokensError(error)) throw new ReflectBatchFailure('max-tokens')
      throw error
    }
    const parsed = parseJsonArray(raw)
    if (parsed === undefined) throw new ReflectBatchFailure('unparseable')

    // 3. 逐动作落库（动作只能引用本片上下文里出现过的 id）。单条写入失败计入 skipped
    //    不中断整批，同旧实现。
    for (const item of parsed) {
      const action = item as { action?: unknown; belief?: unknown; sourceIds?: unknown; observationId?: unknown; reason?: unknown }
      try {
        if (action.action === 'form') {
          const formResult = await applyForm(deps, action, sliceIds)
          if (formResult === 'refined') outcome.refined += 1
          else outcome.formed += 1
        } else if (action.action === 'refine') {
          const observationId = requireObservationId(action.observationId, staleIds)
          if (observationId === undefined) { outcome.skipped += 1; continue }
          if (typeof action.belief !== 'string' || action.belief.trim() === '') { outcome.skipped += 1; continue }
          const sourceIds = requireCandidateIds(action.sourceIds, sliceIds)
          if (sourceIds === undefined) { outcome.skipped += 1; continue }
          await refineWithEmbedding(deps, observationId, action.belief.trim(), sourceIds)
          outcome.refined += 1
        } else if (action.action === 'still') {
          const observationId = requireObservationId(action.observationId, staleIds)
          if (observationId === undefined) { outcome.skipped += 1; continue }
          await deps.store.confirmObservation(observationId)
          outcome.confirmed += 1
        } else if (action.action === 'refute') {
          const observationId = requireObservationId(action.observationId, staleIds)
          if (observationId === undefined) { outcome.skipped += 1; continue }
          await deps.store.refuteObservation(observationId)
          outcome.refuted += 1
        } else {
          outcome.skipped += 1
        }
      } catch {
        // 单条写入失败（库临时不可用等）不影响其余动作落库。
        outcome.skipped += 1
      }
    }
  }

  /**
   * 单片失败自愈（#45）：输出超预算对半递归重试（两半各自独立调用——合回同一请求体积
   * 几乎不减、必然再超限）；切到单片仍超限则该候选计入 dropped（未被巩固、无信念引用，
   * 下次巩固仍会取材），不再空烧；解析失败直接丢弃该片；其余错误原样上抛。
   */
  const runSlice = async (slice: readonly MemoryRecord[], includeStale: boolean): Promise<void> => {
    try {
      await applySlice(slice, includeStale)
      return
    } catch (error) {
      if (!(error instanceof ReflectBatchFailure)) throw error
      if (error.reason === 'unparseable') {
        outcome.dropped += slice.length
        return
      }
    }
    if (slice.length <= 1) {
      // 切到单片仍超输出预算：放弃该候选。
      outcome.dropped += slice.length
      return
    }
    const mid = Math.ceil(slice.length / 2)
    await runSlice(slice.slice(0, mid), includeStale)
    await runSlice(slice.slice(mid), false)
  }

  // 候选按 REFLECT_CHUNK 分片依次巩固，stale 复核只搭第一片的车；无候选但有待复核信念
  // 时仍要跑一次空候选片（否则 stale 永远轮不到复核）。
  if (candidates.length === 0) {
    await runSlice([], true)
  }
  for (let start = 0; start < candidates.length; start += REFLECT_CHUNK) {
    await runSlice(candidates.slice(start, start + REFLECT_CHUNK), start === 0)
  }

  // 4. 汇总审计（审计失败不影响巩固结果）。
  try {
    await deps.store.audit('reflect', 'AUX', JSON.stringify({
      scope: deps.scope,
      pool: outcome.pool,
      candidates: outcome.candidates,
      staleReviewed: outcome.staleReviewed,
      formed: outcome.formed,
      refined: outcome.refined,
      confirmed: outcome.confirmed,
      refuted: outcome.refuted,
      skipped: outcome.skipped,
      dropped: outcome.dropped,
    }))
  } catch {
    /* 审计失败不影响巩固结果 */
  }
  return outcome
}

/** 处理 form：校验信念与证据，算向量并决定近邻归并或新建。@returns 落库形态。 */
async function applyForm(
  deps: ReflectDeps,
  action: { belief?: unknown; sourceIds?: unknown },
  candidateIds: ReadonlySet<string>,
): Promise<'formed' | 'refined'> {
  if (typeof action.belief !== 'string' || action.belief.trim() === '') throw new Error(message('llm.reflectFormBeliefMissing'))
  const sourceIds = requireCandidateIds(action.sourceIds, candidateIds)
  if (sourceIds === undefined || sourceIds.length === 0) throw new Error(message('llm.reflectFormSourceIdsInvalid'))
  const belief = action.belief.trim()
  // 嵌入可用：为信念算向量，与既有 active/stale 信念近邻归并（同主题持续细化同一条）。
  if (deps.embedder !== undefined) {
    const vectors = await deps.embedder.embed([belief])
    const vector = vectors[0]
    if (vector !== undefined) {
      const nearest = await deps.store.nearestObservation(vector)
      if (nearest !== undefined && nearest.similarity >= REFLECT_MERGE_THRESHOLD) {
        await deps.store.refineObservation(nearest.record.id, belief, sourceIds, vector)
        return 'refined'
      }
      await deps.store.createObservation({ scope: deps.scope, belief, sourceIds, embedding: vector })
      return 'formed'
    }
  }
  await deps.store.createObservation({ scope: deps.scope, belief, sourceIds })
  return 'formed'
}

/** refine 时同样尝试为新表述算向量（失败则只改文本与证据，保留旧向量）。 */
async function refineWithEmbedding(
  deps: ReflectDeps,
  observationId: ObservationId,
  belief: string,
  sourceIds: readonly MemoryId[],
): Promise<void> {
  if (deps.embedder !== undefined) {
    const vectors = await deps.embedder.embed([belief])
    const vector = vectors[0]
    if (vector !== undefined) {
      await deps.store.refineObservation(observationId, belief, sourceIds, vector)
      return
    }
  }
  await deps.store.refineObservation(observationId, belief, sourceIds)
}

/** 校验 observationId 是本次喂入的 stale 信念；非法返回 undefined（跳过该动作）。 */
function requireObservationId(raw: unknown, staleIds: ReadonlySet<string>): ObservationId | undefined {
  if (typeof raw !== 'string' || !staleIds.has(raw)) return undefined
  return asObservationId(raw)
}

/**
 * 校验 sourceIds：必须为数组、每个 id 都来自本次候选集；返回品牌化 id 列表。
 * 非数组或含越界 id 返回 undefined（动作跳过）；空数组合法（refine 仅改表述时使用）。
 */
function requireCandidateIds(raw: unknown, candidateIds: ReadonlySet<string>): readonly MemoryId[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const ids: MemoryId[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || !candidateIds.has(item)) return undefined
    ids.push(asMemoryId(item))
  }
  return ids
}
