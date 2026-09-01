/**
 * 插件 Config：所有部署可变项集中于此，禁止在实现里内嵌默认值。
 * @module @kenz1117/dsh-engram/config
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'

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
}

/** 解析后的完整配置（显式默认值集中在此一步，实现不再 `?? 默认`）。 */
export interface ResolvedEngramConfig {
  readonly dbDir: string
  readonly injectProfile: boolean
  readonly profileTopN: number
  readonly modelCacheDir: string
}

/** 合法配置键集合（未知键 loud 失败）。 */
const CONFIG_KEYS: ReadonlySet<string> = new Set(['dbDir', 'injectProfile', 'profileTopN', 'modelCacheDir'])

/** Schemastery 校验面（cordis.yml 读取时校验）。 */
export const Config: z<EngramConfig> = z.object({
  dbDir: z.string(),
  injectProfile: z.boolean(),
  profileTopN: z.number().step(1).min(1).max(64),
  modelCacheDir: z.string(),
})

/**
 * 显式 resolve 步骤：默认值只在唯一的此处落地，非法值 loud 失败。
 * @param config - cordis.yml 传入的未校验配置。
 * @returns 完整解析配置。
 * @throws 未知键或 profileTopN 越界时抛错。
 */
export function resolveConfig(config: EngramConfig = {}): ResolvedEngramConfig {
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`dsh-engram: unknown config key "${key}"`)
  }
  if (config.profileTopN !== undefined && (!Number.isInteger(config.profileTopN) || config.profileTopN < 1 || config.profileTopN > 64)) {
    throw new Error('dsh-engram: profileTopN must be an integer in [1, 64]')
  }
  const dbDir = config.dbDir ?? join(homedir(), '.dsh', 'engram')
  return {
    dbDir,
    injectProfile: config.injectProfile ?? true,
    profileTopN: config.profileTopN ?? 8,
    modelCacheDir: config.modelCacheDir ?? join(dbDir, 'models'),
  }
}
