/**
 * /engram 管理页与 /api/engram/* 数据接口的回环路由。
 * 安全面：peer socket + Host 头必须为本机回环；写操作额外校验 Origin 与
 * Content-Type（billing guardLoopback 同款三重防线）。下游插件不进宿主
 * client 模块表，管理页为 host 直出的自包含单文件页。
 * @module @kenz1117/dsh-engram/routes
 */

import { existsSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute, join, relative } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: merges the ctx.webServer service declaration.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { EngramEntityKind, EngramKind, EngramScope, EngramStatus, EpisodeTimelineAroundResponse, EpisodeTimelineGroupsResponse, ExportData, ListFilter, MemoryRecord, ObservationStatus } from './types.ts'
import { asMemoryId } from './types.ts'
import type { EngramStore } from './store/interface.ts'
import { embedImportedRecords, parseImportData, parseMarkdownExport } from './store/import.ts'
import { formatBytes } from './body-limits.ts'
import { IMPORT_BODY_LIMIT_BYTES, readJsonBody } from './http-body.ts'
import type { EngramEmbedder } from './embedder/interface.ts'
import type { HistoryBackfillRules, HistoryEstimate, HistoryRunProgress, HistoryRunResult } from './ingest/history.ts'
import type { ProjectPalaceKind } from './project/registry.ts'
import type { BaseActionId, BaseStateId } from './registry/base-state.ts'
import type { PalaceGuard } from './registry/palace-guard.ts'
import type { ResolvedHistoryRules, ResolvedJevConfig } from './config.ts'
import { effectiveJevConfig, jevConfigView, loadJevOverride, parseJevPatch, saveJevOverride } from './jev/runtime.ts'
import { testJevConnection } from './jev/client.ts'
import type { JevCatalog, JevConnection, JevModelList } from './jev/host.ts'
import { listJevObservations } from './jev/observe.ts'
import { writeMirror } from './mirror/markdown.ts'
import { isLanguageCode, type EngramLanguage } from './i18n/language.ts'
import { message, messageIn } from './i18n/messages.ts'
import { entriesFromRequest } from './i18n/dictionary-edit.ts'
import type { DictionarySetView } from './i18n/dictionary-edit.ts'
import { isDictionarySet } from './i18n/dictionary-terms.ts'
import type { DictionarySet } from './i18n/dictionary-terms.ts'
import { createBackup, restoreBackup, BACKUP_SCHEMA_VERSION } from './backup/tar.ts'
import { runConsolidation } from './consolidation/run.ts'
import { aggregateTelemetry } from './telemetry/aggregate.ts'
import { buildTourProposal } from './tour-proposal.ts'
import { gatherRefurbSuggestions, DEFAULT_REFURB_OPTIONS } from './refurb.ts'

/** 回环 peer：IPv4 127/8、IPv6 ::1、IPv4-mapped IPv6。 */
function isLoopbackPeer(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress
  if (address === undefined) return false
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.')
}

/** Host 头必须为回环字面量（防 DNS rebinding：拒绝 `127.0.0.1.attacker.com`）。 */
function isLoopbackHost(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (host === undefined || host === '') return true
  const name = host.split(':')[0]
  return name === 'localhost' || name === '::1' || (name !== undefined && /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name))
}

/** 写操作的 Origin 必须为回环（防跨站表单/fetch）。缺失视为放行，由 Content-Type 兜底。 */
function isLoopbackOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === '') return true
  try {
    const host = new URL(origin).hostname
    return host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  } catch {
    return false
  }
}

/**
 * 回环守卫：仅放行回环 GET/POST 请求（peer + Host 同时校验）。
 * @returns 是否放行；false = 已拒绝并结束响应。
 */
export function guardLoopback(req: IncomingMessage, res: ServerResponse): boolean {
  const methodOk = req.method === 'GET' || req.method === 'POST'
  if (!methodOk || !isLoopbackPeer(req) || !isLoopbackHost(req)) {
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'forbidden: loopback only' }))
    return false
  }
  return true
}

/** 写操作守卫：Origin 回环 + Content-Type JSON。 */
function guardWrite(req: IncomingMessage, res: ServerResponse): boolean {
  if (!isLoopbackOrigin(req.headers.origin)) {
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'forbidden: loopback only' }))
    return false
  }
  if (!(req.headers['content-type'] ?? '').toLowerCase().includes('application/json')) {
    res.writeHead(415, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'unsupported content-type' }))
    return false
  }
  return true
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * 读 JSON body，并把失败原因说清楚：超限 413、坏 JSON 400、不是对象 400。
 *
 * 为什么不给「宽容降级成空对象」：那样超限/坏 body 会掉进字段校验，报成
 * 「id required」「archivePath required」——把服务端的锅甩给调用方（#34 的同款毛病）。
 * 机器已经能分辨三种原因，就别再合成一句话。
 *
 * @returns body；返回 null = 已写好错误响应，调用方直接 return。
 */
async function readBody(req: IncomingMessage, res: ServerResponse, language: EngramLanguage): Promise<Record<string, unknown> | null> {
  const result = await readJsonBody(req)
  if (result.ok) return result.body
  if (result.reason === 'too-large') {
    json(res, 413, { error: messageIn(language, 'misc.bodyTooLarge', { limit: formatBytes(result.limit) }) })
    return null
  }
  if (result.reason === 'malformed') {
    json(res, 400, { error: messageIn(language, 'misc.bodyMalformed', { error: result.error }) })
    return null
  }
  json(res, 400, { error: messageIn(language, 'misc.bodyNotObject') })
  return null
}

/**
 * Язык из тела запроса: код языка либо ничего.
 *
 * Пустое и отсутствующее значение — не ошибка: без языка набор читается на том,
 * на котором плагин считает сейчас. Всё остальное, что не похоже на код языка,
 * отбрасывается здесь, а не в вызывающем: `fr` пройдёт, `../../x` — нет.
 */
function languageOf(raw: unknown): EngramLanguage | undefined {
  return typeof raw === 'string' && isLanguageCode(raw) ? raw : undefined
}

/** 从 URL searchParams 收敛 scope（缺省 user）。 */
function scopeOf(raw: string | null, fallback: EngramScope): EngramScope {
  if (raw === 'user' || raw === 'project' || raw === 'shared') return raw
  return fallback
}

/**
 * Какие записи op_log — не журнал, а состояние.
 *
 * Ключи повторной загрузки (`ingest-*`) и очередь отложенных записей (`reflect-pending`) читаются
 * обратно при следующем старте: удалить их — значит заставить загрузчик заново
 * разбирать ходы, которые уже разобраны. Всё остальное в op_log — только след
 * истории, его очистка ничего не ломает.
 */
export const LOG_KEEP_OPS: readonly string[] = ['ingest-done', 'ingest-pending', 'ingest-skip', 'ingest-nothing', 'reflect-pending']

/** Размер базы на диске вместе с WAL/SHM — для индикации «сколько занимает журнал». */
function dbFileBytes(path: string): number {
  let total = 0
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      if (existsSync(candidate)) total += statSync(candidate).size
    } catch {
      // Недоступный файл не учитываем: размер — индикация, а не отчётность.
    }
  }
  return total
}

/** 宽松取数：数字与数字字符串都接受，其余返回 undefined（回退配置默认）。 */
function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** 宽松取布尔：真值/假值的字符串与布尔都接受，其余返回 undefined。 */
function toBoolean(value: unknown): boolean | undefined {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return undefined
}

/** 从 query 或 body 收敛历史回填规则（未给或非法的字段留给配置默认值）。 */
function historyRulesOf(raw: Readonly<Record<string, unknown>>): HistoryBackfillRules {
  const days = toNumber(raw['days'])
  const maxTurnsPerSession = toNumber(raw['maxTurnsPerSession'])
  const maxTotalTurns = toNumber(raw['maxTotalTurns'])
  const includeSubagents = toBoolean(raw['includeSubagents'])
  const includeSeeded = toBoolean(raw['includeSeeded'])
  const includeNoCwd = toBoolean(raw['includeNoCwd'])
  return {
    ...(days === undefined ? {} : { days }),
    ...(maxTurnsPerSession === undefined ? {} : { maxTurnsPerSession }),
    ...(maxTotalTurns === undefined ? {} : { maxTotalTurns }),
    ...(includeSubagents === undefined ? {} : { includeSubagents }),
    ...(includeSeeded === undefined ? {} : { includeSeeded }),
    ...(includeNoCwd === undefined ? {} : { includeNoCwd }),
  }
}

/** 面板用的项目宫殿视图（JSON 友好：无归属目录 = null，未计数 = null）。 */
export interface ProjectPalaceView {
  /** 分库文件名，也是 API 选择器 id（`?project=`）。 */
  readonly dbName: string
  /** 展示标题（工作区标题 / 目录末段 / 进程目录兜底）。 */
  readonly title: string
  /** 归属目录；无法归属时为 null。 */
  readonly path: string | null
  /** 来源类别：宿主注册表工作区 / 只从会话 cwd 见到 / 进程目录兜底。 */
  readonly kind: ProjectPalaceKind
  /** 标识来源：git origin 哈希 / cwd 全量哈希。 */
  readonly source: 'origin' | 'cwd'
  /** 宿主工作区 id；非注册表工作区为 null。 */
  readonly workspaceId: string | null
  /** 分库文件是否已存在（不存在时不建空库，memories 为 null）。 */
  readonly exists: boolean
  /** active 记忆条数；库不存在或读取失败为 null。 */
  readonly memories: number | null
}

/** Неполадка в файле реестра или словаря: где и что именно. */
export interface RegistryFileProblem {
  /** Путь к файлу (панель показывает последний сегмент). */
  readonly file: string
  readonly kind: string
  readonly detail: string
}

/** Строка каталога моделей в том виде, в каком её видит панель. */
export interface RegistryModelView {
  readonly id: string
  /** Короткая метка; у модели без метки — null. */
  readonly label: string | null
  readonly pooling: string
  readonly dtype: string
  /** Объявленная размерность; у удалённой модели её нет — null. */
  readonly dimensions: number | null
  /**
   * Языки, которые модель умеет. Пусто — модель их не объявила.
   *
   * Панель берёт отсюда список языков, для которых имеет смысл заводить словарь:
   * язык, которого модель не знает, считался бы ею вслепую.
   */
  readonly languages: readonly string[]
}

/** Ответ `GET registry`: чем считается содержимое базы и какими словами оно описано. */
export interface RegistryView {
  /** Язык, на котором говорит серверная половина (он же язык прочитанных словарей). */
  readonly language: string
  /**
   * Язык дворца: чем определён и разошлись ли сигналы. null — определять было нечего
   * (язык пришёл из настройки), либо определение ещё не сделано.
   *
   * Прочитанных реплик здесь нет намеренно: журналы сессий больше не читаются
   * при старте (решение 20.10), и показывать «0 сессий» значило бы выдавать
   * отсутствие чтения за отсутствие диалогов.
   */
  readonly palace: {
    readonly setting: string | null
    readonly source: string
    readonly conflict: boolean
    /**
     * Локаль машины как есть («ru», «fr», пустая строка — не прочитать).
     *
     * Нужна панели первого старта: она подставляет этот язык в выбор, а если такого
     * языка у дворца нет — предлагает выбор «другой язык» с инструкцией (решение 21.10).
     * Это сырая локаль, а не наш язык: сводить её к zh/en/ru здесь нельзя, иначе
     * французу предложили бы английский как «его» язык.
     */
    readonly machine: string
    /**
     * Язык, на котором человек ведёт диалог в этой сессии; null — реплик ещё не было
     * (журналы не читаются, кроме текущей сессии).
     */
    readonly dialogue: string | null
    /**
     * Язык, на котором стоят базы по своим меткам; null — метки нет ни у одной базы,
     * `mixed` — базы подписаны разными языками.
     */
    readonly bases: string | null
    /**
     * Что происходит (решение 21.10): `auto` — дворец настраивается сам на язык диалогов;
     * `ask` — опоры нет, спрашиваем; `mismatch` — диалоги и базы на разных языках.
     */
    readonly state: string
  } | null
  /** Объявленное умолчание пакета; не объявлено — null. */
  readonly defaultLanguage: string | null
  /**
   * Языки дворца, которые знает поставка: код, как он называется человеку и есть ли
   * у плагина вшитый набор текстов.
   *
   * Отдаётся панели, чтобы список выбора приходил от того, кто решает, какие языки
   * есть (реестр `registry/languages.json`), а не из копии тройки в сборке клиента:
   * иначе язык, добавленный файлом, был бы на сервере, но не в списке выбора.
   */
  readonly languages: readonly { readonly code: string, readonly label: string, readonly builtin: boolean }[]
  /**
   * Языки из объявленных моделями, у которых словарь уже есть: файл поставки или
   * файл пользователя.
   *
   * Считается по файлам, а не по реестру языков: словарь мог быть заведён и для
   * языка, которого в реестре нет. Панель вычитает этот список из языков моделей —
   * так в выборе «Создать словарь» остаются ровно те языки, для которых заведение
   * имеет смысл.
   */
  readonly dictionaryLanguages: readonly string[]
  /**
   * Длина окна собранного условия смены языка дворца, секунды.
   *
   * Одно число на панель и сервер: панель считает по нему отсчёт и подпись, сервер —
   * принимает ли запрос смены языка. Расходиться им нельзя, поэтому настройка едет
   * тем же ответом, что и языки.
   */
  readonly palaceChangeWindowSec: number
  /** Выбрана ли удалённая модель: тогда локальная строка не выбирается вовсе. */
  readonly remote: boolean
  /** Выбранная локальная модель и правило, по которому она выбрана; нечем выбрать — null. */
  readonly resolved: {
    readonly id: string
    readonly label: string | null
    readonly source: string
    readonly pooling: string
    readonly dtype: string
  } | null
  readonly models: readonly RegistryModelView[]
  readonly bindings: readonly { readonly language: string; readonly model: string }[]
  /** Прочитанные файлы реестра в порядке наложения. */
  readonly files: readonly string[]
  readonly problems: readonly RegistryFileProblem[]
  /** Словари: серверных сообщений и панели, с числом принятых строк и претензиями. */
  readonly dictionaries: readonly {
    readonly name: string
    readonly files: readonly string[]
    readonly entries: number
    readonly problems: readonly { readonly file: string; readonly line: number; readonly kind: string; readonly detail: string }[]
  }[]
}

/**
 * Одна база дворца в карточке обслуживания: где лежит, на чём стоит и что с ней
 * сделает кнопка «Выполнить». Состояние и действие считает ядро
 * (`registry/base-state.ts`), панель их только называет словами.
 */
export interface BaseView {
  /** Имя файла базы: `user.db`, `shared.db`, `project-<hash>.db`. */
  readonly file: string
  /** Чья это база: своя, общая или проектная. */
  readonly scope: 'user' | 'shared' | 'project'
  /** Заголовок проектного дворца; у user/shared его нет (панель называет их сама). */
  readonly title: string | null
  /** Метка из `meta`; базы без метки — null. */
  readonly label: string | null
  /** Метка, которую поставит или ожидает плагин; нечем собрать — null. */
  readonly targetLabel: string | null
  /** Состояние базы; null — не проверено (объявление схемы о другой версии базы). */
  readonly state: BaseStateId | null
  /** Что сделает кнопка; null — действие не определено, потому что состояние не проверено. */
  readonly action: BaseActionId | null
  /** Записей в области объявления схемы. */
  readonly rows: number
  /** Из них без вектора. */
  readonly missing: number
  /** Из них чужой длины. */
  readonly foreign: number
  /** Длины векторов по убыванию числа записей. */
  readonly dims: readonly number[]
  /** Состояние проверено; false — объявление схемы описывает другую версию базы. */
  readonly checked: boolean
  readonly problems: readonly { readonly kind: string, readonly detail: string }[]
}

/** Итог записи метки: что подписали и что не далось. */
export interface BaseLabelResult {
  readonly written: readonly { readonly file: string, readonly label: string }[]
  readonly failed: readonly { readonly file: string, readonly error: string }[]
}

/**
 * Итог пересчёта векторов: сколько строк получило вектор, сколько осталось без него
 * и что не далось.
 *
 * Разделение на «пустой текст» и «сбой» намеренное: первое — факт о содержимом базы
 * (строке не из чего строить вектор), второе — сбой эмбеддера или записи. Сваливать
 * их в одно число значило бы обещать «всё пересчитано» там, где часть строк осталась
 * прежней.
 */
export interface BaseConvertResult {
  /** Строк получило новый вектор за этот прогон. */
  readonly converted: number
  /** Строк пропущено: текста нет, вектор не из чего строить. */
  readonly empty: number
  /** Метки, обновлённые после пересчёта. */
  readonly written: readonly { readonly file: string, readonly label: string }[]
  /** Что не далось: файл, таблица (если известна) и причина. */
  readonly failed: readonly { readonly file: string, readonly table: string | null, readonly error: string }[]
}

/**
 * Итог выбора языка дворца из панели.
 *
 * `ok: false` — язык не записан, и причина названа: без сервиса настроек значение
 * осталось бы на этот процесс и молча потерялось при следующем старте.
 */
export interface PalaceLanguageResult {
  readonly ok: boolean
  /** Записанный язык; при отказе — тот, что просили записать. */
  readonly language: string
  readonly error?: string
}

/**
 * Итог правки словаря: сколько строк легло, куда и как набор выглядит после записи.
 *
 * Панель получает свежий набор тем же ответом, а не вторым запросом: после
 * сохранения таблица обязана показывать записанное, и разойтись эти два
 * представления не должны.
 */
export interface DictionarySaveResult {
  readonly set: DictionarySet
  readonly file: string
  readonly written: number
  readonly bytes: number
  readonly view: DictionarySetView
}

/**
 * Итог заведения пустого словаря для языка, которого в плагине ещё нет.
 *
 * Заводятся оба набора сразу: язык без пары файлов — половина словаря, и человек,
 * выбравший его в панели, увидел бы английский текст в одном месте и перевод в
 * другом. Строк с переводом в новом файле нет вовсе, но строки-ключи есть все:
 * заготовка — это файл с ключами и пустыми правыми частями, а не пустой файл.
 */
export interface DictionaryCreateResult {
  readonly set: DictionarySet
  readonly file: string
  readonly lines: number
  readonly bytes: number
}

/**
 * Итог заполнения партии словаря моделью: переводы и то, кто их дал.
 *
 * Пустой список переводов — не ошибка формата: модель вправе не перевести строку,
 * которую уже нельзя перевести (или перевести её же). Настоящее «нечего принять»
 * отличается тем, что модель не ответила вовсе, — это уже ошибка (см. deps).
 */
export interface DictionaryFillResult {
  readonly set: DictionarySet
  /** Маршрут, который отвечал: виден в тосте и в аудите. */
  readonly provider: string
  readonly model: string
  /** Пары «английская строка → перевод»; строки вне запроса сюда не попадают. */
  readonly translations: readonly (readonly [string, string])[]
}

/**
 * Ответ `GET registry`: снимок реестра плюс состояние баз.
 *
 * Разделение намеренное: реестр, словари и язык читаются один раз при сборке
 * плагина, а состояние баз считается на каждый запрос — метку меняет кнопка в
 * этой же карточке, и после неё панель обязана увидеть новое состояние, а не
 * запомненное при запуске.
 */
export interface RegistryResponse extends RegistryView {
  readonly bases: readonly BaseView[]
  /** Есть ли базы, которых ещё нет: их создаёт код автора, не мы. */
  readonly pendingBases: number
  /**
   * Подключён ли пересчёт векторов (этап 2 блока Б). false — кнопка умеет только
   * ставить метку, а состояния «другая модель», «пересортица» и «записи без
   * вектора» она честно называет невыполнимыми, вместо того чтобы молчать.
   */
  readonly convertAvailable: boolean
}

/** 未知项目选择器（路由统一映射为 404）。 */
class UnknownProjectError extends Error {
  constructor(selector: string) {
    super(`unknown project: ${selector}`)
    this.name = 'UnknownProjectError'
  }
}

/** 管理面板的路由依赖。 */
export interface RouteDeps {
  readonly openStore: (scope: EngramScope) => Promise<EngramStore>
  /**
   * 关闭并清空全部分库缓存。restore-backup 成功后必须调用：restore 用 rename 换掉了
   * .db 的 inode，缓存连接仍指向旧文件，继续写入会落进 .before-restore-* 且重启后丢失
   * （审计 F16，数据丢失级）。
   */
  readonly closeStores: () => Promise<void>
  /**
   * 项目宫殿（工作区）清单与解析：面板「项目」scope 的落点随 GUI 当前工作区切换。
   * `open(undefined)` = 插件进程目录兜底（旧行为）；未知选择器返回 undefined。
   */
  readonly projects: {
    list: () => Promise<readonly ProjectPalaceView[]>
    open: (selector: string | undefined) => Promise<{ readonly store: EngramStore; readonly project: ProjectPalaceView } | undefined>
  }
  readonly exportDir: string
  /** 嵌入器承诺（search-test 的语义道）；undefined = 纯关键词。 */
  readonly embedder: Promise<EngramEmbedder | undefined>
  /** 镜像根目录（默认 `${exportDir}/palaces`），面板「打开镜像目录」按钮会用到。 */
  readonly mirrorDir: string
  /** 备份目录（与 dbDir 同源），用于打包 .db 成 tar.gz。 */
  readonly dbDir: string
  /** 当前插件版本，写进备份 _meta.json 供恢复端校验。 */
  readonly pluginVersion: string
  /** 房间名的显示语言（服务器侧渲染的文本用它取词，如镜像 _index.md）。 */
  readonly language: EngramLanguage
  /**
   * Обслуживание: выбранная модель и прочитанные словари.
   *
   * Функция, а не готовое значение: снимок собирается там, где известны и конфиг,
   * и реестр, и словари (src/index.ts), а правка словаря меняет его — после неё
   * панель обязана увидеть новый текст, а не прочитанный при сборке плагина.
   */
  readonly registry: () => RegistryView
  /**
   * Какие из перечисленных языков уже имеют словарь (файл поставки или файл человека).
   *
   * Спрашивается по кодам, а не отдаётся готовым списком: набор языков задают модели
   * в реестре, и меняется он файлом, а не пересборкой. Проверка — здесь, а не в
   * панели: файлы словарей лежат на серверной стороне.
   */
  readonly dictionaryLanguages: (codes: readonly string[]) => readonly string[]
  /**
   * Правка словарей: прочитать набор терминов и записать пользовательский слой.
   *
   * Пишется только пользовательский слой в каталоге данных; поставка не трогается
   * (см. i18n/dictionary-edit.ts). Чтение отдаёт строки, файлы и претензии разбора.
   *
   * Язык — необязательный: без него берётся язык, на котором плагин считает сейчас.
   * Панель передаёт выбранный в блоке «Язык Плагина», чтобы таблица и счётчики
   * относились к тому языку, на который человек смотрит, а не к тому, что случайно
   * оказался текущим.
   */
  readonly dictionary: {
    readonly read: (set: DictionarySet, language?: EngramLanguage) => DictionarySetView
    readonly write: (set: DictionarySet, entries: ReadonlyMap<string, string>, language?: EngramLanguage) => DictionarySaveResult
    /**
     * Завести пустой словарь для языка, которого в плагине ещё нет: оба набора
     * пишутся в пользовательский слой, каждая строка — с пустым переводом.
     */
    readonly create: (language: EngramLanguage) => readonly DictionaryCreateResult[]
  }
  /**
   * Заполнение словаря моделью: перевести партию английских строк на язык набора.
   *
   * Партии режет панель (см. i18n/dictionary-ai): один запрос — одна партия, чтобы
   * у прогресса была цена, а обрыв одной партии не уносил остальные. Здесь ничего
   * не пишется: переводы уходят в черновик таблицы и станут файлом только после
   * «Сохранить» — модель не должна править словарь молча.
   */
  readonly dictionaryFill: (set: DictionarySet, terms: readonly string[]) => Promise<DictionaryFillResult>
  /**
   * Языки интерфейса, которые приходят словарём из файла, а не вшитым набором.
   *
   * Панель объявляет их у себя в момент запуска (`ctx.locale.addLanguage`) и отдаёт
   * словарь — иначе язык лежит в реестре и в файле словаря, но выбрать его в
   * переключателе нельзя: хост знает только те языки, которые ему объявили плагины.
   * Считается на каждый запрос: файл словаря правится из панели, и объявлять старый
   * текст после правки значило бы «сохранил, а не вижу».
   */
  readonly localePacks: () => readonly {
    readonly code: string
    readonly label: string
    readonly entries: Readonly<Record<string, string>>
  }[]
  /**
   * Обслуживание: состояние каждой базы дворца. Считается на каждый запрос, а не
   * при сборке плагина: метку меняет кнопка в этой же карточке, и после неё панель
   * должна увидеть новое состояние.
   */
  readonly baseStates: () => Promise<{ readonly bases: readonly BaseView[], readonly pendingBases: number }>
  /**
   * Язык дворца глазами панели: считается на каждый запрос, потому что язык диалога
   * появляется посреди работы, а метку базы меняет кнопка в соседней карточке (21.10).
   */
  readonly palaceLanguage: (bases: readonly BaseView[]) => RegistryView['palace']
  /** Обслуживание: поставить метку модели во все базы, которым она нужна. */
  readonly writeBaseLabels: () => Promise<BaseLabelResult>
  /** Обслуживание: пересчитать векторы базам, которые стоят не на целевой модели. */
  readonly convertBases: () => Promise<BaseConvertResult>
  /**
   * Обслуживание: выбрать язык дворца — тот, на котором модель пишет записи.
   *
   * Это не язык интерфейса: интерфейс переключается своим селектором хоста, а язык
   * дворца решает, каким словарём и какой моделью описывается содержимое баз. Выбор
   * записывается в конфигурацию плагина, а не живёт в панели.
   */
  readonly writePalaceLanguage: (language: string) => Promise<PalaceLanguageResult>
  /**
   * Длина окна собранного условия, секунды (настройка `palaceChangeWindowSec`).
   *
   * Отдаётся панели в снимке обслуживания, чтобы отсчёт и подпись считались по одному
   * числу с сервером: иначе панель показывала бы «ещё 30 секунд», а сервер уже отказывал.
   */
  readonly palaceChangeWindowSec: number
  /**
   * Предохранитель смены языка: состояние окна на сервере.
   *
   * Сервер сам помнит, когда окно открылось и на каком языке стояли базы в этот момент, —
   * поэтому клиент не может ни продлить окно, ни назвать «язык, от которого уходят»
   * (решение 24.10 после ревью #36).
   */
  readonly palaceGuard: PalaceGuard
  /**
   * Язык, на котором стоят базы сейчас, — то, от чего уходят при смене.
   *
   * Сервер знает его сам: это язык, на котором стоят базы (метки баз либо язык настройки).
   */
  readonly palaceCurrentLanguage: () => Promise<string>
  /** Подключён ли пересчёт векторов (этап 2 блока Б); false — кнопка умеет только метку. */
  readonly convertAvailable: boolean
  /** 历史回填（面板「历史回填」tab）：估算 / 启动 / 取消 / 查进度 + 部署默认规则。 */
  readonly history: {
    /** 估算候选会话与轮数（不写库、不调 LLM）。 */
    readonly estimate: (rules: HistoryBackfillRules) => Promise<HistoryEstimate>
    /** 启动后台回填；已有任务在跑时拒绝。 */
    readonly start: (rules: HistoryBackfillRules) => { ok: boolean; reason?: string }
    /** 请求中止当前任务（已完成的轮次保留，可重跑续做）。 */
    readonly cancel: () => void
    /** 当前任务进度快照。 */
    readonly status: () => { progress: HistoryRunProgress; failures: HistoryRunResult['failures']; error?: string }
    /** 已注册的 provider 与模型清单（面板「辅助模型」下拉）。 */
    readonly models: () => Promise<{
      providers: { id: string; name: string; models: { id: string; name: string }[] }[]
      failures: string[]
    }>
    /** 部署配置里的默认规则（面板表单初始值）。 */
    readonly defaults: ResolvedHistoryRules
  }
  /** Jev 裁决配置（GET/POST jev-config）：yml 基线 + 面板覆盖文件目录 + мост к хосту. */
  readonly jev: {
    /** Распознанная база из cordis.yml (адрес и ключ тут больше не хранятся — они у хоста). */
    readonly base: ResolvedJevConfig
    /** Каталог файла перекрытия: `<dbDir>/jev-config.json` (0600). */
    readonly dbDir: string
    /** Мост к хосту: список провайдеров DSH и сборка соединения (адрес и ключ — у хоста). */
    readonly host: {
      readonly catalog: () => Promise<JevCatalog>
      /** Живой список моделей провайдера (обращение к нему же, его ключом). */
      readonly models: (provider: string) => Promise<JevModelList>
      /** Соединение: адрес из настроек Jev либо шаблоном от провайдера, ключ — у хоста. */
      readonly connection: (
        provider: string,
        model: string,
        timeoutMs: number,
        endpoint?: string,
      ) => Promise<JevConnection | string>
    }
  }
}

/**
 * 注册 /engram 页面与 /api/engram/* 接口（effect 由调用方持有，disposer 可逆）。
 * @param ctx - 携带 webServer 服务的宿主上下文。
 */
export function registerEngramRoutes(ctx: Context, deps: RouteDeps): void {
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/engram',
      handler: async (req, res) => {
        if (!guardLoopback(req, res)) return
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const route = url.pathname.slice('/api/engram/'.length)
        // 项目宫殿选择器：GET 从 query 取，POST 在读 body 后覆盖（body.project）。
        const selectorRef: { value: string | undefined } = { value: url.searchParams.get('project') ?? undefined }
        /** 按作用域取分库：project 走选择器解析，未知选择器抛错 → catch 统一 404。 */
        const storeFor = async (scope: EngramScope): Promise<EngramStore> => {
          if (scope !== 'project') return deps.openStore(scope)
          const opened = await deps.projects.open(selectorRef.value)
          if (opened === undefined) throw new UnknownProjectError(selectorRef.value ?? '')
          return opened.store
        }
        /** POST body 里的项目选择器（面板所有写操作都会带）。 */
        const adoptBodySelector = (body: Record<string, unknown> | null): void => {
          const raw = body?.['project']
          if (typeof raw === 'string' && raw !== '') selectorRef.value = raw
        }
        try {
          if (req.method === 'GET' && route === 'workspaces') {
            // 项目宫殿清单：面板据此显示当前工作区、并支持手动切换（不建空库）。
            const items = await deps.projects.list()
            const processDefault = items.find(item => item.kind === 'process')
            json(res, 200, {
              items,
              processDefault: processDefault === undefined
                ? null
                : { dbName: processDefault.dbName, path: processDefault.path, title: processDefault.title },
            })
            return
          }
          if (req.method === 'GET' && route === 'stats') {
            // shared 必须在内（#19 后续发现）：scope 选择器提供「共享」，速览却因
            // parts 缺 shared 分部而永远显示 0——一行修复前它是真实的幽灵 scope。
            const scopes: EngramScope[] = ['user', 'project', 'shared']
            const parts = await Promise.all(scopes.map(async (scope) => ({ scope, stats: await (await storeFor(scope)).stats() })))
            json(res, 200, { parts })
            return
          }
          if (req.method === 'GET' && route === 'list') {
            const scope = scopeOf(url.searchParams.get('scope'), 'user')
            const status = url.searchParams.get('status')
            const kind = url.searchParams.get('kind')
            const q = url.searchParams.get('q')
            const redacted = url.searchParams.get('redacted')
            const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 20) || 20))
            const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0)
            const filter: ListFilter = {
              scope,
              ...(status !== null && status !== '' && status !== 'all' ? { status: status as EngramStatus } : {}),
              ...(kind !== null && kind !== '' && kind !== 'all' ? { kind: kind as EngramKind } : {}),
              ...(q !== null && q !== '' ? { q } : {}),
              ...(redacted === 'true' || redacted === 'false' ? { redacted: redacted === 'true' } : {}),
              // 巡游路线排序：面板「按巡游路线」开关；缺省 created_at 倒序。
              ...(url.searchParams.get('sort') === 'tour' ? { sort: 'tour' as const } : {}),
              limit,
              offset,
            }
            json(res, 200, await (await storeFor(scope)).list(filter))
            return
          }
          if (req.method === 'GET' && route === 'search-test') {
            // 召回测试台：跑真实检索（含命中强化），供面板核对召回质量与命中原委。
            const q = url.searchParams.get('q')
            if (q === null || q.trim() === '') { json(res, 400, { error: 'q required' }); return }
            const scopeParam = url.searchParams.get('scope')
            const scopes: EngramScope[] = scopeParam === 'all' || scopeParam === null || scopeParam === ''
              ? ['user', 'project']
              : [scopeOf(scopeParam, 'user')]
            const kind = url.searchParams.get('kind')
            const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit') ?? 10) || 10))
            const embedder = deps.embedder === undefined ? undefined : await deps.embedder
            const vector = embedder === undefined ? undefined : (await embedder.embed([q.trim()]))[0]
            const results = await Promise.all(scopes.map(async scope => {
              const store = await storeFor(scope)
              return store.search({ text: q, scopes: [scope], limit }, vector)
            }))
            const degraded = results.some(result => result.degraded)
            let hits = results.flatMap(result => result.hits)
            if (kind !== null && kind !== '' && kind !== 'all') hits = hits.filter(hit => hit.record.kind === kind)
            json(res, 200, {
              degraded,
              hits: hits.map(hit => ({
                id: hit.record.id,
                score: hit.score,
                via: hit.via,
                ...(hit.viaEdge === undefined ? {} : { viaEdge: hit.viaEdge }),
                scope: hit.record.scope,
                kind: hit.record.kind,
                status: hit.record.status,
                content: hit.record.content,
                createdAt: hit.record.createdAt,
              })),
            })
            return
          }
          if (req.method === 'GET' && route === 'observations') {
            // 巩固信念列表：面板信念页。status 缺省全部；按证据数降序（store 默认排序）。
            const scope = scopeOf(url.searchParams.get('scope'), 'user')
            const status = url.searchParams.get('status')
            const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 100) || 100))
            const items = await (await storeFor(scope)).listObservations({
              ...(status !== null && status !== '' && status !== 'all' ? { status: status as ObservationStatus } : {}),
              limit,
            })
            json(res, 200, { scope, items, total: items.length })
            return
          }
          if (req.method === 'GET' && route === 'observation-evidence') {
            // 信念证据链回查：sourceIds → 原始记忆行（只读，含已归档——证据链必须可回溯到任何历史状态）。
            const scope = scopeOf(url.searchParams.get('scope'), 'user')
            const ids = (url.searchParams.get('ids') ?? '')
              .split(',').map(part => part.trim()).filter(part => part !== '').slice(0, 50)
            if (ids.length === 0) { json(res, 400, { error: 'ids required' }); return }
            const items = await (await storeFor(scope)).getMany(ids as never)
            json(res, 200, { scope, items })
            return
          }
          if (req.method === 'GET' && route === 'entities') {
            // 实体词典：面板实体页列表（含每实体关联记忆数）；实体跟随来源记忆所在 scope 分库。
            const scope = scopeOf(url.searchParams.get('scope'), 'user')
            const kind = url.searchParams.get('kind')
            const q = url.searchParams.get('q')
            const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50))
            const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0)
            const result = await (await storeFor(scope)).listEntities({
              ...(kind !== null && kind !== '' && kind !== 'all' ? { kind: kind as EngramEntityKind } : {}),
              ...(q !== null && q !== '' ? { q } : {}),
              limit,
              offset,
            })
            json(res, 200, { scope, ...result })
            return
          }
          if (req.method === 'GET' && route === 'entity') {
            // 实体详情：实体记录 + 最近关联记忆（面板实体页点开单个实体时）。
            const scope = scopeOf(url.searchParams.get('scope'), 'user')
            const id = url.searchParams.get('id')
            if (id === null || id === '') { json(res, 400, { error: 'id required' }); return }
            const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 20) || 20))
            const detail = await (await storeFor(scope)).entityDetail(id as never, limit)
            if (detail === undefined) { json(res, 404, { error: messageIn(deps.language, 'misc.entityNotFound', { id }) }); return }
            json(res, 200, detail)
            return
          }
          if (req.method === 'GET' && route === 'facts') {
            // 实体事实链：按实体查时序事实（asOf 时点回看 / includeInvalid 展开全链），面板实体页详情卡用。
            const scope = scopeOf(url.searchParams.get('scope'), 'user')
            const id = url.searchParams.get('entityId')
            if (id === null || id === '') { json(res, 400, { error: 'entityId required' }); return }
            const asOf = toNumber(url.searchParams.get('asOf'))
            const includeInvalid = toBoolean(url.searchParams.get('includeInvalid')) ?? false
            const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50))
            const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0)
            const result = await (await storeFor(scope)).factsOfEntity({
              entityId: id as never,
              ...(asOf === undefined ? {} : { asOf }),
              ...(includeInvalid ? { includeInvalid: true } : {}),
              limit,
              offset,
            })
            json(res, 200, { scope, ...result })
            return
          }
          if (req.method === 'GET' && route === 'episode-timeline') {
            // 情景时间线：单库按日期范围/来源会话分组浏览（组头带摄取期生成的会话摘要）；
            // around 非空时切换为邻近扩展（锚点 ± windowMinutes 窗口）。
            const scope = scopeOf(url.searchParams.get('scope'), 'user')
            const since = toNumber(url.searchParams.get('since'))
            const until = toNumber(url.searchParams.get('until'))
            const sessionId = url.searchParams.get('sessionId') ?? undefined
            const around = url.searchParams.get('around') ?? undefined
            const windowMinutes = Math.min(24 * 60, Math.max(1, toNumber(url.searchParams.get('windowMinutes')) ?? 60))
            const limit = Math.min(200, Math.max(1, toNumber(url.searchParams.get('limit')) ?? 100))
            const store = await storeFor(scope)
            if (around !== undefined && around !== '') {
              const result = await store.episodeTimeline({ scopes: [scope], around: around as never, proximityMs: windowMinutes * 60_000, limit })
              const view = result.around
              if (view === undefined) {
                json(res, 404, { error: message('store.anchorNotFound', { id: around }) })
                return
              }
              // 形状与客户端共用（src/types.ts）：邻近模式的载荷外层就是 `around`。
              const payload: EpisodeTimelineAroundResponse = {
                around: {
                  anchor: {
                    id: view.anchor.id, kind: view.anchor.kind, content: view.anchor.content, createdAt: view.anchor.createdAt,
                  },
                  neighbors: view.neighbors.map(record => ({
                    id: record.id, kind: record.kind, content: record.content, createdAt: record.createdAt,
                  })),
                },
              }
              json(res, 200, payload)
              return
            }
            const result = await store.episodeTimeline({
              scopes: [scope],
              ...(since === undefined ? {} : { since }),
              ...(until === undefined ? {} : { until }),
              ...(sessionId === undefined || sessionId === '' ? {} : { sessionId }),
              limit,
            })
            const groupsPayload: EpisodeTimelineGroupsResponse = {
              groups: result.groups.map(group => ({
                sessionId: group.sessionId,
                ...(group.summary === undefined ? {} : { summary: group.summary }),
                startedAt: group.startedAt,
                endedAt: group.endedAt,
                episodes: group.episodes.map(record => ({
                  id: record.id, kind: record.kind, content: record.content, createdAt: record.createdAt,
                })),
              })),
            }
            json(res, 200, groupsPayload)
            return
          }
          if (req.method === 'GET' && route === 'timeline') {
            // 通用时间线（v0.9.x · Memory Spiral 视图专用）：返回当前 scope 的全部活跃记忆，
            // 上限放宽到 500（list 路由的上限 100 在大规模库下不够画螺旋）。
            // 字段对客户端足够：id/kind/content/importance/confidence/accessCount/createdAt/slot。
            const scope = scopeOf(url.searchParams.get('scope'), 'user')
            const since = toNumber(url.searchParams.get('since'))
            const until = toNumber(url.searchParams.get('until'))
            const limit = Math.min(500, Math.max(1, toNumber(url.searchParams.get('limit')) ?? 500))
            const store = await storeFor(scope)
            const records = await store.timeline({
              scopes: [scope],
              ...(since === undefined ? {} : { since }),
              ...(until === undefined ? {} : { until }),
              limit,
            })
            json(res, 200, {
              scope,
              total: records.length,
              records: records.map(record => ({
                id: record.id,
                kind: record.kind,
                content: record.content,
                importance: record.importance,
                confidence: record.confidence,
                accessCount: record.accessCount,
                createdAt: record.createdAt,
                ...(record.slot === undefined ? {} : { slot: record.slot }),
              })),
            })
            return
          }
          // Журнал дворца — наш собственный: таблица op_log в базах дворца, а не файл
          // хост-сессии. Поэтому у него есть путь, размер и кнопка очистки; журналы
          // хост-сессий (dsh) мы не читаем и не трогаем вовсе.
          if ((req.method === 'GET' && route === 'log-info') || (req.method === 'POST' && route === 'log-clear')) {
            const clear = req.method === 'POST'
            if (clear) {
              if (!guardWrite(req, res)) return
              const body = await readBody(req, res, deps.language)
              if (body === null) return
              adoptBodySelector(body)
            }
            // Собираем только существующие базы: ожидание панели не должно создавать пустышки.
            const targets: { scope: EngramScope; store: EngramStore; path: string }[] = []
            for (const [scope, file] of [['user', 'user.db'], ['shared', 'shared.db']] as const) {
              const path = join(deps.dbDir, file)
              if (!existsSync(path)) continue
              targets.push({ scope, store: await deps.openStore(scope), path })
            }
            const opened = await deps.projects.open(selectorRef.value)
            if (opened !== undefined) {
              targets.push({ scope: 'project', store: opened.store, path: join(deps.dbDir, opened.project.dbName) })
            }
            const parts: Record<string, unknown>[] = []
            for (const target of targets) {
              const cleared = clear ? await target.store.clearLog(LOG_KEEP_OPS) : undefined
              const size = await target.store.logSize()
              parts.push({
                scope: target.scope,
                path: target.path,
                fileBytes: dbFileBytes(target.path),
                rows: size.rows,
                bytes: size.bytes,
                ...(cleared === undefined ? {} : { deleted: cleared.deleted, vacuumed: cleared.vacuumed, checkpointed: cleared.checkpointed }),
              })
            }
            const sum = (key: string): number => parts.reduce((total, part) => total + Number(part[key] ?? 0), 0)
            // Флаги очистки по всем базам: «true» значит, что сжатие/чекпоинт состоялись везде.
            const allTrue = (key: string): boolean => parts.length > 0 && parts.every(part => part[key] === true)
            json(res, 200, {
              dir: deps.dbDir,
              keepOps: LOG_KEEP_OPS,
              parts,
              totals: {
                fileBytes: sum('fileBytes'),
                rows: sum('rows'),
                bytes: sum('bytes'),
                ...(clear ? { deleted: sum('deleted'), vacuumed: allTrue('vacuumed'), checkpointed: allTrue('checkpointed') } : {}),
              },
            })
            return
          }
          if (req.method === 'GET' && route === 'activity') {
            // 最近活动：合并两库 op_log 倒序（摄取/检索改写/压缩/蒸馏/条目操作全貌）。
            const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? 20) || 20))
            const scopes: EngramScope[] = ['user', 'project']
            const merged = (await Promise.all(scopes.map(async scope => {
              const ops = await (await storeFor(scope)).recentOps(limit)
              return ops.map(op => ({ ...op, scope }))
            }))).flat().sort((a, b) => b.at - a.at).slice(0, limit)
            json(res, 200, { operations: merged })
            return
          }
          if (req.method === 'GET' && route === 'review-due') {
            // 今日待回忆（检索练习）：只给线索（坐标/门牌/逾期天数），不给正文——正文由面板「揭示」走 review 路由拉取。
            const scope = scopeOf(url.searchParams.get('scope'), 'user')
            const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? 20) || 20))
            const now = Date.now()
            const due = await (await storeFor(scope)).dueReviews(now, limit)
            json(res, 200, {
              scope,
              items: due.map(record => ({
                id: record.id,
                kind: record.kind,
                ...(record.slot === undefined ? {} : { slot: record.slot }),
                caption: record.imagery?.caption ?? null,
                nextReviewAt: record.review?.nextReviewAt ?? null,
                overdueDays: record.review?.nextReviewAt === null || record.review?.nextReviewAt === undefined
                  ? 0
                  : Math.max(0, Math.floor((now - record.review.nextReviewAt) / 86_400_000)),
                reps: record.review?.reps ?? 0,
              })),
            })
            return
          }
          if (req.method === 'POST' && route === 'review-answer') {
            // 检索练习自评：面板 记得/模糊/忘了 三档映射 SM-2 grade 5/3/1，推进调度。
            if (!guardWrite(req, res)) return
            const body = await readBody(req, res, deps.language)
            if (body === null) return
            if (typeof body.id !== 'string' || body.id === '') { json(res, 400, { error: 'id required' }); return }
            const grade = typeof body.grade === 'number' && Number.isInteger(body.grade) && body.grade >= 0 && body.grade <= 5
              ? body.grade as 0 | 1 | 2 | 3 | 4 | 5
              : null
            if (grade === null) { json(res, 400, { error: 'grade must be an integer 0-5' }); return }
            adoptBodySelector(body)
            const scope = scopeOf(typeof body.scope === 'string' ? body.scope : null, 'user')
            const store = await storeFor(scope)
            const record = await store.scheduleReview(body.id as never, grade)
            if (record === undefined) { json(res, 404, { error: messageIn(deps.language, 'misc.recordNotFound', { id: body.id }) }); return }
            json(res, 200, { id: record.id, review: record.review ?? null })
            return
          }
          if (req.method === 'GET' && route === 'review') {
            const scope = scopeOf(url.searchParams.get('scope'), 'user')
            const id = url.searchParams.get('id')
            if (id === null || id === '') { json(res, 400, { error: 'id required' }); return }
            const store = await storeFor(scope)
            const view = await store.review(id as never)
            if (view === undefined) { json(res, 404, { error: messageIn(deps.language, 'misc.recordNotFound', { id }) }); return }
            json(res, 200, view)
            return
          }
          if (req.method === 'GET' && route === 'review-due') {
            // 今日待回忆队列：只给坐标与门牌线索，不给正文（检索练习——先主动回忆再由面板揭示核对）。
            const scope = scopeOf(url.searchParams.get('scope'), 'user')
            const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? 20) || 20))
            const now = Date.now()
            const due = await (await storeFor(scope)).dueReviews(now, limit)
            json(res, 200, {
              scope,
              count: due.length,
              now,
              items: due.map(record => ({
                id: record.id,
                kind: record.kind,
                scope: record.scope,
                importance: record.importance,
                confidence: record.confidence,
                ...(record.slot === undefined ? {} : { slot: record.slot }),
                ...(typeof record.imagery?.caption === 'string' ? { caption: record.imagery.caption } : {}),
                ...(record.review?.nextReviewAt === null || record.review?.nextReviewAt === undefined
                  ? {}
                  : { overdueDays: Math.max(0, Math.floor((now - record.review.nextReviewAt) / 86_400_000)) }),
                ...(record.review === undefined ? {} : { reps: record.review.reps, intervalDays: record.review.intervalDays }),
              })),
            })
            return
          }
          if (req.method === 'GET' && route === 'export') {
            const scope = scopeOf(url.searchParams.get('scope'), 'user')
            const format = url.searchParams.get('format') === 'json' ? 'json' : 'markdown'
            const data = await (await storeFor(scope)).exportAll()
            const stamp = new Date().toISOString().replaceAll(':', '-')
            const body = format === 'json'
              ? JSON.stringify(data, null, 2)
              : [
                  messageIn(deps.language, 'misc.exportHeading', { scope }),
                  '',
                  ...data.records.map(record =>
                    messageIn(deps.language, 'misc.exportRecordLine', {
                      status: record.status,
                      kind: record.kind,
                      content: record.content,
                      id: record.id,
                      importance: record.importance,
                    })),
                  '',
                  messageIn(deps.language, 'misc.exportEdgesHeading'),
                  ...data.edges.map(edge => `- ${edge.from} --${edge.type}--> ${edge.to}`),
                  '',
                ].join('\n')
            res.writeHead(200, {
              'content-type': format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8',
              'content-disposition': `attachment; filename="engram-${scope}-${stamp}.${format}"`,
            })
            res.end(body)
            return
          }
          if (req.method === 'POST' && route === 'import') {
            // 面板导入（#33）：body = { data, scope?, format?: 'json'|'markdown', dryRun?, keepDuplicates?, selectedIds? }。
            // format=markdown 时 data 是导出 MD 原文（有损恢复，见 parseMarkdownExport）；dryRun=true 只分类不写库。
            if (!guardWrite(req, res)) return
            // 导入 payload 是整份导出（实测 165 KB 量级），不能沿用普通接口的 64 KiB 上限——
            // 沿用会把合法导出件当成坏 body 拒掉，还报成「不是 JSON 对象」（issue #34）。
            const bodyResult = await readJsonBody(req, IMPORT_BODY_LIMIT_BYTES)
            if (!bodyResult.ok) {
              // 三种失败分开报：超限是 413（服务端上限，可改路径导入），其余是 400（请求体本身不对）。
              if (bodyResult.reason === 'too-large') {
                json(res, 413, { error: messageIn(deps.language, 'misc.importBodyTooLarge', { limit: formatBytes(bodyResult.limit) }) })
                return
              }
              if (bodyResult.reason === 'malformed') {
                json(res, 400, { error: messageIn(deps.language, 'misc.importBodyMalformed', { error: bodyResult.error }) })
                return
              }
              json(res, 400, { error: messageIn(deps.language, 'misc.importBodyNotObject') })
              return
            }
            const bodyObj = bodyResult.body
            const scope = scopeOf(typeof bodyObj.scope === 'string' ? bodyObj.scope : null, 'user')
            let data: ExportData
            let redacted = false
            if (bodyObj.format === 'markdown') {
              if (typeof bodyObj.data !== 'string') {
                json(res, 400, { error: messageIn(deps.language, 'misc.importInvalidPayload', { error: 'format=markdown 需要 data 为导出 Markdown 文本' }) })
                return
              }
              const parsedMarkdown = parseMarkdownExport(bodyObj.data, scope)
              if (typeof parsedMarkdown === 'string') {
                json(res, 400, { error: messageIn(deps.language, 'misc.importInvalidPayload', { error: parsedMarkdown }) })
                return
              }
              data = parsedMarkdown.data
              redacted = parsedMarkdown.redacted
            } else {
              const parsed = parseImportData(bodyObj.data)
              if (typeof parsed === 'string') {
                json(res, 400, { error: messageIn(deps.language, 'misc.importInvalidPayload', { error: parsed }) })
                return
              }
              data = parsed
            }
            const store = await storeFor(scope)
            if (bodyObj.dryRun === true) {
              json(res, 200, { preview: await store.importPreview(data), ...(redacted ? { redacted: true } : {}) })
              return
            }
            const result = await store.importData(data, {
              ...(Array.isArray(bodyObj.selectedIds)
                ? { selectedIds: bodyObj.selectedIds.filter((v): v is string => typeof v === 'string').map(id => asMemoryId(id)) }
                : {}),
              ...(bodyObj.keepDuplicates === true ? { keepDuplicates: true } : {}),
            })
            const embedder = deps.embedder === undefined ? undefined : await deps.embedder
            const embedded = await embedImportedRecords(store, embedder, result.importedIds)
            json(res, 200, { ...result, embedded })
            return
          }
          if (req.method === 'GET' && route === 'mirror') {
            // 镜像导出：与 engram_export format=markdown-mirror 同语义，HTTP 路由版（面板「导出镜像」按钮 fetch 调用）。
            // attachment 头兜底：即使被当 URL 直开也走下载而不是 webview 顶层导航（实机报告导航会把面板带崩）。
            const scope = scopeOf(url.searchParams.get('scope'), 'user')
            const data = await (await storeFor(scope)).exportAll()
            const stamp = new Date().toISOString().replaceAll(':', '-').slice(0, 19)
            const mirrorRoot = join(deps.mirrorDir, scope, stamp)
            const report = await writeMirror(mirrorRoot, data, deps.language)
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'content-disposition': `attachment; filename="mirror-${scope}-${stamp}.json"`,
            })
            res.end(JSON.stringify({ ...report, scope, memoryCount: data.records.length, edgeCount: data.edges.length }))
            return
          }
          if (req.method === 'GET' && route === 'health') {
            // 健康评分（Memory Prize scorecard）：5 维 0-100，越高宫殿越稳。
            //   - 信噪比 (0-40)：命中强化 / 候选数，0-1 线性
            //   - 活跃率 (0-25)：active / total，越接近目标活跃率越满分（user/project=0.85；shared=0.7）
            //   - 走廊密度 (0-15)：edges / active，封顶 0.5
            //   - 涂改率惩罚 (0-10)：redacted 占比反向
            //   - 衰减覆盖 (0-10)：archived / total 落入区间给满分（user/project=[0.15, 0.45]；
            //     shared=[0.25, 0.5]，更严因为公开过期的风险更高）
            // scope 查询参数：限定只看某一库（不传 = 现 user+project 合并，向后兼容）。
            const rawScope = url.searchParams.get('scope')
            const scopes: EngramScope[] = rawScope === 'user' || rawScope === 'project' || rawScope === 'shared'
              ? [rawScope]
              : ['user', 'project']
            const parts = await Promise.all(scopes.map(async scope => {
              const store = await storeFor(scope)
              const s = await store.stats()
              const edgeCount = (await store.exportAll()).edges.length
              const total = Math.max(s.total, 1)
              const signal = s.signalRatio
              const activeRatio = s.active / total
              const corridorRatio = Math.min(0.5, edgeCount / Math.max(s.active, 1)) / 0.5
              const redactedPenalty = Math.max(0, 1 - s.redacted / total)
              const archivedRatio = s.archived / total
              // shared 库的「最优活跃率」与「衰减区间」与 user/project 不同：公开意味着大部分应当有效，
              // 过期可见会让其他 agent 学到错误信息；门槛更高。
              const isShared = scope === 'shared'
              const targetActive = isShared ? 0.7 : 0.85
              const decayLow = isShared ? 0.25 : 0.15
              const decayHigh = isShared ? 0.5 : 0.45
              const decayWindow = isShared ? 0.25 : 0.3
              const decayCoverage = archivedRatio >= decayLow && archivedRatio <= decayHigh
                ? 1
                : Math.max(0, 1 - Math.min(Math.abs(archivedRatio - decayLow), Math.abs(archivedRatio - decayHigh)) / decayWindow)
              const score = Math.round(
                signal * 40
                + (1 - Math.abs(activeRatio - targetActive) / targetActive) * 25
                + corridorRatio * 15
                + redactedPenalty * 10
                + decayCoverage * 10,
              )
              return { scope, score: Math.min(100, Math.max(0, score)), signal, activeRatio, edgeCount, redacted: s.redacted, archivedRatio }
            }))
            const overall = Math.round(parts.reduce((sum, part) => sum + part.score, 0) / parts.length)
            json(res, 200, { overall, parts, evaluatedAt: Date.now() })
            return
          }
          if (req.method === 'GET' && route === 'corridor') {
            // 走廊图：节点 = 记忆（按房间分簇），边 = related/supersedes/contradicts/refines/supports。
            // 同一作用域只读一份；面板组件默认只画 active 记忆的子图，避免闭馆节点遮蔽。
            const scope = scopeOf(url.searchParams.get('scope'), 'user')
            const includeStatuses = new Set(['active'])
            const rawStatus = url.searchParams.get('status')
            if (rawStatus !== null && rawStatus !== '' && rawStatus !== 'all') {
              for (const s of rawStatus.split(',')) {
                if (s === 'active' || s === 'archived' || s === 'forgotten') includeStatuses.add(s)
              }
            }
            const data = await (await storeFor(scope)).exportAll()
            const nodes = data.records
              .filter(r => includeStatuses.has(r.status))
              .map(r => ({
                id: r.id,
                scope: r.scope,
                kind: r.kind,
                status: r.status,
                importance: r.importance,
                confidence: r.confidence,
                title: r.content.length > 40 ? `${r.content.slice(0, 40)}…` : r.content,
                content: r.content,
              }))
            const allowedIds = new Set(nodes.map(n => n.id))
            const edges = data.edges
              .filter(e => allowedIds.has(e.from) && allowedIds.has(e.to))
              .map(e => ({ id: `${e.from}-${e.to}-${e.type}`, from: e.from, to: e.to, type: e.type }))
            json(res, 200, { scope, nodes, edges })
            return
          }
          if (req.method === 'GET' && route === 'telemetry') {
            // 宫殿遥测：本地聚合 op_log 近 N 天的关键指标，全部数据本地保留。
            // 可选 scope 查询：限定只看某一库（不传 = 三库聚合，向后兼容）。
            const windowDays = Math.min(366, Math.max(1, Number(url.searchParams.get('days') ?? 7) || 7))
            const rawScope = url.searchParams.get('scope')
            const scopeFilter: 'user' | 'project' | 'shared' | undefined =
              rawScope === 'user' ? 'user' : rawScope === 'project' ? 'project' : rawScope === 'shared' ? 'shared' : undefined
            // 项目 scope 的遥测也随选择器走（面板切工作区时计数同步切换）。
            const snapshot = await aggregateTelemetry(scope => storeFor(scope), windowDays, scopeFilter)
            json(res, 200, snapshot)
            return
          }
          if (req.method === 'GET' && route === 'tour-proposal') {
            // 入殿导航：会话首轮时的开场建议（基于当前 scope 的 active 记忆）。
            // 仅取 active（greeting 区分空宫殿与多房间两种文案），suggestedStops ≤ 5。
            const rawScope = url.searchParams.get('scope')
            const scope: EngramScope = rawScope === 'project' ? 'project' : rawScope === 'shared' ? 'shared' : 'user'
            const store = await storeFor(scope)
            const filter = await store.list({ scope, status: 'active', limit: 200, offset: 0 })
            const focusKind = url.searchParams.get('focusKind')
            const proposal = buildTourProposal(scope, filter.records, focusKind ?? undefined)
            json(res, 200, {
              scope: proposal.empty ? 'empty' : scope,
              greeting: proposal.greeting,
              activeCount: proposal.activeCount,
              empty: proposal.empty,
              suggestedStops: proposal.suggestedStops.map(record => ({
                id: record.id,
                kind: record.kind,
                content: record.content,
                importance: record.importance,
                confidence: record.confidence,
              })),
            })
            return
          }
          if (req.method === 'GET' && route === 'refurb') {
            // 翻新清单：扫描当前 scope 的 active 条目，按规则生成 merge/demote/review/split 建议。
            // 响应内联 primary 与 merge 候选的记忆原文：
            // 执行是写操作，用户必须在看到原文的前提下决策（#19）。
            const rawScope = url.searchParams.get('scope')
            const scope: EngramScope = rawScope === 'project' ? 'project' : rawScope === 'shared' ? 'shared' : 'user'
            // 理由文案语言跟随面板（审计 I1）：服务端进程语言在启动时冻结，面板语言运行时可切——
            // 不带 lang 参数的旧客户端回落到 deps.language。
            const rawLang = url.searchParams.get('lang')
            const lang: EngramLanguage = rawLang === 'zh' || rawLang === 'en' || rawLang === 'ru' ? rawLang : deps.language
            const store = await storeFor(scope)
            const filter = await store.list({ scope, status: 'active', limit: 500, offset: 0 })
            const suggestions = gatherRefurbSuggestions(filter.records, lang, DEFAULT_REFURB_OPTIONS)
            const byId = new Map<string, MemoryRecord>(filter.records.map(record => [record.id, record]))
            // 原文全量返回（#19 问题一，方案 A）：清单满宽铺开后长文本完整展示；
            // 环回接口无带宽顾虑，不再截 280 字。
            const previewOf = (id: string) => {
              const record = byId.get(id)
              if (record === undefined) return null
              return { id: record.id, kind: record.kind, content: record.content, importance: record.importance }
            }
            json(res, 200, {
              scope,
              count: suggestions.length,
              suggestions: suggestions.map(suggestion => ({
                action: suggestion.action,
                primaryId: suggestion.primaryId,
                candidates: [...suggestion.candidates],
                scope: suggestion.scope,
                reason: suggestion.reason,
                confidence: suggestion.confidence,
                primary: previewOf(suggestion.primaryId),
                candidatePreviews: suggestion.candidates.map(previewOf).filter(p => p !== null),
              })),
            })
            return
          }
          if (req.method === 'GET' && route === 'version') {
            // 版本握手（审计 F8）：面板比对 client/server 版本，偏斜（客户端已热更、后端进程旧）时挂横幅提示重启。
            json(res, 200, { pluginVersion: deps.pluginVersion })
            return
          }
          if (req.method === 'GET' && route === 'registry') {
            // Обслуживание: чем считается содержимое базы (выбранная модель, каталог,
            // привязки) и какими словами оно описано (файлы словарей и их претензии).
            // Сам словарь панели здесь не едет: тексты для языков из файла отдаёт
            // отдельный маршрут `locales` (его клиент забирает при запуске), а карточке
            // обслуживания хватает счёта строк и претензий разбора.
            // Плюс состояние каждой базы — оно считается здесь, а не при сборке плагина.
            const states = await deps.baseStates()
            const view = deps.registry()
            // Языки, объявленные моделями: из них панель выбирает, чему заводить словарь.
            const modelLanguages = [...new Set(view.models.flatMap(row => row.languages))]
            json(res, 200, {
              ...view,
              dictionaryLanguages: deps.dictionaryLanguages(modelLanguages),
              // Язык дворца пересчитывается здесь вместе с базами: и то и другое меняется
              // на ходу, а снимок из сборки плагина этого не знает.
              palace: deps.palaceLanguage(states.bases),
              bases: states.bases,
              pendingBases: states.pendingBases,
              convertAvailable: deps.convertAvailable,
            })
            return
          }
          if (req.method === 'GET' && route === 'locales') {
            // Языки интерфейса, приходящие словарём: клиент объявляет их у хоста и
            // регистрирует их тексты. Список языков — из того же реестра, что и в
            // снимке обслуживания, поэтому «язык есть в списке дворца» и «язык можно
            // выбрать в интерфейсе» не расходятся.
            json(res, 200, { packs: deps.localePacks() })
            return
          }
          if (req.method === 'GET' && route === 'dictionary') {
            // Правка словаря: таблица терминов набора («панель» или «сообщения»).
            // Чтение отдаёт и строки, и пути слоёв, и претензии разбора: панель
            // показывает, что именно правится и откуда взят текущий перевод.
            const set = url.searchParams.get('set') ?? 'panel'
            if (!isDictionarySet(set)) {
              json(res, 400, { ok: false, error: `unknown dictionary set: ${set}` })
              return
            }
            // Язык набора: панель показывает словари того языка, на который человек
            // смотрит в блоке «Язык Плагина». Без параметра — текущий язык плагина.
            const language = url.searchParams.get('language')
            if (language !== null && !isLanguageCode(language)) {
              json(res, 400, { ok: false, error: `unknown language: ${language}` })
              return
            }
            json(res, 200, deps.dictionary.read(set, language ?? undefined))
            return
          }
          if (req.method === 'POST' && route === 'dictionary') {
            // Запись — только в пользовательский слой в каталоге данных: поставка
            // принадлежит выпуску плагина (см. i18n/dictionary-edit.ts). Тело:
            // { set, entries: [[английская строка, перевод], ...] } — только изменённые
            // клетки: пустое значение снимает правку, отсутствие строки оставляет прежнюю.
            // Наложение на текущий слой — в deps.dictionary.write (applyDictionaryPatch).
            if (!guardWrite(req, res)) return
            const body = await readBody(req, res, deps.language)
            // null = тело не прочиталось (битый JSON или больше 64 КиБ). Продолжать нельзя:
            // пустой список правок — это «снять всё», то есть молчаливая потеря слоя.
            if (body === null) return
            const set = body['set']
            if (!isDictionarySet(set)) {
              json(res, 400, { ok: false, error: `unknown dictionary set: ${String(set)}` })
              return
            }
            json(res, 200, deps.dictionary.write(set, entriesFromRequest(body['entries']), languageOf(body['language'])))
            return
          }
          if (req.method === 'POST' && route === 'dictionary-create') {
            // Заведение пустого словаря для языка, которого в плагине ещё нет. Тело:
            // { language }. Заводятся оба набора сразу и только в пользовательском
            // слое: поставка принадлежит выпуску, и дописывать в неё новый язык нельзя.
            if (!guardWrite(req, res)) return
            const body = await readBody(req, res, deps.language)
            if (body === null) return
            const language = languageOf(body['language'])
            if (language === undefined) {
              json(res, 400, { ok: false, error: `unknown language: ${String(body['language'])}` })
              return
            }
            json(res, 200, { ok: true, written: deps.dictionary.create(language) })
            return
          }
          if (req.method === 'POST' && route === 'dictionary-fill') {
            // Заполнение словаря моделью. Тело: { set, terms: [английская строка, ...] }.
            // Пишем только в черновик панели: файл словаря меняет «Сохранить», а не модель.
            if (!guardWrite(req, res)) return
            const body = await readBody(req, res, deps.language)
            if (body === null) return
            const set = body['set']
            if (!isDictionarySet(set)) {
              json(res, 400, { ok: false, error: `unknown dictionary set: ${String(set)}` })
              return
            }
            const raw = Array.isArray(body['terms']) ? body['terms'] as unknown[] : []
            const terms = raw.filter((term): term is string => typeof term === 'string')
            json(res, 200, await deps.dictionaryFill(set, terms))
            return
          }
          if (req.method === 'POST' && route === 'base-label') {
            // Обслуживание: поставить метку модели. Метка — единственное, что мы пишем
            // в чужую базу (решение 20.10); подтверждение одно на все базы, поэтому
            // тела у запроса нет: набор баз определяет состояние, а не клиент.
            if (!guardWrite(req, res)) return
            json(res, 200, await deps.writeBaseLabels())
            return
          }
          if (req.method === 'POST' && route === 'base-convert') {
            // Обслуживание: пересчитать векторы тем базам, которые стоят не на целевой
            // модели или растеряли векторы. Тела нет по той же причине, что у метки:
            // что делать — следует из состояния баз, а не из того, что прислал браузер.
            if (!guardWrite(req, res)) return
            json(res, 200, await deps.convertBases())
            return
          }
          if (req.method === 'POST' && route === 'palace-change/open') {
            // Первое событие собранного условия: окно открывает сервер, и он же remembers
            // его начало и язык, на котором стояли базы в этот момент. Панель после этого
            // только показывает отсчёт — но отсчёт считается по серверному началу, а не по
            // её собственному таймеру (решение 24.10).
            if (!guardWrite(req, res)) return
            const language = await deps.palaceCurrentLanguage()
            const window = deps.palaceGuard.open(language, Date.now())
            json(res, 200, {
              ok: true,
              startedAt: window.startedAt,
              from: window.from,
              left: deps.palaceGuard.left(Date.now(), deps.palaceChangeWindowSec),
              windowSec: deps.palaceChangeWindowSec,
            })
            return
          }
          if (req.method === 'POST' && route === 'palace-change') {
            // Смена языка дворца собранным условием (решение 20–21.10): язык выбран,
            // предохранитель снят, «Выполнить» нажато — всё в одном окне, отсчёт с
            // первого события.
            //
            // Проверка здесь, а не только в панели: панель может быть старой, а запрос —
            // прийти снаружи. Но основание проверки — серверное состояние: окно должно
            // быть открыто (открыть его может только маршрут palace-change/open, и момент
            // его открытия сервер запомнил сам), а язык, от которого уходят, сервер знает
            // тоже сам. Присланные панелью `from` и `startedAt` не входят в решение:
            // иначе условие выполнялось бы по построению у любого клиента (ревью #36).
            if (!guardWrite(req, res)) return
            const body = await readBody(req, res, deps.language)
            if (body === null) return
            const verdict = deps.palaceGuard.check(
              typeof body['language'] === 'string' ? body['language'] : '',
              Date.now(),
              deps.palaceChangeWindowSec,
            )
            if (!verdict.ok) {
              json(res, 409, { ok: false, reason: verdict.reason })
              return
            }
            // Окно закрыто: следующая смена языка начнётся новым открытием, а не продолжит
            // это же окно.
            deps.palaceGuard.close()
            const written = await deps.writePalaceLanguage(String(body['language']))
            if (!written.ok) { json(res, 200, { ...written, labels: null, convert: null }); return }
            // Что делать с базами, решает их новое состояние, а не клиент: после записи
            // языка целевая метка другая, и базы, стоявшие на прежнем языке, становятся
            // «чужой модели». Сначала метки (там, где модель угадывается), затем пересчёт.
            const labels = await deps.writeBaseLabels()
            const convert = await deps.convertBases()
            json(res, 200, { ...written, labels, convert })
            return
          }
          if (req.method === 'POST' && route === 'palace-language') {
            // Обслуживание: язык дворца выбран человеком. Пишется в конфигурацию
            // плагина; неизвестный язык — отказ, а не «ближайший похожий».
            //
            // Этот маршрут — то же самое действие, что и palace-change, только без
            // пересчёта баз, поэтому и предохранитель здесь тот же: окно должно быть
            // открыто, а окно — не истекло. Иначе это был бы обход: один и тот же
            // предохранитель на двух маршрутах — это предохранитель, которого нет
            // (ревью #36).
            //
            // «Язык должен отличаться» здесь не требуется: этот маршрут записывает
            // выбранный язык (первая настройка), и «язык тот же» здесь — не ошибка, а
            // отсутствие изменений. Проверка на отличие живёт в palace-change.
            if (!guardWrite(req, res)) return
            const body = await readBody(req, res, deps.language)
            if (body === null) return
            const wanted = body['language']
            if (typeof wanted !== 'string' || !isLanguageCode(wanted)) {
              json(res, 400, { ok: false, error: `unknown palace language: ${String(wanted)}` })
              return
            }
            const verdict = deps.palaceGuard.check(wanted, Date.now(), deps.palaceChangeWindowSec, { requireChanged: false })
            if (!verdict.ok) {
              json(res, 409, { ok: false, reason: verdict.reason })
              return
            }
            deps.palaceGuard.close()
            json(res, 200, await deps.writePalaceLanguage(wanted))
            return
          }
          if (req.method === 'GET' && route === 'models') {
            // 已注册的 provider 与模型清单：面板「辅助模型」下拉的数据源。
            json(res, 200, await deps.history.models())
            return
          }
          if (req.method === 'GET' && route === 'profile-block') {
            // 画像 curated block 审计视图：当前态 + 版本历史（新→旧，最多 20 条）。
            // 面板 diff 审计用；编辑走 engram_profile_edit 工具（乐观锁在存储层）。
            const scope = scopeOf(url.searchParams.get('scope'), 'user')
            const store = await storeFor(scope)
            const block = await store.getProfileBlock(scope)
            const versions = await store.listProfileBlockVersions(scope, 20)
            json(res, 200, { scope, block: block ?? null, versions })
            return
          }
          if (req.method === 'GET' && route === 'history-backfill') {
            // 历史回填估算：规则走 query（面板表单直接 GET），返回候选/轮数/预计调用次数；不写库不调 LLM。
            json(res, 200, {
              defaults: deps.history.defaults,
              estimate: await deps.history.estimate(historyRulesOf(Object.fromEntries(url.searchParams))),
            })
            return
          }
          if (req.method === 'GET' && route === 'history-backfill/status') {
            json(res, 200, deps.history.status())
            return
          }
          if (req.method === 'POST' && route === 'history-backfill/start') {
            if (!guardWrite(req, res)) return
            const body = await readBody(req, res, deps.language)
            if (body === null) return
            const started = deps.history.start(historyRulesOf(body))
            if (!started.ok) { json(res, 409, { ok: false, error: started.reason ?? messageIn(deps.language, 'misc.backfillCannotStart') }); return }
            json(res, 200, { ok: true, status: deps.history.status() })
            return
          }
          if (req.method === 'POST' && route === 'history-backfill/cancel') {
            if (!guardWrite(req, res)) return
            deps.history.cancel()
            json(res, 200, { ok: true, status: deps.history.status() })
            return
          }
          if (req.method === 'GET' && route === 'jev-config') {
            // Настройки Jev для панели: выбранные провайдер и модель плюс пороги, а
            // рядом — каталог провайдеров и их моделей, взятый у хоста DSH. Ни ключа,
            // ни адреса у Jev нет: их подставляет хост в момент вызова.
            const catalog = await deps.jev.host.catalog()
            json(res, 200, {
              ...jevConfigView(deps.jev.base, loadJevOverride(deps.jev.dbDir)),
              providers: catalog.providers,
            })
            return
          }
          if (req.method === 'POST' && route === 'jev-config') {
            // Панель сохраняет выбор: негодная правка отвергается целиком (400),
            // годная — перезаписывает файл перекрытия и возвращает новый вид.
            if (!guardWrite(req, res)) return
            const body = await readBody(req, res, deps.language)
            if (body === null) return
            const parsed = parseJevPatch(loadJevOverride(deps.jev.dbDir), body)
            if (typeof parsed === 'string') { json(res, 400, { error: parsed }); return }
            saveJevOverride(deps.jev.dbDir, parsed)
            const catalog = await deps.jev.host.catalog()
            json(res, 200, {
              ok: true,
              view: { ...jevConfigView(deps.jev.base, parsed), providers: catalog.providers },
            })
            return
          }
          if (req.method === 'POST' && route === 'jev-test') {
            // Проверка связи: адрес и ключ собирает хост по выбранному провайдеру,
            // запрос — минимальный ping. Он же подтверждает, что модель отвечает
            // протоколом System One, то есть действительно является Jev.
            if (!guardWrite(req, res)) return
            const body = await readBody(req, res, deps.language)
            if (body === null) return
            const base = effectiveJevConfig(deps.jev.base, loadJevOverride(deps.jev.dbDir))
            const provider = typeof body.provider === 'string' && body.provider.trim() !== ''
              ? body.provider.trim()
              : base.provider
            const model = typeof body.model === 'string' && body.model.trim() !== ''
              ? body.model.trim()
              : base.model
            // Адрес из поля панели; пусто — шаблон от провайдера (решает мост).
            const endpoint = typeof body.endpoint === 'string' && body.endpoint.trim() !== ''
              ? body.endpoint.trim()
              : base.endpoint
            if (provider === undefined || model === undefined) {
              json(res, 200, {
                ok: false,
                elapsedMs: 0,
                probability: undefined,
                error: message('misc.jevProviderMustBeSelected'),
              })
              return
            }
            const connection = await deps.jev.host.connection(provider, model, base.timeoutMs, endpoint)
            if (typeof connection === 'string') {
              json(res, 200, { ok: false, elapsedMs: 0, probability: undefined, error: connection })
              return
            }
            // Рядом с замером отдаём то, чем мерили: панель печатает параметры проверки
            // строкой состояния, и брать их из формы было бы враньём — форма может
            // разойтись с тем, что реально ушло в запрос.
            json(res, 200, {
              ...await testJevConnection(connection),
              ...(endpoint === undefined ? {} : { endpoint }),
              model,
              timeoutMs: base.timeoutMs,
            })
            return
          }
          if (req.method === 'POST' && route === 'jev-models') {
            // Живой список моделей провайдера (`GET {baseURL}/models` его ключом):
            // панель берёт его как подсказки к полю модели, сужая до Jev-моделей,
            // когда такие в списке есть.
            if (!guardWrite(req, res)) return
            const body = await readBody(req, res, deps.language)
            if (body === null) return
            const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
            if (provider === '') {
              json(res, 200, {
                models: [],
                filtered: false,
                error: message('misc.jevProviderMustBeSelected'),
              })
              return
            }
            json(res, 200, await deps.jev.host.models(provider))
            return
          }
          if (req.method === 'GET' && route === 'jev-observations') {
            // 近期裁决观测（进程内环形缓冲，重启清空）：新→旧，最多 50 条。
            json(res, 200, { items: [...listJevObservations()].reverse() })
            return
          }
          if (req.method === 'POST' && route === 'consolidate') {
            // 闭馆整理手动触发：面板「管家整理」按钮；嵌入不可用时仅归档 + 启发式去重。
            // 可选 candidates：仅把指定 ids 当作合并阶段种子（其它条目仅在与种子相似时被并入）。
            if (!guardWrite(req, res)) return
            const body = await readBody(req, res, deps.language)
            if (body === null) return
            adoptBodySelector(body)
            const rawScope = typeof body.scope === 'string' ? body.scope : 'user'
            const scope: 'user' | 'project' | 'shared' = rawScope === 'project' ? 'project' : rawScope === 'shared' ? 'shared' : 'user'
            const candidates = Array.isArray(body.candidates)
              ? body.candidates.filter((value: unknown): value is string => typeof value === 'string')
              : undefined
            const store = await storeFor(scope)
            const report = await runConsolidation(store, deps.embedder, candidates === undefined
              ? { scope }
              : { scope, mergeCandidateIds: candidates })
            json(res, 200, report)
            return
          }
          if (req.method === 'POST' && route === 'backup') {
            if (!guardWrite(req, res)) return
            const result = await createBackup(deps.dbDir, deps.pluginVersion)
            json(res, 200, { archivePath: result.archivePath, bytes: result.bytes, meta: result.meta, schemaVersion: BACKUP_SCHEMA_VERSION })
            return
          }
          if (req.method === 'POST' && route === 'restore-backup') {
            if (!guardWrite(req, res)) return
            const body = await readBody(req, res, deps.language)
            if (body === null) return
            if (typeof body.archivePath !== 'string' || body.archivePath === '') {
              json(res, 400, { error: 'archivePath required' })
              return
            }
            // 路径安全：必须在 dbDir 子树内（防止任意文件覆盖）。relative 判定对两种分隔符都成立
            // ——旧写法 startsWith(dbDir + '/') 在 Windows 恒 false，restore 恒 400（审计 F26）。
            const normalized = join(deps.dbDir, body.archivePath.replace(/^\/+/, ''))
            const rel = relative(deps.dbDir, normalized)
            if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
              json(res, 400, { error: messageIn(deps.language, 'misc.archivePathOutsideDbDir') })
              return
            }
            try {
              const result = await restoreBackup(normalized, deps.dbDir)
              // 审计 F16：rename 换掉了 .db 的 inode，必须让缓存连接全部失效，
              // 否则「恢复成功」后读旧库、新写入进 .before-restore-* 且重启后静默丢失。
              await deps.closeStores()
              json(res, 200, { restored: result.restored, meta: result.archiveMeta })
            } catch (restoreError: unknown) {
              const message = restoreError instanceof Error ? restoreError.message : String(restoreError)
              json(res, 400, { error: messageIn(deps.language, 'misc.restoreFailed', { message }) })
            }
            return
          }
          if (req.method === 'POST' && (route === 'update' || route === 'forget' || route === 'restore')) {
            if (!guardWrite(req, res)) return
            const body = await readBody(req, res, deps.language)
            if (body === null) return
            if (typeof body.id !== 'string' || body.id === '') { json(res, 400, { error: 'id required' }); return }
            adoptBodySelector(body)
            const scope = scopeOf(typeof body.scope === 'string' ? body.scope : null, 'user')
            const store = await storeFor(scope)
            if (route === 'update') {
              if (typeof body.content !== 'string' || body.content.trim() === '') { json(res, 400, { error: 'content required' }); return }
              const old = await store.get(body.id as never)
              if (old === undefined) { json(res, 404, { error: messageIn(deps.language, 'misc.recordNotFound', { id: body.id }) }); return }
              const record = await store.update({
                id: body.id as never,
                scope,
                kind: typeof body.kind === 'string' && ['fact', 'preference', 'decision', 'episode', 'skill'].includes(body.kind)
                  ? body.kind as EngramKind
                  : old.kind,
                content: body.content,
                ...(typeof body.importance === 'number' && Number.isFinite(body.importance)
                  ? { importance: Math.min(1, Math.max(0, body.importance)) }
                  : {}),
              })
              json(res, 200, { record })
              return
            }
            const record = route === 'forget'
              ? await store.forget(body.id as never)
              : await store.restore(body.id as never)
            json(res, 200, { record })
            return
          }
          json(res, 404, { error: 'unknown route' })
        } catch (error) {
          // 未知项目选择器：面板传了不认识的 dbName（工作区已删/改名）→ 明确 404 而不是 500。
          if (error instanceof UnknownProjectError) { json(res, 404, { error: 'unknown project' }); return }
          json(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),
    'dsh-engram: api routes',
  )
}
