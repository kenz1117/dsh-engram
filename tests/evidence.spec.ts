import { describe, expect, it } from 'vitest'
import {
  buildAssessReminder, EvidenceBatches, INSUFFICIENT_HINT_THRESHOLD, MAX_BATCHES_PER_SESSION,
  MAX_EVIDENCE_REFS, MAX_MISSING_CHARS, assessEvidence, evidenceRefOf, isNextStrategy,
} from '../src/retrieve/evidence.ts'
import type { EvidenceBatch } from '../src/retrieve/evidence.ts'

/** 构造批次（ref 集合即本次检索输出的证据清单）。 */
const batch = (...refs: string[]): EvidenceBatch => ({ batchId: 'batch-1', refs: new Set(refs), createdAt: 0 })

describe('evidenceRefOf', () => {
  it('已排桩用「scope/房间#桩位」，未排桩用「scope/#id 前 8 位」', () => {
    expect(evidenceRefOf('user', 'abcdefgh1234', { room: 'episode', index: 3 })).toBe('user/episode#3')
    expect(evidenceRefOf('project', 'abcdefgh1234', undefined)).toBe('project/#abcdefgh')
  })
})

describe('assessEvidence 强制规则', () => {
  it('声称充足 + 有效证据 + answer → 判为充足且未改写', () => {
    const verdict = assessEvidence(batch('user/fact#1', 'user/episode#2'), {
      sufficient: true,
      evidenceRefs: ['user/fact#1'],
      missing: '',
      nextStrategy: 'answer',
    })
    expect(verdict.sufficient).toBe(true)
    expect(verdict.evidenceRefs).toEqual(['user/fact#1'])
    expect(verdict.nextStrategy).toBe('answer')
    expect(verdict.forced).toBe(false)
  })

  it('声称充足却拿不出证据 → 判为不足并把策略改回检索', () => {
    const verdict = assessEvidence(batch('user/fact#1'), {
      sufficient: true,
      evidenceRefs: [],
      missing: '缺少项目约定',
      nextStrategy: 'answer',
    })
    expect(verdict.sufficient).toBe(false)
    expect(verdict.nextStrategy).toBe('search_keyword')
    expect(verdict.forced).toBe(true)
  })

  it('部分 ref 不属于本批次 → 记入 rejected，有效证据仍可用', () => {
    const verdict = assessEvidence(batch('user/fact#1'), {
      sufficient: true,
      evidenceRefs: ['user/fact#1', 'user/fact#99'],
      missing: '',
      nextStrategy: 'answer',
    })
    expect(verdict.evidenceRefs).toEqual(['user/fact#1'])
    expect(verdict.rejectedRefs).toEqual(['user/fact#99'])
    expect(verdict.sufficient).toBe(true)
  })

  it('全部 ref 不属于本批次 → 判为不足，策略改回检索', () => {
    const verdict = assessEvidence(batch('user/fact#1'), {
      sufficient: true,
      evidenceRefs: ['project/episode#9'],
      missing: '',
      nextStrategy: 'answer',
    })
    expect(verdict.sufficient).toBe(false)
    expect(verdict.evidenceRefs).toEqual([])
    expect(verdict.rejectedRefs).toEqual(['project/episode#9'])
    expect(verdict.nextStrategy).toBe('search_keyword')
  })

  it('声称不充足却选择作答 → 改写为继续检索', () => {
    const verdict = assessEvidence(batch('user/fact#1'), {
      sufficient: false,
      evidenceRefs: ['user/fact#1'],
      missing: '缺少时间',
      nextStrategy: 'answer',
    })
    expect(verdict.sufficient).toBe(false)
    expect(verdict.nextStrategy).toBe('search_keyword')
    expect(verdict.forced).toBe(true)
  })

  it('声称不足并给出非作答策略 → 尊重模型策略且不算改写', () => {
    const verdict = assessEvidence(batch(), {
      sufficient: false,
      evidenceRefs: [],
      missing: '缺少用户的部署环境',
      nextStrategy: 'ask_user',
    })
    expect(verdict.nextStrategy).toBe('ask_user')
    expect(verdict.forced).toBe(false)
  })

  it('非法策略 → 回退 search_keyword 并标记强制', () => {
    const verdict = assessEvidence(batch(), {
      sufficient: false,
      evidenceRefs: [],
      missing: '',
      nextStrategy: 'do-something',
    })
    expect(verdict.nextStrategy).toBe('search_keyword')
    expect(verdict.requestedStrategy).toBe('do-something')
    expect(verdict.forced).toBe(true)
  })

  it('证据超过上限：只保留前 8 条，其余进 droppedRefs', () => {
    const refs = Array.from({ length: MAX_EVIDENCE_REFS + 2 }, (_, index) => `user/fact#${String(index + 1)}`)
    const verdict = assessEvidence(batch(...refs), {
      sufficient: true,
      evidenceRefs: refs,
      missing: '',
      nextStrategy: 'answer',
    })
    expect(verdict.evidenceRefs).toHaveLength(MAX_EVIDENCE_REFS)
    expect(verdict.droppedRefs).toEqual([`user/fact#${String(MAX_EVIDENCE_REFS + 1)}`, `user/fact#${String(MAX_EVIDENCE_REFS + 2)}`])
  })

  it('缺口描述超长截断并标记，重复与空白 ref 去重', () => {
    const verdict = assessEvidence(batch('user/fact#1'), {
      sufficient: true,
      evidenceRefs: ['user/fact#1', ' user/fact#1 ', ''],
      missing: '长'.repeat(MAX_MISSING_CHARS + 10),
      nextStrategy: 'answer',
    })
    expect(verdict.evidenceRefs).toEqual(['user/fact#1'])
    expect(verdict.missingTruncated).toBe(true)
    expect(verdict.missing).toHaveLength(MAX_MISSING_CHARS + 1)
  })
})

describe('EvidenceBatches 注册表', () => {
  it('批次 id 单调递增，按会话隔离', () => {
    const registry = new EvidenceBatches()
    const first = registry.register('sess-a', ['user/fact#1'])
    const second = registry.register('sess-b', ['user/fact#2'])
    expect(first.batchId).toBe('batch-1')
    expect(second.batchId).toBe('batch-2')
    expect(registry.get('sess-a', 'batch-1')?.refs.has('user/fact#1')).toBe(true)
    expect(registry.get('sess-b', 'batch-1')).toBeUndefined()
  })

  it('超出每会话上限时淘汰最旧批次', () => {
    const registry = new EvidenceBatches()
    for (let index = 0; index <= MAX_BATCHES_PER_SESSION; index += 1) {
      registry.register('sess-a', ['user/fact#1'])
    }
    expect(registry.get('sess-a', 'batch-1')).toBeUndefined()
    expect(registry.get('sess-a', `batch-${String(MAX_BATCHES_PER_SESSION + 1)}`)).toBeDefined()
  })

  it('clear 释放该会话的全部批次', () => {
    const registry = new EvidenceBatches()
    registry.register('sess-a', ['user/fact#1'])
    registry.clear('sess-a')
    expect(registry.get('sess-a', 'batch-1')).toBeUndefined()
  })
})

describe('EvidenceBatches 判定登记与连续不足计数', () => {
  /** 充足判定（有效证据 + answer 策略，代码不强制改写）。 */
  const sufficientVerdict = (ref: string) => assessEvidence(batch(ref), {
    sufficient: true, evidenceRefs: [ref], missing: '', nextStrategy: 'answer',
  })
  /** 不足判定（声称充足却拿不出证据，被强制改回检索）。 */
  const insufficientVerdict = (ref: string) => assessEvidence(batch(ref), {
    sufficient: true, evidenceRefs: [], missing: '缺', nextStrategy: 'answer',
  })

  it('recordVerdict 登记判定，pendingBatches 只列未判定批次（注册顺序）', () => {
    const registry = new EvidenceBatches()
    const first = registry.register('sess', ['user/fact#1'])
    const second = registry.register('sess', ['user/fact#2'])
    expect(registry.pendingBatches('sess').map(item => item.batchId)).toEqual(['batch-1', 'batch-2'])
    registry.recordVerdict('sess', first.batchId, sufficientVerdict('user/fact#1'))
    expect(registry.get('sess', first.batchId)?.verdict?.sufficient).toBe(true)
    expect(registry.pendingBatches('sess').map(item => item.batchId)).toEqual([second.batchId])
  })

  it('recordVerdict 对不存在批次是 no-op（会话隔离或已淘汰）', () => {
    const registry = new EvidenceBatches()
    registry.register('sess-a', ['user/fact#1'])
    expect(() => registry.recordVerdict('sess-b', 'batch-1', sufficientVerdict('user/fact#1'))).not.toThrow()
    expect(registry.get('sess-b', 'batch-1')).toBeUndefined()
    expect(registry.insufficientStreak('sess-b')).toBe(0)
  })

  it('insufficientStreak 连续不足累加，sufficient 清零，未判定不影响计数', () => {
    const registry = new EvidenceBatches()
    registry.register('sess', ['user/fact#1'])
    expect(registry.insufficientStreak('sess')).toBe(0)
    registry.recordVerdict('sess', 'batch-1', insufficientVerdict('user/fact#1'))
    expect(registry.insufficientStreak('sess')).toBe(1)
    registry.register('sess', ['user/fact#2'])
    registry.recordVerdict('sess', 'batch-2', insufficientVerdict('user/fact#2'))
    expect(registry.insufficientStreak('sess')).toBe(2)
    registry.register('sess', ['user/fact#3'])
    registry.recordVerdict('sess', 'batch-3', sufficientVerdict('user/fact#3'))
    expect(registry.insufficientStreak('sess')).toBe(0)
  })

  it('clear 同时清批次与不足计数', () => {
    const registry = new EvidenceBatches()
    registry.register('sess', ['user/fact#1'])
    registry.recordVerdict('sess', 'batch-1', insufficientVerdict('user/fact#1'))
    registry.clear('sess')
    expect(registry.pendingBatches('sess')).toEqual([])
    expect(registry.insufficientStreak('sess')).toBe(0)
  })
})

describe('buildAssessReminder', () => {
  it('无待判定批次返回 undefined（不需要提醒）', () => {
    expect(buildAssessReminder(0, 3)).toBeUndefined()
  })

  it('有待判定时给基础提醒；连续不足达到阈值后附换检索方式建议', () => {
    const base = buildAssessReminder(1, 0)
    expect(base).toContain('1 search batch(es)')
    expect(base).toContain('engram_assess')
    expect(base).not.toContain('insufficient')

    const escalated = buildAssessReminder(2, INSUFFICIENT_HINT_THRESHOLD)
    expect(escalated).toContain('2 search batch(es)')
    expect(escalated).toContain('try a different room')
  })
})

describe('isNextStrategy', () => {
  it('识别合法策略，拒绝未知值', () => {
    expect(isNextStrategy('answer')).toBe(true)
    expect(isNextStrategy('search_room')).toBe(true)
    expect(isNextStrategy('answer ')).toBe(false)
  })
})
