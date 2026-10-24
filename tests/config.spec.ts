import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'

describe('resolveConfig', () => {
  it('поля Jev прежнего формата не мешают разбору и предупреждают один раз', () => {
    // Конфигурация, написанная до переезда ключа к провайдеру хоста: разбор её пропускает,
    // но человеку один раз говорят, что ключ и адрес больше не читаются.
    const legacy = { enabled: true, apiKey: 'legacy-key', baseUrl: 'https://api.typesafe.ai' }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const resolved = resolveConfig({ jev: legacy } as never)
      expect(resolved.jev.enabled).toBe(true)
      expect(resolved.jev.provider).toBeUndefined()
      resolveConfig({ jev: legacy } as never)
      const said = warn.mock.calls.map(call => String(call[0]))
      expect(said.filter(line => line.includes('cordis.yml') && line.includes('jev.apiKey'))).toHaveLength(1)
      expect(said.filter(line => line.includes('cordis.yml') && line.includes('jev.baseUrl'))).toHaveLength(1)
    } finally {
      warn.mockRestore()
    }
  })

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

describe('jev config', () => {
  it('по умолчанию выключен: провайдер и модель не выбраны, три порога по умолчанию', () => {
    const resolved = resolveConfig({}).jev
    expect(resolved.enabled).toBe(false)
    expect(resolved.provider).toBeUndefined()
    expect(resolved.model).toBeUndefined()
    expect(resolved.endpoint).toBeUndefined()
    expect(resolved.timeoutMs).toBe(3000)
    expect(resolved.deferMergeAbove).toBe(0.85)
    expect(resolved.deferAcceptBelow).toBe(0.15)
    expect(resolved.contradictMinProbability).toBe(0.8)
  })

  it('явная конфигурация проходит целиком (адрес и ключ здесь больше не задаются)', () => {
    const resolved = resolveConfig({
      jev: { enabled: true, provider: 'aitunnel', model: 'jev-x', endpoint: 'https://j.example/v1/systemone', timeoutMs: 5000, deferMergeAbove: 0.9, deferAcceptBelow: 0.1, contradictMinProbability: 0.9 },
    }).jev
    expect(resolved.enabled).toBe(true)
    expect(resolved.provider).toBe('aitunnel')
    expect(resolved.model).toBe('jev-x')
    expect(resolved.endpoint).toBe('https://j.example/v1/systemone')
    expect(resolved.timeoutMs).toBe(5000)
    expect(resolved.deferMergeAbove).toBe(0.9)
    expect(resolved.deferAcceptBelow).toBe(0.1)
    expect(resolved.contradictMinProbability).toBe(0.9)
  })

  it('провайдер или модель — пустая строка: loud-ошибка', () => {
    expect(() => resolveConfig({ jev: { provider: '' } })).toThrow(/jev\.provider/)
    expect(() => resolveConfig({ jev: { provider: '   ' } })).toThrow(/jev\.provider/)
    expect(() => resolveConfig({ jev: { model: '' } })).toThrow(/jev\.model/)
  })

  it('адрес не http(s): loud-ошибка', () => {
    expect(() => resolveConfig({ jev: { endpoint: 'not-a-url' } })).toThrow(/jev\.endpoint/)
    expect(() => resolveConfig({ jev: { endpoint: 'ftp://j.example' } })).toThrow(/jev\.endpoint/)
  })

  it('enabled 非布尔 loud 失败', () => {
    expect(() => resolveConfig({ jev: { enabled: 'yes' as never } })).toThrow(/jev\.enabled/)
  })

  it('timeoutMs 越界或非整数 loud 失败', () => {
    expect(() => resolveConfig({ jev: { timeoutMs: 999 } })).toThrow(/jev\.timeoutMs/)
    expect(() => resolveConfig({ jev: { timeoutMs: 60001 } })).toThrow(/jev\.timeoutMs/)
    expect(() => resolveConfig({ jev: { timeoutMs: 2500.5 } })).toThrow(/jev\.timeoutMs/)
  })

  it('三阈值越界 loud 失败', () => {
    expect(() => resolveConfig({ jev: { deferMergeAbove: 0.4 } })).toThrow(/deferMergeAbove/)
    expect(() => resolveConfig({ jev: { deferAcceptBelow: 0.6 } })).toThrow(/deferAcceptBelow/)
    expect(() => resolveConfig({ jev: { contradictMinProbability: 0.2 } })).toThrow(/contradictMinProbability/)
  })

  it('deferAcceptBelow ≥ deferMergeAbove 交叉 loud 失败', () => {
    // 各自合法（端点 0.5）但组合无效：accept 阈值不得高于 merge 阈值。
    expect(() => resolveConfig({ jev: { deferAcceptBelow: 0.5, deferMergeAbove: 0.5 } })).toThrow(/less than/)
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

describe('embedder config', () => {
  // 现网画像里的真实取值：384 维多语言模型 + mean 池化。旧分支上没有 embedder 这个键，
  // 解析会直接抛 unknown config key——这条断言就是那次故障的防回归线。
  it('现网 profile 配置解析到多语言模型，kind 非法 loud 失败', () => {
    const resolved = resolveConfig({
      embedder: { kind: 'local', localModel: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', localPooling: 'mean' },
    }).embedder
    expect(resolved.kind).toBe('local')
    expect(resolved.localModel).toBe('Xenova/paraphrase-multilingual-MiniLM-L12-v2')
    expect(resolved.localPooling).toBe('mean')
    expect(resolved.remote).toBeUndefined()

    expect(() => resolveConfig({ embedder: { kind: 'nope' } as never })).toThrow(/embedder\.kind/)
  })

  // 作者要求不要静默忽略 `embedder` 块里的未知键：拼错字段名与「设置没生效」
  // 否则看起来一模一样。
  it('未知键在 embedder 块里同样 loud 失败', () => {
    expect(() => resolveConfig({ embedder: { lnocalModel: 'X' } as never })).toThrow(/unknown embedder key "lnocalModel"/)
  })

  it('remote 端点与环境变量名都落到解析后的配置', () => {
    const resolved = resolveConfig({
      embedder: { kind: 'remote', model: 'text-embedding-3-small', baseUrl: 'https://api.example.com/v1', apiKeyEnv: 'MY_KEY' },
    }).embedder
    expect(resolved.kind).toBe('remote')
    expect(resolved.remote?.apiKeyEnv).toBe('MY_KEY')
  })
})

describe('окно смены языка дворца', () => {
  it('по умолчанию 30 секунд, значение передаётся как есть', () => {
    // Пользователь просил менять длину окна без пересборки: «минута это много, 30 сек».
    expect(resolveConfig({}).palaceChangeWindowSec).toBe(30)
    expect(resolveConfig({ palaceChangeWindowSec: 45 }).palaceChangeWindowSec).toBe(45)
  })

  it('вне [5, 600] и не целое — ошибка, а не тихое приведение', () => {
    expect(() => resolveConfig({ palaceChangeWindowSec: 4 })).toThrow(/palaceChangeWindowSec/)
    expect(() => resolveConfig({ palaceChangeWindowSec: 601 })).toThrow(/palaceChangeWindowSec/)
    expect(() => resolveConfig({ palaceChangeWindowSec: 12.5 })).toThrow(/palaceChangeWindowSec/)
  })
})
