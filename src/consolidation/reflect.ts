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

import { parseJsonArray } from '../llm/client.ts'
import type { LlmRoute } from '../llm/client.ts'
import type { EngramEmbedder } from '../embedder/interface.ts'
import type { EngramStore } from '../store/interface.ts'
import type { EngramScope, MemoryId, ObservationId } from '../types.ts'
import { asMemoryId, asObservationId } from '../types.ts'

/** 取材池大小：从 active 记忆按 importance/confidence 倒序扫描的上限。 */
const REFLECT_POOL = 300
/** 单次巩固喂给 LLM 的新证据条数上限（协议内常量：单次辅助调用的可控上下文）。 */
const REFLECT_MAX_INPUT = 30
/** 单次喂给 LLM 的待复核 stale 信念上限。 */
const REFLECT_MAX_STALE = 5
/** 单条 stale 信念附带的证据原文条数上限。 */
const REFLECT_STALE_EVIDENCE_LIMIT = 6
/** stale 证据原文截断字符数（控制总上下文）。 */
const REFLECT_EVIDENCE_SLICE = 120
/** 巩固输出 token 上限。 */
const REFLECT_MAX_TOKENS = 900
/** 信念向量近邻归并阈值：新信念与既有信念余弦达到该值则并入同一条（持续细化）。 */
const REFLECT_MERGE_THRESHOLD = 0.9
/** 新鲜度阈值：新证据与既有信念余弦达到该值（低于归并阈值，语义更宽）则把信念标 stale 待复核。 */
const REFLECT_STALE_THRESHOLD = 0.86

const REFLECT_SYSTEM = [
  '下面给出两部分材料：【待巩固记忆】是新近写入的原始记忆；【待复核信念】是此前巩固出、但可能受新证据影响的信念（附原始证据）。',
  '请对材料做巩固与复核，只输出一个 JSON 数组，每项为以下四种动作之一：',
  '1. {"action":"form","belief":"巩固出的一句话信念（结论/规律/稳定偏好）","sourceIds":["证据记忆id"]} —— sourceIds 至少 1 个且必须全部来自【待巩固记忆】的 id；多条记忆支撑同一信念时合并成一条，不要为单条琐碎记忆立信念。',
  '2. {"action":"refine","observationId":"待复核信念id","belief":"结合新证据后的新表述","sourceIds":["新增证据记忆id"]} —— 新证据补充或限定了该信念时使用；sourceIds 必须来自【待巩固记忆】，可为空数组（仅表述更准确）。',
  '3. {"action":"still","observationId":"待复核信念id"} —— 新证据不影响该信念，原表述仍成立。',
  '4. {"action":"refute","observationId":"待复核信念id","reason":"被否定的原因（引用证据）"} —— 新证据与信念矛盾且原信念不再成立。',
  'observationId 必须取自【待复核信念】给出的 id。材料中没有值得巩固或复核的内容时输出 []。不要输出 JSON 以外的任何内容。',
].join('\n')

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
    pool: 0, candidates: 0, staleReviewed: 0, formed: 0, refined: 0, confirmed: 0, refuted: 0, skipped: 0,
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

  // 2. 组装 LLM 上下文：候选段 + stale 段（stale 附证据原文，条数与长度双截断）。
  const candidateIds = new Set(candidates.map(record => String(record.id)))
  const staleIds = new Set(stale.map(observation => String(observation.id)))
  const sections: string[] = []
  if (candidates.length > 0) {
    const lines = candidates.map(record => `[${String(record.id)}] (${record.kind}, importance ${record.importance.toFixed(2)}) ${record.content}`)
    sections.push(`【待巩固记忆】\n${lines.join('\n')}`)
  }
  if (stale.length > 0) {
    const blocks: string[] = []
    for (const observation of stale) {
      const evidenceRecords = await deps.store.getMany(observation.sourceIds.slice(0, REFLECT_STALE_EVIDENCE_LIMIT))
      const evidence = evidenceRecords
        .map(record => `  - ${record.content.slice(0, REFLECT_EVIDENCE_SLICE)}`)
        .join('\n')
      blocks.push(`[${String(observation.id)}] 证据 ${String(observation.proofCount)} 条：${observation.belief}\n${evidence}`)
    }
    sections.push(`【待复核信念】\n${blocks.join('\n')}`)
  }
  const userText = sections.join('\n\n')
  deps.logRequest({
    route: deps.route,
    scope: deps.scope,
    candidateCount: candidates.length,
    staleCount: stale.length,
    maxTokens: REFLECT_MAX_TOKENS,
  })
  const raw = await deps.call({
    route: deps.route,
    system: REFLECT_SYSTEM,
    userText,
    maxTokens: REFLECT_MAX_TOKENS,
    purpose: 'engram-reflect',
    signal: deps.signal,
  })
  const parsed = parseJsonArray(raw)
  if (parsed === undefined || parsed.length === 0) return outcome

  // 3. 逐动作落库。
  for (const item of parsed) {
    const action = item as { action?: unknown; belief?: unknown; sourceIds?: unknown; observationId?: unknown; reason?: unknown }
    try {
      if (action.action === 'form') {
        const formResult = await applyForm(deps, action, candidateIds)
        if (formResult === 'refined') outcome.refined += 1
        else outcome.formed += 1
      } else if (action.action === 'refine') {
        const observationId = requireObservationId(action.observationId, staleIds)
        if (observationId === undefined) { outcome.skipped += 1; continue }
        if (typeof action.belief !== 'string' || action.belief.trim() === '') { outcome.skipped += 1; continue }
        const sourceIds = requireCandidateIds(action.sourceIds, candidateIds)
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
  if (typeof action.belief !== 'string' || action.belief.trim() === '') throw new Error('form: belief 缺失')
  const sourceIds = requireCandidateIds(action.sourceIds, candidateIds)
  if (sourceIds === undefined || sourceIds.length === 0) throw new Error('form: sourceIds 越界或为空')
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
