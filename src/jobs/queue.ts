/**
 * 持久作业队列原语：基于 node:sqlite 的独立 DB 文件（WAL + busy_timeout），
 * 供后续 reflect/consolidation 等宿主调度使用——本模块只提供队列原语，不做调度。
 *
 * 与主库（store/sqlite）的差别：队列按「多 worker 竞争」设计，写事务一律
 * BEGIN IMMEDIATE——先拿写锁再动手，撞车交给 busy_timeout 等待，而不是让
 * 事务中途从读锁升级写锁时撞 SQLITE_BUSY。表名固定常量、全部参数化查询，
 * 不存在拼接用户输入的 SQL 面。
 *
 * 状态机（无独立 retrying 状态，重试 = 回 queued + 延期 runAfter，attempts 保留）：
 *   queued --claim--> running --complete--> done
 *      ^                 |    --fail(attempts<max)--> queued（runAfter 延期）
 *      |                 └─── --fail(attempts>=max)--> dead
 *      └-------- claim 到期的 queued；claim 租约过期的 running（被新 owner 抢走）
 *
 * done/dead 是终态：不可 claim、不可 complete/fail/checkpoint；只能被 prune 按
 * 保留窗口清除（历史垃圾回收），或因 payload 损坏（毒丸）被 claim 就地 dead-letter。
 * @module @kenz1117/dsh-engram/jobs/queue
 */

import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { EngramError } from '../types.ts'

/** 表名固定常量：所有语句写死引用它，绝不拼接调用方输入。 */
const TABLE = 'jobs'
/** 队列库自身结构版本（PRAGMA user_version）；结构性变更必须 +1。 */
const QUEUE_SCHEMA_VERSION = 1
/** maxAttempts 缺省值：允许 3 次尝试（首次 + 2 次重试）。 */
const DEFAULT_MAX_ATTEMPTS = 3

/** 作业状态。queued 到期可被认领；running 持有租约；done/dead 终态。 */
export type JobStatus = 'queued' | 'running' | 'done' | 'dead'

/** 一条持久作业。时间为 epoch 毫秒；leaseOwner/leaseExpiresAt/checkpoint/lastError 只在相应阶段非空。 */
export interface JobRecord {
  /** 调用方给定的确定性 id（主键）：同 id 重复入队不会产生第二条作业。 */
  readonly id: string
  /** 作业种类（如 'reflect' / 'consolidate'），claim 时可按 kind 过滤。 */
  readonly kind: string
  /** 入队负载（JSON 反序列化后的值）。 */
  readonly payload: unknown
  readonly status: JobStatus
  /** 已被认领次数：每次 claim（含过期抢走）+1，fail 用它与 maxAttempts 判定去留。 */
  readonly attempts: number
  /** 最大尝试次数；attempts 达到它之后下一次 fail 直接 dead-letter。 */
  readonly maxAttempts: number
  /** 最早可认领时间：claim 只取 run_after <= now 的 queued 作业。 */
  readonly runAfter: number
  /** 当前租约持有者；queued/done/dead 为 null。 */
  readonly leaseOwner: string | null
  /** 租约到期时刻：running 且 lease_expires_at <= now 视为可被抢走。 */
  readonly leaseExpiresAt: number | null
  /** 断点续做标记（调用方自定义字符串）；跨重试与 close/reopen 保留。 */
  readonly checkpoint: string | null
  /** 最近一次 fail 的原因；成功完成后保留（反映最后一次失败历史），入队/认领期不产生。 */
  readonly lastError: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

/** enqueue 输入。payload 必须可 JSON 序列化；缺省 runAfter = 入队时刻立即可认领。 */
export interface EnqueueInput {
  readonly id: string
  readonly kind: string
  readonly payload: unknown
  readonly maxAttempts?: number
  readonly runAfter?: number
}

/** enqueue 结果：deduped = true 表示命中同 id 已有作业、原样返回且未做任何改动。 */
export interface EnqueueResult {
  readonly job: JobRecord
  readonly deduped: boolean
}

/** claim 输入：owner 是 worker 身份标识（进程内两实例也须不同）；leaseMs 是本次租约时长。 */
export interface ClaimInput {
  readonly owner: string
  readonly leaseMs: number
  /** 只认领这些 kind；缺省不限。 */
  readonly kinds?: readonly string[]
  /** 一次最多认领几条；缺省 1。 */
  readonly limit?: number
}

/** complete/fail/checkpoint 的公共输入：id + 当前租约持有者身份。 */
export interface OwnerInput {
  readonly id: string
  readonly owner: string
}

/** fail 输入：error 记入 lastError；attempts < maxAttempts 时按 retryDelayMs（缺省 0 = 立即可重试）回 queued，否则 dead-letter。 */
export interface FailInput extends OwnerInput {
  readonly error: string
  readonly retryDelayMs?: number
}

/** checkpoint 输入：running 途中任意次更新断点；不改租约。 */
export interface CheckpointInput extends OwnerInput {
  readonly checkpoint: string
}

/** 队列选项：now 注入时钟（epoch 毫秒），测试用可变变量即可全程确定性。 */
export interface JobQueueOptions {
  readonly now?: () => number
}

/** 持久作业队列。同一 DB 文件可开多个实例（多 worker 竞争靠事务 + 租约保证）。 */
export interface JobQueue {
  /** 按 id 幂等入队：同 id 已存在时原样返回旧作业（deduped: true），不复制作业、不覆盖 payload。 */
  enqueue(input: EnqueueInput): EnqueueResult
  /**
   * 手工事务内认领：只取「到期的 queued」或「租约已过期的 running」（抢走），
   * 每条 attempts+1 并写入新租约。候选按 run_after、id 稳定排序，同一次调用
   * 内多条候选只会被本次 owner 独占——其他 owner 同时 claim 拿不到同一条。
   * 抢走保留上一轮 checkpoint（断点续做）；lastError 原样保留供诊断。
   * 毒丸隔离：payload JSON 损坏的候选被就地 dead-letter（last_error 记损坏原因），
   * 本次不返回它，也不让整个 claim 回滚——队首毒丸不会永久阻塞后续健康作业。
   */
  claim(input: ClaimInput): readonly JobRecord[]
  /** 仅当前租约持有者且租约未过期时可完成；终态化 done，清租约。checkpoint/lastError 保留。 */
  complete(input: OwnerInput): JobRecord
  /** 仅当前租约持有者且租约未过期时可申报失败：按 maxAttempts 决定回 queued（延期）或 dead-letter。 */
  fail(input: FailInput): JobRecord
  /** 仅当前租约持有者且租约未过期时可更新断点；租约时长不变（过期后请重新 claim，attempts 会 +1）。 */
  checkpoint(input: CheckpointInput): JobRecord
  /** 按 id 读取当前记录；不存在返回 undefined。 */
  get(id: string): JobRecord | undefined
  /** 历史回收：只删除 updated_at 早于 now - olderThanMs 的终态作业（done/dead）；queued/running 一律不动。返回删除行数。 */
  prune(olderThanMs: number): number
  /** 关闭句柄。close 后可在同路径重新 openJobQueue——全部状态持久。 */
  close(): void
}

/** 校验非空字符串（不静默 trim：只拒绝纯空白，原文原样入库）。 */
function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new EngramError('JOB_INVALID', `jobs: ${field} 必须是非空字符串`)
  }
  return value
}

/** 校验正整数（maxAttempts/leaseMs/limit）。 */
function requirePositiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new EngramError('JOB_INVALID', `jobs: ${field} 必须是正整数`)
  }
  return value
}

/** 校验非负整数（runAfter/retryDelayMs）。 */
function requireNonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new EngramError('JOB_INVALID', `jobs: ${field} 必须是非负整数`)
  }
  return value
}

/** payload 只收可 JSON 序列化的值：undefined/函数/循环引用一律 JOB_INVALID。 */
function serializePayload(payload: unknown): string {
  let json: string | undefined
  try {
    json = JSON.stringify(payload)
  } catch (cause) {
    throw new EngramError('JOB_INVALID', 'jobs: payload 必须可 JSON 序列化', { cause })
  }
  if (json === undefined) throw new EngramError('JOB_INVALID', 'jobs: payload 必须可 JSON 序列化')
  return json
}

/** complete/fail/checkpoint 共用的守卫：作业存在、正在 running、调用方就是当前租约持有者、且租约未过期。 */
function requireOwnedRunning(row: JobRow, input: OwnerInput, at: number): void {
  if (row.status !== 'running') {
    throw new EngramError('JOB_NOT_RUNNING', `jobs: 作业 ${row.id} 不在 running（当前 ${row.status}）`)
  }
  if (row.lease_owner !== input.owner) {
    throw new EngramError('JOB_OWNER_MISMATCH', `jobs: 作业 ${row.id} 的租约持有者是 ${row.lease_owner ?? '无'}，不是 ${input.owner}`)
  }
  // 过期即失权：哪怕尚未被其他 owner 抢走，迟到上报也不允许——继续写终态会与
  // 即将发生的抢走（claim）竞争同一作业。续做请重新 claim（attempts 会 +1）。
  if (row.lease_expires_at === null || row.lease_expires_at <= at) {
    throw new EngramError('JOB_LEASE_EXPIRED', `jobs: 作业 ${row.id} 的租约已于 ${row.lease_expires_at} 过期（now ${at}），owner ${input.owner} 须重新 claim`)
  }
}

/** 行结构（snake_case 列）。 */
interface JobRow {
  readonly id: string
  readonly kind: string
  readonly payload: string
  readonly status: string
  readonly attempts: number
  readonly max_attempts: number
  readonly run_after: number
  readonly lease_owner: string | null
  readonly lease_expires_at: number | null
  readonly checkpoint: string | null
  readonly last_error: string | null
  readonly created_at: number
  readonly updated_at: number
}

/**
 * 打开（必要时创建）一个独立队列库。
 * @param path - SQLite 文件路径；目录不存在会自动创建（0o700）。
 * @param options - now 注入时钟；缺省 Date.now。
 * @returns 就绪的 JobQueue。
 * @throws EngramError(code=SCHEMA_INCOMPATIBLE) 当队列库结构版本高于当前实现。
 * @throws EngramError(code=JOB_INVALID) 当 path 非法或时钟不可用。
 */
export async function openJobQueue(path: string, options: JobQueueOptions = {}): Promise<JobQueue> {
  if (typeof path !== 'string' || path.length === 0) {
    throw new EngramError('JOB_INVALID', 'jobs: path 必须是非空字符串')
  }
  const now = options.now ?? (() => Date.now())
  const probed = now()
  if (typeof probed !== 'number' || !Number.isFinite(probed)) {
    throw new EngramError('JOB_INVALID', 'jobs: 注入的 now() 必须返回有限数字')
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path)
  /** 手工事务（IMMEDIATE：队列是多写者场景，先拿写锁让 busy_timeout 吸收竞争）。 */
  const withTransaction = (fn: () => void): void => {
    db.exec('BEGIN IMMEDIATE')
    try {
      fn()
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  let versionRow: { user_version: number } | undefined
  try {
    // 与主库同款：WAL 让读写不互斥；busy_timeout 给 5s 撞车缓冲；NORMAL 配 WAL 是官方推荐档。
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec('PRAGMA busy_timeout = 5000;')
    db.exec('PRAGMA synchronous = NORMAL;')
    versionRow = db.prepare('PRAGMA user_version').get() as unknown as { user_version: number } | undefined
    const version = versionRow?.user_version ?? 0
    if (version > QUEUE_SCHEMA_VERSION) {
      throw new EngramError('SCHEMA_INCOMPATIBLE', `jobs: 队列库结构版本过新（found ${version} > supported ${QUEUE_SCHEMA_VERSION}，path ${path}）`)
    }
    if (version < QUEUE_SCHEMA_VERSION) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ${TABLE} (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          payload TEXT NOT NULL,
          status TEXT NOT NULL,
          attempts INTEGER NOT NULL,
          max_attempts INTEGER NOT NULL,
          run_after INTEGER NOT NULL,
          lease_owner TEXT,
          lease_expires_at INTEGER,
          checkpoint TEXT,
          last_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS jobs_due ON ${TABLE} (status, run_after);
        PRAGMA user_version = ${QUEUE_SCHEMA_VERSION};`)
    }
  } catch (error) {
    // 打开/建表中途失败的句柄必须就地关掉（同主库审计 N3）：否则进程握着写锁直到退出。
    try { db.close() } catch { /* 目的是释放句柄；二次失败不遮盖原错误 */ }
    throw error
  }

  const sqlGet = db.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`)
  const sqlInsert = db.prepare(`INSERT INTO ${TABLE}
    (id, kind, payload, status, attempts, max_attempts, run_after, lease_owner, lease_expires_at, checkpoint, last_error, created_at, updated_at)
    VALUES (?, ?, ?, 'queued', 0, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`)
  const sqlDue = db.prepare(`SELECT * FROM ${TABLE}
    WHERE ((status = 'queued' AND run_after <= ?)
       OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?))
    ORDER BY run_after ASC, id ASC
    LIMIT ?`)
  // kind 过滤走 json_each（同主库 sqlGetManyByIds 的 id 列表用法）：kinds 以 JSON 数组绑定，
  // 语句零拼接、LIMIT 在过滤之后生效——不会让不匹配的 kind 挤占名额。
  const sqlDueKinds = db.prepare(`SELECT * FROM ${TABLE}
    WHERE ((status = 'queued' AND run_after <= ?)
       OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?))
      AND kind IN (SELECT value FROM json_each(?))
    ORDER BY run_after ASC, id ASC
    LIMIT ?`)
  const sqlTake = db.prepare(`UPDATE ${TABLE}
    SET status = 'running', attempts = attempts + 1, lease_owner = ?, lease_expires_at = ?, updated_at = ?
    WHERE id = ?`)
  const sqlComplete = db.prepare(`UPDATE ${TABLE}
    SET status = 'done', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
    WHERE id = ?`)
  const sqlRetry = db.prepare(`UPDATE ${TABLE}
    SET status = 'queued', run_after = ?, lease_owner = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ?
    WHERE id = ?`)
  const sqlDead = db.prepare(`UPDATE ${TABLE}
    SET status = 'dead', lease_owner = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ?
    WHERE id = ?`)
  const sqlCheckpoint = db.prepare(`UPDATE ${TABLE} SET checkpoint = ?, updated_at = ? WHERE id = ?`)
  // 历史回收只碰终态：status 过滤写死 done/dead，queued/running 无论多旧都不会被删。
  const sqlPrune = db.prepare(`DELETE FROM ${TABLE} WHERE status IN ('done', 'dead') AND updated_at < ?`)

  /** 行 → 记录：payload 反序列化；坏行（解析失败）明确报 JOB_CORRUPT 而不是静默吞掉。 */
  const toRecord = (row: JobRow): JobRecord => {
    let payload: unknown
    try {
      payload = JSON.parse(row.payload) as unknown
    } catch (cause) {
      throw new EngramError('JOB_CORRUPT', `jobs: 作业 ${row.id} 的 payload 不是合法 JSON`, { cause })
    }
    return {
      id: row.id,
      kind: row.kind,
      payload,
      status: row.status as JobStatus,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      runAfter: row.run_after,
      leaseOwner: row.lease_owner,
      leaseExpiresAt: row.lease_expires_at,
      checkpoint: row.checkpoint,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  const queue: JobQueue = {
    enqueue(input) {
      const id = requireText(input.id, 'id')
      const kind = requireText(input.kind, 'kind')
      const payloadJson = serializePayload(input.payload)
      const maxAttempts = input.maxAttempts === undefined ? DEFAULT_MAX_ATTEMPTS : requirePositiveInt(input.maxAttempts, 'maxAttempts')
      const at = now()
      const runAfter = input.runAfter === undefined ? at : requireNonNegativeInt(input.runAfter, 'runAfter')
      const existing = sqlGet.get(id) as unknown as JobRow | undefined
      if (existing !== undefined) return { job: toRecord(existing), deduped: true }
      let deduped = false
      withTransaction(() => {
        // IMMEDIATE 事务内二次确认：并发同 id 入队被写锁串行化，仍只落一行。
        if (sqlGet.get(id) !== undefined) { deduped = true; return }
        sqlInsert.run(id, kind, payloadJson, maxAttempts, runAfter, at, at)
      })
      return { job: toRecord(sqlGet.get(id) as unknown as JobRow), deduped }
    },

    claim(input) {
      const owner = requireText(input.owner, 'owner')
      const leaseMs = requirePositiveInt(input.leaseMs, 'leaseMs')
      const limit = input.limit === undefined ? 1 : requirePositiveInt(input.limit, 'limit')
      const kinds = input.kinds === undefined ? undefined : input.kinds.map(kind => requireText(kind, 'kinds'))
      const at = now()
      const expiresAt = at + leaseMs
      const taken: JobRecord[] = []
      withTransaction(() => {
        const candidates = (kinds === undefined
          ? sqlDue.all(at, at, limit)
          : sqlDueKinds.all(at, at, JSON.stringify(kinds), limit)) as unknown as JobRow[]
        for (const row of candidates) {
          sqlTake.run(owner, expiresAt, at, row.id)
          try {
            taken.push(toRecord(sqlGet.get(row.id) as unknown as JobRow))
          } catch (error) {
            // 毒丸隔离：payload 损坏的候选（常是队首）不能让整个 claim 回滚、
            // 更不能每次都占住名额永久阻塞——就地 dead-letter（last_error 记损坏
            // 原因），本次不返回它，事务内的其余健康作业照常认领。
            if (!((error instanceof EngramError) && error.code === 'JOB_CORRUPT')) throw error
            const cause = (error as Error).cause
            const causeText = cause instanceof Error ? cause.message : cause === undefined ? '' : String(cause)
            sqlDead.run(causeText === '' ? error.message : `${error.message}（${causeText}）`, at, row.id)
          }
        }
      })
      return taken
    },

    complete(input) {
      const id = requireText(input.id, 'id')
      requireText(input.owner, 'owner')
      const at = now()
      withTransaction(() => {
        const row = sqlGet.get(id) as unknown as JobRow | undefined
        if (row === undefined) throw new EngramError('JOB_NOT_FOUND', `jobs: 作业 ${id} 不存在`)
        requireOwnedRunning(row, input, at)
        sqlComplete.run(at, id)
      })
      return toRecord(sqlGet.get(id) as unknown as JobRow)
    },

    fail(input) {
      const id = requireText(input.id, 'id')
      requireText(input.owner, 'owner')
      const error = requireText(input.error, 'error')
      const retryDelayMs = input.retryDelayMs === undefined ? 0 : requireNonNegativeInt(input.retryDelayMs, 'retryDelayMs')
      const at = now()
      withTransaction(() => {
        const row = sqlGet.get(id) as unknown as JobRow | undefined
        if (row === undefined) throw new EngramError('JOB_NOT_FOUND', `jobs: 作业 ${id} 不存在`)
        requireOwnedRunning(row, input, at)
        if (row.attempts >= row.max_attempts) sqlDead.run(error, at, id)
        else sqlRetry.run(at + retryDelayMs, error, at, id)
      })
      return toRecord(sqlGet.get(id) as unknown as JobRow)
    },

    checkpoint(input) {
      const id = requireText(input.id, 'id')
      requireText(input.owner, 'owner')
      const mark = requireText(input.checkpoint, 'checkpoint')
      const at = now()
      withTransaction(() => {
        const row = sqlGet.get(id) as unknown as JobRow | undefined
        if (row === undefined) throw new EngramError('JOB_NOT_FOUND', `jobs: 作业 ${id} 不存在`)
        requireOwnedRunning(row, input, at)
        sqlCheckpoint.run(mark, at, id)
      })
      return toRecord(sqlGet.get(id) as unknown as JobRow)
    },

    get(id) {
      const row = sqlGet.get(requireText(id, 'id')) as unknown as JobRow | undefined
      return row === undefined ? undefined : toRecord(row)
    },

    prune(olderThanMs) {
      // 输入校验与 runAfter/retryDelayMs 同款：非负整数。
      const thresholdMs = requireNonNegativeInt(olderThanMs, 'olderThanMs')
      const cutoff = now() - thresholdMs
      const result = sqlPrune.run(cutoff)
      return Number(result.changes)
    },

    close() {
      db.close()
    },
  }
  return queue
}
