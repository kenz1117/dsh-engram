/**
 * 宫殿遥测聚合：从 op_log 实时聚合最近 N 天的关键指标，全部数据本地保留、不外传。
 * 暴露给路由 /api/engram/telemetry，供面板「今日速览」与「管家日志」展示计数。
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
    readonly reviewAnswers: number
  }
  /** 各 scope 的活跃记忆数与开放率（signal ratio）。 */
  readonly scopes: ReadonlyArray<{
    readonly scope: 'user' | 'project' | 'shared'
    readonly active: number
    readonly total: number
    readonly signalRatio: number
  }>
  /**
   * 每日写入分布：v0.8.1+ 面板「活动热力日历」按此渲染。
   * 长度 = windowDays（默认 7；路由把上限夹在 366，面板热力日历请求 182），元素 = 该日 0 点的 UTC ms 与写入/摄取合计。
   * 取不到时不返回（undefined），UI 端走降级（不画 / 画灰格子）。
   */
  readonly dailyWrites?: ReadonlyArray<{ readonly dayMs: number; readonly count: number }>
}

/** 从单库 op_log 统计各 op 的计数（窗口内）——SQL GROUP BY，不物化明细行（审计 N1）。 */
async function countByOp(store: EngramStore, sinceMs: number): Promise<Record<string, number>> {
  return store.countOps(sinceMs)
}

/** 按天汇总 op_log 中的写侧活动（热力日历）。返回的 dayMs 是该日 0 点的本地时间戳。
 * 包含 write/update/ingest-done/ingest-request/distill-request/consolidation/restore/forget,
 * 排除纯读侧(search/outcome-report)。折算两段走：SQL 按 UTC 天分组（吃 op_log_at 索引），
 * JS 用「UTC 正午」过 setHours 映射成本地日——正午法对夏令时切换 stable（对抗审查 P2-5）。 */
async function countByDay(
  store: EngramStore,
  sinceMs: number,
  untilMs: number,
): Promise<Map<number, number>> {
  // 写侧 op:任何改变记忆库状态的操作
  const writeOps = ['write', 'update', 'ingest-done', 'ingest-request', 'distill-request', 'consolidation', 'restore', 'forget']
  const rows = await store.countOpsByDay(sinceMs, untilMs, writeOps)
  const counts = new Map<number, number>()
  const dayMs = (ms: number): number => {
    const d = new Date(ms)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  for (let t = dayMs(sinceMs); t <= dayMs(untilMs); t += 86_400_000) counts.set(t, 0)
  for (const row of rows) {
    const local = dayMs(row.utcDay * 86_400_000 + 43_200_000)
    counts.set(local, (counts.get(local) ?? 0) + row.count)
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
    searchRewrites: 0, consumptions: 0, consolidations: 0, reviewAnswers: 0,
  }
  // scopeViews 局部可变（push），返回时满足 TelemetrySnapshot['scopes'] 的 readonly 形状。
  type ScopeView = TelemetrySnapshot['scopes'][number]
  const scopeViews: ScopeView[] = []
  // 每日写入聚合：跨库合并 Map 累加（同一日 0 点对齐）
  const dailyTotals = new Map<number, number>()
  for (const scope of scopes) {
    try {
      const store = await openStore(scope)
      const [counts, stats, daily] = await Promise.all([
        countByOp(store, sinceMs),
        store.stats(),
        countByDay(store, sinceMs, untilMs),
      ])
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
      countsAgg.reviewAnswers += counts['review-answer'] ?? 0
      scopeViews.push({ scope, active: stats.active, total: stats.total, signalRatio: stats.signalRatio })
      for (const [day, n] of daily) dailyTotals.set(day, (dailyTotals.get(day) ?? 0) + n)
    } catch {
      // shared 库可能尚未创建，跳过；不影响其他 scope。
    }
  }
  // 按 dayMs 升序排成数组（v0.8.1+ 热力日历直接用）
  const dailyWrites = Array.from(dailyTotals.entries())
    .sort(([a], [b]) => a - b)
    .map(([dayMs, count]) => ({ dayMs, count }))
  return {
    windowDays,
    sinceMs,
    untilMs,
    counts: countsAgg,
    scopes: scopeViews,
    dailyWrites,
  }
}
