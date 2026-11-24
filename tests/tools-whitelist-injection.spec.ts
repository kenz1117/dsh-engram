/**
 * 工具白名单对「注入给模型的文字」的收敛（#65）。
 *
 * 白名单之外的工具对外不存在——不注册，也**不被点名**。否则 agent 会被叫去调一个
 * 不存在的工具：画像页脚说「用 engram_search 召回」，可检索工具根本没注册。
 */

import { describe, expect, it } from 'vitest'
import { renderProfileDetailed } from '../src/index.ts'
import { buildAssessReminder } from '../src/retrieve/evidence.ts'
import { buildSelectionRationale } from '../src/selection-rationale.ts'
import { toolAvailability } from '../src/tools/names.ts'
import type { MemoryRecord } from '../src/types.ts'

const record = (id: string, kind: string, content: string) => ({ id, kind, content })
const memory = (id: string): MemoryRecord => ({
  id: id as MemoryRecord['id'],
  memoryId: id as MemoryRecord['memoryId'],
  scope: 'user',
  kind: 'fact',
  content: '一条记忆',
  importance: 0.5,
  confidence: 0.5,
  status: 'active',
  createdAt: Date.now(),
  lastAccessedAt: Date.now(),
  accessCount: 0,
} as unknown as MemoryRecord)

describe('白名单裁剪注入文本（#65）', () => {
  it('画像页脚：少了哪个工具就换一句话，两个都没有就不带页脚', () => {
    const records = [record('id-1', 'fact', '一条记忆')]
    // 默认（全开）：两句话都在。
    const full = renderProfileDetailed(records, 1024, 'en').text
    expect(full).toContain('engram_search')
    expect(full).toContain('engram_save')

    // 只有检索：只留检索那半句。
    const searchOnly = renderProfileDetailed(records, 1024, 'en', undefined, toolAvailability(['engram_search'])).text
    expect(searchOnly).toContain('engram_search')
    expect(searchOnly).not.toContain('engram_save')

    // 只有保存：只留保存那半句。
    const saveOnly = renderProfileDetailed(records, 1024, 'en', undefined, toolAvailability(['engram_save'])).text
    expect(saveOnly).toContain('engram_save')
    expect(saveOnly).not.toContain('engram_search')

    // 都没有：没有页脚（正文仍在）。
    const bare = renderProfileDetailed(records, 1024, 'en', undefined, toolAvailability([])).text
    expect(bare).not.toContain('engram_search')
    expect(bare).not.toContain('engram_save')
    expect(bare).toContain('一条记忆')
  })

  it('末尾计数行：没有检索工具时不再叫 agent 去检索', () => {
    const many = Array.from({ length: 40 }, (_, index) => record(`id-${index}`, 'fact', '长'.repeat(300)))
    const budget = 60
    const withSearch = renderProfileDetailed(many, budget, 'en').text
    expect(withSearch).toContain('use engram_search')
    const withoutSearch = renderProfileDetailed(many, budget, 'en', undefined, toolAvailability(['engram_save'])).text
    expect(withoutSearch).not.toContain('use engram_search')
  })

  it('证据门提醒：没有判定工具时整条提醒不注入', () => {
    expect(buildAssessReminder(1, 0, toolAvailability(undefined))).toContain('engram_assess')
    expect(buildAssessReminder(1, 0, toolAvailability(['engram_search']))).toBeUndefined()
  })

  it('证据门提醒的连续不足建议：没有检索/时间线工具时只问用户', () => {
    // 检索与时间线都在：建议里点名它们。
    const full = buildAssessReminder(1, 3, toolAvailability(['engram_assess', 'engram_search', 'engram_timeline']))
    expect(full).toContain('engram_search')
    expect(full).toContain('engram_timeline')
    // 都没有：只问用户。
    const bare = buildAssessReminder(1, 3, toolAvailability(['engram_assess', 'engram_report']))
    expect(bare).not.toContain('engram_search')
    expect(bare).not.toContain('engram_timeline')
    expect(bare).toContain('ask the user')
  })

  it('归因页脚：没有反馈工具时不提反馈', () => {
    const withReport = buildSelectionRationale([memory('id-1')], toolAvailability(undefined))
    expect(withReport).toContain('engram_report')
    const withoutReport = buildSelectionRationale([memory('id-1')], toolAvailability(['engram_save']))
    expect(withoutReport).not.toContain('engram_report')
    expect(withoutReport).toContain('</engram_selection_rationale>')
  })
})
