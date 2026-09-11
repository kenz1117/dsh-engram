/**
 * SM-2 简版间隔重复调度：SuperMemo 2 算法的最小实现。
 * 通过（grade ≥ 3）间隔按 1 → 6 → round(prev × ease) 推进；失败（< 3）重置为 1 天、
 * 连续通过次数清零；ease 下限 1.3 防恶性收缩。纯函数，无副作用，便于单测。
 * @module @kenz1117/dsh-engram/review/sm2
 */

import type { ReviewGrade, ReviewSchedule } from '../types.ts'

/** ease 系数下限（SM-2 标准值）：低于此值记忆会陷入过密复习。 */
export const MIN_EASE = 1.3
/** 初始 ease 系数（SM-2 标准值）。 */
export const INITIAL_EASE = 2.5
/** 首次通过的间隔（天）。 */
export const FIRST_INTERVAL_DAYS = 1
/** 第二次通过的间隔（天）。 */
export const SECOND_INTERVAL_DAYS = 6
const DAY_MS = 86_400_000

/** 一条从未排期记忆的初始调度：明天到期，ease/间隔/reps 从零起。 */
export function initialSchedule(now: number): ReviewSchedule {
  return { nextReviewAt: now + FIRST_INTERVAL_DAYS * DAY_MS, easeFactor: INITIAL_EASE, intervalDays: 0, reps: 0 }
}

/**
 * 按回忆质量推进调度。
 * @param grade - 回忆质量 0-5（0/1 完全遗忘，2 模糊错误，3 勉强，4 正确有迟疑，5 完美）。
 * @param state - 当前调度状态。
 * @param now - 答题时刻（epoch 毫秒）。
 * @returns 新调度状态（不修改入参）。
 */
export function nextSchedule(grade: ReviewGrade, state: ReviewSchedule, now: number): ReviewSchedule {
  if (grade < 3) {
    // 失败：回到 1 天后重练，ease 照罚（SM-2 原版语义），reps 清零。
    const ease = Math.max(MIN_EASE, state.easeFactor + (0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02)))
    return {
      nextReviewAt: now + FIRST_INTERVAL_DAYS * DAY_MS,
      easeFactor: Math.round(ease * 100) / 100,
      intervalDays: FIRST_INTERVAL_DAYS,
      reps: 0,
    }
  }
  const reps = state.reps + 1
  const intervalDays = reps === 1
    ? FIRST_INTERVAL_DAYS
    : reps === 2
      ? SECOND_INTERVAL_DAYS
      : Math.max(1, Math.round(state.intervalDays * state.easeFactor))
  const ease = Math.max(MIN_EASE, state.easeFactor + (0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02)))
  return {
    nextReviewAt: now + intervalDays * DAY_MS,
    easeFactor: Math.round(ease * 100) / 100,
    intervalDays,
    reps,
  }
}

/** 到期判定：nextReviewAt ≤ now 且已排期。 */
export function isDue(schedule: ReviewSchedule, now: number): boolean {
  return schedule.nextReviewAt !== null && schedule.nextReviewAt <= now
}
