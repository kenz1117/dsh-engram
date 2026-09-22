import { statSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ResolvedJevConfig } from '../src/config.ts'
import {
  effectiveJevConfig,
  jevConfigView,
  jevOverridePath,
  loadJevOverride,
  maskApiKey,
  parseJevPatch,
  resolveJevField,
  saveJevOverride,
} from '../src/jev/runtime.ts'

/** yml 基线夹具：面板覆盖为空时应原样透出；三阈值永远来自基线。 */
const baseConfig: ResolvedJevConfig = {
  enabled: true,
  apiKey: 'yml-key-1234567890',
  baseUrl: 'https://api.typesafe.ai',
  model: 'jev-1',
  timeoutMs: 3000,
  deferMergeAbove: 0.85,
  deferAcceptBelow: 0.15,
  contradictMinProbability: 0.8,
}

describe('loadJevOverride', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'engram-jev-runtime-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('覆盖文件缺失：空覆盖，回落 yml', () => {
    expect(loadJevOverride(dir)).toEqual({})
  })

  it('损坏 JSON：按空覆盖自愈，不抛错', async () => {
    await writeFile(jevOverridePath(dir), '{ not json', 'utf8')
    expect(loadJevOverride(dir)).toEqual({})
  })

  it('合法 JSON 但非对象（数字/字符串/null）：按空覆盖', async () => {
    await writeFile(jevOverridePath(dir), '42', 'utf8')
    expect(loadJevOverride(dir)).toEqual({})
    await writeFile(jevOverridePath(dir), '"text"', 'utf8')
    expect(loadJevOverride(dir)).toEqual({})
    await writeFile(jevOverridePath(dir), 'null', 'utf8')
    expect(loadJevOverride(dir)).toEqual({})
  })

  it('类型不符字段丢弃、未知字段丢弃、合法字段保留', async () => {
    await writeFile(
      jevOverridePath(dir),
      JSON.stringify({
        enabled: 'yes',
        apiKey: 123,
        baseUrl: 'https://panel.test',
        model: 'panel-model',
        timeoutMs: 1.5,
        unknown: 'ignored',
      }),
      'utf8',
    )
    expect(loadJevOverride(dir)).toEqual({ baseUrl: 'https://panel.test', model: 'panel-model' })
  })
})

describe('saveJevOverride', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'engram-jev-runtime-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('保存后读回相同对象，文件权限 0600', () => {
    const override = { enabled: false, apiKey: 'panel-key', baseUrl: 'https://panel.test' }
    saveJevOverride(dir, override)
    expect(loadJevOverride(dir)).toEqual(override)
    // mode 与 0o777 取与：屏蔽文件类型位，只比权限位。
    expect(statSync(jevOverridePath(dir)).mode & 0o777).toBe(0o600)
  })
})

describe('parseJevPatch', () => {
  /** 合并底座夹具：验证缺席字段保留与空串清除。 */
  const current = { enabled: true, apiKey: 'old-key', baseUrl: 'https://old.test', model: 'old-model', timeoutMs: 3000 }

  it('空 patch：返回 current 的浅拷贝，字段全保留', () => {
    expect(parseJevPatch(current, {})).toEqual(current)
  })

  it('enabled 非布尔：整体拒绝', () => {
    expect(parseJevPatch(current, { enabled: 'yes' })).toBe('invalid: jev.enabled 必须是布尔值')
  })

  it('apiKey 非字符串：整体拒绝', () => {
    expect(parseJevPatch(current, { apiKey: 123 })).toBe('invalid: jev.apiKey 必须是字符串')
  })

  it('apiKey 空串或纯空白：清除面板覆盖，回落 yml', () => {
    expect(parseJevPatch(current, { apiKey: '' })).toEqual({ ...current, apiKey: undefined })
    expect(parseJevPatch(current, { apiKey: '   ' })).toEqual({ ...current, apiKey: undefined })
  })

  it('apiKey 非空：去首尾空白后保留', () => {
    expect(parseJevPatch(current, { apiKey: '  new-key  ' })).toEqual({ ...current, apiKey: 'new-key' })
  })

  it('baseUrl 非法（非 URL 或非 http(s) 协议）：整体拒绝', () => {
    expect(parseJevPatch(current, { baseUrl: 'not-a-url' })).toBe('invalid: jev.baseUrl 必须是 http(s) URL')
    expect(parseJevPatch(current, { baseUrl: 'ftp://panel.test' })).toBe('invalid: jev.baseUrl 必须是 http(s) URL')
  })

  it('baseUrl 合法 http(s)：去首尾空白后保留', () => {
    expect(parseJevPatch(current, { baseUrl: ' http://panel.test ' })).toEqual({ ...current, baseUrl: 'http://panel.test' })
  })

  it('model 空白或非字符串：整体拒绝；合法值 trim', () => {
    expect(parseJevPatch(current, { model: '   ' })).toBe('invalid: jev.model 不能为空')
    expect(parseJevPatch(current, { model: 42 })).toBe('invalid: jev.model 不能为空')
    expect(parseJevPatch(current, { model: ' m ' })).toEqual({ ...current, model: 'm' })
  })

  it('timeoutMs 非整数或越界：整体拒绝；边界 1000/60000 通过', () => {
    expect(parseJevPatch(current, { timeoutMs: 999 })).toBe('invalid: jev.timeoutMs 必须是 1000-60000 的整数毫秒')
    expect(parseJevPatch(current, { timeoutMs: 60001 })).toBe('invalid: jev.timeoutMs 必须是 1000-60000 的整数毫秒')
    expect(parseJevPatch(current, { timeoutMs: 1.5 })).toBe('invalid: jev.timeoutMs 必须是 1000-60000 的整数毫秒')
    expect(parseJevPatch(current, { timeoutMs: '3000' })).toBe('invalid: jev.timeoutMs 必须是 1000-60000 的整数毫秒')
    expect(parseJevPatch(current, { timeoutMs: 1000 })).toEqual({ ...current, timeoutMs: 1000 })
    expect(parseJevPatch(current, { timeoutMs: 60000 })).toEqual({ ...current, timeoutMs: 60000 })
  })

  it('任一字段非法即整体拒绝：合法字段也不落盘', () => {
    const result = parseJevPatch(current, { model: 'good', timeoutMs: 1 })
    expect(result).toBe('invalid: jev.timeoutMs 必须是 1000-60000 的整数毫秒')
  })
})

describe('effectiveJevConfig', () => {
  it('空覆盖：原样透出基线', () => {
    expect(effectiveJevConfig(baseConfig, {})).toEqual(baseConfig)
  })

  it('面板字段级覆盖生效，三阈值永远来自基线', () => {
    const merged = effectiveJevConfig(baseConfig, {
      enabled: true,
      apiKey: 'panel-key',
      baseUrl: 'https://panel.test',
      model: 'panel-model',
      timeoutMs: 5000,
    })
    expect(merged.baseUrl).toBe('https://panel.test')
    expect(merged.model).toBe('panel-model')
    expect(merged.timeoutMs).toBe(5000)
    expect(merged.apiKey).toBe('panel-key')
    expect(merged.deferMergeAbove).toBe(0.85)
    expect(merged.deferAcceptBelow).toBe(0.15)
    expect(merged.contradictMinProbability).toBe(0.8)
  })

  it('enabled=true 但无任何密钥：强制降级 enabled=false', () => {
    const merged = effectiveJevConfig({ ...baseConfig, apiKey: undefined }, { enabled: true })
    expect(merged.enabled).toBe(false)
    expect(merged.apiKey).toBeUndefined()
  })

  it('面板关闭开关：即使 yml 有密钥也禁用，且不透出密钥', () => {
    const merged = effectiveJevConfig(baseConfig, { enabled: false })
    expect(merged.enabled).toBe(false)
    expect(merged.apiKey).toBeUndefined()
  })
})

describe('maskApiKey', () => {
  it('长度 > 8：显尾 4 位', () => {
    expect(maskApiKey('abcd1234efgh')).toBe('****efgh')
  })

  it('长度 <= 8：全掩码', () => {
    expect(maskApiKey('abcd1234')).toBe('******')
    expect(maskApiKey('k')).toBe('******')
  })
})

describe('jevConfigView', () => {
  it('已配置密钥：apiKeySet 为 true，掩码取合并后的密钥', () => {
    const view = jevConfigView(baseConfig, {})
    expect(view.enabled).toBe(true)
    expect(view.apiKeySet).toBe(true)
    expect(view.apiKeyMask).toBe('****7890')
    expect(view.baseUrl).toBe('https://api.typesafe.ai')
    expect(view.model).toBe('jev-1')
    expect(view.timeoutMs).toBe(3000)
    expect(view.deferMergeAbove).toBe(0.85)
    expect(view.deferAcceptBelow).toBe(0.15)
    expect(view.contradictMinProbability).toBe(0.8)
  })

  it('无密钥降级：apiKeySet 为 false，掩码为 null', () => {
    const view = jevConfigView({ ...baseConfig, apiKey: undefined }, {})
    expect(view.enabled).toBe(false)
    expect(view.apiKeySet).toBe(false)
    expect(view.apiKeyMask).toBeNull()
  })
})

describe('resolveJevField', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'engram-jev-runtime-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('yml 启用且有密钥、无覆盖文件：装配 judge', () => {
    const field = resolveJevField(baseConfig, dir)
    expect(typeof field.judge?.ask).toBe('function')
  })

  it('yml 禁用：空对象，不装配 judge', () => {
    expect(resolveJevField({ ...baseConfig, enabled: false }, dir)).toEqual({})
  })

  it('面板覆盖关闭开关：重读覆盖文件即时生效，judge 消失', async () => {
    expect(typeof resolveJevField(baseConfig, dir).judge?.ask).toBe('function')
    saveJevOverride(dir, { enabled: false })
    expect(resolveJevField(baseConfig, dir)).toEqual({})
  })

  it('面板覆盖补密钥：yml 无密钥时也能装配 judge', async () => {
    saveJevOverride(dir, { enabled: true, apiKey: 'panel-key' })
    const field = resolveJevField({ ...baseConfig, apiKey: undefined }, dir)
    expect(typeof field.judge?.ask).toBe('function')
  })
})
