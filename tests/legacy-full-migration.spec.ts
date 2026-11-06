import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openEngramStore } from '../src/store/sqlite.ts'
import type { EngramStore } from '../src/store/interface.ts'
import { asEntityId, asMemoryId } from '../src/types.ts'

let dir: string
let path: string

/** v13 形态 fixture：没有 memory_id，没有 injection_snapshots；其余业务域全部有数据。 */
async function createLegacyV13(): Promise<void> {
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL,
      importance REAL NOT NULL, confidence REAL NOT NULL, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, last_accessed_at INTEGER NOT NULL, access_count INTEGER NOT NULL,
      source_session_id TEXT, source_round INTEGER, source_seq INTEGER, embedding BLOB, outcome TEXT,
      imagery_json TEXT, slot_room TEXT, slot_index INTEGER, imagery_score REAL,
      next_review_at INTEGER, ease_factor REAL, interval_days REAL, review_reps INTEGER DEFAULT 0);
    CREATE TABLE edges (
      from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (from_id, to_id, type));
    CREATE TABLE op_log (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, op TEXT NOT NULL,
      target_id TEXT NOT NULL, detail TEXT);
    CREATE TABLE nodes_revisions (
      node_id TEXT NOT NULL, content TEXT NOT NULL, kind TEXT NOT NULL,
      importance REAL NOT NULL, superseded_at INTEGER NOT NULL);
    CREATE TABLE tour_routes (position INTEGER PRIMARY KEY, node_id TEXT NOT NULL);
    CREATE TABLE profile_blocks (
      scope TEXT PRIMARY KEY, content TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE profile_block_versions (
      scope TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL, source TEXT NOT NULL,
      at INTEGER NOT NULL, PRIMARY KEY (scope, version));
    CREATE TABLE session_summaries (
      session_id TEXT PRIMARY KEY, summary TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE entities (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, aliases_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE node_entities (
      node_id TEXT NOT NULL, entity_id TEXT NOT NULL, PRIMARY KEY (node_id, entity_id));
    CREATE TABLE facts (
      id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, content TEXT NOT NULL,
      valid_at INTEGER NOT NULL, invalid_at INTEGER, replaced_by TEXT, source_node_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE observations (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, belief TEXT NOT NULL, status TEXT NOT NULL,
      sources_json TEXT NOT NULL, proof_count INTEGER NOT NULL, embedding BLOB,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_validated_at INTEGER NOT NULL);
    CREATE VIRTUAL TABLE nodes_fts USING fts5(node_id UNINDEXED, content, tokenize='unicode61');
    CREATE INDEX nodes_scope_status ON nodes (scope, status);
    CREATE INDEX nodes_kind_created ON nodes (kind, created_at);
    CREATE INDEX nodes_session_created ON nodes (source_session_id, created_at);
    CREATE INDEX entities_name ON entities (name);
    CREATE INDEX node_entities_entity ON node_entities (entity_id);
    CREATE INDEX facts_entity ON facts (entity_id);
    CREATE INDEX observations_status ON observations (status, proof_count, updated_at);
    CREATE INDEX op_log_op_detail ON op_log (op, detail);
    CREATE INDEX op_log_target ON op_log (target_id);
    CREATE INDEX op_log_at ON op_log (at);
  `)
  const at = 1_700_000_000_000
  db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', '13')`).run()
  db.prepare(`INSERT INTO nodes
    (id, scope, kind, content, importance, confidence, status, created_at, last_accessed_at, access_count,
     source_session_id, source_round, source_seq, embedding, outcome, imagery_json, slot_room, slot_index,
     imagery_score, next_review_at, ease_factor, interval_days, review_reps)
    VALUES (?, 'user', 'fact', ?, 0.7, 0.6, 'active', ?, ?, 3, 'sess-legacy', 2, 7, NULL, 'success',
      '{"caption":"旧门牌","sensoryTags":["冷金属"],"emotionalValence":0.4,"provisional":false}',
      'fact', 1, 0.8, NULL, NULL, NULL, 0)`).run('legacy-a', '旧库事实：端口是 3000', at, at)
  db.prepare(`INSERT INTO nodes
    (id, scope, kind, content, importance, confidence, status, created_at, last_accessed_at, access_count,
     source_session_id, source_round, source_seq, embedding, outcome, imagery_json, slot_room, slot_index,
     imagery_score, next_review_at, ease_factor, interval_days, review_reps)
    VALUES (?, 'user', 'fact', ?, 0.8, 0.6, 'archived', ?, ?, 0, NULL, NULL, NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL, NULL, NULL, 0)`).run('legacy-b', '旧库事实：端口改为 4000', at + 1, at + 1)
  db.prepare(`INSERT INTO nodes
    (id, scope, kind, content, importance, confidence, status, created_at, last_accessed_at, access_count,
     source_session_id, source_round, source_seq, embedding, outcome, imagery_json, slot_room, slot_index,
     imagery_score, next_review_at, ease_factor, interval_days, review_reps)
    VALUES (?, 'user', 'episode', ?, 0.6, 0.5, 'active', ?, ?, 0, 'sess-legacy', 3, 8, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL, NULL, NULL, 0)`).run('legacy-episode', '旧库情景：修复部署', at + 2, at + 2)
  db.prepare(`INSERT INTO edges (from_id, to_id, type, created_at) VALUES ('legacy-b', 'legacy-a', 'supersedes', ?)`).run(at + 1)
  db.prepare(`INSERT INTO nodes_revisions (node_id, content, kind, importance, superseded_at)
    VALUES ('legacy-a', '旧库事实：更早内容', 'fact', 0.5, ?)`).run(at)
  db.prepare(`INSERT INTO tour_routes (position, node_id) VALUES (1, 'legacy-a'), (2, 'legacy-episode')`).run()
  db.prepare(`INSERT INTO profile_blocks (scope, content, version, updated_at)
    VALUES ('user', '旧库 curated 画像', 2, ?)`).run(at)
  db.prepare(`INSERT INTO profile_block_versions (scope, version, content, source, at)
    VALUES ('user', 1, '旧库画像 v1', 'edit', ?), ('user', 2, '旧库 curated 画像', 'rollback', ?)`).run(at, at + 1)
  db.prepare(`INSERT INTO session_summaries (session_id, summary, updated_at)
    VALUES ('sess-legacy', '旧库会话摘要：修复部署', ?)`).run(at + 2)
  db.prepare(`INSERT INTO entities (id, name, kind, aliases_json, created_at, updated_at)
    VALUES ('legacy-entity', 'dsh-engram', 'project', '["engram"]', ?, ?)`).run(at, at)
  db.prepare(`INSERT INTO node_entities (node_id, entity_id) VALUES ('legacy-a', 'legacy-entity')`).run()
  db.prepare(`INSERT INTO facts
    (id, entity_id, content, valid_at, invalid_at, replaced_by, source_node_id, created_at, updated_at)
    VALUES ('legacy-fact-old', 'legacy-entity', '旧事实：仓库在杭州', ?, ?, 'legacy-fact-new', 'legacy-a', ?, ?),
           ('legacy-fact-new', 'legacy-entity', '新事实：仓库迁到上海', ?, NULL, NULL, 'legacy-a', ?, ?)`)
    .run(at, at + 1, at, at, at + 1, at + 1, at + 1)
  db.prepare(`INSERT INTO observations
    (id, scope, belief, status, sources_json, proof_count, embedding, created_at, updated_at, last_validated_at)
    VALUES ('legacy-belief', 'user', '旧库信念：Ken 重视数据保真', 'stale', '["legacy-a","legacy-episode"]', 2,
      NULL, ?, ?, ?)`).run(at, at + 1, at)
  db.prepare(`INSERT INTO op_log (at, op, target_id, detail)
    VALUES (?, 'write', 'legacy-a', '{"kind":"fact","scope":"user"}'),
           (?, 'ingest-done', 'sess-legacy', 'sess-legacy:2'),
           (?, 'reflect-pending', 'AUX', '{"scope":"user","sessionId":"sess-legacy"}')`)
    .run(at, at + 1, at + 2)
  db.prepare(`INSERT INTO nodes_fts (node_id, content) VALUES
    ('legacy-a', ?), ('legacy-b', ?), ('legacy-episode', ?)`)
    .run('旧库 事实 端口 3000', '旧库 事实 端口 4000', '旧库 情景 修复 部署')
  db.close()
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'engram-legacy-full-'))
  path = join(dir, 'legacy.db')
  await createLegacyV13()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function countIn(snapshotPath: string, table: string): Promise<number> {
  const db = new DatabaseSync(snapshotPath, { readOnly: true })
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as unknown as { n: number }).n
  } finally {
    db.close()
  }
}

describe('v13 full-fidelity migration', () => {
  it('迁移到 v15 后所有业务域保真，稳定身份与修订链可用', async () => {
    // 迁移前各域行数（rollback 演练的第二事实源）。
    const before = {
      nodes: await countIn(path, 'nodes'),
      edges: await countIn(path, 'edges'),
      revisions: await countIn(path, 'nodes_revisions'),
      routes: await countIn(path, 'tour_routes'),
      profiles: await countIn(path, 'profile_blocks'),
      profileVersions: await countIn(path, 'profile_block_versions'),
      summaries: await countIn(path, 'session_summaries'),
      entities: await countIn(path, 'entities'),
      nodeEntities: await countIn(path, 'node_entities'),
      facts: await countIn(path, 'facts'),
      observations: await countIn(path, 'observations'),
      opLog: await countIn(path, 'op_log'),
    }
    expect(before.nodes).toBe(3)
    expect(before.opLog).toBe(3)

    const store: EngramStore = await openEngramStore(path)

    // Schema 与稳定身份。
    const raw = new DatabaseSync(path, { readOnly: true })
    const version = raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as unknown as { value: string }
    const memoryIds = raw.prepare('SELECT id, memory_id FROM nodes ORDER BY id').all() as unknown as { id: string; memory_id: string | null }[]
    const revisionMemoryIds = raw.prepare('SELECT node_id, memory_id FROM nodes_revisions').all() as unknown as { node_id: string; memory_id: string | null }[]
    raw.close()
    expect(version.value).toBe('15')
    expect(memoryIds.map(row => row.memory_id)).toEqual(['legacy-a', 'legacy-b', 'legacy-episode'])
    expect(revisionMemoryIds).toEqual([{ node_id: 'legacy-a', memory_id: 'legacy-a' }])

    // nodes + supersedes + revisions + stable identity。
    expect((await store.get(asMemoryId('legacy-a')))?.content).toBe('旧库事实：端口是 3000')
    expect((await store.getMemory(asMemoryId('legacy-b')))?.id).toBe('legacy-b')
    expect((await store.review(asMemoryId('legacy-a')))?.supersededBy.map(id => String(id))).toEqual(['legacy-b'])
    expect((await store.review(asMemoryId('legacy-b')))?.supersedes.map(id => String(id))).toEqual(['legacy-a'])
    expect((await store.review(asMemoryId('legacy-a')))?.revisions.map(rev => rev.content))
      .toEqual(['旧库事实：更早内容'])

    // FTS、episode 时间线与 session summary。
    const searched = await store.search({ text: '端口', scopes: ['user'], limit: 10 }, undefined)
    expect(searched.hits.map(hit => String(hit.record.id))).toContain('legacy-a')
    const episodes = await store.episodeTimeline({ scopes: ['user'], sessionId: 'sess-legacy', limit: 10 })
    expect(episodes.groups).toHaveLength(1)
    expect(episodes.groups[0]?.summary).toBe('旧库会话摘要：修复部署')
    expect(episodes.groups[0]?.episodes.map(row => String(row.id))).toEqual(['legacy-episode'])

    // profile 版本链。
    const profile = await store.getProfileBlock('user')
    expect(profile).toEqual({
      scope: 'user',
      content: '旧库 curated 画像',
      version: 2,
      updatedAt: 1_700_000_000_000,
    })
    expect((await store.listProfileBlockVersions('user', 10)).map(row => row.version)).toEqual([2, 1])
    expect((await store.getProfileBlockVersion('user', 1))?.content).toBe('旧库画像 v1')

    // entity -> fact chain -> belief evidence。
    const entities = await store.listEntities({ limit: 10, offset: 0 })
    expect(entities.total).toBe(1)
    expect(entities.items[0]?.memoryCount).toBe(1)
    const facts = await store.factsOfEntity({ entityId: asEntityId('legacy-entity'), includeInvalid: true, limit: 10, offset: 0 })
    expect(facts.items.map(fact => fact.id)).toEqual(['legacy-fact-new', 'legacy-fact-old'])
    const beliefs = await store.listObservations({ limit: 10 })
    expect(beliefs).toHaveLength(1)
    expect(beliefs[0]?.status).toBe('stale')
    expect(beliefs[0]?.sourceIds.map(id => String(id))).toEqual(['legacy-a', 'legacy-episode'])

    // op_log 状态键与审计行保真。
    expect(await store.hasAudit('ingest-done', 'sess-legacy:2')).toBe(true)
    expect(await store.hasAudit('reflect-pending', '{"scope":"user","sessionId":"sess-legacy"}')).toBe(true)
    expect((await store.recentOps(10)).map(op => op.op)).toContain('write')

    // v13 没有快照表；迁移后应可继续写入，且 schema v14 新增字段不破坏旧读。
    const snapshot = await store.recordInjection({
      sessionId: 'sess-after-migration',
      packetHash: 'c'.repeat(64),
      packet: 'migration packet',
      memoryIds: [asMemoryId('legacy-a'), asMemoryId('legacy-b')],
      hasCurated: true,
      compactionCount: 1,
    })
    expect(await store.getInjection(snapshot.id)).toEqual(snapshot)

    await store.close()

    // 全域行数一致性。
    expect(await countIn(path, 'nodes')).toBe(before.nodes)
    expect(await countIn(path, 'edges')).toBe(before.edges)
    expect(await countIn(path, 'nodes_revisions')).toBe(before.revisions)
    expect(await countIn(path, 'tour_routes')).toBe(before.routes)
    expect(await countIn(path, 'profile_blocks')).toBe(before.profiles)
    expect(await countIn(path, 'profile_block_versions')).toBe(before.profileVersions)
    expect(await countIn(path, 'session_summaries')).toBe(before.summaries)
    expect(await countIn(path, 'entities')).toBe(before.entities)
    expect(await countIn(path, 'node_entities')).toBe(before.nodeEntities)
    expect(await countIn(path, 'facts')).toBe(before.facts)
    expect(await countIn(path, 'observations')).toBe(before.observations)
    // FTS 验证本身写入一条 search-exposure（0.12.0 语义），所以 op_log = 旧 3 行 + 1 行新审计。
    expect(await countIn(path, 'op_log')).toBe(before.opLog + 1)
  })

  it('pre-migration 快照可回退到 v13 原库', async () => {
    const store = await openEngramStore(path)
    await store.close()
    const snapshotPath = `${path}.pre-migration`

    // 用 VACUUM INTO 生成的快照替换主库，验证迁移失败/异常时的原库回退路径。
    await copyFile(snapshotPath, path)
    const restored = new DatabaseSync(path, { readOnly: true })
    const version = restored.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as unknown as { value: string }
    const nodeCount = restored.prepare('SELECT COUNT(*) AS n FROM nodes').get() as unknown as { n: number }
    const revisionCount = restored.prepare('SELECT COUNT(*) AS n FROM nodes_revisions').get() as unknown as { n: number }
    const factCount = restored.prepare('SELECT COUNT(*) AS n FROM facts').get() as unknown as { n: number }
    const observationCount = restored.prepare('SELECT COUNT(*) AS n FROM observations').get() as unknown as { n: number }
    const hasInjectionTable = restored.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'injection_snapshots'").get() as unknown as { n: number }
    restored.close()

    expect(version.value).toBe('13')
    expect(nodeCount.n).toBe(3)
    expect(revisionCount.n).toBe(1)
    expect(factCount.n).toBe(2)
    expect(observationCount.n).toBe(1)
    // 打开器建表先于版本迁移，因此快照可能带空 injection_snapshots；
    // 旧版按未知表忽略即可，关键是 v13 数据和版本号原样保留。
    expect(hasInjectionTable.n).toBe(1)
    expect(await countIn(`${path}.pre-migration`, 'profile_block_versions')).toBe(2)
  })
})
