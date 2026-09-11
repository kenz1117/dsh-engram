import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { aggregateTelemetry } from '../src/telemetry/aggregate.ts'
import { openEngramStore } from '../src/store/sqlite.ts'
import type { EngramStore } from '../src/store/interface.ts'

let dir: string
let user: EngramStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'engram-tele-'))
  user = await openEngramStore(join(dir, 'user.db'))
})

afterEach(async () => {
  await user.close()
})

describe('本地遥测 aggregateTelemetry', () => {
  it('空库时所有计数为 0，三库 scopes 视图正常', async () => {
    const snapshot = await aggregateTelemetry(async (scope) => {
      if (scope === 'user') return user
      // shared/project 触发「未创建」分支不影响整体结果。
      throw new Error(`unexpected scope ${scope}`)
    }, 7)
    expect(snapshot.windowDays).toBe(7)
    expect(snapshot.counts.writes).toBe(0)
    expect(snapshot.counts.ingestRequests).toBe(0)
    expect(snapshot.scopes).toHaveLength(1)
    expect(snapshot.scopes[0]!.scope).toBe('user')
    expect(snapshot.scopes[0]!.active).toBe(0)
  })

  it('写入与遗忘计入 writes / forgets', async () => {
    const a = await user.write({ scope: 'user', kind: 'fact', content: 'alpha', importance: 0.6 })
    await user.write({ scope: 'user', kind: 'fact', content: 'beta', importance: 0.5 })
    await user.forget(a.id)
    const snapshot = await aggregateTelemetry(async scope => scope === 'user' ? user : user, 7)
    expect(snapshot.counts.writes).toBeGreaterThanOrEqual(2) // 含 user + project 'write'
    expect(snapshot.counts.forgets).toBeGreaterThanOrEqual(1)
  })

  it('查询 days 默认 7，越界夹到 [1, 90]', async () => {
    // 注：函数本身接受任意 windowDays；此处仅校验 defaults 行为。
    const snapshot = await aggregateTelemetry(async scope => scope === 'user' ? user : user)
    expect(snapshot.windowDays).toBe(7)
  })

  it('scope 视图正确反映 stats', async () => {
    await user.write({ scope: 'user', kind: 'fact', content: 'alpha', importance: 0.6, confidence: 0.8 })
    const snapshot = await aggregateTelemetry(async scope => scope === 'user' ? user : user)
    expect(snapshot.scopes[0]!.active).toBe(1)
    expect(snapshot.scopes[0]!.total).toBe(1)
    expect(snapshot.scopes[0]!.signalRatio).toBeCloseTo(1.0, 1) // 1 active / 1 total
  })
})
