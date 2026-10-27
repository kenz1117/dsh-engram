/**
 * Мост к хосту DSH: провайдеры, их модели и ключи живут в одном месте — у хоста.
 *
 * Jev не хранит ни токен, ни адрес. Панель выбирает провайдера из числа
 * **настроенных** в DSH (`ctx.llm.listConfigurableProviders()`, отбор по признаку
 * `declared`), а реквизиты собираются в момент вызова:
 *   адрес  — шаблон от `baseURL` провайдера (можно переопределить в настройках Jev);
 *   ключ   — из хранилища секретов по ссылке `apiKeyEnv` (`ctx.credentials.resolve`).
 *
 * Шаблон адреса: `{baseURL}/systemone`. Проверено на живом провайдере: при
 * `baseURL = https://api.aitunnel.ru/v1` эндпоинт `…/v1/systemone` отвечает
 * корректным Noul-ответом, а прежняя настройка Jev (`https://api.aitunnel.ru`)
 * давала тот же адрес через свой зашитый путь `/v1/systemone`.
 *
 * Почему не через `ctx.llm.stream`: у Jev собственный протокол (state/questions →
 * вероятности), он не OpenAI-chat-совместим, поэтому HTTP-клиент остаётся свой,
 * а у хоста берутся только реквизиты — тогда токен вводится ровно в одном месте.
 *
 * @module @kenz1117/dsh-engram/jev/host
 */

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

/** Провайдер для панели: идентификатор, подпись, шаблон адреса и модели из настроек. */
export interface JevProviderEntry {
  readonly id: string
  readonly displayName: string
  /** Корень API провайдера из настроек DSH; undefined = в настройках его нет. */
  readonly baseUrl: string | undefined
  /** Шаблон адреса System One, который панель подставляет в поле; undefined = не вывести. */
  readonly endpoint: string | undefined
  /** Модели из настроек провайдера (без обращения к сети); может быть пустым. */
  readonly models: readonly { readonly id: string; readonly name: string }[]
}

/** Каталог, который панель показывает в выпадающих списках. */
export interface JevCatalog {
  readonly providers: readonly JevProviderEntry[]
}

/** Собранное соединение: всё, что нужно HTTP-клиенту Jev для одного запроса. */
export interface JevConnection {
  /** Полный адрес эндпоинта System One (из настроек Jev либо шаблоном от провайдера). */
  readonly endpoint: string
  readonly apiKey: string
  readonly model: string
  readonly timeoutMs: number
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
  const path = Array.isArray(entry.settingsPath)
    ? entry.settingsPath.filter((segment): segment is string => typeof segment === 'string')
    : []
  const value = await readSettingsValue(ctx, ns)
  if (value === undefined) return undefined
  const profile = readPath(value, path.length > 0 ? path : ['providers', providerId])
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
      models: [],
    })
  }
  return { providers }
}

/**
 * Живой список моделей провайдера: `GET {baseURL}/models` тем же ключом, что и
 * судейство. Список сужается до Jev-моделей — панель предлагает только то, что
 * может отвечать протоколом System One.
 *
 * Если Jev-моделей у провайдера не нашлось, не предлагается ничего: остальные его
 * модели этого протокола не понимают, и подсказка из них была бы подсказкой сломать
 * судью. Имя в таком случае вписывают руками — поле принимает любое.
 * Ничего не бросает: причина отказа возвращается полем error.
 * @param ctx - контекст плагина.
 * @param providerId - выбранный провайдер DSH.
 */
export async function readProviderModels(ctx: HostContext, providerId: string): Promise<JevModelList> {
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
    const jevModels = ids.filter(id => /jev/i.test(id))
    // Пустой список вместо всех моделей провайдера: сузить до нуля честнее, чем
    // предложить модель, которая протоколом System One не отвечает (см. пояснение выше).
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
 * Собрать соединение Jev: адрес — из настроек Jev либо шаблоном от провайдера,
 * ключ — из хранилища секретов по ссылке `apiKeyEnv`, модель — из настроек Jev
 * либо первая Jev-модель провайдера.
 * @param ctx - контекст плагина.
 * @param providerId - выбранный провайдер DSH; пусто = провайдера не назвал никто.
 * @param model - выбранная модель; пусто = взять Jev-модель провайдера.
 * @param timeoutMs - тайм-аут одного запроса.
 * @param endpointOverride - адрес из настроек Jev; пусто = взять шаблон от провайдера.
 * @returns соединение либо текст ошибки (как в `parseJevPatch`).
 */
export async function resolveJevConnection(
  ctx: HostContext,
  providerId: string,
  model: string,
  timeoutMs: number,
  endpointOverride?: string,
): Promise<JevConnection | string> {
  // Провайдера мог не назвать никто: ни панель, ни cordis.yml, ни маршрут сессии.
  if (providerId.trim() === '') return message('misc.jevProviderUnresolved')
  const rekvisites = await readProviderRekvisites(ctx, providerId)
  if (typeof rekvisites === 'string') return rekvisites
  // Пустое поле модели означает «взять Jev-модель этого провайдера», а не «любую его
  // модель»: чат-модель не отвечает протоколом System One, и подстановка ломала бы
  // судью молча — вместо этого Jev уходит в чистые правила с видимой причиной.
  const chosenModel = model.trim() !== '' ? model.trim() : pickJevModel(rekvisites.modelIds)
  if (chosenModel === undefined) return message('misc.jevModelNotPicked', { provider: providerId })
  const chosen = endpointOverride !== undefined && endpointOverride.trim() !== ''
    ? endpointOverride.trim()
    : undefined
  const endpoint = chosen ?? (rekvisites.baseUrl === undefined ? undefined : systemOneEndpoint(rekvisites.baseUrl))
  if (endpoint === undefined) {
    return message('misc.jevProviderHasNoBaseUrl', { provider: providerId })
  }
  if (rekvisites.apiKey === '') {
    return message('misc.jevProviderKeyMissing', { provider: providerId, ref: rekvisites.apiKeyEnv ?? '' })
  }
  return { endpoint, apiKey: rekvisites.apiKey, model: chosenModel, timeoutMs }
}

/**
 * Первая Jev-модель из настроек провайдера — замена пустому полю модели.
 * Порядок не пересортировываем: он задан пользователем в настройках DSH, и выбранной
 * должна стать та модель, которую он поставил выше.
 * @param modelIds - модели провайдера из его настроек в DSH.
 * @returns имя модели либо `undefined`, если Jev-моделей у провайдера нет.
 */
function pickJevModel(modelIds: readonly string[]): string | undefined {
  return modelIds.find(id => /jev/i.test(id))
}
