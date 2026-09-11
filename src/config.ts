/**
 * 插件 Config：所有部署可变项集中于此，禁止在实现里内嵌默认值。
 * @module @kenz1117/dsh-engram/config
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** 自动摄取档位：off 关闭；light 只读用户消息（每轮≤2 条）；eager 用户+助手消息（每轮≤5 条）。 */
export type IngestModeConfig = 'off' | 'light' | 'eager'

/** 插件配置。 */
export interface EngramConfig {
  /** 两个 SQLite 分库与嵌入模型缓存的根目录；默认 `~/.dsh/engram`。 */
  dbDir?: string
  /** 会话开始是否注入用户级画像摘要；默认 true。 */
  injectProfile?: boolean
  /** 画像注入的最大条数；默认 8。 */
  profileTopN?: number
  /** 嵌入模型缓存目录；默认 `<dbDir>/models`。 */
  modelCacheDir?: string
  /** 嵌入模型下载端点；默认 huggingface.co，网络受限环境配镜像（如 https://hf-mirror.com）。 */
  hfEndpoint?: string
  /** 自动摄取档位；默认 off（显式开启才写库）。 */
  ingest?: IngestModeConfig
  /** 蒸馏/摄取覆盖路由的 provider；必须与 model 成对提供。 */
  provider?: string
  /** 蒸馏/摄取覆盖路由的 model；必须与 provider 成对提供。 */
  model?: string
  /** 衰减：最近访问超过该天数才可能被归档；默认 30。 */
  decayAfterDays?: number
  /** 衰减：importance 低于该值才可能被归档；默认 0.3。 */
  decayImportanceBelow?: number
  /** 画像注入的 token 预算（估算 ceil(len/4)，超预算条目降级为索引行）；默认 1024。 */
  injectTokenBudget?: number
  /** 检索排序 recency 因子权重（0 关闭）；默认 0.2。 */
  rankRecencyWeight?: number
  /** 检索排序 proof 因子权重（0 关闭）；默认 0.1。 */
  rankProofWeight?: number
  /** engram_search 是否用辅助 LLM 把查询改写为 ≤3 个互补查询再做 RRF 融合；默认 true。改写失败自动降级单查询。 */
  queryRewrite?: boolean
  /** 写入时自动排桩（房间 + 桩位号）并登记固定巡游路线；默认 true。false 时桩位/路线完全由调用方显式指定。 */
  autoSlot?: boolean
  /** 新记忆是否进入 SM-2 间隔重复调度（初始 1 天后到期）；默认 true。false 时复习队列恒空、decay 行为同旧版。 */
  reviewScheduling?: boolean
  /** 历史回填默认规则：时间窗天数，0 = 不限；默认 7。 */
  historyBackfillDays?: number
  /** 历史回填默认规则：单个会话最多摄取轮数；默认 20。 */
  historyBackfillMaxTurnsPerSession?: number
  /** 历史回填上限：单次运行的总轮数硬上限（面板/工具参数只能调低）；默认 200。 */
  historyBackfillMaxTotalTurns?: number
  /** 历史回填默认规则：是否包含子代理会话（origin=subagent）；默认 false。 */
  historyBackfillIncludeSubagents?: boolean
  /** 历史回填默认规则：是否包含种子会话（isSeeded）；默认 false。 */
  historyBackfillIncludeSeeded?: boolean
  /** 历史回填默认规则：是否包含无 cwd 的会话（无法归属项目分库）；默认 false。 */
  historyBackfillIncludeNoCwd?: boolean
}

/** 历史回填规则（面板/工具可在默认值之上按次调整；总轮数受硬上限约束）。 */
export interface ResolvedHistoryRules {
  /** 时间窗天数；0 = 不限。 */
  readonly days: number
  /** 单个会话最多摄取轮数。 */
  readonly maxTurnsPerSession: number
  /** 单次运行总轮数硬上限。 */
  readonly maxTotalTurns: number
  /** 是否包含子代理会话。 */
  readonly includeSubagents: boolean
  /** 是否包含种子会话。 */
  readonly includeSeeded: boolean
  /** 是否包含无 cwd 会话。 */
  readonly includeNoCwd: boolean
}

/** 解析后的完整配置（显式默认值集中在此一步，实现不再 `?? 默认`）。 */
export interface ResolvedEngramConfig {
  readonly dbDir: string
  readonly injectProfile: boolean
  readonly profileTopN: number
  readonly modelCacheDir: string
  readonly hfEndpoint: string | undefined
  readonly ingest: IngestModeConfig
  /** 成对校验后的路由覆盖；undefined = 从会话日志解析路由。 */
  readonly routeOverride: { readonly provider: string; readonly model: string } | undefined
  readonly decayAfterDays: number
  readonly decayImportanceBelow: number
  readonly injectTokenBudget: number
  readonly rankRecencyWeight: number
  readonly rankProofWeight: number
  readonly queryRewrite: boolean
  readonly autoSlot: boolean
  readonly reviewScheduling: boolean
  /** 历史回填默认规则（历史会话 → 记忆宫殿的一次性/按需回填）。 */
  readonly historyBackfill: ResolvedHistoryRules
}

/** 合法配置键集合（未知键 loud 失败）。 */
const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'dbDir', 'injectProfile', 'profileTopN', 'modelCacheDir', 'hfEndpoint',
  'ingest', 'provider', 'model', 'decayAfterDays', 'decayImportanceBelow',
  'injectTokenBudget', 'rankRecencyWeight', 'rankProofWeight', 'queryRewrite',
  'autoSlot', 'reviewScheduling',
  'historyBackfillDays', 'historyBackfillMaxTurnsPerSession', 'historyBackfillMaxTotalTurns',
  'historyBackfillIncludeSubagents', 'historyBackfillIncludeSeeded', 'historyBackfillIncludeNoCwd',
])

const INGEST_MODES: ReadonlySet<string> = new Set(['off', 'light', 'eager'])

/** Schemastery 校验面（cordis.yml 读取时校验）。 */
export const Config: z<EngramConfig> = z.object({
  dbDir: z.string(),
  injectProfile: z.boolean(),
  profileTopN: z.number().step(1).min(1).max(64),
  modelCacheDir: z.string(),
  hfEndpoint: z.string(),
  ingest: z.string() as unknown as z<IngestModeConfig>,
  provider: z.string(),
  model: z.string(),
  decayAfterDays: z.number().step(1).min(1).max(3650),
  decayImportanceBelow: z.number().min(0).max(1),
  injectTokenBudget: z.number().step(1).min(128).max(8192),
  rankRecencyWeight: z.number().min(0).max(2),
  rankProofWeight: z.number().min(0).max(2),
  queryRewrite: z.boolean(),
  autoSlot: z.boolean(),
  reviewScheduling: z.boolean(),
  historyBackfillDays: z.number().step(1).min(0).max(3650),
  historyBackfillMaxTurnsPerSession: z.number().step(1).min(1).max(500),
  historyBackfillMaxTotalTurns: z.number().step(1).min(1).max(5000),
  historyBackfillIncludeSubagents: z.boolean(),
  historyBackfillIncludeSeeded: z.boolean(),
  historyBackfillIncludeNoCwd: z.boolean(),
})

/**
 * 显式 resolve 步骤：默认值只在唯一的此处落地，非法值 loud 失败。
 * @param config - cordis.yml 传入的未校验配置。
 * @returns 完整解析配置。
 * @throws 未知键、ingest 档位非法、provider/model 只给其一、decay/预算/排序权重/历史回填规则越界时抛错。
 */
export function resolveConfig(config: EngramConfig = {}): ResolvedEngramConfig {
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`dsh-engram: unknown config key "${key}"`)
  }
  if (config.ingest !== undefined && !INGEST_MODES.has(config.ingest)) {
    throw new Error(`dsh-engram: ingest must be one of off|light|eager, got "${String(config.ingest)}"`)
  }
  if (config.profileTopN !== undefined && (!Number.isInteger(config.profileTopN) || config.profileTopN < 1 || config.profileTopN > 64)) {
    throw new Error('dsh-engram: profileTopN must be an integer in [1, 64]')
  }
  const hasProvider = config.provider !== undefined
  const hasModel = config.model !== undefined
  if (hasProvider !== hasModel) {
    throw new Error('dsh-engram: provider and model must be supplied together')
  }
  if (config.decayAfterDays !== undefined && (!Number.isInteger(config.decayAfterDays) || config.decayAfterDays < 1 || config.decayAfterDays > 3650)) {
    throw new Error('dsh-engram: decayAfterDays must be an integer in [1, 3650]')
  }
  if (config.decayImportanceBelow !== undefined && (config.decayImportanceBelow < 0 || config.decayImportanceBelow > 1)) {
    throw new Error('dsh-engram: decayImportanceBelow must be in [0, 1]')
  }
  if (config.injectTokenBudget !== undefined && (!Number.isInteger(config.injectTokenBudget) || config.injectTokenBudget < 128 || config.injectTokenBudget > 8192)) {
    throw new Error('dsh-engram: injectTokenBudget must be an integer in [128, 8192]')
  }
  if (config.rankRecencyWeight !== undefined && (config.rankRecencyWeight < 0 || config.rankRecencyWeight > 2)) {
    throw new Error('dsh-engram: rankRecencyWeight must be in [0, 2]')
  }
  if (config.rankProofWeight !== undefined && (config.rankProofWeight < 0 || config.rankProofWeight > 2)) {
    throw new Error('dsh-engram: rankProofWeight must be in [0, 2]')
  }
  if (config.historyBackfillDays !== undefined && (!Number.isInteger(config.historyBackfillDays) || config.historyBackfillDays < 0 || config.historyBackfillDays > 3650)) {
    throw new Error('dsh-engram: historyBackfillDays must be an integer in [0, 3650] (0 = unlimited)')
  }
  if (config.historyBackfillMaxTurnsPerSession !== undefined
    && (!Number.isInteger(config.historyBackfillMaxTurnsPerSession) || config.historyBackfillMaxTurnsPerSession < 1 || config.historyBackfillMaxTurnsPerSession > 500)) {
    throw new Error('dsh-engram: historyBackfillMaxTurnsPerSession must be an integer in [1, 500]')
  }
  if (config.historyBackfillMaxTotalTurns !== undefined
    && (!Number.isInteger(config.historyBackfillMaxTotalTurns) || config.historyBackfillMaxTotalTurns < 1 || config.historyBackfillMaxTotalTurns > 5000)) {
    throw new Error('dsh-engram: historyBackfillMaxTotalTurns must be an integer in [1, 5000]')
  }
  const dbDir = config.dbDir ?? join(homedir(), '.dsh', 'engram')
  return {
    dbDir,
    injectProfile: config.injectProfile ?? true,
    profileTopN: config.profileTopN ?? 8,
    modelCacheDir: config.modelCacheDir ?? join(dbDir, 'models'),
    hfEndpoint: config.hfEndpoint,
    ingest: config.ingest ?? 'off',
    routeOverride: hasProvider && hasModel ? { provider: config.provider!, model: config.model! } : undefined,
    decayAfterDays: config.decayAfterDays ?? 30,
    decayImportanceBelow: config.decayImportanceBelow ?? 0.3,
    injectTokenBudget: config.injectTokenBudget ?? 1024,
    rankRecencyWeight: config.rankRecencyWeight ?? 0.2,
    rankProofWeight: config.rankProofWeight ?? 0.1,
    queryRewrite: config.queryRewrite ?? true,
    autoSlot: config.autoSlot ?? true,
    reviewScheduling: config.reviewScheduling ?? true,
    historyBackfill: {
      days: config.historyBackfillDays ?? 7,
      maxTurnsPerSession: config.historyBackfillMaxTurnsPerSession ?? 20,
      maxTotalTurns: config.historyBackfillMaxTotalTurns ?? 200,
      includeSubagents: config.historyBackfillIncludeSubagents ?? false,
      includeSeeded: config.historyBackfillIncludeSeeded ?? false,
      includeNoCwd: config.historyBackfillIncludeNoCwd ?? false,
    },
  }
}
