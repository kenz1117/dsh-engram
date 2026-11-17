/**
 * Мост к хосту DSH: провайдеры, их модели и ключи живут в одном месте — у хоста.
 *
 * Jev не хранит ни токен, ни адрес. Панель выбирает провайдера из числа
 * **настроенных** в DSH (`ctx.llm.listConfigurableProviders()`, отбор по признаку
 * `declared`), а реквизиты собираются в момент вызова:
 *   адрес  — шаблон от `baseURL` провайдера по выбранному протоколу (можно
 *            переопределить в настройках Jev);
 *   ключ   — из хранилища секретов по ссылке `apiKeyEnv` (`ctx.credentials.resolve`).
 *
 * Шаблон адреса зависит от протокола: `systemone` → `{baseURL}/systemone`
 * (проверено на живом провайдере: при `baseURL = https://api.aitunnel.ru/v1`
 * эндпоинт `…/v1/systemone` отвечает корректным Noul-ответом), `chat` →
 * `{baseURL}/chat/completions` (любой OpenAI-совместимый эндпоинт, см. ./client.ts).
 * Переопределённый адрес в обоих случаях проходит одну и ту же проверку
 * происхождения (`isTrustedJevEndpoint`): ключ хоста уезжает только тому же origin.
 *
 * Почему не через `ctx.llm.stream`: у Jev собственный контракт ответа (вероятности
 * по вопросам) и ленивая сборка реквизитов, поэтому HTTP-клиент остаётся свой,
 * а у хоста берутся только реквизиты — тогда токен вводится ровно в одном месте.
 *
 * @module @kenz1117/dsh-engram/jev/host
 */

import type { JevProtocol } from '../config.ts'
import { message } from '../i18n/messages.ts'

/** Минимальный вид сервиса `llm` хоста; лишние поля не читаем. */
interface HostLlm {
  listConfigurableProviders?: () => readonly HostConfigurableProvider[]
  listProviders?: () => readonly HostProvider[]
}

interface HostConfigurableProvider {
  readonly provider?: unknown
  readonly displayName?: unknown
  readonly settingsNs?: unknown
  readonly settingsPath?: unknown
  /** true = провайдер объявлен в настройках; false = взят из встроенного каталога. */
  readonly declared?: unknown
}

interface HostProvider {
  readonly id?: unknown
  readonly name?: unknown
}

/** Минимальный вид сервиса `settings` хоста. */
interface HostSettings {
  describe?: (options?: unknown) => Promise<readonly HostDescriptor[]>
}

interface HostDescriptor {
  readonly ns?: unknown
  readonly value?: unknown
}

/** Минимальный вид сервиса `credentials` хоста. */
interface HostCredentials {
  resolve?: (ref: string) => Promise<{ readonly value?: unknown } | undefined>
}

/** Вид контекста плагина: нужен только доступ к сервисам хоста по имени. */
export interface HostContext {
  get: (name: string) => unknown
}

/** Провайдер для панели: идентификатор, подпись, шаблоны адресов и модели из настроек. */
export interface JevProviderEntry {
  readonly id: string
  readonly displayName: string
  /** Корень API провайдера из настроек DSH; undefined = в настройках его нет. */
  readonly baseUrl: string | undefined
  /** Шаблон адреса System One, который панель подставляет в поле; undefined = не вывести. */
  readonly endpoint: string | undefined
  /** chat 协议的端点模板（{baseURL}/chat/completions）；undefined = 不输出。 */
  readonly chatEndpoint: string | undefined
  /** Модели из настроек провайдера (без обращения к сети); может быть пустым. */
  readonly models: readonly { readonly id: string; readonly name: string }[]
}

/** Каталог, который панель показывает в выпадающих списках. */
export interface JevCatalog {
  readonly providers: readonly JevProviderEntry[]
}

/** Собранное соединение: всё, что нужно HTTP-клиенту Jev для одного запроса. */
export interface JevConnection {
  /** Полный адрес эндпоинта (из настроек Jev либо шаблоном от провайдера по протоколу). */
  readonly endpoint: string
  readonly apiKey: string
  readonly model: string
  readonly timeoutMs: number
  /** 请求协议：systemone（私有 System One）或 chat（OpenAI 兼容 chat completions）。 */
  readonly protocol: JevProtocol
}

/** Живой список моделей провайдера (ответ `GET {baseURL}/models`). */
export interface JevModelList {
  readonly models: readonly string[]
  /** true = в списке нашлись Jev-модели и список сужен до них. */
  readonly filtered: boolean
  readonly error: string | undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

function readBoolean(record: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = record?.[key]
  return typeof value === 'boolean' ? value : undefined
}

/** Пройти по пути вида `['providers', 'aitunnel']` внутри конфигурации плагина хоста. */
function readPath(root: unknown, path: readonly string[]): unknown {
  let current: unknown = root
  for (const segment of path) {
    const record = asRecord(current)
    if (record === undefined) return undefined
    current = record[segment]
  }
  return current
}

/** Модели из конфигурации провайдера: `[{id, name}]`; битые записи пропускаем. */
function readModels(profile: Record<string, unknown> | undefined): { id: string; name: string }[] {
  const models = profile?.models
  if (!Array.isArray(models)) return []
  const result: { id: string; name: string }[] = []
  for (const entry of models) {
    const record = asRecord(entry)
    const id = readString(record, 'id')
    if (id === undefined) continue
    result.push({ id, name: readString(record, 'name') ?? id })
  }
  return result
}

/** Собрать адрес из корня и относительного пути, не теряя уже имеющийся `/`. */
function joinUrl(base: string, relative: string): string | undefined {
  try {
    return new URL(relative, base.endsWith('/') ? base : `${base}/`).toString()
  } catch {
    return undefined
  }
}

/**
 * Шаблон адреса System One от корня API провайдера.
 * `https://api.aitunnel.ru/v1` → `https://api.aitunnel.ru/v1/systemone`
 * (системный путь — сосед `/chat/completions` в том же корне API).
 */
export function systemOneEndpoint(baseUrl: string): string | undefined {
  return joinUrl(baseUrl, 'systemone')
}

/**
 * chat 协议的端点模板：由提供商 API 根推导（#59 chat 通道）。
 * `https://api.aitunnel.ru/v1` → `https://api.aitunnel.ru/v1/chat/completions`
 * （OpenAI 兼容服务器的标准路径，与 `/systemone` 同根相邻）。
 */
export function chatCompletionsEndpoint(baseUrl: string): string | undefined {
  return joinUrl(baseUrl, 'chat/completions')
}

/**
 * 宿主凭据只能发往 provider 配置中已信任的 origin。面板可以覆盖同源路径，
 * 但不能把存储在 DSH 凭据库里的 Bearer key 指向另一个服务。
 */
export function isTrustedJevEndpoint(baseUrl: string, endpoint: string): boolean {
  try {
    const trusted = new URL(baseUrl)
    const candidate = new URL(endpoint)
    return (candidate.protocol === 'http:' || candidate.protocol === 'https:')
      && candidate.username === ''
      && candidate.password === ''
      && candidate.origin === trusted.origin
  } catch {
    return false
  }
}

/** Дескриптор конфигурации хоста по namespace (например `llm-pi-ai`). */
async function readSettingsValue(ctx: HostContext, ns: string): Promise<unknown> {
  const settings = ctx.get('settings') as HostSettings | undefined
  if (settings?.describe === undefined) return undefined
  try {
    const descriptors = await settings.describe()
    for (const descriptor of descriptors) {
      if (descriptor.ns === ns) return descriptor.value
    }
  } catch {
    return undefined
  }
  return undefined
}

/** Конфигурация провайдера: подпись, `baseURL`, ссылка на ключ и модели. */
async function readProviderProfile(
  ctx: HostContext,
  providerId: string,
): Promise<Record<string, unknown> | undefined> {
  const llm = ctx.get('llm') as HostLlm | undefined
  const configurable = llm?.listConfigurableProviders?.() ?? []
  const entry = configurable.find(candidate => candidate.provider === providerId)
  if (entry === undefined) return undefined
  const ns = typeof entry.settingsNs === 'string' ? entry.settingsNs : undefined
  if (ns === undefined) return undefined
  // #59：区分「settingsPath 未声明」与「声明为空数组」。后者 = 配置就在文档根上
  //（DSH 自带的两个 DeepSeek 提供商都是平铺配置），空路径 readPath 天然返回根本身；
  // 只有前者才回退旧的嵌套约定 ['providers', providerId]。此前空数组也被回退成嵌套
  // 取值，取到 undefined，面板对这类提供商一律误报「未在 DSH 中配置」。
  const path = Array.isArray(entry.settingsPath)
    ? entry.settingsPath.filter((segment): segment is string => typeof segment === 'string')
    : undefined
  const value = await readSettingsValue(ctx, ns)
  if (value === undefined) return undefined
  const profile = readPath(value, path ?? ['providers', providerId])
  return asRecord(profile)
}

/** Ключ провайдера из хранилища секретов хоста по ссылке `apiKeyEnv`. */
async function readProviderKey(ctx: HostContext, profile: Record<string, unknown> | undefined): Promise<string> {
  const apiKeyEnv = readString(profile, 'apiKeyEnv')
  if (apiKeyEnv === undefined) return ''
  const credentials = ctx.get('credentials') as HostCredentials | undefined
  if (credentials?.resolve === undefined) return ''
  try {
    const hit = await credentials.resolve(apiKeyEnv)
    const value = hit?.value
    return typeof value === 'string' ? value : ''
  } catch {
    return ''
  }
}

/** Реквизиты провайдера, приведённые к одному виду; строка = текст ошибки. */
interface ProviderRekvisites {
  readonly baseUrl: string | undefined
  readonly apiKey: string
  readonly apiKeyEnv: string | undefined
  /** Модели из настроек провайдера — из них берётся замена пустому полю модели. */
  readonly modelIds: readonly string[]
}

async function readProviderRekvisites(
  ctx: HostContext,
  providerId: string,
): Promise<ProviderRekvisites | string> {
  if (ctx.get('llm') === undefined) return message('misc.jevHostLlmUnavailable')
  const profile = await readProviderProfile(ctx, providerId)
  if (profile === undefined) return message('misc.jevProviderNotConfigured', { provider: providerId })
  return {
    baseUrl: readString(profile, 'baseURL'),
    apiKey: await readProviderKey(ctx, profile),
    apiKeyEnv: readString(profile, 'apiKeyEnv'),
    modelIds: readModels(profile).map(item => item.id),
  }
}

/**
 * Каталог для панели: только провайдеры, настроенные в DSH, с шаблоном адреса
 * и моделями из настроек (без обращения к сети — живой список берётся отдельно).
 *
 * Реестр хоста отдаёт и весь встроенный каталог pi-ai (anthropic, openai, google
 * и ещё три десятка видов) — их пользователь не настраивал, и в выпадающем списке
 * Jev им делать нечего. Признак «свой» хост сообщает сам: `declared = true`
 * у провайдера, объявленного в настройках, и `false` — у взятого из каталога
 * (функция `directoryEntries` в `dsh-llm-pi-ai`; там же видно, что объявленные
 * идут в конце списка, после встроенных).
 *
 * @param ctx - контекст плагина (доступ к сервисам хоста по имени).
 * @returns настроенные провайдеры с моделями; пустой список, если хост не отдал ничего.
 */
export async function readJevCatalog(ctx: HostContext): Promise<JevCatalog> {
  const llm = ctx.get('llm') as HostLlm | undefined
  const configurable = llm?.listConfigurableProviders?.() ?? []
  const declared: JevProviderEntry[] = []
  const withProfile: JevProviderEntry[] = []
  const every: JevProviderEntry[] = []
  for (const entry of configurable) {
    const id = typeof entry.provider === 'string' ? entry.provider : undefined
    if (id === undefined) continue
    const profile = await readProviderProfile(ctx, id)
    const baseUrl = readString(profile, 'baseURL')
    const item: JevProviderEntry = {
      id,
      displayName: readString(asRecord(entry), 'displayName') ?? readString(profile, 'displayName') ?? id,
      baseUrl,
      endpoint: baseUrl === undefined ? undefined : systemOneEndpoint(baseUrl),
      chatEndpoint: baseUrl === undefined ? undefined : chatCompletionsEndpoint(baseUrl),
      models: readModels(profile),
    }
    every.push(item)
    if (profile !== undefined) withProfile.push(item)
    // Признак «настроен»: хост пометил провайдера объявленным. Если признака нет
    // (другая версия хоста), считаем настроенным того, у кого нашлась запись в настройках.
    const flag = readBoolean(asRecord(entry), 'declared')
    if (flag === true || (flag === undefined && profile !== undefined)) declared.push(item)
  }
  if (declared.length > 0) return { providers: declared }
  if (withProfile.length > 0) return { providers: withProfile }
  if (every.length > 0) return { providers: every }
  // Запасной путь: хост не отдал настраиваемых провайдеров — показываем хотя бы маршруты.
  const providers: JevProviderEntry[] = []
  for (const route of llm?.listProviders?.() ?? []) {
    const id = readString(route as Record<string, unknown>, 'id')
    if (id === undefined) continue
    providers.push({
      id,
      displayName: readString(route as Record<string, unknown>, 'name') ?? id,
      baseUrl: undefined,
      endpoint: undefined,
      chatEndpoint: undefined,
      models: [],
    })
  }
  return { providers }
}

/**
 * 提供商的活体模型列表：`GET {baseURL}/models`，与裁决同一把密钥。
 * systemone 协议把列表收窄到 Jev 模型——面板只提议真能以 System One 协议应答的模型；
 * chat 协议任何模型都能按 JSON 契约应答，因此整表下发、不做收窄。
 *
 * systemone 下若提供商没有 Jev 模型，则一个也不提议：其余模型不懂该协议，
 * 从它们里提示等于提示把裁决配坏。此时模型名手填——字段接受任意值。
 * 本函数不抛错：拒绝原因经 error 字段返回。
 * @param ctx - 插件上下文。
 * @param providerId - 所选 DSH 提供商。
 * @param protocol - 裁决协议；决定是否把列表收窄到 Jev 模型。
 */
export async function readProviderModels(
  ctx: HostContext,
  providerId: string,
  protocol: JevProtocol = 'systemone',
): Promise<JevModelList> {
  const rekvisites = await readProviderRekvisites(ctx, providerId)
  if (typeof rekvisites === 'string') return { models: [], filtered: false, error: rekvisites }
  if (rekvisites.baseUrl === undefined) {
    return {
      models: [],
      filtered: false,
      error: message('misc.jevProviderHasNoBaseUrl', { provider: providerId }),
    }
  }
  if (rekvisites.apiKey === '') {
    return {
      models: [],
      filtered: false,
      error: message('misc.jevProviderKeyMissing', { provider: providerId, ref: rekvisites.apiKeyEnv ?? '' }),
    }
  }
  const url = joinUrl(rekvisites.baseUrl, 'models')
  if (url === undefined) {
    return {
      models: [],
      filtered: false,
      error: message('misc.jevProviderHasNoBaseUrl', { provider: providerId }),
    }
  }
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${rekvisites.apiKey}` },
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) return { models: [], filtered: false, error: `HTTP ${response.status}` }
    const payload = (await response.json()) as { data?: unknown }
    const ids: string[] = []
    if (Array.isArray(payload.data)) {
      for (const entry of payload.data) {
        const id = readString(asRecord(entry), 'id')
        if (id !== undefined) ids.push(id)
      }
    }
    ids.sort((left, right) => left.localeCompare(right))
    // chat：任何模型都能按 JSON 契约应答（见 ./client.ts），无需收窄；
    // systemone：只留 Jev 模型。宁可空列表也不把不懂 System One 协议的模型端上来
    //（见上方说明）。
    if (protocol === 'chat') return { models: ids, filtered: false, error: undefined }
    const jevModels = ids.filter(id => /jev/i.test(id))
    return { models: jevModels, filtered: true, error: undefined }
  } catch (error) {
    return {
      models: [],
      filtered: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * 组装 Jev 连接：地址取 Jev 设置或按所选协议从提供商推导，密钥取宿主密钥库的
 * `apiKeyEnv` 引用，模型取 Jev 设置或提供商的第一台合适模型。
 * @param ctx - 插件上下文。
 * @param providerId - 所选 DSH 提供商；空 = 没有任何一方指定提供商。
 * @param model - 所选模型；空 = 用提供商的模型（见 `pickJevModel`）。
 * @param timeoutMs - 单次请求超时毫秒。
 * @param endpointOverride - Jev 设置里的地址；空 = 按提供商推导模板。
 * @param protocol - 裁决协议：systemone（默认）或 chat。
 * @returns 连接或错误文案（与 `parseJevPatch` 同一口径）。
 */
export async function resolveJevConnection(
  ctx: HostContext,
  providerId: string,
  model: string,
  timeoutMs: number,
  endpointOverride?: string,
  protocol: JevProtocol = 'systemone',
): Promise<JevConnection | string> {
  // 提供商可能谁都没指定：面板、cordis.yml、会话路由都没有。
  if (providerId.trim() === '') return message('misc.jevProviderUnresolved')
  const rekvisites = await readProviderRekvisites(ctx, providerId)
  if (typeof rekvisites === 'string') return rekvisites
  // 模型字段留空 = 「用该提供商的模型」：systemone 下聊天模型答不了 System One
  // 协议，静默代换会把裁决悄悄配坏——不如让 Jev 带着可见原因回落纯规则；
  // chat 下任何模型都行，取其设置里的第一台。
  const chosenModel = model.trim() !== '' ? model.trim() : pickJevModel(rekvisites.modelIds, protocol)
  if (chosenModel === undefined) return message('misc.jevModelNotPicked', { provider: providerId })
  const chosen = endpointOverride !== undefined && endpointOverride.trim() !== ''
    ? endpointOverride.trim()
    : undefined
  // 两协议共用同一守卫：宿主密钥只发往提供商 baseURL 同源，面板不得转投他处。
  if (chosen !== undefined && (rekvisites.baseUrl === undefined || !isTrustedJevEndpoint(rekvisites.baseUrl, chosen))) {
    return message('misc.jevEndpointOriginMismatch', { provider: providerId })
  }
  const endpoint = chosen ?? (rekvisites.baseUrl === undefined
    ? undefined
    : protocol === 'chat'
      ? chatCompletionsEndpoint(rekvisites.baseUrl)
      : systemOneEndpoint(rekvisites.baseUrl))
  if (endpoint === undefined) {
    return message('misc.jevProviderHasNoBaseUrl', { provider: providerId })
  }
  if (rekvisites.apiKey === '') {
    return message('misc.jevProviderKeyMissing', { provider: providerId, ref: rekvisites.apiKeyEnv ?? '' })
  }
  return { endpoint, apiKey: rekvisites.apiKey, model: chosenModel, timeoutMs, protocol }
}

/**
 * 提供商设置里第一台合适模型——模型字段留空时的代换值。
 * 顺序不重排：那是用户在 DSH 设置里亲自排的，选中的就该是他放在前面的那台。
 * @param modelIds - 提供商在 DSH 设置里的模型。
 * @param protocol - 裁决协议；systemone 找 Jev 模型，chat 取第一台。
 * @returns 模型名，或提供商没有合适模型时的 `undefined`。
 */
function pickJevModel(modelIds: readonly string[], protocol: JevProtocol): string | undefined {
  // chat：无需 jev 前缀——JSON 契约由客户端自己把守（见 ./client.ts）。
  return protocol === 'chat' ? modelIds[0] : modelIds.find(id => /jev/i.test(id))
}
