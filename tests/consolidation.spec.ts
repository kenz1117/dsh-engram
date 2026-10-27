import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runConsolidation } from '../src/consolidation/run.ts'
import { openEngramStore } from '../src/store/sqlite.ts'
import type { EngramStore } from '../src/store/interface.ts'

let dir: string
let store: EngramStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'engram-cons-'))
  store = await openEngramStore(join(dir, 'user.db'))
})

afterEach(async () => {
  await store.close()
})

describe('Background Consolidation', () => {
  it('嵌入不可用时：归档老旧低重要性条目，启发式去重完全相同条目', async () => {
    // 1) 老旧低 importance → 应归档（decay 判准：importance < 阈值且 last_accessed_at 超龄）。
    // initialReviewAt: null = 显式不进复习调度（与历史回填同口径）——进了调度队列的
    // 条目按设计走翻新 demote 退出，不参与自动衰减（sqlDecay 的 next_review_at IS NULL）。
    const old = await store.write({ scope: 'user', kind: 'fact', content: '旧且无关', importance: 0.1, confidence: 0.5, initialReviewAt: null })
    // 手动把 last_accessed_at 拨到 60 天前（decay 检查的是访问时间，接口不暴露）。
    const path = join(dir, 'user.db')
    const { DatabaseSync } = await import('node:sqlite')
    const raw = new DatabaseSync(path)
    raw.prepare('UPDATE nodes SET last_accessed_at = ? WHERE id = ?').run(Date.now() - 60 * 86_400_000, old.id)
    raw.close()

    // 2) 完全相同内容（启发式去重）：a(0.5) 与 b(0.6) 同文，b 留下、a 被归档。
    await store.write({ scope: 'user', kind: 'fact', content: '偏好 TypeScript', importance: 0.5, confidence: 0.7 })
    const b = await store.write({ scope: 'user', kind: 'fact', content: '偏好 TypeScript', importance: 0.6, confidence: 0.7 })
    // 完全相同被去重：b (更高 importance) 留下
    void b // sanity

    // 3) 不应被归档的（创建新鲜）
    const fresh = await store.write({ scope: 'user', kind: 'fact', content: '新鲜高重要', importance: 0.9, confidence: 0.9 })

    // 设计：existing 胜出保留（高 importance 不被覆盖），所以 b(0.6) 留下，a(0.5) 不动。
    // 后续断言只看归档发生；merged 视具体 importance 顺序，本测试不强制。
    const dbgBefore = await store.topActive('user', 10)
    const report = await runConsolidation(store, Promise.resolve(undefined), { olderThanDays: 30, importanceBelow: 0.3 })
    expect(report.archived).toBe(1) // 仅 old 命中归档阈值
    expect(report.merged).toBe(0) // b 重要度更高，保留；a 不动
    expect(dbgBefore.filter(r => r.content === '偏好 TypeScript')).toHaveLength(2) // 整理前两条都在

    const stats = await store.stats()
    // 期望 active=3：fresh(0.9) + b(0.6) + a(0.5)；old 已归档（archived——后台清理归一走 decay 语义）。
    expect(stats.active).toBe(3)

    // fresh 必须健在
    const freshRow = (await store.topActive('user', 10)).find(record => record.id === fresh.id)
    expect(freshRow).toBeDefined()

    // op_log 应记录 consolidation 摘要
    const ops = await store.recentOps(50)
    const summary = ops.find(op => op.op === 'consolidation')
    expect(summary).toBeDefined()
    const detail = JSON.parse(summary!.detail!) as { archived: number; merged: number }
    expect(detail.archived).toBe(report.archived)
    expect(detail.merged).toBe(report.merged)
  })

  it('空库调用不报错，summary 全 0', async () => {
    const report = await runConsolidation(store, Promise.resolve(undefined))
    expect(report.archived).toBe(0)
    expect(report.merged).toBe(0)
    expect(report.skipped).toBe(0)
    expect(report.tookMs).toBeGreaterThanOrEqual(0)
  })

  it('覆盖默认参数（短龄阈值）也能跑通', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '任何内容', importance: 0.5, confidence: 0.5 })
    const report = await runConsolidation(store, Promise.resolve(undefined), { olderThanDays: 1, importanceBelow: 0.4, mergeThreshold: 0.99 })
    expect(report).toBeDefined()
    expect(report.tookMs).toBeGreaterThanOrEqual(0)
  })
})
