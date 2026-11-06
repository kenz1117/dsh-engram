import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openJobQueue } from '../src/jobs/queue.ts'
import type { JobQueue } from '../src/jobs/queue.ts'
import { EngramError } from '../src/types.ts'

let dir: string
let clock: number
let queue: JobQueue

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'engram-jobs-'))
  clock = 1_700_000_000_000
  queue = await openJobQueue(join(dir, 'jobs.db'), { now: () => clock })
})
afterEach(() => {
  queue.close()
})

/** 断言 fn 抛出指定 code 的 EngramError；不抛或抛错码都算失败。 */
function expectJobError(fn: () => unknown, code: string): void {
  try {
    fn()
    expect.unreachable(`应抛 EngramError(${code})`)
  } catch (error) {
    expect(error).toBeInstanceOf(EngramError)
    expect((error as EngramError).code).toBe(code)
  }
}

describe('JobQueue (durable jobs)', () => {
  it('enqueue 按 id 幂等：重复入队不复制作业、不覆盖 payload', () => {
    const first = queue.enqueue({ id: 'reflect-1', kind: 'reflect', payload: { day: '2026-11-06' } })
    expect(first.deduped).toBe(false)
    expect(first.job.status).toBe('queued')
    expect(first.job.attempts).toBe(0)
    expect(first.job.maxAttempts).toBe(3) // 缺省
    const second = queue.enqueue({ id: 'reflect-1', kind: 'reflect', payload: { day: '被覆盖的负载' } })
    expect(second.deduped).toBe(true)
    expect(second.job).toEqual(first.job)
    expect(second.job.payload).toEqual({ day: '2026-11-06' })
    expect(queue.get('reflect-1')).toEqual(first.job)
  })

  it('payload 往返：复杂对象原样取回', () => {
    const payload = { memoryIds: ['m1', 'm2'], nested: { depth: 2, ok: true } }
    queue.enqueue({ id: 'p1', kind: 'reflect', payload })
    expect(queue.get('p1')?.payload).toEqual(payload)
  })

  it('两个 owner 竞争同一作业只能一个 claim；另一实例（同文件）看到已提交的租约', async () => {
    queue.enqueue({ id: 'j1', kind: 'consolidate', payload: null })
    const other = await openJobQueue(join(dir, 'jobs.db'), { now: () => clock })
    const claimA = queue.claim({ owner: 'worker-a', leaseMs: 60_000 })
    expect(claimA).toHaveLength(1)
    expect(claimA[0]?.leaseOwner).toBe('worker-a')
    expect(claimA[0]?.attempts).toBe(1)
    expect(claimA[0]?.leaseExpiresAt).toBe(clock + 60_000)
    // 租约有效期内，另一 worker（另一连接）claim 不到
    expect(other.claim({ owner: 'worker-b', leaseMs: 60_000 })).toHaveLength(0)
    other.close()
  })

  it('claim 支持批量与稳定排序，空队列返回 []', () => {
    for (let i = 0; i < 3; i++) queue.enqueue({ id: `batch-${i}`, kind: 'reflect', payload: i })
    expect(queue.claim({ owner: 'w1', leaseMs: 60_000, limit: 2 }).map(job => job.id)).toEqual(['batch-0', 'batch-1'])
    expect(queue.claim({ owner: 'w1', leaseMs: 60_000 }).map(job => job.id)).toEqual(['batch-2'])
    expect(queue.claim({ owner: 'w1', leaseMs: 60_000 })).toHaveLength(0)
  })

  it('claim 按 kinds 过滤：不匹配的 kind 不会挤占名额', () => {
    queue.enqueue({ id: 'r1', kind: 'reflect', payload: null })
    queue.enqueue({ id: 'c1', kind: 'consolidate', payload: null })
    const got = queue.claim({ owner: 'w1', leaseMs: 60_000, kinds: ['consolidate'] })
    expect(got).toHaveLength(1)
    expect(got[0]?.id).toBe('c1')
    expect(queue.get('r1')?.status).toBe('queued')
  })

  it('runAfter 延期入队：到期前 claim 不到，到期后可认领', () => {
    queue.enqueue({ id: 'later', kind: 'reflect', payload: null, runAfter: clock + 1_000 })
    expect(queue.claim({ owner: 'w1', leaseMs: 60_000 })).toHaveLength(0)
    clock += 1_000
    expect(queue.claim({ owner: 'w1', leaseMs: 60_000 }).map(job => job.id)).toEqual(['later'])
  })

  it('complete：仅当前租约持有者可完成，终态后不可再完成', () => {
    queue.enqueue({ id: 'j2', kind: 'reflect', payload: null })
    queue.claim({ owner: 'w1', leaseMs: 60_000 })
    expectJobError(() => queue.complete({ id: 'j2', owner: 'w2' }), 'JOB_OWNER_MISMATCH')
    const done = queue.complete({ id: 'j2', owner: 'w1' })
    expect(done.status).toBe('done')
    expect(done.leaseOwner).toBeNull()
    expect(done.leaseExpiresAt).toBeNull()
    expectJobError(() => queue.complete({ id: 'j2', owner: 'w1' }), 'JOB_NOT_RUNNING')
    // done 不会再被 claim
    expect(queue.claim({ owner: 'w3', leaseMs: 60_000 })).toHaveLength(0)
  })

  it('fail 未超 maxAttempts：回 queued 并按 retryDelayMs 延期，lastError 保留，attempts 随下次 claim 累加', () => {
    queue.enqueue({ id: 'j3', kind: 'reflect', payload: null, maxAttempts: 3 })
    queue.claim({ owner: 'w1', leaseMs: 60_000 })
    const failed = queue.fail({ id: 'j3', owner: 'w1', error: 'LLM 超时', retryDelayMs: 500 })
    expect(failed.status).toBe('queued')
    expect(failed.runAfter).toBe(clock + 500)
    expect(failed.lastError).toBe('LLM 超时')
    expect(failed.leaseOwner).toBeNull()
    // 延期未到不可认领
    expect(queue.claim({ owner: 'w2', leaseMs: 60_000 })).toHaveLength(0)
    clock += 500
    const retried = queue.claim({ owner: 'w2', leaseMs: 60_000 })
    expect(retried).toHaveLength(1)
    expect(retried[0]?.attempts).toBe(2)
    expect(retried[0]?.lastError).toBe('LLM 超时')
  })

  it('fail 超过 maxAttempts：dead-letter，终态不可认领、不可 complete/fail', () => {
    queue.enqueue({ id: 'j4', kind: 'reflect', payload: null, maxAttempts: 2 })
    queue.claim({ owner: 'w1', leaseMs: 60_000 })
    expect(queue.fail({ id: 'j4', owner: 'w1', error: 'e1' }).status).toBe('queued') // 1 < 2：重试
    queue.claim({ owner: 'w1', leaseMs: 60_000 })
    const dead = queue.fail({ id: 'j4', owner: 'w1', error: 'e2' })
    expect(dead.status).toBe('dead') // 2 >= 2：dead-letter
    expect(dead.lastError).toBe('e2')
    expect(dead.leaseOwner).toBeNull()
    expect(queue.claim({ owner: 'w2', leaseMs: 60_000 })).toHaveLength(0)
    expectJobError(() => queue.complete({ id: 'j4', owner: 'w1' }), 'JOB_NOT_RUNNING')
    expectJobError(() => queue.fail({ id: 'j4', owner: 'w1', error: 'e3' }), 'JOB_NOT_RUNNING')
  })

  it('lease 过期恢复：到期后可被新 owner 抢走，原 owner 立即失配', () => {
    queue.enqueue({ id: 'j5', kind: 'reflect', payload: null })
    queue.claim({ owner: 'w1', leaseMs: 1_000 })
    clock += 999
    expect(queue.claim({ owner: 'w2', leaseMs: 60_000 })).toHaveLength(0) // 差 1ms 未到期
    clock += 1
    const stolen = queue.claim({ owner: 'w2', leaseMs: 60_000 })
    expect(stolen).toHaveLength(1)
    expect(stolen[0]?.leaseOwner).toBe('w2')
    expect(stolen[0]?.attempts).toBe(2) // 抢走也算一次尝试
    expectJobError(() => queue.complete({ id: 'j5', owner: 'w1' }), 'JOB_OWNER_MISMATCH')
    expect(queue.complete({ id: 'j5', owner: 'w2' }).status).toBe('done')
  })

  it('租约过期（未被抢走）后原 owner 立即失去 complete/fail/checkpoint 权限', () => {
    queue.enqueue({ id: 'j9', kind: 'reflect', payload: null })
    queue.claim({ owner: 'w1', leaseMs: 1_000 })
    clock += 999
    // 有效租约内原行为不变
    expect(queue.checkpoint({ id: 'j9', owner: 'w1', checkpoint: '进行中' }).checkpoint).toBe('进行中')
    clock += 1 // 恰好到期：lease_expires_at <= now 即视为过期
    expectJobError(() => queue.complete({ id: 'j9', owner: 'w1' }), 'JOB_LEASE_EXPIRED')
    expectJobError(() => queue.fail({ id: 'j9', owner: 'w1', error: '迟到上报' }), 'JOB_LEASE_EXPIRED')
    expectJobError(() => queue.checkpoint({ id: 'j9', owner: 'w1', checkpoint: '迟到断点' }), 'JOB_LEASE_EXPIRED')
    // 守卫在写之前生效：状态/断点/租约原样，仍可被新 owner 认领恢复
    expect(queue.get('j9')).toMatchObject({ status: 'running', checkpoint: '进行中', leaseOwner: 'w1' })
    const stolen = queue.claim({ owner: 'w2', leaseMs: 60_000 })
    expect(stolen[0]?.attempts).toBe(2)
    // 新 owner 在有效租约内照常操作
    expect(queue.complete({ id: 'j9', owner: 'w2' }).status).toBe('done')
  })

  it('checkpoint：仅租约持有者可更新，不改租约；完成与抢走后都保留', () => {
    queue.enqueue({ id: 'j6', kind: 'consolidate', payload: null })
    queue.claim({ owner: 'w1', leaseMs: 60_000 })
    const marked = queue.checkpoint({ id: 'j6', owner: 'w1', checkpoint: '已聚类 3/10' })
    expect(marked.checkpoint).toBe('已聚类 3/10')
    expect(marked.leaseOwner).toBe('w1') // checkpoint 不续租、不改租约
    expect(marked.leaseExpiresAt).toBe(clock + 60_000)
    expectJobError(() => queue.checkpoint({ id: 'j6', owner: 'w2', checkpoint: '篡改' }), 'JOB_OWNER_MISMATCH')
    // 断点跨失败重试保留，续做方读到同一断点
    queue.fail({ id: 'j6', owner: 'w1', error: '中断' })
    const resumed = queue.claim({ owner: 'w2', leaseMs: 60_000 })
    expect(resumed[0]?.checkpoint).toBe('已聚类 3/10')
    expect(queue.complete({ id: 'j6', owner: 'w2' }).checkpoint).toBe('已聚类 3/10')
  })

  it('close/reopen 后状态持久：running 租约、checkpoint、延期作业都还在，过期照常恢复', async () => {
    queue.enqueue({ id: 'j7', kind: 'reflect', payload: { day: 1 } })
    queue.enqueue({ id: 'j8', kind: 'reflect', payload: { day: 2 }, runAfter: clock + 5_000 })
    expect(queue.claim({ owner: 'w1', leaseMs: 1_000 }).map(job => job.id)).toEqual(['j7'])
    queue.checkpoint({ id: 'j7', owner: 'w1', checkpoint: 'half' })
    queue.close()
    clock += 5_000 // j7 租约（1s）与 j8 延期（5s）同时到期
    queue = await openJobQueue(join(dir, 'jobs.db'), { now: () => clock })
    const kept = queue.get('j7')
    expect(kept?.status).toBe('running')
    expect(kept?.leaseOwner).toBe('w1')
    expect(kept?.attempts).toBe(1)
    expect(kept?.checkpoint).toBe('half')
    expect(kept?.createdAt).toBe(1_700_000_000_000)
    // 新实例按旧租约照常恢复：j7（run_after 更早）先被抢走，checkpoint 保留
    const stolen = queue.claim({ owner: 'w2', leaseMs: 60_000 })
    expect(stolen.map(job => job.id)).toEqual(['j7'])
    expect(stolen[0]?.checkpoint).toBe('half')
    expect(stolen[0]?.attempts).toBe(2)
    // j8 延期已到，下一轮可认领
    expect(queue.claim({ owner: 'w3', leaseMs: 60_000 }).map(job => job.id)).toEqual(['j8'])
  })

  it('输入校验：非法 id/kind/payload/数值/owner 一律 JOB_INVALID', () => {
    expectJobError(() => queue.enqueue({ id: '', kind: 'x', payload: null }), 'JOB_INVALID')
    expectJobError(() => queue.enqueue({ id: '  ', kind: 'x', payload: null }), 'JOB_INVALID')
    expectJobError(() => queue.enqueue({ id: 'x', kind: '', payload: null }), 'JOB_INVALID')
    expectJobError(() => queue.enqueue({ id: 'x', kind: 'x', payload: undefined }), 'JOB_INVALID')
    expectJobError(() => queue.enqueue({ id: 'x', kind: 'x', payload: () => 1 }), 'JOB_INVALID')
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expectJobError(() => queue.enqueue({ id: 'x', kind: 'x', payload: circular }), 'JOB_INVALID')
    expectJobError(() => queue.enqueue({ id: 'x', kind: 'x', payload: null, maxAttempts: 0 }), 'JOB_INVALID')
    expectJobError(() => queue.enqueue({ id: 'x', kind: 'x', payload: null, maxAttempts: 1.5 }), 'JOB_INVALID')
    expectJobError(() => queue.enqueue({ id: 'x', kind: 'x', payload: null, runAfter: -1 }), 'JOB_INVALID')
    expectJobError(() => queue.claim({ owner: '', leaseMs: 1 }), 'JOB_INVALID')
    expectJobError(() => queue.claim({ owner: 'w', leaseMs: 0 }), 'JOB_INVALID')
    expectJobError(() => queue.claim({ owner: 'w', leaseMs: 1, limit: -2 }), 'JOB_INVALID')
    expectJobError(() => queue.claim({ owner: 'w', leaseMs: 1, kinds: ['ok', ' '] }), 'JOB_INVALID')
    expectJobError(() => queue.fail({ id: 'x', owner: 'w', error: '' }), 'JOB_INVALID')
    expectJobError(() => queue.fail({ id: 'x', owner: 'w', error: 'e', retryDelayMs: -1 }), 'JOB_INVALID')
    expectJobError(() => queue.checkpoint({ id: 'x', owner: 'w', checkpoint: ' ' }), 'JOB_INVALID')
    expect(queue.get('x')).toBeUndefined()
  })

  it('不存在的作业：complete/fail/checkpoint 报 JOB_NOT_FOUND', () => {
    expectJobError(() => queue.complete({ id: 'ghost', owner: 'w' }), 'JOB_NOT_FOUND')
    expectJobError(() => queue.fail({ id: 'ghost', owner: 'w', error: 'e' }), 'JOB_NOT_FOUND')
    expectJobError(() => queue.checkpoint({ id: 'ghost', owner: 'w', checkpoint: 'c' }), 'JOB_NOT_FOUND')
  })

  it('毒丸隔离：payload 损坏的队首记录被就地 dead-letter，不回滚也不阻塞后续 claim', async () => {
    queue.enqueue({ id: 'healthy-1', kind: 'reflect', payload: { ok: 1 } })
    queue.enqueue({ id: 'healthy-2', kind: 'reflect', payload: { ok: 2 } })
    // 用另一个原始连接把一条 payload 非法 JSON 的行插到队首（run_after 更早）。
    const { DatabaseSync } = await import('node:sqlite')
    const raw = new DatabaseSync(join(dir, 'jobs.db'))
    try {
      raw.prepare(`INSERT INTO jobs
        (id, kind, payload, status, attempts, max_attempts, run_after, lease_owner, lease_expires_at, checkpoint, last_error, created_at, updated_at)
        VALUES (?, ?, ?, 'queued', 0, 3, ?, NULL, NULL, NULL, NULL, ?, ?)`)
        .run('poison', 'reflect', '{broken-json', clock - 1, clock, clock)
    } finally {
      raw.close()
    }
    // 队首毒丸不回滚整个 claim：同一次调用拿到后面的健康作业
    const taken = queue.claim({ owner: 'w1', leaseMs: 60_000, limit: 5 })
    expect(taken.map(job => job.id)).toEqual(['healthy-1', 'healthy-2'])
    expect(taken.every(job => job.leaseOwner === 'w1')).toBe(true)
    // 毒丸被标为 dead 且 last_error 记损坏原因（payload 仍是坏 JSON，须用原始连接读取）
    const rawAfter = new DatabaseSync(join(dir, 'jobs.db'))
    try {
      const row = rawAfter.prepare('SELECT status, last_error, lease_owner FROM jobs WHERE id = ?').get('poison') as
        { status: string; last_error: string | null; lease_owner: string | null }
      expect(row.status).toBe('dead')
      expect(row.lease_owner).toBeNull()
      expect(row.last_error).toContain('不是合法 JSON')
    } finally {
      rawAfter.close()
    }
    // 终态毒丸不再被认领
    expect(queue.claim({ owner: 'w2', leaseMs: 60_000 })).toHaveLength(0)
  })

  it('prune：只删过窗 done/dead，queued/running 与阈值上的终态保留，返回删除行数', () => {
    // 旧终态：done 与 dead，updated_at = T0
    queue.enqueue({ id: 'done-old', kind: 'reflect', payload: null })
    queue.claim({ owner: 'w1', leaseMs: 60_000 })
    queue.complete({ id: 'done-old', owner: 'w1' })
    queue.enqueue({ id: 'dead-old', kind: 'reflect', payload: null, maxAttempts: 1 })
    queue.claim({ owner: 'w1', leaseMs: 60_000 })
    queue.fail({ id: 'dead-old', owner: 'w1', error: 'e' })
    clock += 10_000
    // 新终态：updated_at = T1 = T0 + 10s
    queue.enqueue({ id: 'done-new', kind: 'reflect', payload: null })
    queue.claim({ owner: 'w1', leaseMs: 60_000 })
    queue.complete({ id: 'done-new', owner: 'w1' })
    // 未终态：旧 queued（延期未到）与旧 running（租约仍有效），updated_at = T1
    queue.enqueue({ id: 'queued-old', kind: 'reflect', payload: null, runAfter: clock + 60_000 })
    queue.enqueue({ id: 'running-old', kind: 'reflect', payload: null })
    queue.claim({ owner: 'w2', leaseMs: 60_000 })
    clock += 5_000 // now = T0 + 15s
    // 边界：updated_at 恰在阈值上（now - 15s = T0）不算「早于」，不删
    expect(queue.prune(15_000)).toBe(0)
    expect(queue.get('done-old')).toEqual(expect.objectContaining({ status: 'done' }))
    // 比阈值早 1ms 的终态删除，未终态与较新终态保留
    expect(queue.prune(14_999)).toBe(2)
    expect(queue.get('done-old')).toBeUndefined()
    expect(queue.get('dead-old')).toBeUndefined()
    expect(queue.get('done-new')).toEqual(expect.objectContaining({ status: 'done' }))
    expect(queue.get('queued-old')).toEqual(expect.objectContaining({ status: 'queued' }))
    expect(queue.get('running-old')).toEqual(expect.objectContaining({ status: 'running' }))
    // 0 阈值 = 立即回收 now 之前的全部终态（done-new 已比 now 早 5s），queued/running 依然不动
    expect(queue.prune(0)).toBe(1)
    expect(queue.get('done-new')).toBeUndefined()
    expect(queue.get('queued-old')).toEqual(expect.objectContaining({ status: 'queued' }))
    expect(queue.get('running-old')).toEqual(expect.objectContaining({ status: 'running' }))
  })

  it('prune 输入校验：负数与非整数报 JOB_INVALID', () => {
    expectJobError(() => queue.prune(-1), 'JOB_INVALID')
    expectJobError(() => queue.prune(1.5), 'JOB_INVALID')
    expectJobError(() => queue.prune(Number.NaN), 'JOB_INVALID')
  })

  it('list/summary：轻量投影、状态过滤、新到旧排序且不含 payload', () => {
    queue.enqueue({ id: 'sum-queued', kind: 'reflect', payload: { n: 1 } }).job
    const second = queue.enqueue({ id: 'sum-running', kind: 'consolidate', payload: { n: 2 } }).job
    queue.claim({ owner: 'w1', leaseMs: 60_000, kinds: ['consolidate'] })
    const done = queue.enqueue({ id: 'sum-done', kind: 'reflect', payload: { n: 3 } }).job
    queue.claim({ owner: 'w2', leaseMs: 60_000 })
    queue.complete({ id: done.id, owner: 'w2' })
    const dead = queue.enqueue({ id: 'sum-dead', kind: 'reflect', payload: null, maxAttempts: 1 }).job
    queue.claim({ owner: 'w3', leaseMs: 60_000 })
    queue.fail({ id: dead.id, owner: 'w3', error: 'permanent' })

    expect(queue.summary()).toEqual({ total: 4, queued: 1, running: 1, done: 1, dead: 1 })

    const all = queue.list({ limit: 10 })
    expect(all.map(job => job.id)).toEqual(['sum-dead', 'sum-done', 'sum-running', 'sum-queued'])
    expect(all.every(job => !('payload' in job))).toBe(true)
    expect(all.find(job => job.id === second.id)).toMatchObject({
      kind: 'consolidate', status: 'running', attempts: 1, leaseOwner: 'w1',
    })

    expect(queue.list({ statuses: ['dead'], limit: 10 }).map(job => job.id)).toEqual(['sum-dead'])
    expect(queue.list({ statuses: ['queued', 'done'], limit: 10 }).map(job => job.id)).toEqual(['sum-done', 'sum-queued'])
    expect(() => queue.list({ statuses: ['bogus' as never] })).toThrowError(/status/)
    expect(() => queue.list({ limit: 0 })).toThrowError(/limit/)
  })

  it('打开校验：非法 path 与非有限时钟报 JOB_INVALID', async () => {
    await expect(openJobQueue('', { now: () => clock })).rejects.toMatchObject({ code: 'JOB_INVALID' })
    await expect(openJobQueue(join(dir, 'bad.db'), { now: () => Number.NaN })).rejects.toMatchObject({ code: 'JOB_INVALID' })
  })
})
