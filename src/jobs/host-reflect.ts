/**
 * DSH 宿主侧的 reflect 作业工厂：打开持久队列，执行真实巩固，并统一停止/关闭。
 * @module @kenz1117/dsh-engram/jobs/host-reflect
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { reflectObservations } from '../consolidation/reflect.ts'
import type { ReflectDeps } from '../consolidation/reflect.ts'
import type { EngramEmbedder } from '../embedder/interface.ts'
import { message } from '../i18n/messages.ts'
import type { EngramStore } from '../store/interface.ts'
import type { EngramScope } from '../types.ts'
import { openJobQueue } from './queue.ts'
import { DurableReflectWorker } from './reflect-worker.ts'
import type { ReflectJobPayload } from './reflect-worker.ts'

export interface HostedReflectWorker {
  enqueue(payload: ReflectJobPayload): void
  pump(): Promise<void>
  stop(): Promise<void>
}

export interface AutoReflectHostOptions {
  readonly dbDir: string
  readonly dbNameForCwd: (cwd: string) => string
  readonly openStore: (scope: EngramScope) => Promise<EngramStore>
  readonly openProjectStore: (cwd: string) => Promise<EngramStore>
  readonly embedder: () => Promise<EngramEmbedder | undefined>
  readonly call: (sessionId: string, params: Parameters<ReflectDeps['call']>[0]) => Promise<string>
}

/** 终态作业保留窗口：与主库 op_log 同款 366 天，过窗 done/dead 由 prune 清除。 */
const PRUNE_RETENTION_MS = 366 * 86_400_000
/** prune 班车间隔：24 小时一班，启动时先跑一次。 */
const PRUNE_INTERVAL_MS = 24 * 3_600_000

/** 启动真实 reflect worker；stop 先取消在途执行，再关闭独立 jobs.db。 */
export async function startAutoReflectWorker(options: AutoReflectHostOptions): Promise<HostedReflectWorker> {
  const queue = await openJobQueue(join(options.dbDir, 'jobs.db'))
  // 历史回收班车：启动即清一次过期终态作业，此后每 24 小时一班；
  // 单次失败不反向终止调度，等下一班再试。
  try { queue.prune(PRUNE_RETENTION_MS) } catch (error) {
    console.warn(message('core.warnReflectFailed', { scope: 'prune' }), error)
  }
  const pruneTimer = setInterval(() => {
    try { queue.prune(PRUNE_RETENTION_MS) } catch { /* 队列暂不可用时等下一班 */ }
  }, PRUNE_INTERVAL_MS)
  pruneTimer.unref()
  const worker = new DurableReflectWorker({
    queue,
    execute: async (payload, signal) => {
      const scope = payload.scope
      // 项目库在入队后可能被删除：过时作业明确完成，不为已消失项目重建空库。
      if (scope === 'project' && (payload.cwd === undefined || !existsSync(join(options.dbDir, options.dbNameForCwd(payload.cwd))))) return
      const store = scope === 'user'
        ? await options.openStore('user')
        : await options.openProjectStore(payload.cwd!)
      const outcome = await reflectObservations({
        store,
        embedder: await options.embedder(),
        scope,
        call: params => options.call(payload.sessionId, params),
        logRequest: data => {
          void store.audit('reflect-request', 'AUX', JSON.stringify(data)).catch(() => { /* 审计失败不影响巩固 */ })
        },
        route: payload.route,
        signal,
      })
      if (outcome.formed + outcome.refined + outcome.confirmed + outcome.refuted > 0) {
        console.log(message('core.logReflectDone', {
          scope,
          formed: outcome.formed,
          refined: outcome.refined,
          confirmed: outcome.confirmed,
          refuted: outcome.refuted,
        }))
      }
      if (outcome.dropped > 0) console.warn(message('core.warnReflectBatchDropped', { count: outcome.dropped }))
    },
    onError: (error, job) => {
      const scope = (job?.payload as { scope?: unknown } | undefined)?.scope
      console.warn(message('core.warnReflectFailed', { scope: typeof scope === 'string' ? scope : 'unknown' }), error)
    },
  })
  worker.start()
  return {
    enqueue: payload => { worker.enqueue(payload) },
    pump: () => worker.pump(),
    stop: async () => {
      // 先停 prune 班车（避免对已关闭的队列跑 prune），再取消在途执行并关闭 jobs.db。
      clearInterval(pruneTimer)
      try { await worker.stop() } finally { queue.close() }
    },
  }
}
