/**
 * 嵌入调用的进程级失败计数（issue #60「失败可见性」）：此前嵌入错误在多条路径
 * 上被静默吞掉，用户只见「搜不出东西」，却不知道嵌入一直在炸。这里把每次真实
 * 调用的成败记下来，经 telemetry 快照透出到面板「运行时」。
 *
 * 计数器随进程生存：重启即清零，快照文案一律说「本次运行」，不冒充历史累计。
 * embedder=undefined 的「降级为纯关键词」是既有信号（EMBEDDER_DOWNLOAD_FAILED
 * 的降级链路），不是本模块的计数对象——这里只记真实发生过的嵌入调用。
 * @module @kenz1117/dsh-engram/embedder/stats
 */

/** 快照里错误文本的截断上限：遥测是给人看的概览，不装完整堆栈。 */
const LAST_ERROR_MAX = 200

/** 嵌入调用计数的只读快照。 */
export interface EmbedderStatsSnapshot {
  /** 本次运行的嵌入调用总次数（每次真实调用 extractor/远端请求计 1）。 */
  readonly attempts: number
  /** 其中以异常告终的次数。 */
  readonly failures: number
  /** 最近一次失败的错误文本（截断到 200 字符）；尚无失败时缺省。 */
  readonly lastError?: string
  /** 最近一次失败的时间戳（Date.now()）；尚无失败时缺省。 */
  readonly lastFailureAtMs?: number
}

/** 进程级计数器：模块级单例，所有 embedder 实例共享（与故障域一致——都是同一个进程）。 */
const stats = {
  attempts: 0,
  failures: 0,
  lastError: undefined as string | undefined,
  lastFailureAtMs: undefined as number | undefined,
}

/**
 * 记一次嵌入调用。调用前记 `recordEmbedAttempt(false)`；抛错时补记
 * `recordEmbedAttempt(true, error)`（或直接在 catch 里这样调）。
 * @param failed - 这次调用是否以异常告终。
 * @param error - 失败时的错误；文本进 lastError，不进入日志也不外传。
 */
export function recordEmbedAttempt(failed: boolean, error?: unknown): void {
  stats.attempts += 1
  if (!failed) return
  stats.failures += 1
  stats.lastFailureAtMs = Date.now()
  const text = error instanceof Error ? error.message : String(error)
  stats.lastError = text.length > LAST_ERROR_MAX ? `${text.slice(0, LAST_ERROR_MAX)}…` : text
}

/**
 * 取当前计数的幂等快照：返回全新对象，调用方怎么改都不影响内部计数，
 * 重复调用在两次嵌入之间得到相等的值。可选字段只在有值时出现，
 * 便于遥测结构随版本演进（旧客户端按缺省兜底）。
 */
export function embedderStatsSnapshot(): EmbedderStatsSnapshot {
  const snapshot: { attempts: number; failures: number; lastError?: string; lastFailureAtMs?: number } = {
    attempts: stats.attempts,
    failures: stats.failures,
  }
  if (stats.lastError !== undefined) snapshot.lastError = stats.lastError
  if (stats.lastFailureAtMs !== undefined) snapshot.lastFailureAtMs = stats.lastFailureAtMs
  return snapshot
}
