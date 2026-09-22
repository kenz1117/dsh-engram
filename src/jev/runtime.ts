/**
 * Jev 连接配置的运行时覆盖：管理面板保存到 `<dbDir>/jev-config.json`（0600），
 * 字段级覆盖 cordis.yml 的 jev 子配置；装配免缓存——judge 构造是无状态闭包、
 * 覆盖文件是小读，每个装配点即时解析，面板保存后立即生效。
 * 覆盖文件损坏按空覆盖处理：不卡启动，面板重新保存即修复。
 * @module @kenz1117/dsh-engram/jev/runtime
 */

import { readFileSync, writeFileSync } from 'node:fs'
import type { ResolvedJevConfig } from '../config.ts'
import type { MemoryJudge } from '../write-disposition.ts'
import { createMemoryJudge } from './client.ts'

/** 面板可编辑的 Jev 连接字段；三阈值不在面板范围，保持 yml 高级配置。 */
export interface JevOverride {
  /** 是否启用 Jev 裁决。 */
  readonly enabled?: boolean
  /** Jev API 密钥（Bearer 认证）；明文落盘由 0600 文件 + 0700 dbDir 双保护。 */
  readonly apiKey?: string
  /** 端点覆盖（缺省回落 yml，官方 `https://api.typesafe.ai`）。 */
  readonly baseUrl?: string
  /** 判决模型名覆盖。 */
  readonly model?: string
  /** 单次请求超时（毫秒，1000-60000 整数）。 */
  readonly timeoutMs?: number
}

/** 面板 Jev 配置视图：apiKey 只回掩码，明文不出进程。 */
export interface JevConfigView {
  readonly enabled: boolean
  /** 是否已配置密钥（yml 或面板任一来源）。 */
  readonly apiKeySet: boolean
  /** 密钥掩码（尾 4 位）；未配置为 null。 */
  readonly apiKeyMask: string | null
  readonly baseUrl: string
  readonly model: string
  readonly timeoutMs: number
  readonly deferMergeAbove: number
  readonly deferAcceptBelow: number
  readonly contradictMinProbability: number
}

/** 覆盖文件路径（dbDir 已 0700，文件本身 0600 双保险）。 */
export function jevOverridePath(dbDir: string): string {
  return `${dbDir}/jev-config.json`
}

/** 读覆盖文件：缺失/损坏/非法 JSON 都按空覆盖（面板重新保存即修复）。 */
export function loadJevOverride(dbDir: string): JevOverride {
  let raw: string
  try {
    raw = readFileSync(jevOverridePath(dbDir), 'utf8')
  } catch {
    // 文件不存在（未用面板保存过）：空覆盖，回落 yml。
    return {}
  }
  try {
    return collectOverride(JSON.parse(raw) as unknown)
  } catch {
    // 手改坏 JSON：不卡启动，按空覆盖；面板下次保存全量重写。
    return {}
  }
}

/** 收敛未知 JSON 为覆盖对象：只认五个已知字段，类型不符的丢弃。 */
function collectOverride(value: unknown): JevOverride {
  if (value === null || typeof value !== 'object') return {}
  const raw = value as Record<string, unknown>
  return {
    ...(typeof raw['enabled'] === 'boolean' ? { enabled: raw['enabled'] } : {}),
    ...(typeof raw['apiKey'] === 'string' ? { apiKey: raw['apiKey'] } : {}),
    ...(typeof raw['baseUrl'] === 'string' ? { baseUrl: raw['baseUrl'] } : {}),
    ...(typeof raw['model'] === 'string' ? { model: raw['model'] } : {}),
    ...(typeof raw['timeoutMs'] === 'number' && Number.isInteger(raw['timeoutMs'])
      ? { timeoutMs: raw['timeoutMs'] }
      : {}),
  }
}

/** 全量保存覆盖文件（调用方先经 parseJevPatch 校验；内容为面板合并后的完整覆盖）。 */
export function saveJevOverride(dbDir: string, override: JevOverride): void {
  writeFileSync(jevOverridePath(dbDir), `${JSON.stringify(override, null, 2)}\n`, { mode: 0o600 })
}

/**
 * 面板 patch 解析：只认已知字段并逐个校验，出现非法值整体拒绝。
 * `apiKey: ''` 表示清除面板密钥覆盖（回落 yml）；缺席的字段保留 current。
 * @param current - 现有覆盖（合并底座）。
 * @param patch - POST body 原始对象。
 * @returns 合法时返回合并后的完整覆盖；非法时返回 `invalid:` 前缀的字段错误文案。
 */
export function parseJevPatch(current: JevOverride, patch: Readonly<Record<string, unknown>>): JevOverride | string {
  const merged: {
    enabled?: boolean
    apiKey?: string
    baseUrl?: string
    model?: string
    timeoutMs?: number
  } = { ...current }
  if (patch['enabled'] !== undefined) {
    if (typeof patch['enabled'] !== 'boolean') return 'invalid: jev.enabled 必须是布尔值'
    merged.enabled = patch['enabled']
  }
  if (patch['apiKey'] !== undefined) {
    if (typeof patch['apiKey'] !== 'string') return 'invalid: jev.apiKey 必须是字符串'
    // 空串 = 清除面板覆盖，回落 yml 值；非空去首尾空白。
    const trimmed = patch['apiKey'].trim()
    if (trimmed === '') delete merged.apiKey
    else merged.apiKey = trimmed
  }
  if (patch['baseUrl'] !== undefined) {
    if (typeof patch['baseUrl'] !== 'string') return 'invalid: jev.baseUrl 必须是字符串'
    const value = patch['baseUrl'].trim()
    try {
      const url = new URL(value)
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'invalid: jev.baseUrl 必须是 http(s) URL'
    } catch {
      return 'invalid: jev.baseUrl 必须是 http(s) URL'
    }
    merged.baseUrl = value
  }
  if (patch['model'] !== undefined) {
    if (typeof patch['model'] !== 'string' || patch['model'].trim() === '') return 'invalid: jev.model 不能为空'
    merged.model = patch['model'].trim()
  }
  if (patch['timeoutMs'] !== undefined) {
    const value = patch['timeoutMs']
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1000 || value > 60000) {
      return 'invalid: jev.timeoutMs 必须是 1000-60000 的整数毫秒'
    }
    merged.timeoutMs = value
  }
  return merged
}

/**
 * 面板覆盖与 yml 基线的字段级合并；合并后 enabled=true 但无密钥时强制降级
 * enabled=false（与 Jev 不可用静默降级语义一致，不卡启动）。
 */
export function effectiveJevConfig(base: ResolvedJevConfig, override: JevOverride): ResolvedJevConfig {
  const apiKey = override.apiKey ?? base.apiKey
  const enabled = (override.enabled ?? base.enabled) && apiKey !== undefined && apiKey !== ''
  return {
    enabled,
    apiKey: enabled ? apiKey : undefined,
    baseUrl: override.baseUrl ?? base.baseUrl,
    model: override.model ?? base.model,
    timeoutMs: override.timeoutMs ?? base.timeoutMs,
    deferMergeAbove: base.deferMergeAbove,
    deferAcceptBelow: base.deferAcceptBelow,
    contradictMinProbability: base.contradictMinProbability,
  }
}

/** 密钥掩码：长度 > 8 显示尾 4 位，其余全掩码。 */
export function maskApiKey(key: string): string {
  return key.length > 8 ? `****${key.slice(-4)}` : '******'
}

/** 组装面板视图：基于生效配置；掩码取合并后的密钥。 */
export function jevConfigView(base: ResolvedJevConfig, override: JevOverride): JevConfigView {
  const config = effectiveJevConfig(base, override)
  return {
    enabled: config.enabled,
    apiKeySet: config.apiKey !== undefined && config.apiKey !== '',
    apiKeyMask: config.apiKey === undefined || config.apiKey === '' ? null : maskApiKey(config.apiKey),
    baseUrl: config.baseUrl,
    model: config.model,
    timeoutMs: config.timeoutMs,
    deferMergeAbove: config.deferMergeAbove,
    deferAcceptBelow: config.deferAcceptBelow,
    contradictMinProbability: config.contradictMinProbability,
  }
}

/**
 * 统一装配函数：读面板覆盖、合并 yml 基线，enabled 时产出 judge，否则返回空对象。
 * 产出形状可直接条件展开进摄取/工具/末轮/回填四类依赖（`...resolveJevField(resolved.jev, dbDir)`）。
 * 免缓存：judge 构造是无状态闭包、覆盖文件是小读，每次调用即时解析，面板保存立即生效。
 */
export function resolveJevField(base: ResolvedJevConfig, dbDir: string): { judge: MemoryJudge } | Record<string, never> {
  const config = effectiveJevConfig(base, loadJevOverride(dbDir))
  if (!config.enabled || config.apiKey === undefined || config.apiKey === '') return {}
  return { judge: createMemoryJudge(config) }
}
