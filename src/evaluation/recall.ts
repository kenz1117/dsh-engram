/**
 * 本地记忆检索评测：不依赖外部模型和网络，用同一 fixture 可重复比较引擎改动。
 * 指标覆盖召回、排序、知识更新、时间线、拒答与稳定身份 provenance。
 * @module @kenz1117/dsh-engram/evaluation/recall
 */

import type { EngramStore } from '../store/interface.ts'
import { asMemoryId } from '../types.ts'
import type { MemoryId } from '../types.ts'

/** 能力标签：与 LongMemEval 的五个核心能力保持概念对齐，但语料是 DSH 私域 fixture。 */
export type MemoryAbility = 'recall' | 'knowledge-update' | 'temporal' | 'abstention'

export interface RetrievalCase {
  readonly caseId: string
  readonly ability: Exclude<MemoryAbility, 'temporal'>
  readonly query: string
  /** 稳定 memoryId；absent 案例省略。 */
  readonly relevantMemoryIds?: readonly MemoryId[]
  readonly k?: number
}

export interface RetrievedMemory {
  readonly memoryId: MemoryId
  readonly revisionId: MemoryId
  readonly score: number
  readonly via: 'fts' | 'vec' | 'both'
  readonly degraded: boolean
}

export interface RetrievalCaseResult {
  readonly caseId: string
  readonly ability: MemoryAbility
  readonly query: string
  readonly retrieved: readonly RetrievedMemory[]
  readonly rank: number | null
  readonly recall: number
  readonly hit: boolean
  readonly mrr: number
  readonly abstentionCorrect?: boolean
}

export interface RetrievalReport {
  readonly k: number
  readonly cases: readonly RetrievalCaseResult[]
  readonly relevantCases: number
  readonly recallAtK: number
  readonly hitAtK: number
  readonly mrr: number
  readonly abstentionCases: number
  readonly abstentionAccuracy: number
  readonly provenanceComplete: number
}

export interface EpisodeTimelineCase {
  readonly caseId: string
  readonly sessionId?: string
  readonly expectedMemoryIds: readonly MemoryId[]
  readonly k?: number
}

export interface EpisodeTimelineCaseResult {
  readonly caseId: string
  readonly sessionId: string | null
  readonly retrieved: readonly RetrievedMemory[]
  readonly rank: number | null
  readonly recall: number
  readonly hit: boolean
  readonly mrr: number
}

export interface EpisodeTimelineReport {
  readonly cases: readonly EpisodeTimelineCaseResult[]
  readonly recallAtK: number
  readonly hitAtK: number
  readonly mrr: number
  readonly chronological: boolean
}

export interface EvaluationOptions {
  /** 召回窗口；默认 5。 */
  readonly k?: number
  /** 无相关记忆时，最高分低于该阈值才视为正确拒答；默认 0.04。 */
  readonly abstainScoreBelow?: number
}

function idSet(ids: readonly MemoryId[] | undefined): Set<string> {
  return new Set((ids ?? []).map(id => String(id)))
}

function retrievedOf(hit: { record: { id: MemoryId; memoryId: MemoryId }; score: number; via: 'fts' | 'vec' | 'both'; } , degraded: boolean): RetrievedMemory {
  return {
    memoryId: hit.record.memoryId,
    revisionId: hit.record.id,
    score: hit.score,
    via: hit.via,
    degraded,
  }
}

function rankOf(retrieved: readonly RetrievedMemory[], relevant: Set<string>): number | null {
  const index = retrieved.findIndex(item => relevant.has(String(item.memoryId)))
  return index === -1 ? null : index + 1
}

function recallOf(retrieved: readonly RetrievedMemory[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 0
  const found = new Set(retrieved.slice(0, k).map(item => String(item.memoryId)).filter(id => relevant.has(id)))
  return found.size / relevant.size
}

/** 评测 FTS/vector 混合检索；vector undefined 时会记录 degraded，作为关键词降级基线。 */
export async function evaluateRetrieval(
  store: EngramStore,
  cases: readonly RetrievalCase[],
  options: EvaluationOptions = {},
): Promise<RetrievalReport> {
  const k = Math.max(1, Math.floor(options.k ?? 5))
  const abstainBelow = options.abstainScoreBelow ?? 0.04
  const results: RetrievalCaseResult[] = []

  for (const item of cases) {
    const relevant = idSet(item.relevantMemoryIds)
    const result = await store.search({ text: item.query, scopes: ['user'], limit: k }, undefined)
    const retrieved = result.hits.map(hit => retrievedOf(hit, result.degraded))
    const rank = rankOf(retrieved, relevant)
    const relevantCase = relevant.size > 0
    const abstentionCorrect = relevantCase ? undefined : retrieved.length === 0 || retrieved[0]!.score < abstainBelow
    results.push({
      caseId: item.caseId,
      ability: item.ability,
      query: item.query,
      retrieved,
      rank,
      recall: recallOf(retrieved, relevant, k),
      hit: rank !== null,
      mrr: rank === null ? 0 : 1 / rank,
      ...(abstentionCorrect === undefined ? {} : { abstentionCorrect }),
    })
  }

  const relevantResults = results.filter(result => idSet(
    cases.find(caseItem => caseItem.caseId === result.caseId)?.relevantMemoryIds,
  ).size > 0)
  const abstentionResults = results.filter(result => result.abstentionCorrect !== undefined)
  const provenanceComplete = results.reduce((sum, result) => sum + (result.retrieved.every(item => (
    item.memoryId !== undefined
    && item.revisionId !== undefined
    && Number.isFinite(item.score)
    && typeof item.via === 'string'
  )) ? 1 : 0), 0)

  return {
    k,
    cases: results,
    relevantCases: relevantResults.length,
    recallAtK: relevantResults.length === 0 ? 0
      : relevantResults.reduce((sum, result) => sum + result.recall, 0) / relevantResults.length,
    hitAtK: relevantResults.length === 0 ? 0
      : relevantResults.filter(result => result.hit).length / relevantResults.length,
    mrr: relevantResults.length === 0 ? 0
      : relevantResults.reduce((sum, result) => sum + result.mrr, 0) / relevantResults.length,
    abstentionCases: abstentionResults.length,
    abstentionAccuracy: abstentionResults.length === 0 ? 0
      : abstentionResults.filter(result => result.abstentionCorrect === true).length / abstentionResults.length,
    provenanceComplete,
  }
}

/** 评测 episode 时间线：验证会话过滤、组内时间顺序和稳定身份召回。 */
export async function evaluateEpisodeTimeline(
  store: EngramStore,
  cases: readonly EpisodeTimelineCase[],
  options: EvaluationOptions = {},
): Promise<EpisodeTimelineReport> {
  const k = Math.max(1, Math.floor(options.k ?? 5))
  const results: EpisodeTimelineCaseResult[] = []
  let chronological = true

  for (const item of cases) {
    const expected = idSet(item.expectedMemoryIds)
    const timeline = await store.episodeTimeline({
      scopes: ['user'],
      ...(item.sessionId === undefined ? {} : { sessionId: item.sessionId }),
      limit: k,
    })
    const episodes = timeline.groups.flatMap(group => group.episodes)
    for (let index = 1; index < episodes.length; index += 1) {
      if (episodes[index - 1]!.createdAt > episodes[index]!.createdAt) chronological = false
    }
    const retrieved = episodes.map(row => ({
      memoryId: asMemoryId(row.id),
      revisionId: asMemoryId(row.id),
      score: 1,
      via: 'fts' as const,
      degraded: false,
    }))
    const rank = rankOf(retrieved, expected)
    results.push({
      caseId: item.caseId,
      sessionId: item.sessionId ?? null,
      retrieved,
      rank,
      recall: recallOf(retrieved, expected, k),
      hit: rank !== null,
      mrr: rank === null ? 0 : 1 / rank,
    })
  }

  return {
    cases: results,
    recallAtK: results.length === 0 ? 0 : results.reduce((sum, result) => sum + result.recall, 0) / results.length,
    hitAtK: results.length === 0 ? 0 : results.filter(result => result.hit).length / results.length,
    mrr: results.length === 0 ? 0 : results.reduce((sum, result) => sum + result.mrr, 0) / results.length,
    chronological,
  }
}
