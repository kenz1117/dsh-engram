/**
 * 闭馆整理（Background Consolidation）：会话结束或定时触发时的后台巡检，
 * 把长期未访问且重要性低的 active 条目归档（清楼）；同 kind / 高相似度的条目合并
 * （新旧 supersedes 链保留 + 旧条目归档）。
 *
 * 实现：单进程内 setImmediate 分片执行（避免阻塞宿主）。向量优先取库内存量
 * （nodes.embedding），缺向量的条目才嵌入；没有向量可比时退回正文启发式去重。
 * 按余弦相似度 ≥ 0.92 合并（同维才可比）。所有动作写 op_log，便于面板审计。
 *
 * @module @kenz1117/dsh-engram/consolidation/run
 */

import type { EmbedderHandle } from '../embedder/interface.ts'
import type { EngramStore } from '../store/interface.ts'
import type { MemoryRecord } from '../types.ts'
// 余弦相似度：与 store 检索共享 src/vec.ts 的单一实现（维度不匹配告警一次）。
import { cosine } from '../vec.ts'

/** 单条整理动作（写入 op_log 的统一标记）。 */
const CONSOLIDATION_OP = 'consolidation'

/** 闭馆归档参数：默认 30 天未访问 + importance < 0.3。 */
export interface ConsolidateOptions {
  readonly olderThanDays?: number
  readonly importanceBelow?: number
  /** 合并相似度阈值（0-1），嵌入可用时按 cosine 触发。 */
  readonly mergeThreshold?: number
  /** 整理作用域；未传 = 'user'（保持向后兼容）。 */
  readonly scope?: 'user' | 'project' | 'shared'
  /**
   * 限定只对指定 ids 做合并阶段；未传 = 全库扫（向后兼容）。
   * 仅控制阶段 2（合并相似）；阶段 1（闭馆归档）始终全库执行。
   * candidate 之外的同 kind 同相似条目也会被并入（避免漏并）。
   */
  readonly mergeCandidateIds?: readonly string[]
}

/** 单次整理结果摘要（写入 op_log 并返回给调用方）。 */
export interface ConsolidateReport {
  readonly archived: number
  readonly merged: number
  readonly skipped: number
  readonly tookMs: number
}

/** 默认参数。 */
const DEFAULTS: Required<Omit<ConsolidateOptions, 'scope' | 'mergeCandidateIds'>> = {
  olderThanDays: 30,
  importanceBelow: 0.3,
  mergeThreshold: 0.92,
}

/** 合并阶段的工作集封顶：超出交给归档/衰减处置（审计 N12——两两比对必须设界）。 */
const CONSOLIDATION_MAX_RECORDS = 500
/** 批式嵌入的块大小（一次 ONNX 前向的条数）。 */
const EMBED_BATCH = 32

/** 闭馆整理主函数：纯异步，不抛错（失败仅记日志 / 落 pending）。 */
export async function runConsolidation(
  store: EngramStore,
  embedder: EmbedderHandle,
  opts: ConsolidateOptions = {},
): Promise<ConsolidateReport> {
  const start = Date.now()
  const options = { ...DEFAULTS, ...opts }
  const scope: 'user' | 'project' | 'shared' = options.scope ?? 'user'
  let archived = 0
  let merged = 0
  let skipped = 0

  // 阶段 1：闭馆归档（清楼）——走 store.decay 的 archived 语义（SQL 全表，不整池加载）。
  // 审计 N12：此前这里逐条 forget——forgotten 是遗忘墓碑桶（喂「遗忘审计」视图），
  // 而每日衰减任务把同一套 30 天/0.3 判准归档进 archived。同_criteria 两种状态语义 =
  // 面板的归档视图与遗忘审计各看到一半。统一为归档后各归其位：forget 只留给用户的
  // 主动遗忘（带墓碑），后台清理一律 archived。
  try {
    archived = await store.decay({ importanceBelow: options.importanceBelow, olderThanDays: options.olderThanDays })
  } catch {
    skipped += 1
  }

  // 阶段 2：合并相似条目（按 kind 分桶，桶内两两比对）。
  // 可选 mergeCandidateIds：仅把指定 id 当作「种子」参与比对（同桶内仍允许并入未指定条目）。
  // 工作集封顶（审计 N12）：全量 active 进两两比对是 O(N²)，每日后台任务必须设界；
  // 界内取 topActive（重要度序 = 合并价值最高的一批），界外交给归档/衰减处置。
  // 限定种子模式不设顶：种子 id 可能重要度很低，按重要度截断会漏种；其内层比较
  // 只发生在有向量的种子之间，代价 O(种子数²) 而非 O(N²)。
  const seedIds = options.mergeCandidateIds !== undefined
    ? new Set(options.mergeCandidateIds)
    : null
  const stats = await store.stats()
  const records = await store.topActive(scope, seedIds === null ? Math.min(Math.max(stats.active, 0), CONSOLIDATION_MAX_RECORDS) : Math.max(stats.active, 0))
  // ---- 向量：先用库内存量，缺了才嵌入（#64）----
  // 存量条目写入时已带向量（nodes.embedding）。整理时把同一段正文再嵌一遍，等于白付
  // 一遍本地推理：一次 ONNX WASM 前向 2s+ 且同步占宿主主线程，开机窗口里这一轮就是
  // 报告人实测的 10–25s（#64：DSH ready 之后主线程仍被占住，会话列表与首个会话延迟出现）。
  // 存量向量走 vectorsFor：按稳定逻辑身份批量读，只读、不写库、不记日志。
  const vectors = new Map<string, Float32Array>()
  const stored = await store.vectorsFor(records.map(record => record.memoryId))
  for (const record of records) {
    const vec = stored.get(record.memoryId)
    if (vec !== undefined) vectors.set(record.id, vec)
  }
  // 全部条目都有存量向量时**不碰嵌入器**：await 句柄会把模型整个拉起来（数百 MB RSS +
  // 主线程占用），整理没必要付这份钱。
  const missing = records.filter(record => !vectors.has(record.id))
  const emb = missing.length > 0 ? await embedder : undefined
  if (emb !== undefined) {
    // 批式嵌入（审计 N12）：逐条 embed 是 N 次 ONNX 前向——批 32 条一次前向，
    // 整块失败退回逐条（一条坏文本不废一批，与摄取候选同一纪律）。
    for (let offset = 0; offset < missing.length; offset += EMBED_BATCH) {
      const chunk = missing.slice(offset, offset + EMBED_BATCH)
      try {
        const vecs = await emb.embed(chunk.map(record => record.content))
        chunk.forEach((record, index) => {
          const vec = vecs[index]
          if (vec !== undefined) vectors.set(record.id, vec)
        })
      } catch {
        for (const record of chunk) {
          try {
            const vec = (await emb.embed([record.content]))[0]
            if (vec !== undefined) vectors.set(record.id, vec)
          } catch {
            skipped += 1
          }
        }
      }
      // 批间把事件循环还给宿主：一次前向同步占主线程 2s+，不还手的话整理期间
      // 宿主的新请求要等整轮跑完（#64）。
      await new Promise<void>(resolve => { setImmediate(resolve) })
    }
  }
  const buckets = new Map<string, MemoryRecord[]>()
  for (const record of records) {
    const list = buckets.get(record.kind) ?? []
    list.push(record)
    buckets.set(record.kind, list)
  }
  for (const list of buckets.values()) {
    if (list.length < 2) continue
    // 限定模式：桶内若无任何种子 id 则跳过该桶（仅在其他桶找到 seed 的关联条目时才合并）。
    if (seedIds !== null && !list.some(record => seedIds.has(record.id))) continue

    // 向量按维度分组（#64）：cosine() 遇异维直接抛（EMBEDDER_DIMENSION_MISMATCH）。
    // 换过模型的存量库天然混维——异维两条本来就不在同一个向量空间里，不可比是事实
    // 而不是缺陷，所以同维桶内两两比，异维不互比。
    const groups = new Map<number, MemoryRecord[]>()
    const withoutVector: MemoryRecord[] = []
    for (const record of list) {
      const vec = vectors.get(record.id)
      if (vec === undefined) { withoutVector.push(record); continue }
      const dim = vec.length
      const group = groups.get(dim) ?? []
      group.push(record)
      groups.set(dim, group)
    }
    // 有向量的部分：两两 cosine ≥ 阈值则合并（保留高 importance）。
    // 限定模式：以种子为起点向外扫；非种子桶内记录只有与某个种子相似才参与合并。
    for (const group of groups.values()) {
      if (group.length < 2) continue
      // 限定模式的主角只能是种子：非种子即使有向量，也不许当合并的发起方
      // （面板承诺的是「其它条目仅在与种子相似时被并入」）。
      // 旧实现里非种子根本没有向量（整批重嵌只嵌种子），这条约束是被副作用实现的；
      // 现在非种子带存量向量，约束必须显式写出来。
      const leaders = seedIds === null ? group : group.filter(record => seedIds.has(record.id))
      const visited = new Set<string>()
      for (const a of leaders) {
        if (visited.has(a.id)) continue
        const dupes: MemoryRecord[] = []
        for (const b of group) {
          if (visited.has(b.id)) continue
          // b 可能就是 a 自己：cosine(a, a)=1 ≥ 阈值 → 条目被自己 supersede
          //（归档 + 复制出新 id，每日一次）。跳过自身。
          if (b.id === a.id) continue
          const bVec = vectors.get(b.id)
          if (bVec === undefined) continue
          const sim = cosine(vectors.get(a.id)!, bVec)
          if (sim >= options.mergeThreshold) dupes.push(b)
        }
        if (dupes.length > 0) {
          // #42：种子必须随行——只 supersede dupes 会留下「种子 + 新节点」这对重复
          // active，下一轮整理重新匹配、重新刻写（issue #42：3 天 54 份副本的根因）。
          // 种子入链后每轮合并净减一组重复，一轮收敛；新节点继承种子的向量，幸存者
          // 不再是向量检索盲区。importance 取组内最大（路径注释的既定意图：保留高 importance）。
          const ids = [...dupes.map(record => record.id), a.id]
          const embedding = vectors.get(a.id)
          try {
            await store.supersedeMany(
              {
                scope,
                kind: a.kind,
                content: a.content,
                importance: Math.max(a.importance, ...dupes.map(record => record.importance)),
                confidence: a.confidence,
                ...(embedding === undefined ? {} : { embedding }),
              },
              ids,
            )
            // a.id 已在 ids 内，visited 一并覆盖。
            for (const id of ids) visited.add(id)
            merged += 1
          } catch {
            skipped += 1
          }
        }
      }
    }

    // 没有向量的条目（嵌入不可用，或刚写入还没嵌上）：仅按 content 文本前 60 字
    // 完全相同做去重启发式（保留 importance 高的 = existing 胜出）。
    // 当前 record importance 更高时 supersede existing；否则跳过（existing 保持）。
    if (withoutVector.length >= 2) {
      const seen = new Map<string, MemoryRecord>()
      for (const record of withoutVector) {
        const key = record.content.slice(0, 60)
        const existing = seen.get(key)
        if (existing === undefined) {
          seen.set(key, record)
        } else {
          // #42：同文重复一律合并（自审 P1：旧判准 record.importance > existing.importance
          // 在 topActive 的 importance 降序里永假——嵌入器不可用的部署从未有过去重守卫）。
          // 双方入 supersedes 链、每对净减一组重复；幸存节点取组内最大 importance/confidence。
          try {
            const survivor = await store.supersedeMany(
              {
                scope,
                kind: record.kind,
                content: record.content,
                importance: Math.max(existing.importance, record.importance),
                confidence: Math.max(existing.confidence, record.confidence),
              },
              [existing.id, record.id],
            )
            merged += 1
            seen.set(key, survivor)
          } catch {
            // 合并失败：库未变，record 仍 active——继续作 seen 种子（下一对重复仍可合并）。
            skipped += 1
            seen.set(key, record)
          }
        }
      }
    }
  }

  // 阶段 3：写一条 op_log 汇总（duration / archived / merged / skipped）。
  // 汇总行同时是下一轮的分界点：它的 seq 之后出现的写入才算「内容变了」
  // （#64：整理是每日巡检，不是每分钟巡检）。seq 由 audit 返回，不靠时间戳猜。
  const report: ConsolidateReport = { archived, merged, skipped, tookMs: Date.now() - start }
  try {
    await store.audit(
      CONSOLIDATION_OP,
      'AUX',
      JSON.stringify({ scope, archived: report.archived, merged: report.merged, skipped: report.skipped, tookMs: report.tookMs }),
    )
  } catch {
    /* 审计失败不影响整理结果 */
  }
  return report
}
