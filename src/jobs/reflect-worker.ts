/**
 * reflect 持久调度器：确定性入队、串行认领、限时执行、失败重试与停止恢复。
 * queue 的生命周期由宿主管理；本 worker 只拥有定时器与自己的执行取消信号。
 * @module @kenz1117/dsh-engram/jobs/reflect-worker
 */

import { randomUUID } from 'node:crypto'
import type { LlmRoute } from '../llm/client.ts'
import type { EnqueueResult, JobQueue, JobRecord } from './queue.ts'

export interface ReflectJobPayload {
  readonly sessionId: string
  readonly scope: 'user' | 'project'
  readonly cwd?: string
  readonly route: LlmRoute
  /** 可选事件序号（非负整数）：由主线程按会话事件流递增传入，参与派生确定性 id，让同一会话的后续事件在前一作业 done/dead 后仍能触发新作业。 */
  readonly eventSeq?: number
}

export interface DurableReflectWorkerOptions {
  readonly queue: JobQueue
  readonly execute: (payload: ReflectJobPayload, signal: AbortSignal) => Promise<void>
  readonly onError?: (error: Error, job?: JobRecord) => void
  readonly owner?: string
  readonly intervalMs?: number
  readonly leaseMs?: number
  readonly retryDelayMs?: number
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

function positive(value: number | undefined, fallback: number, field: string): number {
  const result = value ?? fallback
  if (!Number.isInteger(result) || result <= 0) throw new Error(`reflect worker: ${field} 必须是正整数`)
  return result
}

function nonNegative(value: number | undefined, fallback: number, field: string): number {
  const result = value ?? fallback
  if (!Number.isInteger(result) || result < 0) throw new Error(`reflect worker: ${field} 必须是非负整数`)
  return result
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function parsePayload(value: unknown): ReflectJobPayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('reflect job payload 必须是对象')
  const raw = value as Record<string, unknown>
  const route = raw.route as Record<string, unknown> | undefined
  if (!text(raw.sessionId) || (raw.scope !== 'user' && raw.scope !== 'project')) {
    throw new Error('reflect job payload 缺 sessionId 或 scope 非法')
  }
  if (raw.cwd !== undefined && !text(raw.cwd)) throw new Error('reflect job payload.cwd 必须是非空字符串')
  if (raw.eventSeq !== undefined && (typeof raw.eventSeq !== 'number' || !Number.isInteger(raw.eventSeq) || raw.eventSeq < 0)) {
    throw new Error('reflect job payload.eventSeq 必须是非负整数')
  }
  if (route === undefined || !text(route.provider) || !text(route.model)) {
    throw new Error('reflect job payload.route 缺 provider/model')
  }
  return {
    sessionId: raw.sessionId,
    scope: raw.scope,
    ...(raw.cwd === undefined ? {} : { cwd: raw.cwd }),
    ...(raw.eventSeq === undefined ? {} : { eventSeq: raw.eventSeq }),
    route: { provider: route.provider, model: route.model },
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class DurableReflectWorker {
  private readonly queue: JobQueue
  private readonly execute: DurableReflectWorkerOptions['execute']
  private readonly onError: DurableReflectWorkerOptions['onError']
  private readonly owner: string
  private readonly intervalMs: number
  private readonly leaseMs: number
  private readonly retryDelayMs: number
  private readonly timeoutMs: number
  private readonly externalSignal: AbortSignal | undefined
  private readonly abort = new AbortController()
  private currentAbort: AbortController | undefined
  private timer: NodeJS.Timeout | undefined
  private activePump: Promise<void> | undefined
  private stopped = false

  constructor(options: DurableReflectWorkerOptions) {
    this.queue = options.queue
    this.execute = options.execute
    this.onError = options.onError
    this.owner = options.owner ?? `reflect-${randomUUID()}`
    this.intervalMs = positive(options.intervalMs, 1000, 'intervalMs')
    this.leaseMs = positive(options.leaseMs, 180_000, 'leaseMs')
    this.retryDelayMs = nonNegative(options.retryDelayMs, 30_000, 'retryDelayMs')
    this.timeoutMs = positive(options.timeoutMs, 120_000, 'timeoutMs')
    this.externalSignal = options.signal
  }

  enqueue(payload: ReflectJobPayload): EnqueueResult {
    const checked = parsePayload(payload)
    return this.queue.enqueue({
      // 带 eventSeq 时序号入 id：同 session/scope 同 seq 幂等，seq 前进即新作业
      //（不受前一作业 done/dead 影响）；不带时保持旧 id 兼容。
      id: checked.eventSeq === undefined
        ? `reflect:${checked.sessionId}:${checked.scope}`
        : `reflect:${checked.sessionId}:${checked.scope}:${checked.eventSeq}`,
      kind: 'reflect',
      payload: checked,
      maxAttempts: 3,
    })
  }

  start(): void {
    if (this.stopped) throw new Error('reflect worker: stop 后不可重新 start')
    if (this.timer !== undefined) return
    void this.pump()
    this.timer = setInterval(() => { void this.pump() }, this.intervalMs)
    this.timer.unref()
  }

  /** 重入共享同一个 pump；executor 在任意时刻至多一个在跑。 */
  pump(): Promise<void> {
    if (this.activePump !== undefined) return this.activePump
    const active = this.drain()
    this.activePump = active
    const clear = (): void => {
      if (this.activePump === active) this.activePump = undefined
    }
    void active.then(clear, clear)
    return active
  }

  private get cancelled(): boolean {
    return this.stopped || this.abort.signal.aborted || this.externalSignal?.aborted === true
  }

  private report(error: unknown, job?: JobRecord): void {
    if (this.onError === undefined) return
    try { this.onError(error instanceof Error ? error : new Error(String(error)), job) } catch { /* 日志不反向终止调度 */ }
  }

  private async drain(): Promise<void> {
    try {
      while (!this.cancelled) {
        const [job] = this.queue.claim({ owner: this.owner, kinds: ['reflect'], leaseMs: this.leaseMs })
        if (job === undefined) break
        const controller = new AbortController()
        this.currentAbort = controller
        const signals = [controller.signal, this.abort.signal, AbortSignal.timeout(this.timeoutMs)]
        if (this.externalSignal !== undefined) signals.push(this.externalSignal)
        try {
          const payload = parsePayload(job.payload)
          await this.execute(payload, AbortSignal.any(signals))
          this.queue.complete({ id: job.id, owner: this.owner })
        } catch (error) {
          let reported = error
          try {
            this.queue.fail({ id: job.id, owner: this.owner, error: errorText(error), retryDelayMs: this.retryDelayMs })
          } catch (queueError) {
            reported = queueError
          }
          this.report(reported, job)
        } finally {
          this.currentAbort = undefined
        }
      }
    } catch (error) {
      // 队列级故障不能形成未处理 rejection；持久状态留待下一次定时 pump 恢复。
      this.report(error)
    }
  }

  /** 停止认领新作业，取消在途执行并等待 queue 状态收束；queue 保持打开。 */
  async stop(): Promise<void> {
    if (this.stopped) {
      await this.activePump
      return
    }
    this.stopped = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    this.abort.abort()
    this.currentAbort?.abort()
    await this.activePump
  }
}
