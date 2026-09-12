/**
 * token 估算：CJK 感知的上下文预算口径。
 *
 * 汉字、假名、韩文与全角标点按 1.5 token/字计，其余字符按 4 字符/token 计。
 * 统一的 `长度 / 4` 会把中文低估四倍以上，使按 token 计的注入预算与实际占用脱钩
 * （中文 1024 token 预算实际会注入四千余 token）。
 * @module @kenz1117/dsh-engram/token
 */

/** 单个 CJK 字符的 token 成本。 */
export const WIDE_TOKENS_PER_CHAR = 1.5

/** 非 CJK 字符的每 token 字符数。 */
export const NARROW_CHARS_PER_TOKEN = 4

/**
 * 判断码点是否属于 CJK 文字与全角符号区间（含扩展平面）。
 * @param codePoint - Unicode 码点。
 */
function isWideCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x3000 && codePoint <= 0x303f) || // CJK 标点与全角符号
    (codePoint >= 0x3040 && codePoint <= 0x30ff) || // 平假名、片假名
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) || // 汉字扩展 A
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // 汉字基本区
    (codePoint >= 0xa960 && codePoint <= 0xa97f) || // 谚文字母扩展 A
    (codePoint >= 0xac00 && codePoint <= 0xd7ff) || // 谚文音节
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // 汉字兼容
    (codePoint >= 0xff00 && codePoint <= 0xff60) || // 全角 ASCII
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) || // 全角符号
    (codePoint >= 0x20000 && codePoint <= 0x3ffff) // 汉字扩展 B 及以后
  )
}

/**
 * 估算文本占用的 token 数（向上取整）。
 * @param text - 待估算文本。
 * @returns token 估算值；空串为 0。
 */
export function estimateTokens(text: string): number {
  if (text === '') return 0
  let wide = 0
  let narrow = 0
  for (const char of text) {
    if (isWideCodePoint(char.codePointAt(0)!)) wide += 1
    else narrow += 1
  }
  return Math.ceil(wide * WIDE_TOKENS_PER_CHAR + narrow / NARROW_CHARS_PER_TOKEN)
}
