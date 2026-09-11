/**
 * 注入归因：把画像中每条记忆按启发式打标签（recent / bright / corridor-hit / strong-evidence），
 * 输出成 XML 注解块附加在画像文本前，让 agent 知道「为什么这条进了宫」。
 * model-visible ⟺ logged：rationale 也写进会话日志（连同画像正文）。
 * @module @kenz1117/dsh-engram/selection-rationale
 */

import type { MemoryRecord } from './types.ts'

/** 单条记忆的入选原因（可叠加）。 */
export type Reason = 'recent' | 'bright' | 'corridor-hit' | 'strong-evidence'

/** 给定一组入选记忆，返回归因 XML 字符串；空 rooms 返回空串。 */
export function buildSelectionRationale(records: readonly MemoryRecord[]): string {
  if (records.length === 0) return ''
  const now = Date.now()
  const lines: string[] = [
    '<engram_selection_rationale>',
    `本轮画像共 ${String(records.length)} 条记忆，挑选理由如下：`,
    '',
  ]
  for (const record of records) {
    const reasons = classifyRecord(record, now)
    lines.push(`- #${record.id.slice(0, 8)} [${record.kind}/${record.scope}] ${reasonsLabel(reasons)}：${record.content.slice(0, 40)}${record.content.length > 40 ? '…' : ''}`)
  }
  lines.push('', '如果某条理由错误，请通过 engram_report 反馈，越准的画像越能帮你。', '</engram_selection_rationale>')
  return lines.join('\n')
}

/** 把画像正文 + 归因拼成最终注入文本。 */
export function wrapWithRationale(profileText: string, records: readonly MemoryRecord[]): string {
  const rationale = buildSelectionRationale(records)
  return rationale === '' ? profileText : `${rationale}\n\n${profileText}`
}

/** 启发式：4 类原因按阈值判定，可叠加。 */
function classifyRecord(record: MemoryRecord, now: number): Reason[] {
  const reasons: Reason[] = []
  // recent：7 天内被访问过
  if (now - record.lastAccessedAt < 7 * 86_400_000) reasons.push('recent')
  // bright：地标亮度 ≥ 0.7（importance × confidence）
  if (record.importance * record.confidence >= 0.7) reasons.push('bright')
  // corridor-hit：被参观 ≥ 5 次（访问密度高）
  if (record.accessCount >= 5) reasons.push('corridor-hit')
  // strong-evidence：管家验证 success
  if (record.outcome === 'success') reasons.push('strong-evidence')
  return reasons
}

/** 中文/英文 reason 标签。 */
function reasonsLabel(reasons: readonly Reason[]): string {
  if (reasons.length === 0) return '基础入选'
  const LABELS: Record<Reason, string> = {
    recent: '近期被参观',
    bright: '地标明亮',
    'corridor-hit': '走廊常客',
    'strong-evidence': '管家验证有效',
  }
  return reasons.map(r => LABELS[r]).join(' / ')
}
