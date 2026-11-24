/**
 * 23 个 engram_ 工具的规范名字，与「白名单之外的工具对外不存在」的判定（#65）。
 *
 * 名单单独成模块的原因：`src/tools/create.ts` 依赖宿主的 `@deepseek-ai/dsh-tools`，
 * 而 `src/config.ts` 要在解析配置时就校验白名单里的名字——CI 的无 peer 门禁要读
 * config.ts，那条路上装不了宿主包，名单因此需要一份不依赖宿主的副本。
 *
 * 名单与工具定义的一致性由测试守着（tests/tools-names.spec.ts：名字集合必须与
 * createEngramTools 实际产出的工具名逐一相等）。
 *
 * @module @kenz1117/dsh-engram/tools/names
 */

/** 全部工具名（23 个）。顺序与工具定义一致，便于人工核对。 */
export const ENGRAM_TOOL_NAMES: readonly string[] = [
  'engram_save', 'engram_search', 'engram_facts', 'engram_assess', 'engram_timeline',
  'engram_episode_timeline', 'engram_update', 'engram_forget', 'engram_ingest_history',
  'engram_audit_forgotten', 'engram_review_queue', 'engram_report', 'engram_review', 'engram_stats',
  'engram_export', 'engram_import', 'engram_distill', 'engram_reflect', 'engram_examine',
  'engram_neighbors', 'engram_tour', 'engram_profile_edit', 'engram_language_guide',
]

/** 名字集合（查存在性用）。 */
export const ENGRAM_TOOL_NAME_SET: ReadonlySet<string> = new Set(ENGRAM_TOOL_NAMES)

/**
 * 这个名字是不是本插件的工具。
 * @param name - 工具名。
 * @returns true = 是 engram_ 工具。
 */
export function isEngramToolName(name: string): boolean {
  return ENGRAM_TOOL_NAME_SET.has(name)
}

/**
 * 工具可用性：白名单之外的工具对外不存在（#65）。
 *
 * 工具的 schema 是**常驻成本**——注册了 23 个工具，每轮上下文都要背着它们的
 * description。画像那一侧有 `profileTopN` / `injectTokenBudget` 可调，工具这一侧
 * 此前没有闸门。用配置里的 `tools` 白名单裁剪注册面，是唯一能把这份常驻成本
 * 降下来的办法。
 *
 * 判定只有一个含义：**不存在**。因此注入给模型的文字里也不能提到白名单之外的
 * 工具——叫 agent 去调一个没注册的工具，它只会拿到「工具不存在」。
 */
export interface ToolAvailability {
  /**
   * 某个工具是否可用。
   * @param name - 工具名。
   * @returns true = 可用（已注册）。
   */
  readonly has: (name: string) => boolean
}

/**
 * 由白名单造出可用性判定。
 *
 * 白名单为 `undefined` = 未配置 = **全开**（向后兼容：存量用户零影响）。
 * 空数组 = 一个都不注册（只保留存储层与面板）。
 * @param enabled - 配置里的白名单；undefined = 全开。
 * @returns 可用性判定。
 */
export function toolAvailability(enabled: readonly string[] | undefined): ToolAvailability {
  if (enabled === undefined) return { has: () => true }
  const allowed = new Set(enabled)
  return { has: (name: string) => allowed.has(name) }
}

/** 括号里点名工具的片段：中文「（engram_search）」与英文「(engram_search)」。 */
const TOOL_MENTION = /[（(][^（()）]*engram_[a-z_]+[^（()）]*[)）]/g

/**
 * 去掉指向「不存在之工具」的括号注记。
 *
 * 工具结果里的策略提示是这么写的：「换关键词再检索（engram_search）」。白名单之外的
 * 工具连注记都不该留——括号里点名的工具不存在时，那半句就是噪声。
 * @param text - 原始文本。
 * @param availability - 工具可用性。
 * @returns 去掉不可用工具注记后的文本。
 */
export function stripUnavailableToolMentions(text: string, availability: ToolAvailability): string {
  let changed = false
  const stripped = text.replace(TOOL_MENTION, (segment) => {
    const names = [...segment.matchAll(/engram_[a-z_]+/g)].map(match => match[0])
    // 括号里点名的工具全都不存在 → 整段去掉；还有一个在 → 整段保留（少见的混合情况，
    // 宁可留一个多余的注记，也不要把半句话删成病句）。
    if (names.length > 0 && names.every(name => !availability.has(name))) {
      changed = true
      return ''
    }
    return segment
  })
  return changed ? stripped.replace(/[ \t]{2,}/g, ' ').trim() : text
}
