/**
 * 排桩：把记忆钉到宫殿的固定位置（地点法核心）。
 * 默认房间按 kind 映射；房间容量 9（7±2 工作记忆上限），满员自动开「<房名>-2」。
 * 桩位只增不改——宫殿的位置一旦固定就不搬家，物品移除（遗忘/归档）留下空桩。
 * @module @kenz1117/dsh-engram/palace/slots
 */

import type { EngramKind, Slot } from '../types.ts'

/** 房间容量：7±2 上限取 9——超过此数，人类（与模型）巡游单间的认知负荷陡增。 */
export const ROOM_CAPACITY = 9

/** kind → 默认房间名。固定映射，保证同主题记忆总是聚在同一间（同类巩固）。 */
export const KIND_ROOMS: Readonly<Record<EngramKind, string>> = {
  fact: '事实厅',
  preference: '偏好阁',
  decision: '决策堂',
  episode: '往事廊',
  skill: '技法坊',
}

/** 一个房间的占用状态（slotCountsByRoom 的行）。 */
export interface RoomOccupancy {
  /** 已占用桩位数（forgotten 除外——软删即刻腾位）。 */
  readonly count: number
  /** 当前最大桩位序号（含空桩，决定下一个分配的序号）。 */
  readonly maxIndex: number
}

/**
 * 为新条目分配桩位。
 * @param kind - 记忆种类（决定默认房间）。
 * @param occupancy - 各房间占用状态（store.slotCountsByRoom() 的快照）。
 * @returns 分配的桩位与是否开了新房（开新房时调用方应记 op_log 提醒人工命名/拆分）。
 */
export function assignSlot(
  kind: EngramKind,
  occupancy: Readonly<Record<string, RoomOccupancy>>,
): { slot: Slot; openedNewRoom: boolean } {
  const base = KIND_ROOMS[kind]
  // 找该 kind 最新的房间（base、base-2、base-3…）中第一个未满员的。
  for (let n = 1; ; n += 1) {
    const room = n === 1 ? base : `${base}-${n}`
    const state = occupancy[room]
    if (state === undefined) {
      // 房间不存在：n=1 是首次使用该 kind；n>1 是前一房满员后的自然扩建。
      return { slot: { room, index: 1 }, openedNewRoom: n > 1 }
    }
    if (state.count < ROOM_CAPACITY) {
      // 序号取 maxIndex+1 而非 count+1：forgotten 腾出的空桩不回收，保持位置语义稳定。
      return { slot: { room, index: state.maxIndex + 1 }, openedNewRoom: false }
    }
  }
}
