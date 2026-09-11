/**
 * 宫殿遥测聚合：从 op_log 实时聚合最近 N 天的关键指标，全部数据本地保留、不外传。
 * 暴露给路由 /api/engram/telemetry，供面板「管家日报」展示趋势。
 * @module @kenz1117/dsh-engram/telemetry/aggregate
 */

import type { EngramStore } from '../store/interface.ts'

/** 聚合窗口（默认 7 天，可由路由 query 覆盖）。 */
const DEFAULT_WINDOW_DAYS = 7

/** 聚合指标视图。 */
export interface TelemetrySnapshot {
  readonly windowDays: number
  readonly sinceMs: number
  readonly untilMs: number
  readonly counts: {
    readonly ingestRequests: number
    readonly ingestDones: number
    readonly searches: number
    readonly writes: number
    readonly updates: number
    readonly forgets: number
    readonly restores: number
    readonly distillRequests: number
    readonly compressRequests: number
    readonly searchRewrites: number
    readonly consumptions: number
    readonly consolidations: number
  }
  /** 各 scope 的活跃房间数与开放率（signal ratio）。 */
  readonly scopes: ReadonlyArray<{
    readonly scope: 'user' | 'project' | 'shared'
    readonly active: number
    readonly total: number
    readonly signalRatio: number
  }>
}

/** 从单库 op_log 统计各 op 的计数（窗口内）。 */
async function countByOp(store: EngramStore, sinceMs: number): Promise<Record<string, number>> {
  const ops = await store.recentOps(100_000)
  const counts: Record<string, number> = {}
  for (const op of ops) {
    if (op.at < sinceMs) continue
    counts[op.op] = (counts[op.op] ?? 0) + 1
  }
  return counts
}

/** 聚合两库的指标 + 各 scope 状态。
 * @param scopeFilter - 限定只聚合指定 scope；undefined = 三库全聚合（向后兼容）。 */
export async function aggregateTelemetry(
  openStore: (scope: 'user' | 'project' | 'shared') => Promise<EngramStore>,
  windowDays: number = DEFAULT_WINDOW_DAYS,
  scopeFilter?: 'user' | 'project' | 'shared',
): Promise<TelemetrySnapshot> {
  const untilMs = Date.now()
  const sinceMs = untilMs - windowDays * 86_400_000
  const scopes: Array<'user' | 'project' | 'shared'> = scopeFilter !== undefined
    ? [scopeFilter]
    : ['user', 'project', 'shared']
  const countsAgg = {
    ingestRequests: 0, ingestDones: 0, searches: 0, writes: 0, updates: 0,
    forgets: 0, restores: 0, distillRequests: 0, compressRequests: 0,
    searchRewrites: 0, consumptions: 0, consolidations: 0,
  }
  // scopeViews 局部可变（push），返回时满足 TelemetrySnapshot['scopes'] 的 readonly 形状。
  type ScopeView = TelemetrySnapshot['scopes'][number]
  const scopeViews: ScopeView[] = []
  for (const scope of scopes) {
    try {
      const store = await openStore(scope)
      const [counts, stats] = await Promise.all([countByOp(store, sinceMs), store.stats()])
      countsAgg.ingestRequests += counts['ingest-request'] ?? 0
      countsAgg.ingestDones += counts['ingest-done'] ?? 0
      countsAgg.searches += counts['search-rewrite-request'] ?? 0
      countsAgg.writes += counts['write'] ?? 0
      countsAgg.updates += counts['update'] ?? 0
      countsAgg.forgets += counts['forget'] ?? 0
      countsAgg.restores += counts['restore'] ?? 0
      countsAgg.distillRequests += counts['distill-request'] ?? 0
      countsAgg.compressRequests += counts['compress-request'] ?? 0
      countsAgg.searchRewrites += counts['search-rewrite-request'] ?? 0
      countsAgg.consumptions += (counts['outcome-report'] ?? 0)
      countsAgg.consolidations += counts['consolidation'] ?? 0
      scopeViews.push({ scope, active: stats.active, total: stats.total, signalRatio: stats.signalRatio })
    } catch {
      // shared 库可能尚未创建，跳过；不影响其他 scope。
    }
  }
  return {
    windowDays,
    sinceMs,
    untilMs,
    counts: countsAgg,
    scopes: scopeViews,
  }
}
