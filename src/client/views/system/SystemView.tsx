/**
 * System 工作面：运行时状态、存储与日志、模型与词典、历史回填、Jev 服务。
 *
 * 0.13 起这里是一张「服务控制台」：二级导航切分六个面向（Runtime / Storage /
 * Models / Backfill / Jev / Logs），每个面向只回答一个问题，写操作的后果写在按钮旁边。
 * 独立成模块的理由：这些卡片合计两千余行，塞在面板主体里会淹没导航与内容区；
 * 且视图回引 EngramPanel 会形成 CJS 闭包循环依赖。
 * @module @kenz1117/dsh-engram/client/views/system/SystemView
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { createPortal } from 'react-dom'
import styles from '../../panel.module.css'
import { api } from '../../rpc.ts'
import { useApi } from '../../useApi.ts'
import { usePersistedState, usePersistedString } from '../../UiStorage.ts'
import type { ToastController } from '../../Toast.tsx'
import { EmptyState, LoadFailedLine, Metric, SelectField, type T } from '../../ui/panel-kit.tsx'
import {
  activityDetail,
  type ActivityRow,
  formatBytes,
  logDotClass,
  LOG_FILTER_KEY,
  LOG_GROUPS,
  type LogFilter,
  type LogStorageInfo,
  opLabel,
  relTime,
  type TelemetrySnapshot,
} from '../../ui/model.ts'
import { en, ru, zh, type EngramKey } from '../../locales/index.ts'
import { needsTranslation, splitDictionaryPatch, splitFillBatch } from '../../../i18n/dictionary-limits.ts'
import { windowLeft } from '../../../registry/palace-change.ts'
import type { PanelLang } from '../../translate.ts'
import pluginPackageJson from '../../../../package.json' with { type: 'json' }

/** 客户端 bundle 版本：单一来源 = package.json（与面板握手横幅同源）。 */
const CLIENT_VERSION: string = pluginPackageJson.version

export function LogPanel({ t, telemetry, project, onCleared }: {
  t: T
  telemetry: TelemetrySnapshot | null
  /** 项目宫殿选择器（仅用于重载依赖；注入在 api() 里做）。 */
  project: string | null
  /** 清理成功后回调：让总览遥测（瓦片计数）跟着重取，否则它显示的是清理前的旧值。 */
  onCleared?: (() => void) | undefined
}): React.ReactElement {
  const [rows, setRows] = useState<ActivityRow[] | null>(null)
  const [filter, setFilter] = useState<LogFilter>('all')
  const [failed, setFailed] = useState<string | null>(null)
  const [reloadTick, setReloadTick] = useState(0)
  // Журнал дворца — наш собственный: показываем путь и размер, и даём его очистить.
  const [storage, setStorage] = useState<LogStorageInfo | null>(null)
  const [storageFailed, setStorageFailed] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  useEffect(() => {
    let cancelled = false
    api<{ operations: ActivityRow[] }>('activity?limit=50', undefined, true)
      .then((data) => { if (!cancelled) { setRows(data.operations); setFailed(null) } })
      .catch((error: Error) => { if (!cancelled) setFailed(error.message) })
    api<LogStorageInfo>('log-info', undefined, true)
      .then((data) => { if (!cancelled) { setStorage(data); setStorageFailed(null) } })
      .catch((error: Error) => { if (!cancelled) setStorageFailed(error.message) })
    return () => { cancelled = true }
  }, [project, reloadTick])
  /** Очистка журнала: первый клик — вопрос, второй — действие (как у прочих удалений). */
  const clearLog = (): void => {
    if (!confirmClear) { setConfirmClear(true); return }
    setClearing(true)
    api<LogStorageInfo>('log-clear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, true)
      .then((data) => {
        setStorage(data)
        setStorageFailed(null)
        setNotice(t('logClearDone', { n: data.totals.deleted ?? 0, size: formatBytes(data.totals.fileBytes) }))
        setConfirmClear(false)
        setReloadTick(tick => tick + 1)
        // Счётчики-瓦плики берутся из telemetry всего обзора: без этого они остались бы
        // от предыдущей (до очистки) загрузки — показали бы уже удалённые строки.
        onCleared?.()
      })
      .catch((error: Error) => { setStorageFailed(error.message); setConfirmClear(false) })
      .finally(() => { setClearing(false) })
  }
  const allow = LOG_GROUPS[filter]
  const visible = (rows ?? []).filter(row => allow === null || allow.includes(row.op))
  const counts = telemetry?.counts
  return (
    <section className={styles.section}>
      {/* 一条工具条：标题 + 条数 + 近 7 天三类计数（带类别色点）+ 类别筛选，
          取代原先「独立计数卡 + 筛选行」两段式。 */}
      {/* v0.8.8 近 7 天四类计数升级为 stat 瓦片行 */}
      <div className={styles.logTiles}>
        <div className={styles.logTile}>
          <span className={styles.logTileTop}><i className={`${styles.logDot} ${styles.logDotWrite}`} aria-hidden="true" />{t('logFilterWrite')}</span>
          <b className={styles.logTileValue}>{counts?.writes ?? 0}</b>
        </div>
        <div className={styles.logTile}>
          <span className={styles.logTileTop}><i className={`${styles.logDot} ${styles.logDotIngest}`} aria-hidden="true" />{t('logFilterIngest')}</span>
          <b className={styles.logTileValue}>{counts?.ingestDones ?? 0}</b>
        </div>
        <div className={styles.logTile}>
          <span className={styles.logTileTop}><i className={`${styles.logDot} ${styles.logDotRetrieve}`} aria-hidden="true" />{t('logFilterRetrieve')}</span>
          <b className={styles.logTileValue}>{counts?.searches ?? 0}</b>
        </div>
        <div className={styles.logTile}>
          <span className={styles.logTileTop}><i className={`${styles.logDot} ${styles.logDotOrganize}`} aria-hidden="true" />{t('logFilterOrganize')}</span>
          <b className={styles.logTileValue}>{counts?.consolidations ?? 0}</b>
        </div>
      </div>
      <div className={styles.logToolbar}>
        <h4 className={styles.sectionTitle}>{t('tabLog')}</h4>
        <span className={styles.sectionHint}>{t('logCount', { n: visible.length })}</span>
        <div className={styles.segGroup} role="tablist">
          {(['all', 'write', 'ingest', 'retrieve', 'organize'] as const).map(option => (
            <button key={option} type="button" role="tab" aria-selected={filter === option}
              className={filter === option ? `${styles.segItem} ${styles.on}` : styles.segItem}
              onClick={() => { setFilter(option) }}>{t(LOG_FILTER_KEY[option])}</button>
          ))}
        </div>
      </div>
      {/* Журнал дворца — наш собственный: путь, размер и кнопка очистки. Журналы хост-сессий
          (dsh) сюда не попадают вовсе: мы их не читаем и не трогаем. */}
      <div className={styles.logStorage}>
        <div className={styles.logStorageMain}>
          <span className={styles.logStoragePath} title={storage?.dir ?? ''}>{t('logStoragePath', { path: storage?.dir ?? '…' })}</span>
          <span className={styles.logStorageSize}>{storage === null ? t('loading') : formatBytes(storage.totals.fileBytes)}</span>
          <button type="button" className={styles.button} disabled={clearing || storage === null} onClick={clearLog}>
            {confirmClear ? t('logClearConfirm') : t('logClear')}
          </button>
        </div>
        <div className={styles.logStorageParts}>
          {(storage?.parts ?? []).map(part => (
            <span key={part.path} className={styles.logStoragePart} title={part.path}>
              {t('logStoragePart', { file: part.path.split(/[\\/]/).pop() ?? part.path, size: formatBytes(part.fileBytes), n: part.rows })}
            </span>
          ))}
        </div>
        <span className={styles.logStorageHint}>{t('logStorageHint')}</span>
        {notice === null ? null : <span className={styles.logStorageNotice}>{notice}</span>}
        {storageFailed === null ? null : <LoadFailedLine t={t} msg={storageFailed} onRetry={() => { setReloadTick(tick => tick + 1) }} />}
      </div>
      <div className={styles.panelCard}>
        {failed !== null
          ? <LoadFailedLine t={t} msg={failed} onRetry={() => { setReloadTick(tick => tick + 1) }} />
          : rows === null
          ? <div className={styles.expandLoading}>{t('loading')}</div>
          : visible.length === 0
            ? <EmptyState title={t('activityEmpty')} hint={t('emptyHint')} />
            : (
              <div className={styles.logList}>
                {visible.map((op, index) => (
                  <div key={index} className={styles.logRow}>
                    <i className={logDotClass(op.op)} aria-hidden="true" />
                    <span className={styles.logTime}>{relTime(t, op.at)}</span>
                    <span className={styles.logOp}>{opLabel(t, op.op)}</span>
                    <span className={styles.logScope}>{op.scope === 'user' ? t('scopeUser') : t('scopeProject')}</span>
                    <span className={styles.logDetail} title={op.detail ?? ''}>{activityDetail(t, op.detail)}</span>
                  </div>
                ))}
              </div>
            )}
      </div>
    </section>
  )
}

type PalaceAskChoice = string

/**
 * Пояснение к окну первого запуска — сразу на трёх языках, одно под другим.
 *
 * Язык интерфейса в этот момент ещё не выбран человеком (его выбирают как раз здесь),
 * поэтому объяснение не подчиняется языку панели: показываем все три языка, на которых
 * плагин говорит со дня поставки. Берём тексты из вшитых наборов (`locales/*.ts`), а не
 * переписываем их здесь: одна и та же фраза не должна жить в двух местах.
 */
const PALACE_ASK_PARTS: readonly string[] = [zh.palaceAskBody, en.palaceAskBody, ru.palaceAskBody]

/**
 * Обещание для тех, чьего языка у дворца ещё нет, — тоже на трёх языках.
 *
 * Оно относится только к выбору «другой язык»: человеку с нашей локалью этот текст
 * ничего не объясняет, а тому, чья локаль не наша, — объясняет весь его путь (язык
 * запишется настоящим кодом, служебные надписи будут английскими, инструкция для
 * агента лежит в плагине). Показывать его на языке интерфейса нельзя: этим людям наш
 * язык как раз и не родной, поэтому текст идёт теми же тремя частями, что и пояснение.
 */
const PALACE_FALLBACK_PARTS: readonly string[] = [zh.palaceAskFallback, en.palaceAskFallback, ru.palaceAskFallback]

/** Подставить код языка в часть обещания: `{language}` — единственная подстановка там. */
function withLanguage(part: string, code: string): string {
  return part.split('{language}').join(code)
}

export function PalaceLanguageAsk({ t, overlayHost, dryRun, toast, onClose }: {
  t: T
  readonly overlayHost: { readonly current: HTMLDivElement | null }
  /** Проверка окна без записи: язык дворца не меняется, конфигурация не трогается. */
  readonly dryRun?: boolean
  /** Куда сообщать о сбросе (нужен только в проверке). */
  readonly toast?: ToastController
  /** Закрыть проверку снаружи (окно проверки живёт, пока его держит панель). */
  readonly onClose?: () => void
}): React.ReactElement | null {
  const [palace, setPalace] = useState<RegistrySnapshot['palace']>(null)
  /** Языки дворца с сервера: что предлагать в выборе. */
  const [languages, setLanguages] = useState<readonly PalaceLanguageOption[]>([])
  /** Предохранитель: пока снят — идёт отсчёт окна. */
  const [guard, setGuard] = useState(true)
  /** Длина окна из настройки: её же проверяет сервер, поэтому в проверке она настоящая. */
  const [windowSec, setWindowSec] = useState(GUARD_SECONDS)
  const [left, setLeft] = useState(GUARD_SECONDS)
  const [suggested, setSuggested] = useState<PalaceAskChoice | null>(null)
  const [choice, setChoice] = useState<PalaceAskChoice | null>(null)
  const [pending, setPending] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [closed, setClosed] = useState(false)
  // Проверка: окно открывается независимо от состояния дворца и ничего не читает
  // из конфигурации. Локаль берём ту же, что и в жизни, — иначе проверка показывала
  // бы не тот язык, который человек увидит на первом старте.
  //
  // Список языков берётся с сервера и в проверке тоже: проверка должна показывать
  // ровно то, что человек увидит на первом старте, а не копию тройки из сборки.
  useEffect(() => {
    if (dryRun !== true) return
    const machine = ((): string => {
      try { return (Intl.DateTimeFormat().resolvedOptions().locale.split('-')[0] ?? '').toLowerCase() } catch { return '' }
    })()
    setPalace({ setting: null, source: 'test', conflict: false, machine, dialogue: null, bases: null, state: 'ask' })
    let cancelled = false
    api<RegistrySnapshot>('registry')
      .then((snapshot) => {
        if (cancelled) return
        // Поля-новички читаются терпимо к пустоте: сервер плагина и его клиент грузятся
        // из разных файлов, и сразу после обновления клиент может оказаться новее сервера
        // (старый процесс в памяти). Без этого панель падала бы целиком с TypeError.
        setLanguages(snapshot.languages ?? [])
        // Длина окна — из настройки: проверка должна считать ровно так же, как жизнь.
        setWindowSec(snapshot.palaceChangeWindowSec ?? GUARD_SECONDS)
        setLeft(snapshot.palaceChangeWindowSec ?? GUARD_SECONDS)
        const supported = (snapshot.languages ?? []).some(row => row.code === machine) ? machine : null
        setSuggested(supported ?? 'other')
        setChoice(supported ?? 'other')
      })
      .catch((error: Error) => { if (!cancelled) setFailed(error.message) })
    return () => { cancelled = true }
  }, [dryRun])
  // Отсчёт окна — свойство формы, а не фоновая задача: сняли предохранитель — пошло,
  // поставили обратно — обнулилось. На нуле предохранитель встаёт сам.
  useEffect(() => {
    if (guard) return
    if (left <= 0) {
      setGuard(true)
      setLeft(windowSec)
      toast?.push('reset', t('guardReset', { seconds: windowSec }))
      return
    }
    const id = setTimeout(() => { setLeft(left - 1) }, 1000)
    return () => { clearTimeout(id) }
  }, [guard, left, windowSec, toast?.push, t])
  useEffect(() => {
    if (dryRun === true) return
    let cancelled = false
    api<RegistrySnapshot>('registry')
      // palace !== null значит «определять было что, а решения нет»: настройка всё ещё auto.
      .then((snapshot) => {
        if (cancelled || snapshot.palace === null) return
        // При расхождении подставляем язык диалогов, а не локаль: человек уже показал,
        // на каком языке он говорит, и это сильнее настроек машины. В остальных случаях
        // предустановка — локаль Windows.
        const preferred = snapshot.palace.state === 'mismatch'
          ? snapshot.palace.dialogue
          : snapshot.palace.machine
        // Список языков терпит пустоту: старый сервер его не отдаёт, и окно всё равно
        // должно открыться — с одним выбором «другой язык», а не с пустым полем.
        const supported = (snapshot.languages ?? []).some(row => row.code === preferred) ? preferred : null
        setLanguages(snapshot.languages ?? [])
        setPalace(snapshot.palace)
        setSuggested(supported ?? 'other')
        setChoice(supported ?? 'other')
      })
      .catch((error: Error) => { if (!cancelled) setFailed(error.message) })
    return () => { cancelled = true }
  }, [])
  /**
   * Окно открывает сервер: он сам запоминает начало отсчёта и язык, на котором стоят базы
   * (решение 24.10). Без этого сервер откажет в записи: предохранитель держит сервер,
   * и открыть окно должен он.
   *
   * Открытие здесь — то самое первое событие собранного условия: человек увидел окно и
   * начал выбирать.
   */
  useEffect(() => {
    if (dryRun === true) return
    void api<{ ok: boolean, startedAt: number, left: number }>('palace-change/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
      .catch(() => { /* окно не открылось — запись будет отклонена, и это правильно */ })
  }, [dryRun])
  if (palace === null || closed) return null
  /**
   * Закрыть окно.
   *
   * В проверке окно держит панель (`panelTest`), поэтому закрытие сообщается наружу.
   * Без этого панель считала проверку открытой, а окно уже закрылось, — и повторное
   * нажатие «Тест панели» ничего не делало.
   */
  const close = (): void => { setClosed(true); onClose?.() }
  // Опора есть: дворец настроился сам — говорим, на что, и ничего не спрашиваем.
  if (palace.state === 'auto') {
    const note = (
      <div className={styles.palaceNote} role="status">
        {t('palaceAutoNote', { language: (palace.dialogue ?? '').toUpperCase() })}
      </div>
    )
    return overlayHost.current === null ? note : createPortal(note, overlayHost.current)
  }
  const mismatch = palace.state === 'mismatch'
  const basesName = palace.bases === 'mixed' ? t('palaceMismatchMixed') : (palace.bases ?? '').toUpperCase()
  const title = mismatch ? t('palaceMismatchTitle') : t('palaceAskTitle')
  const body = mismatch
    ? t('palaceMismatchBody', { dialogue: (palace.dialogue ?? '').toUpperCase(), bases: basesName })
    : t('palaceAskBody')
  /**
   * Код языка за четвёртым выбором — локаль машины как есть (`fr`).
   *
   * Подставлять вместо неё английский нельзя: это тот самый заменитель, из-за
   * которого француз получал дворец «на своём языке», а на деле английский.
   * null — локаль прочитать не удалось либо она не похожа на код языка; тогда
   * выбор не отправляется, а человеку говорится, что код не определился.
   */
  const otherCode = LANGUAGE_CODE.test(palace.machine) ? palace.machine : null
  const submit = (): void => {
    if (choice === null) return
    if (choice === 'other' && otherCode === null) { setFailed(t('palaceAskNoCode')); return }
    // «Другой язык» передаёт дворцу настоящий код языка, а не английский: язык
    // дворца становится `fr`, служебные тексты он берёт английским словарём,
    // пока для языка не появится файл (решение 21.10, В.09).
    const language = choice === 'other' ? (otherCode as string) : choice
    // Проверка ничего не пишет: показываем, что было бы выбрано, и закрываемся.
    if (dryRun === true) {
      toast?.push('success', t('panelTestDone', { language: language.toUpperCase() }))
      close()
      return
    }
    setPending(true)
    api<{ ok: boolean, language: string, error?: string }>('palace-language', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ language }),
    })
      .then((result) => {
        if (!result.ok) { setFailed(result.error ?? ''); return }
        setSaved(result.language.toUpperCase())
        setFailed(null)
      })
      .catch((error: Error) => { setFailed(error.message) })
      .finally(() => { setPending(false) })
  }
  const choices: readonly PalaceAskChoice[] = [...languages.map(row => row.code), 'other']
  const screen = (
    <div className={styles.importLayer} role="dialog" aria-modal="true" aria-label={title}>
      <div className={styles.importScrim} onClick={() => { if (!pending) close() }} />
      <div className={styles.drawer}>
        <header className={styles.drawerHead}>
          <div className={styles.drawerTitle}>
            <h3>{title}</h3>
          </div>
          <button type="button" className={styles.drawerClose} aria-label={t('drawerClose')}
            disabled={pending} onClick={close}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M2 2 L12 12 M12 2 L2 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
            </svg>
          </button>
        </header>
        <div className={`${styles.drawerBody} ${styles.palaceAskBody}`}>
          {/* Расхождение языков — не первый запуск: там объясняется конкретная пара
              языков, и переводить это на три языка сразу незачем. */}
          {mismatch
            ? <p className={styles.regNote}>{body}</p>
            : (
              <div className={styles.palaceAskText}>
                {PALACE_ASK_PARTS.map(part => <p key={part} className={styles.regNote}>{part}</p>)}
              </div>
            )}
          <div className={styles.palaceChoiceList} role="radiogroup" aria-label={title}>
            {choices.map(value => (
              <label key={value} className={choice === value ? `${styles.palaceChoice} ${styles.palaceChoiceOn}` : styles.palaceChoice}>
                <input type="radio" name="palace-language-choice" value={value}
                  checked={choice === value} disabled={pending || saved !== null}
                  onChange={() => { setChoice(value) }} />
                <span className={styles.palaceChoiceName}>
                  {value === 'other'
                    ? t('palaceAskOther')
                    : (languages.find(row => row.code === value)?.label ?? value.toUpperCase())}
                </span>
                {suggested === value ? <span className={styles.palaceChoiceNote}>{t('palaceAskSuggested')}</span> : null}
              </label>
            ))}
          </div>
          {choice === 'other'
            ? (otherCode === null
              ? <p className={styles.palaceAskHint}>{t('palaceAskNoCode')}</p>
              : (
                <div className={styles.palaceAskText}>
                  {PALACE_FALLBACK_PARTS.map(part => (
                    <p key={part} className={styles.palaceAskHint}>{withLanguage(part, otherCode.toUpperCase())}</p>
                  ))}
                </div>
              ))
            : null}
          {dryRun === true ? (
            <div className={styles.regGroup}>
              <span className={styles.regGroupTitle}>{t('panelTestTitle')}</span>
              <label className={styles.regNote}>
                <input type="checkbox" checked={guard}
                  onChange={(event) => {
                    const next = event.target.checked
                    setGuard(next)
                    setLeft(windowSec)
                  }} />
                {' '}
                {guard ? t('guardArmed') : t('guardDisarmed', { seconds: left })}
              </label>
            </div>
          ) : null}
          {saved === null ? null : <p className={styles.regNote}>{t('palaceAskSaved', { language: saved })}</p>}
          {failed === null ? null : <p className={styles.regNote}>{t('loadFailed', { msg: failed })}</p>}
          <div className={styles.modalFoot}>
            <button type="button" className={styles.button} disabled={pending}
              onClick={close}>{t('palaceAskLater')}</button>
            <button type="button" className={`${styles.button} ${styles.primary}`}
              disabled={pending || choice === null || saved !== null} onClick={submit}>
              {pending ? t('palaceAskSaving') : t('palaceAskContinue')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
  // Окно fixed, но .panel образует собственный контекст наложения (см. .overlayHost):
  // внутри него оверлей не перекрыл бы окно плагина целиком, поэтому — порталом в якорь.
  return overlayHost.current === null ? screen : createPortal(screen, overlayHost.current)
}

interface BackfillEstimateView {
  readonly rules: {
    readonly days: number
    readonly maxTurnsPerSession: number
    readonly maxTotalTurns: number
    readonly includeSubagents: boolean
    readonly includeSeeded: boolean
    readonly includeNoCwd: boolean
  }
  readonly candidates: number
  readonly eligibleTurns: number
  readonly pendingTurns: number
  readonly alreadyIngested: number
  readonly skipped: {
    readonly subagent: number
    readonly seeded: number
    readonly noCwd: number
    readonly tooOld: number
    readonly unreadable: number
  }
  readonly truncated: boolean
  readonly unavailable?: string
}

interface ModelsView {
  readonly providers: readonly { readonly id: string; readonly name: string; readonly models: readonly { readonly id: string; readonly name: string }[] }[]
  readonly failures: readonly string[]
}

interface BackfillStatusView {
  readonly progress: {
    readonly state: 'running' | 'done' | 'cancelled' | 'failed'
    readonly sessionsTotal: number
    readonly sessionsDone: number
    readonly turnsPlanned: number
    readonly turnsDone: number
    readonly memoriesWritten: number
    readonly turnsSkipped: number
    readonly turnsFailed: number
    readonly skipReasons: Readonly<Record<string, number>>
    readonly currentSession?: string
  }
  readonly failures: readonly { readonly sessionId: string; readonly turn: number; readonly reason: string }[]
  readonly error?: string
}

const SKIP_KEY: Record<string, EngramKey> = {
  'low-activity': 'skipLowActivity',
  chitchat: 'skipChitchat',
  'capture-forbidden': 'skipForbidden',
  'no-user-content': 'skipNoContent',
  'already-ingested': 'skipAlready',
  'no-such-turn': 'skipNoTurn',
  'no-previous-turn': 'skipNoTurn',
  'no-route-in-log': 'skipNoRoute',
  // hook 产出的原因值（hook.ts）：不可解析 'unparseable-output'、空答案 'empty-answer'。
  // 旧键 'unparsable' 从未与产出对上过，导致该原因一直以原始英文展示（#11）。
  'unparseable-output': 'skipUnparsable',
  'empty-answer': 'skipEmptyAnswer',
  // 审计 F13 对偶面：全败回合保留 pending，面板要把它翻成人话而不是裸枚举。
  'all-candidates-failed': 'skipAllCandidatesFailed',
}

function skipLabel(t: T, reason: string): string {
  const key = SKIP_KEY[reason]
  return key === undefined ? reason : t(key)
}

function HistoryBackfillCard({ t, toast }: { t: T; toast: ToastController }): React.ReactElement {
  /** 规则（持久化）：时间窗与过滤开关以字符串存，便于 localStorage 往返。 */
  const [days, setDays] = usePersistedState<string>('backfill.days', '7', ['7', '30', '90', '0'])
  const [maxTurns, setMaxTurns] = usePersistedString('backfill.maxTurns', '20')
  const [maxTotal, setMaxTotal] = usePersistedString('backfill.maxTotal', '200')
  const [subagents, setSubagents] = usePersistedState<string>('backfill.subagents', 'false', ['false', 'true'])
  const [seeded, setSeeded] = usePersistedState<string>('backfill.seeded', 'false', ['false', 'true'])
  const [noCwd, setNoCwd] = usePersistedState<string>('backfill.noCwd', 'false', ['false', 'true'])
  /** 辅助模型选择：'' = 自动（用当前在用的模型）；否则 `provider::model`。 */
  const [modelChoice, setModelChoice] = usePersistedString('backfill.model', '')
  const [models, setModels] = useState<ModelsView | null>(null)
  const [estimate, setEstimate] = useState<BackfillEstimateView | null>(null)
  const [status, setStatus] = useState<BackfillStatusView | null>(null)
  const [busy, setBusy] = useState(false)

  // 已注册模型清单：只拉一次（模型注册表变化不频繁，切换 tab 会重新挂载）。
  useEffect(() => {
    let cancelled = false
    api<ModelsView>('models')
      .then((data) => { if (!cancelled) setModels(data) })
      .catch(() => { if (!cancelled) setModels({ providers: [], failures: [] }) })
    return () => { cancelled = true }
  }, [])

  /** 显式选中的辅助模型（未选 = 交给后端用当前在用的模型）。 */
  const selection = ((): { provider: string; model: string } | undefined => {
    if (modelChoice === '') return undefined
    const separator = modelChoice.indexOf('::')
    if (separator <= 0) return undefined
    return { provider: modelChoice.slice(0, separator), model: modelChoice.slice(separator + 2) }
  })()

  const params = new URLSearchParams({
    days, maxTurnsPerSession: maxTurns, maxTotalTurns: maxTotal,
    includeSubagents: subagents, includeSeeded: seeded, includeNoCwd: noCwd,
  })
  if (selection !== undefined) {
    params.set('provider', selection.provider)
    params.set('model', selection.model)
  }
  const query = params.toString()

  const reload = useCallback((): void => {
    setBusy(true)
    api<{ estimate: BackfillEstimateView }>(`history-backfill?${query}`)
      .then((data) => { setEstimate(data.estimate) })
      .catch((error: Error) => { toast.push('error', error.message) })
      .finally(() => { setBusy(false) })
    // 依赖 toast.push（稳定引用）而非整个 toast 对象：后者每次渲染换新，
    // 曾让本 effect 在每次父渲染时重拉估算（审计 N19）。
  }, [query, toast.push])
  useEffect(() => { reload() }, [reload])

  // 进度轮询：运行中每 1.5 秒一次；空闲只拉一次拿最终态。
  const running = status?.progress.state === 'running'
  // v0.8.12:轮询失败不再静默——服务重启会杀掉运行中的回填,吞掉错误会让 UI 永远停在「回填中」。
  const [pollFailed, setPollFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    const poll = (): void => {
      api<BackfillStatusView>('history-backfill/status')
        .then((data) => { if (!cancelled) { setStatus(data); setPollFailed(false) } })
        .catch(() => { if (!cancelled) setPollFailed(true) })
    }
    poll()
    if (!running) return () => { cancelled = true }
    const timer = window.setInterval(poll, 1500)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [running])

  const start = (): void => {
    setBusy(true)
    api<{ ok: boolean; status: BackfillStatusView }>('history-backfill/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        days: Number(days), maxTurnsPerSession: Number(maxTurns), maxTotalTurns: Number(maxTotal),
        includeSubagents: subagents === 'true', includeSeeded: seeded === 'true', includeNoCwd: noCwd === 'true',
        ...(selection === undefined ? {} : { provider: selection.provider, model: selection.model }),
      }),
    })
      .then((data) => { setStatus(data.status) })
      .catch((error: Error) => { toast.push('error', error.message) })
      .finally(() => { setBusy(false) })
  }
  const pause = (): void => {
    api<{ status: BackfillStatusView }>('history-backfill/cancel', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
      .then((data) => { setStatus(data.status) })
      .catch((error: Error) => { toast.push('error', error.message) })
  }

  const progress = status?.progress
  // v0.8.12:服务重启后 status 返回 done 0/0 哨兵——显示「未在运行」而不是误导的「已完成」。
  const freshBoot = progress !== undefined
    && progress.state === 'done' && progress.sessionsTotal === 0
    && progress.turnsPlanned === 0 && progress.turnsDone === 0
  const stateLabel = progress === undefined || pollFailed
    ? ''
    : freshBoot ? t('backfillStateIdle')
      : progress.state === 'running' ? t('backfillStateRunning')
        : progress.state === 'done' ? t('backfillStateDone')
          : progress.state === 'cancelled' ? t('backfillStateCancelled')
            : t('backfillStateFailed')
  const percent = progress === undefined || progress.turnsPlanned === 0
    ? 0
    : Math.min(100, Math.round((progress.turnsDone / progress.turnsPlanned) * 100))

  return (
    <div className={styles.backfill}>
      {/* 解释性长文收进「说明」折叠里：运维页是工具页，正文第一屏应该先给控件，
          想读的人点一下就在。 */}
      <details className={styles.opsDetails}>
        <summary>{t('opsMoreInfo')}</summary>
        <p className={styles.backfillIntro}>{t('backfillIntro')}</p>
      </details>

      {/* 导入规则：全部由用户选择（持久化，下次进来沿用）。 */}
      <div className={styles.backfillRules}>
        <label className={styles.backfillRule}>
          <span>{t('backfillDays')}</span>
          <SelectField selectClassName={styles.input} value={days} onChange={event => { setDays(event.target.value) }}>
            <option value="7">{t('backfillDaysUnit', { n: 7 })}</option>
            <option value="30">{t('backfillDaysUnit', { n: 30 })}</option>
            <option value="90">{t('backfillDaysUnit', { n: 90 })}</option>
            <option value="0">{t('backfillDaysAll')}</option>
          </SelectField>
        </label>
        <label className={styles.backfillRule}>
          <span>{t('backfillMaxTurns')}</span>
          <input className={styles.input} type="number" min={1} max={500} value={maxTurns}
            onChange={event => { setMaxTurns(event.target.value) }} />
        </label>
        <label className={styles.backfillRule}>
          <span>{t('backfillMaxTotal')}</span>
          <input className={styles.input} type="number" min={1} max={5000} value={maxTotal}
            onChange={event => { setMaxTotal(event.target.value) }} />
        </label>
        {/* 辅助模型：默认「自动」= 回填时用你当前在用的模型（历史日志里的旧模型可能已不可用）。 */}
        <label className={styles.backfillRule}>
          <span>{t('backfillModel')}</span>
            <SelectField selectClassName={styles.input} value={modelChoice}
              onChange={event => { setModelChoice(event.target.value) }}>
              <option value="">{t('backfillModelAuto')}</option>
              {(models?.providers ?? []).map(provider => (
                <optgroup key={provider.id} label={provider.name}>
                  {provider.models.map(model => (
                    <option key={`${provider.id}::${model.id}`} value={`${provider.id}::${model.id}`}>{model.name}</option>
                  ))}
                </optgroup>
              ))}
            </SelectField>
        </label>
      </div>
      <div className={styles.backfillToggles}>
        <label className={styles.backfillToggle}>
          <input type="checkbox" checked={subagents === 'true'}
            onChange={event => { setSubagents(event.target.checked ? 'true' : 'false') }} />
          {t('backfillIncludeSubagents')}
        </label>
        <label className={styles.backfillToggle}>
          <input type="checkbox" checked={seeded === 'true'}
            onChange={event => { setSeeded(event.target.checked ? 'true' : 'false') }} />
          {t('backfillIncludeSeeded')}
        </label>
        <label className={styles.backfillToggle}>
          <input type="checkbox" checked={noCwd === 'true'}
            onChange={event => { setNoCwd(event.target.checked ? 'true' : 'false') }} />
          {t('backfillIncludeNoCwd')}
        </label>
      </div>

      {/* 估算：零成本先看数（不写库、不调 LLM）。 */}
      <div className={styles.backfillEstimate}>
        {estimate === null
          ? <span className={styles.backfillMuted}>{t('backfillEstimating')}</span>
          : estimate.unavailable !== undefined
            ? <span className={styles.backfillMuted}>{estimate.unavailable}</span>
            : (
              <>
                {/* Оценка — теми же крупными метриками, что на главной: три числа
                    видно сразу, а не нужно искать в трёх одинаковых коробках. */}
                <div className={styles.heroMetrics}>
                  <Metric label={t('backfillLabelCandidates')} value={estimate.candidates} />
                  <Metric label={t('backfillLabelPending')} value={estimate.pendingTurns} />
                  <Metric label={t('backfillLabelSkipped')} value={estimate.alreadyIngested} />
                </div>
                <div className={styles.backfillMuted}>
                  {t('backfillSkippedDetail', {
                    subagent: estimate.skipped.subagent,
                    seeded: estimate.skipped.seeded,
                    noCwd: estimate.skipped.noCwd,
                    tooOld: estimate.skipped.tooOld,
                    unreadable: estimate.skipped.unreadable,
                  })}
                </div>
                {estimate.truncated && <div className={styles.backfillMuted}>{t('backfillTruncated')}</div>}
              </>
            )}
      </div>

      <div className={styles.cardDivider} />
      <div className={styles.backfillActions}>
        <button type="button" className={styles.button} disabled={busy} onClick={reload}>{t('backfillReestimate')}</button>
        <button type="button" className={`${styles.button} ${styles.primary}`}
          disabled={busy || running || estimate === null || estimate.unavailable !== undefined || estimate.pendingTurns === 0}
          onClick={start}>{t('backfillStart')}</button>
        <button type="button" className={styles.button} disabled={!running} onClick={pause}>{t('backfillPause')}</button>
      </div>
      {progress !== undefined && (
        <div className={styles.backfillProgress}>
          <div className={styles.backfillProgressHead}>
            <span>
              {pollFailed ? t('backfillPollFailed') : stateLabel}
              {!pollFailed && progress.currentSession !== undefined && stateLabel === t('backfillStateRunning') && (
                <span className={styles.backfillMuted}>{` · #${progress.currentSession.slice(0, 8)}`}</span>
              )}
            </span>
            <span>{t('backfillProgressTurns', { done: progress.turnsDone, total: progress.turnsPlanned })}</span>
          </div>
          <div className={styles.progressBar}><i style={{ width: `${String(percent)}%` }} /></div>
          <div className={styles.backfillMeta}>
            <span>{t('backfillProgressSessions', { done: progress.sessionsDone, total: progress.sessionsTotal })}</span>
            <span>{t('backfillWritten', { n: progress.memoriesWritten })}</span>
            <span>{t('backfillTurnsSkipped', { n: progress.turnsSkipped })}</span>
            <span>{t('backfillTurnsFailed', { n: progress.turnsFailed })}</span>
          </div>
          {/* 跳过原因分布：让「写入很少」可解释（多为节流跳过而非失败）。 */}
          {Object.keys(progress.skipReasons).length > 0 && (
            <div className={styles.backfillMeta}>
              <span>{t('backfillSkipReasons')}</span>
              {Object.entries(progress.skipReasons).sort(([, a], [, b]) => b - a).map(([reason, count]) => (
                <span key={reason}>{`${skipLabel(t, reason)} ${String(count)}`}</span>
              ))}
            </div>
          )}
          {(status?.failures ?? []).length > 0 && (
            <ul className={styles.backfillFailures}>
              <li className={styles.backfillMuted}>{t('backfillFailures')}</li>
              {status!.failures.slice(0, 3).map((failure, index) => (
                <li key={`${failure.sessionId}-${String(failure.turn)}-${String(index)}`}>
                  {`${failure.sessionId.slice(-12)} · ${String(failure.turn)} · ${failure.reason}`}
                </li>
              ))}
            </ul>
          )}
          {(status?.failures ?? []).length > 0 && (
            <div className={styles.backfillMuted}>{t('backfillRouteHint')}</div>
          )}
          {status?.error !== undefined && <div className={styles.backfillMuted}>{status.error}</div>}
        </div>
      )}
    </div>
  )
}

interface JevModelOption {
  readonly id: string
}

interface JevProviderOption {
  readonly id: string
  readonly displayName: string
  readonly baseUrl: string | undefined
  readonly endpoint: string | undefined
  readonly models: readonly JevModelOption[]
}

interface JevPanelView {
  readonly enabled: boolean
  readonly provider: string | undefined
  readonly model: string | undefined
  readonly endpoint: string | undefined
  readonly timeoutMs: number
  readonly deferMergeAbove: number
  readonly deferAcceptBelow: number
  readonly contradictMinProbability: number
  /**
   * Каталог провайдеров и их моделей. Приходит от сервера и может отсутствовать:
   * после обновления панель бывает новее запущенной половины сервера, а старый
   * сервер этого поля не отдаёт — тогда раздел обязан остаться на ногах, а не падать
   * на `undefined.find`.
   */
  readonly providers?: readonly JevProviderOption[]
}

interface JevCheckView {
  readonly at: number
  readonly ok: boolean
  readonly elapsedMs: number
  readonly probability: number | undefined
  readonly status: number | undefined
  readonly kind: 'http' | 'network' | 'timeout' | 'shape' | undefined
  readonly error: string | undefined
  readonly endpoint: string
  readonly model: string
  readonly timeoutMs: number
}

function readJevCheck(raw: string): JevCheckView | null {
  if (raw === '') return null
  try {
    const parsed = JSON.parse(raw) as Partial<JevCheckView>
    if (typeof parsed.at !== 'number' || typeof parsed.ok !== 'boolean') return null
    const kind = parsed.kind
    return {
      at: parsed.at,
      ok: parsed.ok,
      elapsedMs: typeof parsed.elapsedMs === 'number' ? parsed.elapsedMs : 0,
      probability: typeof parsed.probability === 'number' ? parsed.probability : undefined,
      status: typeof parsed.status === 'number' ? parsed.status : undefined,
      kind: kind === 'http' || kind === 'network' || kind === 'timeout' || kind === 'shape' ? kind : undefined,
      error: typeof parsed.error === 'string' ? parsed.error : undefined,
      endpoint: typeof parsed.endpoint === 'string' ? parsed.endpoint : '',
      model: typeof parsed.model === 'string' ? parsed.model : '',
      timeoutMs: typeof parsed.timeoutMs === 'number' ? parsed.timeoutMs : 0,
    }
  } catch {
    return null
  }
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host
  } catch {
    return endpoint
  }
}

function JevConfigCard({ t, toast }: { t: T; toast: ToastController }): React.ReactElement {
  const [view, setView] = useState<JevPanelView | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [provider, setProvider] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [model, setModel] = useState('')
  const [timeoutMs, setTimeoutMs] = useState('3000')
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [loadingModels, setLoadingModels] = useState(false)
  const [liveModels, setLiveModels] = useState<readonly string[]>([])
  const [liveFiltered, setLiveFiltered] = useState(false)
  /**
   * Последний замер связи — в localStorage, а не в состоянии процесса: строка «когда
   * проверяли и чем кончилось» остаётся правдой после перезагрузки панели, пока её
   * не перезапишет новая проверка.
   */
  const [lastRaw, setLastRaw] = usePersistedString('jevCheck', '')
  const last = useMemo(() => readJevCheck(lastRaw), [lastRaw])

  // Initial load: form starts from the saved override; providers come from DSH via the same response.
  useEffect(() => {
    let cancelled = false
    api<JevPanelView>('jev-config')
      .then((data) => {
        if (cancelled) return
        setView(data)
        setEnabled(data.enabled)
        setProvider(data.provider ?? '')
        setEndpoint(data.endpoint ?? '')
        setModel(data.model ?? '')
        setTimeoutMs(String(data.timeoutMs))
      })
      .catch((error: Error) => { if (!cancelled) toast.push('error', `${t('jevLoadFailed')}: ${error.message}`) })
    return () => { cancelled = true }
    // 依赖 toast.push（稳定引用）而非整个 toast 对象——曾构成死循环：加载失败弹
    // toast → 父组件重渲染 → toast 对象换新 → effect 重触发 → 再弹（审计 N19）。
  }, [t, toast.push])

  /** Choose a provider and pre-fill the endpoint from its template (the field stays editable). */
  const chooseProvider = (id: string): void => {
    setProvider(id)
    const chosen = (view?.providers ?? []).find(item => item.id === id)
    setEndpoint(chosen?.endpoint ?? '')
    setLiveModels([])
    setLiveFiltered(false)
  }

  const save = (): void => {
    setBusy(true)
    api<{ ok: boolean; view: JevPanelView }>('jev-config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Empty provider/model clears that field on the server; Jev then falls back to pure rules.
      body: JSON.stringify({
        enabled,
        provider,
        endpoint: endpoint.trim(),
        model: model.trim(),
        timeoutMs: Number(timeoutMs),
      }),
    })
      .then((data) => {
        setView(data.view)
        toast.push('success', t('jevSaved'))
      })
      .catch((error: Error) => { toast.push('error', error.message) })
      .finally(() => { setBusy(false) })
  }

  /** Ask the provider for its live model list; Jev-only models win when the provider reports any. */
  const loadModels = (): void => {
    if (provider === '') { toast.push('error', t('jevModelsNoProvider')); return }
    setLoadingModels(true)
    api<{ models: readonly string[]; filtered: boolean; error: string | undefined }>('jev-models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider }),
    })
      .then((result) => {
        if (result.error !== undefined) {
          setLiveModels([])
          setLiveFiltered(false)
          toast.push('error', `${t('jevModelsFailed')}: ${result.error}`)
          return
        }
        setLiveModels(result.models)
        setLiveFiltered(result.filtered)
        toast.push('success', result.filtered
          ? t('jevModelsFiltered', { count: result.models.length })
          : t('jevModelsLoaded', { count: result.models.length }))
      })
      .catch((error: Error) => { toast.push('error', error.message) })
      .finally(() => { setLoadingModels(false) })
  }

  // Connection test: a minimal ping question sent with the current field values (nothing is written),
  // which also proves that the model really speaks the System One protocol.
  // Рядом с тостом кладём замер в состояние строки: тост живёт секунды, а «чем кончилась
  // проверка» должно оставаться на экране — иначе кнопка выглядит как «ничего не произошло».
  const testConnection = (): void => {
    setTesting(true)
    api<{
      ok: boolean
      elapsedMs: number
      probability: number | undefined
      error: string | undefined
      status?: number
      kind?: JevCheckView['kind']
      endpoint?: string
      model?: string
      timeoutMs?: number
    }>('jev-test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider, model: model.trim(), endpoint: endpoint.trim() }),
    })
      .then((result) => {
        setLastRaw(JSON.stringify({
          at: Date.now(),
          ok: result.ok,
          elapsedMs: result.elapsedMs,
          probability: result.probability,
          status: result.status,
          kind: result.kind,
          error: result.error,
          // Сервер старше панели параметров замера не отдаёт — тогда честно берём форму.
          endpoint: result.endpoint ?? endpoint.trim(),
          model: result.model ?? model.trim(),
          timeoutMs: result.timeoutMs ?? Number(timeoutMs),
        } satisfies JevCheckView))
        if (result.ok) toast.push('success', t('jevTestOk', { ms: result.elapsedMs, p: result.probability }))
        else toast.push('error', t('jevTestFail', { error: result.error ?? '' }))
      })
      .catch((error: Error) => { toast.push('error', error.message) })
      .finally(() => { setTesting(false) })
  }

  if (view === null) return <span className={styles.jevMuted}>{t('loading')}</span>

  const selected = (view.providers ?? []).find(item => item.id === provider)
  // Suggestions: the provider's live list once loaded, otherwise the models from its DSH settings.
  const suggestions: readonly string[] = liveModels.length > 0
    ? liveModels
    : (selected?.models ?? []).map(item => item.id)

  /** Адрес, который уйдёт на сервер: поле панели, а пустое поле — шаблон выбранного провайдера. */
  const endpointShown = endpoint.trim() !== '' ? endpoint.trim() : (selected?.endpoint ?? '')
  /** Слово отказа: по нему видно, что чинить — сеть, тайм-аут или протокол. */
  const kindWord = (kind: JevCheckView['kind']): string => kind === 'http'
    ? t('jevKindHttp')
    : kind === 'network' ? t('jevKindNetwork')
      : kind === 'timeout' ? t('jevKindTimeout')
        : kind === 'shape' ? t('jevKindShape') : t('jevKindUnknown')
  const lastLine = last === null
    ? t('jevCheckNever')
    : last.ok
      ? t('jevCheckOk', {
        time: new Date(last.at).toLocaleString(),
        ms: last.elapsedMs,
        p: last.probability === undefined ? '—' : last.probability.toFixed(2),
        status: last.status ?? 200,
      })
      : t('jevCheckFail', { time: new Date(last.at).toLocaleString(), kind: kindWord(last.kind), ms: last.elapsedMs })

  return (
    <div className={styles.jev}>
      {/* 解释性长文收进「说明」折叠里（同回填块）：工具页第一屏先给控件。 */}
      <details className={styles.opsDetails}>
        <summary>{t('opsMoreInfo')}</summary>
        <p className={styles.jevIntro}>{t('jevIntro')}</p>
      </details>
      <div className={styles.jevToggleRow}>
        <label className={styles.jevToggle}>
          <input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />
          {t('jevEnabled')}
        </label>
        <span className={styles.jevStatus}>{view.enabled ? t('jevStatusOn') : t('jevStatusOff')}</span>
      </div>
      {/* Параметры проверки и последний замер: то же, что делает кнопка «Проверить
          соединение», но видно без нажатия — строка отвечает «куда, чем и когда», а
          тост живёт секунды. Полный текст отказа — в подсказке, чтобы строка не разъезжалась. */}
      <div className={styles.jevCheck}>
        <span>{t('jevCheckParams', {
          endpoint: endpointShown === '' ? '—' : hostOf(endpointShown),
          model: model.trim() === '' ? '—' : model.trim(),
          timeout: timeoutMs,
        })}</span>
        <span className={last !== null && !last.ok ? styles.jevCheckBad : undefined}
          title={last?.error ?? undefined}>{lastLine}</span>
      </div>
      <div className={styles.jevForm}>
        <label className={styles.jevField}>
          <span>{t('jevProvider')}</span>
          <select className={styles.input} value={provider} onChange={event => chooseProvider(event.target.value)}>
            <option value="">{t('jevProviderUnset')}</option>
            {(view.providers ?? []).map(item => (
              <option key={item.id} value={item.id}>{`${item.displayName} (${item.id})`}</option>
            ))}
          </select>
          <span className={styles.jevMuted}>{t('jevHostHint')}</span>
        </label>
        <label className={styles.jevField}>
          <span>{t('jevEndpointField')}</span>
          <input className={styles.input} value={endpoint} placeholder={t('jevEndpointTemplate')}
            onChange={event => setEndpoint(event.target.value)} />
        </label>
        <label className={styles.jevField}>
          <span>{t('jevModel')}</span>
          <input className={styles.input} value={model} list="jev-model-suggestions"
            onChange={event => setModel(event.target.value)} />
          <datalist id="jev-model-suggestions">
            {suggestions.map(id => <option key={id} value={id} />)}
          </datalist>
          <span className={styles.jevMuted}>{liveModels.length > 0
            ? (liveFiltered
              ? t('jevModelsFiltered', { count: liveModels.length })
              : t('jevModelsLoaded', { count: liveModels.length }))
            : t('jevModelHint')}</span>
        </label>
        <label className={styles.jevField}>
          <span>{t('jevTimeoutMs')}</span>
          <input className={styles.input} type="number" min={1000} max={60000} value={timeoutMs}
            onChange={event => setTimeoutMs(event.target.value)} />
        </label>
      </div>
      <div className={styles.jevMuted}>{t('jevThresholdsTitle')}</div>
      <div className={styles.jevMuted}>{t('jevThresholdLine', {
        merge: view.deferMergeAbove,
        accept: view.deferAcceptBelow,
        contradict: view.contradictMinProbability,
      })}</div>
      <div className={styles.jevActions}>
        <button type="button" className={`${styles.button} ${styles.primary}`} disabled={busy} onClick={save}>
          {t('jevSave')}
        </button>
        <button type="button" className={styles.button} disabled={busy || testing} onClick={testConnection}>
          {t('jevTest')}
        </button>
        <button type="button" className={styles.button} disabled={busy || loadingModels} onClick={loadModels}>
          {t('jevLoadModels')}
        </button>
      </div>
    </div>
  )
}

interface JevObservationView {
  readonly at: number
  readonly site: 'band' | 'contradiction'
  readonly question: string
  readonly answered: boolean
  readonly probability: number | undefined
  readonly elapsedMs: number
  readonly error: string | undefined
  readonly verdict: 'merge' | 'accept' | 'defer' | 'confirm' | 'reject' | 'fallback'
}

const VERDICT_KEY: Readonly<Record<JevObservationView['verdict'], EngramKey>> = {
  merge: 'jevObsVerdictMerge',
  accept: 'jevObsVerdictAccept',
  defer: 'jevObsVerdictDefer',
  confirm: 'jevObsVerdictConfirm',
  reject: 'jevObsVerdictReject',
  fallback: 'jevObsVerdictFallback',
}

function JevObservationsCard({ t, toast }: { t: T; toast: ToastController }): React.ReactElement {
  const [items, setItems] = useState<readonly JevObservationView[] | null>(null)

  useEffect(() => {
    let cancelled = false
    // 初载失败弹 toast；轮询失败静默重试（观测卡不值得刷屏打扰）。
    const reload = (reportFailure: boolean): void => {
      api<{ items: readonly JevObservationView[] }>('jev-observations')
        .then((data) => { if (!cancelled) setItems(data.items) })
        .catch((error: Error) => {
          if (cancelled) return
          setItems(previous => previous ?? [])
          if (reportFailure) toast.push('error', `${t('jevObsLoadFailed')}: ${error.message}`)
        })
    }
    reload(true)
    const timer = window.setInterval(() => reload(false), 1500)
    return () => { cancelled = true; window.clearInterval(timer) }
    // toast.push 稳定引用：整个对象每渲染换新，曾让 1.5s 轮询器每次渲染拆了重建（审计 N19）。
  }, [t, toast.push])

  if (items === null) return <span className={styles.jevMuted}>{t('loading')}</span>
  if (items.length === 0) return <span className={styles.jevMuted}>{t('jevObsEmpty')}</span>

  return (
    <div className={styles.jevObs}>
      <div className={styles.jevObsHead}>{t('jevObsTitle')}</div>
      {items.map((item, index) => (
        <div key={`${item.at}-${item.site}-${index}`} className={styles.jevObsItem}>
          <span className={styles.jevObsTime}>{new Date(item.at).toLocaleTimeString()}</span>
          <span>{item.site === 'band' ? t('jevObsSiteBand') : t('jevObsSiteContradiction')}</span>
          <span className={item.verdict === 'fallback'
            ? styles.jevObsBadgeWarn
            : item.verdict === 'confirm' || item.verdict === 'merge' ? styles.jevObsBadgeGood : styles.jevObsBadge}>
            {t(VERDICT_KEY[item.verdict])}
          </span>
          <span>{item.answered ? `p=${item.probability?.toFixed(3)}` : t('jevObsNoAnswer')}</span>
          <span>{item.elapsedMs}ms</span>
          {item.error !== undefined && <span className={styles.jevObsError}>{t('jevObsErrorLine', { error: item.error })}</span>}
        </div>
      ))}
    </div>
  )
}

interface BaseRepairPart {
  readonly written: readonly { readonly file?: string }[]
  readonly converted?: number
  readonly failed: readonly { readonly file?: string, readonly error?: string }[]
}

interface RegistryBase {
  readonly file: string
  readonly scope: 'user' | 'shared' | 'project'
  readonly title: string | null
  readonly label: string | null
  readonly targetLabel: string | null
  /** Состояние базы; null — не проверено (объявление схемы о другой версии базы). */
  readonly state: string | null
  /** Что сделает кнопка; null — действие не определено, потому что не проверено. */
  readonly action: string | null
  readonly rows: number
  readonly missing: number
  readonly foreign: number
  readonly dims: readonly number[]
  readonly checked: boolean
  readonly problems: readonly { readonly kind: string, readonly detail: string }[]
}

interface RegistrySnapshot {
  readonly language: string
  /** Язык дворца: чем определён; null — язык пришёл из настройки, решать было нечего. */
  readonly palace: {
    readonly setting: string | null
    readonly source: string
    readonly conflict: boolean
    /** Локаль машины как есть: «ru», «fr», пустая строка — прочитать не удалось. */
    readonly machine: string
    /** Язык диалогов этой сессии; null — реплик ещё не было. */
    readonly dialogue: string | null
    /** Язык, на котором стоят базы по меткам; null — метки нет, `mixed` — разные. */
    readonly bases: string | null
    /** `auto` — дворец настраивается сам; `ask` — спрашиваем; `mismatch` — языки разошлись. */
    readonly state: string
  } | null
  readonly defaultLanguage: string | null
  /**
   * Длина окна собранного условия смены языка дворца, секунды (настройка).
   *
   * Одно число на панель и сервер: панель считает по нему отсчёт и показывает остаток,
   * сервер — принимает ли запрос смены языка. Приходит снимком, а не константой клиента.
   */
  readonly palaceChangeWindowSec: number
  /** Языки дворца, которые знает поставка: от неё же зависит, что предлагать в выборе. */
  readonly languages: readonly PalaceLanguageOption[]
  readonly remote: boolean
  readonly resolved: { readonly id: string; readonly label: string | null; readonly source: string; readonly pooling: string; readonly dtype: string } | null
  readonly models: readonly { readonly id: string; readonly label: string | null; readonly pooling: string; readonly dtype: string; readonly dimensions: number | null; readonly languages: readonly string[] }[]
  /**
   * Языки моделей, у которых словарь уже заведён. Список терпит отсутствие поля по той
   * же причине, что и `languages`: клиент и сервер едут разными файлами.
   */
  readonly dictionaryLanguages?: readonly string[]
  readonly bindings: readonly { readonly language: string; readonly model: string }[]
  readonly files: readonly string[]
  readonly problems: readonly { readonly file: string; readonly kind: string; readonly detail: string }[]
  readonly dictionaries: readonly {
    readonly name: string
    readonly files: readonly string[]
    readonly entries: number
    readonly problems: readonly { readonly file: string; readonly line: number; readonly kind: string; readonly detail: string }[]
  }[]
  /** Базы дворца: состояние каждой и что с ней сделает кнопка. */
  readonly bases: readonly RegistryBase[]
  /** Сколько баз ещё нет: их создаёт код автора, не мы. */
  readonly pendingBases: number
  /** Подключён ли пересчёт векторов (этап 2 блока Б). */
  readonly convertAvailable: boolean
}

interface PalaceLanguageOption {
  readonly code: string
  readonly label: string
  /** Есть ли у плагина вшитый набор текстов; иначе язык говорит словарём из файла. */
  readonly builtin: boolean
}

const LANGUAGE_CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/

const GUARD_SECONDS = 30

/**
 * Сколько висит сообщение об итоге обслуживания.
 *
 * Обычного срока тоста не хватает: пока человек читает причину отказа, сообщение уже
 * ушло, и остаётся впечатление «мелькнуло и всё». Полминуты — чтобы успеть прочитать,
 * и не настолько много, чтобы сообщение мешало.
 */
const TOAST_LONG_MS = 30_000

/** 文件全路径只留文件名：卡片里要的是「какой файл», а не «где лежит пакет». */
function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut < 0 ? path : path.slice(cut + 1)
}

const BASE_STATE_KEY: Readonly<Record<string, EngramKey>> = {
  absent: 'baseStateAbsent',
  empty: 'baseStateEmpty',
  normal: 'baseStateNormal',
  'no-label': 'baseStateNoLabel',
  'other-model': 'baseStateOtherModel',
  'mixed-dims': 'baseStateMixedDims',
  'missing-vectors': 'baseStateMissingVectors',
}

const displayNameCache = new Map<string, Intl.DisplayNames | null>()
function languageLabel(code: string, known: readonly PalaceLanguageOption[], locale: string): string {
  const registered = known.find(row => row.code === code)?.label
  if (registered !== undefined) return registered
  let names = displayNameCache.get(locale)
  if (names === undefined) {
    try {
      names = new Intl.DisplayNames([locale], { type: 'language' })
    } catch {
      // Старый браузер без `DisplayNames` — показываем код: он всегда верен.
      names = null
    }
    displayNameCache.set(locale, names)
  }
  const label = names?.of(code)
  return label === undefined || label === '' ? code.toUpperCase() : label
}

function PalaceLanguageCard({ t, snapshot, onReload, blockRefs, toast }: {
  readonly t: T
  /** Снимок обслуживания: язык, модель, базы. */
  readonly snapshot: RegistrySnapshot
  /** Перечитать снимок (после починки или смены языка); OpsTab 的 useApi.reload 返回 void。 */
  readonly onReload: () => void | Promise<void>
  /** Узел блока для верхней навигации по странице обслуживания. */
  readonly blockRefs?: { readonly current: Record<string, HTMLElement | null> }
  /**
   * Общий контроллер тостов секции. Своего здесь быть не должно: вьюпорт тостов
   * смонтирован один, в EngramSection, — приватный экземпляр рендерил уведомления
   * в пустоту, и «Починить базы» выглядела кнопкой, которая ничего не делает.
   */
  readonly toast: ToastController
}): React.ReactElement {
  const [busy, setBusy] = useState(false)
  /**
   * Замок на смену языка дворца: по умолчанию закрыт.
   *
   * Порядок действий задаёт он же: снял замок — ожил выбор языка, выбрал другой язык —
   * ожила кнопка «Выполнить». Пока язык не изменён, кнопка молчит: пересчёт баз идёт
   * только вместе со сменой языка.
   *
   * Состояние намеренно НЕ хранится между заходами: снятый замок, переживший выход из
   * панели, оставлял бы дорогое действие открытым для случайного нажатия.
   */
  const [locked, setLocked] = useState(true)
  /**
   * Перехват последней починки: что вызвано и что ответил сервер.
   *
   * Тост живёт секунды и уносит причину с собой — человек видит «мелькнуло» и не знает,
   * чем кончилось. Поэтому итог остаётся строкой под кнопкой и держится до следующего
   * нажатия или до перезагрузки страницы. Это же и есть перехват: если строка не
   * изменилась после нажатия, значит нажатие не дошло до обработчика.
   */
  const [lastRepair, setLastRepair] = useState<string | null>(null)
  /**
   * Язык, выбранный в блоке «Язык дворца», но ещё не записанный.
   *
   * Пока он не отправлен, в настройке ничего не меняется: выбор — это первое из трёх
   * событий собранного условия, а не сама смена языка (решение 20–21.10).
   */
  const [pending, setPending] = useState<string | null>(null)
  /** Момент первого из трёх событий: с него идёт окно. null — окно не начато. */
  const [startedAt, setStartedAt] = useState<number | null>(null)
  /** Остаток окна в секундах: подпись у предохранителя и признак «ещё можно». */
  const [left, setLeft] = useState(0)
  const tt = (key: EngramKey, params?: Record<string, string | number>): string => t(key, params)
  /**
   * Длина окна: считается по настройке, а не по константе — сервер проверяет тем же
   * числом. Читается из снимка, а снимка до загрузки ещё нет, поэтому здесь терпит
   * пустоту: значение нужно таймеру, а таймер обязан стоять до ранних выходов
   * (ниже), иначе первый рендер рисует на один хук меньше, чем второй, и React
   * падает с ошибкой #310 — «хуков больше, чем в прошлом рендере».
   */
  const windowSec = snapshot?.palaceChangeWindowSec ?? GUARD_SECONDS

  /**
   * Окно собранного условия: тикает, пока начато, и по нулю возвращает всё назад.
   *
   * Сброс — не наказание, а восстановление: выбор возвращается к языку, на котором стоят
   * базы, предохранитель встаёт на место, и человек видит, что окно закрылось. Молчаливое
   * «ничего не произошло» здесь хуже всего: непонятно, сработало ли нажатие.
   *
   * Стоит до ранних выходов — порядок хуков не должен зависеть от того, пришёл ли снимок.
   * Зависимости — стабильные ссылки: `t` меняется только вместе с языком панели, а в
   * `toast` стабилен только `push` — сам контроллер пересоздаётся на каждый рендер
   * секции, и быть зависимостью не может.
   */
  useEffect(() => {
    if (startedAt === null) {
      setLeft(windowSec)
      return undefined
    }
    const tick = (): void => {
      const rest = windowLeft(startedAt, Date.now(), windowSec)
      setLeft(rest)
      if (rest > 0) return
      setStartedAt(null)
      setPending(null)
      setLocked(true)
      toast.push('reset', t('guardReset', { seconds: windowSec }))
    }
    tick()
    const id = setInterval(tick, 500)
    return () => { clearInterval(id) }
  }, [startedAt, windowSec, toast.push, t])

  /**
   * Языки реестра. Стоит до ранних выходов: от них зависят подписи языков в блоке
   * обслуживания, а он собирается уже после ранних выходов.
   *
   * Список терпит отсутствие поля: клиент и сервер плагина едут разными файлами, и сразу
   * после обновления клиент может оказаться новее сервера — тогда `languages` в снимке нет.
   */
  const languages = snapshot?.languages ?? []

  const resolvedLabel = snapshot.resolved === null
    ? tt('registryNone')
    : snapshot.resolved.label ?? snapshot.resolved.id
  /**
   * Язык дворца в настройке: «чем записано» — в отличие от `snapshot.language`, которым
   * этот процесс считает прямо сейчас. До перезапуска они могут расходиться, и панель
   * обязана показывать оба, а не выбирать за человека, какой из них настоящий.
   */
  const currentLanguage = snapshot.palace?.setting ?? snapshot.language
  /** Что показано в выборе: несохранённый выбор, иначе записанный язык. */
  const chosenLanguage = pending ?? currentLanguage
  const languageChanged = chosenLanguage !== currentLanguage
  /**
   * Список выбора языка дворца: языки реестра с сервера плюс текущий, если его там
   * нет. Записанный язык мог прийти из настройки или быть объявлен файлом
   * `languages.json` на этой машине; без такой строки `select` показал бы пустое
   * поле вместо языка, на котором дворец на самом деле стоит.
   */
  const languageOptions = languages.some(row => row.code === chosenLanguage)
    ? languages
    : [...languages, { code: chosenLanguage, label: chosenLanguage.toUpperCase(), builtin: false }]

  /**
   * Язык дворца словом — «Русский», а не `RU`. Код остаётся для машин и для
   * `select`, где он служит значением; в строке состояния человек читает название,
   * и взять его можно только из реестра языков.
   */
  const palaceLanguageName = languages.find(row => row.code === currentLanguage)?.label
    ?? currentLanguage.toUpperCase()

  // Состояние баз одной строкой для верхнего ряда: это индикатор, а не действие.
  const actions = (snapshot.bases ?? []).map(base => base.action)
  const todo: 'convert' | 'repair' | 'write-label' | 'none' = actions.includes('convert')
    ? 'convert'
    : actions.includes('repair') ? 'repair' : actions.includes('write-label') ? 'write-label' : 'none'

  /**
   * Состояние баз одним из трёх слов — только они и есть: в порядке, требует
   * ремонта, требует конвертации.
   *
   * «Ремонт» здесь широкий и означает «надо поправить записи»: и растерянные
   * векторы, и базу без метки модели — второе лечится тем же нажатием. Отдельного
   * четвёртого состояния у строки нет намеренно: человеку важно, придётся ли ему
   * что-то делать, а не как называется причина.
   *
   * У конвертации приоритет не по важности, а по существу: она пересчитывает всё
   * подряд и заодно устраняет то, что чинил бы ремонт. Показывать «ремонт» рядом с
   * базой, которую всё равно ждёт пересчёт, значило бы предлагать два действия там,
   * где нужно одно.
   */
  const baseKind: 'ok' | 'repair' | 'convert' = todo === 'convert'
    ? 'convert'
    : todo === 'none' ? 'ok' : 'repair'

  const baseStateText = baseKind === 'convert'
    ? tt('baseStateConvert')
    : baseKind === 'repair' ? tt('baseStateRepair') : tt('baseStateOk')

  /**
   * Цвет сообщения: у беды два оттенка — ремонт обычный, конвертация жирная, потому
   * что за ней стоит смена языка, а не только правка строк. Порядок в порядке
   * зелёный: это не тревога, а ответ «делать нечего».
   */
  const baseStateClass = baseKind === 'ok'
    ? styles.baseStateGood
    : baseKind === 'convert' ? styles.baseStateAlarm : styles.baseStateBad

  /**
   * Первое из трёх событий открывает окно; следующие его не продлевают.
   *
   * Окно открывает сервер: он сам запоминает момент и язык, на котором стояли базы, —
   * поэтому клиент не может ни продлить окно, ни назвать «язык, от которого уходят»
   * (решение 24.10). Панель берёт у сервера начало отсчёта и показывает его, но основание
   * решения остаётся на сервере.
   */
  const beginWindow = (): void => {
    if (startedAt !== null) return
    void api<{ ok: boolean, startedAt: number, left: number }>('palace-change/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
      .then((answer) => {
        if (!answer.ok) return
        setStartedAt(answer.startedAt)
        setLeft(answer.left)
      })
      .catch(() => { /* окно не открылось — кнопка останется запертой, и это правильно */ })
  }

  /** Выбор языка: первое событие окна, в настройку ничего не пишется. */
  const pickLanguage = (language: string): void => {
    if (language === currentLanguage) { setPending(null); return }
    setPending(language)
    beginWindow()
  }

  /**
   * Замок: пока он закрыт, ни выбор языка, ни починка не срабатывают.
   *
   * При смене языка снятие замка — ещё и первое событие окна: человек открыл дорогу к
   * выбору, дальше он выбирает язык, и только тогда оживает «Выполнить».
   *
   * При ремонте окна нет вовсе (решение 22.10): починка не меняет ни язык, ни модель,
   * это правка строк в тех же самых базах. Охраняет её один замок — снят, значит можно
   * нажимать; отсчёт, который через полминуты запер бы кнопку, здесь только мешал бы.
   */
  const toggleLock = (next: boolean): void => {
    setLocked(next)
    if (!next && baseKind === 'convert') beginWindow()
  }

  /** Причина отказа сервера — словами: код отказа человеку ничего не говорит. */
  const reasonText = (reason?: string): string => reason === 'window'
    ? tt('palaceChangeReasonWindow')
    : reason === 'not-changed' ? tt('palaceChangeReasonChanged')
      : reason === 'not-a-code' ? tt('palaceChangeReasonCode') : tt('palaceChangeReasonStart')

  /**
   * Смена языка собранным условием: снят замок + выбран другой язык + нажатие, всё в окне.
   *
   * Язык, метки и пересчёт уходят одним запросом: сервер проверяет окно и только потом
   * пишет настройку, ставит метки и пересчитывает векторы. Разделять это на три запроса
   * значило бы оставить состояния «язык уже новый, базы ещё старые» без присмотра.
   *
   * Без смены языка кнопка не работает вовсе: пересчёт идёт только вместе с языком.
   */
  const applyChange = (): void => {
    if (busy || locked || !languageChanged) return
    if (startedAt === null || left <= 0) return
    setBusy(true)
    void api<{
      ok: boolean
      language: string
      error?: string
      reason?: string
      labels?: { readonly written: readonly unknown[], readonly failed: readonly unknown[] } | null
      convert?: { readonly converted: number, readonly failed: readonly unknown[] } | null
    }>('palace-change', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Только выбранный язык: окно и «язык, от которого уходят» сервер знает сам.
      // Присылать их отсюда было бы всё равно, что не присылать ничего, — проверялся бы
      // присланное, а не состояние (ревью #36).
      body: JSON.stringify({ language: chosenLanguage }),
    })
      .then(async (answer) => {
        if (!answer.ok) {
          toast.push('error', tt('palaceChangeRefused', { reason: reasonText(answer.reason) }))
          return
        }
        toast.push('success', tt('palaceChangeDone', {
          language: answer.language.toUpperCase(),
          labels: answer.labels?.written.length ?? 0,
          converted: answer.convert?.converted ?? 0,
        }))
        setPending(null)
        setStartedAt(null)
        setLocked(true)
        await onReload()
      })
      .catch((changeError: Error) => { toast.push('error', changeError.message) })
      .finally(() => { setBusy(false) })
  }

  /**
   * Починка баз: всё, что можно поправить без смены языка и модели.
   *
   * Два запроса, а не один, потому что это два разных дела: сначала метки моделей
   * (маршрут `base-label` — он пишет строку только тем базам, которым она нужна),
   * потом пересчёт строк с пустыми и неправильными векторами (`base-convert`). Окно и
   * выбор языка здесь не участвуют вовсе: ни настройка, ни модель не меняются, а
   * охраняет нажатие один замок.
   *
   * Порядок именно такой: метка говорит, на какой модели стоит база, и пересчёт,
   * начатый раньше неё, считал бы по догадке.
   *
   * Отказ сервера не прячется за словом «готово»: обе ручки возвращают списки `failed`,
   * и сервер умеет отказать целиком с кодом 200 — когда, например, модель эмбеддингов
   * ещё не поднялась. Раньше панель смотрела только на числа и говорила «починено» при
   * нулях; человек видел мгновенный тост, а база оставалась с дырками. Теперь сначала
   * называются отказы, и только если их нет — итог по числам.
   */
  const repairBases = (): void => {
    if (busy || locked) return
    setBusy(true)
    const steps: string[] = []
    const began = Date.now()
    setLastRepair(tt('baseRepairRunning'))
    // Аргументов у обеих ручек нет: всё, что им нужно, они берут из настроек. Заголовок
    // JSON подставляет сам `api` — у него это правило для всех POST.
    const post = { method: 'POST' } as const
    void api<BaseRepairPart>('base-label', post)
      .then(async (labels) => {
        steps.push(`base-label: меток ${labels.written.length}, отказов ${labels.failed.length}`)
        const convert = await api<BaseRepairPart>('base-convert', post)
        steps.push(`base-convert: пересчитано ${convert.converted ?? 0}, отказов ${convert.failed.length}`)
        const failures = [...labels.failed, ...convert.failed]
        const written = labels.written.length
        const converted = convert.converted ?? 0
        // Держим итог на экране: тост уходит через секунды, а разбираться приходится
        // потом. Длительность тоста — на случай, если человек смотрит не в панель.
        if (failures.length > 0) {
          const first = failures.map(row => row.error ?? '').find(text => text !== '') ?? ''
          steps.push(first === '' ? `отказов ${failures.length}` : first)
          toast.push('error', tt('baseRepairFailed', {
            error: first === '' ? tt('baseRepairFailedCount', { n: failures.length }) : first,
          }), TOAST_LONG_MS)
        } else if (written === 0 && converted === 0) {
          // Сервер не назвал ни одной ошибки, но и не сделал ничего. Молчать об этом
          // нельзя: для человека это выглядит как «кнопка не работает».
          steps.push('ничего не сделано')
          toast.push('warning', tt('baseRepairNothing'), TOAST_LONG_MS)
        } else {
          toast.push('success', tt('baseRepairDone', { labels: written, converted }), TOAST_LONG_MS)
        }
        steps.push(`${((Date.now() - began) / 1000).toFixed(1)} с`)
        setLastRepair(tt('baseRepairTrace', { steps: steps.join(' → ') }))
        await onReload()
      })
      .catch((repairError: Error) => {
        steps.push(`ошибка: ${repairError.message}`)
        setLastRepair(tt('baseRepairTrace', { steps: steps.join(' → ') }))
        toast.push('error', tt('baseRepairFailed', { error: repairError.message }), TOAST_LONG_MS)
      })
      .finally(() => { setBusy(false) })
  }

  /** Язык диалогов с агентом: у сессии без реплик его ещё нет. */
  /**
   * Строка проблемы базы — словами панели.
   *
   * Сервер отдаёт `kind` машинным ключом и `detail` безъязыковым фактом
   * (имя таблицы, версии `v11→v13`), а не готовой фразой: готовая фраза была
   * зашита по-русски и в китайском интерфейсе вылезала посреди китайских строк.
   * Неизвестный вид оставляем как есть — лучше сырой факт, чем пустота.
   */
  const baseProblemText = (problem: { readonly kind: string; readonly detail: string }): string => {
    if (problem.kind === 'no-table') {
      return tt('baseProblemNoTable', { table: problem.detail })
    }
    if (problem.kind === 'schema-version') {
      const versions = [...problem.detail.matchAll(/v(\d+)/g)].map(match => match[1] ?? '')
      const [found, expected] = versions
      if (found !== undefined && expected !== undefined) {
        return tt('baseProblemSchemaVersion', { found: `v${found}`, expected: `v${expected}` })
      }
    }
    return problem.detail
  }

  const dialogueLabel = snapshot.palace?.dialogue == null
    ? tt('palaceDialogueNone')
    : snapshot.palace.dialogue.toUpperCase()

  /** Язык, на котором стоят базы по меткам. */
  const basesLabel = snapshot.palace?.bases == null
    ? tt('palaceBasesNone')
    : snapshot.palace.bases === 'mixed' ? tt('palaceBasesMixed') : snapshot.palace.bases.toUpperCase()

  /**
   * Метки языков у модели. Привязка `*` означает «все языки без явной привязки» — она
   * и есть метка этой модели, поэтому показывается словом, а не звёздочкой.
   */
  const languagesOfModel = (modelId: string): string => {
    const bound = snapshot.bindings.filter(row => row.model === modelId)
    if (bound.length === 0) return tt('registryNone')
    return bound.map(row => row.language === '*'
      ? tt('registryAllLanguages')
      : languages.find(option => option.code === row.language)?.label ?? row.language.toUpperCase())
      .join(' · ')
  }

  return (
      <div className={`${styles.panelCard} ${styles.opsBlock}`}
        ref={element => { if (blockRefs !== undefined) blockRefs.current.palace = element }}>
        <div className={styles.cardHead}>
          <h3 className={styles.cardTitle}>{tt('palaceLanguageTitle')}</h3>
        </div>
        {/* Строка состояния — только чтение: чем дворец думает (словом), что стоит в
            базах (буквами) и что с базами. */}
        <div className={styles.palaceChangeRow}>
          <span className={styles.regLabel}>{tt('palaceLanguageName')}</span>
          <span className={styles.regValue}>{palaceLanguageName}</span>
          <span className={styles.regLabel}>{tt('palaceBasesLine')}</span>
          <span className={styles.regMono} title={tt('palaceBasesHint')}>{basesLabel}</span>
          <span className={baseStateClass}>{baseStateText}</span>
        </div>
        {/* Что именно не так — словами, а не словом «конвертация»: иначе человек
            видит красную метку и не знает, что с ней делать. */}
        {baseKind === 'convert' && <p className={styles.regNote}>{tt('baseStateConvertHint')}</p>}
        {baseKind === 'repair' && <p className={styles.regNote}>{tt('baseStateRepairHint')}</p>}
        {/* Два факта о модели нужны всегда, а не только когда базы в разнобой:
            какой моделью считают память и на каком языке с нами говорят. */}
        <dl className={styles.regKV}>
          <dt>{tt('palaceThoughtsModelLine')}</dt>
          <dd>
            {currentLanguage.toUpperCase()}
            {' · '}
            <span className={styles.regMono}>{resolvedLabel}</span>
          </dd>
        </dl>
        <p className={styles.regNote}>{tt('palaceThoughtsModelHint')}</p>
        <dl className={styles.regKV}>
          <dt>{tt('palaceDialogueLine')}</dt>
          <dd>
            {dialogueLabel}
            <span className={styles.regHint}>{tt('palaceDialogueHint')}</span>
          </dd>
        </dl>
        {/* Действие — только когда есть что делать. */}
            {baseKind === 'convert' && (<>
              <div className={styles.palaceChangeRow}>
                <span className={`${styles.regLabel} ${styles.regLangPush}`}>
                  {tt('palaceLanguageChange')}
                </span>
                <select className={`${styles.input} ${styles.regLang}`}
                  value={chosenLanguage} disabled={locked}
                  aria-label={tt('palaceLanguageChange')}
                  onChange={event => { pickLanguage(event.target.value) }}>
                  {languageOptions.map(row => (
                    <option key={row.code} value={row.code}>{row.label}</option>
                  ))}
                </select>
              </div>
              <p className={styles.regNote}>{tt('palaceChangeHint', { seconds: windowSec })}</p>
            </>)}
            {baseKind !== 'ok' && (
              <div className={styles.baseRunRow}>
                <label className={styles.regGuard}>
                  <input type="checkbox" checked={locked}
                    onChange={event => { toggleLock(event.target.checked) }} />
                  <span>{tt('baseLock')}</span>
                </label>
                <button type="button" className={`${styles.button} ${styles.primary}`}
                  disabled={busy || locked || (baseKind === 'convert'
                    && (!languageChanged || startedAt === null || left <= 0))}
                  onClick={baseKind === 'convert' ? applyChange : repairBases}>
                  {busy ? tt('baseRunBusy') : tt('baseRun')}
                </button>
                <span className={styles.baseRunNote}>
                  {baseKind === 'convert'
                    ? (languageChanged ? tt('baseActionConvert') : tt('baseRunNeedLanguage'))
                    : tt('baseActionRepair')}
                </span>
                {baseKind === 'repair' && (
                  <span className={`${styles.baseRunNote} ${styles.baseRunScope}`}>
                    {tt('baseActionRepairScope')}
                  </span>
                )}
              </div>
            )}
            {baseKind === 'repair' && lastRepair !== null && (
              <p className={styles.baseRunTrace}>{lastRepair}</p>
            )}
            {baseKind === 'convert' && languageChanged && (
              <p className={styles.regNote}>
                {tt('palaceChangeLeft', { seconds: left })}
                {locked ? ` · ${tt('palaceChangeNeedAllow')}` : ''}
              </p>
            )}
            {baseKind === 'convert' && chosenLanguage !== snapshot.language && (
              <p className={styles.regNote}>{tt('palacePending', { running: snapshot.language.toUpperCase() })}</p>
            )}
        {/* Таблицы — всегда: карточка показывает состояние, а не одну кнопку.
            Раньше они жили внутри «когда что-то сломалось» и в порядке дел
            исчезали совсем. */}
        <div className={styles.cardDivider} />
              <p className={styles.regNote}>{tt('registryModelsHint')}</p>
              <div className={styles.regTableWrap}>
              <table className={styles.regTable}>
                <thead>
                  <tr>
                    <th>{tt('registryColLanguage')}</th>
                    <th>{tt('registryColLabel')}</th>
                    <th>{tt('registryColId')}</th>
                    <th>{tt('registryColDims')}</th>
                    <th>{tt('registryColParams')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(snapshot.models ?? []).map(row => (
                    <tr key={row.id} className={row.id === snapshot.resolved?.id ? styles.on : undefined}>
                      <td className={styles.regMono}>{languagesOfModel(row.id)}</td>
                      <td>{row.label ?? tt('registryNone')}</td>
                      <td className={styles.regMono}>{row.id}</td>
                      <td>{row.dimensions ?? tt('registryNone')}</td>
                      <td>{row.pooling} · {row.dtype}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
              {snapshot.remote && <p className={styles.regNote}>{tt('registryRemote')}</p>}
              {snapshot.problems.length > 0 && (
                <ul className={styles.regBad}>
                  {snapshot.problems.map((problem, index) => (
                    <li key={`${problem.file}-${String(index)}`}>
                      {baseName(problem.file)}: {baseProblemText(problem)}
                    </li>
                  ))}
                </ul>
              )}
            {snapshot.bases.length === 0
              ? <p className={styles.regNote}>{tt('baseNoSchema')}</p>
              : (
                <>
                <p className={styles.regNote}>{tt('registryBasesHint')}</p>
                <div className={`${styles.regTableWrap} ${styles.regTableScroll}`}>
                <table className={styles.regTable}>
                  <thead>
                    <tr>
                      <th>{tt('baseColBase')}</th>
                      <th>{tt('baseColState')}</th>
                      <th>{tt('baseColRows')}</th>
                      <th>{tt('baseColMissing')}</th>
                      <th>{tt('baseColForeign')}</th>
                      <th>{tt('baseColDims')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(snapshot.bases ?? []).map((base, index) => (
                      <tr key={base.file ?? base.title ?? String(index)}>
                        <td className={styles.regMono} title={base.file}>{base.title ?? base.file}</td>
                        <td>{base.state === null ? tt('baseStateUnchecked') : tt(BASE_STATE_KEY[base.state] ?? 'baseStateUnchecked')}</td>
                        <td>{base.rows}</td>
                        <td>{base.missing}</td>
                        <td>{base.foreign}</td>
                        <td className={styles.regMono}>{base.dims.length === 0 ? tt('registryNone') : base.dims.join(' · ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
                </>
              )}
            {snapshot.bases.some(base => !base.checked) && (
              <ul className={styles.regBad}>
                {snapshot.bases.filter(base => !base.checked).map(base => (
                  <li key={base.file}>
                    {base.file}: {base.problems.map(problem => baseProblemText(problem)).join('; ')}
                  </li>
                ))}
              </ul>
            )}
            {snapshot.pendingBases > 0 && (
              <p className={styles.regNote}>{tt('basePending', { n: snapshot.pendingBases })}</p>
            )}
      </div>
  )
}

function PluginLanguageCard({ t, snapshot, onReload, overlayHost, lang, onTestPanel, blockRefs, toast }: {
  readonly t: T
  /** Снимок обслуживания: реестр языков и список моделей. */
  readonly snapshot: RegistrySnapshot
  /** Перечитать снимок (после заведения словаря список языков меняется). */
  readonly onReload: () => void | Promise<void>
  /** Якорь оверлеев панели (вне `.panel`): сюда порталом уходит экран правки словаря. */
  readonly overlayHost: { readonly current: HTMLDivElement | null }
  /** Язык самой панели: он же умолчание для выбора языка в блоке «Язык Плагина». */
  readonly lang: PanelLang
  /** Открыть проверку окна первого запуска — без записи и без смены языка дворца. */
  readonly onTestPanel?: () => void
  /** Узел блока для верхней навигации по странице обслуживания. */
  readonly blockRefs?: { readonly current: Record<string, HTMLElement | null> }
  /** Общий контроллер тостов секции: вьюпорт один, в EngramSection, — приватный экземпляр здесь молчал бы. */
  readonly toast: ToastController
}): React.ReactElement {
  /** Открыт ли экран правки словаря: он перекрывает окно плагина целиком. */
  const [dictionaryOpen, setDictionaryOpen] = useState(false)
  /**
   * Язык, словари которого показывает блок «Язык Плагина».
   *
   * Умолчание — язык самой панели (тот, что стоит в верхнем переключателе): человек
   * чаще всего смотрит переводы того языка, на котором читает интерфейс. Дальше это
   * независимый выбор: он не переключает панель и ничего не пишет в настройки.
   */
  const [dictLanguage, setDictLanguage] = useState<string>(lang)
  /** Счётчики словарей выбранного языка; null — ещё не прочитаны. */
  const [dictStats, setDictStats] = useState<readonly DictStatView[] | null>(null)
  /** Просьба перечитать счётчики: после заведения словаря язык тот же, а данные новые. */
  const [dictReload, setDictReload] = useState(0)
  /** Язык, выбранный справа в поле «Создать словарь» (подпись, а не код: так ищут глазами). */
  const [createLanguage, setCreateLanguage] = useState<string>('')
  const [dictError, setDictError] = useState<string | null>(null)
  const tt = (key: EngramKey, params?: Record<string, string | number>): string => t(key, params)
  /**
   * Языки реестра. Список терпит отсутствие поля: клиент и сервер плагина едут разными
   * файлами, и сразу после обновления клиент может оказаться новее сервера.
   */
  const languages = snapshot.languages ?? []
  /**
   * Счётчики словарей выбранного языка: «всего строк / заполнено / откуда прочитано».
   *
   * Считаются по таблице правки (`GET dictionary?set=…&language=…`), а не по снимку
   * обслуживания: снимок описывает язык, на котором плагин считает сейчас, а человек
   * смотрит на язык, выбранный в блоке. Всего строк — это термины набора (строки
   * таблицы), заполнено — те, у которых правая клетка непустая.
   */
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [messages, panel] = await Promise.all([
          api<DictionarySetView>(`dictionary?set=messages&language=${encodeURIComponent(dictLanguage)}`),
          api<DictionarySetView>(`dictionary?set=panel&language=${encodeURIComponent(dictLanguage)}`),
        ])
        if (!alive) return
        setDictStats([
          { set: 'messages', label: 'registryDictionaryMessages', view: messages },
          { set: 'panel', label: 'registryDictionaryPanel', view: panel },
        ])
        setDictError(null)
      } catch (cause) {
        if (alive) setDictError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
    return () => { alive = false }
  }, [dictLanguage, dictReload])
  /**
   * Языки для выбора в блоке «Язык Плагина»: те, что знает реестр языков, плюс язык
   * панели, если его там ещё нет. Своего списка клиент не держит намеренно — иначе
   * язык, добавленный файлом, появлялся бы на сервере, но не в выборе.
   */
  const pluginLanguageOptions = languages.some(row => row.code === dictLanguage)
    ? languages
    : [...languages, { code: dictLanguage, label: dictLanguage.toUpperCase(), builtin: false }]

  /**
   * «Открыть словарь» — только для языков, которые приходят словарём из файла. У zh и
   * en текст вшит в код: правка файлом их не перекрывает, и кнопка открыла бы таблицу,
   * которая ничего не меняет.
   */
  const canOpenDictionary = languages.some(row => row.code === dictLanguage && !row.builtin)

  /** Есть ли непереведённые строки: «заполнено» меньше, чем «всего строк». */
  const dictIncomplete = dictStats?.some(stat => dictFilledOf(stat.view) < stat.view.rows.length)

  /**
   * Языки, для которых «Создать словарь» имеет смысл: их объявляют модели реестра,
   * у них нет вшитого набора (файлом его не перекрыть) и нет файла словаря — заведение
   * поверх стёрло бы правки в пользовательском слое.
   *
   * Список — из моделей, а не из реестра языков: язык, которого модель не знает,
   * считался бы ею вслепую, и словарь для него был бы пустой работой.
   */
  const createOptions = ((): readonly { readonly code: string, readonly label: string }[] => {
    const builtin = new Set(languages.filter(row => row.builtin).map(row => row.code))
    const known = new Set(snapshot.dictionaryLanguages ?? [])
    return [...new Set((snapshot.models ?? []).flatMap(row => row.languages ?? []))]
      .filter(code => !builtin.has(code) && !known.has(code))
      .map(code => ({ code, label: languageLabel(code, languages, lang) }))
      .sort((left, right) => left.label.localeCompare(right.label, lang))
  })()

  /** Язык из списка: подпись — то, что человек видит и набирает. */
  const createCode = createOptions.find(row => row.label === createLanguage)?.code

  /** Заводить словарь можно ровно тому языку, который предложен в списке. */
  const canCreateDictionary = createCode !== undefined

  /**
   * Завести словарь выбранного справа языка и сразу открыть его — то же, что «Открыть
   * словарь», только для только что созданного языка.
   *
   * Открытие — не любезность: файл заводится пустым (формат не хранит строку без
   * перевода), и единственное, что человек может с ним сделать, — заполнять строки в
   * таблице. Поэтому за созданием сразу идёт таблица этого языка, а блок «Язык Плагина»
   * переключается на него же: иначе открытая таблица и подписи блока говорили бы о
   * разных языках.
   */
  const createDictionary = (): void => {
    const code = createCode
    if (code === undefined) return
    void api<{ ok: boolean, written: readonly { set: string, file: string, lines: number, bytes: number }[] }>(
      'dictionary-create',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ language: code }) },
    )
      .then(async answer => {
        toast.push('success', tt('dictCreateDone', { files: answer.written.map(row => baseName(row.file)).join(', ') }))
        // Язык из списка уходит: словарь у него теперь есть. Поле очищаем, чтобы не
        // показывать выбор, которого больше нет, а снимок перечитываем — список языков
        // без словаря приходит с сервера, а не считается по памяти панели.
        setCreateLanguage('')
        setDictLanguage(code)
        setDictionaryOpen(true)
        await onReload()
        setDictReload(value => value + 1)
      })
      .catch((cause: Error) => { toast.push('error', tt('dictCreateFailed', { error: cause.message })) })
  }

  return (
    <>
      <div className={`${styles.panelCard} ${styles.opsBlock}`}
        ref={element => { if (blockRefs !== undefined) blockRefs.current.plugin = element }}>
        <div className={styles.cardHead}>
          <h3 className={styles.cardTitle}>{tt('pluginLanguageTitle')}</h3>
          {onTestPanel === undefined ? null : (
            <button type="button" className={styles.button}
              onClick={onTestPanel}>{tt('panelTestOpen')}</button>
          )}
        </div>
            {/* Две задачи — двумя группами, а не одним длинным рядом: «какой словарь сейчас»
                и «завести новый» — разные дела, и в узкой колонке они встают друг на друга. */}
            <div className={styles.opsFieldGrid}>
              <div className={styles.opsField}>
                <span className={styles.regLabel}>{tt('pluginLanguageCurrent')}</span>
                <div className={styles.opsFieldRow}>
                  <select className={`${styles.input} ${styles.regLang}`} value={dictLanguage}
                    aria-label={tt('pluginLanguageCurrent')}
                    onChange={event => { setDictLanguage(event.target.value) }}>
                    {pluginLanguageOptions.map(row => (
                      <option key={row.code} value={row.code}>{row.label}</option>
                    ))}
                  </select>
                  <button type="button" className={styles.button}
                    disabled={!canOpenDictionary}
                    onClick={() => { setDictionaryOpen(true) }}>{tt('dictOpenWord')}</button>
                </div>
              </div>
              {/* Заведение словаря — со своим списком языков, а не с `<datalist>`: родной список
                  рисует сам браузер поверх окна, у него нет своей прокрутки, и в невысоком окне
                  его нижние строки срезаются краем приложения. Свой список живёт в слое
                  поверх страницы, прокручивается и сам встаёт в свободную сторону.
                  В списке языки, которые знают модели, у которых ещё нет ни вшитого
                  набора, ни файла словаря. */}
              <div className={styles.opsField}>
                <span className={styles.regLabel}>{tt('dictCreateTitle')}</span>
                <div className={styles.opsFieldRow}>
                  <LanguagePicker value={createLanguage} options={createOptions}
                    placeholder={tt('registryColLanguage')} label={tt('dictCreateTitle')}
                    empty={tt('dictLangNoMatch')}
                    onChange={setCreateLanguage} />
                  <button type="button" className={styles.button}
                    disabled={!canCreateDictionary}
                    onClick={createDictionary}>{tt('dictCreateNew')}</button>
                </div>
              </div>
            </div>
            {createOptions.length === 0 && (
              <p className={styles.regNote}>{tt('dictCreateBlocked')}</p>
            )}
            <div className={styles.regGroup}>
              {dictError !== null && <p className={styles.regBad}>{dictError}</p>}
              {dictStats === null
                ? <p className={styles.regNote}>{tt('registryLoading')}</p>
                : dictStats.map(stat => {
                  const total = stat.view.rows.length
                  const filled = dictFilledOf(stat.view)
                  const files = stat.view.files.read.length === 0
                    ? tt('registryNone')
                    : stat.view.files.read.map(baseName).join(', ')
                  return (
                    <div key={stat.set} className={styles.opsDictRow}>
                      <span className={styles.opsDictDot} aria-hidden="true" />
                      <span className={styles.opsDictName}>{tt(stat.label)}</span>
                      <span className={styles.opsDictFiles} title={files}>{files}</span>
                      <span className={styles.opsDictCount}>
                        <b className={filled < total ? styles.regFilledShort : undefined}>{String(filled)}</b>
                        {` / ${String(total)}`}
                      </span>
                      <span className={stat.view.problems.length === 0 ? styles.opsDictFiles : styles.opsDictBad}>
                        {stat.view.problems.length === 0 ? tt('registryNoProblems') : String(stat.view.problems.length)}
                      </span>
                    </div>
                  )
                })}
              {dictIncomplete && <p className={styles.regIncomplete}>{tt('dictIncomplete')}</p>}
            </div>
        </div>
      {dictionaryOpen && (
        <DictionaryEditor tt={tt} host={overlayHost} toast={toast} language={dictLanguage}
          onClose={() => { setDictionaryOpen(false) }} />
      )}
    </>
  )
}

/** System 工作面的六个面向（0.13）：每个面向只回答一个问题。 */
export type SystemSection = 'runtime' | 'storage' | 'models' | 'backfill' | 'jev' | 'logs'

/** jobs 只读 API 的行（插件级队列，不属于任何分库）。 */
interface JobRowView {
  readonly id: string
  readonly kind: string
  readonly status: 'queued' | 'running' | 'done' | 'dead'
  readonly attempts: number
  readonly maxAttempts: number
  readonly lastError: string | null
}

interface JobsView {
  readonly available: boolean
  readonly summary: { readonly total: number; readonly queued: number; readonly running: number; readonly done: number; readonly dead: number }
  readonly items: readonly JobRowView[]
}

/** stats 路由的分库统计行。 */
interface StoreStatsView {
  readonly scope: 'user' | 'project' | 'shared'
  readonly stats: {
    readonly total: number
    readonly active: number
    readonly archived: number
    readonly forgotten: number
    readonly redacted: number
    readonly opLogCount: number
  }
}

/** 运行时：插件/面板版本、持久作业队列、嵌入模型。 */
function RuntimeSection({ t, reloadTick }: {
  t: T
  reloadTick: number
}): ReactElement {
  const [version, setVersion] = useState<string | null>(null)
  const [modes, setModes] = useState<{ readonly ingest?: string | undefined; readonly reflect?: string | undefined } | null>(null)
  const [jobs, setJobs] = useState<JobsView | null>(null)
  const [models, setModels] = useState<readonly { id: string; label: string | null; dtype: string; dimensions: number | null }[]>([])
  const [failed, setFailed] = useState<string | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadTick 是重载信号——外部写操作后要重新取一次运行时事实
  useEffect(() => {
    let cancelled = false
    Promise.all([
      api<{ pluginVersion: string; ingest?: string; reflect?: string }>('version'),
      api<JobsView>('jobs?limit=20'),
      api<RegistrySnapshot>('registry'),
    ])
      .then(([v, j, r]) => {
        if (cancelled) return
        setVersion(v.pluginVersion)
        setModes({ ingest: v.ingest, reflect: v.reflect })
        setJobs(j)
        setModels(r.models)
        setFailed(null)
      })
      .catch((err: Error) => { if (!cancelled) setFailed(err.message) })
    return () => { cancelled = true }
  }, [reloadTick])

  const mismatch = version !== null && version !== CLIENT_VERSION
  return (
    <div>
      <div className={styles.sectionHead}>
        <h4 className={styles.sectionTitle}>{t('systemRuntime')}</h4>
        <span className={styles.sectionHint}>{t('pageHeaderRuntimeSubtitle')}</span>
      </div>
      {failed !== null && <LoadFailedLine t={t} msg={failed} onRetry={() => { /* 重新拉取 */ }} />}
      <div className={styles.panelCard}>
        <div className={styles.cardHead}>
          <h3 className={styles.cardTitle}>{t('systemVersionCard')}</h3>
        </div>
        <dl className={styles.attrGrid}>
          <dt>{t('systemVersionPlugin')}</dt>
          <dd><code className={styles.identityCode}>{version ?? '—'}</code></dd>
          <dt>{t('systemVersionClient')}</dt>
          <dd><code className={styles.identityCode}>{CLIENT_VERSION}</code></dd>
        </dl>
        <p className={styles.sectionHint}>{mismatch ? t('systemVersionDiff') : t('systemVersionOk')}</p>
      </div>

      {modes?.ingest !== undefined && modes.ingest !== 'off' && (modes.reflect ?? 'off') === 'off' && (
        <div className={`${styles.panelCard} ${styles.degradedCard}`}>
          <p className={styles.degradedNote}>{t('systemGuardIngestNoReflect')}</p>
        </div>
      )}

      <div className={styles.panelCard}>
        <div className={styles.cardHead}>
          <h3 className={styles.cardTitle}>{t('systemJobsTitle')}</h3>
        </div>
        {jobs === null
          ? <div className={styles.expandLoading}>{t('loading')}</div>
          : !jobs.available
            ? <p className={styles.sectionHint}>{t('systemJobsUnavailable')}</p>
            : (
              <>
                <div className={styles.logTiles}>
                  <div className={styles.logTile}>
                    <span className={styles.logTileTop}>{t('systemJobsQueued')}</span>
                    <b className={styles.logTileValue}>{jobs.summary.queued}</b>
                  </div>
                  <div className={styles.logTile}>
                    <span className={styles.logTileTop}>{t('systemJobsRunning')}</span>
                    <b className={styles.logTileValue}>{jobs.summary.running}</b>
                  </div>
                  <div className={styles.logTile}>
                    <span className={styles.logTileTop}>{t('systemJobsDone')}</span>
                    <b className={styles.logTileValue}>{jobs.summary.done}</b>
                  </div>
                  <div className={styles.logTile}>
                    <span className={styles.logTileTop}>{t('systemJobsDead')}</span>
                    <b className={styles.logTileValue}>{jobs.summary.dead}</b>
                  </div>
                </div>
                {jobs.items.length === 0
                  ? <p className={styles.sectionHint}>{t('systemJobEmpty')}</p>
                  : (
                    <div className={styles.sysList}>
                      {jobs.items.map(job => (
                        <div key={job.id} className={styles.sysRow}>
                          <span className={styles.sysName} title={job.id}>{job.kind}</span>
                          <span className={styles.sysTag}>{job.status}</span>
                          <span className={styles.sysNum}>
                            {t('systemJobAttempts', { n: job.attempts })}
                            {job.lastError === null ? '' : ` · ${t('systemJobError')}: ${job.lastError}`}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
              </>
            )}
      </div>

      <div className={styles.panelCard}>
        <div className={styles.cardHead}>
          <h3 className={styles.cardTitle}>{t('systemModelStatus')}</h3>
        </div>
        {models.length === 0
          ? <p className={styles.sectionHint}>{t('systemModelNone')}</p>
          : (
            <div className={styles.sysList}>
              {models.map(model => (
                <div key={model.id} className={styles.sysRow}>
                  <span className={styles.sysName} title={model.id}>{model.label ?? model.id}</span>
                  <span className={styles.sysTag}>{model.dtype}</span>
                  <span className={styles.sysNum}>{model.dimensions ?? '—'}</span>
                </div>
              ))}
            </div>
          )}
      </div>
    </div>
  )
}

/** 存储：三个分库的规模与日志占用（只读观测；清理在 Logs 面）。 */
function StorageSection({ t, reloadTick }: {
  t: T
  reloadTick: number
}): ReactElement {
  const [stores, setStores] = useState<readonly StoreStatsView[] | null>(null)
  const [storage, setStorage] = useState<LogStorageInfo | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadTick 是重载信号——外部写操作后要重新取一次存储事实
  useEffect(() => {
    let cancelled = false
    Promise.all([
      api<{ parts: readonly StoreStatsView[] }>('stats'),
      api<LogStorageInfo>('log-info', undefined, true),
    ])
      .then(([s, l]) => {
        if (cancelled) return
        setStores(s.parts)
        setStorage(l)
        setFailed(null)
      })
      .catch((err: Error) => { if (!cancelled) setFailed(err.message) })
    return () => { cancelled = true }
  }, [reloadTick])

  return (
    <div>
      <div className={styles.sectionHead}>
        <h4 className={styles.sectionTitle}>{t('systemStorage')}</h4>
        <span className={styles.sectionHint}>{t('pageHeaderStorageSubtitle')}</span>
      </div>
      {failed !== null && <p className={styles.sectionHint}>{t('systemStorageFailed')}</p>}
      <div className={styles.panelCard}>
        {stores === null
          ? <div className={styles.expandLoading}>{t('loading')}</div>
          : (
            <table className={styles.sysTable}>
              <thead>
                <tr>
                  <th>{t('systemStorageScope')}</th>
                  <th className={styles.num}>{t('systemStorageTotal')}</th>
                  <th className={styles.num}>{t('systemStorageActive')}</th>
                  <th className={styles.num}>{t('systemStorageArchived')}</th>
                  <th className={styles.num}>{t('systemStorageForgotten')}</th>
                  <th className={styles.num}>{t('systemStorageOpLog')}</th>
                </tr>
              </thead>
              <tbody>
                {stores.map(store => (
                  <tr key={store.scope}>
                    <td>{t(`scope${store.scope.charAt(0).toUpperCase()}${store.scope.slice(1)}` as EngramKey)}</td>
                    <td className={styles.num}>{store.stats.total}</td>
                    <td className={styles.num}>{store.stats.active}</td>
                    <td className={styles.num}>{store.stats.archived}</td>
                    <td className={styles.num}>{store.stats.forgotten}</td>
                    <td className={styles.num}>{store.stats.opLogCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
      <div className={styles.panelCard}>
        <div className={styles.cardHead}>
          <h3 className={styles.cardTitle}>{t('systemStorageLogSize')}</h3>
        </div>
        <dl className={styles.attrGrid}>
          <dt>{t('systemStorageLogPath')}</dt>
          <dd><code className={styles.identityCode} title={storage?.dir ?? ''}>{storage?.dir ?? '—'}</code></dd>
          <dt>{t('systemStorageHome')}</dt>
          <dd><code className={styles.identityCode} title={storage?.home ?? ''}>{storage?.home ?? '—'}</code></dd>
          <dt>{t('systemStorageLogSize')}</dt>
          <dd>{storage === null ? '—' : formatBytes(storage.totals.fileBytes)}</dd>
          <dt>{t('systemStorageOpLog')}</dt>
          <dd>{storage === null ? '—' : String(storage.totals.rows)}</dd>
        </dl>
        {storage?.outsideHome === true && (
          <p className={styles.degradedNote}>{t('systemStorageOutsideHome')}</p>
        )}
      </div>
    </div>
  )
}

/**
 * System 工作面主体：按二级导航切分六个面向。
 * 每个面向自己取数——打开哪个面，就只付哪个面的请求代价。
 */
export function SystemView({
  t, section, overlayHost, lang, toast, onTestPanel, telemetry, reloadTick, onCleared,
}: {
  t: T
  section: SystemSection
  overlayHost: { readonly current: HTMLDivElement | null }
  lang: PanelLang
  toast: ToastController
  onTestPanel: () => void
  telemetry: TelemetrySnapshot | null
  reloadTick: number
  onCleared: () => void
}): ReactElement {
  const { data: snapshot, failed: error, reload } = useApi<RegistrySnapshot>('registry')
  /** Узлы блоков: верхняя навигация прокручивает к ним. */
  const blocks = useRef<Record<string, HTMLElement | null>>({})

  const tt = (key: EngramKey, params?: Record<string, string | number>): string => t(key, params)

  if (section === 'runtime') return <RuntimeSection t={t} reloadTick={reloadTick} />
  if (section === 'storage') return <StorageSection t={t} reloadTick={reloadTick} />
  if (section === 'logs') {
    return (
      <div>
        <div className={styles.sectionHead}>
          <h4 className={styles.sectionTitle}>{tt('tabLog')}</h4>
          <span className={styles.sectionHint}>{tt('pageHeaderLogSubtitle')}</span>
        </div>
        <LogPanel t={t} telemetry={telemetry} project={null} onCleared={onCleared} />
      </div>
    )
  }
  if (section === 'backfill') {
    return (
      <div>
        <div className={styles.sectionHead}>
          <h4 className={styles.sectionTitle}>{tt('tabBackfill')}</h4>
          <span className={styles.sectionHint}>{tt('pageHeaderBackfillSubtitle')}</span>
        </div>
        <div className={styles.panelCard}>
          <HistoryBackfillCard t={t} toast={toast} />
        </div>
      </div>
    )
  }
  if (section === 'jev') {
    return (
      <div>
        <div className={styles.sectionHead}>
          <h4 className={styles.sectionTitle}>{tt('tabJev')}</h4>
          <span className={styles.sectionHint}>{tt('pageHeaderJevSubtitle')}</span>
        </div>
        <div className={styles.panelCard}>
          <JevConfigCard t={t} toast={toast} />
          <div className={styles.cardDivider} />
          <JevObservationsCard t={t} toast={toast} />
        </div>
      </div>
    )
  }
  // models
  if (error !== null) {
    return <div className={styles.empty}><b>{tt('registryFailed')}</b><span>{error}</span></div>
  }
  if (snapshot === null) return <div className={styles.expandLoading}>{tt('registryLoading')}</div>
  return (
    <div>
      <div className={styles.sectionHead}>
        <h4 className={styles.sectionTitle}>{tt('systemModels')}</h4>
        <span className={styles.sectionHint}>{tt('pageHeaderModelsSubtitle')}</span>
      </div>
      <nav className={styles.opsNav} aria-label={tt('systemModels')}>
        {([
          ['palace', tt('palaceLanguageTitle')],
          ['plugin', tt('pluginLanguageTitle')],
        ] as const).map(([key, label]) => (
          <button key={key} type="button" className={styles.chip}
            onClick={() => {
              const target = blocks.current[key]
              if (target === null || target === undefined) return
              target.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }}>
            {label}
          </button>
        ))}
      </nav>
      <div className={styles.layout}>
        <div className={styles.mainCol}>
          <PalaceLanguageCard t={t} snapshot={snapshot} onReload={reload} blockRefs={blocks} toast={toast} />
        </div>
        <div className={styles.sideCol}>
          <PluginLanguageCard t={t} snapshot={snapshot} onReload={reload} overlayHost={overlayHost}
            lang={lang} onTestPanel={onTestPanel} blockRefs={blocks} toast={toast} />
        </div>
      </div>
    </div>
  )
}

type DictionarySetName = 'panel' | 'messages'

/** Где на экране встал открытый список языка: считаем от поля, а не от разметки. */
interface PickerBox {
  readonly left: number
  readonly width: number
  readonly maxHeight: number
  /** Сверху от поля или снизу: прижат к своей стороне, чтобы расти от поля. */
  readonly below: boolean
  readonly top: number
  readonly bottom: number
}

function LanguagePicker({ value, options, placeholder, label, empty, onChange }: {
  readonly value: string
  readonly options: readonly { readonly code: string, readonly label: string }[]
  readonly placeholder: string
  readonly label: string
  /** Что сказать, когда под набранный текст ничего не подошло. */
  readonly empty: string
  readonly onChange: (text: string) => void
}): React.ReactElement {
  const fieldRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  /** Строка, на которой стоит клавиатура: −1 — ни на какой. */
  const [active, setActive] = useState(-1)
  const [box, setBox] = useState<PickerBox | null>(null)

  const shown = useMemo(() => {
    const query = value.trim().toLowerCase()
    if (query === '') return options
    return options.filter(row => row.label.toLowerCase().includes(query) || row.code.toLowerCase().includes(query))
  }, [options, value])

  /**
   * Поставить список у поля.
   *
   * Высота — по свободному месту: снизу его больше — список идёт вниз, меньше — вверх.
   * Совсем тесное окно всё равно оставляет список прокручиваемым (96px), иначе выбор
   * языка пропадал бы именно там, где он нужнее всего. Ширина — не уже поля, но и не
   * за краем окна: у правого края список сдвигается влево, а не вылезает наружу.
   */
  const place = useCallback((): void => {
    const field = fieldRef.current
    if (field === null) return
    const rect = field.getBoundingClientRect()
    const viewportW = window.innerWidth
    const viewportH = window.innerHeight
    const gap = 6
    const free = viewportH - rect.bottom - gap - 8
    const freeAbove = rect.top - gap - 8
    const below = free >= freeAbove || freeAbove < 160
    const room = Math.max(96, Math.min(320, below ? free : freeAbove))
    const width = Math.max(rect.width, 200)
    const left = Math.max(8, Math.min(rect.left, viewportW - width - 8))
    setBox({
      left,
      width,
      maxHeight: room,
      below,
      top: rect.bottom + gap,
      bottom: viewportH - rect.top + gap,
    })
  }, [])

  // Открытый список следит за полем: прокрутка панели и смена размера окна двигают его,
  // и список обязан ехать вместе с полем, а не висеть на прежнем месте.
  useEffect(() => {
    if (!open) return undefined
    place()
    const onMove = (): void => { place() }
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, true)
    return () => {
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove, true)
    }
  }, [open, place])

  // Щелчок мимо поля и мимо списка закрывает список: так же ведёт себя любой выбор.
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (fieldRef.current?.contains(target) === true) return
      if (listRef.current?.contains(target) === true) return
      setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => { window.removeEventListener('mousedown', onDown) }
  }, [open])

  // Новая порция строк — клавиатура встаёт на первую: иначе она указывала бы в пустоту.
  useEffect(() => { setActive(shown.length === 0 ? -1 : 0) }, [shown])

  // Выбранная строка должна быть видна: список прокручивается под клавиатуру.
  useEffect(() => {
    if (!open || active < 0) return
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index='${String(active)}']`)
    node?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  const pick = (code: string): void => {
    const row = shown.find(item => item.code === code)
    if (row === undefined) return
    onChange(row.label)
    setOpen(false)
    fieldRef.current?.focus()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      const step = event.key === 'ArrowDown' ? 1 : -1
      const next = Math.min(Math.max(active + step, 0), shown.length - 1)
      setActive(next)
      return
    }
    if (event.key === 'Enter') {
      if (!open || active < 0) return
      const row = shown[active]
      if (row === undefined) return
      event.preventDefault()
      pick(row.code)
      return
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      setOpen(false)
    }
  }

  const list = open && box !== null
    ? createPortal(
      <div ref={listRef} className={styles.dictLangList} role="listbox" aria-label={label}
        style={{
          left: box.left,
          width: box.width,
          maxHeight: box.maxHeight,
          ...(box.below ? { top: box.top } : { bottom: box.bottom }),
        }}>
        {shown.length === 0
          ? <p className={styles.dictLangEmpty}>{empty}</p>
          : shown.map((row, index) => (
            <button key={row.code} type="button" role="option" aria-selected={index === active}
              data-index={index} data-active={index === active}
              className={styles.dictLangOption}
              onMouseEnter={() => { setActive(index) }}
              onClick={() => { pick(row.code) }}>
              <span>{row.label}</span>
              <span className={styles.dictLangOptionCode}>{row.code}</span>
            </button>
          ))}
      </div>,
      document.body,
    )
    : null

  return (
    <span className={styles.dictLangField}>
      <input ref={fieldRef} type="text" className={`${styles.input} ${styles.dictLangInput}`}
        value={value} placeholder={placeholder} aria-label={label}
        role="combobox" aria-expanded={open}
        onChange={event => { onChange(event.target.value); setOpen(true) }}
        onFocus={() => { setOpen(true) }}
        onKeyDown={onKeyDown} />
      {list}
    </span>
  )
}

interface DictionaryRowView {
  /** Английская строка — она же ключ словаря, поэтому её не правят. */
  readonly left: string
  /** Что стоит справа сейчас; пусто — перевода нет. */
  readonly right: string
  /** Откуда взят правый столбец: правка, поставка, вшитый набор или ничего. */
  readonly source: 'user' | 'delivery' | 'builtin' | 'none'
  /** Значение пользовательского слоя; null — строки в файле нет, '' — строка есть без перевода. */
  readonly override: string | null
  /** Есть ли такая левая часть в наборе текстов программы: false — строка файла без ключа. */
  readonly known: boolean
}

interface DictionaryStatsView {
  readonly program: number
  readonly file: number
  readonly missing: number
  readonly unkeyed: number
}

interface DictionarySetView {
  readonly set: DictionarySetName
  readonly language: string
  readonly rows: readonly DictionaryRowView[]
  readonly files: { readonly delivery: string, readonly user: string, readonly read: readonly string[] }
  readonly problems: readonly { readonly file: string, readonly line: number, readonly kind: string, readonly detail: string }[]
  /**
   * Сверка. Может не прийти: серверная половина старше клиентской (после обновления
   * плагина до перезапуска DSH). Тогда строка сверки не рисуется — панель не должна
   * падать из-за того, что сервер ещё не знает про неё.
   */
  readonly stats?: DictionaryStatsView
}

interface DictStatView {
  readonly set: DictionarySetName
  readonly label: 'registryDictionaryMessages' | 'registryDictionaryPanel'
  readonly view: DictionarySetView
}

function dictFilledOf(view: DictionarySetView): number {
  return view.rows.filter(row => row.right !== '').length
}

interface DictionarySaveResultView {
  readonly set: DictionarySetName
  readonly file: string
  readonly written: number
  readonly bytes: number
  readonly view: DictionarySetView
}

interface DictionaryFillAnswer {
  readonly set: DictionarySetName
  readonly provider: string
  readonly model: string
  readonly translations: readonly (readonly [string, string])[]
}

const DictionaryRow = memo(function DictionaryRow({ left, value, edited, hint, placeholder, onEdit }: {
  readonly left: string
  readonly value: string
  readonly edited: boolean
  readonly hint: string
  readonly placeholder: string
  readonly onEdit: (left: string, next: string) => void
}): React.ReactElement {
  return (
    <label className={`${styles.dictRow} ${edited ? styles.dictRowEdited : ''}`} title={hint}>
      <span className={styles.dictLeft}>{left}</span>
      <input className={styles.dictInput} value={value} placeholder={placeholder} spellCheck={false}
        onChange={event => { onEdit(left, event.target.value) }} />
    </label>
  )
})

function DictionaryEditor({ tt, host, toast, onClose, language }: {
  readonly tt: (key: EngramKey, params?: Record<string, string | number>) => string
  /** Якорь оверлея (начало `.panelRoot`): экран уходит туда порталом. Сам он fixed, но якорь
   *  обязан лежать вне `.panel` — иначе собственный контекст наложения панели не даст
   *  перекрыть окно целиком. */
  readonly host: { readonly current: HTMLDivElement | null }
  readonly toast: ToastController
  readonly onClose: () => void
  /**
   * Язык набора: тот, что выбран в блоке «Язык Плагина». Без него таблица показывала бы
   * словарь текущего языка плагина, и человек правил бы не тот файл, который открыл.
   */
  readonly language: string
}): React.ReactElement {
  const [set, setSet] = useState<DictionarySetName>('panel')
  const [view, setView] = useState<DictionarySetView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  /**
   * Что показать из сверки: все строки, ключи без перевода или строки без ключа.
   *
   * Группа — это фильтр таблицы, а не отдельный экран: человек видит находку и тут же
   * правит клетку, не теряя из виду остальной словарь.
   */
  const [group, setGroup] = useState<'all' | 'missing' | 'unkeyed'>('all')
  /** Черновик правок: английская строка → значение клетки ('' — снять правку). */
  const [draft, setDraft] = useState<ReadonlyMap<string, string>>(new Map())
  /** Что сейчас занято: сохранение и заполнение не ходят одновременно. */
  const [busy, setBusy] = useState<'save' | 'fill' | null>(null)
  /** Прогресс заполнения (null — не заполняем): отправлено партий / терминов всего. */
  const [fill, setFill] = useState<{ readonly done: number, readonly total: number } | null>(null)
  /** Просьба остановить заполнение: проверяется перед каждой партией. */
  const stopFill = useRef(false)
  /**
   * Рамка, которую кроет экран: видимая область панели, а не весь клиент.
   *
   * Полноэкранный слой (`inset: 0`) заезжал на верхнюю полосу приложения — над панелью
   * у неё своё меню, и заголовок «Словарь» печатался прямо поверх него. Якорь оверлея
   * лежит началом `.panelRoot`, а тот сам является скроллером: его рамка не меняется
   * при прокрутке и всегда равна тому, что видно от панели. Отсюда и берём прямоугольник.
   */
  const [frame, setFrame] = useState<{ readonly top: number, readonly left: number, readonly width: number, readonly height: number } | null>(null)
  useLayoutEffect(() => {
    const anchor = host.current?.parentElement ?? null
    if (anchor === null) return undefined
    const measure = (): void => {
      const box = anchor.getBoundingClientRect()
      setFrame({ top: box.top, left: box.left, width: box.width, height: box.height })
    }
    // useLayoutEffect — до первой отрисовки: слой не успевает мигнуть на весь клиент.
    measure()
    window.addEventListener('resize', measure)
    const observer = new ResizeObserver(measure)
    observer.observe(anchor)
    return () => {
      window.removeEventListener('resize', measure)
      observer.disconnect()
    }
  }, [host])

  // Набор перечитывается на каждое переключение: «панель» и «сообщения» — разные
  // файлы, и общий кэш здесь только запутал бы, чей перевод на экране. Заодно
  // останавливается заполнение: партии другого набора в этот черновик не годятся.
  useEffect(() => {
    let alive = true
    stopFill.current = true
    setFill(null)
    setBusy(null)
    setView(null)
    setError(null)
    setDraft(new Map())
    setGroup('all')
    void (async () => {
      try {
        const data = await api<DictionarySetView>(`dictionary?set=${set}&language=${encodeURIComponent(language)}`)
        if (alive) setView(data)
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
    return () => { alive = false }
  }, [set, language])

  /** Что стоит в клетке: несохранённая правка, иначе значение слоя. */
  const cell = useCallback((row: DictionaryRowView): string => draft.get(row.left) ?? row.right, [draft])

  const edit = useCallback((left: string, next: string) => {
    setDraft(current => new Map(current).set(left, next))
  }, [])

  const rows = useMemo(() => {
    if (view === null) return []
    // Сначала группа сверки, потом поиск: группа — это «что чинить», поиск — «где это».
    const inGroup = view.rows.filter(row => {
      if (group === 'missing') return cell(row).trim() === ''
      // Именно `=== false`: у сервера старше клиента признака нет вовсе, и
      // «ключа нет» из отсутствия поля не следует.
      if (group === 'unkeyed') return row.known === false
      return true
    })
    const needle = query.trim().toLowerCase()
    if (needle === '') return inGroup
    // Ищем и по термину, и по переводу: чаще всего ищут «где эта надпись».
    return inGroup.filter(row => row.left.toLowerCase().includes(needle) || cell(row).toLowerCase().includes(needle))
  }, [view, query, cell, group])

  /**
   * Партия правок — то, что уйдёт в файл: только клетки, отличающиеся от слоя.
   * Пустое значение остаётся значимым («снять правку»), поэтому отбрасывается не пустое,
   * а совпадающее с тем, что уже лежит в словаре.
   */
  const patch = useMemo(() => {
    if (view === null) return [] as readonly (readonly [string, string])[]
    const changed: (readonly [string, string])[] = []
    for (const row of view.rows) {
      const value = draft.get(row.left)
      if (value === undefined || value === row.right) continue
      changed.push([row.left, value])
    }
    return changed
  }, [view, draft])
  const dirty = patch.length

  /** Клетки без перевода: только их и отдаём модели — заполнение не перекрывает готовое. */
  const fillable = useMemo(() => {
    if (view === null) return [] as readonly string[]
    // Строки из одних подстановок и знаков не спрашиваем: переводить в них нечего, а
    // каждый проход тратил на них партию и оставлял те же пустые клетки (см. needsTranslation).
    return view.rows.filter(row => cell(row).trim() === '' && needsTranslation(row.left)).map(row => row.left)
  }, [view, cell])

  const save = (): void => {
    if (view === null || dirty === 0 || busy !== null) return
    setBusy('save')
    void (async () => {
      // Правок бывает больше, чем пролезает в одно тело запроса (набор сообщений при
      // заполнении нового языка): режем по размеру, а не по числу строк. Каждая пачка —
      // законченная запись (правки накладываются на слой), поэтому обрыв на середине
      // оставляет уже записанное записанным, а не откатывает всё.
      const chunks = splitDictionaryPatch(patch)
      const sent: string[] = []
      let last: DictionarySaveResultView | null = null
      try {
        for (const chunk of chunks) {
          const answer = await api<DictionarySaveResultView>('dictionary', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ set, language, entries: chunk }),
          })
          last = answer
          for (const row of chunk) sent.push(row[0])
        }
      } catch (cause) {
        const text = cause instanceof Error ? cause.message : String(cause)
        // Что успело записаться, то записалось: об этом говорят отдельно, чтобы «не вышло»
        // не читалось как «ничего не изменилось».
        if (sent.length > 0) toast.push('success', tt('dictSaved', { n: sent.length, file: last?.file ?? '' }))
        toast.push('error', tt('dictSaveFailed', { error: text }))
        return
      } finally {
        // Таблица продолжает показывать записанное: представление берём из ответа последней
        // пачки, а не перечитываем — иначе «сохранил» и «вижу» расходятся на один запрос.
        if (last !== null) setView(last.view)
        // Записанные клетки возвращаются к слою: иначе снятая правка (пустая клетка)
        // навсегда осталась бы «изменённой» и кнопка сохранения не гасла бы.
        setDraft(current => {
          const next = new Map(current)
          for (const left of sent) next.delete(left)
          return next
        })
        setBusy(null)
      }
      toast.push('success', tt('dictSaved', { n: sent.length, file: last?.file ?? '' }))
    })()
  }

  const cancel = (): void => {
    if (dirty === 0 || busy !== null) return
    setDraft(new Map())
    toast.push('info', tt('dictReverted'))
  }

  /** Уход с экрана: несохранённое теряется, поэтому об этом говорят, а не молчат. */
  const back = (): void => {
    if (dirty > 0) toast.push('info', tt('dictReverted'))
    onClose()
  }

  const fillAi = (): void => {
    if (view === null) return
    // Второе нажатие — остановка: у долгого заполнения должна быть кнопка «хватит».
    if (fill !== null) { stopFill.current = true; return }
    if (busy !== null || fillable.length === 0) return
    const terms = fillable
    const base = new Map(view.rows.map(row => [row.left, row.right]))
    stopFill.current = false
    setBusy('fill')
    setFill({ done: 0, total: terms.length })
    void (async () => {
      let filled = 0
      let sent = 0
      let failure: string | null = null
      // Партии режет общий с сервером предел — по числу терминов и по длине строк: вывод
      // модели растёт вместе со входом, и одна большая партия упиралась в предел вывода,
      // теряя ответ целиком (сорок длинных подсказок набора «сообщения»).
      for (const batch of splitFillBatch(terms)) {
        if (stopFill.current) break
        try {
          const answer = await api<DictionaryFillAnswer>('dictionary-fill', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ set, terms: batch }),
          })
          // Набор переключили, пока партия ехала: её переводы уже чужого словаря.
          if (stopFill.current) break
          setDraft(current => {
            const next = new Map(current)
            for (const [left, right] of answer.translations) {
              // Пишем только в пустую клетку: ни работа человека, ни прошлая партия
              // не перекрываются — иначе повторный проход затирал бы уже принятое.
              if ((next.get(left) ?? base.get(left) ?? '').trim() !== '') continue
              next.set(left, right)
            }
            return next
          })
          filled += answer.translations.length
        } catch (cause) {
          failure = cause instanceof Error ? cause.message : String(cause)
          break
        }
        sent += batch.length
        setFill({ done: sent, total: terms.length })
      }
      stopFill.current = true
      setFill(null)
      setBusy(null)
      if (filled > 0) toast.push('success', tt('dictFillDone', { n: filled }))
      if (failure !== null) toast.push('error', tt('dictFillFailed', { error: failure }))
    })()
  }

  /**
   * Подпись строки (в подсказке, не в колонке): сначала «такого ключа в программе нет» —
   * это важнее источника текста, потому что такую строку человек не ищет, а находит.
   */
  const hintOf = (row: DictionaryRowView): string => row.known === false
    ? tt('dictRowUnkeyed')
    : row.source === 'user' ? tt('dictEdited')
      : row.source === 'delivery' ? tt('dictShipped') : row.source === 'builtin' ? tt('dictBuiltin') : tt('dictNoTranslation')

  /** Сверка либо ничего: сервер старше клиента её не считает (см. `DictionarySetView.stats`). */
  const stats = view?.stats

  // Экран уходит порталом в якорь оверлеев (.overlayHost) вне .panel: сам он fixed, поэтому
  // место якоря не важно, важна лишь чужая область наложения. Якорь ещё не смонтирован —
  // рисуем на месте, без портала: нажатие никогда не должно оставаться без ответа.
  const screen = (
    <div className={styles.dictScreen}
      style={frame === null ? undefined : {
        top: frame.top, left: frame.left, width: frame.width, height: frame.height, right: 'auto', bottom: 'auto',
      }}>
      <div className={styles.dictMenu}>
        <button type="button" className={styles.dictBack} onClick={back}
          title={tt('dictBack')} aria-label={tt('dictBack')}>{'←'}</button>
        <span className={styles.dictTitle}>{tt('dictTitle')}</span>
        <div className={styles.dictMenuRight}>
          <button type="button" className={styles.button}
            disabled={view === null || busy === 'save' || (fill === null && fillable.length === 0)}
            title={fill !== null ? tt('dictFillStop') : fillable.length === 0 ? tt('dictFillHint') : tt('dictFillAiHint')}
            onClick={fillAi}>
            {fill !== null ? tt('dictFillStop') : tt('dictFillAi')}
          </button>
          <button type="button" className={styles.button} disabled={busy !== null || dirty === 0}
            title={dirty === 0 ? tt('dictCancelHint') : undefined} onClick={cancel}>
            {tt('dictCancel')}
          </button>
          <button type="button" className={styles.button} disabled={busy !== null || dirty === 0}
            title={dirty === 0 ? tt('dictSaveHint') : undefined} onClick={save}>
            {busy === 'save' ? tt('dictSaveBusy') : tt('dictSave')}
          </button>
        </div>
      </div>
      <div className={styles.dictBar}>
        {(['panel', 'messages'] as const).map(name => (
          <button key={name} type="button" className={name === set ? styles.dictSetOn : styles.dictSet}
            onClick={() => { setSet(name) }}>
            {name === 'panel' ? tt('dictSetPanel') : tt('dictSetMessages')}
          </button>
        ))}
        <input className={styles.dictFilter} value={query} placeholder={tt('dictFilter')} spellCheck={false}
          onChange={event => { setQuery(event.target.value) }} />
        <span className={styles.dictStatus}>
          {view === null ? tt('dictLoading') : tt('dictRows', { n: view.rows.length })}
          {dirty > 0 && <> · {tt('dictDirty', { n: dirty })}</>}
          {fill !== null && <> · {tt('dictFillRunning', { done: fill.done, total: fill.total })}</>}
          {view !== null && <> · {tt('dictTarget')} <span className={styles.regMono}>{view.files.user}</span></>}
        </span>
      </div>
      {/* Сверка программы с файлом: числа независимы и стоят рядом намеренно —
          совпадение ключей в коде и строк в файле ничего не доказывает, а находки
          (ключ без перевода, строка без ключа) и есть то, ради чего словарь открывают.
          Нажатие на находку — фильтр таблицы, а не отдельный экран. */}
      {stats !== undefined && (
        <div className={styles.dictCheck}>
          <span>{tt('dictCheckProgram', { n: stats.program })}</span>
          <span>{tt('dictCheckFile', { n: stats.file })}</span>
          <button type="button" className={group === 'missing' ? styles.dictChipOn : styles.dictChip}
            disabled={stats.missing === 0 && group !== 'missing'}
            title={tt('dictCheckMissingHint')}
            onClick={() => { setGroup(group === 'missing' ? 'all' : 'missing') }}>
            {tt('dictCheckMissing', { n: stats.missing })}
          </button>
          <button type="button" className={group === 'unkeyed' ? styles.dictChipOn : styles.dictChip}
            disabled={stats.unkeyed === 0 && group !== 'unkeyed'}
            title={tt('dictCheckUnkeyedHint')}
            onClick={() => { setGroup(group === 'unkeyed' ? 'all' : 'unkeyed') }}>
            {tt('dictCheckUnkeyed', { n: stats.unkeyed })}
          </button>
          {group !== 'all' && (
            <button type="button" className={styles.dictChip} onClick={() => { setGroup('all') }}>
              {tt('dictCheckAll')}
            </button>
          )}
        </div>
      )}
      <div className={styles.dictBody}>
        <p className={styles.regNote}>{tt('dictHint', { file: view?.files.user ?? '' })}</p>
        {error !== null
          ? <p className={styles.regBad}>{tt('dictFailed', { error })}</p>
          : view === null
            ? <p className={styles.regNote}>{tt('dictLoading')}</p>
            : rows.length === 0
              ? <p className={styles.regNote}>{tt('dictNoRows')}</p>
              : rows.map(row => (
                <DictionaryRow key={row.left} left={row.left} value={cell(row)} hint={hintOf(row)}
                  placeholder={row.source === 'none' ? tt('dictNoTranslation') : ''}
                  edited={draft.get(row.left) !== undefined && draft.get(row.left) !== row.right}
                  onEdit={edit} />
              ))}
      </div>
    </div>
  )

  const hostNode = host.current
  return hostNode === null ? screen : createPortal(screen, hostNode)
}
