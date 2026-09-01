import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'

describe('resolveConfig', () => {
  it('空配置回落到 ~/.dsh/engram 与全部默认值', () => {
    const resolved = resolveConfig({})
    expect(resolved.dbDir).toBe(join(homedir(), '.dsh', 'engram'))
    expect(resolved.injectProfile).toBe(true)
    expect(resolved.profileTopN).toBe(8)
    expect(resolved.modelCacheDir).toBe(join(homedir(), '.dsh', 'engram', 'models'))
  })

  it('显式值全部透传', () => {
    const resolved = resolveConfig({ dbDir: '/tmp/e', injectProfile: false, profileTopN: 3, modelCacheDir: '/tmp/m' })
    expect(resolved).toEqual({ dbDir: '/tmp/e', injectProfile: false, profileTopN: 3, modelCacheDir: '/tmp/m' })
  })

  it('未知键 loud 失败', () => {
    expect(() => resolveConfig({ nope: 1 } as never)).toThrow(/unknown config key/)
  })

  it('profileTopN 越界 loud 失败', () => {
    expect(() => resolveConfig({ profileTopN: 0 })).toThrow(/profileTopN/)
    expect(() => resolveConfig({ profileTopN: 65 })).toThrow(/profileTopN/)
  })
})
