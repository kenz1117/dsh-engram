import { describe, expect, it } from 'vitest'
import {
  FIRST_INTERVAL_DAYS, INITIAL_EASE, MIN_EASE, SECOND_INTERVAL_DAYS, initialSchedule, isDue, nextSchedule,
} from '../src/review/sm2.ts'
import { KIND_ROOMS, ROOM_CAPACITY, assignSlot, type RoomOccupancy } from '../src/palace/slots.ts'
import { PLACARD_LOW_THRESHOLD, placardImprovementHint, scorePlacard } from '../src/imagery/score.ts'
import type { ReviewSchedule } from '../src/types.ts'

const DAY = 86_400_000
const NOW = 1_700_000_000_000

/** 构造调度态（缺省从 SM-2 初始态起步）。 */
const state = (patch: Partial<ReviewSchedule> = {}): ReviewSchedule =>
  ({ nextReviewAt: null, easeFactor: INITIAL_EASE, intervalDays: 0, reps: 0, ...patch })

describe('SM-2 间隔重复调度', () => {
  it('初始排期：明天到期，ease 2.5，间隔 0，reps 0', () => {
    const schedule = initialSchedule(NOW)
    expect(schedule.nextReviewAt).toBe(NOW + FIRST_INTERVAL_DAYS * DAY)
    expect(schedule.easeFactor).toBe(INITIAL_EASE)
    expect(schedule.intervalDays).toBe(0)
    expect(schedule.reps).toBe(0)
  })

  it('连续通过：间隔按 1 → 6 → round(prev × ease) 推进', () => {
    const first = nextSchedule(5, state(), NOW)
    expect(first.intervalDays).toBe(FIRST_INTERVAL_DAYS)
    expect(first.reps).toBe(1)
    const second = nextSchedule(5, first, NOW)
    expect(second.intervalDays).toBe(SECOND_INTERVAL_DAYS)
    expect(second.reps).toBe(2)
    // 第三次起按上一间隔 × ease（ease 每轮 5 分 +0.1）。
    const third = nextSchedule(5, second, NOW)
    expect(third.intervalDays).toBe(Math.round(SECOND_INTERVAL_DAYS * second.easeFactor))
    expect(third.reps).toBe(3)
    expect(third.nextReviewAt).toBe(NOW + third.intervalDays * DAY)
  })

  it('失败（grade < 3）重置为 1 天后、reps 清零，ease 照罚并受下限保护', () => {
    const mature = state({ intervalDays: 30, reps: 5, easeFactor: MIN_EASE })
    const reset = nextSchedule(1, mature, NOW)
    expect(reset.intervalDays).toBe(FIRST_INTERVAL_DAYS)
    expect(reset.reps).toBe(0)
    expect(reset.nextReviewAt).toBe(NOW + DAY)
    // ease 已在下限：罚后不得低于 MIN_EASE。
    expect(reset.easeFactor).toBe(MIN_EASE)
  })

  it('ease 更新公式：高分升、低分降，且不低于下限', () => {
    // grade 5：+0.1；grade 3：-0.14；grade 0：-0.8。
    expect(nextSchedule(5, state({ easeFactor: 2.5 }), NOW).easeFactor).toBeCloseTo(2.6, 5)
    expect(nextSchedule(3, state({ easeFactor: 2.5 }), NOW).easeFactor).toBeCloseTo(2.36, 5)
    expect(nextSchedule(0, state({ easeFactor: 2.5 }), NOW).easeFactor).toBeCloseTo(1.7, 5)
    // 起点 1.5 罚 0.8 得 0.7，被下限抬回 1.3。
    expect(nextSchedule(0, state({ easeFactor: 1.5 }), NOW).easeFactor).toBe(MIN_EASE)
    expect(nextSchedule(1, state({ easeFactor: 1.4 }), NOW).easeFactor).toBe(MIN_EASE)
  })

  it('到期判定：未排期永不到期，排期时刻到达即到期', () => {
    expect(isDue(state({ nextReviewAt: null }), NOW)).toBe(false)
    expect(isDue(state({ nextReviewAt: NOW }), NOW)).toBe(true)
    expect(isDue(state({ nextReviewAt: NOW + 1 }), NOW)).toBe(false)
  })
})

describe('排桩（地点法）', () => {
  it('kind 映射固定房间，序号从 1 起递增', () => {
    const first = assignSlot('fact', {})
    expect(first).toEqual({ slot: { room: KIND_ROOMS.fact, index: 1 }, openedNewRoom: false })
    const occupancy: Record<string, RoomOccupancy> = { [KIND_ROOMS.fact]: { count: 3, maxIndex: 3 } }
    expect(assignSlot('fact', occupancy).slot).toEqual({ room: KIND_ROOMS.fact, index: 4 })
  })

  it('满员（9）开「房名-2」，新房从 1 起', () => {
    const full: Record<string, RoomOccupancy> = { [KIND_ROOMS.decision]: { count: ROOM_CAPACITY, maxIndex: ROOM_CAPACITY } }
    const next = assignSlot('decision', full)
    expect(next.slot).toEqual({ room: `${KIND_ROOMS.decision}-2`, index: 1 })
    expect(next.openedNewRoom).toBe(true)
    // 二号房也满员：继续开三号房。
    const bothFull: Record<string, RoomOccupancy> = {
      [KIND_ROOMS.decision]: { count: ROOM_CAPACITY, maxIndex: ROOM_CAPACITY },
      [`${KIND_ROOMS.decision}-2`]: { count: ROOM_CAPACITY, maxIndex: ROOM_CAPACITY },
    }
    expect(assignSlot('decision', bothFull).slot).toEqual({ room: `${KIND_ROOMS.decision}-3`, index: 1 })
  })

  it('空桩不回收：序号取 maxIndex+1 而非 count+1', () => {
    // 曾有 5 桩，其中 2 桩被遗忘腾出（count=3），下一个仍应落在 6 号位。
    const occupancy: Record<string, RoomOccupancy> = { [KIND_ROOMS.episode]: { count: 3, maxIndex: 5 } }
    expect(assignSlot('episode', occupancy).slot).toEqual({ room: KIND_ROOMS.episode, index: 6 })
  })

  it('不同 kind 互不干扰，各自落在自己的房间', () => {
    const occupancy: Record<string, RoomOccupancy> = {
      [KIND_ROOMS.fact]: { count: 9, maxIndex: 9 },
      [KIND_ROOMS.skill]: { count: 2, maxIndex: 2 },
    }
    expect(assignSlot('fact', occupancy).slot).toEqual({ room: `${KIND_ROOMS.fact}-2`, index: 1 })
    expect(assignSlot('skill', occupancy).slot).toEqual({ room: KIND_ROOMS.skill, index: 3 })
  })
})

describe('门牌规则评分（唯一 · 差异化 · 带日期）', () => {
  const empty = { existingCaptions: [], roomCaptions: [] }

  it('三原则全中得满分：合规长度 + 全库唯一 + 日期锚点 + 同房不撞前缀', () => {
    expect(scorePlacard('2026-09 端口改为 4000', empty)).toBe(1)
  })

  it('与全库既有门牌重复：失去唯一性分', () => {
    const context = { existingCaptions: ['2026-09 端口改为 4000'], roomCaptions: [] }
    expect(scorePlacard('2026-09 端口改为 4000', context)).toBe(0.6)
  })

  it('与同房邻牌前 6 字重复：失去差异化分', () => {
    const context = { existingCaptions: [], roomCaptions: ['部署端口是 4000 的第一版说明'] }
    // 合规 + 唯一（0.4）+ 前缀撞车不加分 + 无日期锚点 = 0.4。
    expect(scorePlacard('部署端口是 5000 的第二版说明', context)).toBe(0.4)
  })

  it('长度不合规不计「有效」两分，但日期锚点仍计', () => {
    expect(scorePlacard('端口', empty)).toBe(0)
    expect(scorePlacard('长'.repeat(31), empty)).toBe(0)
    // 超长（41 字）但带日期锚点：只剩日期分。
    expect(scorePlacard(`2026-09-11 ${'长'.repeat(30)}`, empty)).toBe(0.3)
  })

  it('无门牌记 0 分；低分给出补挂建议', () => {
    expect(scorePlacard(null, empty)).toBe(0)
    expect(scorePlacard(undefined, empty)).toBe(0)
    expect(placardImprovementHint(0.3)).toContain('门牌不合规')
    expect(placardImprovementHint(PLACARD_LOW_THRESHOLD)).toBeNull()
    expect(placardImprovementHint(1)).toBeNull()
  })
})
