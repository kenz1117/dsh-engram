import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { evaluateEpisodeTimeline, evaluateRetrieval } from '../src/evaluation/recall.ts'
import type { RetrievalCase } from '../src/evaluation/recall.ts'
import { openEngramStore } from '../src/store/sqlite.ts'
import type { EngramStore } from '../src/store/interface.ts'

let dir: string
let store: EngramStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'engram-eval-'))
  store = await openEngramStore(join(dir, 'user.db'))
})

afterEach(async () => {
  await store.close()
  await rm(dir, { recursive: true, force: true })
})

describe('local memory evaluation baseline', () => {
  it('retrieval recall, knowledge update, abstention and provenance are measurable', async () => {
    const preference = await store.write({
      scope: 'user',
      kind: 'preference',
      content: '用户偏好：优先使用命令行和键盘驱动的开发流程',
    })
    const project = await store.write({
      scope: 'user',
      kind: 'fact',
      content: '项目事实：dsh-engram 使用 SQLite 存储长期记忆',
    })
    const oldFramework = await store.write({
      scope: 'user',
      kind: 'fact',
      content: '项目事实：测试框架最初使用 Jest',
    })
    const newFramework = await store.update({
      id: oldFramework.id,
      scope: 'user',
      kind: 'fact',
      content: '项目事实：测试框架改为 Vitest',
    })

    // 干扰语料：验证排序不只靠“库里有几个词”。
    for (let index = 0; index < 12; index += 1) {
      await store.write({
        scope: 'user',
        kind: 'fact',
        content: `干扰记忆 ${index}：会议纪要、发布清单和临时调试笔记`,
      })
    }

    const cases: RetrievalCase[] = [
      { caseId: 'preference', ability: 'recall', query: '命令行 键盘 偏好', relevantMemoryIds: [preference.memoryId] },
      { caseId: 'project', ability: 'recall', query: 'SQLite 存储 长期记忆', relevantMemoryIds: [project.memoryId] },
      { caseId: 'knowledge-update', ability: 'knowledge-update', query: '测试框架 Vitest', relevantMemoryIds: [newFramework.memoryId] },
      { caseId: 'abstention', ability: 'abstention', query: '米其林餐厅推荐' },
    ]
    const report = await evaluateRetrieval(store, cases, { k: 5, abstainScoreBelow: 0.05 })

    expect(report.relevantCases).toBe(3)
    expect(report.abstentionCases).toBe(1)
    expect(report.recallAtK).toBe(1)
    expect(report.hitAtK).toBe(1)
    expect(report.mrr).toBe(1)
    expect(report.abstentionAccuracy).toBe(1)

    const updateCase = report.cases.find(result => result.caseId === 'knowledge-update')
    expect(updateCase?.retrieved[0]?.memoryId).toBe(newFramework.memoryId)
    expect(updateCase?.retrieved[0]?.revisionId).toBe(newFramework.id)
    expect(await store.get(newFramework.id)).toMatchObject({ content: '项目事实：测试框架改为 Vitest' })
    // 每个 retrieved 都带稳定身份 + revision + 分数 + 通道，作为 provenance 基线。
    expect(report.provenanceComplete).toBe(cases.length)
  })

  it('episode timeline keeps session filtering, chronology and recall', async () => {
    const deploy = await store.write({
      scope: 'user',
      kind: 'episode',
      content: '部署事故：修复 GitHub Actions 凭据过期',
      sourceSessionId: 'sess-deploy',
      sourceRound: 2,
      initialReviewAt: null,
    })
    await store.write({
      scope: 'user',
      kind: 'episode',
      content: '无关会话：整理桌面文件清单',
      sourceSessionId: 'sess-desktop',
      sourceRound: 1,
      initialReviewAt: null,
    })

    const report = await evaluateEpisodeTimeline(store, [
      { caseId: 'deploy-session', sessionId: 'sess-deploy', expectedMemoryIds: [deploy.id], k: 5 },
    ])
    expect(report.recallAtK).toBe(1)
    expect(report.hitAtK).toBe(1)
    expect(report.mrr).toBe(1)
    expect(report.chronological).toBe(true)
  })

  it('injection replay metadata preserves exact packet and stable memory ids', async () => {
    const memory = await store.write({
      scope: 'user',
      kind: 'fact',
      content: '回放事实：注入快照必须逐字一致',
    })
    const packet = '<engram_memory_context>回放事实：注入快照必须逐字一致</engram_memory_context>'
    const saved = await store.recordInjection({
      sessionId: 'sess-replay',
      packetHash: 'a'.repeat(64),
      packet,
      memoryIds: [memory.memoryId],
      hasCurated: false,
      compactionCount: 0,
    })

    expect((await store.getInjection(saved.id))?.packet).toBe(packet)
    expect((await store.listInjections({ sessionId: 'sess-replay' }))[0]?.memoryIds).toEqual([memory.memoryId])
  })
})
