/**
 * EngramStore 的 node:sqlite 实现：节点表 + 边表 + FTS5（unicode61 + 中文 2-gram 预切词）
 * + 操作日志，单调 SCHEMA_VERSION，打开时校验、不兼容拒绝加载（不写兼容 shim）。
 * 事务用手工 BEGIN/COMMIT——DatabaseSync.prototype.transaction 仅新引擎可用，
 * 本包声明兼容 node ^22.19。
 * @module @kenz1117/dsh-engram/store/sqlite
 */

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { EngramError, asMemoryId } from '../types.ts'
import type {
  DecayOptions, EngramEdgeType, EngramScope, ExportData, ListFilter, ListResult,
  MemoryEdge, MemoryId,
  MemoryRecord, ReviewView, SearchHit, SearchResult, StoreStats,
  TimelineQuery, UpdateInput, WriteInput,
} from '../types.ts'
import type { EngramStore } from './interface.ts'

/** 当前 schema 版本；结构性变更必须 +1 并拒绝旧库（pre-release 无兼容承诺）。 */
const SCHEMA_VERSION = 2
/** RRF 融合常数：score = Σ 1/(K + rank)。 */
const RRF_K = 60
/** 向量道的语义门槛：低于该余弦的条目不参与排序。 */
const MIN_COSINE = 0.2
/** 矛盾候选门槛：近邻余弦达到该值即报告（由模型/用户裁决）。 */
const CONTRADICTION_COSINE = 0.88
/** 每道参与融合的候选上限。 */
const RANK_POOL = 64
/** 一跳扩展引入的邻居上限。 */
const EXPANSION_LIMIT = 32
/** 命中强化：每次检索命中的置信度增量。 */
const CONFIDENCE_BUMP = 0.05
/** 审计视图返回的操作日志条数上限。 */
const REVIEW_LOG_LIMIT = 20

/** 节点表的行结构（snake_case 对应列名）。 */
interface NodeRow {
  id: string
  scope: string
  kind: string
  content: string
  importance: number
  confidence: number
  status: string
  created_at: number
  last_accessed_at: number
  access_count: number
  source_session_id: string | null
  source_round: number | null
  source_seq: number | null
  embedding: Uint8Array | null
}

function rowToRecord(row: NodeRow): MemoryRecord {
  return {
    id: asMemoryId(row.id),
    scope: row.scope as EngramScope,
    kind: row.kind as MemoryRecord['kind'],
    content: row.content,
    importance: row.importance,
    confidence: row.confidence,
    status: row.status as MemoryRecord['status'],
    createdAt: row.created_at,
    lastAccessedAt: row.last_accessed_at,
    accessCount: row.access_count,
    sourceSessionId: row.source_session_id,
    sourceRound: row.source_round,
    sourceSeq: row.source_seq,
  }
}

function blobToVec(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength))
}

function vecToBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength)
}

/** 余弦相似度；任一向量零范数时返回 0。 */
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * 中文 2-gram + 西文词元切词：unicode61 把连续汉字当作单个 token，无法支撑短语检索，
 * 因此入库与查询前都把中文按两字窗口切开、西文按词保留，用空格分隔交给 FTS5。
 */
export function tokenizeForFts(text: string): string {
  const tokens: string[] = []
  for (const segment of text.split(/([a-zA-Z0-9_]+)/)) {
    if (segment === '') continue
    if (/^[a-zA-Z0-9_]+$/.test(segment)) {
      tokens.push(segment.toLowerCase())
      continue
    }
    const cjk = segment.replace(/\s+/gu, '')
    if (cjk.length === 1) {
      tokens.push(cjk)
    } else {
      for (let i = 0; i + 2 <= cjk.length; i++) tokens.push(cjk.slice(i, i + 2))
    }
  }
  return tokens.join(' ')
}

/** 把切词结果转成 FTS5 MATCH 表达式（每个词元双引号包裹，OR 连接）；无有效词元返回 undefined。 */
export function ftsMatchExpression(text: string): string | undefined {
  const tokens = tokenizeForFts(text).split(' ').filter(token => token !== '')
  if (tokens.length === 0) return undefined
  return tokens.map(token => `"${token.replaceAll('"', '""')}"`).join(' OR ')
}

/**
 * 打开（必要时创建）一个 scope 分库。
 * @param path - SQLite 文件路径；目录不存在会自动创建（0o700）。
 * @returns 就绪的 EngramStore。
 * @throws EngramError(code=SCHEMA_INCOMPATIBLE) 当库的 schema 版本高于当前实现。
 */
export async function openEngramStore(path: string): Promise<EngramStore> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path)
  /** 手工事务：BEGIN/COMMIT/ROLLBACK（兼容 ^22.19 引擎范围）。 */
  const withTransaction = (fn: () => void): void => {
    db.exec('BEGIN')
    try {
      fn()
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL,
      importance REAL NOT NULL, confidence REAL NOT NULL, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, last_accessed_at INTEGER NOT NULL, access_count INTEGER NOT NULL,
      source_session_id TEXT, source_round INTEGER, source_seq INTEGER, embedding BLOB);
    CREATE TABLE IF NOT EXISTS edges (
      from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (from_id, to_id, type));
    CREATE TABLE IF NOT EXISTS op_log (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, op TEXT NOT NULL,
      target_id TEXT NOT NULL, detail TEXT);
    CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(node_id UNINDEXED, content, tokenize='unicode61');
    CREATE INDEX IF NOT EXISTS nodes_scope_status ON nodes (scope, status);
  `)
  const versionRow = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as unknown as { value: string } | undefined
  if (versionRow === undefined) {
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION))
  } else if (Number(versionRow.value) !== SCHEMA_VERSION) {
    // pre-release 无兼容承诺：版本不一致（更高或更低）一律拒绝加载，
    // 不做原地迁移——旧库由用户备份后删除重建。
    db.close()
    throw new EngramError('SCHEMA_INCOMPATIBLE', `engram 数据库 schema 版本 ${versionRow.value} 与插件支持的 ${SCHEMA_VERSION} 不一致：请备份并删除旧库文件（${path}）后重试`)
  }

  const sqlGet = db.prepare('SELECT * FROM nodes WHERE id = ?')
  const sqlInsert = db.prepare(`INSERT INTO nodes
    (id, scope, kind, content, importance, confidence, status, created_at, last_accessed_at, access_count,
     source_session_id, source_round, source_seq, embedding)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, 0, ?, ?, ?, ?)`)
  const sqlFtsInsert = db.prepare('INSERT INTO nodes_fts (node_id, content) VALUES (?, ?)')
  const sqlSetStatus = db.prepare('UPDATE nodes SET status = ?, last_accessed_at = ? WHERE id = ?')
  const sqlTouch = db.prepare(`UPDATE nodes SET access_count = access_count + 1, last_accessed_at = ?,
    confidence = MIN(1, confidence + ${CONFIDENCE_BUMP}) WHERE id = ?`)
  const sqlLog = db.prepare('INSERT INTO op_log (at, op, target_id, detail) VALUES (?, ?, ?, ?)')
  const sqlOpLogById = db.prepare('SELECT at, op, detail FROM op_log WHERE target_id = ? ORDER BY seq DESC LIMIT ?')
  const sqlTopActive = db.prepare("SELECT * FROM nodes WHERE scope = ? AND status = 'active' ORDER BY importance DESC, confidence DESC LIMIT ?")
  const sqlEdgeUpsert = db.prepare('INSERT OR IGNORE INTO edges (from_id, to_id, type, created_at) VALUES (?, ?, ?, ?)')
  const sqlNeighbors = db.prepare(`SELECT * FROM edges WHERE from_id IN (SELECT value FROM json_each(?))
    AND type IN ('supports','refines','related') LIMIT ?`)
  const sqlEdgesTouching = db.prepare('SELECT from_id, to_id, type FROM edges WHERE from_id = ? OR to_id = ?')
  const sqlCountBy = db.prepare('SELECT status, COUNT(*) AS n FROM nodes GROUP BY status')
  const sqlCountKind = db.prepare('SELECT kind, COUNT(*) AS n FROM nodes GROUP BY kind')
  const sqlCountEdges = db.prepare('SELECT COUNT(*) AS n FROM edges')
  const sqlCountOpLog = db.prepare('SELECT COUNT(*) AS n FROM op_log')
  const sqlAllNodes = db.prepare('SELECT * FROM nodes ORDER BY created_at')
  const sqlAllEdges = db.prepare('SELECT * FROM edges')
  const sqlDecay = db.prepare(`UPDATE nodes SET status = 'archived'
    WHERE status = 'active' AND importance < ? AND last_accessed_at < ?`)
  const sqlPurgeNodes = db.prepare('DELETE FROM nodes')
  const sqlPurgeEdges = db.prepare('DELETE FROM edges')
  const sqlPurgeFts = db.prepare('DELETE FROM nodes_fts')
  const sqlPurgeLog = db.prepare('DELETE FROM op_log')

  /** FTS 道：按 scope 集合检索（占位符动态生成，scope 集合由调用方去重）。 */
  const ftsSearch = (match: string, scopes: readonly EngramScope[]): NodeRow[] => {
    const placeholders = scopes.map(() => '?').join(',')
    return db.prepare(`SELECT n.* FROM nodes_fts f JOIN nodes n ON n.id = f.node_id
      WHERE nodes_fts MATCH ? AND n.status = 'active' AND n.scope IN (${placeholders})
      ORDER BY bm25(nodes_fts) LIMIT ${RANK_POOL}`).all(match, ...scopes) as unknown as NodeRow[]
  }

  /** 向量候选池：active 且带向量的条目，按 scope 集合过滤（占位符动态生成）。 */
  const vectorPool = (scopes: readonly EngramScope[]): NodeRow[] => {
    const placeholders = scopes.map(() => '?').join(',')
    return db.prepare(`SELECT * FROM nodes WHERE status = 'active' AND embedding IS NOT NULL AND scope IN (${placeholders})`)
      .all(...scopes) as unknown as NodeRow[]
  }

  const getRow = (id: string): NodeRow | undefined => sqlGet.get(id) as unknown as NodeRow | undefined

  /**
   * 写入公共体：插入节点 + FTS + 操作日志（不建边、不开事务）。
   * 事务由调用方持有（withTransaction）。
   */
  const insertRecord = (
    id: MemoryId, input: WriteInput, content: string,
    importance: number, confidence: number, at: number,
    sourceSessionId: string | null, embedding: Float32Array | Uint8Array | null, op: string,
  ): void => {
    // Float32Array 不是合法 BLOB 参数，落库前转字节视图；Uint8Array 直传。
    const stored = embedding === null
      ? null
      : embedding instanceof Float32Array ? vecToBlob(embedding) : embedding
    sqlInsert.run(
      id, input.scope, input.kind, content, importance, confidence, at, at,
      sourceSessionId, input.sourceRound ?? null, input.sourceSeq ?? null, stored,
    )
    sqlFtsInsert.run(id, tokenizeForFts(content))
    sqlLog.run(at, op, id, JSON.stringify({ kind: input.kind, scope: input.scope }))
  }

  /** 邻居收集：该 id 触及的全部边按类型分组（supersedes 分方向）。 */
  const edgeGroups = (id: MemoryId): Pick<ReviewView, 'supersededBy' | 'supersedes' | 'contradicts' | 'related'> => {
    const rows = sqlEdgesTouching.all(id, id) as unknown as { from_id: string; to_id: string; type: string }[]
    const supersededBy: string[] = []
    const supersedes: string[] = []
    const contradicts: string[] = []
    const related: string[] = []
    for (const edge of rows) {
      if (edge.type === 'supersedes') {
        if (edge.to_id === id) supersededBy.push(edge.from_id)
        else supersedes.push(edge.to_id)
      } else if (edge.type === 'contradicts') {
        contradicts.push(edge.from_id === id ? edge.to_id : edge.from_id)
      } else if (edge.type === 'related' || edge.type === 'supports' || edge.type === 'refines') {
        related.push(edge.from_id === id ? edge.to_id : edge.from_id)
      }
    }
    return {
      supersededBy: supersededBy.map(asMemoryId),
      supersedes: supersedes.map(asMemoryId),
      contradicts: contradicts.map(asMemoryId),
      related: related.map(asMemoryId),
    }
  }

  return {
    async write(input: WriteInput) {
      const content = input.content.trim()
      if (content === '') throw new EngramError('EMPTY_CONTENT', 'content 不能为空')
      const id = asMemoryId(randomUUID())
      const at = Date.now()
      withTransaction(() => {
        insertRecord(id, input, content, input.importance ?? 0.5, input.confidence ?? 0.5, at, input.sourceSessionId ?? null, input.embedding ?? null, 'write')
      })
      return rowToRecord(sqlGet.get(id) as unknown as NodeRow)
    },

    async get(id: MemoryId) {
      const row = getRow(id)
      return row === undefined ? undefined : rowToRecord(row)
    },

    async search(query, queryVector): Promise<SearchResult> {
      const limit = query.limit ?? 8
      type Scored = { score: number; via: SearchHit['via'] }
      const scores = new Map<string, Scored>()

      // 道 1：FTS5 关键词（2-gram OR）。
      const match = ftsMatchExpression(query.text)
      if (match !== undefined) {
        ftsSearch(match, query.scopes).forEach((row, index) => {
          scores.set(row.id, { score: 1 / (RRF_K + index + 1), via: 'fts' })
        })
      }

      // 道 2：向量余弦（active 且带向量的条目全量参与）。
      let degraded = true
      if (queryVector !== undefined) {
        degraded = false
        const pool = vectorPool(query.scopes)
        const ranked = pool
          .map(row => ({ row, sim: cosine(queryVector, blobToVec(row.embedding!)) }))
          .filter(entry => entry.sim >= MIN_COSINE)
          .sort((a, b) => b.sim - a.sim)
          .slice(0, RANK_POOL)
        ranked.forEach((entry, index) => {
          const add = 1 / (RRF_K + index + 1)
          const existing = scores.get(entry.row.id)
          if (existing === undefined) {
            scores.set(entry.row.id, { score: add, via: 'vec' })
          } else {
            scores.set(entry.row.id, { score: existing.score + add, via: 'both' })
          }
        })
      }

      // 关系一跳扩展：top 结果的 supports/refines/related 邻居，若 active 且未入结果则低权重引入。
      const topIds = [...scores.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, limit).map(([id]) => id)
      const viaEdgeOf = new Map<string, { from: MemoryId; type: MemoryEdge['type'] }>()
      if (topIds.length > 0) {
        const edges = sqlNeighbors.all(JSON.stringify(topIds), EXPANSION_LIMIT) as unknown as MemoryEdge[]
        for (const edge of edges) {
          if (scores.has(edge.to) || !topIds.includes(edge.from)) continue
          const row = getRow(edge.to)
          if (row === undefined || row.status !== 'active' || !query.scopes.includes(row.scope as EngramScope)) continue
          const baseScore = scores.get(edge.from)?.score
          if (baseScore === undefined) continue
          scores.set(edge.to, { score: baseScore * 0.5, via: 'fts' })
          viaEdgeOf.set(edge.to, { from: asMemoryId(edge.from), type: edge.type })
        }
      }

      // 排序截断 + 命中强化（accessCount、confidence）。
      const finalRows = [...scores.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, limit)
      const hits: SearchHit[] = []
      for (const [id, info] of finalRows) {
        const row = getRow(id)
        if (row === undefined) continue
        const viaEdge = viaEdgeOf.get(id)
        hits.push({
          record: rowToRecord(row),
          score: info.score,
          via: info.via,
          ...(viaEdge === undefined ? {} : { viaEdge }),
        })
        sqlTouch.run(Date.now(), id)
      }
      return { hits, degraded }
    },

    async timeline(query: TimelineQuery) {
      const limit = query.limit ?? 20
      const placeholders = query.scopes.map(() => '?').join(',')
      const rows = db.prepare(`SELECT * FROM nodes WHERE status = 'active' AND scope IN (${placeholders})
        AND (? IS NULL OR created_at >= ?) AND (? IS NULL OR created_at <= ?)
        AND (? IS NULL OR instr(content, ?) > 0)
        ORDER BY created_at DESC LIMIT ?`)
        .all(...query.scopes, query.since ?? null, query.since ?? null, query.until ?? null, query.until ?? null, query.topic ?? null, query.topic ?? null, limit) as unknown as NodeRow[]
      return rows.map(rowToRecord)
    },

    async update(input: UpdateInput) {
      const old = getRow(input.id)
      if (old === undefined) throw new EngramError('NOT_FOUND', `条目 ${input.id} 不存在`)
      const content = input.content.trim()
      if (content === '') throw new EngramError('EMPTY_CONTENT', 'content 不能为空')
      const id = asMemoryId(randomUUID())
      const at = Date.now()
      withTransaction(() => {
        sqlSetStatus.run('archived', at, input.id)
        sqlLog.run(at, 'superseded', input.id, JSON.stringify({ supersededBy: id }))
        insertRecord(
          id,
          { scope: input.scope, kind: input.kind, content },
          content,
          input.importance ?? old.importance,
          old.confidence,
          at,
          old.source_session_id,
          input.embedding ?? old.embedding,
          'update',
        )
        sqlEdgeUpsert.run(id, input.id, 'supersedes', at)
      })
      return rowToRecord(sqlGet.get(id) as unknown as NodeRow)
    },

    async forget(id: MemoryId) {
      const row = getRow(id)
      if (row === undefined) throw new EngramError('NOT_FOUND', `条目 ${id} 不存在`)
      sqlSetStatus.run('forgotten', Date.now(), id)
      sqlLog.run(Date.now(), 'forget', id, null)
      return rowToRecord(sqlGet.get(id) as unknown as NodeRow)
    },

    async restore(id: MemoryId) {
      const row = getRow(id)
      if (row === undefined) throw new EngramError('NOT_FOUND', `条目 ${id} 不存在`)
      sqlSetStatus.run('active', Date.now(), id)
      sqlLog.run(Date.now(), 'restore', id, null)
      return rowToRecord(sqlGet.get(id) as unknown as NodeRow)
    },

    async topActive(scope: EngramScope, n: number) {
      const rows = sqlTopActive.all(scope, n) as unknown as NodeRow[]
      return rows.map(rowToRecord)
    },

    async list(filter: ListFilter): Promise<ListResult> {
      const conds: string[] = ['scope = ?']
      const params: (string | number)[] = [filter.scope]
      if (filter.status !== undefined) { conds.push('status = ?'); params.push(filter.status) }
      if (filter.kind !== undefined) { conds.push('kind = ?'); params.push(filter.kind) }
      if (filter.q !== undefined && filter.q !== '') { conds.push('instr(content, ?) > 0'); params.push(filter.q) }
      const where = conds.join(' AND ')
      const total = (db.prepare(`SELECT COUNT(*) AS n FROM nodes WHERE ${where}`).get(...params) as unknown as { n: number }).n
      const rows = db.prepare(`SELECT * FROM nodes WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
        .all(...params, filter.limit, filter.offset) as unknown as NodeRow[]
      return { records: rows.map(rowToRecord), total }
    },

    async review(id: MemoryId): Promise<ReviewView | undefined> {
      const row = getRow(id)
      if (row === undefined) return undefined
      const operations = sqlOpLogById.all(id, REVIEW_LOG_LIMIT) as unknown as { at: number; op: string; detail: string | null }[]
      return { record: rowToRecord(row), ...edgeGroups(id), operations }
    },

    async stats(): Promise<StoreStats> {
      const statusRows = sqlCountBy.all() as unknown as { status: string; n: number }[]
      const kindRows = sqlCountKind.all() as unknown as { kind: string; n: number }[]
      const edgeCount = (sqlCountEdges.get() as unknown as { n: number }).n
      const opCount = (sqlCountOpLog.get() as unknown as { n: number }).n
      const byStatus: Record<string, number> = { active: 0, archived: 0, forgotten: 0 }
      for (const row of statusRows) byStatus[row.status] = row.n
      const byKind: Record<string, number> = {}
      for (const row of kindRows) byKind[row.kind] = row.n
      const active = byStatus['active'] ?? 0
      const archived = byStatus['archived'] ?? 0
      const forgotten = byStatus['forgotten'] ?? 0
      const total = active + archived + forgotten
      return {
        total,
        active,
        archived,
        forgotten,
        byKind,
        edges: edgeCount,
        opLogCount: opCount,
        signalRatio: total === 0 ? 0 : active / total,
      }
    },

    async exportAll(): Promise<ExportData> {
      const records = (sqlAllNodes.all() as unknown as NodeRow[]).map(rowToRecord)
      const edgeRows = sqlAllEdges.all() as unknown as { from_id: string; to_id: string; type: string; created_at: number }[]
      return {
        exportedAt: Date.now(),
        records,
        edges: edgeRows.map(edge => ({ from: asMemoryId(edge.from_id), to: asMemoryId(edge.to_id), type: edge.type as MemoryEdge['type'], createdAt: edge.created_at })),
      }
    },

    async decay(options: DecayOptions) {
      const cutoff = Date.now() - options.olderThanDays * 86_400_000
      const result = sqlDecay.run(options.importanceBelow, cutoff)
      const changed = Number(result.changes)
      if (changed > 0) sqlLog.run(Date.now(), 'decay', 'BATCH', JSON.stringify({ archived: changed }))
      return changed
    },

    async findContradictions(embedding: Float32Array, limit = 3) {
      const pool = db.prepare("SELECT * FROM nodes WHERE status = 'active' AND embedding IS NOT NULL AND scope IN ('user','project')").all() as unknown as NodeRow[]
      return pool
        .map(row => ({ row, sim: cosine(embedding, blobToVec(row.embedding!)) }))
        .filter(entry => entry.sim >= CONTRADICTION_COSINE)
        .sort((a, b) => b.sim - a.sim)
        .slice(0, limit)
        .map(entry => rowToRecord(entry.row))
    },

    async linkEdge(from: MemoryId, to: MemoryId, type: EngramEdgeType) {
      sqlEdgeUpsert.run(from, to, type, Date.now())
    },

    async supersedeMany(input: WriteInput, oldIds: readonly MemoryId[]) {
      // oldIds 为空时与 write 等价（insertRecord + 0 次归档循环），不走 this 引用。
      const content = input.content.trim()
      if (content === '') throw new EngramError('EMPTY_CONTENT', 'content 不能为空')
      const id = asMemoryId(randomUUID())
      const at = Date.now()
      withTransaction(() => {
        insertRecord(id, input, content, input.importance ?? 0.5, input.confidence ?? 0.5, at, input.sourceSessionId ?? null, input.embedding ?? null, 'distill')
        for (const oldId of oldIds) {
          sqlSetStatus.run('archived', at, oldId)
          sqlEdgeUpsert.run(id, oldId, 'supersedes', at)
        }
      })
      return rowToRecord(sqlGet.get(id) as unknown as NodeRow)
    },

    async audit(op: string, targetId: string, detail: string | null) {
      sqlLog.run(Date.now(), op, targetId, detail)
    },

    async purge() {
      withTransaction(() => {
        sqlPurgeNodes.run()
        sqlPurgeEdges.run()
        sqlPurgeFts.run()
        sqlPurgeLog.run()
      })
    },

    async close() {
      db.close()
    },
  }
}
