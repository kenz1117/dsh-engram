import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openEngramStore } from '../src/store/sqlite.ts'
import { asMemoryId } from '../src/types.ts'
import type { MemoryRecord } from '../src/types.ts'
import type { EngramStore } from '../src/store/interface.ts'

let dir: string
let store: EngramStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'engram-'))
  store = await openEngramStore(join(dir, 'user.db'))
})
afterEach(async () => {
  await store.close()
})

describe('EngramStore (sqlite)', () => {
  it('write 后可 get，字段完整', async () => {
    const record = await store.write({ scope: 'user', kind: 'preference', content: '用户偏好简体中文回复', importance: 0.8 })
    const fetched = await store.get(record.id)
    expect(fetched?.content).toBe('用户偏好简体中文回复')
    expect(fetched?.status).toBe('active')
    expect(fetched?.accessCount).toBe(0)
    expect(fetched?.sourceSessionId).toBeNull()
  })

  it('list 按 redacted 标记过滤（三态）', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '密钥 [REDACTED:api-key] 已脱敏' })
    await store.write({ scope: 'user', kind: 'fact', content: '部署在 4000 端口' })
    await store.write({ scope: 'user', kind: 'fact', content: '普通条目' })
    const all = await store.list({ scope: 'user', limit: 10, offset: 0 })
    expect(all.total).toBe(3)
    const only = await store.list({ scope: 'user', redacted: true, limit: 10, offset: 0 })
    expect(only.total).toBe(1)
    expect(only.records[0]?.content).toContain('[REDACTED:api-key]')
    const none = await store.list({ scope: 'user', redacted: false, limit: 10, offset: 0 })
    expect(none.total).toBe(2)
    expect(none.records.some(record => record.content.includes('[REDACTED:'))).toBe(false)
  })

  it('stats 统计含脱敏标记条目数', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '密钥 [REDACTED:api-key] 已脱敏' })
    await store.write({ scope: 'user', kind: 'fact', content: '普通条目' })
    const stats = await store.stats()
    expect(stats.total).toBe(2)
    expect(stats.redacted).toBe(1)
  })

  it('reportOutcome 更新效果并联动 confidence（提权/降权/夹逼）', async () => {
    const skill = await store.write({ scope: 'user', kind: 'skill', content: '部署前先跑 typecheck 再跑 test', importance: 0.7 })
    const up = await store.reportOutcome(skill.id, 'success')
    expect(up?.outcome).toBe('success')
    expect(up!.confidence).toBeCloseTo(0.55, 5) // 0.5 + 0.05
    const down = await store.reportOutcome(skill.id, 'failure')
    expect(down?.outcome).toBe('failure')
    expect(down!.confidence).toBeCloseTo(0.45, 5) // 0.55 - 0.1
    // 边界夹逼：连续失败到 0 不为负
    for (let index = 0; index < 10; index++) {
      await store.reportOutcome(skill.id, 'failure')
    }
    const floor = await store.reportOutcome(skill.id, 'failure')
    expect(floor!.confidence).toBe(0)
    // 不存在 id 返回 undefined（不抛错）
    expect(await store.reportOutcome('mem-missing' as never, 'success')).toBeUndefined()
  })

  it('空 content loud 失败', async () => {
    await expect(store.write({ scope: 'user', kind: 'fact', content: '   ' })).rejects.toThrow(/content/)
  })

  it('FTS 检索命中中文 2 字查询', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '项目使用 pnpm 管理依赖' })
    const result = await store.search({ text: 'pnpm', scopes: ['user'] }, undefined)
    expect(result.degraded).toBe(true)
    expect(result.hits.length).toBe(1)
    expect(result.hits[0]!.via).toBe('fts')
  })

  it('中文 2 字查询命中（2-gram 切词）', async () => {
    await store.write({ scope: 'user', kind: 'decision', content: '部署端口改为 4000' })
    const result = await store.search({ text: '端口', scopes: ['user'] }, undefined)
    expect(result.hits.length).toBe(1)
  })

  it('向量道与 FTS 道融合，via=both 且 degraded=false', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: 'alpha 内容说明', embedding: new Float32Array(512).fill(0.1) })
    const vec = new Float32Array(512).fill(0.1)
    const result = await store.search({ text: 'alpha', scopes: ['user'] }, vec)
    expect(result.degraded).toBe(false)
    expect(result.hits[0]!.via).toBe('both')
  })

  it('向量道低于语义门槛的条目不出现', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '完全无关的内容词', embedding: new Float32Array(512).fill(0.4) })
    // 查询与内容无共享 2-gram，且查询向量与内容向量方向相反（余弦 < 门槛）。
    const vec = new Float32Array(512).fill(-0.4)
    const result = await store.search({ text: '量子纠缠', scopes: ['user'] }, vec)
    expect(result.hits).toHaveLength(0)
  })

  it('update 建立 supersedes 链且旧条目退出检索', async () => {
    const old = await store.write({ scope: 'user', kind: 'fact', content: '端口是 3000' })
    const next = await store.update({ id: old.id, scope: 'user', kind: 'fact', content: '端口改为 4000' })
    expect((await store.get(old.id))?.status).toBe('archived')
    const result = await store.search({ text: '端口', scopes: ['user'] }, undefined)
    expect(result.hits.map(hit => hit.record.id)).toEqual([next.id])
    expect(result.hits[0]!.record.content).toContain('4000')
  })

  it('update 不存在的条目 loud 失败', async () => {
    await expect(store.update({ id: asMemoryId('nope'), scope: 'user', kind: 'fact', content: 'x' })).rejects.toThrow(/不存在/)
  })

  it('forget/restore 往返', async () => {
    const record = await store.write({ scope: 'user', kind: 'fact', content: '待删除条目' })
    expect((await store.forget(record.id)).status).toBe('forgotten')
    expect(await store.get(record.id)).toBeDefined()
    expect((await store.restore(record.id)).status).toBe('active')
    const result = await store.search({ text: '待删除', scopes: ['user'] }, undefined)
    expect(result.hits).toHaveLength(1)
  })

  it('检索命中会强化访问计数', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '访问计数条目' })
    await store.search({ text: '访问计数', scopes: ['user'] }, undefined)
    const result = await store.search({ text: '访问计数', scopes: ['user'] }, undefined)
    expect(result.hits[0]!.record.accessCount).toBe(1)
  })

  it('topActive 按 importance 倒序', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '低重要性', importance: 0.2 })
    await store.write({ scope: 'user', kind: 'fact', content: '高重要性', importance: 0.9 })
    const top = await store.topActive('user', 1)
    expect(top[0]!.content).toBe('高重要性')
  })

  it('timeline 按 createdAt 倒序且 topic 过滤', async () => {
    const a = await store.write({ scope: 'user', kind: 'episode', content: '事件 A 描述' })
    await new Promise(resolve => setTimeout(resolve, 3))
    const b = await store.write({ scope: 'user', kind: 'episode', content: '事件 B 描述' })
    const rows = await store.timeline({ scopes: ['user'] })
    expect(rows.map(row => row.id)).toEqual([b.id, a.id])
    const filtered = await store.timeline({ scopes: ['user'], topic: 'B' })
    expect(filtered.map(row => row.id)).toEqual([b.id])
  })

  it('purge 物理清空', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '将被清除' })
    await store.purge()
    const result = await store.search({ text: '清除', scopes: ['user'] }, undefined)
    expect(result.hits).toHaveLength(0)
    expect(await store.topActive('user', 10)).toHaveLength(0)
  })

  it('schema 版本不兼容时拒绝打开', async () => {
    const path = join(dir, 'bad.db')
    const bad = await openEngramStore(path)
    await bad.close()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(path)
    db.prepare("UPDATE meta SET value = '999' WHERE key = 'schema_version'").run()
    db.close()
    await expect(openEngramStore(path)).rejects.toThrow(/schema/i)
  })

  it('v2 旧库打开时自动迁移到最新 schema（保数据）', async () => {
    const path = join(dir, 'migrate.db')
    // 先用当前版本建库写入数据，再手工把 schema_version 改回 v2（SQLite 不支持 DROP COLUMN，
    // 测试通过迁移脚本的 ALTER/CREATE 路径保证 outcome/revisions/imagery_json 都被加上）。
    const legacy = await openEngramStore(path)
    const record = await legacy.write({ scope: 'user', kind: 'skill', content: '迁移前写入的技能' })
    await legacy.close()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(path)
    db.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run()
    db.close()
    const migrated = await openEngramStore(path)
    const fetched = await migrated.get(record.id)
    expect(fetched?.content).toBe('迁移前写入的技能')
    expect(fetched?.outcome).toBeUndefined()
    await migrated.close()
    const db2 = new DatabaseSync(path)
    const version = (db2.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as unknown as { value: string }).value
    db2.close()
    expect(version).toBe('11')
  })

  it('v3 库打开时顺序迁移到 v5（数据保留，修订表可用）', async () => {
    const path = join(dir, 'migrate-v3.db')
    const legacy = await openEngramStore(path)
    const record = await legacy.write({ scope: 'user', kind: 'fact', content: 'v3 时代条目' })
    await legacy.close()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(path)
    // 仅降级 schema_version；不删 outcome 列（v3 已存在 outcome，但少了 revisions/imagery_json）。
    db.exec('DROP TABLE nodes_revisions')
    db.prepare("UPDATE meta SET value = '3' WHERE key = 'schema_version'").run()
    db.close()
    const migrated = await openEngramStore(path)
    expect((await migrated.get(record.id))?.content).toBe('v3 时代条目')
    // 迁移后修订表可用：update 写快照并可回读。
    await migrated.update({ id: record.id, scope: 'user', kind: 'fact', content: 'v5 修订内容' })
    const view = await migrated.review(record.id)
    expect(view?.revisions.map(rev => rev.content)).toEqual(['v3 时代条目'])
    await migrated.close()
  })

  it('asMemoryId 品牌化 id 可透传 get', async () => {
    const record = await store.write({ scope: 'user', kind: 'fact', content: '品牌 id' })
    expect((await store.get(asMemoryId(record.id)))?.id).toBe(record.id)
  })
})

describe('修订历史与操作流（schema v4）', () => {
  let dir: string
  let store: EngramStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'engram-rev-'))
    store = await openEngramStore(join(dir, 'user.db'))
  })
  afterEach(async () => {
    await store.close()
  })

  it('update 归档旧条目前写内容快照，review 返回修订历史', async () => {
    const a = await store.write({ scope: 'user', kind: 'fact', content: '端口是 3000', importance: 0.6 })
    const b = await store.update({ id: a.id, scope: 'user', kind: 'fact', content: '端口改为 4000' })
    const c = await store.update({ id: b.id, scope: 'user', kind: 'fact', content: '端口改为 5000' })
    // 快照记录的是被取代条目自己的旧内容；链式修订各自留痕。
    expect((await store.review(a.id))?.revisions.map(rev => rev.content)).toEqual(['端口是 3000'])
    expect((await store.review(a.id))?.revisions[0]!.kind).toBe('fact')
    expect((await store.review(a.id))?.revisions[0]!.importance).toBe(0.6)
    expect((await store.review(a.id))?.revisions[0]!.supersededAt).toBeGreaterThan(0)
    expect((await store.review(b.id))?.revisions.map(rev => rev.content)).toEqual(['端口改为 4000'])
    expect((await store.review(c.id))?.revisions).toEqual([])
    // 链路完整：c 超越 b，b 超越 a。
    expect((await store.review(c.id))?.supersedes.map(id => String(id))).toEqual([String(b.id)])
    expect((await store.review(a.id))?.supersededBy.map(id => String(id))).toEqual([String(b.id)])
  })

  it('未被修订过的条目修订历史为空', async () => {
    const record = await store.write({ scope: 'user', kind: 'fact', content: '从未修订' })
    const view = await store.review(record.id)
    expect(view?.revisions).toEqual([])
  })

  it('recentOps 返回最近操作（倒序，跨类型）', async () => {
    const a = await store.write({ scope: 'user', kind: 'fact', content: '操作流条目' })
    await store.forget(a.id)
    const ops = await store.recentOps(10)
    expect(ops.length).toBeGreaterThanOrEqual(2)
    expect(ops[0]!.op).toBe('forget')
    expect(ops[0]!.targetId).toBe(a.id)
    expect(ops[ops.length - 1]!.op).toBe('write')
    // limit 生效。
    expect(await store.recentOps(1)).toHaveLength(1)
  })
})

describe('渐进式披露：getMany / neighbors', () => {
  let dir: string
  let store: EngramStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'engram-prog-'))
    store = await openEngramStore(join(dir, 'user.db'))
  })
  afterEach(async () => {
    await store.close()
  })

  it('getMany 按入参顺序返回，去重且缺失静默跳过', async () => {
    const a = await store.write({ scope: 'user', kind: 'fact', content: '甲' })
    const b = await store.write({ scope: 'user', kind: 'fact', content: '乙' })
    const c = await store.write({ scope: 'user', kind: 'fact', content: '丙' })
    const missing = asMemoryId('00000000-0000-0000-0000-000000000000')
    const result = await store.getMany([c.id, a.id, c.id, missing, b.id])
    expect(result.map(r => r.content)).toEqual(['丙', '甲', '乙'])
  })

  it('neighbors 沿 related/supersedes/contradicts 走廊边 BFS 展开并去重起点', async () => {
    const a = await store.write({ scope: 'user', kind: 'fact', content: '起点房间' })
    const b = await store.write({ scope: 'user', kind: 'fact', content: '一跳邻居' })
    const c = await store.write({ scope: 'user', kind: 'fact', content: '两跳邻居' })
    const d = await store.write({ scope: 'user', kind: 'fact', content: '与起点互斥' })
    await store.linkEdge(a.id, b.id, 'related')
    await store.linkEdge(b.id, c.id, 'refines')
    await store.linkEdge(a.id, d.id, 'contradicts')
    const ns1 = await store.neighbors(a.id, 1)
    expect(ns1.map(r => r.content).sort()).toEqual(['一跳邻居', '与起点互斥'])
    const ns2 = await store.neighbors(a.id, 2)
    expect(ns2.map(r => r.content)).toEqual(expect.arrayContaining(['一跳邻居', '两跳邻居', '与起点互斥']))
    expect(ns2).toHaveLength(3)
    // depth 越界：夹到 1-3（0 → 1、9 → 3）。
    expect(await store.neighbors(a.id, 0)).toHaveLength(2)
    expect(await store.neighbors(a.id, 9)).toHaveLength(3)
  })

  it('无邻居时返回空数组（不报错）', async () => {
    const a = await store.write({ scope: 'user', kind: 'fact', content: '孤岛房间' })
    expect(await store.neighbors(a.id, 3)).toEqual([])
    expect(await store.getMany([])).toEqual([])
  })

  it('nearestNeighbor 返回余弦最高的 active 条目；空库 undefined；遗忘后不参与', async () => {
    expect(await store.nearestNeighbor(new Float32Array(512).fill(0.1))).toBeUndefined()
    const a = await store.write({ scope: 'user', kind: 'fact', content: '杭州的条目', embedding: new Float32Array(512).fill(0.1) })
    const b = await store.write({ scope: 'user', kind: 'fact', content: '完全无关的条目', embedding: new Float32Array(512).fill(-0.4) })
    const nearest = await store.nearestNeighbor(new Float32Array(512).fill(0.1))
    expect(nearest?.record.id).toBe(a.id)
    expect(nearest?.similarity).toBeCloseTo(1, 5)
    await store.forget(a.id)
    const after = await store.nearestNeighbor(new Float32Array(512).fill(0.1))
    expect(after?.record.id).toBe(b.id)
  })

  it('reinforce 强化置信度与访问计数并记 write-merge 审计；未知 id 返回 undefined', async () => {
    const a = await store.write({ scope: 'user', kind: 'fact', content: '被复述的条目' })
    const reinforced = await store.reinforce(a.id, '{"content":"复述","similarity":0.95}')
    expect(reinforced?.confidence).toBeCloseTo(0.55, 5)
    expect(reinforced?.accessCount).toBe(1)
    const ops = await store.recentOps(10)
    expect(ops.some(op => op.op === 'write-merge' && op.targetId === a.id)).toBe(true)
    expect(await store.reinforce(asMemoryId('missing'), '{}')).toBeUndefined()
  })
})

describe('episodeTimeline (episode 情景独立时间线)', () => {
  const MINUTE = 60_000
  /** 基准时刻：2026-09-01 10:00 UTC。 */
  const base = Date.parse('2026-09-01T10:00:00Z')

  beforeEach(() => {
    // createdAt 由 store 内部 Date.now() 决定：用假时钟精确控制写入时刻。
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** 把系统时间拨到指定时刻再写入一条；sessionId 未传时为无会话来源（null）。 */
  async function writeAt(at: number, input: { content: string; kind?: 'episode' | 'fact'; sessionId?: string }): Promise<MemoryRecord> {
    vi.setSystemTime(at)
    return store.write({
      scope: 'user',
      kind: input.kind ?? 'episode',
      content: input.content,
      ...(input.sessionId === undefined ? {} : { sourceSessionId: input.sessionId }),
    })
  }

  it('日期范围只命中窗口内的 episode，其他 kind 不入时间线', async () => {
    const d1 = await writeAt(base, { content: '周一事件', sessionId: 's1' })
    await writeAt(base + 30 * MINUTE, { kind: 'fact', content: '周一事实' })
    const d2 = await writeAt(base + 24 * 60 * MINUTE, { content: '周二事件', sessionId: 's1' })
    const ranged = await store.episodeTimeline({ scopes: ['user'], since: base, until: base + 24 * 60 * MINUTE - 1 })
    expect(ranged.groups).toHaveLength(1)
    expect(ranged.groups[0]!.episodes.map(episode => episode.id)).toEqual([d1.id])
    // 不限范围时同会话条目归同组（跨天不拆），组内按时间升序。
    const all = await store.episodeTimeline({ scopes: ['user'] })
    expect(all.groups).toHaveLength(1)
    expect(all.groups[0]!.episodes.map(episode => episode.id)).toEqual([d1.id, d2.id])
    expect(all.groups[0]!.startedAt).toBe(base)
    expect(all.groups[0]!.endedAt).toBe(base + 24 * 60 * MINUTE)
  })

  it('按来源会话分组：组间新→旧，组内时间升序；无会话来源单独成组', async () => {
    await writeAt(base, { content: '早会记录', sessionId: 's-old' })
    await writeAt(base + 5 * MINUTE, { content: '早会后续', sessionId: 's-old' })
    await writeAt(base + 60 * MINUTE, { content: '下午的事', sessionId: 's-new' })
    await writeAt(base + 90 * MINUTE, { content: '显式保存无会话' })
    const result = await store.episodeTimeline({ scopes: ['user'] })
    // 组排序键是组内最早条目：无会话组(90m) > s-new(60m) > s-old(0m)。
    expect(result.groups.map(group => group.sessionId)).toEqual([null, 's-new', 's-old'])
    expect(result.groups[0]!.episodes.map(episode => episode.content)).toEqual(['显式保存无会话'])
    expect(result.groups[2]!.episodes.map(episode => episode.content)).toEqual(['早会记录', '早会后续'])
    expect(result.groups[2]!.startedAt).toBe(base)
    expect(result.groups[2]!.endedAt).toBe(base + 5 * MINUTE)
  })

  it('sessionId 过滤只返回该会话', async () => {
    await writeAt(base, { content: 'A 会话事件', sessionId: 's-a' })
    await writeAt(base + MINUTE, { content: 'B 会话事件', sessionId: 's-b' })
    const result = await store.episodeTimeline({ scopes: ['user'], sessionId: 's-a' })
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0]!.sessionId).toBe('s-a')
    expect(result.groups[0]!.episodes.map(episode => episode.content)).toEqual(['A 会话事件'])
  })

  it('around 邻近扩展：默认 ±60 分钟窗口内 episode 升序，排除锚点与非 episode；锚点缺失 loud 失败', async () => {
    const anchor = await writeAt(base, { kind: 'fact', content: '锚点事实' })
    await writeAt(base - 30 * MINUTE, { content: '前 30 分钟' })
    await writeAt(base + 45 * MINUTE, { content: '后 45 分钟' })
    await writeAt(base + 90 * MINUTE, { content: '窗口外的情景' })
    const result = await store.episodeTimeline({ scopes: ['user'], around: asMemoryId(anchor.id) })
    expect(result.around!.anchor.id).toBe(anchor.id)
    expect(result.around!.neighbors.map(episode => episode.content)).toEqual(['前 30 分钟', '后 45 分钟'])
    expect(result.groups).toEqual([])
    await expect(store.episodeTimeline({ scopes: ['user'], around: asMemoryId('nope') })).rejects.toThrow(/不存在/)
  })

  it('proximityMs 自定义窗口；limit 截断邻居与条目数', async () => {
    const anchor = await writeAt(base, { content: '锚点情景' })
    await writeAt(base - 10 * MINUTE, { content: '前 10 分钟' })
    await writeAt(base + 20 * MINUTE, { content: '后 20 分钟' })
    const narrow = await store.episodeTimeline({ scopes: ['user'], around: asMemoryId(anchor.id), proximityMs: 15 * MINUTE })
    expect(narrow.around!.neighbors.map(episode => episode.content)).toEqual(['前 10 分钟'])
    const capped = await store.episodeTimeline({ scopes: ['user'], around: asMemoryId(anchor.id), limit: 1 })
    expect(capped.around!.neighbors).toHaveLength(1)
    // 组模式同样受 limit 约束（按条数截断，DESC 取最近的）。
    const limited = await store.episodeTimeline({ scopes: ['user'], limit: 1 })
    expect(limited.groups.flatMap(group => group.episodes)).toHaveLength(1)
    expect(limited.groups[0]!.episodes[0]!.content).toBe('后 20 分钟')
  })

  it('episode 时间线索引在新建库就位', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(dir, 'user.db'))
    const indexes = (db.prepare('PRAGMA index_list(nodes)').all() as unknown as { name: string }[]).map(row => row.name)
    db.close()
    expect(indexes).toContain('nodes_kind_created')
    expect(indexes).toContain('nodes_session_created')
  })

  it('session_summaries 表在新建库与 v8 迁移后就位，schema_version 升到 11', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(dir, 'user.db'))
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as { name: string }[])
      .map(row => row.name)
    const version = (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as unknown as { value: string }).value
    db.close()
    expect(tables).toContain('session_summaries')
    expect(version).toBe('11')
    // v8 旧库（手工降版）重开时经 MIGRATIONS['8'] 建出摘要表，数据零搬运。
    const legacyPath = join(dir, 'legacy-v8.db')
    const legacy = await openEngramStore(legacyPath)
    await legacy.close()
    const raw = new DatabaseSync(legacyPath)
    raw.prepare("UPDATE meta SET value = '8' WHERE key = 'schema_version'").run()
    raw.prepare('DROP TABLE session_summaries').run()
    raw.close()
    const reopened = await openEngramStore(legacyPath)
    await reopened.close()
    const raw2 = new DatabaseSync(legacyPath)
    const tables2 = (raw2.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as { name: string }[])
      .map(row => row.name)
    raw2.close()
    expect(tables2).toContain('session_summaries')
  })

  it('会话摘要 upsert/读取；episodeTimeline 组头带出摘要，未生成的组缺省', async () => {
    await writeAt(base, { content: 's1 的事件', sessionId: 's1' })
    await writeAt(base + MINUTE, { content: 's2 的事件', sessionId: 's2' })
    // 未写入过：读取 undefined，组头不带 summary 键（exactOptionalPropertyTypes 不允许显式 undefined）。
    expect(await store.getSessionSummary('s1')).toBeUndefined()
    const before = await store.episodeTimeline({ scopes: ['user'] })
    expect('summary' in before.groups.find(group => group.sessionId === 's1')!).toBe(false)
    // 写入后：读取命中，组头带摘要。
    await store.setSessionSummary('s1', '为记忆宫殿补齐了会话摘要链路')
    expect(await store.getSessionSummary('s1')).toBe('为记忆宫殿补齐了会话摘要链路')
    const after = await store.episodeTimeline({ scopes: ['user'] })
    expect(after.groups.find(group => group.sessionId === 's1')?.summary).toBe('为记忆宫殿补齐了会话摘要链路')
    expect('summary' in after.groups.find(group => group.sessionId === 's2')!).toBe(false)
    // upsert 覆盖：同会话重跑生成新摘要时替换旧值（每会话只存一条）。
    await store.setSessionSummary('s1', '覆盖后的新摘要')
    expect(await store.getSessionSummary('s1')).toBe('覆盖后的新摘要')
    // 无会话来源的组永远没有摘要。
    await writeAt(base + 2 * MINUTE, { content: '显式保存无会话' })
    const mixed = await store.episodeTimeline({ scopes: ['user'] })
    expect('summary' in mixed.groups.find(group => group.sessionId === null)!).toBe(false)
  })

  it('purge 清空会话摘要', async () => {
    await store.setSessionSummary('s1', '会被 purge 清掉的摘要')
    await store.purge()
    expect(await store.getSessionSummary('s1')).toBeUndefined()
  })
})

describe('实体词典', () => {
  it('resolveEntities 新建并按归一化名/别名复用（大小写与空白不敏感）', async () => {
    const first = await store.resolveEntities([{ name: 'DeepSeek Harness', kind: 'project', aliases: ['DSH'] }])
    expect(first).toHaveLength(1)
    expect(first[0]!.name).toBe('DeepSeek Harness')
    expect(first[0]!.aliases).toEqual(['DSH'])
    // 归一化复用：不同大小写与多余空白命中同一条，不新建。
    const second = await store.resolveEntities([{ name: '  deepseek   harness ', kind: 'project' }])
    expect(second[0]!.id).toBe(first[0]!.id)
    // 别名命中同一条。
    const third = await store.resolveEntities([{ name: 'dsh', kind: 'project' }])
    expect(third[0]!.id).toBe(first[0]!.id)
    // 词典里确实只有一条（复用不产生新行）。
    const list = await store.listEntities({ limit: 10, offset: 0 })
    expect(list.total).toBe(1)
  })

  it('resolveEntities 清洗后空名 loud 失败；空提及列表直接返回', async () => {
    await expect(store.resolveEntities([{ name: '   ', kind: 'other' }])).rejects.toThrow(/实体名不能为空/)
    expect(await store.resolveEntities([])).toEqual([])
  })

  it('linkNodeEntities 幂等关联，entitiesOfNodes 批量反查', async () => {
    const record = await store.write({ scope: 'user', kind: 'fact', content: 'ken 负责 dsh-engram 插件' })
    const [ken, engram] = await store.resolveEntities([
      { name: 'ken', kind: 'person' },
      { name: 'dsh-engram', kind: 'project' },
    ])
    await store.linkNodeEntities(record.id, [ken!.id, engram!.id])
    // 重复关联不报错、不产生重复行。
    await store.linkNodeEntities(record.id, [ken!.id])
    const map = await store.entitiesOfNodes([record.id])
    const linked = map.get(record.id) ?? []
    expect(linked).toHaveLength(2)
    expect(linked.map(entity => entity.id).sort()).toEqual([ken!.id, engram!.id].sort())
  })

  it('listEntities kind/q 过滤，memoryCount 只数 active 记忆', async () => {
    const kept = await store.write({ scope: 'user', kind: 'fact', content: '活跃记忆' })
    const dropped = await store.write({ scope: 'user', kind: 'fact', content: '将被遗忘的记忆' })
    const [ken] = await store.resolveEntities([
      { name: 'ken', kind: 'person', aliases: ['阿肯'] },
      { name: 'postgres', kind: 'tool' },
    ])
    await store.linkNodeEntities(kept.id, [ken!.id])
    await store.linkNodeEntities(dropped.id, [ken!.id])
    await store.forget(dropped.id)
    // 全量：updated_at 倒序，关联计数只统计 active 记忆。
    const all = await store.listEntities({ limit: 10, offset: 0 })
    expect(all.total).toBe(2)
    const kenRow = all.items.find(item => item.entity.name === 'ken')!
    expect(kenRow.memoryCount).toBe(1)
    // kind 过滤。
    const people = await store.listEntities({ kind: 'person', limit: 10, offset: 0 })
    expect(people.total).toBe(1)
    expect(people.items[0]!.entity.name).toBe('ken')
    // q 命中别名（大小写不敏感子串）。
    const byAlias = await store.listEntities({ q: '阿肯', limit: 10, offset: 0 })
    expect(byAlias.total).toBe(1)
    expect(byAlias.items[0]!.entity.id).toBe(ken!.id)
  })

  it('entityDetail 返回实体与关联记忆（倒序、限量）；不存在返回 undefined', async () => {
    // 假时钟控制写入时刻：同毫秒写入时 created_at 相同，倒序无从区分。
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse('2026-09-01T10:00:00Z'))
    const first = await store.write({ scope: 'user', kind: 'fact', content: '第一条' })
    vi.setSystemTime(Date.parse('2026-09-01T10:05:00Z'))
    const second = await store.write({ scope: 'user', kind: 'fact', content: '第二条' })
    vi.useRealTimers()
    const [ken] = await store.resolveEntities([{ name: 'ken', kind: 'person' }])
    await store.linkNodeEntities(first.id, [ken!.id])
    await store.linkNodeEntities(second.id, [ken!.id])
    const detail = await store.entityDetail(ken!.id, 20)
    expect(detail?.entity.name).toBe('ken')
    expect(detail?.memories.map(record => record.content)).toEqual(['第二条', '第一条'])
    // memoryLimit 生效。
    expect((await store.entityDetail(ken!.id, 1))?.memories).toHaveLength(1)
    expect(await store.entityDetail('ent-missing' as never, 20)).toBeUndefined()
  })

  it('v9 旧库重开：迁移重建实体表且旧记忆完好', async () => {
    const record = await store.write({ scope: 'user', kind: 'fact', content: '迁移前已有的记忆' })
    const path = join(dir, 'user.db')
    await store.close()
    // 模拟 v9 旧库：降版本号并删掉 v10 才有的两张表。
    const raw = new DatabaseSync(path)
    raw.prepare("UPDATE meta SET value = '9' WHERE key = 'schema_version'").run()
    raw.prepare('DROP TABLE node_entities').run()
    raw.prepare('DROP TABLE entities').run()
    raw.close()
    // 重开实例交还外层 store，由 afterEach 统一关闭。
    store = await openEngramStore(path)
    expect((await store.get(record.id))?.content).toBe('迁移前已有的记忆')
    const [ken] = await store.resolveEntities([{ name: 'ken', kind: 'person' }])
    expect(ken?.name).toBe('ken')
  })
})

describe('事实链（schema v11）', () => {
  it('writeFacts 批量写入与字段回读；replaces 软失效链回填旧事实', async () => {
    const [ken] = await store.resolveEntities([{ name: 'ken', kind: 'person' }])
    // 假时钟控制 validAt/invalidAt：事实的时间窗完全由写入与取代时刻决定。
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse('2026-09-01T10:00:00Z'))
    const [old, plain] = await store.writeFacts([
      { entityId: ken!.id, content: 'ken 用 vim 编辑' },
      { entityId: ken!.id, content: 'ken 在杭州工作' },
    ])
    vi.setSystemTime(Date.parse('2026-09-10T10:00:00Z'))
    const [next] = await store.writeFacts([{ entityId: ken!.id, content: 'ken 改用 VSCode', replaces: old!.id }])
    vi.useRealTimers()
    // 新事实接棒：validAt 取写入时刻；取代关系不回指（回指记录在被取代方）。
    expect(next!.validAt).toBe(Date.parse('2026-09-10T10:00:00Z'))
    expect(next!.invalidAt).toBeNull()
    expect(next!.replacedBy).toBeNull()
    // 默认视图只看生效事实：被取代的旧事实退场，旁观事实不受影响。
    const current = await store.factsOfEntity({ entityId: ken!.id, limit: 10, offset: 0 })
    expect(current.total).toBe(2)
    expect(current.items.map(fact => fact.content)).toEqual(['ken 改用 VSCode', 'ken 在杭州工作'])
    // 全链视图：旧事实软失效回填 invalidAt/replacedBy，内容保留。
    const full = await store.factsOfEntity({ entityId: ken!.id, includeInvalid: true, limit: 10, offset: 0 })
    expect(full.total).toBe(3)
    const superseded = full.items.find(fact => fact.id === old!.id)!
    expect(superseded.content).toBe('ken 用 vim 编辑')
    expect(superseded.invalidAt).toBe(Date.parse('2026-09-10T10:00:00Z'))
    expect(superseded.replacedBy).toBe(next!.id)
    expect(full.items.find(fact => fact.id === plain!.id)?.invalidAt).toBeNull()
  })

  it('replaces 指向不存在的事实时按无取代写入', async () => {
    const [ken] = await store.resolveEntities([{ name: 'ken', kind: 'person' }])
    const [fact] = await store.writeFacts([
      { entityId: ken!.id, content: '悬空取代的新事实', replaces: 'fact-missing' as never },
    ])
    expect(fact?.invalidAt).toBeNull()
    expect(fact?.replacedBy).toBeNull()
    const full = await store.factsOfEntity({ entityId: ken!.id, includeInvalid: true, limit: 10, offset: 0 })
    expect(full.total).toBe(1)
  })

  it('factsOfEntity asOf 时点过滤与 limit/offset 分页', async () => {
    const [ken] = await store.resolveEntities([{ name: 'ken', kind: 'person' }])
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse('2026-03-01T10:00:00Z'))
    const [a] = await store.writeFacts([{ entityId: ken!.id, content: '三月的事实' }])
    vi.setSystemTime(Date.parse('2026-06-01T10:00:00Z'))
    const [b] = await store.writeFacts([{ entityId: ken!.id, content: '六月的事实', replaces: a!.id }])
    vi.setSystemTime(Date.parse('2026-09-01T10:00:00Z'))
    const [c] = await store.writeFacts([{ entityId: ken!.id, content: '九月的事实', replaces: b!.id }])
    vi.useRealTimers()
    // 时点 3 月：只有 a 已生效（b 6 月才开始有效）。
    const march = await store.factsOfEntity({
      entityId: ken!.id, asOf: Date.parse('2026-03-15T00:00:00Z'), limit: 10, offset: 0,
    })
    expect(march.total).toBe(1)
    expect(march.items[0]!.id).toBe(a!.id)
    // 时点 7 月：a 已失效（失效时刻早于时点），b 生效。
    const july = await store.factsOfEntity({
      entityId: ken!.id, asOf: Date.parse('2026-07-01T00:00:00Z'), limit: 10, offset: 0,
    })
    expect(july.total).toBe(1)
    expect(july.items[0]!.id).toBe(b!.id)
    // 不传 asOf：只看当前生效事实（c）。
    const now = await store.factsOfEntity({ entityId: ken!.id, limit: 10, offset: 0 })
    expect(now.total).toBe(1)
    expect(now.items[0]!.id).toBe(c!.id)
    // 全链分页：valid_at 倒序 [c, b, a]，跳过最新 1 条取 2 条。
    const page = await store.factsOfEntity({ entityId: ken!.id, includeInvalid: true, limit: 2, offset: 1 })
    expect(page.total).toBe(3)
    expect(page.items.map(fact => fact.id)).toEqual([b!.id, a!.id])
  })

  it('v10 旧库重开：迁移重建 facts 表且旧数据完好', async () => {
    const record = await store.write({ scope: 'user', kind: 'fact', content: '迁移前已有的记忆' })
    const path = join(dir, 'user.db')
    await store.close()
    // 模拟 v10 旧库：降版本号并删掉 v11 才有的 facts 表。
    const raw = new DatabaseSync(path)
    raw.prepare("UPDATE meta SET value = '10' WHERE key = 'schema_version'").run()
    raw.prepare('DROP TABLE facts').run()
    raw.close()
    // 重开实例交还外层 store，由 afterEach 统一关闭。
    store = await openEngramStore(path)
    expect((await store.get(record.id))?.content).toBe('迁移前已有的记忆')
    const [ken] = await store.resolveEntities([{ name: 'ken', kind: 'person' }])
    const [fact] = await store.writeFacts([{ entityId: ken!.id, content: '迁移后写入的事实' }])
    expect(fact?.content).toBe('迁移后写入的事实')
  })

  it('purge 连同事实表一起清空', async () => {
    const [ken] = await store.resolveEntities([{ name: 'ken', kind: 'person' }])
    await store.writeFacts([{ entityId: ken!.id, content: '将被清空的事实' }])
    await store.purge()
    const full = await store.factsOfEntity({ entityId: ken!.id, includeInvalid: true, limit: 10, offset: 0 })
    expect(full.total).toBe(0)
  })
})
