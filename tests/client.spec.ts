import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// 直导两个零 react 依赖的模块：client 层测试从 0 起步的第一步（审计批次 3）。
// 词典/插值行为与请求出口都不经组件渲染即可验证。
import { api, setProjectHealHandler, setActiveProjectSelector } from '../src/client/rpc.ts'
import { makeT, ruPluralForm } from '../src/client/translate.ts'
import { en, ru, zh } from '../src/client/locales/index.ts'

const REPLAY_KEYS = [
  'workfaceReplay', 'pageHeaderReplaySubtitle', 'replayFilterLabel', 'replayFilterPlaceholder', 'replayCount',
  'replayEmpty', 'replayFailed', 'replayOpen', 'replayClose', 'replayPacketTitle', 'replayMetaTitle',
  'replayExactNote', 'replaySession', 'replayHash', 'replayMemories', 'replayCurated', 'replayCompactions', 'replaySize',
] as const

const SHELL_KEYS = [
  'navWorkfaces', 'workfaceToday', 'workfaceRecall', 'workfaceMemory', 'workfaceGovernance',
  'workfaceReplay', 'workfaceSystem',
  // 二级导航与各工作面的副标题：0.13 把十个旧 tab 折进六个工作面后，视图名与说明各归其位。
  'memoryRecords', 'memoryTimeline', 'memoryEntities', 'memoryAtlas',
  'governanceConflicts', 'governanceBeliefs',
  'pageHeaderLibrarySubtitle', 'pageHeaderCorridorSubtitle', 'pageHeaderEpisodesSubtitle',
  'pageHeaderEntitiesSubtitle', 'pageHeaderBeliefsSubtitle', 'pageHeaderGovernanceSubtitle',
  'pageHeaderRecallSubtitle', 'pageHeaderTodaySubtitle',
  'pageHeaderSystemSubtitle', 'pageHeaderRuntimeSubtitle', 'pageHeaderStorageSubtitle',
  'pageHeaderModelsSubtitle', 'pageHeaderLogSubtitle', 'pageHeaderBackfillSubtitle',
  'pageHeaderJevSubtitle',
  'systemRuntime', 'systemStorage', 'systemModels',
  'systemVersionPlugin', 'systemVersionClient', 'systemVersionOk', 'systemVersionDiff',
  'systemJobsTitle', 'systemJobsUnavailable', 'systemJobsQueued', 'systemJobsRunning',
  'systemJobsDone', 'systemJobsDead', 'systemJobAttempts', 'systemJobError', 'systemJobEmpty',
  'systemStorageTotal', 'systemStorageActive', 'systemStorageArchived',
  'systemStorageForgotten', 'systemStorageOpLog', 'systemStorageLogSize', 'systemStorageLogPath',
  'systemStorageFailed', 'systemModelStatus', 'systemModelNone',
  'identityStable', 'identityRevision', 'identityRevisionNote',
] as const

const ATTENTION_KEYS = [
  'kpiExposures', 'attentionEmpty', 'attentionFailed', 'attentionGovernance', 'attentionJobsDead',
  'attentionJobsQueued', 'attentionJobsUnavailable',
] as const

const GOVERNANCE_KEYS = [
  'benchInspect', 'governanceTitle', 'governanceHint', 'governanceCount', 'governanceEmpty', 'governanceFailed',
  'governanceDismiss', 'governanceForgetSide', 'governanceForgetConfirm', 'governanceDismissHint',
  'governanceActionFailed', 'governanceStableId',
] as const

describe('context replay locale parity', () => {
  it('回放工作面的 18 个文案键在 zh/en/ru 三语齐备', () => {
    for (const key of REPLAY_KEYS) {
      expect(zh[key], `zh:${key}`).toBeTruthy()
      expect(en[key], `en:${key}`).toBeTruthy()
      expect(ru[key], `ru:${key}`).toBeTruthy()
    }
  })

  it('0.13 shell 的 7 个文案键在 zh/en/ru 三语齐备', () => {
    for (const key of SHELL_KEYS) {
      expect(zh[key], `zh:${key}`).toBeTruthy()
      expect(en[key], `en:${key}`).toBeTruthy()
      expect(ru[key], `ru:${key}`).toBeTruthy()
    }
  })

  it('Today 真实待办与曝光指标的 7 个文案键三语齐备', () => {
    for (const key of ATTENTION_KEYS) {
      expect(zh[key], `zh:${key}`).toBeTruthy()
      expect(en[key], `en:${key}`).toBeTruthy()
      expect(ru[key], `ru:${key}`).toBeTruthy()
    }
  })

  it('治理工作面的 10 个文案键在 zh/en/ru 三语齐备', () => {
    for (const key of GOVERNANCE_KEYS) {
      expect(zh[key], `zh:${key}`).toBeTruthy()
      expect(en[key], `en:${key}`).toBeTruthy()
      expect(ru[key], `ru:${key}`).toBeTruthy()
    }
  })
})

describe('ruPluralForm（俄语复数三段式选择）', () => {
  it('1 / 21 / 101 → one；2-4 / 22-24 → few；其余 → many', () => {
    expect(ruPluralForm(1)).toBe(0)
    expect(ruPluralForm(21)).toBe(0)
    expect(ruPluralForm(101)).toBe(0)
    expect(ruPluralForm(2)).toBe(1)
    expect(ruPluralForm(4)).toBe(1)
    expect(ruPluralForm(22)).toBe(1)
    expect(ruPluralForm(24)).toBe(1)
    expect(ruPluralForm(5)).toBe(2)
    expect(ruPluralForm(11)).toBe(2)
    expect(ruPluralForm(12)).toBe(2)
    expect(ruPluralForm(25)).toBe(2)
    expect(ruPluralForm(0)).toBe(2)
  })
})

describe('makeT（面板级合成 t）', () => {
  it('{param} 插值；缺参保留原样', () => {
    const t = makeT('zh')
    const out = t('loadFailed' as never, { msg: 'HTTP 502' }) as unknown as string
    expect(out).toContain('HTTP 502')
    // 缺参：占位符不被吞掉，方便排查。
    expect(t('loadFailed' as never)).toContain('{msg}')
  })

  it('ru 复数键按 n 选段：1 分钟 / 2 分钟 / 5 分钟 三种词形', () => {
    const t = makeT('ru')
    expect(t('timeMinutesAgo' as never, { n: 1 })).toContain('минуту назад')
    expect(t('timeMinutesAgo' as never, { n: 2 })).toContain('минуты назад')
    expect(t('timeMinutesAgo' as never, { n: 5 })).toContain('минут назад')
    expect(t('timeMinutesAgo' as never, { n: 21 })).toContain('минуту назад')
  })

  it('未知键回退键名本身（不抛错）', () => {
    expect(makeT('en')('no.such.key' as never)).toBe('no.such.key')
  })
})

describe('api()（唯一请求出口）', () => {
  beforeEach(() => {
    setActiveProjectSelector(null)
    setProjectHealHandler(null)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    setActiveProjectSelector(null)
    setProjectHealHandler(null)
  })

  const okResponse = (body: string, status = 200): Response => new Response(body, { status, headers: { 'content-type': 'application/json' } })

  it('2xx JSON 原样解析返回', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse('{"ok":true,"value":7}')))
    await expect(api<{ ok: boolean; value: number }>('stats')).resolves.toEqual({ ok: true, value: 7 })
  })

  it('非 2xx 带 JSON error：抛 body.error 文案', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse('{"error":"id required"}', 400)))
    await expect(api('stats')).rejects.toThrow('id required')
  })

  it('代理错误页（HTML）不再伪装成 Unexpected token <——审计批次1：先判 ok 再解析', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>502 Bad Gateway</html>', { status: 502 })))
    const error = await api('stats').then(() => undefined, (cause: Error) => cause)
    expect(error).toBeInstanceOf(Error)
    expect(error?.message).toBe('HTTP 502')
  })

  it('2xx 空 body：显式报 HTTP 200 而非 SyntaxError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    await expect(api('stats')).rejects.toThrow('HTTP 200')
  })

  it('project 选择器注入 GET：query 追加 project 参数', async () => {
    setActiveProjectSelector('project-demo.db')
    const fetchMock = vi.fn(async (_url: string) => okResponse('{}'))
    vi.stubGlobal('fetch', fetchMock)
    await api('stats?scope=project')
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/api/engram/stats?scope=project&project=project-demo.db')
  })

  it('project 作用域 POST：选择器写进 JSON body（带 content-type 缺省补齐）', async () => {
    setActiveProjectSelector('project-demo.db')
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => okResponse('{}'))
    vi.stubGlobal('fetch', fetchMock)
    await api('update', { method: 'POST', body: JSON.stringify({ id: 'a', scope: 'project' }) })
    const calledInit = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect((calledInit.headers as Headers).get('content-type')).toBe('application/json')
    expect(JSON.parse(String(calledInit.body))).toEqual({ id: 'a', scope: 'project', project: 'project-demo.db' })
  })

  it('固定分库 404 unknown project：触发一次自愈后照常抛错', async () => {
    setActiveProjectSelector('project-dead.db')
    const heal = vi.fn()
    setProjectHealHandler(heal)
    vi.stubGlobal('fetch', vi.fn(async () => okResponse('{"error":"unknown project"}', 404)))
    await expect(api('stats?scope=project')).rejects.toThrow('unknown project')
    expect(heal).toHaveBeenCalledTimes(1)
    // 跟随态（无选择器）的 404 不触发自愈。
    setActiveProjectSelector(null)
    await expect(api('stats')).rejects.toThrow('unknown project')
    expect(heal).toHaveBeenCalledTimes(1)
  })
})
