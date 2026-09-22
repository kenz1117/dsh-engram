/**
 * Jev 裁决观测：进程内环形缓冲，记录每次 judge.ask 的调用点、结论、概率、耗时与
 * 失败原因，供面板「近期裁决」卡回答「这条为什么被搁置」。只进内存（50 条，重启
 * 清空），不落盘——观测不拖慢写入链路，也不给密钥/记忆正文增加留存面。
 * @module @kenz1117/dsh-engram/jev/observe
 */

/**
 * 观测结论：本次 ask 对写入链路的实际影响。
 * merge/accept = Jev 判定直接改变写入处置；defer = 概率未跨阈值维持搁置；
 * confirm/reject = 矛盾确认通过与否；fallback = Jev 失败或未返回答案，纯规则兜底。
 */
export type JevVerdict =
  | 'merge'
  | 'accept'
  | 'defer'
  | 'confirm'
  | 'reject'
  | 'fallback'

/** 单次 judge.ask 的观测记录。 */
export interface JevObservation {
  /** 记录时刻（Date.now() 毫秒）。 */
  readonly at: number
  /** 调用点：band = 写入模糊带三路裁决；contradiction = 矛盾建边前确认。 */
  readonly site: 'band' | 'contradiction'
  /** 问题 id（same_memory / contradicts）。 */
  readonly question: string
  /** Jev 是否给出可用答案（false = 抛错或答案缺失，结论为 fallback）。 */
  readonly answered: boolean
  /** Noul 概率（0-1）；answered 时必有值。 */
  readonly probability: number | undefined
  /** 请求耗时（毫秒）。 */
  readonly elapsedMs: number
  /** 失败原因文案；answered 时为 undefined。 */
  readonly error: string | undefined
  /** 结论（见 JevVerdict）。 */
  readonly verdict: JevVerdict
}

/** 缓冲容量：足够回看一次摄取批次，同时封顶内存占用。 */
const CAPACITY = 50

const buffer: JevObservation[] = []

/** 追加一条观测；超出容量丢弃最旧记录。 */
export function recordJevObservation(observation: JevObservation): void {
  buffer.push(observation)
  if (buffer.length > CAPACITY) buffer.shift()
}

/** 按时间正序返回全部观测（最新在末尾）；返回副本，调用方改动不影响缓冲。 */
export function listJevObservations(): readonly JevObservation[] {
  return [...buffer]
}

/** 清空缓冲（测试隔离用；生产链路无清空入口，缓冲随进程生命周期存活）。 */
export function clearJevObservations(): void {
  buffer.length = 0
}
