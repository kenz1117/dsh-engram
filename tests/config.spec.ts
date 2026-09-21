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
    expect(resolved.ingest).toBe('off')
    expect(resolved.legacyMigration).toBe('eager')
    expect(resolved.routeOverride).toBeUndefined()
    expect(resolved.decayAfterDays).toBe(30)
    expect(resolved.decayImportanceBelow).toBe(0.3)
    expect(resolved.injectTokenBudget).toBe(1024)
    expect(resolved.rankRecencyWeight).toBe(0.2)
    expect(resolved.rankProofWeight).toBe(0.1)
    expect(resolved.queryRewrite).toBe(true)
    expect(resolved.injectItemBudgetStart).toBe(160)
    expect(resolved.injectItemBudgetDecay).toBe(0.9)
    expect(resolved.injectItemBudgetFloor).toBe(24)
    expect(resolved.assessReminder).toBe(true)
  })

  it('显式值全部透传', () => {
    const resolved = resolveConfig({
      dbDir: '/tmp/e', injectProfile: false, profileTopN: 3, modelCacheDir: '/tmp/m',
      hfEndpoint: 'https://hf-mirror.com', ingest: 'eager',
      provider: 'deepseek', model: 'deepseek-v4-flash',
      decayAfterDays: 7, decayImportanceBelow: 0.5,
      injectTokenBudget: 2048, rankRecencyWeight: 0, rankProofWeight: 1.5,
      queryRewrite: false,
      injectItemBudgetStart: 200, injectItemBudgetDecay: 0.8, injectItemBudgetFloor: 40,
      assessReminder: false,
    })
    expect(resolved.dbDir).toBe('/tmp/e')
    expect(resolved.injectProfile).toBe(false)
    expect(resolved.profileTopN).toBe(3)
    expect(resolved.modelCacheDir).toBe('/tmp/m')
    expect(resolved.hfEndpoint).toBe('https://hf-mirror.com')
    expect(resolved.ingest).toBe('eager')
    expect(resolved.routeOverride).toEqual({ provider: 'deepseek', model: 'deepseek-v4-flash' })
    expect(resolved.decayAfterDays).toBe(7)
    expect(resolved.decayImportanceBelow).toBe(0.5)
    expect(resolved.injectTokenBudget).toBe(2048)
    expect(resolved.rankRecencyWeight).toBe(0)
    expect(resolved.rankProofWeight).toBe(1.5)
    expect(resolved.queryRewrite).toBe(false)
    expect(resolved.injectItemBudgetStart).toBe(200)
    expect(resolved.injectItemBudgetDecay).toBe(0.8)
    expect(resolved.injectItemBudgetFloor).toBe(40)
    expect(resolved.assessReminder).toBe(false)
  })

  it('未知键 loud 失败', () => {
    expect(() => resolveConfig({ nope: 1 } as never)).toThrow(/unknown config key/)
  })

  it('profileTopN 越界 loud 失败', () => {
    expect(() => resolveConfig({ profileTopN: 0 })).toThrow(/profileTopN/)
    expect(() => resolveConfig({ profileTopN: 65 })).toThrow(/profileTopN/)
  })

  it('ingest 非法档位 loud 失败', () => {
    expect(() => resolveConfig({ ingest: 'aggressive' as never })).toThrow(/ingest/)
  })

  it('provider/model 只给其一 loud 失败', () => {
    expect(() => resolveConfig({ provider: 'deepseek' })).toThrow(/provider and model/)
    expect(() => resolveConfig({ model: 'v4' })).toThrow(/provider and model/)
  })

  it('decay 参数越界 loud 失败', () => {
    expect(() => resolveConfig({ decayAfterDays: 0 })).toThrow(/decayAfterDays/)
    expect(() => resolveConfig({ decayImportanceBelow: 2 })).toThrow(/decayImportanceBelow/)
  })

  it('injectTokenBudget 越界 loud 失败', () => {
    expect(() => resolveConfig({ injectTokenBudget: 127 })).toThrow(/injectTokenBudget/)
    expect(() => resolveConfig({ injectTokenBudget: 8193 })).toThrow(/injectTokenBudget/)
    expect(() => resolveConfig({ injectTokenBudget: 1024.5 })).toThrow(/injectTokenBudget/)
  })

  it('排序 boost 权重越界 loud 失败', () => {
    expect(() => resolveConfig({ rankRecencyWeight: -0.1 })).toThrow(/rankRecencyWeight/)
    expect(() => resolveConfig({ rankRecencyWeight: 2.1 })).toThrow(/rankRecencyWeight/)
    expect(() => resolveConfig({ rankProofWeight: 3 })).toThrow(/rankProofWeight/)
  })

  it('分级递减预算参数越界 loud 失败', () => {
    expect(() => resolveConfig({ injectItemBudgetStart: 39 })).toThrow(/injectItemBudgetStart/)
    expect(() => resolveConfig({ injectItemBudgetStart: 2001 })).toThrow(/injectItemBudgetStart/)
    expect(() => resolveConfig({ injectItemBudgetStart: 160.5 })).toThrow(/injectItemBudgetStart/)
    expect(() => resolveConfig({ injectItemBudgetDecay: 0.49 })).toThrow(/injectItemBudgetDecay/)
    expect(() => resolveConfig({ injectItemBudgetDecay: 1.01 })).toThrow(/injectItemBudgetDecay/)
    expect(() => resolveConfig({ injectItemBudgetFloor: 7 })).toThrow(/injectItemBudgetFloor/)
    expect(() => resolveConfig({ injectItemBudgetFloor: 201 })).toThrow(/injectItemBudgetFloor/)
  })

  it('floor 超过 start loud 失败（截断预算下限不得高于首条预算）', () => {
    expect(() => resolveConfig({ injectItemBudgetStart: 100, injectItemBudgetFloor: 101 }))
      .toThrow(/injectItemBudgetFloor/)
  })

  it('assessReminder 非布尔 loud 失败', () => {
    expect(() => resolveConfig({ assessReminder: 'yes' as never })).toThrow(/assessReminder/)
  })
})

describe('legacyMigration config', () => {
  it('accepts both policies', () => {
    expect(resolveConfig({ legacyMigration: 'eager' }).legacyMigration).toBe('eager')
    expect(resolveConfig({ legacyMigration: 'conservative' }).legacyMigration).toBe('conservative')
  })
  it.each(['typo', '', null, false, 1])('rejects invalid policy %s', (value) => {
    expect(() => resolveConfig({ legacyMigration: value as never })).toThrow(/legacyMigration/)
  })
})
