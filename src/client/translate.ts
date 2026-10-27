/**
 * 面板级文案合成（从 EngramPanel 抽出，审计批次 3）：纯函数、零 react 依赖——
 * 独立模块让 client 层测试可以不经组件渲染直接验证词典与插值行为。
 * @module @kenz1117/dsh-engram/client/translate
 */

import { en, ru, zh, type EngramKey } from './locales/index.ts'

/** 面板语言（与宿主 locale 席位同键）。 */
export type PanelLang = 'zh' | 'en' | 'ru'
/** 面板级 t 的形状（与宿主词典调用同款）。 */
export type Translate = (key: EngramKey, params?: Record<string, unknown>) => string

const DICTS: Record<PanelLang, Record<EngramKey, string>> = { zh, en, ru }

/** 俄语复数段选择（one / few / many 的 0/1/2 下标）。 */
export function ruPluralForm(n: number): 0 | 1 | 2 {
  const mod10 = Math.abs(n) % 10
  const mod100 = Math.abs(n) % 100
  if (mod10 === 1 && mod100 !== 11) return 0
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 1
  return 2
}

/** 词典值插值：{param} 直替，缺参保留原样。 */
function fillParams(raw: string, params: Record<string, unknown> | undefined): string {
  return raw.replace(/\{(\w+)\}/g, (part: string, name: string) => {
    const value = params?.[name]
    return value === undefined ? part : String(value)
  })
}

/** 合成面板级 t：与宿主词典同款 {param} 插值，未知键回退键名本身。
 *  俄语复数（审计 I2）：词典值为「one|few|many」三段式、且参数含数字 n 时按俄语复数
 *  规则选段（如 '{n} предложение|{n} предложения|{n} предложений'）；单段值行为不变。 */
export function makeT(lang: PanelLang): Translate {
  const dict = DICTS[lang]
  return (key, params) => {
    const raw = dict[key] ?? String(key)
    const n = params?.n
    if (lang === 'ru' && typeof n === 'number' && raw.includes('|')) {
      const forms = raw.split('|')
      const form = forms[ruPluralForm(n)]
      if (forms.length === 3 && form !== undefined) return fillParams(form, params)
    }
    return fillParams(raw, params)
  }
}
