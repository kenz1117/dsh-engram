import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openJobQueue } from '../src/jobs/queue.ts'
import type { JobQueue } from '../src/jobs/queue.ts'
import { DurableReflectWorker } from '../src/jobs/reflect-worker.ts'
import type { DurableReflectWorkerOptions, ReflectJobPayload } from '../src/jobs/reflect-worker.ts'
import { startAutoReflectWorker } from '../src/jobs/host-reflect.ts'

let dir: string
let clock: number
let queue: JobQueue
let workers: DurableReflectWorker[]

const payload: ReflectJobPayload = {
  sessionId: 'sess-a',
  scope: 'user',
  route: { provider: 'deepseek', model: 'deepseek-v4' },
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'engram-reflect-worker-'))
  clock = 1_700_000_000_000
  queue = await openJobQueue(join(dir, 'jobs.db'), { now: () => clock })
  workers = []
})

afterEach(async () => {
  for (const worker of workers) await worker.stop()
  queue.close()
  await rm(dir, { recursive: true, force: true })
})

function makeWorker(options: Partial<DurableReflectWorkerOptions> & Pick<DurableReflectWorkerOptions, 'execute'>): DurableReflectWorker {
  const worker = new DurableReflectWorker({ queue, ...options })
  workers.push(worker)
  return worker
}

describe('DurableReflectWorker', () => {
  it('确定性入队幂等，成功执行后 complete 且不重复执行', async () => {
    const execute = vi.fn(async (_payload: ReflectJobPayload, _signal: AbortSignal) => {})
    const worker = makeWorker({ execute })
    expect(worker.enqueue(payload).deduped).toBe(false)
    expect(worker.enqueue(payload).deduped).toBe(true)
    await worker.pump()
    await worker.pump()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0]?.[0]).toEqual(payload)
    expect(queue.get('reflect:sess-a:user')?.status).toBe('done')
  })

  it('失败按 runAfter 重排，到期后再次执行并保留 attempts', async () => {
    let calls = 0
    const worker = makeWorker({
      retryDelayMs: 500,
      execute: async () => {
        calls += 1
        if (calls === 1) throw new Error('LLM 超时')
      },
    })
    worker.enqueue(payload)
    await worker.pump()
    expect(queue.get('reflect:sess-a:user')).toMatchObject({ status: 'queued', attempts: 1, lastError: 'LLM 超时' })
    await worker.pump()
    expect(calls).toBe(1)
    clock += 500
    await worker.pump()
    expect(calls).toBe(2)
    expect(queue.get('reflect:sess-a:user')).toMatchObject({ status: 'done', attempts: 2 })
  })

  it('并发 pump 共享同一批执行，executor 不并行', async () => {
    let release: (() => void) | undefined
    let started: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const began = new Promise<void>(resolve => { started = resolve })
    const execute = vi.fn(async () => {
      started?.()
      await gate
    })
    const worker = makeWorker({ execute })
    worker.enqueue(payload)
    const first = worker.pump()
    const second = worker.pump()
    expect(second).toBe(first)
    await began
    expect(execute).toHaveBeenCalledTimes(1)
    release?.()
    await Promise.all([first, second])
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('stop 取消在途执行、保留 queued 作业且不关闭 queue', async () => {
    let began: (() => void) | undefined
    const started = new Promise<void>(resolve => { began = resolve })
    const worker = makeWorker({
      retryDelayMs: 0,
      execute: (_payload, signal) => new Promise<void>((_resolve, reject) => {
        began?.()
        signal.addEventListener('abort', () => reject(new Error('cancelled by stop')), { once: true })
      }),
    })
    worker.enqueue(payload)
    const running = worker.pump()
    await started
    await worker.stop()
    await running
    expect(queue.get('reflect:sess-a:user')).toMatchObject({ status: 'queued', attempts: 1, lastError: 'cancelled by stop' })

    const recovered = makeWorker({ execute: async () => {} })
    await recovered.pump()
    expect(queue.get('reflect:sess-a:user')).toMatchObject({ status: 'done', attempts: 2 })
  })

  it('start 自动接管持久化的过期 running 作业', async () => {
    queue.enqueue({ id: 'reflect:sess-a:user', kind: 'reflect', payload, maxAttempts: 3 })
    queue.claim({ owner: 'previous-process', leaseMs: 1000 })
    clock += 1000
    const execute = vi.fn(async (_payload: ReflectJobPayload, _signal: AbortSignal) => {})
    const worker = makeWorker({ execute, intervalMs: 60_000 })
    worker.start()
    await worker.pump()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(queue.get('reflect:sess-a:user')).toMatchObject({ status: 'done', attempts: 2 })
  })

  it('队列级异常只进入 onError，不形成未处理 rejection', async () => {
    const broken = new Proxy(queue, {
      get: (target, property, receiver) => {
        if (property === 'claim') return () => { throw new Error('queue temporarily unavailable') }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as JobQueue
    const onError = vi.fn()
    const worker = new DurableReflectWorker({ queue: broken, execute: async () => {}, onError })
    workers.push(worker)
    await worker.pump()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]?.[0].message).toBe('queue temporarily unavailable')
  })

  it('坏 payload 进入失败恢复路径，不击穿调度循环', async () => {
    queue.enqueue({ id: 'bad', kind: 'reflect', payload: { bad: true } })
    const onError = vi.fn()
    const worker = makeWorker({ execute: async () => {}, onError })
    await worker.pump()
    expect(queue.get('bad')).toMatchObject({ status: 'queued', attempts: 1 })
    expect(queue.get('bad')?.lastError).toContain('sessionId')
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('eventSeq 参与确定性 id：同 seq 幂等，seq 前进即新作业，无 seq 保持旧 id', async () => {
    const execute = vi.fn(async (_payload: ReflectJobPayload, _signal: AbortSignal) => {})
    const worker = makeWorker({ execute })
    const first = worker.enqueue({ ...payload, eventSeq: 0 })
    expect(first.deduped).toBe(false)
    expect(first.job.id).toBe('reflect:sess-a:user:0')
    expect(worker.enqueue({ ...payload, eventSeq: 0 }).deduped).toBe(true) // 同 session/scope 同 seq 幂等
    const next = worker.enqueue({ ...payload, eventSeq: 1 })
    expect(next.deduped).toBe(false)
    expect(next.job.id).toBe('reflect:sess-a:user:1')
    expect(worker.enqueue(payload).job.id).toBe('reflect:sess-a:user') // 无 eventSeq 兼容旧 id
    await worker.pump()
    const executed = execute.mock.calls.map(call => call[0])
    expect(executed).toContainEqual({ ...payload, eventSeq: 0 })
    expect(executed).toContainEqual({ ...payload, eventSeq: 1 })
    expect(queue.get('reflect:sess-a:user:0')).toMatchObject({ status: 'done' })
    expect(queue.get('reflect:sess-a:user:1')).toMatchObject({ status: 'done' })
  })

  it('前一 eventSeq 作业 done 后，更大的 eventSeq 仍能入队并执行', async () => {
    let calls = 0
    const worker = makeWorker({ execute: async () => { calls += 1 } })
    worker.enqueue({ ...payload, eventSeq: 7 })
    await worker.pump()
    expect(queue.get('reflect:sess-a:user:7')).toMatchObject({ status: 'done' })
    const next = worker.enqueue({ ...payload, eventSeq: 8 })
    expect(next.deduped).toBe(false)
    await worker.pump()
    expect(calls).toBe(2)
    expect(queue.get('reflect:sess-a:user:8')).toMatchObject({ status: 'done' })
  })

  it('前一 eventSeq 作业 dead 后，更大的 eventSeq 仍能入队并执行', async () => {
    const worker = makeWorker({
      retryDelayMs: 0,
      execute: async () => { throw new Error('永久失败') },
    })
    worker.enqueue({ ...payload, eventSeq: 7 })
    await worker.pump()
    await worker.pump()
    await worker.pump() // 3 次 attempts 耗尽 → dead-letter
    expect(queue.get('reflect:sess-a:user:7')).toMatchObject({ status: 'dead', attempts: 3 })
    const recovered = makeWorker({ execute: async () => {} })
    expect(recovered.enqueue({ ...payload, eventSeq: 8 }).deduped).toBe(false)
    await recovered.pump()
    expect(queue.get('reflect:sess-a:user:8')).toMatchObject({ status: 'done' })
  })

  it('eventSeq 校验：负数/非整数/非数字拒绝，0 合法', () => {
    const worker = makeWorker({ execute: async () => {} })
    expect(() => worker.enqueue({ ...payload, eventSeq: -1 })).toThrow('eventSeq 必须是非负整数')
    expect(() => worker.enqueue({ ...payload, eventSeq: 1.5 })).toThrow('eventSeq 必须是非负整数')
    expect(() => worker.enqueue({ ...payload, eventSeq: Number.NaN })).toThrow('eventSeq 必须是非负整数')
    expect(() => worker.enqueue({ ...payload, eventSeq: '3' as unknown as number })).toThrow('eventSeq 必须是非负整数')
    expect(worker.enqueue({ ...payload, eventSeq: 0 }).job.id).toBe('reflect:sess-a:user:0')
  })
})

describe('host-reflect（宿主装配）', () => {
  const DAY = 86_400_000

  /** 用原始连接读 jobs 表的 id → status 映射（宿主已把 queue 关闭，只能这么看）。 */
  function readStatuses(path: string): Record<string, string> {
    const db = new DatabaseSync(path)
    try {
      return Object.fromEntries(
        (db.prepare('SELECT id, status FROM jobs ORDER BY id').all() as { id: string; status: string }[])
          .map(row => [row.id, row.status]),
      )
    } finally {
      db.close()
    }
  }

  it('启动即 prune 过窗终态作业，24h 班车再清一次，stop 清定时器并关闭 queue', async () => {
    // 宿主固定打开 dbDir/jobs.db：用独立子目录，避免与外层 beforeEach 的 queue 撞文件
    const hostDir = join(dir, 'host')
    const hostPath = join(hostDir, 'jobs.db')
    // 先由 openJobQueue 建好表结构，再用原始连接预置三档 updated_at 的 done 行
    const bootstrap = await openJobQueue(hostPath)
    bootstrap.close()
    const raw = new DatabaseSync(hostPath)
    vi.useFakeTimers()
    try {
      const nowMs = Date.now()
      const insert = raw.prepare(`INSERT INTO jobs
        (id, kind, payload, status, attempts, max_attempts, run_after, lease_owner, lease_expires_at, checkpoint, last_error, created_at, updated_at)
        VALUES (?, 'reflect', '{}', 'done', 1, 3, 0, NULL, NULL, NULL, NULL, ?, ?)`)
      insert.run('stale', nowMs - 366 * DAY - 5_000, nowMs - 366 * DAY - 5_000) // 已过 366 天窗口 → 启动即清
      insert.run('aging', nowMs - 366 * DAY + 60_000, nowMs - 366 * DAY + 60_000) // 差 60s 过窗 → 启动保留、24h 班车清
      insert.run('fresh', nowMs - 1_000, nowMs - 1_000) // 新终态 → 一直保留
    } finally {
      raw.close()
    }
    const hosted = await startAutoReflectWorker({
      dbDir: hostDir,
      dbNameForCwd: () => 'project.db',
      openStore: async () => { throw new Error('不应打开 store') },
      openProjectStore: async () => { throw new Error('不应打开项目库') },
      embedder: async () => undefined,
      call: async () => '',
    })
    try {
      expect(readStatuses(hostPath)).toEqual({ aging: 'done', fresh: 'done' }) // 启动 prune：只清 stale
      vi.advanceTimersByTime(24 * 3_600_000) // 24h 班车：aging 此刻已越过 366 天窗口
      expect(readStatuses(hostPath)).toEqual({ fresh: 'done' })
    } finally {
      await hosted.stop()
    }
    vi.useRealTimers()
    // stop 后 queue 已关闭：任何队列操作都会抛错（证明 stop 兜底 close 生效）
    expect(() => hosted.enqueue(payload)).toThrow()
  })
})
