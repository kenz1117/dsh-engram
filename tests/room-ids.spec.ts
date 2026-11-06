/**
 * 房名归一化：0.8.12 及更早把**显示名**（「事实厅」）写进 slot_room，语言中立 id 启用后
 * 同一逻辑房会裂成两间——容量翻倍、巡游顺序错乱。这里手工构造 0.8.12 形态的库（中文房名 +
 * schema_version=12），验证打开时一次性归一化，且排桩接着原有房间续号而不是另起一间。
 *
 * 这组测试是评审阻断项 1 的回归护栏：它必须能在没有归一化时失败。
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { openEngramStore } from '../src/store/sqlite.ts'

let dir: string
let path: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'engram-room-'))
  path = join(dir, 'user.db')
})

/** 手工把库改回 0.8.12 形态：中文房名 + 版本号 12。 */
async function asLegacyPalace(room: (kind: string) => string): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite')
  const raw = new DatabaseSync(path)
  const rows = raw.prepare('SELECT id, kind FROM nodes WHERE slot_room IS NOT NULL').all() as unknown as { id: string, kind: string }[]
  const update = raw.prepare('UPDATE nodes SET slot_room = ? WHERE id = ?')
  for (const row of rows) update.run(room(row.kind), row.id)
  raw.prepare("UPDATE meta SET value = '12' WHERE key = 'schema_version'").run()
  raw.close()
}

describe('房名归一化（schema v12 → v13）', () => {
  it('老库的中文房名在打开时改写为 id，排桩续号而不裂房', async () => {
    const store = await openEngramStore(path)
    for (let i = 1; i <= 9; i += 1) await store.write({ scope: 'user', kind: 'fact', content: `老事实 ${i}` })
    await store.write({ scope: 'user', kind: 'decision', content: '老决策' })
    // 满员后扩建的那间也要连同后缀一起归一化。
    const expanded = await store.write({ scope: 'user', kind: 'skill', content: '老技法' })
    const before = await store.routeList()
    await store.close()

    const legacy = { fact: '事实厅', decision: '决策堂', skill: '技法坊-2' }
    await asLegacyPalace(kind => legacy[kind as keyof typeof legacy] ?? kind)

    const reopened = await openEngramStore(path)
    const rooms = await reopened.slotCountsByRoom()
    // 归一化本身：只剩 id，没有任何中文残留。
    expect(Object.keys(rooms).filter(name => name.startsWith('事实') || name.startsWith('决策') || name.startsWith('技法'))).toEqual([])
    expect(rooms.fact).toEqual({ count: 9, maxIndex: 9 })
    expect(rooms.decision).toEqual({ count: 1, maxIndex: 1 })
    expect(rooms['skill-2']).toEqual({ count: 1, maxIndex: 1 })

    // 巡游路线按节点 id 记录，房名改写不动顺序（此断言须在写入新条目之前——写入会 append）。
    expect((await reopened.routeList()).map(stop => String(stop.id))).toEqual(before.map(stop => String(stop.id)))

    // 关键断言：老房间算满，新条目开的是 fact-2，而不是在空的 fact 里从 1 号重新排。
    const fresh = await reopened.write({ scope: 'user', kind: 'fact', content: '归一化后写入' })
    expect(fresh.slot).toEqual({ room: 'fact-2', index: 1 })
    // 扩建房的前缀替换不吞后缀：skill-2 仍是原条目，没有被改成 skill。
    expect((await reopened.get(expanded.id))?.slot).toEqual({ room: 'skill-2', index: 1 })
    await reopened.close()

    const check = await import('node:sqlite').then(({ DatabaseSync }) => new DatabaseSync(path))
    expect((check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as unknown as { value: string }).value).toBe('15')
    check.close()
  })

  it('已是 id 的库零改动，且重复打开幂等', async () => {
    const store = await openEngramStore(path)
    const record = await store.write({ scope: 'user', kind: 'preference', content: '现代条目' })
    await store.close()

    const first = await openEngramStore(path)
    expect(await first.slotCountsByRoom()).toEqual({ preference: { count: 1, maxIndex: 1 } })
    await first.close()
    const second = await openEngramStore(path)
    expect((await second.get(record.id))?.slot).toEqual({ room: 'preference', index: 1 })
    expect(await second.slotCountsByRoom()).toEqual({ preference: { count: 1, maxIndex: 1 } })
    await second.close()
  })
})
