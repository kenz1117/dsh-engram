import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openEngramStore } from '../src/store/sqlite.ts'
import { asMemoryId } from '../src/types.ts'
import type { EngramStore } from '../src/store/interface.ts'

let dir: string
let store: EngramStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'engram-v2-'))
  store = await openEngramStore(join(dir, 'user.db'))
})
afterEach(async () => {
  await store.close()
})

describe('EngramStore v2 additions', () => {
  it('review 返回条目 + supersedes 链 + 操作日志', async () => {
    const old = await store.write({ scope: 'user', kind: 'fact', content: '端口 3000', sourceRound: 1, sourceSeq: 7 })
    const next = await store.update({ id: old.id, scope: 'user', kind: 'fact', content: '端口 4000' })
    const view = await store.review(next.id)
    expect(view?.record.content).toBe('端口 4000')
    expect(view?.supersedes.map(id => String(id))).toEqual([String(old.id)])
    expect(view?.record.sourceRound).toBeNull()
    const oldView = await store.review(old.id)
    expect(oldView?.supersededBy.map(id => String(id))).toEqual([String(next.id)])
    expect(oldView?.record.sourceSeq).toBe(7)
    expect(oldView?.operations.length).toBeGreaterThan(0)
    expect(oldView?.operations[0]!.op).toBe('superseded')
  })

  it('stats 统计分布与信噪比', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '甲' })
    await store.write({ scope: 'user', kind: 'preference', content: '乙' })
    const stale = await store.write({ scope: 'user', kind: 'episode', content: '丙' })
    await store.forget(stale.id)
    const stats = await store.stats()
    expect(stats.total).toBe(3)
    expect(stats.active).toBe(2)
    expect(stats.forgotten).toBe(1)
    expect(stats.byKind['fact']).toBe(1)
    expect(stats.byKind['episode']).toBe(1)
    expect(stats.signalRatio).toBeCloseTo(2 / 3, 5)
    expect(stats.opLogCount).toBeGreaterThan(0)
  })

  it('decay 归档低重要性且长期未访问的条目', async () => {
    const path = join(dir, 'user.db')
    await store.write({ scope: 'user', kind: 'fact', content: '将被衰减', importance: 0.1 })
    await store.write({ scope: 'user', kind: 'fact', content: '重要性高保留', importance: 0.9 })
    // 把全部条目的最近访问时间拨回 40 天前，模拟长期未访问；
    // 并清掉写入期自动排的复习日程——进入复习调度的条目不参与自动衰减（由复习结果决定命运）。
    const { DatabaseSync } = await import('node:sqlite')
    const raw = new DatabaseSync(path)
    raw.prepare('UPDATE nodes SET last_accessed_at = ?, next_review_at = NULL').run(Date.now() - 40 * 86_400_000)
    raw.close()
    const archived = await store.decay({ importanceBelow: 0.3, olderThanDays: 30 })
    expect(archived).toBe(1)
    const survivors = await store.topActive('user', 10)
    expect(survivors.map(record => record.content)).toEqual(['重要性高保留'])
  })

  it('findContradictions 只报高相似近邻，linkEdge 幂等建边', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '部署端口是 4000', embedding: new Float32Array(512).fill(0.5) })
    await store.write({ scope: 'user', kind: 'fact', content: '毫无相关的另一条', embedding: new Float32Array(512).fill(-0.5) })
    const candidates = await store.findContradictions(new Float32Array(512).fill(0.5))
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.content).toBe('部署端口是 4000')
    // 写入新条目并建 contradicts 边 → review 分组可见
    const next = await store.write({ scope: 'user', kind: 'fact', content: '部署端口改为 5000' })
    await store.linkEdge(next.id, candidates[0]!.id, 'contradicts')
    await store.linkEdge(next.id, candidates[0]!.id, 'contradicts')
    const view = await store.review(next.id)
    expect(view?.contradicts.map(id => String(id))).toEqual([String(candidates[0]!.id)])
  })

  it('supersedeMany 单事务写新归旧并建链', async () => {
    const a = await store.write({ scope: 'user', kind: 'fact', content: '碎片甲', importance: 0.4 })
    const b = await store.write({ scope: 'user', kind: 'fact', content: '碎片乙', importance: 0.6 })
    const merged = await store.supersedeMany(
      { scope: 'user', kind: 'skill', content: '甲乙合并的规律', importance: 0.8, confidence: 0.7, sourceRound: 3, sourceSeq: 12 },
      [a.id, b.id],
    )
    expect((await store.get(a.id))?.status).toBe('archived')
    expect((await store.get(b.id))?.status).toBe('archived')
    const view = await store.review(merged.id)
    expect(view?.supersedes.map(id => String(id)).sort()).toEqual([String(a.id), String(b.id)].sort())
    expect(view?.record.sourceRound).toBe(3)
    expect(view?.record.sourceSeq).toBe(12)
    // 空数组时与 write 等价
    const solo = await store.supersedeMany({ scope: 'user', kind: 'fact', content: '独立条目' }, [])
    expect(solo.content).toBe('独立条目')
  })

  it('exportAll 含任意状态条目与边', async () => {
    const a = await store.write({ scope: 'user', kind: 'fact', content: '导出甲' })
    const forgotten = await store.write({ scope: 'user', kind: 'fact', content: '导出乙' })
    await store.forget(forgotten.id)
    await store.linkEdge(a.id, forgotten.id, 'related')
    const data = await store.exportAll()
    expect(data.records.map(record => record.id).sort()).toEqual([a.id, forgotten.id].sort())
    expect(data.records.find(record => record.id === forgotten.id)?.status).toBe('forgotten')
    expect(data.edges).toHaveLength(1)
    expect(asMemoryId(data.edges[0]!.from)).toBe(a.id)
  })

  it('search 命中提升 confidence', async () => {
    const record = await store.write({ scope: 'user', kind: 'fact', content: '置信度提升条目', confidence: 0.5 })
    await store.search({ text: '置信度', scopes: ['user'] }, undefined)
    const bumped = await store.get(record.id)
    expect(bumped?.confidence).toBeCloseTo(0.55, 5)
  })
})

describe('EngramStore list (management view)', () => {
  it('按 status/kind/子串过滤分页，含全部状态', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '列表甲 fact' })
    await store.write({ scope: 'user', kind: 'preference', content: '列表乙 preference' })
    const forgotten = await store.write({ scope: 'user', kind: 'fact', content: '列表丙 forgotten' })
    await store.forget(forgotten.id)
    const all = await store.list({ scope: 'user', limit: 10, offset: 0 })
    expect(all.total).toBe(3)
    expect(all.records).toHaveLength(3)
    const onlyForgotten = await store.list({ scope: 'user', status: 'forgotten', limit: 10, offset: 0 })
    expect(onlyForgotten.records.map(r => r.id)).toEqual([forgotten.id])
    const onlyPreference = await store.list({ scope: 'user', kind: 'preference', limit: 10, offset: 0 })
    expect(onlyPreference.records.map(r => r.kind)).toEqual(['preference'])
    const byQ = await store.list({ scope: 'user', q: '列表甲', limit: 10, offset: 0 })
    expect(byQ.records.map(r => r.content)).toEqual(['列表甲 fact'])
    const paged = await store.list({ scope: 'user', limit: 1, offset: 1 })
    expect(paged.records).toHaveLength(1)
    expect(paged.total).toBe(3)
  })

  it('sort=tour 按巡游路线桩位顺序排，未上路线者置后', async () => {
    const a = await store.write({ scope: 'user', kind: 'fact', content: '路线甲' })
    const b = await store.write({ scope: 'user', kind: 'fact', content: '路线乙' })
    const c = await store.write({ scope: 'user', kind: 'fact', content: '路线丙' })
    // 三条同毫秒写入：显式铺开 created_at 让缺省倒序断言确定（甲最早、丙最新）。
    const { DatabaseSync } = await import('node:sqlite')
    const raw = new DatabaseSync(join(dir, 'user.db'))
    const base = Date.now()
    raw.prepare('UPDATE nodes SET created_at = ? WHERE id = ?').run(base - 3000, a.id)
    raw.prepare('UPDATE nodes SET created_at = ? WHERE id = ?').run(base - 2000, b.id)
    raw.prepare('UPDATE nodes SET created_at = ? WHERE id = ?').run(base - 1000, c.id)
    raw.close()
    const byTour = await store.list({ scope: 'user', sort: 'tour', limit: 10, offset: 0 })
    expect(byTour.records.map(record => record.id)).toEqual([a.id, b.id, c.id])
    // 缺省排序：created_at 倒序（后写的在前）。
    const byTime = await store.list({ scope: 'user', limit: 10, offset: 0 })
    expect(byTime.records.map(record => record.id)).toEqual([c.id, b.id, a.id])
  })
})

describe('EngramStore 宫殿与复习调度（schema v6）', () => {
  it('写入期自动排桩：按 kind 分房、序号递增、登记巡游路线、1 天后到期', async () => {
    const fact = await store.write({ scope: 'user', kind: 'fact', content: '自动排桩的事实' })
    expect(fact.slot).toEqual({ room: '事实厅', index: 1 })
    const preference = await store.write({ scope: 'user', kind: 'preference', content: '自动排桩的偏好' })
    expect(preference.slot).toEqual({ room: '偏好阁', index: 1 })
    const secondFact = await store.write({ scope: 'user', kind: 'fact', content: '第二条事实' })
    expect(secondFact.slot).toEqual({ room: '事实厅', index: 2 })
    // 路线按登记先后 append：事实厅#1、偏好阁#1、事实厅#2。
    const route = await store.routeList()
    expect(route.map(stop => stop.id)).toEqual([fact.id, preference.id, secondFact.id])
    expect(await store.routeHas(fact.id)).toBe(true)
    // 初始排期：写入时刻 + 1 天（用近似断言容忍毫秒级漂移）。
    expect(fact.review?.nextReviewAt).toBeGreaterThan(Date.now() + 86_400_000 - 5_000)
    expect(fact.review?.reps).toBe(0)
  })

  it('门牌评分落库：唯一·差异化·带日期三者独立计分', async () => {
    const good = await store.write({
      scope: 'user',
      kind: 'fact',
      content: '端口配置',
      imagery: { caption: '2026-09-11 端口改为 4000 的定案', sensoryTags: [], emotionalValence: 0, provisional: false },
    })
    expect(good.imageryScore).toBe(1)
    const bad = await store.write({
      scope: 'user',
      kind: 'fact',
      content: '另一条',
      imagery: { caption: '端口改', sensoryTags: [], emotionalValence: 0, provisional: false },
    })
    expect(bad.imageryScore).toBe(0)
  })

  it('scheduleReview 推进 SM-2：连续满分间隔 1 → 6，失败重置为 1 天', async () => {
    const record = await store.write({ scope: 'user', kind: 'skill', content: '复习调度目标' })
    const first = await store.scheduleReview(record.id, 5)
    expect(first?.review?.intervalDays).toBe(1)
    expect(first?.review?.reps).toBe(1)
    const second = await store.scheduleReview(record.id, 5)
    expect(second?.review?.intervalDays).toBe(6)
    expect(second?.review?.reps).toBe(2)
    const failed = await store.scheduleReview(record.id, 1)
    expect(failed?.review?.intervalDays).toBe(1)
    expect(failed?.review?.reps).toBe(0)
    // 不存在的 id 返回 undefined（面板/工具据此报 404）。
    expect(await store.scheduleReview(asMemoryId('nonexistent-id'), 5)).toBeUndefined()
  })

  it('dueReviews 只回收已到期条目，按最逾期在前', async () => {
    const due = await store.write({ scope: 'user', kind: 'fact', content: '已到期条目' })
    const fresh = await store.write({ scope: 'user', kind: 'fact', content: '刚写入未到期条目' })
    const path = join(dir, 'user.db')
    const { DatabaseSync } = await import('node:sqlite')
    const raw = new DatabaseSync(path)
    // 把 due 拨到 3 天前，fresh 拨到 1 天后。
    raw.prepare('UPDATE nodes SET next_review_at = ? WHERE id = ?').run(Date.now() - 3 * 86_400_000, due.id)
    raw.prepare('UPDATE nodes SET next_review_at = ? WHERE id = ?').run(Date.now() + 86_400_000, fresh.id)
    raw.close()
    const queue = await store.dueReviews(Date.now(), 10)
    expect(queue.map(record => record.id)).toEqual([due.id])
  })

  it('backfillSlots 幂等：为存量条目排桩并补登记路线，重跑不重复', async () => {
    const path = join(dir, 'legacy.db')
    const legacy = await openEngramStore(path)
    const old = await legacy.write({ scope: 'user', kind: 'decision', content: '存量条目' })
    await legacy.close()
    // 清空桩位与路线，模拟 v6 之前写入的存量库（列已存在，值为 NULL）。
    const { DatabaseSync } = await import('node:sqlite')
    const raw = new DatabaseSync(path)
    raw.prepare('UPDATE nodes SET slot_room = NULL, slot_index = NULL').run()
    raw.exec('DELETE FROM tour_routes')
    raw.close()
    const reopened = await openEngramStore(path)
    const opened: string[] = []
    const patched = await reopened.backfillSlots(room => { opened.push(room) })
    expect(patched).toBe(1)
    const after = await reopened.get(old.id)
    expect(after?.slot).toEqual({ room: '决策堂', index: 1 })
    expect((await reopened.routeList()).map(stop => stop.id)).toEqual([old.id])
    // 幂等：重跑无待处理条目。
    expect(await reopened.backfillSlots(room => { opened.push(room) })).toBe(0)
    expect(opened).toEqual([])
    await reopened.close()
  })

  it('真实 v5 库（无 v6 列）打开时迁移到 v6：建列建索引并保留数据', async () => {
    const path = join(dir, 'real-v5.db')
    const { DatabaseSync } = await import('node:sqlite')
    const raw = new DatabaseSync(path)
    // 手工构造 v5 结构：有 outcome / imagery_json，但没有 slot_room 等 v6 列与 tour_routes 表。
    raw.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL,
        importance REAL NOT NULL, confidence REAL NOT NULL, status TEXT NOT NULL,
        created_at INTEGER NOT NULL, last_accessed_at INTEGER NOT NULL, access_count INTEGER NOT NULL,
        source_session_id TEXT, source_round INTEGER, source_seq INTEGER, embedding BLOB,
        outcome TEXT, imagery_json TEXT);
      CREATE TABLE edges (from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL,
        created_at INTEGER NOT NULL, PRIMARY KEY (from_id, to_id, type));
      CREATE TABLE op_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, op TEXT NOT NULL,
        target_id TEXT NOT NULL, detail TEXT);
      CREATE TABLE nodes_revisions (node_id TEXT NOT NULL, content TEXT NOT NULL, kind TEXT NOT NULL,
        importance REAL NOT NULL, superseded_at INTEGER NOT NULL);
      INSERT INTO meta (key, value) VALUES ('schema_version', '5');
    `)
    raw.prepare(`INSERT INTO nodes
      (id, scope, kind, content, importance, confidence, status, created_at, last_accessed_at, access_count)
      VALUES ('legacy-1', 'user', 'fact', 'v5 存量条目', 0.5, 0.5, 'active', ?, ?, 0)`)
      .run(Date.now(), Date.now())
    raw.close()
    // 打开即迁移：不抛 no such column（v6 索引建在列之前是此前的回归点）。
    const migrated = await openEngramStore(path)
    const record = await migrated.get(asMemoryId('legacy-1'))
    expect(record?.content).toBe('v5 存量条目')
    expect(record?.slot).toBeUndefined()
    // 迁移后新写入可正常排桩：列与索引都已就位。
    const fresh = await migrated.write({ scope: 'user', kind: 'fact', content: '迁移后写入' })
    expect(fresh.slot).toEqual({ room: '事实厅', index: 1 })
    // 存量条目由 backfillSlots 补齐桩位（首开时由插件层触发，此处直接验证其幂等可跑）。
    expect(await migrated.backfillSlots(() => { /* 测试不关心开新房提示 */ })).toBe(1)
    expect((await migrated.get(asMemoryId('legacy-1')))?.slot).toEqual({ room: '事实厅', index: 2 })
    await migrated.close()
    const check = new DatabaseSync(path)
    expect((check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as unknown as { value: string }).value).toBe('6')
    const indexes = (check.prepare('PRAGMA index_list(nodes)').all() as unknown as { name: string }[]).map(row => row.name)
    expect(indexes).toContain('nodes_slot')
    expect(indexes).toContain('nodes_review_due')
    check.close()
  })

  it('v5 版本号但列/表齐备时迁移幂等（重复打开不报错）', async () => {
    const path = join(dir, 'migrate-v6.db')
    const legacy = await openEngramStore(path)
    const record = await legacy.write({ scope: 'user', kind: 'fact', content: 'v5 时代条目' })
    await legacy.close()
    const { DatabaseSync } = await import('node:sqlite')
    const raw = new DatabaseSync(path)
    // 仅降级版本号模拟 v5：v6 新增列/表此时已存在，迁移路径靠幂等探测跳过重复 DDL。
    raw.prepare("UPDATE meta SET value = '5' WHERE key = 'schema_version'").run()
    raw.close()
    const migrated = await openEngramStore(path)
    expect((await migrated.get(record.id))?.content).toBe('v5 时代条目')
    await migrated.close()
    const check = new DatabaseSync(path)
    const version = (check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as unknown as { value: string }).value
    check.close()
    expect(version).toBe('6')
  })
})
