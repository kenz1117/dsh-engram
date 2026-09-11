/**
 * 记忆库设置面板：统计卡片、过滤列表、批量操作、编辑（取代链）、遗忘/恢复、导出。
 * 数据经回环 API（/api/engram/*）读写；详情与编辑为条目下方行内展开
 * （不嵌套弹窗）；文案全部走宿主 locale 词典（zh/en），语言切换自动
 * 重渲染；数据层英文枚举（status/kind/op）只在显示层映射；内容节点
 * 一律 DOM/JSX 构建（防 XSS）。
 * @module @kenz1117/dsh-engram/client/EngramPanel
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import styles from './panel.module.css'
import { NS, type EngramKey } from './locales.ts'
import { CorridorMap } from './CorridorMap.tsx'
import { useToast, type ToastController } from './Toast.tsx'
import { usePersistedState, usePersistedString } from './UiStorage.ts'

/** 列表/详情用的记忆视图（宿主 /api/engram/list 的行结构）。 */
interface MemoryRow {
  readonly id: string
  readonly scope: 'user' | 'project' | 'shared'
  readonly kind: string
  readonly content: string
  readonly importance: number
  readonly confidence: number
  readonly status: 'active' | 'archived' | 'forgotten'
  /** 最近一次使用效果回报（engram_report 写入；未回报过缺省）。 */
  readonly outcome?: 'success' | 'failure'
  readonly createdAt: number
  readonly accessCount: number
  readonly sourceSessionId: string | null
  readonly sourceRound: number | null
  /** 桩位（v0.7.2 起；未排桩时缺省）。 */
  readonly slot?: { readonly room: string; readonly index: number }
}

interface ListResult {
  readonly records: MemoryRow[]
  readonly total: number
}

interface StatsPart {
  readonly scope: 'user' | 'project' | 'shared'
  readonly stats: {
    readonly total: number
    readonly active: number
    readonly archived: number
    readonly forgotten: number
    readonly redacted: number
    readonly signalRatio: number
  }
}

/** review API 的返回结构（详情行内展开区的数据源）。 */
interface ReviewView {
  readonly record: MemoryRow
  readonly supersededBy?: readonly string[]
  readonly supersedes?: readonly string[]
  readonly contradicts?: readonly string[]
  readonly related?: readonly string[]
  /** 修订历史（旧内容快照，按被取代时间倒序）。 */
  readonly revisions?: readonly { content: string; kind: string; importance: number; supersededAt: number }[]
  readonly operations?: readonly { at: number; op: string; detail: string | null }[]
}

/** 面板内部传递的翻译函数（渲染器按注册的 locale 声明合成的 t 的窄化签名）。 */
type T = (key: EngramKey, params?: Record<string, unknown>) => string

/** kind 数据值（存储层英文枚举，编辑表单下拉的 value 保持英文）。 */
const KINDS = ['fact', 'preference', 'decision', 'episode', 'skill'] as const
const PAGE_SIZE = 20

/** 数据层枚举 → 词典键映射（显示层本地化，存储值不变）。 */
const STATUS_KEY: Record<MemoryRow['status'], EngramKey> = {
  active: 'statusActive',
  archived: 'statusArchived',
  forgotten: 'statusForgotten',
}
const KIND_KEY: Record<string, EngramKey> = {
  fact: 'kindFact',
  preference: 'kindPreference',
  decision: 'kindDecision',
  episode: 'kindEpisode',
  skill: 'kindSkill',
}
const SCOPE_KEY: Record<MemoryRow['scope'], EngramKey> = {
  user: 'scopeUser',
  project: 'scopeProject',
  shared: 'scopeShared',
}
const OP_KEY: Record<string, EngramKey> = {
  write: 'opWrite',
  update: 'opUpdate',
  forget: 'opForget',
  restore: 'opRestore',
  decay: 'opDecay',
  superseded: 'opSuperseded',
  'ingest-request': 'opIngestRequest',
  'ingest-done': 'opIngestDone',
  'outcome-report': 'opOutcomeReport',
  'search-rewrite-request': 'opSearchRewrite',
  'compress-request': 'opCompressRequest',
  'distill-request': 'opDistillRequest',
}
const REL_KEY: Record<string, EngramKey> = {
  supersededBy: 'relSupersededBy',
  supersedes: 'relSupersedes',
  contradicts: 'relContradicts',
  related: 'relRelated',
}
/** 操作日志 detail JSON 的已知键 → 词典键（write/update/superseded 的小对象）。 */
const DETAIL_KEY: Record<string, EngramKey> = {
  kind: 'labelKind',
  scope: 'labelScope',
  status: 'labelStatus',
}

/** kind 数据值 → 本地化标签（未知值回退原文）。 */
function kindLabel(t: T, kind: string): string {
  const key = KIND_KEY[kind]
  return key === undefined ? kind : t(key)
}

/** op 数据值 → 本地化标签（未知值回退原文）。 */
function opLabel(t: T, op: string): string {
  const key = OP_KEY[op]
  return key === undefined ? op : t(key)
}

/** 操作日志 detail 的本地化：write/update/superseded 的小对象转中文键值；摄取/蒸馏请求的完整 JSON 保持原样（审计诚实性优先）。 */
function formatOpDetail(t: T, op: string, detail: string | null): string {
  if (detail === null) return ''
  if (op !== 'write' && op !== 'update' && op !== 'superseded') return ` ${detail}`
  try {
    const parsed = JSON.parse(detail) as Record<string, unknown>
    const entries = Object.entries(parsed)
    if (entries.length === 0) return ` ${detail}`
    return ' ' + entries.map(([key, value]) => {
      const label = DETAIL_KEY[key]
      if (label === undefined) return `${key}=${String(value)}`
      if (key === 'kind' && typeof value === 'string') return `${t(label)}=${kindLabel(t, value)}`
      if (key === 'scope' && (value === 'user' || value === 'project')) return `${t(label)}=${t(SCOPE_KEY[value])}`
      return `${t(label)}=${String(value)}`
    }).join(' · ')
  } catch {
    return ` ${detail}`
  }
}

/** 来源会话展示片段：截短的会话 id + 可选轮次。 */
function sourceLabel(t: T, record: Pick<MemoryRow, 'sourceSessionId' | 'sourceRound'>): string {
  if (record.sourceSessionId === null) return t('sourceExplicit')
  const id = `${record.sourceSessionId.slice(0, 16)}…`
  const withRound = record.sourceRound === null
    ? id
    : `${id} ${t('round', { n: record.sourceRound })}`
  return t('sourceSession', { id: withRound })
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/engram/${path}`, init)
  const body = (await response.json()) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${String(response.status)}`)
  return body
}

/** 绝对时间（审计时间线等需要精确时刻的位置）。 */
function fmtTime(ms: number): string {
  // 时间格式跟随浏览器环境语言（宿主界面语言通常与浏览器一致）。
  return new Date(ms).toLocaleString(navigator.language || 'zh-CN', { hour12: false })
}

/** 列表用的相对时间：1 分钟内「刚刚」，其后按分钟/小时/天取整。 */
function relTime(t: T, ms: number): string {
  const diff = Math.max(0, Date.now() - ms)
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return t('timeJustNow')
  if (minutes < 60) return t('timeMinutesAgo', { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return t('timeHoursAgo', { n: hours })
  return t('timeDaysAgo', { n: Math.floor(hours / 24) })
}

/** 细仪表条：重要性（品牌色）与置信（成功色）共用，conf 变体换色。 */
function Meter({ value, conf }: { value: number; conf?: boolean }): React.ReactElement {
  return (
    <span className={conf === true ? `${styles.meter} ${styles.conf}` : styles.meter}>
      <i style={{ width: `${String(Math.round(Math.min(1, Math.max(0, value)) * 100))}%` }} />
    </span>
  )
}

/** 关系 id 列表 → 等宽字体 chips（完整 id 放 title）。 */
function RelChips({ ids }: { ids: readonly string[] }): React.ReactElement {
  return (
    <div className={styles.relChips}>
      {ids.map(id => <span key={id} className={styles.relChip} title={id}>{id.slice(0, 18)}</span>)}
    </div>
  )
}

/** 行内审计区：属性网格 + 关系 chips + 操作时间线（review API）。 */
function ReviewBody({ t, recordId, scope }: {
  t: T
  recordId: string
  scope: 'user' | 'project' | 'shared'
}): React.ReactElement {
  const [view, setView] = useState<ReviewView | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    api<ReviewView>(`review?scope=${scope}&id=${encodeURIComponent(recordId)}`)
      .then((data) => { if (!cancelled) setView(data) })
      .catch((error: Error) => { if (!cancelled) setFailed(error.message) })
    return () => { cancelled = true }
  }, [recordId, scope, t])
  if (failed !== null) return <div className={styles.expandLoading}>{t('loadFailed', { msg: failed })}</div>
  if (view === null) return <div className={styles.expandLoading}>{t('loading')}</div>
  const { record } = view
  const relations = (['supersededBy', 'supersedes', 'contradicts', 'related'] as const)
    .map(key => ({ key, label: REL_KEY[key], ids: view[key] ?? [] }))
    .filter(entry => entry.ids.length > 0)
  const operations = view.operations ?? []
  return (
    <div className={styles.reviewGrid}>
      <div>
        <dl className={styles.attrGrid}>
          <dt>{t('labelContent')}</dt>
          <dd>{record.content}</dd>
          <dt>{t('labelKind')}</dt>
          <dd><span className={`${styles.pill} ${styles.kind}`}>{kindLabel(t, record.kind)}</span></dd>
          <dt>{t('labelStatus')}</dt>
          <dd><span className={`${styles.pill} ${styles[`status${record.status.charAt(0).toUpperCase()}${record.status.slice(1)}`] ?? ''}`}>{t(STATUS_KEY[record.status])}</span></dd>
          <dt>{t('importance')}</dt>
          <dd>{record.importance.toFixed(2)}<Meter value={record.importance} /></dd>
          <dt>{t('confidence')}</dt>
          <dd>{record.confidence.toFixed(2)}<Meter value={record.confidence} conf /></dd>
          <dt>{t('detailSource')}</dt>
          <dd>{sourceLabel(t, record)}</dd>
          <dt>{t('labelCreated')}</dt>
          <dd>{fmtTime(record.createdAt)}</dd>
        </dl>
        {relations.map(({ key, label, ids }) => (
          <div key={key} className={styles.relBlock}>
            <h5>{label === undefined ? key : t(label)}</h5>
            <RelChips ids={ids} />
          </div>
        ))}
      </div>
      <div>
        {(view.revisions ?? []).length > 0 && (
          <div className={styles.relBlock}>
            <h5>{t('detailRevisions')}</h5>
            <ul className={styles.timeline}>
              {view.revisions!.map((rev, index) => (
                <li key={index}>
                  <time>{fmtTime(rev.supersededAt)}</time>
                  <b>{kindLabel(t, rev.kind)}</b>
                  {' '}{rev.content}
                </li>
              ))}
            </ul>
          </div>
        )}
        {operations.length > 0 && (
          <div className={styles.relBlock}>
            <h5>{t('detailOperations')}</h5>
            <ul className={styles.timeline}>
              {operations.map((op, index) => (
                <li key={index}>
                  <time>{fmtTime(op.at)}</time>
                  <b>{opLabel(t, op.op)}</b>
                  {formatOpDetail(t, op.op, op.detail)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}

/** 行内编辑表单：内容/种类/重要性 → POST update（旧条目归档，取代链保留）。 */
function EditForm({ t, record, onClose, onSaved, toast }: {
  t: T
  record: MemoryRow
  onClose: () => void
  onSaved: () => void
  toast: ToastController
}): React.ReactElement {
  const [content, setContent] = useState(record.content)
  const [kind, setKind] = useState(record.kind)
  const [importance, setImportance] = useState(record.importance)
  const save = (): void => {
    api('update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: record.id, scope: record.scope, content, kind, importance }),
    })
      .then(onSaved)
      .catch((error: Error) => { toast.push('error', error.message) })
  }
  return (
    <div className={styles.editForm}>
      <div>
        <label className={styles.fieldLabel}>{t('labelContent')}</label>
        <textarea className={styles.input} rows={3} value={content} onChange={event => setContent(event.target.value)} />
      </div>
      <div>
        <label className={styles.fieldLabel}>{t('labelKind')}</label>
        {/* option 的 value 保持数据层英文枚举，仅显示文本本地化。 */}
        <select className={styles.input} value={kind} onChange={event => setKind(event.target.value)}>
          {KINDS.map(option => <option key={option} value={option}>{kindLabel(t, option)}</option>)}
        </select>
      </div>
      <div className={styles.fieldRow}>
        <div>
          <label className={styles.fieldLabel}>{`${t('importance')} ${importance.toFixed(2)}`}</label>
          <input type="range" min={0} max={1} step={0.05} value={importance}
            onChange={event => setImportance(Number(event.target.value))} />
        </div>
      </div>
      <div className={styles.modalFoot}>
        <button type="button" className={styles.button} onClick={onClose}>{t('cancel')}</button>
        <button type="button" className={`${styles.button} ${styles.primary}`} onClick={save}>{t('saveWithHint')}</button>
      </div>
    </div>
  )
}

/** search-test API 的命中行。 */
interface BenchHit {
  readonly id: string
  readonly score: number
  readonly via: 'fts' | 'vec' | 'both'
  readonly viaEdge?: { readonly from: string; readonly type: string }
  readonly scope: string
  readonly kind: string
  readonly content: string
}

/** search-test API 的返回结构。 */
interface BenchResult {
  readonly degraded: boolean
  readonly hits: readonly BenchHit[]
}

/** activity API 的行结构（两库 op_log 合并）。 */
interface ActivityRow {
  readonly at: number
  readonly op: string
  readonly targetId: string
  readonly detail: string | null
  readonly scope: 'user' | 'project'
}

/** 命中道 → 词典键。 */
const VIA_KEY: Record<BenchHit['via'], EngramKey> = { fts: 'viaFts', vec: 'viaVec', both: 'viaBoth' }

/** 召回测试台：输入查询跑真实检索，展示得分、命中原委（关键词/语义/边扩展）与内容。 */
function RecallBench({ t, scope }: { t: T; scope: 'user' | 'project' | 'shared' }): React.ReactElement {
  const [query, setQuery] = useState('')
  /** 默认随观察 scope，但用户可在 select 内手动切换 'all' / 其它；切换观察 scope 时重置。 */
  const [benchScope, setBenchScope] = useState<string>(scope)
  const [result, setResult] = useState<BenchResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 观察 scope 变化时同步 benchScope（用户在 select 里改过的「all」会被覆盖——刻意保持一致性）。
  useEffect(() => { setBenchScope(scope) }, [scope])
  const run = (): void => {
    if (query.trim() === '' || busy) return
    setBusy(true)
    api<BenchResult>(`search-test?q=${encodeURIComponent(query.trim())}&scope=${benchScope}`)
      .then((data) => { setResult(data); setError(null) })
      .catch((benchError: Error) => setError(benchError.message))
      .finally(() => setBusy(false))
  }
  const hits = result?.hits ?? []
  return (
    <div>
      <div className={styles.benchBar}>
        <input className={`${styles.input} ${styles.search}`} placeholder={t('benchPlaceholder')} value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') run() }} />
        <select className={styles.input} value={benchScope}
          onChange={event => setBenchScope(event.target.value)}>
          <option value="all">{t('benchScopeAll')}</option>
          <option value="user">{t('scopeUser')}</option>
          <option value="project">{t('scopeProject')}</option>
          <option value="shared">{t('scopeShared')}</option>
        </select>
        <button type="button" className={`${styles.button} ${styles.primary}`}
          disabled={busy || query.trim() === ''} onClick={run}>{t('benchRun')}</button>
      </div>
      {error !== null && <div className={styles.expandLoading}>{t('loadFailed', { msg: error })}</div>}
      {result !== null && error === null && (
        <div className={styles.benchMeta}>
          <span>{t('benchHits', { n: hits.length })}</span>
          {result.degraded && <span className={styles.degradedNote}>{t('benchDegraded')}</span>}
        </div>
      )}
      <div className={styles.benchList}>
      {hits.map(hit => (
        <div key={hit.id} className={styles.benchRow}>
          <div className={styles.benchHead}>
            <span className={styles.viaChip}>{t(VIA_KEY[hit.via])}</span>
            {hit.viaEdge !== undefined && (
              <span className={styles.viaChip}
                title={`${hit.viaEdge.type} ${hit.viaEdge.from}`}>{t('viaEdgeLabel')} · {hit.viaEdge.type}</span>
            )}
            <span className={`${styles.pill} ${styles.kind}`}>{kindLabel(t, hit.kind)}</span>
            <span className={styles.benchScore}>{hit.score.toFixed(4)}</span>
          </div>
          <div className={styles.benchContent}>{hit.content}</div>
          <span className={styles.benchId} title={hit.id}>{hit.id}</span>
        </div>
      ))}
      </div>
      {result !== null && hits.length === 0 && error === null && (
        <div className={styles.benchEmpty}>{t('benchEmpty')}</div>
      )}
    </div>
  )
}

/** 活动日志 detail 的摘要：摄取/改写/压缩请求解析 JSON 字段，其余原样截断。
   窄侧栏下文本应尽量短，长详情交给 title 悬浮展示。 */
function activityDetail(t: T, detail: string | null): string {
  if (detail === null) return ''
  try {
    const parsed = JSON.parse(detail) as Record<string, unknown>
    if (typeof parsed.round === 'number' && typeof parsed.userText === 'string') {
      const mode = typeof parsed.mode === 'string' ? ` · ${parsed.mode}` : ''
      return `${t('round', { n: parsed.round })}${mode} · ${parsed.userText.slice(0, 48)}`
    }
    if (typeof parsed.query === 'string' && Array.isArray(parsed.queries)) {
      return `${t('benchRewrite', { n: parsed.queries.length })} · ${parsed.query.slice(0, 36)}`
    }
    if (typeof parsed.count === 'number' && Object.keys(parsed).length === 1) {
      return t('benchCompress', { n: parsed.count })
    }
  } catch {
    // 非 JSON（outcome 值等）：走末尾原样截断。
  }
  return detail.length > 56 ? `${detail.slice(0, 56)}…` : detail
}

/** 最近活动：两库 op_log 合并倒序，摄取/检索改写/压缩/蒸馏/条目操作全貌可见。 */
function ActivityFeed({ t }: { t: T }): React.ReactElement {
  const [rows, setRows] = useState<ActivityRow[] | null>(null)
  useEffect(() => {
    let cancelled = false
    api<{ operations: ActivityRow[] }>('activity?limit=20')
      .then((data) => { if (!cancelled) setRows(data.operations) })
      .catch(() => { if (!cancelled) setRows([]) })
    return () => { cancelled = true }
  }, [])
  if (rows === null) return <div className={styles.expandLoading}>{t('loading')}</div>
  if (rows.length === 0) return <div className={styles.expandLoading}>{t('activityEmpty')}</div>
  return (
    // activityList：管家日志限高 280px + 内部滚动，避免 20 条满载把观察页整列拉长。
    <ul className={`${styles.timeline} ${styles.activityList}`}>
      {rows.map((op, index) => (
        <li key={index}>
          <span className={styles.actTime}>{relTime(t, op.at)}</span>
          <b>{opLabel(t, op.op)}</b>
          <span className={styles.actScope}>{op.scope === 'user' ? t('scopeUser') : t('scopeProject')}</span>
          <div className={styles.actBody} title={op.detail ?? ''}>{activityDetail(t, op.detail)}</div>
        </li>
      ))}
    </ul>
  )
}

/** review-due API 的行结构（只给线索：坐标/门牌/逾期天数，不给正文——检索练习的刻意设计）。 */
interface ReviewDueItem {
  readonly id: string
  readonly kind: string
  readonly slot?: { readonly room: string; readonly index: number }
  readonly caption: string | null
  readonly nextReviewAt: number | null
  readonly overdueDays: number
  readonly reps: number
}

/** 今日待回忆：检索练习卡片。线索先行 → 揭示正文 → 三档自评（记得/模糊/忘了 → SM-2 grade 5/3/1）推进调度。
 *  onAnswered 供 Header 角标同步递减。 */
function ReviewQueueCard({ t, scope, toast, onAnswered }: {
  t: T
  scope: 'user' | 'project' | 'shared'
  toast: ToastController
  onAnswered: () => void
}): React.ReactElement {
  const [items, setItems] = useState<ReviewDueItem[] | null>(null)
  /** 已揭示的条目正文（id → content）。 */
  const [revealed, setRevealed] = useState<Readonly<Record<string, string>>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const reload = useCallback(() => {
    api<{ items: ReviewDueItem[] }>(`review-due?scope=${scope}`)
      .then(data => { setItems(data.items); setRevealed({}) })
      .catch((error: Error) => { toast.push('error', error.message); setItems([]) })
  }, [scope, toast])
  useEffect(() => { reload() }, [reload])
  /** 揭示：拉完整正文（复用 review 路由），用户核对回忆是否准确。 */
  const reveal = (id: string): void => {
    setBusyId(id)
    api<ReviewView>(`review?scope=${scope}&id=${encodeURIComponent(id)}`)
      .then(view => { setRevealed(current => ({ ...current, [id]: view.record.content })) })
      .catch((error: Error) => { toast.push('error', error.message) })
      .finally(() => { setBusyId(null) })
  }
  /** 自评：提交 grade 并把该条移出今日队列。 */
  const answer = (item: ReviewDueItem, grade: 1 | 3 | 5): void => {
    setBusyId(item.id)
    api<{ review: { nextReviewAt: number | null; intervalDays: number } | null }>('review-answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: item.id, scope, grade }),
    })
      .then(result => {
        setItems(current => current?.filter(row => row.id !== item.id) ?? null)
        const days = result.review?.intervalDays ?? 1
        toast.push('success', t('reviewScheduled', { n: days }))
        onAnswered()
      })
      .catch((error: Error) => { toast.push('error', error.message) })
      .finally(() => { setBusyId(null) })
  }
  if (items === null) return <div className={styles.expandLoading}>{t('loading')}</div>
  if (items.length === 0) return <div className={styles.expandLoading}>{t('reviewQueueEmpty')}</div>
  return (
    <ul className={styles.reviewQueue}>
      {items.map(item => (
        <li key={item.id} className={styles.reviewItem}>
          <div className={styles.reviewCue}>
            <span className={`${styles.pill} ${styles.kind}`}>{kindLabel(t, item.kind)}</span>
            {item.slot !== undefined && <span className={styles.reviewSlot}>{item.slot.room}#{item.slot.index}</span>}
            <span className={styles.reviewCaption}>{item.caption ?? t('reviewNoPlacard')}</span>
            <span className={styles.reviewOverdue}>
              {item.overdueDays > 0 ? t('reviewOverdue', { n: item.overdueDays }) : t('reviewDueToday')}
            </span>
          </div>
          {revealed[item.id] === undefined
            ? (
              <button type="button" className={styles.button} disabled={busyId === item.id}
                onClick={() => { reveal(item.id) }}>{t('reviewReveal')}</button>
            )
            : (
              <>
                <div className={styles.reviewContent}>{revealed[item.id]}</div>
                <div className={styles.reviewGrades}>
                  <button type="button" className={`${styles.button} ${styles.primary}`} disabled={busyId === item.id}
                    onClick={() => { answer(item, 5) }}>{t('reviewGradeRemember')}</button>
                  <button type="button" className={styles.button} disabled={busyId === item.id}
                    onClick={() => { answer(item, 3) }}>{t('reviewGradeVague')}</button>
                  <button type="button" className={styles.button} disabled={busyId === item.id}
                    onClick={() => { answer(item, 1) }}>{t('reviewGradeForgot')}</button>
                </div>
              </>
            )}
        </li>
      ))}
    </ul>
  )
}

/** 入殿导航：根据当前 scope 的 active 房间给出开场邀请 + 候选房间列表；点击可展开抽屉。
 *  顶部 kind chip（全部 / fact / preference / decision / episode / skill）切换 focusKind，
 *  触发后端按该 kind 优先选前 N 间作为开场建议。 */
function TourProposalCard({ t, scope, onSelect }: { t: T; scope: 'user' | 'project' | 'shared'; onSelect: (id: string) => void }): React.ReactElement {
  interface Stop { id: string; kind: string; content: string; importance: number; confidence: number }
  interface Proposal { greeting: string; activeCount: number; empty: boolean; suggestedStops: readonly Stop[] }
  const KINDS_FOCUS = ['', 'fact', 'preference', 'decision', 'episode', 'skill'] as const
  const [focusKind, setFocusKind] = usePersistedState<string>('tour.focusKind', '', KINDS_FOCUS)
  const [proposal, setProposal] = useState<Proposal | null>(null)
  useEffect(() => {
    let cancelled = false
    const path = focusKind === ''
      ? `tour-proposal?scope=${scope}`
      : `tour-proposal?scope=${scope}&focusKind=${focusKind}`
    api<Proposal>(path)
      .then((data) => { if (!cancelled) setProposal(data) })
      .catch(() => { if (!cancelled) setProposal({ greeting: t('tourProposalEmpty'), activeCount: 0, empty: true, suggestedStops: [] }) })
    return () => { cancelled = true }
  }, [t, scope, focusKind])
  const labelKind = (kind: string): string => {
    if (kind === '') return t('tourFocusAll')
    const key = KIND_KEY[kind]
    return key === undefined ? kind : t(key)
  }
  if (proposal === null) return <div className={styles.expandLoading}>{t('loading')}</div>
  return (
    <div className={styles.tourProposal}>
      <div className={styles.tourFocusRow} role="tablist" aria-label="focus-kind">
        {KINDS_FOCUS.map(kind => (
          <button key={kind || 'all'} type="button" role="tab"
            aria-selected={focusKind === kind}
            className={focusKind === kind ? `${styles.tourFocusChip} ${styles.tourFocusChipOn}` : styles.tourFocusChip}
            onClick={() => { setFocusKind(kind) }}>
            {labelKind(kind)}
          </button>
        ))}
      </div>
      {proposal.empty
        ? <div className={styles.expandLoading}>{t('tourProposalEmpty')}</div>
        : (
          <>
            <p className={styles.tourGreeting}>{proposal.greeting}</p>
            <ol className={styles.tourStops}>
              {proposal.suggestedStops.map((stop, index) => (
                <li key={stop.id}>
                  <button type="button" className={styles.tourStop} onClick={() => { onSelect(stop.id) }}>
                    <span className={styles.tourStopIndex}>{index + 1}</span>
                    <span className={styles.tourStopBody}>
                      <span className={styles.tourStopKind}>{stop.kind}</span>
                      <span className={styles.tourStopText}>{stop.content.length > 60 ? `${stop.content.slice(0, 60)}…` : stop.content}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
            <p className={styles.tourHint}>{t('tourProposalHint')}</p>
          </>
        )}
    </div>
  )
}

/** 翻新清单：扫描 active 条目，给出 merge / demote / review / split 四类建议；带手动刷新 + 写回按钮。
 *  - review / split：跳到对应房间抽屉查看（无副作用）。
 *  - demote：调用 engram_forget（带三问墓志铭），房间转 archived。
 *  - merge：触发当前 scope 的 engram_distill（用户级闭馆整理），把多间相似房间蒸馏为一条高层规律。 */
function RefurbCard({ t, scope, onSelect, onAfterAction, toast }: {
  t: T
  scope: 'user' | 'project' | 'shared'
  onSelect: (id: string) => void
  onAfterAction: () => void
  toast: ToastController
}): React.ReactElement {
  interface Suggestion { action: 'merge' | 'demote' | 'review' | 'split'; primaryId: string; candidates: readonly string[]; reason: string; confidence: number }
  interface RefurbReport { count: number; suggestions: readonly Suggestion[] }
  const [report, setReport] = useState<RefurbReport | null>(null)
  const [busy, setBusy] = useState(false)
  const reload = useCallback(() => {
    setBusy(true)
    api<RefurbReport>(`refurb?scope=${scope}`)
      .then((data) => { setReport(data) })
      .catch(() => { setReport({ count: 0, suggestions: [] }) })
      .finally(() => { setBusy(false) })
  }, [scope])
  useEffect(() => { reload() }, [reload])
  const labelOf = (action: Suggestion['action']): string => {
    switch (action) {
      case 'demote': return t('refurbActionDemote')
      case 'merge': return t('refurbActionMerge')
      case 'review': return t('refurbActionReview')
      case 'split': return t('refurbActionSplit')
    }
  }
  /** 执行建议：review/split 仅跳转；demote/merge 调写接口。 */
  const execute = useCallback((suggestion: Suggestion) => {
    if (suggestion.action === 'review' || suggestion.action === 'split') {
      onSelect(suggestion.primaryId)
      return
    }
    if (suggestion.action === 'demote') {
      if (!window.confirm(t('refurbConfirmDemote'))) return
      setBusy(true)
      api<{ id: string }>('forget', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: suggestion.primaryId,
          scope,
          reason: '翻新清单降级',
          affects: '无',
          stillUseful: '可经 engram_restore 复原',
        }),
      })
        .then(() => {
          reload()
          onAfterAction()
          toast.push('success', t('refurbDemoteDone'))
        })
        .catch((error: Error) => { toast.push('error', t('refurbActionFailed', { msg: error.message })) })
        .finally(() => { setBusy(false) })
      return
    }
    if (suggestion.action === 'merge') {
      const n = suggestion.candidates.length + 1
      if (n < 2) {
        toast.push('warning', t('refurbMergeEmpty'))
        return
      }
      if (!window.confirm(t('refurbConfirmMerge', { n }))) return
      setBusy(true)
      // 透传 candidates：后端 runConsolidation 仅把这些 ids 当合并种子，其它条目仅在与种子相似时被并入。
      const candidates = [suggestion.primaryId, ...suggestion.candidates]
      api<Record<string, unknown>>('consolidate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope, candidates }),
      })
        .then(() => {
          reload()
          onAfterAction()
          toast.push('success', t('refurbMergeDone'))
        })
        .catch((error: Error) => { toast.push('error', t('refurbActionFailed', { msg: error.message })) })
        .finally(() => { setBusy(false) })
    }
  }, [reload, onSelect, onAfterAction, toast, t, scope])
  if (report === null) return <div className={styles.expandLoading}>{t('loading')}</div>
  return (
    <div className={styles.refurb}>
      <div className={styles.refurbHead}>
        <span className={styles.refurbCount}>{t('refurbCount', { n: report.count })}</span>
        <button type="button" className={styles.button} disabled={busy} onClick={reload}>{t('refurbRun')}</button>
      </div>
      {report.count === 0
        ? <div className={styles.expandLoading}>{t('refurbEmpty')}</div>
        : (
          <ul className={styles.refurbList}>
            {report.suggestions.map((suggestion, index) => (
              <li key={`${suggestion.action}-${suggestion.primaryId}-${index}`} className={styles.refurbItem}>
                <button type="button" className={styles.refurbBadge} onClick={() => { onSelect(suggestion.primaryId) }}>
                  {labelOf(suggestion.action)}
                </button>
                <div className={styles.refurbReason}>{suggestion.reason}</div>
                <span className={styles.refurbConfidence}>{(suggestion.confidence * 100).toFixed(0)}%</span>
                <button type="button" className={`${styles.refurbExec} ${styles.button}`} disabled={busy}
                  onClick={() => { execute(suggestion) }}>{t('refurbExecute')}</button>
              </li>
            ))}
          </ul>
        )}
    </div>
  )
}

/** 走廊鸟瞰数据拉取与节点/边状态（命中 active + archived，forgotten 默认隐藏）。 */
interface CorridorGraph {
  readonly nodes: ReadonlyArray<{
    readonly id: string
    readonly scope: string
    readonly kind: string
    readonly status: string
    readonly importance: number
    readonly confidence: number
    readonly title: string
    readonly content?: string
  }>
  readonly edges: ReadonlyArray<{ readonly id: string; readonly from: string; readonly to: string; readonly type: string }>
}

function CorridorPanel({ t, scope, onSelect }: {
  t: T
  scope: 'user' | 'project' | 'shared'
  onSelect: (id: string) => void
}): React.ReactElement {
  const [graph, setGraph] = useState<CorridorGraph | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    api<CorridorGraph>(`corridor?status=active,archived&scope=${scope}`)
      .then(data => { if (!cancelled) setGraph(data); setFailed(null) })
      .catch((err: Error) => { if (!cancelled) setFailed(err.message) })
    return () => { cancelled = true }
  }, [scope])
  if (failed !== null) return <div className={styles.expandLoading}>{t('corridorFailed')}：{failed}</div>
  if (graph === null) return <div className={styles.expandLoading}>{t('corridorLoad')}</div>
  if (graph.nodes.length === 0) return <div className={styles.empty}>{t('corridorEmpty')}</div>
  return <CorridorMap scope={scope} nodes={graph.nodes} edges={graph.edges} onSelect={onSelect} />
}

/** 宫殿健康分卡：5 维 0-100 + 总分 + 每维度进度条。 */
interface HealthReport {
  readonly overall: number
  readonly parts: ReadonlyArray<{
    readonly scope: string
    readonly score: number
    readonly signal: number
    readonly activeRatio: number
    readonly edgeCount: number
    readonly redacted: number
    readonly archivedRatio: number
  }>
  readonly evaluatedAt: number
}

function HealthScoreCard({ t, scope }: { t: T; scope: 'user' | 'project' | 'shared' }): React.ReactElement {
  const [report, setReport] = useState<HealthReport | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    api<HealthReport>(`health?scope=${scope}`)
      .then(data => { if (!cancelled) setReport(data); setFailed(null) })
      .catch((err: Error) => { if (!cancelled) setFailed(err.message) })
    return () => { cancelled = true }
  }, [scope])
  if (failed !== null) return <div className={styles.expandLoading}>{t('healthFailed')}：{failed}</div>
  if (report === null) return <div className={styles.expandLoading}>{t('healthLoading')}</div>
  const tone = report.overall >= 80 ? 'good' : report.overall >= 50 ? 'mid' : 'low'
  return (
    <div className={styles.health}>
      <div className={`${styles.healthScore} ${tone === 'good' ? styles.healthScoreGood : tone === 'mid' ? styles.healthScoreMid : styles.healthScoreLow}`}>
        <b>{report.overall}</b>
        <span>/ 100</span>
      </div>
      <div className={styles.healthMetrics}>
        {report.parts.map(part => (
          <div key={part.scope} className={styles.healthMetric}>
            <div className={styles.healthMetricHead}>
              <span>{part.scope === 'user' ? t('scopeUser') : part.scope === 'project' ? t('scopeProject') : t('scopeShared')}</span>
              <b>{part.score}</b>
            </div>
            <div className={styles.healthMetricBar}>
              <i style={{ width: `${String(part.score)}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** 宫殿遥测：最近 7 天 op_log 聚合（写 / 摄取 / 整理 / 闭环等计数）。 */
interface TelemetrySnapshot {
  readonly windowDays: number
  readonly counts: {
    readonly writes: number
    readonly forgets: number
    readonly ingestRequests: number
    readonly ingestDones: number
    readonly distillRequests: number
    readonly consolidations: number
  }
}

/**
 * 管家日报整体条：tabs 上方常驻（原 KPI 条位置），scope 跟随 Header 全局三宫格。
 * 内容分两组横排：宫殿规模（房间 / 开放 / 闭馆 / 清晰度）+ 近 7 天活动五计数；
 * 数字与标签同行（baseline 对齐），标签 nowrap，杜绝窄卡换行。
 */
function TelemetryBar({ t, scope }: {
  t: T
  scope: 'user' | 'project' | 'shared'
}): React.ReactElement {
  const [snap, setSnap] = useState<TelemetrySnapshot | null>(null)
  const [stats, setStats] = useState<StatsPart['stats'] | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    // 宫殿规模（stats）+ 近 7 天活动（telemetry）一次并行拉齐。
    Promise.all([
      api<TelemetrySnapshot>(`telemetry?days=7&scope=${scope}`),
      api<{ parts: StatsPart[] }>('stats'),
    ])
      .then(([tele, statRes]) => {
        if (cancelled) return
        setSnap(tele)
        setStats(statRes.parts.find(part => part.scope === scope)?.stats ?? null)
        setFailed(null)
      })
      .catch((err: Error) => { if (!cancelled) setFailed(err.message) })
    return () => { cancelled = true }
  }, [scope])
  if (failed !== null) return <div className={styles.expandLoading}>{t('teleFailed')}：{failed}</div>
  if (snap === null) return <div className={styles.expandLoading}>{t('teleLoading')}</div>
  const items: Array<[string, number]> = [
    [t('teleWrites'), snap.counts.writes],
    [t('teleForgets'), snap.counts.forgets],
    [t('teleIngest'), snap.counts.ingestRequests],
    [t('teleDistill'), snap.counts.distillRequests],
    [t('teleConsolidate'), snap.counts.consolidations],
  ]
  return (
    <section className={styles.panelCard}>
      <div className={styles.panelCardTitle}>
        <h4>{t('teleTitle')}</h4>
        {/* 隐私元数据：叹号图标 + 短标签 + hover/聚焦弹出长说明，挂在卡片标题右侧。 */}
        <span className={styles.telePrivacy} role="note" aria-label={t('telePrivacyHint')} tabIndex={0}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.2"/>
            <line x1="7" y1="6" x2="7" y2="10.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
            <circle cx="7" cy="4.2" r="0.7" fill="currentColor"/>
          </svg>
          <span className={styles.telePrivacyHint}>{t('telePrivacyHint')}</span>
          <span className={styles.telePrivacyTip} role="tooltip">{t('telePrivacyTip')}</span>
        </span>
      </div>
      <div className={styles.teleBar}>
        {/* 左：规模 2×2；右：近 7 天 5 格。两区等高，组标题居左上小灰字。 */}
        <div className={styles.teleCol}>
          <span className={styles.teleColLabel}>{t('teleGroupScale')}</span>
          <div className={styles.teleGrid}>
            <div className={styles.teleStat}>
              <span>{t('kpiTotal')}</span>
              <b>{stats?.total ?? 0}</b>
            </div>
            <div className={styles.teleStat}>
              <span>{t('kpiActive')}</span>
              <b>{stats?.active ?? 0}</b>
            </div>
            <div className={styles.teleStat}>
              <span>{t('kpiForgotten')}</span>
              <b>{stats?.forgotten ?? 0}</b>
            </div>
            <div className={styles.teleStat} role="meter" aria-valuemin={0} aria-valuemax={100}
              aria-valuenow={Math.round((stats?.signalRatio ?? 0) * 100)} aria-label={t('kpiSignal')}>
              <span>{t('kpiSignal')}</span>
              <b>{`${String(Math.round((stats?.signalRatio ?? 0) * 100))}%`}</b>
            </div>
          </div>
        </div>
        <div className={styles.teleCol}>
          <span className={styles.teleColLabel}>{t('teleGroupRecent')}</span>
          <div className={`${styles.teleGrid} ${styles.teleGridRecent}`}>
            {items.map(([label, value]) => (
              <div key={label} className={styles.teleStat}>
                <span>{label}</span>
                <b>{value}</b>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

/** 导出下拉：把三种格式（Markdown / JSON / 镜像目录）合并成一个按钮 + 弹出列表。 */
function ExportMenu({ t, scope }: { t: T; scope: 'user' | 'project' | 'shared' }): React.ReactElement {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const handler = (event: MouseEvent): void => {
      if (wrapRef.current === null || !wrapRef.current.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', handler)
    return () => { window.removeEventListener('mousedown', handler) }
  }, [open])
  const options: Array<{ label: string; hint: string; href: string }> = [
    { label: t('exportMd'), hint: t('exportMdHint'), href: `/api/engram/export?scope=${scope}&format=markdown` },
    { label: t('exportJson'), hint: t('exportJsonHint'), href: `/api/engram/export?scope=${scope}&format=json` },
    { label: t('exportMirror'), hint: t('exportMirrorHint'), href: `/api/engram/mirror?scope=${scope}` },
  ]
  return (
    <div className={styles.exportWrap} ref={wrapRef}>
      <button type="button" className={styles.button} aria-haspopup="menu" aria-expanded={open}
        onClick={() => { setOpen(value => !value) }}>
        {t('export')}
        <span className={styles.exportCaret} aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className={styles.exportMenu} role="menu">
          {options.map(option => (
            <a key={option.href} role="menuitem" className={styles.exportItem} href={option.href}
              onClick={() => { setOpen(false) }}>
              <span className={styles.exportItemLabel}>{option.label}</span>
              <span className={styles.exportItemHint}>{option.hint}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  )
}

/** 设置页「记忆库」section 主组件（t 由渲染器按 locale: NS 声明合成）。 */
export function EngramSection({ t }: PropsLocale<typeof NS>): React.ReactElement {
  const toast = useToast()
  /** 全局 scope（持久化）：Header 三宫格是唯一切换器，驱动日报条、导览管家全部卡片、陈展列表与导出。 */
  const [scope, setScope] = usePersistedState<'user' | 'project' | 'shared'>('library.scope', 'user', ['user', 'project', 'shared'])
  /** 库顶 status / kind / q 过滤器（持久化）。 */
  const [status, setStatus] = usePersistedState<string>('library.status', 'all', ['all', 'active', 'archived', 'forgotten'])
  const [kind, setKind] = usePersistedState<string>('library.kind', 'all', ['all', 'fact', 'preference', 'decision', 'episode', 'skill'])
  const [q, setQ] = usePersistedString('library.q', '')
  /** 陈展列表排序（持久化）：time = 开馆时间倒序；tour = 固定巡游路线桩位顺序。 */
  const [sort, setSort] = usePersistedState<'time' | 'tour'>('library.sort', 'time', ['time', 'tour'])
  /** 今日待回忆条数（Header 角标）：与导览管家的待回忆卡同源。 */
  const [dueCount, setDueCount] = useState(0)
  /** 脱敏筛选已合并到顶部 KPI 与 tag 视觉，不再作为过滤器。 */
  const [redacted] = useState('all')
  const [offset, setOffset] = useState(0)
  const [list, setList] = useState<ListResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 行内展开态：互斥的唯一展开条目（review 或 edit）。 */
  const [expanded, setExpanded] = useState<{ kind: 'review' | 'edit'; record: MemoryRow } | null>(null)
  const [reloadTick, setReloadTick] = useState(0)
  /** 批量选择：条目 id 集合（scope/过滤/翻页/搜索变更时清空）。 */
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  /** 批量遗忘的两段式确认。 */
  const [confirmForget, setConfirmForget] = useState(false)
  /** Tab 视图：library 列表 / observability 召回与活动。 */
  const [activeTab, setActiveTab] = useState<'library' | 'observability'>('observability')

  const reload = useCallback((): void => { setReloadTick(tick => tick + 1) }, [])

  /** 刷新 Header 角标计数（本地回环毫秒级；失败静默归零，不打断面板）。 */
  const refreshDue = useCallback((): void => {
    api<{ items: unknown[] }>(`review-due?scope=${scope}&limit=50`)
      .then(data => { setDueCount(data.items.length) })
      .catch(() => { setDueCount(0) })
  }, [scope])
  useEffect(() => { refreshDue() }, [refreshDue])

  /** 角标点击：切到导览管家并滚到今日待回忆卡（待 tab 切换渲染完成后再滚）。 */
  const goToDue = (): void => {
    setActiveTab('observability')
    requestAnimationFrame(() => {
      document.getElementById('engram-review-due')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    })
  }

  useEffect(() => {
    let cancelled = false
    const qs = new URLSearchParams({
      scope, status, kind, redacted, limit: String(PAGE_SIZE), offset: String(offset),
    })
    if (q !== '') qs.set('q', q)
    if (sort === 'tour') qs.set('sort', 'tour')
    api<ListResult>(`list?${qs.toString()}`)
      .then((data) => { if (!cancelled) { setList(data); setError(null) } })
      .catch((loadError: Error) => { if (!cancelled) setError(loadError.message) })
    return () => { cancelled = true }
  }, [scope, status, kind, redacted, q, sort, offset, reloadTick])

  const act = (route: string, record: MemoryRow): void => {
    api(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: record.id, scope: record.scope }),
    })
      .then(reload)
      .catch((actError: Error) => { toast.push('error', actError.message) })
  }

  const toggle = (expandKind: 'review' | 'edit', record: MemoryRow): void => {
    setExpanded(current => (current !== null && current.kind === expandKind && current.record.id === record.id)
      ? null
      : { kind: expandKind, record })
  }

  const pageRecords = list?.records ?? []
  const selectedRecords = pageRecords.filter(record => selected.has(record.id))
  const forgetable = selectedRecords.filter(record => record.status === 'active').length
  const restorable = selectedRecords.length - forgetable
  const allSelected = pageRecords.length > 0 && pageRecords.every(record => selected.has(record.id))

  const toggleSelect = (id: string): void => {
    setSelected(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const clearSelection = (): void => { setSelected(new Set()); setConfirmForget(false) }

  const toggleAllPage = (): void => {
    setSelected(current => {
      const next = new Set(current)
      if (allSelected) pageRecords.forEach(record => next.delete(record.id))
      else pageRecords.forEach(record => next.add(record.id))
      return next
    })
  }

  /** 批量执行：逐条调单条 API（回环毫秒级），单条失败不阻塞其余；完成即刷新并清空选择。 */
  const runBatch = (mode: 'forget' | 'restore'): void => {
    const targets = mode === 'forget'
      ? selectedRecords.filter(record => record.status === 'active')
      : selectedRecords.filter(record => record.status !== 'active')
    if (targets.length === 0) return
    void Promise.allSettled(targets.map(target => api(mode, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: target.id, scope: target.scope }),
    }))).then(() => { clearSelection(); reload() })
  }

  const armBatchForget = (): void => {
    // 确认态保持到用户点击确认执行或清空选择，不做自动复位（3 秒窗口曾导致执行落空）。
    if (confirmForget) { runBatch('forget'); return }
    setConfirmForget(true)
  }

  const page = Math.floor(offset / PAGE_SIZE) + 1
  const pages = list === null ? 1 : Math.max(1, Math.ceil(list.total / PAGE_SIZE))
  /** Segmented Control 玻璃指示器位置：根据选中按钮 DOM 测量。 */
  const segRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map())
  const [segIndicator, setSegIndicator] = useState<{ left: number; width: number; opacity: number }>({ left: 0, width: 0, opacity: 0 })
  const measureSeg = useCallback((): void => {
    const node = segRefs.current.get(scope)
    if (node === null || node === undefined) return
    setSegIndicator({ left: node.offsetLeft, width: node.offsetWidth, opacity: 1 })
  }, [scope])
  useEffect(() => {
    measureSeg()
    const onResize = (): void => measureSeg()
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('resize', onResize) }
  }, [measureSeg])

  return (
    <div className={styles.panel}>
      {/* Header：宫殿 Logo + 标题 + 简介 + 右侧动作按钮组。 */}
      <div className={styles.header}>
        <div className={styles.headerBrand}>
          <span className={styles.headerLogo} aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 48 48" fill="none">
              <path d="M6 20 L24 7 L42 20 Z" fill="currentColor" fillOpacity="0.9"/>
              <rect x="9" y="20" width="30" height="18" rx="1.5" fill="none" stroke="currentColor" strokeWidth="2"/>
              <rect x="13" y="24" width="6" height="6" rx="1" fill="none" stroke="currentColor" strokeWidth="1.6"/>
              <line x1="16" y1="24" x2="16" y2="30" stroke="currentColor" strokeWidth="1.2"/>
              <line x1="13" y1="27" x2="19" y2="27" stroke="currentColor" strokeWidth="1.2"/>
              <path d="M21 38 L21 28 Q21 25 24 25 Q27 25 27 28 L27 38" fill="none" stroke="currentColor" strokeWidth="1.8"/>
              <rect x="29" y="24" width="6" height="6" rx="1" fill="none" stroke="currentColor" strokeWidth="1.6"/>
              <line x1="32" y1="24" x2="32" y2="30" stroke="currentColor" strokeWidth="1.2"/>
              <line x1="29" y1="27" x2="35" y2="27" stroke="currentColor" strokeWidth="1.2"/>
            </svg>
          </span>
          <div className={styles.headerTitle}>
            <h2>{t('headerTitle')}</h2>
            <p>{t('headerSubtitle')}</p>
          </div>
        </div>
        <div className={styles.headerActions}>
          <div className={`${styles.segGroup} ${styles.segScope}`}>
            <span className={styles.segIndicator}
              style={{ left: `${String(segIndicator.left)}px`, width: `${String(segIndicator.width)}px`, opacity: segIndicator.opacity }} />
            {(['user', 'project', 'shared'] as const).map(option => (
              <button key={option} type="button" ref={node => { segRefs.current.set(option, node) }}
                className={scope === option ? `${styles.segItem} ${styles.on}` : styles.segItem}
                onClick={() => { setScope(option); setOffset(0); setExpanded(null); clearSelection() }}>
                {t(SCOPE_KEY[option])}
              </button>
            ))}
          </div>
          {/* 今日待回忆角标：有待回忆时在 Header 一眼可见，点击直达导览管家的待回忆卡。 */}
          {dueCount > 0 && (
            <button type="button" className={styles.dueBadge}
              title={t('dueBadgeLabel', { n: dueCount })} aria-label={t('dueBadgeLabel', { n: dueCount })}
              onClick={goToDue}>
              <span className={styles.dueDot} aria-hidden="true" />
              {dueCount}
            </button>
          )}
          <button type="button" className={styles.button} onClick={() => { reload(); refreshDue() }}>{t('refresh')}</button>
          <ExportMenu t={t} scope={scope} />
        </div>
      </div>

      {/* 管家日报整体条（tabs 上方常驻）：宫殿规模 + 近 7 天活动；scope 跟随 Header 全局三宫格。 */}
      <TelemetryBar t={t} scope={scope} />

      {/* 顶部 Tab Bar：两个标签页（导览管家 / 宫殿陈展；按"管家先"语义排序）。 */}
      <div className={styles.tabs} role="tablist">
        <button type="button" role="tab"
          className={activeTab === 'observability' ? `${styles.tabItem} ${styles.on}` : styles.tabItem}
          aria-selected={activeTab === 'observability'}
          onClick={() => { setActiveTab('observability') }}>
          {t('tabObservability')}
        </button>
        <button type="button" role="tab"
          className={activeTab === 'library' ? `${styles.tabItem} ${styles.on}` : styles.tabItem}
          aria-selected={activeTab === 'library'}
          onClick={() => { setActiveTab('library') }}>
          {t('tabLibrary')}
          <small>{t('tabLibraryCount', { n: list?.total ?? 0 })}</small>
        </button>
      </div>

      {activeTab === 'library' && (
        <div className={styles.tabPanel}>
          <div className={styles.filters}>
            <div className={styles.segGroup}>
              {([
                ['all', t('allStatuses')],
                ['active', t('statusActive')],
                ['archived', t('statusArchived')],
                ['forgotten', t('statusForgotten')],
              ] as const).map(([value, label]) => (
                <button key={value} type="button"
                  className={status === value ? `${styles.segItem} ${styles.on}` : styles.segItem}
                  onClick={() => { setStatus(value); setOffset(0); setExpanded(null); clearSelection() }}>
                  {label}
                </button>
              ))}
            </div>
            <div className={styles.segGroup}>
              {([
                ['all', t('allKinds')],
                ...KINDS.map(option => [option, kindLabel(t, option)] as const),
              ] as const).map(([value, label]) => (
                <button key={value} type="button"
                  className={kind === value ? `${styles.segItem} ${styles.on}` : styles.segItem}
                  onClick={() => { setKind(value); setOffset(0); setExpanded(null); clearSelection() }}>
                  {label}
                </button>
              ))}
            </div>
            <div className={styles.segGroup}>
              {([['time', t('sortTime')], ['tour', t('sortTour')]] as const).map(([value, label]) => (
                <button key={value} type="button"
                  className={sort === value ? `${styles.segItem} ${styles.on}` : styles.segItem}
                  onClick={() => { setSort(value); setOffset(0); setExpanded(null); clearSelection() }}>
                  {label}
                </button>
              ))}
            </div>
            <input className={`${styles.input} ${styles.search}`} placeholder={t('searchPlaceholder')} value={q}
              onChange={event => { setQ(event.target.value.trim()); setOffset(0); setExpanded(null); clearSelection() }} />
          </div>

          {selected.size > 0 && (
            <div className={styles.batchBar}>
              <span>{t('selectedCount', { n: selected.size })}</span>
              <button type="button" className={styles.button} onClick={toggleAllPage}>
                {allSelected ? t('deselectAll') : t('selectAll')}
              </button>
              <button type="button" className={styles.button} disabled={restorable === 0}
                onClick={() => runBatch('restore')}>{t('batchRestore', { n: restorable })}</button>
              <button type="button"
                className={confirmForget ? `${styles.button} ${styles.danger}` : styles.button}
                disabled={forgetable === 0}
                onClick={armBatchForget}>
                {confirmForget ? t('batchForgetConfirm', { n: forgetable }) : t('batchForget', { n: forgetable })}
              </button>
              <button type="button" className={styles.button} onClick={clearSelection}>{t('clearSelection')}</button>
            </div>
          )}

          {error !== null && (
            <div className={styles.empty}>
              <b>{t('loadFailed', { msg: error })}</b>
              <span>{t('emptyHint')}</span>
            </div>
          )}
          {error === null && list === null && (
            <div className={styles.skeletonList}>
              {[0, 1, 2, 3].map(index => (
                <div key={index} className={styles.skeleton} style={{ animationDelay: `${String(index * 60)}ms` }}><i /><i /><i /></div>
              ))}
            </div>
          )}
          {error === null && list !== null && list.records.length === 0 && (
            <div className={styles.empty}>
              <b>{t('empty')}</b>
              <span>{t('emptyHint')}</span>
            </div>
          )}

          {(list?.records ?? []).length > 0 && (
            <div className={styles.itemList}>
              {(list?.records ?? []).map((record, index) => (
                <div key={record.id}
                  className={selected.has(record.id) ? `${styles.item} ${styles.selected}` : styles.item}
                  style={{ animationDelay: `${String(Math.min(index, 12) * 36)}ms` }}>
                  <input type="checkbox" className={styles.itemCheck} checked={selected.has(record.id)}
                    aria-label={record.content.slice(0, 24)} onChange={() => toggleSelect(record.id)} />
                  <div className={styles.itemBody}>
                    <div className={styles.itemTags}>
                      <span className={`${styles.pill} ${styles[`status${record.status.charAt(0).toUpperCase()}${record.status.slice(1)}`] ?? ''}`}>{t(STATUS_KEY[record.status])}</span>
                      <span className={`${styles.pill} ${styles.kind}`}>{kindLabel(t, record.kind)}</span>
                      {record.slot !== undefined && (
                        <span className={styles.pill}>{record.slot.room}#{record.slot.index}</span>
                      )}
                      {record.content.includes('[REDACTED:') && (
                        <span className={`${styles.pill} ${styles.redacted}`}>{t('tagRedacted')}</span>
                      )}
                      {record.outcome !== undefined && (
                        <span className={`${styles.pill} ${record.outcome === 'success' ? styles.outcomeSuccess : styles.outcomeFailure}`}>
                          {record.outcome === 'success' ? t('tagOutcomeSuccess') : t('tagOutcomeFailure')}
                        </span>
                      )}
                      <span className={styles.pill} title={fmtTime(record.createdAt)} style={{ marginLeft: 'auto' }}>
                        {t(SCOPE_KEY[record.scope])} · {relTime(t, record.createdAt)}
                      </span>
                    </div>
                    <div className={styles.content}>{record.content}</div>
                    <div className={styles.itemMeta}>
                      <span><b>{t('importance')}</b> {record.importance.toFixed(2)}</span>
                      <span><b>{t('confidence')}</b> {record.confidence.toFixed(2)}</span>
                      <span>{t('accessCount', { n: record.accessCount })}</span>
                      <span>{sourceLabel(t, record)}</span>
                    </div>
                  </div>
                  <div className={styles.itemOps}>
                    <button type="button" className={styles.button}
                      onClick={() => { toggle('review', record) }}>{t('detail')}</button>
                    <button type="button" className={styles.button}
                      onClick={() => { toggle('edit', record) }}>{t('edit')}</button>
                    {record.status === 'active'
                      ? <button type="button" className={styles.button}
                          onClick={() => { act('forget', record) }}>{t('forget')}</button>
                      : <button type="button" className={styles.button}
                          onClick={() => { act('restore', record) }}>{t('restore')}</button>}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className={styles.pager}>
            <button type="button" className={styles.button} disabled={offset === 0} aria-label={t('prevPage')}
              onClick={() => { setOffset(Math.max(0, offset - PAGE_SIZE)); setExpanded(null); clearSelection() }}>‹</button>
            <span>{t('pagerInfo', { page, pages, total: list?.total ?? 0 })}</span>
            <button type="button" className={styles.button} disabled={list === null || offset + PAGE_SIZE >= list.total}
              aria-label={t('nextPage')}
              onClick={() => { setOffset(offset + PAGE_SIZE); setExpanded(null); clearSelection() }}>›</button>
          </div>
        </div>
      )}

      {activeTab === 'observability' && (
        <div className={styles.tabPanel}>
          <div className={styles.layout}>
            <div className={styles.mainCol}>
              <section className={styles.panelCard}>
                <h4 className={styles.panelCardTitle}>{t('healthTitle')}</h4>
                <HealthScoreCard t={t} scope={scope} />
              </section>
              <section className={styles.panelCard}>
                <h4 className={styles.panelCardTitle}>{t('sectionCorridor')}</h4>
                <CorridorPanel t={t} scope={scope} onSelect={(id) => { setExpanded({ kind: 'review', record: list?.records.find(record => record.id === id) ?? ({ id: id as never, scope, kind: 'fact', content: '', importance: 0.5, confidence: 0.5, status: 'active', createdAt: Date.now(), accessCount: 0, sourceSessionId: null, sourceRound: null } as MemoryRow) }) }} />
              </section>
              <section className={styles.panelCard}>
                <h4 className={styles.panelCardTitle}>{t('refurbTitle')}</h4>
                {/* 翻新与走廊同列：动作类信息聚簇（左 = 宫殿全局 + 整改 + 试走，试走放在最后）。 */}
                <RefurbCard t={t} scope={scope} onSelect={(id) => { setExpanded({ kind: 'review', record: list?.records.find(record => record.id === id) ?? ({ id: id as never, scope, kind: 'fact', content: '', importance: 0.5, confidence: 0.5, status: 'active', createdAt: Date.now(), accessCount: 0, sourceSessionId: null, sourceRound: null } as MemoryRow) }) }} onAfterAction={reload} toast={toast} />
              </section>
              <section className={styles.panelCard}>
                <h4 className={styles.panelCardTitle}>{t('sectionBench')}</h4>
                <RecallBench t={t} scope={scope} />
              </section>
            </div>
            <aside className={styles.sideCol}>
              <section className={styles.panelCard} id="engram-review-due">
                <h4 className={styles.panelCardTitle}>{t('reviewQueueTitle')}</h4>
                <ReviewQueueCard t={t} scope={scope} toast={toast} onAnswered={refreshDue} />
              </section>
              <section className={styles.panelCard}>
                <h4 className={styles.panelCardTitle}>{t('tourProposalTitle')}</h4>
                <TourProposalCard t={t} scope={scope} onSelect={(id) => { setExpanded({ kind: 'review', record: list?.records.find(record => record.id === id) ?? ({ id: id as never, scope, kind: 'fact', content: '', importance: 0.5, confidence: 0.5, status: 'active', createdAt: Date.now(), accessCount: 0, sourceSessionId: null, sourceRound: null } as MemoryRow) }) }} />
              </section>
              <section className={styles.panelCard}>
                <h4 className={styles.panelCardTitle}>{t('sectionActivity')}</h4>
                <ActivityFeed t={t} />
              </section>
            </aside>
          </div>
        </div>
      )}

      {/* Drawer：行内展开升级为右滑入聚焦态，避免列表被展开压塌。 */}
      {expanded !== null && (
        <>
          <div className={styles.drawerScrim} onClick={() => { setExpanded(null) }} />
          <aside className={styles.drawer} role="dialog" aria-label={t('drawerTitle')}>
            <header className={styles.drawerHead}>
              <div className={styles.drawerTitle}>
                <h3>{t('drawerTitle')}</h3>
                <span title={expanded.record.id}>
                  {`#${expanded.record.id.slice(0, 8)}…`}
                </span>
              </div>
              <button type="button" className={styles.drawerClose} aria-label={t('drawerClose')}
                onClick={() => { setExpanded(null) }}>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <path d="M2 2 L12 12 M12 2 L2 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
                </svg>
              </button>
            </header>
            <div className={styles.drawerBody}>
              {expanded.kind === 'review'
                ? <ReviewBody t={t} recordId={expanded.record.id} scope={expanded.record.scope} />
                : <EditForm t={t} record={expanded.record} onClose={() => { setExpanded(null) }}
                    onSaved={() => { setExpanded(null); reload() }} toast={toast} />}
            </div>
          </aside>
        </>
      )}
      {/* Toast 叠层（右上角，position:fixed 脱离 panel 容器）。 */}
      {toast.viewport}
    </div>
  )
}
