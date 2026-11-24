/**
 * 闭馆整理的调度判定：这一轮值不值得跑。
 *
 * 整理是每日巡检，不是每分钟巡检。上轮整理已经在 op_log 里记下了收尾时刻，
 * 之后没有内容变更就没有重复的必要——省下的不只是时间，还有一次全库比对
 * （#64：整理摆在开机窗口里会占住宿主主线程十几秒）。
 *
 * @module @kenz1117/dsh-engram/consolidation/schedule
 */

import type { EngramStore } from '../store/interface.ts'

/**
 * 算「内容变更」的操作名。
 *
 * 只收会改条目本身的写操作：写入、改写、遗忘、恢复、归档、导入、治理。
 * 检索曝光一类的读操作不算——读了库不等于内容变了，把它们算进来会让
 * 「没有变更」永远不成立，这道闸就形同虚设。
 */
export const CONSOLIDATION_WATCHED_OPS: readonly string[] = [
  'write', 'write-merge', 'update', 'superseded', 'forget', 'restore', 'decay', 'import', 'governance',
]

/**
 * 自上轮整理以来，库里有没有内容变更。
 *
 * 分界用 op_log 的 **seq**（自增主键），不用时间戳：整理自己写的那些行
 * （write-merge / superseded / decay）排在整理的汇总行之前，seq 更小；
 * 而同一毫秒里的外部写入与整理收尾，时间戳分不出先后，seq 分得出。
 *
 * 上轮整理的汇总行（op='consolidation'）就是分界点：它的 seq 之后出现的
 * 内容变更类操作，才算「这一轮有事可做」。
 * @param store - 打开的库。
 * @returns true = 有变更，值得整理；false = 没变更，可以跳过。
 */
export async function changedSinceLastConsolidation(store: EngramStore): Promise<boolean> {
  const seq = await store.latestAuditSeq('consolidation')
  if (seq === undefined) return true
  const counts = await store.countOpsSince(seq)
  return CONSOLIDATION_WATCHED_OPS.some(op => (counts[op] ?? 0) > 0)
}
