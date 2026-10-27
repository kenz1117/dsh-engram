/**
 * Настройки Jev, задаваемые из панели: сохраняются в `<dbDir>/jev-config.json` (0600)
 * и пофайлово перекрывают подконфигурацию `jev` из cordis.yml.
 *
 * Здесь хранится только то, что действительно относится к Jev: включён ли он,
 * какой провайдер DSH и какая его модель выбраны, тайм-аут. Ни адреса, ни токена
 * тут нет и быть не должно — их берёт у хоста мост `./host.ts` в момент вызова,
 * поэтому провайдеры и ключи вводятся ровно в одном месте, у хоста.
 *
 * Сборка судьи не кэшируется: конструктор — это замыкание без состояния, а файл
 * настроек читается мелко, поэтому каждая точка сборки разрешает его заново и
 * сохранение в панели действует сразу. Битый файл настроек считается пустым
 * перекрытием: запуск не блокируется, панель перезапишет файл при сохранении.
 * @module @kenz1117/dsh-engram/jev/runtime
 */

import { readFileSync, writeFileSync } from 'node:fs'
import type { ResolvedJevConfig } from '../config.ts'
import type { JudgeProvider } from '../write-disposition.ts'
import { message } from '../i18n/messages.ts'
import { createMemoryJudge } from './client.ts'
import { resolveJevConnection, type HostContext } from './host.ts'
import { legacyJevFields, noteLegacyJevFields } from './stale.ts'

/** Поля Jev, которые правит панель; три порога остаются расширенной настройкой cordis.yml. */
export interface JevOverride {
  /** Включён ли вердикт Jev. */
  readonly enabled?: boolean
  /** Провайдер DSH (ключ в `providers` плагина `llm-pi-ai`). */
  readonly provider?: string
  /** Модель провайдера (id из его списка моделей). */
  readonly model?: string
  /** Полный адрес эндпоинта System One; пусто = вывести шаблоном из baseURL провайдера. */
  readonly endpoint?: string
  /** Тайм-аут одного запроса в миллисекундах (целое, 1000-60000). */
  readonly timeoutMs?: number
}

/** Вид настроек Jev для панели: ни ключа, ни адреса — только выбор и пороги. */
export interface JevConfigView {
  readonly enabled: boolean
  readonly provider: string | undefined
  readonly model: string | undefined
  /** Адрес эндпоинта из настроек; undefined = подставить шаблон от провайдера. */
  readonly endpoint: string | undefined
  readonly timeoutMs: number
  readonly deferMergeAbove: number
  readonly deferAcceptBelow: number
  readonly contradictMinProbability: number
}

/** Путь к файлу перекрытия (каталог уже 0700, сам файл — 0600, двойная защита). */
export function jevOverridePath(dbDir: string): string {
  return `${dbDir}/jev-config.json`
}

/** Прочитать перекрытие: нет файла, битый JSON или мусор — всё считается пустым перекрытием. */
export function loadJevOverride(dbDir: string): JevOverride {
  let raw: string
  try {
    raw = readFileSync(jevOverridePath(dbDir), 'utf8')
  } catch {
    // Файла нет (панель ещё не сохраняла): пустое перекрытие, работает cordis.yml.
    return {}
  }
  try {
    return collectOverride(JSON.parse(raw) as unknown)
  } catch {
    // Испорченный руками JSON: запуск не блокируем, панель перезапишет файл целиком.
    return {}
  }
}

/**
 * Свести произвольный JSON к перекрытию: известны четыре поля, остальное отбрасывается.
 * Поля прежнего формата (`apiKey`, `baseUrl`) намеренно не читаются: ключ и адрес
 * больше не хранятся у Jev, их место занял выбор провайдера у хоста.
 */
function collectOverride(value: unknown): JevOverride {
  if (value === null || typeof value !== 'object') return {}
  const raw = value as Record<string, unknown>
  // Прежний формат не читаем, но и не прячем: одноразовое предупреждение скажет,
  // что ключ из этого файла больше не используется и куда он переехал.
  const legacy = legacyJevFields(raw)
  if (legacy.length > 0) noteLegacyJevFields('jev-config.json', legacy)
  return {
    ...(typeof raw.enabled === 'boolean' ? { enabled: raw.enabled } : {}),
    ...(typeof raw.provider === 'string' && raw.provider !== '' ? { provider: raw.provider } : {}),
    ...(typeof raw.model === 'string' && raw.model !== '' ? { model: raw.model } : {}),
    ...(typeof raw.endpoint === 'string' && raw.endpoint !== '' ? { endpoint: raw.endpoint } : {}),
    ...(typeof raw.timeoutMs === 'number' && Number.isInteger(raw.timeoutMs)
      ? { timeoutMs: raw.timeoutMs }
      : {}),
  }
}

/** Записать перекрытие целиком (вызывающий уже проверил его через `parseJevPatch`). */
export function saveJevOverride(dbDir: string, override: JevOverride): void {
  writeFileSync(jevOverridePath(dbDir), `${JSON.stringify(override, null, 2)}\n`, { mode: 0o600 })
}

/**
 * Разобрать правку из панели: известные поля проверяются по одному, при любой
 * негодности отвергается вся правка. `provider: ''` очищает выбор провайдера
 * (Jev при этом молча уходит в чистые правила); отсутствующее поле сохраняет текущее.
 * @param current - текущее перекрытие (основа слияния).
 * @param patch - сырой объект из тела POST.
 * @returns при годности — слитое перекрытие целиком; иначе текст ошибки с префиксом `invalid:`.
 */
export function parseJevPatch(current: JevOverride, patch: Readonly<Record<string, unknown>>): JevOverride | string {
  const merged: {
    enabled?: boolean
    provider?: string
    model?: string
    endpoint?: string
    timeoutMs?: number
  } = { ...current }
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') return message('misc.jevEnabledMustBeBoolean')
    merged.enabled = patch.enabled
  }
  if (patch.provider !== undefined) {
    if (typeof patch.provider !== 'string') return message('misc.jevProviderMustBeString')
    // Пустая строка = снять выбор провайдера; непустая — без крайних пробелов.
    const trimmed = patch.provider.trim()
    if (trimmed === '') delete merged.provider
    else merged.provider = trimmed
  }
  if (patch.model !== undefined) {
    if (typeof patch.model !== 'string') return message('misc.jevModelMustNotBeEmpty')
    const trimmed = patch.model.trim()
    if (trimmed === '') delete merged.model
    else merged.model = trimmed
  }
  if (patch.endpoint !== undefined) {
    if (typeof patch.endpoint !== 'string') return message('misc.jevEndpointMustBeHttp')
    const trimmed = patch.endpoint.trim()
    // Пустая строка = вернуться к шаблону от провайдера.
    if (trimmed === '') {
      delete merged.endpoint
    } else {
      let scheme = ''
      try {
        scheme = new URL(trimmed).protocol
      } catch {
        scheme = ''
      }
      if (scheme !== 'http:' && scheme !== 'https:') return message('misc.jevEndpointMustBeHttp')
      merged.endpoint = trimmed
    }
  }
  if (patch.timeoutMs !== undefined) {
    const value = patch.timeoutMs
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1000 || value > 60000) {
      return message('misc.jevTimeoutMsMustBeInteger')
    }
    merged.timeoutMs = value
  }
  return merged
}

/**
 * Непустое значение либо `undefined`: пустая строка означает «поле не названо»,
 * а не «названо пустым». Без этого шага очищенное поле панели затирало бы значение
 * из cordis.yml вместо того, чтобы уступить ему место.
 */
function named(value: string | undefined): string | undefined {
  return value !== undefined && value !== '' ? value : undefined
}

/**
 * Слить перекрытие панели с базой из cordis.yml по полям.
 *
 * Провайдер и модель вправе остаться неназванными: провайдера тогда подставит ленивый
 * резолвер соединения (маршрут текущей сессии), а модель — первая Jev-модель этого
 * провайдера. Поэтому `enabled` здесь означает только «пользователь включил Jev»:
 * снимать его заранее значило бы терять наследование, которое видно лишь в момент вопроса.
 */
export function effectiveJevConfig(base: ResolvedJevConfig, override: JevOverride): ResolvedJevConfig {
  return {
    enabled: override.enabled ?? base.enabled,
    provider: named(override.provider) ?? named(base.provider),
    model: named(override.model) ?? named(base.model),
    // Адрес хранится отдельно: пусто означает «подставить шаблон от провайдера».
    endpoint: override.endpoint ?? base.endpoint,
    timeoutMs: override.timeoutMs ?? base.timeoutMs,
    deferMergeAbove: base.deferMergeAbove,
    deferAcceptBelow: base.deferAcceptBelow,
    contradictMinProbability: base.contradictMinProbability,
  }
}

/** Собрать вид для панели по действующей конфигурации. */
export function jevConfigView(base: ResolvedJevConfig, override: JevOverride): JevConfigView {
  const config = effectiveJevConfig(base, override)
  return {
    enabled: config.enabled,
    provider: config.provider,
    model: config.model,
    endpoint: config.endpoint,
    timeoutMs: config.timeoutMs,
    deferMergeAbove: config.deferMergeAbove,
    deferAcceptBelow: config.deferAcceptBelow,
    contradictMinProbability: config.contradictMinProbability,
  }
}

/**
 * Единая точка сборки: отдать поставщика судьи Jev — функцию, которая собирает судью
 * в момент операции. Результат раскладывается в зависимости четырёх видов
 * (запись, инструменты, последний ход, догрузка истории).
 *
 * Поставщик читает перекрытие панели и базу cordis.yml при каждом вызове, а реквизиты
 * соединения резолвятся ещё позже — при первом вопросе судьи, где и доопределяются
 * провайдер и модель, которых не назвал никто. Поэтому включение Jev и смена провайдера,
 * модели или адреса в панели действуют без перезапуска, а не только при загрузке плагина.
 * Три порога задаются лишь в cordis.yml и меняются с перезапуском.
 * @param ctx - контекст плагина (доступ к сервисам хоста: llm, settings, credentials).
 * @param base - база из cordis.yml.
 * @param dbDir - каталог данных (там лежит файл перекрытия).
 * @param routeProvider - провайдер текущей сессии: подставляется, только если его не
 *   назвали ни панель, ни cordis.yml. Читается в момент вопроса, поэтому смена
 *   маршрута посреди сессии подхватывается сама.
 */
export function resolveJevField(
  ctx: HostContext,
  base: ResolvedJevConfig,
  dbDir: string,
  routeProvider?: () => string | undefined,
): { resolveJudge: JudgeProvider } {
  return {
    resolveJudge: () => {
      const config = effectiveJevConfig(base, loadJevOverride(dbDir))
      if (!config.enabled) return undefined
      const configured = config.provider
      const model = config.model ?? ''
      const endpoint = config.endpoint
      const timeoutMs = config.timeoutMs
      return createMemoryJudge(config, () => {
        const provider = configured !== undefined && configured !== ''
          ? configured
          : (routeProvider?.() ?? '')
        return resolveJevConnection(ctx, provider, model, timeoutMs, endpoint)
      })
    },
  }
}
