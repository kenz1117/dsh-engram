/**
 * 闭馆整理的调度判定（#64）：这一轮值不值得跑。
 *
 * 整理是每日巡检。上轮整理的 op_log 行里带 endedAt，之后没有内容变更就没有
 * 重复巡检的必要。这道闸必须严：把读操作算成变更，它就永远不成立。
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { changedSinceLastConsolidation } from '../src/consolidation/schedule.ts'
import { runConsolidation } from '../src/consolidation/run.ts'
import { openEngramStore } from '../src/store/sqlite.ts'
import type { EngramStore } from '../src/store/interface.ts'

let dir: string
let store: EngramStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'engram-sched-'))
  store = await openEngramStore(join(dir, 'user.db'))
})

afterEach(async () => {
  await store.close()
})

describe('闭馆整理调度判定', () => {
  it('没整理过 → 有变更（第一轮照跑）', async () => {
    expect(await changedSinceLastConsolidation(store)).toBe(true)
  })

  it('整理后没有写入 → 无变更（这一轮跳过）', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '一条记忆', importance: 0.5, confidence: 0.5 })
    await runConsolidation(store, Promise.resolve(undefined), { olderThanDays: 30, importanceBelow: 0.3 })
    expect(await changedSinceLastConsolidation(store)).toBe(false)
  })

  it('整理后有写入 → 有变更（这一轮照跑）', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '一条记忆', importance: 0.5, confidence: 0.5 })
    await runConsolidation(store, Promise.resolve(undefined), { olderThanDays: 30, importanceBelow: 0.3 })
    await store.write({ scope: 'user', kind: 'fact', content: '后来又记了一条', importance: 0.5, confidence: 0.5 })
    expect(await changedSinceLastConsolidation(store)).toBe(true)
  })

  it('整理后只有读操作 → 仍算无变更（读库不是改库）', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '一条记忆', importance: 0.5, confidence: 0.5 })
    await runConsolidation(store, Promise.resolve(undefined), { olderThanDays: 30, importanceBelow: 0.3 })
    // 检索会写 'search-exposure' 行（谁在什么时候被召回）：读操作不该触发整理。
    await store.search({ text: '一条记忆', scopes: ['user'], limit: 5 }, undefined)
    expect(await changedSinceLastConsolidation(store)).toBe(false)
  })

  it('分界是 seq 而不是时间戳：整理汇总行之后的写入才算变更', async () => {
    // 手写一行整理汇总（模拟面板手动整理或旧版写的行）→ 之后没有写入 = 无变更。
    await store.audit('consolidation', 'AUX', JSON.stringify({ scope: 'user', archived: 0, merged: 0, skipped: 0, tookMs: 1 }))
    expect(await changedSinceLastConsolidation(store)).toBe(false)
    // 汇总行之后的写入 → 有变更。
    await store.write({ scope: 'user', kind: 'fact', content: '汇总行之后写的', importance: 0.5, confidence: 0.5 })
    expect(await changedSinceLastConsolidation(store)).toBe(true)
  })
})
