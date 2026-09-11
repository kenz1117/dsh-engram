/**
 * 门牌质量启发式评分（0-1）：「每个标记独一无二」的信息架构纪律。
 * 三原则——唯一（不与他牌重复）、差异化（与同房邻牌一眼可辨）、带日期（时间锚点）。
 * 感官/情绪维度刻意不计分：那是为人脑先天限制打的补丁，AI 既没有也不需要。
 * 评分在 save 时落库（imagery_score），供翻新清单低分规则与 save 提示复用。
 * 纯启发式，不调 LLM——避免每次保存都付一次辅助调用。
 * @module @kenz1117/dsh-engram/imagery/score
 */

/** 低分阈值：低于此值 save 输出附增强建议，refurb 生成「门牌不合规」动议。 */
export const PLACARD_LOW_THRESHOLD = 0.5

/** 日期/时间锚点：ISO 日期、中文年月、相对时间词。 */
const DATE_ANCHOR = /\d{4}[-/年.]\s?\d{1,2}|[今昨]天|本周|上周|周[一二三四五六日天]|\d{1,2}月\d{1,2}[日号]/

/** 差异化比较的前缀长度：前 6 字相同即视为「近似到无法区分」。 */
const DIFF_PREFIX_LEN = 6

/** 门牌评分上下文：既有门牌快照（save 前由存储层拉取）。 */
export interface PlacardContext {
  /** 全库既有 caption 集合（唯一性检查）。 */
  readonly existingCaptions: readonly string[]
  /** 同房间既有 caption 集合（差异化检查）。 */
  readonly roomCaptions: readonly string[]
}

/**
 * 计算门牌质量分（0-1，保留两位小数）。
 * 构成：caption 有效（4-30 字）且全库唯一 +0.4；带日期/时间锚点 +0.3；
 * 与同房既有门牌差异化（前 6 字不重复）+0.3。无 caption 记 0 分。
 * @param caption - 门牌文字（ImageryLabel.caption）；null/undefined 表示未挂牌。
 * @param context - 既有门牌快照。
 * @returns 0-1 的质量分。
 */
export function scorePlacard(caption: string | null | undefined, context: PlacardContext): number {
  if (caption === null || caption === undefined) return 0
  const text = caption.trim()
  let score = 0
  const valid = text.length >= 4 && text.length <= 30
  if (valid && !context.existingCaptions.includes(text)) score += 0.4
  if (DATE_ANCHOR.test(text)) score += 0.3
  const prefix = text.slice(0, DIFF_PREFIX_LEN)
  const clashes = context.roomCaptions.some(other => other.slice(0, DIFF_PREFIX_LEN) === prefix)
  if (valid && !clashes) score += 0.3
  return Math.round(Math.min(1, score) * 100) / 100
}

/**
 * 低分门牌的增强建议（附在 engram_save 输出末尾，中文一行）。
 * @param score - scorePlacard 的得分。
 * @returns 建议文本；非低分返回 null。
 */
export function placardImprovementHint(score: number): string | null {
  if (score >= PLACARD_LOW_THRESHOLD) return null
  return '门牌不合规（宫殿纪律：唯一 · 差异化 · 带日期）：建议用 engram_update 的 imagery 参数挂一个 4-30 字、含日期锚点、与同房其他门牌前 6 字不重复的铭牌。'
}
