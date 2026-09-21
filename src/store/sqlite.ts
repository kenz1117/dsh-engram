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
import { EngramError, EPISODE_PROXIMITY_MS_DEFAULT, EPISODE_TIMELINE_LIMIT_DEFAULT, asEntityId, asFactId, asMemoryId, normalizeEntityName } from '../types.ts'
import { assignSlot } from '../palace/slots.ts'
import { nextSchedule } from '../review/sm2.ts'
import { scorePlacard } from '../imagery/score.ts'
import type {
  DecayOptions, EngramEdgeType, EngramScope, EntityDetail, EntityId, EntityListFilter,
  EntityListResult, EntityMention, EntityRecord, ExportData, FactListFilter, FactListResult,
  FactRecord, FactWriteInput, ForgettingTombstone,
  ForgottenAuditRow, ImageryLabel,
  ListFilter, ListResult, MemoryEdge, MemoryId, MemoryOutcome,
  MemoryRecord, ProfileBlock, ProfileBlockVersion, ReviewGrade, ReviewView, SearchHit, SearchResult, Slot, StoreStats,
  TimelineQuery, UpdateInput, WriteInput,
  EpisodeTimelineQuery, EpisodeTimelineResult,
} from '../types.ts'
import type { EngramStore, RoomState } from './interface.ts'

/** 当前 schema 版本；结构性变更必须 +1。可空列与伴随表走增量迁移（见 openEngramStore 的迁移段）。 */
const SCHEMA_VERSION = 11
/** 增量迁移表：key 为起始版本，value 为升到下一版本的 SQL（可多语句）。
 *  v2 → v3：nodes 补可空列 outcome（使用效果回报）。
 *  v3 → v4：新增 nodes_revisions 修订表（update 归档旧条目时的内容快照）。
 *  v4 → v5：nodes 补 imagery_json 列（意象铭牌：caption + sensoryTags + emotionalValence + provisional）。
 *  v5 → v6：桩位（slot_room/slot_index）、意象质量分（imagery_score）、SM-2 调度
 *   （next_review_at/ease_factor/interval_days/review_reps）+ 固定巡游路线表 tour_routes。
 *   全部可空或带默认值，存量条目零搬运；排桩由 backfillSlots 幂等补齐。
 *  v6 → v7：画像 curated block 两表（profile_blocks 当前态 + profile_block_versions
 *   追加式版本链）。scope 作主键，每 scope 至多一个 block；版本链只增不改，rollback 数据源。
 *  v7 → v8：episode 情景时间线两个专用索引（kind+created_at 日期范围扫描、
 *   source_session_id+created_at 会话过滤）。列自 v1 就存在，纯索引迁移，零数据搬运。
 *  v8 → v9：会话摘要表 session_summaries（摄取期 LLM 生成的一句话会话摘要，
 *   组头展示用；与 nodes 无外键，会话 id 仅作逻辑关联）。
 *  v9 → v10：实体层两表——entities 实体词典（name/kind/aliases）与 node_entities
 *   记忆↔实体关联。实体随来源记忆所在 scope 分库；两表均无外键，删除记忆不级联
 *   （关联残留由查询侧 join status 过滤，见 listEntities 的 orphan 统计）。
 *  v10 → v11：facts 事实表——摄取/工具期抽取的一句话事实，挂在实体上（entity_id
 *   引用同库 entities.id，无外键）。valid_at/invalid_at 时间窗 + replaced_by 软失效
 *   链：新事实可声明取代旧事实（旧事实置 invalid_at 并回指 replaced_by），历史链
 *   保留可审计；asOf 查询按时间窗过滤（见 factsOfEntity）。 */
const MIGRATIONS: Readonly<Record<string, string>> = {
  '2': 'ALTER TABLE nodes ADD COLUMN outcome TEXT',
  '3': `CREATE TABLE IF NOT EXISTS nodes_revisions (
    node_id TEXT NOT NULL, content TEXT NOT NULL, kind TEXT NOT NULL,
    importance REAL NOT NULL, superseded_at INTEGER NOT NULL);`,
  '4': 'ALTER TABLE nodes ADD COLUMN imagery_json TEXT',
  '5': `ALTER TABLE nodes ADD COLUMN slot_room TEXT;
    ALTER TABLE nodes ADD COLUMN slot_index INTEGER;
    ALTER TABLE nodes ADD COLUMN imagery_score REAL;
    ALTER TABLE nodes ADD COLUMN next_review_at INTEGER;
    ALTER TABLE nodes ADD COLUMN ease_factor REAL;
    ALTER TABLE nodes ADD COLUMN interval_days REAL;
    ALTER TABLE nodes ADD COLUMN review_reps INTEGER DEFAULT 0;
    CREATE TABLE IF NOT EXISTS tour_routes (
      position INTEGER PRIMARY KEY, node_id TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS nodes_slot ON nodes (slot_room, slot_index);
    CREATE INDEX IF NOT EXISTS nodes_review_due ON nodes (next_review_at);`,
  '6': `CREATE TABLE IF NOT EXISTS profile_blocks (
    scope TEXT PRIMARY KEY, content TEXT NOT NULL, version INTEGER NOT NULL,
    updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS profile_block_versions (
      scope TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL,
      source TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (scope, version));`,
  '7': `CREATE INDEX IF NOT EXISTS nodes_kind_created ON nodes (kind, created_at);
    CREATE INDEX IF NOT EXISTS nodes_session_created ON nodes (source_session_id, created_at);`,
  '8': `CREATE TABLE IF NOT EXISTS session_summaries (
    session_id TEXT PRIMARY KEY, summary TEXT NOT NULL, updated_at INTEGER NOT NULL);`,
  '9': `CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
    aliases_json TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS node_entities (
      node_id TEXT NOT NULL, entity_id TEXT NOT NULL,
      PRIMARY KEY (node_id, entity_id));
    CREATE INDEX IF NOT EXISTS entities_name ON entities (name);
    CREATE INDEX IF NOT EXISTS node_entities_entity ON node_entities (entity_id);`,
  '10': `CREATE TABLE IF NOT EXISTS facts (
    id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, content TEXT NOT NULL,
    valid_at INTEGER NOT NULL, invalid_at INTEGER, replaced_by TEXT,
    source_node_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS facts_entity ON facts (entity_id);`,
}
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
/** 效果回报降权：failure 回报的置信度扣减（success 复用 CONFIDENCE_BUMP）。 */
const OUTCOME_PENALTY = 0.1
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
  outcome: string | null
  imagery_json: string | null
  slot_room: string | null
  slot_index: number | null
  imagery_score: number | null
  next_review_at: number | null
  ease_factor: number | null
  interval_days: number | null
  review_reps: number | null
}

/** 把意象铭牌序列化为 JSON（缺省序列化为 null，落库）。 */
function imageryToJson(imagery: ImageryLabel | undefined): string | null {
  if (imagery === undefined) return null
  return JSON.stringify({
    caption: imagery.caption,
    sensoryTags: [...imagery.sensoryTags],
    emotionalValence: imagery.emotionalValence,
    provisional: imagery.provisional,
  })
}

/** 从 JSON 反序列化意象铭牌；空串或解析失败返回 undefined（视作未铭刻）。 */
function jsonToImagery(raw: string | null): ImageryLabel | undefined {
  if (raw === null || raw === '') return undefined
  try {
    const parsed = JSON.parse(raw) as { caption?: unknown; sensoryTags?: unknown; emotionalValence?: unknown; provisional?: unknown }
    const caption = typeof parsed.caption === 'string' ? parsed.caption : null
    const sensory = Array.isArray(parsed.sensoryTags) ? parsed.sensoryTags.filter((s): s is string => typeof s === 'string') : []
    const emotionalValence = typeof parsed.emotionalValence === 'number' && Number.isFinite(parsed.emotionalValence)
      ? Math.min(1, Math.max(0, parsed.emotionalValence)) : 0
    const provisional = parsed.provisional === true
    return { caption, sensoryTags: sensory, emotionalValence, provisional }
  } catch {
    return undefined
  }
}

function rowToRecord(row: NodeRow): MemoryRecord {
  const imagery = jsonToImagery(row.imagery_json)
  const hasReviewState = row.next_review_at !== null || row.ease_factor !== null || row.interval_days !== null
  return {
    id: asMemoryId(row.id),
    scope: row.scope as EngramScope,
    kind: row.kind as MemoryRecord['kind'],
    content: row.content,
    importance: row.importance,
    confidence: row.confidence,
    status: row.status as MemoryRecord['status'],
    ...(row.outcome === 'success' || row.outcome === 'failure' ? { outcome: row.outcome } : {}),
    createdAt: row.created_at,
    lastAccessedAt: row.last_accessed_at,
    accessCount: row.access_count,
    sourceSessionId: row.source_session_id,
    sourceRound: row.source_round,
    sourceSeq: row.source_seq,
    ...(imagery === undefined ? {} : { imagery }),
    ...(row.slot_room === null || row.slot_index === null ? {} : { slot: { room: row.slot_room, index: row.slot_index } }),
    ...(row.imagery_score === null ? {} : { imageryScore: row.imagery_score }),
    ...(hasReviewState ? {
      review: {
        nextReviewAt: row.next_review_at,
        easeFactor: row.ease_factor ?? 2.5,
        intervalDays: row.interval_days ?? 0,
        reps: row.review_reps ?? 0,
      },
    } : {}),
  }
}

function blobToVec(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength))
}

/** 实体表的行结构（snake_case 对应列名）。 */
interface EntityRow {
  id: string
  name: string
  kind: string
  aliases_json: string
  created_at: number
  updated_at: number
}

function entityRowToRecord(row: EntityRow): EntityRecord {
  let aliases: string[] = []
  try {
    const parsed: unknown = JSON.parse(row.aliases_json)
    if (Array.isArray(parsed)) aliases = parsed.filter((a): a is string => typeof a === 'string')
  } catch {
    // aliases_json 由本模块写入（JSON.stringify 产物），损坏时按空别名处理即可继续检索。
  }
  return {
    id: asEntityId(row.id),
    name: row.name,
    kind: row.kind as EntityRecord['kind'],
    aliases,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** 事实表的行结构（snake_case 对应列名）。 */
interface FactRow {
  id: string
  entity_id: string
  content: string
  valid_at: number
  invalid_at: number | null
  replaced_by: string | null
  source_node_id: string | null
  created_at: number
  updated_at: number
}

function factRowToRecord(row: FactRow): FactRecord {
  return {
    id: asFactId(row.id),
    entityId: asEntityId(row.entity_id),
    content: row.content,
    validAt: row.valid_at,
    invalidAt: row.invalid_at,
    replacedBy: row.replaced_by === null ? null : asFactId(row.replaced_by),
    sourceNodeId: row.source_node_id === null ? null : asMemoryId(row.source_node_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
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

/** 检索排序乘性 boost 参数（RRF 融合分之上逐条乘因子；权重 0 即该因子恒 1）。 */
export interface RankBoostOptions {
  /** recency 因子权重：`1 + w * max(0, 1 - daysSince(lastAccessedAt) / decayAfterDays)`。 */
  readonly recencyWeight: number
  /** proof 因子权重：`1 + w * log2(1 + accessCount)`。 */
  readonly proofWeight: number
  /** recency 因子的衰减窗口天数（与衰减调度共用同一配置值）。 */
  readonly decayAfterDays: number
}

/** 缺省不加 boost（测试与脚本直开库时保持旧排序行为）。 */
const NO_BOOST: RankBoostOptions = { recencyWeight: 0, proofWeight: 0, decayAfterDays: 30 }

/** 写入期自动化开关（产品决策在存储层落地，保证 save/批量/摄取/蒸馏四条写入路径行为一致）。 */
export interface StoreAutomation {
  /** 写入时自动排桩 + 登记巡游路线；缺省 true。 */
  readonly autoSlot: boolean
  /** 新记忆自动进入 SM-2 复习调度（初始 1 天后到期）；缺省 true。 */
  readonly reviewScheduling: boolean
}
/** 缺省全开（config 的默认值也在此处对齐）。 */
const DEFAULT_AUTOMATION: StoreAutomation = { autoSlot: true, reviewScheduling: true }

/**
 * 打开（必要时创建）一个 scope 分库。
 * @param path - SQLite 文件路径；目录不存在会自动创建（0o700）。
 * @param rankBoost - 排序 boost 参数；缺省不乘任何因子。
 * @param automation - 写入期自动化开关（自动排桩/初始排期）；缺省全开。
 * @returns 就绪的 EngramStore。
 * @throws EngramError(code=SCHEMA_INCOMPATIBLE) 当库的 schema 版本高于当前实现。
 */
export async function openEngramStore(path: string, rankBoost: RankBoostOptions = NO_BOOST, automation: StoreAutomation = DEFAULT_AUTOMATION): Promise<EngramStore> {
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
      source_session_id TEXT, source_round INTEGER, source_seq INTEGER, embedding BLOB, outcome TEXT,
      imagery_json TEXT,
      slot_room TEXT, slot_index INTEGER, imagery_score REAL,
      next_review_at INTEGER, ease_factor REAL, interval_days REAL,
      review_reps INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS edges (
      from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (from_id, to_id, type));
    CREATE TABLE IF NOT EXISTS op_log (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, op TEXT NOT NULL,
      target_id TEXT NOT NULL, detail TEXT);
    CREATE TABLE IF NOT EXISTS nodes_revisions (
      node_id TEXT NOT NULL, content TEXT NOT NULL, kind TEXT NOT NULL,
      importance REAL NOT NULL, superseded_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tour_routes (
      position INTEGER PRIMARY KEY, node_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS profile_blocks (
      scope TEXT PRIMARY KEY, content TEXT NOT NULL, version INTEGER NOT NULL,
      updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS profile_block_versions (
      scope TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL,
      source TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (scope, version));
    CREATE TABLE IF NOT EXISTS session_summaries (
      session_id TEXT PRIMARY KEY, summary TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
      aliases_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS node_entities (
      node_id TEXT NOT NULL, entity_id TEXT NOT NULL,
      PRIMARY KEY (node_id, entity_id));
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, content TEXT NOT NULL,
      valid_at INTEGER NOT NULL, invalid_at INTEGER, replaced_by TEXT,
      source_node_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(node_id UNINDEXED, content, tokenize='unicode61');
    CREATE INDEX IF NOT EXISTS nodes_scope_status ON nodes (scope, status);
    CREATE INDEX IF NOT EXISTS nodes_kind_created ON nodes (kind, created_at);
    CREATE INDEX IF NOT EXISTS nodes_session_created ON nodes (source_session_id, created_at);
    CREATE INDEX IF NOT EXISTS entities_name ON entities (name);
    CREATE INDEX IF NOT EXISTS node_entities_entity ON node_entities (entity_id);
    CREATE INDEX IF NOT EXISTS facts_entity ON facts (entity_id);
  `)
  // v6 索引不在此处建：旧库此刻还没有 slot_room / next_review_at 列（迁移在后面才跑），
  // 对已存在的表建这两个索引会抛 no such column。新建库走下方补建，旧库由 MIGRATIONS['5'] 建。
  const versionRow = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as unknown as { value: string } | undefined
  if (versionRow === undefined) {
    db.exec(`CREATE INDEX IF NOT EXISTS nodes_slot ON nodes (slot_room, slot_index);
      CREATE INDEX IF NOT EXISTS nodes_review_due ON nodes (next_review_at);`)
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION))
  } else {
    // 顺序增量迁移：按 MIGRATIONS 逐版升到当前版本（保数据）；更高版本或断链（缺迁移）拒绝加载。
    let version = Number(versionRow.value)
    if (!Number.isInteger(version) || version > SCHEMA_VERSION) {
      db.close()
      throw new EngramError('SCHEMA_INCOMPATIBLE', `engram 数据库 schema 版本 ${versionRow.value} 高于插件支持的 ${SCHEMA_VERSION}：请升级插件或备份后删除旧库文件（${path}）`)
    }
    while (version < SCHEMA_VERSION) {
      const migration = MIGRATIONS[String(version)]
      if (migration === undefined) {
        db.close()
        throw new EngramError('SCHEMA_INCOMPATIBLE', `engram 数据库 schema 版本 ${version} 无法升到 ${SCHEMA_VERSION}（缺迁移步骤）：请备份并删除旧库文件（${path}）后重试`)
      }
      withTransaction(() => {
        // ALTER TABLE ADD COLUMN 不支持 IF NOT EXISTS；逐条 ALTER 在执行前探测列存在性
        // （schema_version 已 ≤ 当前版本，但用户手工降级 + 部分列已存在时仍需幂等）。
        const safe = migration
          .split(';')
          .map(stmt => stmt.trim())
          .filter(stmt => stmt !== '')
          .filter(stmt => {
            const match = /^ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/i.exec(stmt)
            if (match === null) return true
            const table = match[1]
            const column = match[2]
            const cols = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]
            return !cols.some(c => c.name === column)
          })
        for (const stmt of safe) db.exec(stmt)
        version += 1
        db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(version))
      })
    }
  }

  const sqlGet = db.prepare('SELECT * FROM nodes WHERE id = ?')
  const sqlInsert = db.prepare(`INSERT INTO nodes
    (id, scope, kind, content, importance, confidence, status, created_at, last_accessed_at, access_count,
     source_session_id, source_round, source_seq, embedding, imagery_json,
     slot_room, slot_index, imagery_score, next_review_at, ease_factor, interval_days)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const sqlFtsInsert = db.prepare('INSERT INTO nodes_fts (node_id, content) VALUES (?, ?)')
  const sqlSetStatus = db.prepare('UPDATE nodes SET status = ?, last_accessed_at = ? WHERE id = ?')
  const sqlSetOutcome = db.prepare(`UPDATE nodes
    SET outcome = ?,
        confidence = CASE WHEN ? = 'success' THEN min(1.0, confidence + ${CONFIDENCE_BUMP}) ELSE max(0.0, confidence - ${OUTCOME_PENALTY}) END
    WHERE id = ?`)
  const sqlTouch = db.prepare(`UPDATE nodes SET access_count = access_count + 1, last_accessed_at = ?,
    confidence = MIN(1, confidence + ${CONFIDENCE_BUMP}) WHERE id = ?`)
  const sqlLog = db.prepare('INSERT INTO op_log (at, op, target_id, detail) VALUES (?, ?, ?, ?)')
  const sqlHasAudit = db.prepare('SELECT 1 AS x FROM op_log WHERE op = ? AND detail = ? LIMIT 1')
  const sqlListAudit = db.prepare('SELECT detail FROM op_log WHERE op = ? AND detail IS NOT NULL ORDER BY seq')
  const sqlClearAudit = db.prepare('DELETE FROM op_log WHERE op = ? AND detail = ?')
  const sqlOpLogById = db.prepare('SELECT at, op, target_id, detail FROM op_log WHERE target_id = ? ORDER BY seq DESC LIMIT ?')
  const sqlGetManyByIds = db.prepare('SELECT * FROM nodes WHERE id IN (SELECT value FROM json_each(?))')
  const sqlNeighborsBounded = db.prepare(`SELECT * FROM nodes WHERE id IN (
    WITH RECURSIVE walk(id, depth) AS (
      SELECT ?, 0
      UNION
      SELECT CASE WHEN e.from_id = walk.id THEN e.to_id ELSE e.from_id END, walk.depth + 1
      FROM edges e JOIN walk ON (e.from_id = walk.id OR e.to_id = walk.id)
      WHERE walk.depth < ? AND e.type IN ('supports','refines','related','supersedes','contradicts')
    )
    SELECT id FROM walk WHERE depth > 0
  )`)
  const sqlRecentOps = db.prepare('SELECT at, op, target_id, detail FROM op_log ORDER BY seq DESC LIMIT ?')
  const sqlRevisionInsert = db.prepare('INSERT INTO nodes_revisions (node_id, content, kind, importance, superseded_at) VALUES (?, ?, ?, ?, ?)')
  const sqlRevisionsById = db.prepare('SELECT content, kind, importance, superseded_at FROM nodes_revisions WHERE node_id = ? ORDER BY superseded_at DESC')
  const sqlTopActive = db.prepare("SELECT * FROM nodes WHERE scope = ? AND status = 'active' ORDER BY importance DESC, confidence DESC LIMIT ?")
  const sqlEdgeUpsert = db.prepare('INSERT OR IGNORE INTO edges (from_id, to_id, type, created_at) VALUES (?, ?, ?, ?)')
  const sqlNeighbors = db.prepare(`SELECT * FROM edges WHERE from_id IN (SELECT value FROM json_each(?))
    AND type IN ('supports','refines','related') LIMIT ?`)
  const sqlEdgesTouching = db.prepare('SELECT from_id, to_id, type FROM edges WHERE from_id = ? OR to_id = ?')
  const sqlCountBy = db.prepare('SELECT status, COUNT(*) AS n FROM nodes GROUP BY status')
  const sqlCountKind = db.prepare('SELECT kind, COUNT(*) AS n FROM nodes GROUP BY kind')
  const sqlCountEdges = db.prepare('SELECT COUNT(*) AS n FROM edges')
  const sqlCountOpLog = db.prepare('SELECT COUNT(*) AS n FROM op_log')
  const sqlCountRedacted = db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE content LIKE '%[REDACTED:%'")
  const sqlAllNodes = db.prepare('SELECT * FROM nodes ORDER BY created_at')
  const sqlAllEdges = db.prepare('SELECT * FROM edges')
  const sqlDecay = db.prepare(`UPDATE nodes SET status = 'archived'
    WHERE status = 'active' AND importance < ? AND last_accessed_at < ? AND next_review_at IS NULL`)
  // 进入 SM-2 复习调度的条目（next_review_at 非空）不参与自动衰减：到期未复习的记忆
  // 该被优先复习而非归档，其退出由翻新清单 demote 规则（人工确认）接管。
  const sqlScheduleReview = db.prepare(`UPDATE nodes
    SET next_review_at = ?, ease_factor = ?, interval_days = ?, review_reps = ?, last_accessed_at = ?
    WHERE id = ?`)
  const sqlDueReviews = db.prepare(`SELECT * FROM nodes
    WHERE status = 'active' AND next_review_at IS NOT NULL AND next_review_at <= ?
    ORDER BY next_review_at ASC LIMIT ?`)
  const sqlSlotCounts = db.prepare(`SELECT slot_room AS room, MAX(slot_index) AS maxIndex, COUNT(*) AS n
    FROM nodes WHERE slot_room IS NOT NULL AND status != 'forgotten' GROUP BY slot_room`)
  const sqlSetSlot = db.prepare('UPDATE nodes SET slot_room = ?, slot_index = ? WHERE id = ?')
  const sqlUnslotted = db.prepare(`SELECT * FROM nodes WHERE slot_room IS NULL AND status = 'active'
    ORDER BY kind, created_at`)
  const sqlRouteAppend = db.prepare(`INSERT INTO tour_routes (position, node_id)
    VALUES ((SELECT COALESCE(MAX(position), -1) + 1 FROM tour_routes), ?)`)
  const sqlRouteList = db.prepare('SELECT position, node_id FROM tour_routes ORDER BY position')
  const sqlRouteHas = db.prepare('SELECT 1 AS x FROM tour_routes WHERE node_id = ? LIMIT 1')
  const sqlSlotNeighbors = db.prepare(`SELECT id FROM nodes
    WHERE slot_room = ? AND slot_index IN (?, ?) AND status = 'active' AND id != ?`)
  const sqlListPlacards = db.prepare(`SELECT slot_room AS room, json_extract(imagery_json, '$.caption') AS caption
    FROM nodes WHERE imagery_json IS NOT NULL AND status = 'active'`)
  const sqlPurgeNodes = db.prepare('DELETE FROM nodes')
  const sqlPurgeEdges = db.prepare('DELETE FROM edges')
  const sqlPurgeFts = db.prepare('DELETE FROM nodes_fts')
  const sqlPurgeLog = db.prepare('DELETE FROM op_log')
  const sqlPurgeRoutes = db.prepare('DELETE FROM tour_routes')
  const sqlPurgeProfileBlocks = db.prepare('DELETE FROM profile_blocks')
  const sqlPurgeProfileVersions = db.prepare('DELETE FROM profile_block_versions')
  const sqlPurgeSessionSummaries = db.prepare('DELETE FROM session_summaries')
  // 画像 curated block：当前态读写 + 版本链追加/查询。
  const sqlProfileBlockGet = db.prepare('SELECT scope, content, version, updated_at FROM profile_blocks WHERE scope = ?')
  const sqlProfileBlockUpsert = db.prepare(`INSERT INTO profile_blocks (scope, content, version, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(scope) DO UPDATE SET content = excluded.content, version = excluded.version, updated_at = excluded.updated_at`)
  const sqlProfileVersionInsert = db.prepare('INSERT INTO profile_block_versions (scope, version, content, source, at) VALUES (?, ?, ?, ?, ?)')
  const sqlProfileVersionsList = db.prepare('SELECT scope, version, content, source, at FROM profile_block_versions WHERE scope = ? ORDER BY version DESC LIMIT ?')
  const sqlProfileVersionGet = db.prepare('SELECT scope, version, content, source, at FROM profile_block_versions WHERE scope = ? AND version = ?')
  // 会话摘要：upsert（每会话一条，重跑覆盖）+ 单查 + 按会话 id 批量查（episodeTimeline 组头）。
  const sqlSessionSummaryUpsert = db.prepare(`INSERT INTO session_summaries (session_id, summary, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (session_id) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at`)
  const sqlSessionSummaryGet = db.prepare('SELECT session_id, summary FROM session_summaries WHERE session_id = ?')
  const sqlSessionSummaryMany = db.prepare('SELECT session_id, summary FROM session_summaries WHERE session_id IN (SELECT value FROM json_each(?))')
  const sqlEntityAll = db.prepare('SELECT * FROM entities')
  const sqlEntityGet = db.prepare('SELECT * FROM entities WHERE id = ?')
  const sqlEntityInsert = db.prepare('INSERT INTO entities (id, name, kind, aliases_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
  const sqlEntityTouch = db.prepare('UPDATE entities SET updated_at = ? WHERE id = ?')
  const sqlNodeEntityInsert = db.prepare('INSERT OR IGNORE INTO node_entities (node_id, entity_id) VALUES (?, ?)')
  const sqlEntityByNode = db.prepare(`SELECT e.* FROM node_entities ne JOIN entities e ON e.id = ne.entity_id
    WHERE ne.node_id = ? ORDER BY e.name`)
  const sqlEntityMemoryCounts = db.prepare(`SELECT ne.entity_id AS id, COUNT(*) AS n FROM node_entities ne
    JOIN nodes n ON n.id = ne.node_id WHERE n.status = 'active' GROUP BY ne.entity_id`)
  const sqlEntityMemories = db.prepare(`SELECT n.* FROM node_entities ne JOIN nodes n ON n.id = ne.node_id
    WHERE ne.entity_id = ? AND n.status = 'active' ORDER BY n.created_at DESC LIMIT ?`)
  const sqlPurgeEntities = db.prepare('DELETE FROM entities')
  const sqlPurgeNodeEntities = db.prepare('DELETE FROM node_entities')
  const sqlFactInsert = db.prepare(`INSERT INTO facts
    (id, entity_id, content, valid_at, invalid_at, replaced_by, source_node_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)`)
  const sqlFactInvalidate = db.prepare('UPDATE facts SET invalid_at = ?, replaced_by = ?, updated_at = ? WHERE id = ?')
  const sqlFactGet = db.prepare('SELECT * FROM facts WHERE id = ?')
  const sqlPurgeFacts = db.prepare('DELETE FROM facts')

  /** FTS 道：按 scope 集合检索（占位符动态生成，scope 集合由调用方去重）；rooms 非空时只查指定房间。 */
  const ftsSearch = (match: string, scopes: readonly EngramScope[], rooms: readonly string[] | undefined): NodeRow[] => {
    const placeholders = scopes.map(() => '?').join(',')
    const roomCond = rooms === undefined || rooms.length === 0
      ? ''
      : ` AND n.slot_room IN (${rooms.map(() => '?').join(',')})`
    return db.prepare(`SELECT n.* FROM nodes_fts f JOIN nodes n ON n.id = f.node_id
      WHERE nodes_fts MATCH ? AND n.status = 'active' AND n.scope IN (${placeholders})${roomCond}
      ORDER BY bm25(nodes_fts) LIMIT ${RANK_POOL}`).all(match, ...scopes, ...(rooms ?? [])) as unknown as NodeRow[]
  }

  /** 向量候选池：active 且带向量的条目，按 scope 集合过滤（占位符动态生成）；rooms 非空时只查指定房间。 */
  const vectorPool = (scopes: readonly EngramScope[], rooms: readonly string[] | undefined): NodeRow[] => {
    const placeholders = scopes.map(() => '?').join(',')
    const roomCond = rooms === undefined || rooms.length === 0
      ? ''
      : ` AND slot_room IN (${rooms.map(() => '?').join(',')})`
    return db.prepare(`SELECT * FROM nodes WHERE status = 'active' AND embedding IS NOT NULL AND scope IN (${placeholders})${roomCond}`)
      .all(...scopes, ...(rooms ?? [])) as unknown as NodeRow[]
  }

  const getRow = (id: string): NodeRow | undefined => sqlGet.get(id) as unknown as NodeRow | undefined

  /**
   * 写入公共体：插入节点 + FTS + 操作日志（不建边、不开事务）。
   * 事务由调用方持有（withTransaction）。
   */
  const insertRecord = (
    id: MemoryId, input: WriteInput, content: string,
    importance: number, confidence: number, at: number,
    sourceSessionId: string | null, embedding: Float32Array | Uint8Array | null,
    imagery: ImageryLabel | undefined, op: string,
  ): void => {
    // Float32Array 不是合法 BLOB 参数，落库前转字节视图；Uint8Array 直传。
    const stored = embedding === null
      ? null
      : embedding instanceof Float32Array ? vecToBlob(embedding) : embedding
    // 初始排期：进入复习调度的条目 ease 从 SM-2 默认 2.5、间隔 0（等首次答题推进）起。
    const initialReview = input.initialReviewAt ?? null
    sqlInsert.run(
      id, input.scope, input.kind, content, importance, confidence, at, at,
      sourceSessionId, input.sourceRound ?? null, input.sourceSeq ?? null, stored,
      imageryToJson(imagery),
      input.slot?.room ?? null, input.slot?.index ?? null, input.imageryScore ?? null,
      initialReview, initialReview === null ? null : 2.5, initialReview === null ? null : 0,
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

  /**
   * 写入期自动化（save/批量/摄取/update/蒸馏全部写入路径统一在此落地；调用方须已持事务）：
   * 1) 排桩——显式 slot 优先，否则按 kind 分房自动分配（满员开新房并记 op_log）；
   * 2) 门牌评分——有铭牌时按「唯一/差异化/带日期」启发式落库；
   * 3) 初始排期——reviewScheduling 开启且未显式指定时，1 天后首次到期（显式 null = 明确不排期）；
   * 4) 巡游路线——有桩位的条目登记到固定路线末尾。
   * @returns 合入 WriteInput 的自动化字段。
   */
  const applyWriteAutomation = (input: WriteInput, id: MemoryId, at: number, imagery: ImageryLabel | undefined): Pick<WriteInput, 'slot' | 'imageryScore' | 'initialReviewAt'> => {
    let slot = input.slot
    if (slot === undefined && automation.autoSlot) {
      const occupancy: Record<string, RoomState> = {}
      for (const row of sqlSlotCounts.all() as unknown as { room: string; maxIndex: number; n: number }[]) {
        occupancy[row.room] = { count: row.n, maxIndex: row.maxIndex }
      }
      const assigned = assignSlot(input.kind, occupancy)
      slot = assigned.slot
      if (assigned.openedNewRoom) {
        sqlLog.run(at, 'room-open', 'BATCH', JSON.stringify({ room: slot.room, kind: input.kind }))
      }
    }
    let imageryScore = input.imageryScore
    if (imageryScore === undefined && imagery !== undefined) {
      const placards = (sqlListPlacards.all() as unknown as { room: string | null; caption: string | null }[])
        .filter((row): row is { room: string | null; caption: string } => typeof row.caption === 'string' && row.caption !== '')
      imageryScore = scorePlacard(imagery.caption, {
        existingCaptions: placards.map(row => row.caption),
        roomCaptions: slot === undefined ? [] : placards.filter(row => row.room === slot.room).map(row => row.caption),
      })
    }
    // initialReviewAt 显式给 null = 调用方明确不排期（历史回填：不让回填条目涌入复习队列）；
    // undefined 才走自动化默认（reviewScheduling 开启时 1 天后首次到期）。
    const initialReviewAt = input.initialReviewAt === undefined
      ? (automation.reviewScheduling ? at + 86_400_000 : undefined)
      : input.initialReviewAt ?? undefined
    if (slot !== undefined && sqlRouteHas.get(id) === undefined) sqlRouteAppend.run(id)
    return {
      ...(slot === undefined ? {} : { slot }),
      ...(imageryScore === undefined ? {} : { imageryScore }),
      ...(initialReviewAt === undefined ? {} : { initialReviewAt }),
    }
  }

  return {
    async write(input: WriteInput) {
      const content = input.content.trim()
      if (content === '') throw new EngramError('EMPTY_CONTENT', 'content 不能为空')
      const id = asMemoryId(randomUUID())
      const at = Date.now()
      withTransaction(() => {
        const automationFields = applyWriteAutomation(input, id, at, input.imagery)
        insertRecord(id, { ...input, ...automationFields }, content, input.importance ?? 0.5, input.confidence ?? 0.5, at, input.sourceSessionId ?? null, input.embedding ?? null, input.imagery, 'write')
      })
      return rowToRecord(sqlGet.get(id) as unknown as NodeRow)
    },

    async get(id: MemoryId) {
      const row = getRow(id)
      return row === undefined ? undefined : rowToRecord(row)
    },

    async getMany(ids: readonly MemoryId[]): Promise<MemoryRecord[]> {
      if (ids.length === 0) return []
      const seen = new Set<string>()
      const unique: MemoryId[] = []
      for (const id of ids) if (!seen.has(id)) { seen.add(id); unique.push(id) }
      const rows = sqlGetManyByIds.all(JSON.stringify(unique.map(id => String(id)))) as unknown as NodeRow[]
      const map = new Map<string, MemoryRecord>()
      for (const row of rows) map.set(row.id, rowToRecord(row))
      // 保留入参顺序，缺失静默跳过。
      return unique.map(id => map.get(id)).filter((r): r is MemoryRecord => r !== undefined)
    },

    async neighbors(id: MemoryId, depth: number): Promise<MemoryRecord[]> {
      const boundedDepth = Math.min(Math.max(1, Math.floor(depth)), 3)
      const rows = sqlNeighborsBounded.all(String(id), boundedDepth) as unknown as NodeRow[]
      const seen = new Set<string>([String(id)])
      const result: MemoryRecord[] = []
      for (const row of rows) {
        if (seen.has(row.id)) continue
        seen.add(row.id)
        result.push(rowToRecord(row))
      }
      return result
    },

    async search(query, queryVector): Promise<SearchResult> {
      const limit = query.limit ?? 8
      type Scored = { score: number; via: SearchHit['via'] }
      const scores = new Map<string, Scored>()

      // 道 1：FTS5 关键词（2-gram OR）。
      const match = ftsMatchExpression(query.text)
      if (match !== undefined) {
        ftsSearch(match, query.scopes, query.rooms).forEach((row, index) => {
          scores.set(row.id, { score: 1 / (RRF_K + index + 1), via: 'fts' })
        })
      }

      // 道 2：向量余弦（active 且带向量的条目全量参与）。
      let degraded = true
      if (queryVector !== undefined) {
        degraded = false
        const pool = vectorPool(query.scopes, query.rooms)
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

      // 排序 boost：RRF 融合分之上乘 recency 与 proof 因子（权重 0 时因子恒 1，退化为纯 RRF）。
      if (rankBoost.recencyWeight !== 0 || rankBoost.proofWeight !== 0) {
        const now = Date.now()
        for (const [id, info] of scores) {
          const row = getRow(id)
          if (row === undefined) continue
          const daysSince = Math.max(0, (now - row.last_accessed_at) / 86_400_000)
          const recency = 1 + rankBoost.recencyWeight * Math.max(0, 1 - daysSince / rankBoost.decayAfterDays)
          const proof = 1 + rankBoost.proofWeight * Math.log2(1 + row.access_count)
          info.score *= recency * proof
        }
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
        // 编码特异性线索（top5）：同房间相邻桩位——提取时重建编码情境（“它旁边挂着什么”）。
        const cueNeighbors = hits.length < 5 && row.slot_room !== null && row.slot_index !== null
          ? (sqlSlotNeighbors.all(row.slot_room, row.slot_index - 1, row.slot_index + 1, id) as unknown as { id: string }[])
              .map(neighbor => asMemoryId(neighbor.id))
          : []
        // 实体标签（schema v10）：命中的记忆附上关联实体（id + 规范名），提取路径可沿实体展开。
        const entityRows = sqlEntityByNode.all(id) as unknown as EntityRow[]
        hits.push({
          record: rowToRecord(row),
          score: info.score,
          via: info.via,
          ...(viaEdge === undefined ? {} : { viaEdge }),
          ...(cueNeighbors.length === 0 ? {} : { cues: { neighbors: cueNeighbors } }),
          ...(entityRows.length === 0
            ? {}
            : { entities: entityRows.map(r => ({ id: asEntityId(r.id), name: r.name })) }),
        })
        sqlTouch.run(Date.now(), id)
      }
      return { hits, degraded }
    },

    async timeline(query: TimelineQuery) {
      const limit = query.limit ?? 20
      const placeholders = query.scopes.map(() => '?').join(',')
      const where = `nodes.status = 'active' AND nodes.scope IN (${placeholders})
        AND (? IS NULL OR nodes.created_at >= ?) AND (? IS NULL OR nodes.created_at <= ?)
        AND (? IS NULL OR instr(nodes.content, ?) > 0)`
      const params: (string | number | null)[] = [
        ...query.scopes,
        query.since ?? null, query.since ?? null,
        query.until ?? null, query.until ?? null,
        query.topic ?? null, query.topic ?? null,
        limit,
      ]
      // order=tour：LEFT JOIN 巡游路线，按桩位顺序排（未上路线者 IS NULL 置后，按创建时间收尾）。
      const rows = query.order === 'tour'
        ? db.prepare(`SELECT nodes.* FROM nodes LEFT JOIN tour_routes ON tour_routes.node_id = nodes.id
            WHERE ${where} ORDER BY tour_routes.position IS NULL, tour_routes.position ASC, nodes.created_at DESC LIMIT ?`)
          .all(...params) as unknown as NodeRow[]
        : db.prepare(`SELECT nodes.* FROM nodes WHERE ${where} ORDER BY nodes.created_at DESC LIMIT ?`)
          .all(...params) as unknown as NodeRow[]
      return rows.map(rowToRecord)
    },

    async episodeTimeline(query: EpisodeTimelineQuery): Promise<EpisodeTimelineResult> {
      const limit = Math.max(1, Math.floor(query.limit ?? EPISODE_TIMELINE_LIMIT_DEFAULT))
      const placeholders = query.scopes.map(() => '?').join(',')
      // 时间邻近扩展模式：锚点不限 kind（事实/决策也可作锚），邻居只取 episode；
      // 窗口覆盖日期过滤（窗口语义下日期过滤只会截断扩展结果）。
      if (query.around !== undefined) {
        const anchorRow = getRow(query.around)
        if (anchorRow === undefined) throw new EngramError('NOT_FOUND', `邻近扩展锚点 ${query.around} 不存在`)
        const window = Math.max(0, Math.floor(query.proximityMs ?? EPISODE_PROXIMITY_MS_DEFAULT))
        const rows = db.prepare(`SELECT * FROM nodes
            WHERE kind = 'episode' AND status = 'active' AND scope IN (${placeholders})
              AND id != ? AND created_at >= ? AND created_at <= ?
            ORDER BY created_at ASC LIMIT ?`)
          .all(...query.scopes, query.around, anchorRow.created_at - window, anchorRow.created_at + window, limit) as unknown as NodeRow[]
        return { groups: [], around: { anchor: rowToRecord(anchorRow), neighbors: rows.map(rowToRecord) } }
      }
      const params: (string | number | null)[] = [
        ...query.scopes,
        query.since ?? null, query.since ?? null,
        query.until ?? null, query.until ?? null,
        query.sessionId ?? null, query.sessionId ?? null,
        limit,
      ]
      const rows = db.prepare(`SELECT * FROM nodes
          WHERE kind = 'episode' AND status = 'active' AND scope IN (${placeholders})
            AND (? IS NULL OR created_at >= ?) AND (? IS NULL OR created_at <= ?)
            AND (? IS NULL OR source_session_id = ?)
          ORDER BY created_at DESC LIMIT ?`)
        .all(...params) as unknown as NodeRow[]
      // 按来源会话分组：DESC 遍历后组内反转成升序；组按会话起点倒序（最新会话在前）。
      const bySession = new Map<string | null, MemoryRecord[]>()
      for (const row of rows) {
        const record = rowToRecord(row)
        const bucket = bySession.get(record.sourceSessionId)
        if (bucket === undefined) bySession.set(record.sourceSessionId, [record])
        else bucket.push(record)
      }
      const groups = [...bySession.entries()].map(([sessionId, episodesDesc]) => {
        const episodes = [...episodesDesc].reverse()
        return {
          sessionId,
          episodes,
          startedAt: episodes[0]!.createdAt,
          endedAt: episodes[episodes.length - 1]!.createdAt,
        }
      })
      groups.sort((a, b) => b.startedAt - a.startedAt)
      // 组头摘要：按会话 id 批量取（一次查询），命中的组带 summary（可选字段条件展开）。
      const sessionIds = groups.map(g => g.sessionId).filter((id): id is string => id !== null)
      const summaries = new Map<string, string>()
      if (sessionIds.length > 0) {
        const rows = sqlSessionSummaryMany.all(JSON.stringify(sessionIds)) as unknown as { session_id: string; summary: string }[]
        for (const row of rows) summaries.set(row.session_id, row.summary)
      }
      return {
        groups: groups.map(group => {
          const summary = group.sessionId === null ? undefined : summaries.get(group.sessionId)
          return { ...group, ...(summary === undefined ? {} : { summary }) }
        }),
      }
    },

    async setSessionSummary(sessionId: string, summary: string): Promise<void> {
      sqlSessionSummaryUpsert.run(sessionId, summary, Date.now())
      sqlLog.run(Date.now(), 'session-summary', sessionId, JSON.stringify({ length: summary.length }))
    },

    async getSessionSummary(sessionId: string): Promise<string | undefined> {
      const row = sqlSessionSummaryGet.get(sessionId) as unknown as { session_id: string; summary: string } | undefined
      return row?.summary
    },

    async update(input: UpdateInput) {
      const old = getRow(input.id)
      if (old === undefined) throw new EngramError('NOT_FOUND', `条目 ${input.id} 不存在`)
      const content = input.content.trim()
      if (content === '') throw new EngramError('EMPTY_CONTENT', 'content 不能为空')
      const id = asMemoryId(randomUUID())
      const at = Date.now()
      withTransaction(() => {
        // 修订历史先行：归档旧条目前快照其内容（内容不变性审计，schema v4）。
        sqlRevisionInsert.run(input.id, old.content, old.kind, old.importance, at)
        sqlSetStatus.run('archived', at, input.id)
        sqlLog.run(at, 'superseded', input.id, JSON.stringify({ supersededBy: id }))
        // 新条目是新物品：重新排桩/评分/排期（宫殿里修正一件物品 = 在新桩位放新版）。
        const imagery = input.imagery ?? jsonToImagery(old.imagery_json)
        const updateInput: WriteInput = { scope: input.scope, kind: input.kind, content }
        const automationFields = applyWriteAutomation(updateInput, id, at, imagery)
        insertRecord(
          id,
          { ...updateInput, ...automationFields },
          content,
          input.importance ?? old.importance,
          old.confidence,
          at,
          old.source_session_id,
          input.embedding ?? old.embedding,
          imagery,
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

    async forgetWithTombstone(id: MemoryId, tombstone: ForgettingTombstone) {
      const row = getRow(id)
      if (row === undefined) throw new EngramError('NOT_FOUND', `条目 ${id} 不存在`)
      const at = Date.now()
      // 墓志铭三问脱敏清洗（避免闭馆时把会话密钥一并封进 op_log）。
      const cleaned = {
        reason: tombstone.reason.trim().slice(0, 200),
        affects: tombstone.affects.trim().slice(0, 200),
        stillUseful: tombstone.stillUseful.trim().slice(0, 200),
      }
      sqlSetStatus.run('forgotten', at, id)
      sqlLog.run(at, 'forget', id, JSON.stringify({ tombstone: cleaned }))
      return rowToRecord(sqlGet.get(id) as unknown as NodeRow)
    },

    async listForgottenWithTombs(limit: number): Promise<readonly ForgottenAuditRow[]> {
      const boundedLimit = Math.max(1, Math.min(limit, 200))
      const rows = db.prepare(`SELECT n.*, o.at AS forgotten_at, o.detail AS tombstone_json
        FROM nodes n
        INNER JOIN op_log o ON o.target_id = n.id AND o.op = 'forget'
        WHERE n.status = 'forgotten'
        ORDER BY o.seq DESC
        LIMIT ?`).all(boundedLimit) as unknown as (NodeRow & { forgotten_at: number; tombstone_json: string | null })[]
      return rows.map((row) => {
        let tombstone: ForgettingTombstone | null = null
        if (row.tombstone_json !== null) {
          try {
            const parsed = JSON.parse(row.tombstone_json) as { tombstone?: { reason?: unknown; affects?: unknown; stillUseful?: unknown } }
            const inner = parsed.tombstone
            if (inner !== undefined && typeof inner.reason === 'string') {
              tombstone = {
                reason: inner.reason,
                affects: typeof inner.affects === 'string' ? inner.affects : '',
                stillUseful: typeof inner.stillUseful === 'string' ? inner.stillUseful : '',
              }
            }
          } catch {
            tombstone = null
          }
        }
        const base = rowToRecord(row)
        return {
          id: base.id,
          scope: base.scope,
          kind: base.kind,
          content: base.content,
          importance: base.importance,
          lastAccessedAt: base.lastAccessedAt,
          tombstone,
          forgottenAt: row.forgotten_at,
        }
      })
    },

    async reportOutcome(id: MemoryId, outcome: MemoryOutcome) {
      // 奖励信号：success 提权 +0.05、failure 降权 -0.1（夹逼 0-1），软删/归档条目也接受回报（效果事实不因状态改变）。
      const row = getRow(id)
      if (row === undefined) return undefined
      // 参数依次：SET outcome、CASE 效果判断、WHERE id（CASE 与 SET 用同一 outcome 值）。
      sqlSetOutcome.run(outcome, outcome, id)
      sqlLog.run(Date.now(), 'outcome-report', id, outcome)
      return rowToRecord(sqlGet.get(id) as unknown as NodeRow)
    },

    async scheduleReview(id: MemoryId, grade: ReviewGrade) {
      const row = getRow(id)
      if (row === undefined) return undefined
      const now = Date.now()
      // 未排期过的条目从 SM-2 初始态起步（ease 2.5 / 间隔 0 / reps 0）。
      const current = rowToRecord(row).review ?? {
        nextReviewAt: null, easeFactor: 2.5, intervalDays: 0, reps: row.review_reps ?? 0,
      }
      const next = nextSchedule(grade, current, now)
      sqlScheduleReview.run(next.nextReviewAt, next.easeFactor, next.intervalDays, next.reps, now, id)
      sqlLog.run(now, 'review-answer', id, JSON.stringify({ grade, nextIntervalDays: next.intervalDays }))
      return rowToRecord(sqlGet.get(id) as unknown as NodeRow)
    },

    async dueReviews(now: number, limit: number) {
      const rows = sqlDueReviews.all(now, Math.max(1, limit)) as unknown as NodeRow[]
      return rows.map(rowToRecord)
    },

    async slotCountsByRoom() {
      const rows = sqlSlotCounts.all() as unknown as { room: string; maxIndex: number; n: number }[]
      const result: Record<string, RoomState> = {}
      for (const row of rows) result[row.room] = { count: row.n, maxIndex: row.maxIndex }
      return result
    },

    async assignSlot(id: MemoryId, slot: Slot) {
      sqlSetSlot.run(slot.room, slot.index, id)
      sqlLog.run(Date.now(), 'slot-assign', id, JSON.stringify(slot))
    },

    async backfillSlots(capacityNote: (room: string) => void) {
      // 存量排桩：只处理 active 且未排桩的条目（幂等，可重跑）；
      // 按 kind 分房、created_at 定序，与 save 时的实时排桩共用 assignSlot 规则。
      const rows = sqlUnslotted.all() as unknown as NodeRow[]
      if (rows.length === 0) return 0
      const now = Date.now()
      withTransaction(() => {
        const occupancy: Record<string, RoomState> = {}
        for (const row of sqlSlotCounts.all() as unknown as { room: string; maxIndex: number; n: number }[]) {
          occupancy[row.room] = { count: row.n, maxIndex: row.maxIndex }
        }
        for (const row of rows) {
          const { slot, openedNewRoom } = assignSlot(row.kind as MemoryRecord['kind'], occupancy)
          sqlSetSlot.run(slot.room, slot.index, row.id)
          // 巡游路线补登记：已在路线上的（重复跑）跳过。
          if (sqlRouteHas.get(row.id) === undefined) sqlRouteAppend.run(row.id)
          const state = occupancy[slot.room] ?? { count: 0, maxIndex: 0 }
          occupancy[slot.room] = { count: state.count + 1, maxIndex: Math.max(state.maxIndex, slot.index) }
          if (openedNewRoom) capacityNote(slot.room)
        }
        sqlLog.run(now, 'slot-backfill', 'BATCH', JSON.stringify({ assigned: rows.length }))
      })
      return rows.length
    },

    async routeAppend(id: MemoryId) {
      sqlRouteAppend.run(id)
    },

    async routeHas(id: MemoryId) {
      return sqlRouteHas.get(id) !== undefined
    },

    async routeList() {
      const rows = sqlRouteList.all() as unknown as { position: number; node_id: string }[]
      return rows.map(row => ({ position: row.position, id: asMemoryId(row.node_id) }))
    },

    async listPlacards() {
      const rows = sqlListPlacards.all() as unknown as { room: string | null; caption: string | null }[]
      // caption 为 null 的铭牌（json 里 caption 字段为 null）不参与唯一性/差异化比较。
      return rows.filter((row): row is { room: string | null; caption: string } => typeof row.caption === 'string' && row.caption !== '')
    },

    async getProfileBlock(scope: EngramScope): Promise<ProfileBlock | undefined> {
      const row = sqlProfileBlockGet.get(scope) as unknown as { scope: string; content: string; version: number; updated_at: number } | undefined
      if (row === undefined) return undefined
      return { scope: row.scope as EngramScope, content: row.content, version: row.version, updatedAt: row.updated_at }
    },

    async saveProfileBlock(scope: EngramScope, expectedVersion: number | undefined, content: string, source: ProfileBlockVersion['source']): Promise<ProfileBlock> {
      if (content.trim() === '') throw new EngramError('EMPTY_CONTENT', '画像 block 内容不能为空')
      const current = sqlProfileBlockGet.get(scope) as unknown as { version: number } | undefined
      // 乐观锁：未带版本仅允许首次创建；带版本必须与当前一致（并发编辑 loud 失败）。
      if (current === undefined && expectedVersion !== undefined) {
        throw new EngramError('VERSION_CONFLICT', `画像 block 不存在（${scope}），不能带 expectedVersion=${String(expectedVersion)} 编辑；先传 undefined 创建`)
      }
      if (current !== undefined && expectedVersion !== current.version) {
        throw new EngramError('VERSION_CONFLICT', `画像 block 版本冲突（${scope}）：当前 v${String(current.version)}，请求基于 v${String(expectedVersion)}；请重读最新版本后再改`)
      }
      const nextVersion = current === undefined ? 1 : current.version + 1
      const now = Date.now()
      // 版本行先落（rollback 数据源），再更新当前态；同一事务保证两表一致。
      withTransaction(() => {
        sqlProfileVersionInsert.run(scope, nextVersion, content, source, now)
        sqlProfileBlockUpsert.run(scope, content, nextVersion, now)
      })
      return { scope, content, version: nextVersion, updatedAt: now }
    },

    async listProfileBlockVersions(scope: EngramScope, limit: number): Promise<ProfileBlockVersion[]> {
      const rows = sqlProfileVersionsList.all(scope, Math.max(1, limit)) as unknown as
        { scope: string; version: number; content: string; source: string; at: number }[]
      return rows.map(row => ({
        scope: row.scope as EngramScope,
        version: row.version,
        content: row.content,
        source: row.source === 'rollback' ? 'rollback' : 'edit',
        at: row.at,
      }))
    },

    async getProfileBlockVersion(scope: EngramScope, version: number): Promise<ProfileBlockVersion | undefined> {
      const row = sqlProfileVersionGet.get(scope, version) as unknown as
        { scope: string; version: number; content: string; source: string; at: number } | undefined
      if (row === undefined) return undefined
      return {
        scope: row.scope as EngramScope,
        version: row.version,
        content: row.content,
        source: row.source === 'rollback' ? 'rollback' : 'edit',
        at: row.at,
      }
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
      // 脱敏标记过滤：标记格式由 redact.ts 固定（[REDACTED:<类型>]），LIKE 字面匹配。
      if (filter.redacted !== undefined) {
        conds.push(filter.redacted ? "content LIKE '%[REDACTED:%'" : "content NOT LIKE '%[REDACTED:%'")
      }
      const where = conds.join(' AND ')
      const total = (db.prepare(`SELECT COUNT(*) AS n FROM nodes WHERE ${where}`).get(...params) as unknown as { n: number }).n
      // sort=tour：LEFT JOIN 巡游路线，按桩位顺序排（未上路线者 IS NULL 置后，按创建时间收尾）。
      const rows = filter.sort === 'tour'
        ? db.prepare(`SELECT nodes.* FROM nodes LEFT JOIN tour_routes ON tour_routes.node_id = nodes.id
            WHERE ${where} ORDER BY tour_routes.position IS NULL, tour_routes.position ASC, created_at DESC LIMIT ? OFFSET ?`)
          .all(...params, filter.limit, filter.offset) as unknown as NodeRow[]
        : db.prepare(`SELECT * FROM nodes WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
          .all(...params, filter.limit, filter.offset) as unknown as NodeRow[]
      return { records: rows.map(rowToRecord), total }
    },

    async review(id: MemoryId): Promise<ReviewView | undefined> {
      const row = getRow(id)
      if (row === undefined) return undefined
      const operations = sqlOpLogById.all(id, REVIEW_LOG_LIMIT) as unknown as { at: number; op: string; target_id: string; detail: string | null }[]
      const revisions = sqlRevisionsById.all(id) as unknown as { content: string; kind: string; importance: number; superseded_at: number }[]
      return {
        record: rowToRecord(row),
        ...edgeGroups(id),
        revisions: revisions.map(rev => ({ content: rev.content, kind: rev.kind, importance: rev.importance, supersededAt: rev.superseded_at })),
        operations: operations.map(op => ({ at: op.at, op: op.op, targetId: op.target_id, detail: op.detail })),
      }
    },

    async recentOps(limit: number) {
      const rows = sqlRecentOps.all(Math.max(1, limit)) as unknown as { at: number; op: string; target_id: string; detail: string | null }[]
      return rows.map(op => ({ at: op.at, op: op.op, targetId: op.target_id, detail: op.detail }))
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
        redacted: (sqlCountRedacted.get() as unknown as { n: number }).n,
        byKind,
        edges: edgeCount,
        opLogCount: opCount,
        signalRatio: total === 0 ? 0 : active / total,
      }
    },

    async exportAll(): Promise<ExportData> {
      const records = (sqlAllNodes.all() as unknown as NodeRow[]).map(rowToRecord)
      const edgeRows = sqlAllEdges.all() as unknown as { from_id: string; to_id: string; type: string; created_at: number }[]
      const entities = (sqlEntityAll.all() as unknown as EntityRow[]).map(entityRowToRecord)
      return {
        exportedAt: Date.now(),
        records,
        edges: edgeRows.map(edge => ({ from: asMemoryId(edge.from_id), to: asMemoryId(edge.to_id), type: edge.type as MemoryEdge['type'], createdAt: edge.created_at })),
        entities,
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

    async nearestNeighbor(embedding: Float32Array) {
      // 与 findContradictions 同一池口径（active 且有向量的 user/project 行），不夹阈值、保留相似度。
      const pool = db.prepare("SELECT * FROM nodes WHERE status = 'active' AND embedding IS NOT NULL AND scope IN ('user','project')").all() as unknown as NodeRow[]
      let best: { row: NodeRow; sim: number } | undefined
      for (const row of pool) {
        const sim = cosine(embedding, blobToVec(row.embedding!))
        if (best === undefined || sim > best.sim) best = { row, sim }
      }
      return best === undefined ? undefined : { record: rowToRecord(best.row), similarity: best.sim }
    },

    async reinforce(id: MemoryId, note: string) {
      if (sqlGet.get(id) === undefined) return undefined
      sqlTouch.run(Date.now(), id)
      sqlLog.run(Date.now(), 'write-merge', id, note)
      return rowToRecord(sqlGet.get(id) as unknown as NodeRow)
    },

    async supersedeMany(input: WriteInput, oldIds: readonly MemoryId[]) {
      // oldIds 为空时与 write 等价（insertRecord + 0 次归档循环），不走 this 引用。
      const content = input.content.trim()
      if (content === '') throw new EngramError('EMPTY_CONTENT', 'content 不能为空')
      const id = asMemoryId(randomUUID())
      const at = Date.now()
      withTransaction(() => {
        // 蒸馏产物是新高层规律：与 write 同一套排桩/评分/排期自动化。
        const automationFields = applyWriteAutomation(input, id, at, input.imagery)
        insertRecord(id, { ...input, ...automationFields }, content, input.importance ?? 0.5, input.confidence ?? 0.5, at, input.sourceSessionId ?? null, input.embedding ?? null, input.imagery, 'distill')
        for (const oldId of oldIds) {
          sqlSetStatus.run('archived', at, oldId)
          sqlEdgeUpsert.run(id, oldId, 'supersedes', at)
        }
      })
      return rowToRecord(sqlGet.get(id) as unknown as NodeRow)
    },

    async resolveEntities(mentions: readonly EntityMention[]): Promise<readonly EntityRecord[]> {
      if (mentions.length === 0) return []
      const at = Date.now()
      const result: EntityRecord[] = []
      withTransaction(() => {
        // 全量加载建归一化索引：实体词典量级为个人记忆库规模（百级），全表扫比逐名查询简单且够快。
        const byKey = new Map<string, EntityRecord>()
        for (const row of sqlEntityAll.all() as unknown as EntityRow[]) {
          const entity = entityRowToRecord(row)
          byKey.set(normalizeEntityName(entity.name), entity)
          for (const alias of entity.aliases) {
            const aliasKey = normalizeEntityName(alias)
            if (aliasKey !== '' && !byKey.has(aliasKey)) byKey.set(aliasKey, entity)
          }
        }
        for (const mention of mentions) {
          const name = mention.name.trim()
          if (name === '') throw new EngramError('EMPTY_ENTITY_NAME', '实体名不能为空（清洗后的提及仍含空名）')
          const key = normalizeEntityName(name)
          const hit = byKey.get(key)
          if (hit !== undefined) {
            // 复用既有实体并刷新 updated_at：词典列表按「最近提及」倒序展示。
            sqlEntityTouch.run(at, hit.id)
            result.push(hit)
            continue
          }
          // 新建：别名去空去重；别名键若已被其他实体占用则不登记（first wins，不做合并）。
          const aliases = [...new Set((mention.aliases ?? []).map(a => a.trim()).filter(a => a !== ''))]
          const entity: EntityRecord = {
            id: asEntityId(randomUUID()),
            name,
            kind: mention.kind,
            aliases,
            createdAt: at,
            updatedAt: at,
          }
          sqlEntityInsert.run(entity.id, entity.name, entity.kind, JSON.stringify(aliases), at, at)
          byKey.set(key, entity)
          for (const alias of aliases) {
            const aliasKey = normalizeEntityName(alias)
            if (aliasKey !== '' && !byKey.has(aliasKey)) byKey.set(aliasKey, entity)
          }
          result.push(entity)
        }
      })
      return result
    },

    async linkNodeEntities(nodeId: MemoryId, entityIds: readonly EntityId[]) {
      withTransaction(() => {
        for (const entityId of entityIds) sqlNodeEntityInsert.run(String(nodeId), String(entityId))
      })
    },

    async entitiesOfNodes(nodeIds: readonly MemoryId[]): Promise<ReadonlyMap<MemoryId, readonly EntityRecord[]>> {
      const map = new Map<MemoryId, EntityRecord[]>()
      for (const nodeId of nodeIds) {
        const rows = sqlEntityByNode.all(String(nodeId)) as unknown as EntityRow[]
        if (rows.length > 0) map.set(nodeId, rows.map(entityRowToRecord))
      }
      return map
    },

    async listEntities(filter: EntityListFilter): Promise<EntityListResult> {
      const conditions: string[] = []
      const params: (string | number)[] = []
      if (filter.kind !== undefined) {
        conditions.push('kind = ?')
        params.push(filter.kind)
      }
      if (filter.q !== undefined && filter.q !== '') {
        // q 对 name 与 aliases_json（JSON 数组文本）做 LIKE 子串匹配；转义 LIKE 通配符。
        conditions.push("name LIKE ? ESCAPE '\\' OR aliases_json LIKE ? ESCAPE '\\'")
        const pattern = `%${filter.q.replace(/[\\%_]/g, c => `\\${c}`)}%`
        params.push(pattern, pattern)
      }
      const where = conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`
      const total = (db.prepare(`SELECT COUNT(*) AS n FROM entities${where}`).get(...params) as unknown as { n: number }).n
      const rows = db.prepare(`SELECT * FROM entities${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
        .all(...params, filter.limit, filter.offset) as unknown as EntityRow[]
      const counts = new Map<string, number>(
        (sqlEntityMemoryCounts.all() as unknown as { id: string; n: number }[]).map(r => [r.id, r.n]),
      )
      return {
        items: rows.map(row => ({ entity: entityRowToRecord(row), memoryCount: counts.get(row.id) ?? 0 })),
        total,
      }
    },

    async entityDetail(id: EntityId, memoryLimit: number): Promise<EntityDetail | undefined> {
      const row = sqlEntityGet.get(String(id)) as unknown as EntityRow | undefined
      if (row === undefined) return undefined
      const memories = (sqlEntityMemories.all(String(id), memoryLimit) as unknown as NodeRow[]).map(rowToRecord)
      return { entity: entityRowToRecord(row), memories }
    },

    async writeFacts(inputs: readonly FactWriteInput[]): Promise<readonly FactRecord[]> {
      const now = Date.now()
      return inputs.map(input => {
        const id = asFactId(randomUUID())
        const validAt = input.validAt ?? now
        withTransaction(() => {
          // 软失效链：replaces 指向存在的事实时才失效它（引用可能过期，过期按无取代写入）。
          if (input.replaces !== undefined
            && (sqlFactGet.get(String(input.replaces)) as unknown as FactRow | undefined) !== undefined) {
            sqlFactInvalidate.run(now, id, now, String(input.replaces))
          }
          sqlFactInsert.run(id, String(input.entityId), input.content, validAt,
            input.sourceNodeId === undefined ? null : String(input.sourceNodeId), now, now)
        })
        return {
          id,
          entityId: input.entityId,
          content: input.content,
          validAt,
          invalidAt: null,
          replacedBy: null,
          sourceNodeId: input.sourceNodeId ?? null,
          createdAt: now,
          updatedAt: now,
        }
      })
    },

    async factsOfEntity(filter: FactListFilter): Promise<FactListResult> {
      const conditions = ['entity_id = ?']
      const params: (string | number)[] = [String(filter.entityId)]
      // includeInvalid 优先于 asOf：全链视图本意就是展示完整历史（含失效链）。
      if (!filter.includeInvalid) {
        if (filter.asOf !== undefined) {
          conditions.push('valid_at <= ? AND (invalid_at IS NULL OR invalid_at > ?)')
          params.push(filter.asOf, filter.asOf)
        } else {
          conditions.push('invalid_at IS NULL')
        }
      }
      const where = ` WHERE ${conditions.join(' AND ')}`
      const total = (db.prepare(`SELECT COUNT(*) AS n FROM facts${where}`).get(...params) as unknown as { n: number }).n
      const rows = db.prepare(`SELECT * FROM facts${where} ORDER BY valid_at DESC LIMIT ? OFFSET ?`)
        .all(...params, filter.limit, filter.offset) as unknown as FactRow[]
      return { items: rows.map(factRowToRecord), total }
    },

    async audit(op: string, targetId: string, detail: string | null) {
      sqlLog.run(Date.now(), op, targetId, detail)
    },

    async hasAudit(op: string, detail: string) {
      return sqlHasAudit.get(op, detail) !== undefined
    },

    async listAuditDetails(op: string) {
      return (sqlListAudit.all(op) as unknown as { detail: string }[]).map(row => row.detail)
    },

    async clearAudit(op: string, detail: string) {
      sqlClearAudit.run(op, detail)
    },

    async purge() {
      withTransaction(() => {
        sqlPurgeNodes.run()
        sqlPurgeEdges.run()
        sqlPurgeFts.run()
        sqlPurgeLog.run()
        sqlPurgeRoutes.run()
        sqlPurgeProfileBlocks.run()
        sqlPurgeProfileVersions.run()
        sqlPurgeSessionSummaries.run()
        sqlPurgeNodeEntities.run()
        sqlPurgeEntities.run()
        sqlPurgeFacts.run()
      })
    },

    async close() {
      db.close()
    },
  }
}
