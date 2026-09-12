/**
 * 检索批次的证据门。
 *
 * 检索命中只说明「相关」，不说明「足以回答」。每次 engram_search 注册一个批次，
 * 登记该次输出里可引用的证据 ref；engram_assess 只能引用同一批次内的 ref，
 * 且 sufficient 由代码强制（模型声称充足 + 至少一条有效证据 + nextStrategy=answer）。
 * 批次只存在于进程内、按会话隔离并有上限，重启或过期后需重新检索。
 * @module @kenz1117/dsh-engram/retrieve/evidence
 */

import type { Slot } from '../types.ts'

/** 单次判定最多接受的证据条数（有界契约：防止把整个结果集当证据）。 */
export const MAX_EVIDENCE_REFS = 8

/** missing 字段的最大字符数。 */
export const MAX_MISSING_CHARS = 160

/** 每个会话保留的批次数上限（超出丢最旧的批次）。 */
export const MAX_BATCHES_PER_SESSION = 20

/** 判定后可选的下一步策略。 */
export const NEXT_STRATEGIES = ['answer', 'search_keyword', 'search_room', 'search_timeline', 'ask_user', 'stop'] as const

/** 下一步策略。 */
export type NextStrategy = (typeof NEXT_STRATEGIES)[number]

/** 一个检索批次：批次 id 与该批次内可引用的证据 ref 集合。 */
export interface EvidenceBatch {
  /** 批次 id（会话内单调递增，形如 batch-3）。 */
  readonly batchId: string
  /** 该批次输出里出现过的证据 ref。 */
  readonly refs: ReadonlySet<string>
  /** 注册时间。 */
  readonly createdAt: number
}

/** 模型提交的判定请求（字段值尚未校验）。 */
export interface AssessRequest {
  /** 模型自称证据是否充分。 */
  readonly sufficient: boolean
  /** 模型提交的证据 ref。 */
  readonly evidenceRefs: readonly string[]
  /** 缺失的信息（缺口描述）。 */
  readonly missing: string
  /** 模型建议的下一步策略。 */
  readonly nextStrategy: string
}

/** 代码校验后的判定结果。 */
export interface AssessVerdict {
  /** 最终是否充足（代码强制后的值）。 */
  readonly sufficient: boolean
  /** 被接受的有效证据 ref（保序）。 */
  readonly evidenceRefs: readonly string[]
  /** 不属于该批次、被拒绝的 ref。 */
  readonly rejectedRefs: readonly string[]
  /** 超出条数上限被丢弃的 ref。 */
  readonly droppedRefs: readonly string[]
  /** 缺口描述（已按上限截断）。 */
  readonly missing: string
  /** 缺口描述是否被截断。 */
  readonly missingTruncated: boolean
  /** 最终下一步策略（代码强制后的值）。 */
  readonly nextStrategy: NextStrategy
  /** 模型原始提交的策略（诊断用）。 */
  readonly requestedStrategy: string
  /** 输入是否被代码改写。 */
  readonly forced: boolean
}

/**
 * 判断字符串是否为合法策略。
 * @param value - 待判定字符串。
 */
export function isNextStrategy(value: string): value is NextStrategy {
  return (NEXT_STRATEGIES as readonly string[]).includes(value)
}

/**
 * 构造批次内唯一的证据 ref：已排桩时用「scope/房间#桩位」（与检索行里的宫殿坐标一致），
 * 未排桩时用「scope/#id 前 8 位」。带 scope 前缀，跨作用域的同名房间不会撞号。
 * @param scope - 条目所在作用域。
 * @param id - 条目 id。
 * @param slot - 宫殿坐标；未排桩传 undefined。
 */
export function evidenceRefOf(scope: string, id: string, slot: Slot | undefined): string {
  return slot === undefined ? `${scope}/#${id.slice(0, 8)}` : `${scope}/${slot.room}#${slot.index}`
}

/** 批次注册表：按会话隔离，超出上限丢最旧的批次。 */
export class EvidenceBatches {
  private readonly bySession = new Map<string, Map<string, EvidenceBatch>>()

  private counter = 0

  /**
   * 注册一个批次。
   * @param sessionId - 会话标识。
   * @param refs - 本次输出中可引用的证据 ref（重复项只留一次）。
   * @param now - 当前时间（测试注入）。
   * @returns 新批次。
   */
  register(sessionId: string, refs: readonly string[], now: number = Date.now()): EvidenceBatch {
    this.counter += 1
    const batch: EvidenceBatch = { batchId: `batch-${String(this.counter)}`, refs: new Set(refs), createdAt: now }
    const batches = this.bySession.get(sessionId) ?? new Map<string, EvidenceBatch>()
    batches.set(batch.batchId, batch)
    while (batches.size > MAX_BATCHES_PER_SESSION) {
      const oldest = batches.keys().next().value
      if (oldest === undefined) break
      batches.delete(oldest)
    }
    this.bySession.set(sessionId, batches)
    return batch
  }

  /**
   * 取会话内指定批次。
   * @param sessionId - 会话标识。
   * @param batchId - 批次 id。
   * @returns 批次；不存在或已被上限淘汰时返回 undefined。
   */
  get(sessionId: string, batchId: string): EvidenceBatch | undefined {
    return this.bySession.get(sessionId)?.get(batchId)
  }

  /**
   * 清理会话的全部批次（会话销毁时调用，避免长驻进程累积）。
   * @param sessionId - 会话标识。
   */
  clear(sessionId: string): void {
    this.bySession.delete(sessionId)
  }
}

/** 进程内批次注册表：插件为单实例，会话销毁时调用 clear 释放该会话的批次。 */
export const evidenceBatches = new EvidenceBatches()

/**
 * 校验判定：ref 必须属于批次，sufficient 由代码强制。
 * 强制规则：sufficient 需同时满足「模型声称充足」「至少一条本批次有效证据」「策略为 answer」；
 * 三者缺一即判为不充足，并把策略改写为继续检索（模型声称充足时）或尊重其非作答策略。
 * @param batch - 被引用的批次。
 * @param request - 模型提交的判定。
 * @returns 校验后的判定结果（含被拒绝与超限的 ref 明细）。
 */
export function assessEvidence(batch: EvidenceBatch, request: AssessRequest): AssessVerdict {
  const submitted = request.evidenceRefs
    .filter((ref): ref is string => typeof ref === 'string')
    .map(ref => ref.trim())
    .filter(ref => ref !== '')
  const unique = [...new Set(submitted)]
  const limited = unique.slice(0, MAX_EVIDENCE_REFS)
  const droppedRefs = unique.slice(MAX_EVIDENCE_REFS)
  const accepted: string[] = []
  const rejectedRefs: string[] = []
  for (const ref of limited) {
    if (batch.refs.has(ref)) accepted.push(ref)
    else rejectedRefs.push(ref)
  }

  const rawMissing = typeof request.missing === 'string' ? request.missing.trim() : ''
  const missingTruncated = rawMissing.length > MAX_MISSING_CHARS
  const missing = missingTruncated ? `${rawMissing.slice(0, MAX_MISSING_CHARS)}…` : rawMissing

  const requestedStrategy = typeof request.nextStrategy === 'string' ? request.nextStrategy.trim() : ''
  const strategy: NextStrategy = isNextStrategy(requestedStrategy) ? requestedStrategy : 'search_keyword'
  const claimed = request.sufficient === true
  const sufficient = claimed && accepted.length > 0 && strategy === 'answer'
  // 模型声称不充足却给出 answer，或声称充足却拿不出有效证据：改回继续检索。
  const nextStrategy: NextStrategy = sufficient || strategy !== 'answer' ? strategy : 'search_keyword'
  return {
    sufficient,
    evidenceRefs: accepted,
    rejectedRefs,
    droppedRefs,
    missing,
    missingTruncated,
    nextStrategy,
    requestedStrategy,
    forced: claimed !== sufficient || strategy !== requestedStrategy || nextStrategy !== strategy,
  }
}
