import { statSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedJevConfig } from '../src/config.ts'
import type { HostContext } from '../src/jev/host.ts'
import { readJevCatalog, readProviderModels, resolveJevConnection } from '../src/jev/host.ts'
import {
  effectiveJevConfig,
  jevConfigView,
  jevOverridePath,
  loadJevOverride,
  parseJevPatch,
  resolveJevField,
  saveJevOverride,
} from '../src/jev/runtime.ts'

/**
 * Заглушка контекста хоста: адрес и ключ разрешаются лениво — при первом вопросе
 * судьи, — поэтому самой сборке судьи достаточно пустого доступа к сервисам.
 */
const hostStub: HostContext = { get: () => undefined }

/** База из cordis.yml: пустое перекрытие отдаёт её как есть, а три порога всегда берутся отсюда. */
const baseConfig: ResolvedJevConfig = {
  enabled: true,
  provider: 'aitunnel',
  model: 'jev-1',
  endpoint: undefined,
  protocol: 'systemone',
  timeoutMs: 3000,
  deferMergeAbove: 0.85,
  deferAcceptBelow: 0.15,
  contradictMinProbability: 0.8,
}

/**
 * Заглушка хоста для каталога провайдеров: `listConfigurableProviders` отдаёт и встроенные
 * виды, и объявленные; настройки содержат запись только для объявленного провайдера.
 */
function hostWithCatalog(options: {
  readonly declared?: boolean | undefined
  readonly configurable?: readonly Record<string, unknown>[]
  readonly routes?: readonly Record<string, unknown>[]
  readonly models?: readonly Record<string, unknown>[]
} = {}): HostContext {
  const configurable = options.configurable ?? [
    { provider: 'anthropic', displayName: 'anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'], ...(options.declared === undefined ? {} : { declared: options.declared }) },
    { provider: 'aitunnel', displayName: 'aitunnel', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'aitunnel'], declared: true },
  ]
  return {
    get: (name: string) => {
      if (name === 'llm') {
        return {
          listConfigurableProviders: () => configurable,
          listProviders: () => options.routes ?? [{ id: 'deepseek', name: 'DeepSeek' }],
        }
      }
      if (name === 'settings') {
        return {
          describe: async () => [{
            ns: 'llm-pi-ai',
            value: {
              providers: {
                aitunnel: {
                  displayName: 'AITunnel',
                  baseURL: 'https://api.aitunnel.ru/v1',
                  apiKeyEnv: 'AITUNNEL_API_KEY',
                  models: options.models ?? [{ id: 'jev-1.13', name: 'Jev 1.13' }],
                },
              },
            },
          }],
        }
      }
      if (name === 'credentials') return { resolve: async () => ({ value: 'host-key' }) }
      return undefined
    },
  }
}

describe('readJevCatalog', () => {
  it('отсекает встроенный каталог хоста: остаются только настроенные провайдеры', async () => {
    const catalog = await readJevCatalog(hostWithCatalog())
    expect(catalog.providers.map(provider => provider.id)).toEqual(['aitunnel'])
    expect(catalog.providers[0]?.baseUrl).toBe('https://api.aitunnel.ru/v1')
    expect(catalog.providers[0]?.endpoint).toBe('https://api.aitunnel.ru/v1/systemone')
    // chat 协议的端点模板随目录一并下发，面板按当前协议取用（#59 chat 通道）。
    expect(catalog.providers[0]?.chatEndpoint).toBe('https://api.aitunnel.ru/v1/chat/completions')
    expect(catalog.providers[0]?.models).toEqual([{ id: 'jev-1.13', name: 'Jev 1.13' }])
  })

  it('признака declared нет (другая версия хоста): настроенным считается тот, у кого есть запись в настройках', async () => {
    const catalog = await readJevCatalog(hostWithCatalog({ declared: undefined }))
    // anthropic без признака и без записи в настройках отсекается, aitunnel (declared: true) остаётся.
    expect(catalog.providers.map(provider => provider.id)).toEqual(['aitunnel'])
  })

  it('хост не отдал настраиваемых провайдеров: падаем на маршруты, а не на пустой список', async () => {
    const catalog = await readJevCatalog(hostWithCatalog({ configurable: [] }))
    expect(catalog.providers.map(provider => provider.id)).toEqual(['deepseek'])
    expect(catalog.providers[0]?.displayName).toBe('DeepSeek')
  })

  // #59 回归：DSH 自带的 DeepSeek 提供商是平铺配置——settingsPath 声明为空数组、
  // baseURL 就在 ns 文档根上。修复前空数组被回退成 ['providers', providerId] 嵌套取值，
  // 取到 undefined，面板对这类提供商一律误报「未在 DSH 中配置」。
  it('#59 回归:settingsPath 空数组 = 配置在文档根上,照常读出 baseURL 与密钥', async () => {
    const host: HostContext = {
      get: (name: string) => {
        if (name === 'llm') {
          return {
            listConfigurableProviders: () => [{
              provider: 'deepseek',
              displayName: 'DeepSeek',
              settingsNs: 'llm-deepseek',
              settingsPath: [],
              declared: true,
            }],
          }
        }
        if (name === 'settings') {
          return {
            describe: async () => [{
              ns: 'llm-deepseek',
              value: {
                baseURL: 'https://api.deepseek.com/v1',
                apiKeyEnv: 'DEEPSEEK_KEY',
                models: [{ id: 'jev-1.13', name: 'Jev 1.13' }],
              },
            }],
          }
        }
        if (name === 'credentials') return { resolve: async () => ({ value: 'ds-key' }) }
        return undefined
      },
    }
    const catalog = await readJevCatalog(host)
    expect(catalog.providers.map(provider => provider.id)).toEqual(['deepseek'])
    expect(catalog.providers[0]?.baseUrl).toBe('https://api.deepseek.com/v1')
    expect(catalog.providers[0]?.endpoint).toBe('https://api.deepseek.com/v1/systemone')
    expect(catalog.providers[0]?.chatEndpoint).toBe('https://api.deepseek.com/v1/chat/completions')
    const connection = await resolveJevConnection(host, 'deepseek', '', 3000)
    expect(connection).toEqual({
      endpoint: 'https://api.deepseek.com/v1/systemone',
      apiKey: 'ds-key',
      model: 'jev-1.13',
      timeoutMs: 3000,
      protocol: 'systemone',
    })
  })

  it('#59 回归:settingsPath 未声明才回退旧嵌套约定 [providers, providerId]', async () => {
    // 与 hostWithCatalog 同构，但 settingsPath 键整个缺失（旧版宿主）。
    const host: HostContext = {
      get: (name: string) => {
        if (name === 'llm') {
          return {
            listConfigurableProviders: () => [{
              provider: 'legacy',
              displayName: 'Legacy',
              settingsNs: 'llm-pi-ai',
              declared: true,
            }],
          }
        }
        if (name === 'settings') {
          return {
            describe: async () => [{
              ns: 'llm-pi-ai',
              value: {
                providers: {
                  legacy: {
                    baseURL: 'https://legacy.test/v1',
                    apiKeyEnv: 'LEGACY_KEY',
                    models: [{ id: 'jev-1', name: 'Jev 1' }],
                  },
                },
              },
            }],
          }
        }
        if (name === 'credentials') return { resolve: async () => ({ value: 'legacy-key' }) }
        return undefined
      },
    }
    const catalog = await readJevCatalog(host)
    expect(catalog.providers[0]?.baseUrl).toBe('https://legacy.test/v1')
  })
})

describe('loadJevOverride', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'engram-jev-runtime-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('файла перекрытия нет: пустое перекрытие, работает yml', () => {
    expect(loadJevOverride(dir)).toEqual({})
  })

  it('битый JSON: самолечение пустым перекрытием, без исключения', async () => {
    await writeFile(jevOverridePath(dir), '{ not json', 'utf8')
    expect(loadJevOverride(dir)).toEqual({})
  })

  it('валидный JSON, но не объект (число/строка/null): пустое перекрытие', async () => {
    await writeFile(jevOverridePath(dir), '42', 'utf8')
    expect(loadJevOverride(dir)).toEqual({})
    await writeFile(jevOverridePath(dir), '"text"', 'utf8')
    expect(loadJevOverride(dir)).toEqual({})
    await writeFile(jevOverridePath(dir), 'null', 'utf8')
    expect(loadJevOverride(dir)).toEqual({})
  })

  it('негодные по типу и неизвестные поля отбрасываются, годные остаются', async () => {
    await writeFile(
      jevOverridePath(dir),
      JSON.stringify({
        enabled: 'yes',
        provider: 123,
        model: 'panel-model',
        endpoint: 'https://panel.test/v1/systemone',
        timeoutMs: 1.5,
        unknown: 'ignored',
      }),
      'utf8',
    )
    expect(loadJevOverride(dir)).toEqual({
      model: 'panel-model',
      endpoint: 'https://panel.test/v1/systemone',
    })
  })

  it('поля старого формата (apiKey/baseUrl) игнорируются, о чём предупреждаем один раз', async () => {
    // Файл прежней версии: ключ и адрес плагин больше не хранит — их место занял выбор провайдера.
    await writeFile(
      jevOverridePath(dir),
      JSON.stringify({ enabled: true, apiKey: 'legacy-key', baseUrl: 'https://api.aitunnel.ru', model: 'jev-1.13' }),
      'utf8',
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(loadJevOverride(dir)).toEqual({ enabled: true, model: 'jev-1.13' })
      // Второе чтение того же файла: судья собирается на каждой записи, текст не должен повторяться.
      expect(loadJevOverride(dir)).toEqual({ enabled: true, model: 'jev-1.13' })
      const said = warn.mock.calls.map(call => String(call[0]))
      expect(said.filter(line => line.includes('jev-config.json') && line.includes('jev.apiKey'))).toHaveLength(1)
      expect(said.filter(line => line.includes('jev-config.json') && line.includes('jev.baseUrl'))).toHaveLength(1)
    } finally {
      warn.mockRestore()
    }
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

  it('после сохранения читается тот же объект, права файла 0600', () => {
    const override = { enabled: false, provider: 'aitunnel', model: 'jev-2' }
    saveJevOverride(dir, override)
    expect(loadJevOverride(dir)).toEqual(override)
    // mode 与 0o777 取与：屏蔽文件类型位，只比权限位。
    // Windows 不维护 POSIX 权限位（stat 回报 0o666），断言仅对 POSIX 生效（#13 贡献者实录）。
    if (process.platform !== 'win32') {
      expect(statSync(jevOverridePath(dir)).mode & 0o777).toBe(0o600)
    }
  })
})

describe('parseJevPatch', () => {
  /** База слияния: проверяет сохранение отсутствующих полей и очистку пустой строкой. */
  const current = { enabled: true, provider: 'aitunnel', model: 'old-model', timeoutMs: 3000 }

  it('пустая правка: поверхностная копия current, все поля сохранены', () => {
    expect(parseJevPatch(current, {})).toEqual(current)
  })

  it('enabled не булево: правка отвергается целиком', () => {
    expect(parseJevPatch(current, { enabled: 'yes' })).toBe('invalid: jev.enabled 必须是布尔值')
  })

  it('provider не строка: правка отвергается целиком', () => {
    expect(parseJevPatch(current, { provider: 123 })).toBe('invalid: jev.provider 必须是字符串')
  })

  it('provider — пустая строка или пробелы: выбор снимается (Jev молча уходит в чистые правила)', () => {
    expect(parseJevPatch(current, { provider: '' })).toEqual({ ...current, provider: undefined })
    expect(parseJevPatch(current, { provider: '   ' })).toEqual({ ...current, provider: undefined })
  })

  it('provider непустой: сохраняется без крайних пробелов', () => {
    expect(parseJevPatch(current, { provider: '  aitunnel  ' })).toEqual({ ...current, provider: 'aitunnel' })
  })

  it('endpoint негодный (не URL или не http(s)): правка отвергается целиком', () => {
    expect(parseJevPatch(current, { endpoint: 'not-a-url' })).toBe('invalid: jev.endpoint 必须是 http(s) URL')
    expect(parseJevPatch(current, { endpoint: 'ftp://panel.test' })).toBe('invalid: jev.endpoint 必须是 http(s) URL')
  })

  it('endpoint годный http(s): сохраняется без крайних пробелов', () => {
    expect(parseJevPatch(current, { endpoint: ' http://panel.test/v1/systemone ' }))
      .toEqual({ ...current, endpoint: 'http://panel.test/v1/systemone' })
  })

  it('endpoint — пустая строка: адрес очищается, возвращается шаблон от провайдера', () => {
    const withEndpoint = { ...current, endpoint: 'https://panel.test/v1/systemone' }
    expect(parseJevPatch(withEndpoint, { endpoint: '' })).toEqual({ ...current, endpoint: undefined })
  })

  it('model пустой или не строка: пустая строка снимает выбор, не строка — отказ', () => {
    // Пустая строка означает «модель не выбрана» — так же, как и у провайдера.
    expect(parseJevPatch(current, { model: '   ' })).toEqual({ ...current, model: undefined })
    expect(parseJevPatch(current, { model: 42 })).toBe('invalid: jev.model 不能为空')
    expect(parseJevPatch(current, { model: ' m ' })).toEqual({ ...current, model: 'm' })
  })

  it('timeoutMs не целое или вне границ: правка отвергается; границы 1000/60000 проходят', () => {
    expect(parseJevPatch(current, { timeoutMs: 999 })).toBe('invalid: jev.timeoutMs 必须是 1000-60000 的整数毫秒')
    expect(parseJevPatch(current, { timeoutMs: 60001 })).toBe('invalid: jev.timeoutMs 必须是 1000-60000 的整数毫秒')
    expect(parseJevPatch(current, { timeoutMs: 1.5 })).toBe('invalid: jev.timeoutMs 必须是 1000-60000 的整数毫秒')
    expect(parseJevPatch(current, { timeoutMs: '3000' })).toBe('invalid: jev.timeoutMs 必须是 1000-60000 的整数毫秒')
    expect(parseJevPatch(current, { timeoutMs: 1000 })).toEqual({ ...current, timeoutMs: 1000 })
    expect(parseJevPatch(current, { timeoutMs: 60000 })).toEqual({ ...current, timeoutMs: 60000 })
  })

  it('негодное поле отвергает правку целиком: годные поля тоже не сохраняются', () => {
    const result = parseJevPatch(current, { model: 'good', timeoutMs: 1 })
    expect(result).toBe('invalid: jev.timeoutMs 必须是 1000-60000 的整数毫秒')
  })

  // #59 chat 通道：协议是面板可覆盖字段，非法值同样整条 patch 拒绝（all-or-nothing）。
  it('protocol 非法值(非字符串或未知名字):整条 patch 拒绝', () => {
    expect(parseJevPatch(current, { protocol: 'grpc' })).toBe('invalid: jev.protocol 必须是 systemone|chat')
    expect(parseJevPatch(current, { protocol: 'SYSTEMONE' })).toBe('invalid: jev.protocol 必须是 systemone|chat')
    expect(parseJevPatch(current, { protocol: 42 })).toBe('invalid: jev.protocol 必须是 systemone|chat')
    // 连带 годные 字段一并拒绝，保持 all-or-nothing。
    expect(parseJevPatch(current, { protocol: 'grpc', model: 'good' })).toBe('invalid: jev.protocol 必须是 systemone|chat')
  })

  it('protocol 合法值写入;空串清除选择(跟随 yml)', () => {
    expect(parseJevPatch(current, { protocol: 'chat' })).toEqual({ ...current, protocol: 'chat' })
    expect(parseJevPatch(current, { protocol: ' systemone ' })).toEqual({ ...current, protocol: 'systemone' })
    const withProtocol = { ...current, protocol: 'chat' as const }
    expect(parseJevPatch(withProtocol, { protocol: '' })).toEqual(current)
  })
})

describe('effectiveJevConfig', () => {
  it('пустое перекрытие: база отдаётся как есть', () => {
    expect(effectiveJevConfig(baseConfig, {})).toEqual(baseConfig)
  })

  it('поля панели перекрывают базу, три порога всегда из базы', () => {
    const merged = effectiveJevConfig(baseConfig, {
      enabled: true,
      provider: 'panel-provider',
      model: 'panel-model',
      endpoint: 'https://panel.test/v1/systemone',
      timeoutMs: 5000,
    })
    expect(merged.provider).toBe('panel-provider')
    expect(merged.model).toBe('panel-model')
    expect(merged.endpoint).toBe('https://panel.test/v1/systemone')
    expect(merged.timeoutMs).toBe(5000)
    expect(merged.deferMergeAbove).toBe(0.85)
    expect(merged.deferAcceptBelow).toBe(0.15)
    expect(merged.contradictMinProbability).toBe(0.8)
  })

  it('провайдер и модель вправе остаться неназванными: enabled сохраняется, доопределение — в момент вопроса', () => {
    const noProvider = effectiveJevConfig({ ...baseConfig, provider: undefined }, { enabled: true })
    expect(noProvider.enabled).toBe(true)
    expect(noProvider.provider).toBeUndefined()
    const noModel = effectiveJevConfig({ ...baseConfig, model: undefined }, { enabled: true })
    expect(noModel.enabled).toBe(true)
    expect(noModel.model).toBeUndefined()
  })

  it('поле панели очищено: это «не названо», база из yml остаётся в силе', () => {
    const merged = effectiveJevConfig(baseConfig, { enabled: true, provider: '', model: '' })
    expect(merged.enabled).toBe(true)
    expect(merged.provider).toBe('aitunnel')
    expect(merged.model).toBe('jev-1')
  })

  it('панель выключает тумблер: Jev выключен', () => {
    const merged = effectiveJevConfig(baseConfig, { enabled: false })
    expect(merged.enabled).toBe(false)
  })

  // #59 chat 通道：protocol 是第六个面板可覆盖字段；覆盖文件（旧版）没有该键时
  // 合并语义 = 跟随 yml（base 的 protocol 在 resolveConfig 已落默认值 systemone）。
  it('protocol:面板覆盖优先,缺省继承 yml', () => {
    expect(effectiveJevConfig(baseConfig, { protocol: 'chat' }).protocol).toBe('chat')
    expect(effectiveJevConfig(baseConfig, {}).protocol).toBe('systemone')
    const chatBase = { ...baseConfig, protocol: 'chat' as const }
    expect(effectiveJevConfig(chatBase, {}).protocol).toBe('chat')
  })
})

describe('jevConfigView', () => {
  it('выбор провайдера и модели отдаётся как есть, ключа и адреса в виде нет', () => {
    const view = jevConfigView(baseConfig, {})
    expect(view.enabled).toBe(true)
    expect(view.provider).toBe('aitunnel')
    expect(view.model).toBe('jev-1')
    expect(view.endpoint).toBeUndefined()
    expect(view.protocol).toBe('systemone')
    expect(view.timeoutMs).toBe(3000)
    expect(view.deferMergeAbove).toBe(0.85)
    expect(view.deferAcceptBelow).toBe(0.15)
    expect(view.contradictMinProbability).toBe(0.8)
  })

  it('провайдер не назван: тумблер всё равно включён — провайдера подставит маршрут сессии', () => {
    const view = jevConfigView({ ...baseConfig, provider: undefined }, {})
    expect(view.enabled).toBe(true)
    expect(view.provider).toBeUndefined()
  })

  it('панель выбрала chat: вид показывает его, чтобы селектор не прыгал при перезагрузке', () => {
    expect(jevConfigView(baseConfig, { protocol: 'chat' }).protocol).toBe('chat')
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

  it('yml включён, выбор сделан, файла перекрытия нет: поставщик отдаёт судью', () => {
    const field = resolveJevField(hostStub, baseConfig, dir)
    expect(typeof field.resolveJudge()?.ask).toBe('function')
  })

  it('yml выключен: поставщик отдаёт undefined, судья не собирается', () => {
    expect(resolveJevField(hostStub, { ...baseConfig, enabled: false }, dir).resolveJudge()).toBeUndefined()
  })

  it('провайдер не назван никем: судья собирается, причину назовёт момент вопроса', () => {
    const field = resolveJevField(hostStub, { ...baseConfig, provider: undefined, model: undefined }, dir)
    expect(typeof field.resolveJudge()?.ask).toBe('function')
  })

  it('наследование маршрута сессии: читатель провайдера спрашивается не при сборке судьи, а при вопросе', () => {
    let asked = 0
    const field = resolveJevField(hostStub, { ...baseConfig, provider: undefined, model: undefined }, dir, () => {
      asked += 1
      return 'from-session'
    })
    // Реквизиты соединения собираются при первом вопросе, а не при сборке судьи,
    // поэтому смена маршрута посреди сессии подхватывается сама.
    expect(typeof field.resolveJudge()?.ask).toBe('function')
    expect(asked).toBe(0)
  })

  it('панель выключает и включает тумблер: тот же поставщик следует за файлом, перезапуск не нужен', () => {
    const field = resolveJevField(hostStub, baseConfig, dir)
    expect(typeof field.resolveJudge()?.ask).toBe('function')
    saveJevOverride(dir, { enabled: false })
    expect(field.resolveJudge()).toBeUndefined()
    saveJevOverride(dir, { enabled: true })
    expect(typeof field.resolveJudge()?.ask).toBe('function')
  })

  it('панель добавляет выбор: без провайдера в yml судья всё равно собирается', async () => {
    saveJevOverride(dir, { enabled: true, provider: 'aitunnel', model: 'jev-1' })
    const field = resolveJevField(hostStub, { ...baseConfig, provider: undefined }, dir)
    expect(typeof field.resolveJudge()?.ask).toBe('function')
  })
})

describe('resolveJevConnection: провайдер и модель доопределяются лениво', () => {
  it('модель не названа: берётся первая Jev-модель провайдера из его настроек', async () => {
    const connection = await resolveJevConnection(hostWithCatalog(), 'aitunnel', '', 3000)
    expect(connection).toEqual({
      endpoint: 'https://api.aitunnel.ru/v1/systemone',
      apiKey: 'host-key',
      model: 'jev-1.13',
      timeoutMs: 3000,
      protocol: 'systemone',
    })
  })

  it('модель названа вручную: подстановка не перебивает имя, данное пользователем', async () => {
    const connection = await resolveJevConnection(hostWithCatalog(), 'aitunnel', 'systemone-2', 3000)
    expect(connection).toMatchObject({ model: 'systemone-2' })
  })

  it('у провайдера нет Jev-моделей: чужая модель не подставляется, причина названа', async () => {
    const host = hostWithCatalog({ models: [{ id: 'gpt-4o', name: 'GPT-4o' }] })
    const result = await resolveJevConnection(host, 'aitunnel', '', 3000)
    expect(typeof result).toBe('string')
    expect(result).toContain('JEV')
  })

  it('провайдера не назвал никто: причина вместо соединения', async () => {
    const result = await resolveJevConnection(hostWithCatalog(), '', 'jev-1.13', 3000)
    expect(typeof result).toBe('string')
    expect(result).toContain('Jev')
    expect(result).not.toContain('aitunnel')
  })

  // #59 chat 通道：端点推导为 {baseURL}/chat/completions，模型兜底不再要求 jev 前缀。
  it('chat 协议:端点推导 chat/completions,模型兜底取第一台(无 jev 前缀要求)', async () => {
    const host = hostWithCatalog({ models: [{ id: 'gpt-4o', name: 'GPT-4o' }, { id: 'claude-3', name: 'Claude' }] })
    const connection = await resolveJevConnection(host, 'aitunnel', '', 3000, undefined, 'chat')
    expect(connection).toEqual({
      endpoint: 'https://api.aitunnel.ru/v1/chat/completions',
      apiKey: 'host-key',
      // 顺序不重排：用户排在设置前面的那台优先。
      model: 'gpt-4o',
      timeoutMs: 3000,
      protocol: 'chat',
    })
  })

  it('chat 协议:同源守卫不变,跨 origin 的覆写仍被拒绝', async () => {
    const result = await resolveJevConnection(
      hostWithCatalog(),
      'aitunnel',
      'gpt-4o',
      3000,
      'https://attacker.invalid/v1/chat/completions',
      'chat',
    )
    expect(typeof result).toBe('string')
    expect(result).toContain('同源')
  })
})

describe('readProviderModels: в подсказки идут только Jev-модели', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  /** Живой список моделей провайдера подменяется: наружу теста сеть не выходит. */
  const respond = (ids: readonly string[]): void => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: ids.map(id => ({ id })) }),
    }))
  }

  it('Jev-модели есть: список сужается до них', async () => {
    respond(['gpt-4o', 'jev-1.13'])
    const list = await readProviderModels(hostWithCatalog(), 'aitunnel')
    expect(list).toEqual({ models: ['jev-1.13'], filtered: true, error: undefined })
  })

  it('Jev-моделей нет: не предлагается ничего — остальные протокол не понимают', async () => {
    respond(['gpt-4o', 'claude-3'])
    const list = await readProviderModels(hostWithCatalog(), 'aitunnel')
    expect(list).toEqual({ models: [], filtered: true, error: undefined })
  })

  // #59 chat 通道：chat 下任何模型都能按 JSON 契约应答，列表整表下发、不收窄。
  it('chat 协议:整表下发,不按 jev 前缀收窄', async () => {
    respond(['gpt-4o', 'jev-1.13', 'claude-3'])
    const list = await readProviderModels(hostWithCatalog(), 'aitunnel', 'chat')
    expect(list).toEqual({ models: ['claude-3', 'gpt-4o', 'jev-1.13'], filtered: false, error: undefined })
  })
})
