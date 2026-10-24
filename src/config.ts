/**
 * 插件 Config：所有部署可变项集中于此，禁止在实现里内嵌默认值。
 * @module @kenz1117/dsh-engram/config
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'

import { isLanguageCode, resolveLanguage, type EngramLanguage, type LanguageSetting } from './i18n/language.ts'
import { legacyJevFields, noteLegacyJevFields } from './jev/stale.ts'

/** 旧库迁移策略：默认自动迁移，可选择保留待人工确认。 */
export type LegacyMigrationPolicy = 'eager' | 'conservative'

/** 自动摄取档位：off 关闭；light 只读用户消息（每轮≤2 条）；eager 用户+助手消息（每轮≤5 条）。 */
export type IngestModeConfig = 'off' | 'light' | 'eager'

/** 信念巩固档位：off 仅允许手动 engram_reflect；suggest 会话结束只登记待巩固；auto 会话结束后自动巩固。 */
export type ReflectModeConfig = 'off' | 'suggest' | 'auto'

/**
 * 嵌入后端。
 *
 * `local` — 包内模型，离线推理，数据不出机。
 * `remote` — OpenAI 兼容端点；既可以是公开的嵌入服务，也可以是局域网内的推理
 * 服务器，因此「本地/远程」由 baseUrl 的取值界定，而不是单独的档位。
 */
export type EmbedderKind = 'local' | 'remote'

/** 把 token 归并成单个向量的方式。bge-m3 与同族模型需要 cls。 */
export type EmbedderPooling = 'mean' | 'cls'

/** 嵌入器子配置：本地模型或远程端点（二者互斥）。 */
export interface EmbedderConfig {
  /** 后端；默认 local——旧版本的行为原样保留。 */
  kind?: EmbedderKind
  /** local：模型标识 — явное переопределение поверх привязок языка；по умолчанию модель берётся из реестра. */
  localModel?: string
  /** local：способ сведения токенов — явное переопределение поверх каталога моделей. */
  localPooling?: EmbedderPooling
  /** remote：模型标识，原样传给服务端（例如 text-embedding-3-small）。 */
  model?: string
  /** remote：端点根地址含版本号，例如 https://api.example.com/v1。 */
  baseUrl?: string
  /** remote：直接写在配置里的 Bearer 密钥——与 jev.apiKey 同一做法。 */
  apiKey?: string
  /** remote：存放密钥的环境变量名；已设置的变量优先于 apiKey。 */
  apiKeyEnv?: string
  /** remote：单次请求的文本条数上限；默认 32。 */
  batchSize?: number
  /** remote：单次请求的超时毫秒数；默认 30000。 */
  timeoutMs?: number
}

/** Jev System One 模型子配置：DEFER 模糊带自动裁决与矛盾边确认；默认关闭时四态判定保持纯规则。 */
export interface JevConfig {
  /** 是否启用 Jev 裁决；默认 false。 */
  enabled?: boolean
  /** Провайдер DSH (ключ в `providers` плагина `llm-pi-ai`): адрес и ключ берутся у хоста. */
  provider?: string
  /** Модель провайдера (id из его списка моделей); принадлежность Jev проверяется тестом связи. */
  model?: string
  /** Полный адрес эндпоинта System One; пусто = вывести шаблоном из baseURL провайдера. */
  endpoint?: string
  /** 单次裁决请求的超时毫秒数；默认 3000。 */
  timeoutMs?: number
  /** 模糊带裁决：Noul 概率高于该值判「同一条」并自动 merge；默认 0.85。 */
  deferMergeAbove?: number
  /** 模糊带裁决：Noul 概率低于该值判「不同条」并放行 accept；默认 0.15。 */
  deferAcceptBelow?: number
  /** 矛盾确认：Noul 概率达到该值才建立 contradicts 边，低于则放弃建边；默认 0.8。 */
  contradictMinProbability?: number
}

/** 插件配置。 */
export interface EngramConfig {
  /** 两个 SQLite 分库与嵌入模型缓存的根目录；默认 `~/.dsh/engram`。 */
  dbDir?: string
  /** 旧库迁移策略：默认 eager 自动迁移；conservative 保留旧库待人工确认。 */
  legacyMigration?: LegacyMigrationPolicy
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
  /** 信念自动巩固档位；默认 off。suggest/auto 会话结束后触发，复用 provider/model 辅助路由。 */
  reflect?: ReflectModeConfig
  /** 蒸馏/摄取覆盖路由的 provider；必须与 model 成对提供。 */
  provider?: string
  /** 蒸馏/摄取覆盖路由的 model；必须与 provider 成对提供。 */
  model?: string
  /** 衰减：最近访问超过该天数才可能被归档；默认 30。 */
  decayAfterDays?: number
  /** 衰减：importance 低于该值才可能被归档；默认 0.3。 */
  decayImportanceBelow?: number
  /** 画像注入的 token 预算（估算 ceil(len/4)）；默认 1024。 */
  injectTokenBudget?: number
  /** 画像分级递减预算：首条正文字符数；默认 160。 */
  injectItemBudgetStart?: number
  /** 画像分级递减预算：逐条递减系数（0.5-1）；默认 0.9。 */
  injectItemBudgetDecay?: number
  /** 画像分级递减预算：单条正文字符下限；默认 24。 */
  injectItemBudgetFloor?: number
  /** 证据门收尾提醒：会话存在未判定检索批次时在下一步开始前注入提醒；默认 true。 */
  assessReminder?: boolean
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
  /**
   * Окно смены языка дворца, в секундах: сколько даётся на собранное условие — выбрать
   * язык, снять предохранитель, нажать «Выполнить». Отсчёт идёт с первого из трёх
   * событий; окно истекло — выбор возвращается к языку баз, предохранитель встаёт.
   *
   * Настройка, а не константа в коде: пользователь просил менять её без пересборки
   * («минута это много, 30 сек» — и это его решение, а не наше). Значение читает и
   * панель (отсчёт и подпись), и сервер (проверка собранного условия при запросе).
   * По умолчанию 30.
   */
  palaceChangeWindowSec?: number
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
  /** Jev System One 裁决子配置；默认关闭（纯规则四态判定，行为与旧版一致）。 */
  jev?: JevConfig
  /** 嵌入器：本地离线模型或远程 OpenAI 兼容端点；默认 local。 */
  embedder?: EmbedderConfig
  /**
   * Язык дворца: на нём плагин говорит сам — имена комнат, сообщения инструментов,
   * системные инструкции модели. «auto» — решения ещё нет: язык берётся из системы.
   * В рантайме поле приходит живой ссылкой (volatile) и меняется без перемонтирования;
   * интерфейс панели настраивается отдельно, средствами DSH.
   */
  language?: LanguageSetting | { get(): LanguageSetting }
  /**
   * Слова-метки секретов, добавленные пользователем. Дополняют наборы языкового пакета
   * и действуют **всегда**, независимо от языка: пользователь добавляет их как раз потому,
   * что пакета не хватило. Пробельные строки отбрасываются.
   */
  redactWords?: string[]
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

/** 解析后的 Jev 子配置（默认值已落地，实现不再判空）。 */
export interface ResolvedJevConfig {
  readonly enabled: boolean
  /** Выбранный провайдер DSH; undefined = не выбран, Jev молча уходит в чистые правила. */
  readonly provider: string | undefined
  readonly model: string | undefined
  /** Адрес эндпоинта из настроек; undefined = вывести шаблоном из провайдера. */
  readonly endpoint: string | undefined
  readonly timeoutMs: number
  readonly deferMergeAbove: number
  readonly deferAcceptBelow: number
  readonly contradictMinProbability: number
}

/** 解析后的嵌入器子配置（默认值已落地）。 */
export interface ResolvedEmbedderConfig {
  readonly kind: EmbedderKind
  /** Явное переопределение модели из настроек; undefined — взять из реестра по языку. */
  readonly localModel: string | undefined
  /** Явное переопределение сведения токенов; undefined — взять из каталога моделей. */
  readonly localPooling: EmbedderPooling | undefined
  /** 远程端点；kind=local 时为 undefined。 */
  readonly remote: {
    readonly model: string
    readonly baseUrl: string
    readonly apiKey: string | undefined
    readonly apiKeyEnv: string | undefined
    readonly batchSize: number
    readonly timeoutMs: number
  } | undefined
}

/** 解析后的完整配置（显式默认值集中在此一步，实现不再 `?? 默认`）。 */
export interface ResolvedEngramConfig {
  readonly dbDir: string
  readonly legacyMigration: LegacyMigrationPolicy
  readonly injectProfile: boolean
  readonly profileTopN: number
  readonly modelCacheDir: string
  readonly hfEndpoint: string | undefined
  readonly ingest: IngestModeConfig
  readonly reflect: ReflectModeConfig
  /** 成对校验后的路由覆盖；undefined = 从会话日志解析路由。 */
  readonly routeOverride: { readonly provider: string; readonly model: string } | undefined
  readonly decayAfterDays: number
  readonly decayImportanceBelow: number
  readonly injectTokenBudget: number
  readonly injectItemBudgetStart: number
  readonly injectItemBudgetDecay: number
  readonly injectItemBudgetFloor: number
  readonly assessReminder: boolean
  readonly rankRecencyWeight: number
  readonly rankProofWeight: number
  readonly queryRewrite: boolean
  readonly autoSlot: boolean
  readonly reviewScheduling: boolean
  /**
   * Окно собранного условия смены языка дворца, в секундах. Читают оба: панель считает
   * по нему отсчёт, сервер — принимает ли он запрос смены языка (окно истекло — отказ).
   */
  readonly palaceChangeWindowSec: number
  /** 历史回填默认规则（历史会话 → 记忆宫殿的一次性/按需回填）。 */
  readonly historyBackfill: ResolvedHistoryRules
  /** Jev System One 裁决子配置（默认关闭）。 */
  readonly jev: ResolvedJevConfig
  /** 解析后的嵌入器子配置。 */
  readonly embedder: ResolvedEmbedderConfig
  /** Язык вывода серверной половины (после разворачивания «auto» в язык системы). */
  readonly language: EngramLanguage
  /**
   * Что стояло в настройке до разворачивания: `auto`, конкретный язык или ничего.
   * Нужен, чтобы отличить «язык дворца уже определён» от «ещё не определён»:
   * `auto` — это не язык дворца, а отсутствие решения.
   */
  readonly languageSetting: LanguageSetting | undefined
  /** Слова пользователя для вычистки секретов (действуют поверх языковых наборов). */
  readonly redactWords: readonly string[]
}

/** 合法配置键集合（未知键 loud 失败）。 */
const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'legacyMigration', 'dbDir', 'injectProfile', 'profileTopN', 'modelCacheDir', 'hfEndpoint',
  'ingest', 'reflect', 'provider', 'model', 'decayAfterDays', 'decayImportanceBelow',
  'injectTokenBudget', 'injectItemBudgetStart', 'injectItemBudgetDecay', 'injectItemBudgetFloor',
  'rankRecencyWeight', 'rankProofWeight', 'queryRewrite',
  'autoSlot', 'reviewScheduling', 'assessReminder', 'palaceChangeWindowSec',
  'historyBackfillDays', 'historyBackfillMaxTurnsPerSession', 'historyBackfillMaxTotalTurns',
  'historyBackfillIncludeSubagents', 'historyBackfillIncludeSeeded', 'historyBackfillIncludeNoCwd',
  'jev', 'embedder', 'language', 'redactWords',
])

const INGEST_MODES: ReadonlySet<string> = new Set(['off', 'light', 'eager'])
const REFLECT_MODES: ReadonlySet<string> = new Set(['off', 'suggest', 'auto'])

/** `embedder` 块的键：未知键按错误处理，而不是静默忽略。 */
const EMBEDDER_KEYS: ReadonlySet<string> = new Set([
  'kind', 'localModel', 'localPooling', 'model', 'baseUrl', 'apiKey', 'apiKeyEnv', 'batchSize', 'timeoutMs',
])

/** Schemastery 校验面（cordis.yml 读取时校验）。 */
export const Config: z<EngramConfig> = z.object({
  dbDir: z.string(),
  legacyMigration: z.string() as unknown as z<LegacyMigrationPolicy>,
  injectProfile: z.boolean(),
  profileTopN: z.number().step(1).min(1).max(64),
  modelCacheDir: z.string(),
  hfEndpoint: z.string(),
  ingest: z.string() as unknown as z<IngestModeConfig>,
  reflect: z.string() as unknown as z<ReflectModeConfig>,
  provider: z.string(),
  model: z.string(),
  decayAfterDays: z.number().step(1).min(1).max(3650),
  decayImportanceBelow: z.number().min(0).max(1),
  injectTokenBudget: z.number().step(1).min(128).max(8192),
  injectItemBudgetStart: z.number().step(1).min(40).max(2000),
  injectItemBudgetDecay: z.number().min(0.5).max(1),
  injectItemBudgetFloor: z.number().step(1).min(8).max(200),
  rankRecencyWeight: z.number().min(0).max(2),
  rankProofWeight: z.number().min(0).max(2),
  queryRewrite: z.boolean(),
  autoSlot: z.boolean(),
  reviewScheduling: z.boolean(),
  palaceChangeWindowSec: z.number().step(1).min(5).max(600),
  assessReminder: z.boolean(),
  historyBackfillDays: z.number().step(1).min(0).max(3650),
  historyBackfillMaxTurnsPerSession: z.number().step(1).min(1).max(500),
  historyBackfillMaxTotalTurns: z.number().step(1).min(1).max(5000),
  historyBackfillIncludeSubagents: z.boolean(),
  historyBackfillIncludeSeeded: z.boolean(),
  historyBackfillIncludeNoCwd: z.boolean(),
  jev: z.object({
    enabled: z.boolean(),
    provider: z.string(),
    model: z.string(),
    endpoint: z.string(),
    timeoutMs: z.number().step(1).min(1000).max(60000),
    deferMergeAbove: z.number().min(0.5).max(1),
    deferAcceptBelow: z.number().min(0).max(0.5),
    contradictMinProbability: z.number().min(0.5).max(1),
  }) as unknown as z<JevConfig>,
  embedder: z.object({
    kind: z.string(),
    localModel: z.string(),
    localPooling: z.string(),
    model: z.string(),
    baseUrl: z.string(),
    apiKey: z.string(),
    apiKeyEnv: z.string(),
    batchSize: z.number().step(1).min(1).max(256),
    timeoutMs: z.number().step(1).min(1000).max(600000),
  }) as unknown as z<EmbedderConfig>,
  // volatile: язык дворца меняется на ходу, без перемонтирования плагина
  // (загрузчик коммитит новое значение в живую ссылку и шлёт loader/volatile-update).
  language: z.string().volatile() as unknown as z<LanguageSetting | { get(): LanguageSetting }>,
  redactWords: z.array(z.string()),
})

/**
 * Прочитать значение `language` из любого вида, в котором оно приходит:
 * загрузчик отдаёт volatile-поле ссылкой (`{ get() }`), а тесты и обычный конфиг — строкой.
 * @param value - ссылка на volatile-поле, строка или ничего.
 * @returns Настройка языка в том виде, в каком её записал пользователь.
 */
export function readLanguageSetting(
  value: LanguageSetting | { get(): LanguageSetting } | undefined,
): LanguageSetting | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return value
  const live = (value as { get?: () => LanguageSetting }).get
  return typeof live === 'function' ? value.get() : undefined
}

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
  if (config.legacyMigration !== undefined && config.legacyMigration !== 'eager' && config.legacyMigration !== 'conservative') {
    throw new Error('dsh-engram: legacyMigration must be one of eager|conservative')
  }
  if (config.ingest !== undefined && !INGEST_MODES.has(config.ingest)) {
    throw new Error(`dsh-engram: ingest must be one of off|light|eager, got "${String(config.ingest)}"`)
  }
  if (config.reflect !== undefined && !REFLECT_MODES.has(config.reflect)) {
    throw new Error(`dsh-engram: reflect must be one of off|suggest|auto, got "${String(config.reflect)}"`)
  }
  const languageSetting = readLanguageSetting(config.language)
  if (languageSetting !== undefined && languageSetting !== 'auto' && !isLanguageCode(languageSetting)) {
    throw new Error(`dsh-engram: language must be "auto" or a language code (zh, en, ru, fr, …), got "${String(languageSetting)}"`)
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
  if (config.injectItemBudgetStart !== undefined
    && (!Number.isInteger(config.injectItemBudgetStart) || config.injectItemBudgetStart < 40 || config.injectItemBudgetStart > 2000)) {
    throw new Error('dsh-engram: injectItemBudgetStart must be an integer in [40, 2000]')
  }
  if (config.injectItemBudgetDecay !== undefined && (config.injectItemBudgetDecay < 0.5 || config.injectItemBudgetDecay > 1)) {
    throw new Error('dsh-engram: injectItemBudgetDecay must be in [0.5, 1]')
  }
  if (config.injectItemBudgetFloor !== undefined
    && (!Number.isInteger(config.injectItemBudgetFloor) || config.injectItemBudgetFloor < 8 || config.injectItemBudgetFloor > 200)) {
    throw new Error('dsh-engram: injectItemBudgetFloor must be an integer in [8, 200]')
  }
  if (config.injectItemBudgetStart !== undefined && config.injectItemBudgetFloor !== undefined
    && config.injectItemBudgetFloor > config.injectItemBudgetStart) {
    throw new Error('dsh-engram: injectItemBudgetFloor must not exceed injectItemBudgetStart')
  }
  if (config.assessReminder !== undefined && typeof config.assessReminder !== 'boolean') {
    throw new Error('dsh-engram: assessReminder must be a boolean')
  }
  if (config.palaceChangeWindowSec !== undefined
    && (!Number.isInteger(config.palaceChangeWindowSec) || config.palaceChangeWindowSec < 5 || config.palaceChangeWindowSec > 600)) {
    throw new Error('dsh-engram: palaceChangeWindowSec must be an integer in [5, 600] (seconds)')
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
  const jev = config.jev
  if (jev !== undefined) {
    // Поля прежнего формата (apiKey/baseUrl) не читаются с переезда ключа к провайдеру
    // хоста; одноразовое предупреждение объясняет это тому, у кого они уже написаны.
    const legacy = legacyJevFields(jev)
    if (legacy.length > 0) noteLegacyJevFields('cordis.yml', legacy)
    if (jev.enabled !== undefined && typeof jev.enabled !== 'boolean') {
      throw new Error('dsh-engram: jev.enabled must be a boolean')
    }
    if (jev.provider !== undefined && (typeof jev.provider !== 'string' || jev.provider.trim() === '')) {
      throw new Error('dsh-engram: jev.provider must be a non-empty string')
    }
    if (jev.model !== undefined && (typeof jev.model !== 'string' || jev.model.trim() === '')) {
      throw new Error('dsh-engram: jev.model must be a non-empty string')
    }
    if (jev.endpoint !== undefined) {
      let scheme = ''
      try {
        scheme = new URL(jev.endpoint).protocol
      } catch {
        throw new Error('dsh-engram: jev.endpoint must be an http(s) URL')
      }
      if (scheme !== 'https:' && scheme !== 'http:') {
        throw new Error('dsh-engram: jev.endpoint must be an http(s) URL')
      }
    }
    if (jev.timeoutMs !== undefined && (!Number.isInteger(jev.timeoutMs) || jev.timeoutMs < 1000 || jev.timeoutMs > 60000)) {
      throw new Error('dsh-engram: jev.timeoutMs must be an integer in [1000, 60000]')
    }
    if (jev.deferMergeAbove !== undefined && (jev.deferMergeAbove < 0.5 || jev.deferMergeAbove > 1)) {
      throw new Error('dsh-engram: jev.deferMergeAbove must be in [0.5, 1]')
    }
    if (jev.deferAcceptBelow !== undefined && (jev.deferAcceptBelow < 0 || jev.deferAcceptBelow > 0.5)) {
      throw new Error('dsh-engram: jev.deferAcceptBelow must be in [0, 0.5]')
    }
    if (jev.contradictMinProbability !== undefined && (jev.contradictMinProbability < 0.5 || jev.contradictMinProbability > 1)) {
      throw new Error('dsh-engram: jev.contradictMinProbability must be in [0.5, 1]')
    }
    if ((jev.deferAcceptBelow ?? 0.15) >= (jev.deferMergeAbove ?? 0.85)) {
      throw new Error('dsh-engram: jev.deferAcceptBelow must be less than jev.deferMergeAbove')
    }
  }
  const embedderConfig = config.embedder
  const embedderKind = embedderConfig?.kind ?? 'local'
  if (embedderConfig !== undefined) {
    for (const key of Object.keys(embedderConfig)) {
      if (!EMBEDDER_KEYS.has(key)) throw new Error(`dsh-engram: unknown embedder key "${key}"`)
    }
    if (embedderConfig.kind !== undefined && embedderConfig.kind !== 'local' && embedderConfig.kind !== 'remote') {
      throw new Error('dsh-engram: embedder.kind must be one of local|remote')
    }
    if (embedderConfig.localPooling !== undefined && embedderConfig.localPooling !== 'mean' && embedderConfig.localPooling !== 'cls') {
      throw new Error('dsh-engram: embedder.localPooling must be one of mean|cls')
    }
    if (embedderConfig.batchSize !== undefined
      && (!Number.isInteger(embedderConfig.batchSize) || embedderConfig.batchSize < 1 || embedderConfig.batchSize > 256)) {
      throw new Error('dsh-engram: embedder.batchSize must be an integer in [1, 256]')
    }
    if (embedderConfig.timeoutMs !== undefined
      && (!Number.isInteger(embedderConfig.timeoutMs) || embedderConfig.timeoutMs < 1000 || embedderConfig.timeoutMs > 600000)) {
      throw new Error('dsh-engram: embedder.timeoutMs must be an integer in [1000, 600000]')
    }
    const baseUrl = embedderConfig.baseUrl
    if (baseUrl !== undefined && baseUrl !== '') {
      try {
        const parsed = new URL(baseUrl)
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('unsupported protocol')
      } catch {
        throw new Error('dsh-engram: embedder.baseUrl must be an http(s) URL')
      }
    }
    // 只对选中的后端提要求：local 不必知道 baseUrl，remote 不必知道模型缓存。
    if (embedderKind === 'remote') {
      if (embedderConfig.model === undefined || embedderConfig.model === '') {
        throw new Error('dsh-engram: embedder.kind=remote requires embedder.model')
      }
      if (baseUrl === undefined || baseUrl === '') {
        throw new Error('dsh-engram: embedder.kind=remote requires embedder.baseUrl')
      }
    }
  }
  const dbDir = config.dbDir ?? join(homedir(), '.dsh', 'engram')
  return {
    dbDir,
    legacyMigration: config.legacyMigration ?? 'eager',
    injectProfile: config.injectProfile ?? true,
    profileTopN: config.profileTopN ?? 8,
    modelCacheDir: config.modelCacheDir ?? join(dbDir, 'models'),
    hfEndpoint: config.hfEndpoint,
    ingest: config.ingest ?? 'off',
    reflect: config.reflect ?? 'off',
    language: resolveLanguage(languageSetting ?? 'auto'),
    languageSetting,
    redactWords: config.redactWords ?? [],
    routeOverride: hasProvider && hasModel ? { provider: config.provider!, model: config.model! } : undefined,
    decayAfterDays: config.decayAfterDays ?? 30,
    decayImportanceBelow: config.decayImportanceBelow ?? 0.3,
    injectTokenBudget: config.injectTokenBudget ?? 1024,
    injectItemBudgetStart: config.injectItemBudgetStart ?? 160,
    injectItemBudgetDecay: config.injectItemBudgetDecay ?? 0.9,
    injectItemBudgetFloor: config.injectItemBudgetFloor ?? 24,
    assessReminder: config.assessReminder ?? true,
    rankRecencyWeight: config.rankRecencyWeight ?? 0.2,
    rankProofWeight: config.rankProofWeight ?? 0.1,
    queryRewrite: config.queryRewrite ?? true,
    autoSlot: config.autoSlot ?? true,
    reviewScheduling: config.reviewScheduling ?? true,
    palaceChangeWindowSec: config.palaceChangeWindowSec ?? 30,
    historyBackfill: {
      days: config.historyBackfillDays ?? 7,
      maxTurnsPerSession: config.historyBackfillMaxTurnsPerSession ?? 20,
      maxTotalTurns: config.historyBackfillMaxTotalTurns ?? 200,
      includeSubagents: config.historyBackfillIncludeSubagents ?? false,
      includeSeeded: config.historyBackfillIncludeSeeded ?? false,
      includeNoCwd: config.historyBackfillIncludeNoCwd ?? false,
    },
    jev: {
      enabled: config.jev?.enabled ?? false,
      provider: config.jev?.provider,
      model: config.jev?.model,
      endpoint: config.jev?.endpoint,
      timeoutMs: config.jev?.timeoutMs ?? 3000,
      deferMergeAbove: config.jev?.deferMergeAbove ?? 0.85,
      deferAcceptBelow: config.jev?.deferAcceptBelow ?? 0.15,
      contradictMinProbability: config.jev?.contradictMinProbability ?? 0.8,
    },
    embedder: {
      kind: embedderKind,
      localModel: embedderConfig?.localModel,
      localPooling: embedderConfig?.localPooling,
      remote: embedderKind === 'remote' && embedderConfig?.model !== undefined && embedderConfig.baseUrl !== undefined
        ? {
            model: embedderConfig.model,
            baseUrl: embedderConfig.baseUrl,
            apiKey: embedderConfig.apiKey,
            apiKeyEnv: embedderConfig.apiKeyEnv,
            batchSize: embedderConfig.batchSize ?? 32,
            timeoutMs: embedderConfig.timeoutMs ?? 30000,
          }
        : undefined,
    },
  }
}
