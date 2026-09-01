/**
 * 记忆库设置面板：统计卡片、过滤列表、编辑（取代链）、遗忘/恢复、导出。
 * 数据经回环 API（/api/engram/*）读写；详情与编辑为条目下方行内展开
 * （不嵌套弹窗）；文案全部走宿主 locale 词典（zh/en），语言切换自动
 * 重渲染；数据层英文枚举（status/kind/op）只在显示层映射；内容节点
 * 一律 DOM/JSX 构建（防 XSS）。
 * @module @kenz1117/dsh-engram/client/EngramPanel
 */

import { useCallback, useEffect, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import styles from './panel.module.css'
import { NS, type EngramKey } from './locales.ts'

/** 列表/详情用的记忆视图（宿主 /api/engram/list 的行结构）。 */
interface MemoryRow {
  readonly id: string
  readonly scope: 'user' | 'project'
  readonly kind: string
  readonly content: string
  readonly importance: number
  readonly confidence: number
  readonly status: 'active' | 'archived' | 'forgotten'
  readonly createdAt: number
  readonly accessCount: number
  readonly sourceSessionId: string | null
  readonly sourceRound: number | null
}

interface ListResult {
  readonly records: MemoryRow[]
  readonly total: number
}

interface StatsPart {
  readonly scope: 'user' | 'project'
  readonly stats: {
    readonly total: number
    readonly active: number
    readonly archived: number
    readonly forgotten: number
    readonly signalRatio: number
  }
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
}
const OP_KEY: Record<string, EngramKey> = {
  write: 'opWrite',
  update: 'opUpdate',
  forget: 'opForget',
  restore: 'opRestore',
  decay: 'opDecay',
  'ingest-request': 'opIngestRequest',
  'distill-request': 'opDistillRequest',
}
const REL_KEY: Record<string, EngramKey> = {
  supersededBy: 'relSupersededBy',
  supersedes: 'relSupersedes',
  contradicts: 'relContradicts',
  related: 'relRelated',
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

function fmtTime(ms: number): string {
  // 时间格式跟随浏览器环境语言（宿主界面语言通常与浏览器一致）。
  return new Date(ms).toLocaleString(navigator.language || 'zh-CN', { hour12: false })
}

/** 行内审计区：来源链、关系与最近操作日志（review API）。 */
function ReviewBody({ t, recordId, scope }: {
  t: T
  recordId: string
  scope: 'user' | 'project'
}): React.ReactElement {
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    api<Record<string, unknown>>(`review?scope=${scope}&id=${encodeURIComponent(recordId)}`)
      .then((view) => {
        if (cancelled) return
        const record = view.record as MemoryRow
        const lines = [
          `${t('labelContent')}: ${record.content}`,
          `${t('detailAttributes')}: ${t('labelKind')}=${kindLabel(t, record.kind)}, ${t('labelStatus')}=${t(STATUS_KEY[record.status])}, ${t('importance')}=${record.importance.toFixed(2)}, ${t('confidence')}=${record.confidence.toFixed(2)}, ${t('accessCount', { n: record.accessCount })}`,
          `${t('detailSource')}: ${sourceLabel(t, record)}`,
        ]
        for (const key of ['supersededBy', 'supersedes', 'contradicts', 'related'] as const) {
          const ids = view[key] as string[] | undefined
          const relKey = REL_KEY[key]
          if (ids !== undefined && ids.length > 0) lines.push(`${relKey === undefined ? key : t(relKey)}: ${ids.join(', ')}`)
        }
        const operations = view.operations as { at: number; op: string; detail: string | null }[] | undefined
        if (operations !== undefined && operations.length > 0) {
          lines.push(`${t('detailOperations')}:`)
          operations.forEach(op => lines.push(`  ${fmtTime(op.at)} ${opLabel(t, op.op)}${op.detail ? ` ${op.detail}` : ''}`))
        }
        setText(lines.join('\n'))
      })
      .catch((error: Error) => { if (!cancelled) setText(t('loadFailed', { msg: error.message })) })
    return () => { cancelled = true }
  }, [recordId, scope, t])
  if (text === null) return <div className={styles.expandLoading}>{t('loading')}</div>
  return <pre className={styles.review}>{text}</pre>
}

/** 行内编辑表单：内容/种类/重要性 → POST update（旧条目归档，取代链保留）。 */
function EditForm({ t, record, onClose, onSaved }: {
  t: T
  record: MemoryRow
  onClose: () => void
  onSaved: () => void
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
      .catch((error: Error) => { alert(error.message) })
  }
  return (
    <div className={styles.editForm}>
      <label className={styles.fieldLabel}>{t('labelContent')}</label>
      <textarea className={styles.input} rows={3} value={content} onChange={event => setContent(event.target.value)} />
      <label className={styles.fieldLabel}>{t('labelKind')}</label>
      {/* option 的 value 保持数据层英文枚举，仅显示文本本地化。 */}
      <select className={styles.input} value={kind} onChange={event => setKind(event.target.value)}>
        {KINDS.map(option => <option key={option} value={option}>{kindLabel(t, option)}</option>)}
      </select>
      <label className={styles.fieldLabel}>{`${t('importance')} ${importance.toFixed(2)}`}</label>
      <input type="range" min={0} max={1} step={0.05} value={importance}
        onChange={event => setImportance(Number(event.target.value))} />
      <div className={styles.modalFoot}>
        <button type="button" className={styles.button} onClick={onClose}>{t('cancel')}</button>
        <button type="button" className={`${styles.button} ${styles.primary}`} onClick={save}>{t('saveWithHint')}</button>
      </div>
    </div>
  )
}

/** 设置页「记忆库」section 主组件（t 由渲染器按 locale: NS 声明合成）。 */
export function EngramSection({ t }: PropsLocale<typeof NS>): React.ReactElement {
  const [scope, setScope] = useState<'user' | 'project'>('user')
  const [status, setStatus] = useState('all')
  const [kind, setKind] = useState('all')
  const [q, setQ] = useState('')
  const [offset, setOffset] = useState(0)
  const [list, setList] = useState<ListResult | null>(null)
  const [stats, setStats] = useState<StatsPart[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 行内展开态：互斥的唯一展开条目（review 或 edit）。 */
  const [expanded, setExpanded] = useState<{ kind: 'review' | 'edit'; record: MemoryRow } | null>(null)
  const [reloadTick, setReloadTick] = useState(0)

  const reload = useCallback((): void => { setReloadTick(tick => tick + 1) }, [])

  useEffect(() => {
    let cancelled = false
    const qs = new URLSearchParams({
      scope, status, kind, limit: String(PAGE_SIZE), offset: String(offset),
    })
    if (q !== '') qs.set('q', q)
    api<ListResult>(`list?${qs.toString()}`)
      .then((data) => { if (!cancelled) { setList(data); setError(null) } })
      .catch((loadError: Error) => { if (!cancelled) setError(loadError.message) })
    api<{ parts: StatsPart[] }>('stats')
      .then((data) => { if (!cancelled) setStats(data.parts) })
      .catch(() => { /* 统计失败不影响列表 */ })
    return () => { cancelled = true }
  }, [scope, status, kind, q, offset, reloadTick])

  const act = (route: string, record: MemoryRow): void => {
    api(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: record.id, scope: record.scope }),
    })
      .then(reload)
      .catch((actError: Error) => { alert(actError.message) })
  }

  const toggle = (expandKind: 'review' | 'edit', record: MemoryRow): void => {
    setExpanded(current => (current !== null && current.kind === expandKind && current.record.id === record.id)
      ? null
      : { kind: expandKind, record })
  }

  const page = Math.floor(offset / PAGE_SIZE) + 1
  const pages = list === null ? 1 : Math.max(1, Math.ceil(list.total / PAGE_SIZE))

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <div className={styles.scopeTabs}>
          {(['user', 'project'] as const).map(option => (
            <button key={option} type="button"
              className={scope === option ? styles.scopeOn : styles.scopeOff}
              onClick={() => { setScope(option); setOffset(0); setExpanded(null) }}>
              {t(SCOPE_KEY[option])}
            </button>
          ))}
        </div>
        <button type="button" className={styles.button} onClick={reload}>{t('refresh')}</button>
        <button type="button" className={styles.button}
          onClick={() => { location.href = `/api/engram/export?scope=${scope}&format=markdown` }}>{t('exportMd')}</button>
        <button type="button" className={styles.button}
          onClick={() => { location.href = `/api/engram/export?scope=${scope}&format=json` }}>{t('exportJson')}</button>
      </div>
      <div className={styles.cards}>
        {(stats ?? []).map(part => (
          <button key={part.scope} type="button" className={styles.card}
            style={part.scope === scope ? { borderColor: 'var(--dsw-alias-brand-primary)' } : undefined}
            onClick={() => { setScope(part.scope); setOffset(0) }}>
            <b>{part.stats.total}</b>
            <span>{`${t(SCOPE_KEY[part.scope])} · ${t('cardActive', { n: part.stats.active })} · ${t('signalRatio', { n: Math.round(part.stats.signalRatio * 100) })}`}</span>
          </button>
        ))}
      </div>
      <div className={styles.filters}>
        <select className={styles.input} value={status}
          onChange={event => { setStatus(event.target.value); setOffset(0); setExpanded(null) }}>
          <option value="all">{t('allStatuses')}</option>
          <option value="active">{t('statusActive')}</option>
          <option value="archived">{t('statusArchived')}</option>
          <option value="forgotten">{t('statusForgotten')}</option>
        </select>
        <select className={styles.input} value={kind}
          onChange={event => { setKind(event.target.value); setOffset(0); setExpanded(null) }}>
          <option value="all">{t('allKinds')}</option>
          {KINDS.map(option => <option key={option} value={option}>{kindLabel(t, option)}</option>)}
        </select>
        <input className={styles.input} placeholder={t('searchPlaceholder')} value={q}
          onChange={event => { setQ(event.target.value.trim()); setOffset(0); setExpanded(null) }} />
      </div>
      {error !== null && <div className={styles.empty}>{t('loadFailed', { msg: error })}</div>}
      {error === null && list !== null && list.records.length === 0 && (
        <div className={styles.empty}>{t('empty')}</div>
      )}
      {(list?.records ?? []).map(record => (
        <div key={record.id} className={styles.item}>
          <div className={styles.row1}>
            <span className={`${styles.badge} ${styles[record.status]}`}>{t(STATUS_KEY[record.status])}</span>
            <span className={styles.badge}>{kindLabel(t, record.kind)}</span>
            <span className={styles.badge}>{t(SCOPE_KEY[record.scope])}</span>
          </div>
          <div className={styles.content}>{record.content}</div>
          <div className={styles.meta}>
            <span>{`${t('importance')} ${record.importance.toFixed(2)}`}</span>
            <span>{`${t('confidence')} ${record.confidence.toFixed(2)}`}</span>
            <span>{t('accessCount', { n: record.accessCount })}</span>
            <span>{sourceLabel(t, record)}</span>
            <span>{fmtTime(record.createdAt)}</span>
          </div>
          <div className={styles.ops}>
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
          {expanded !== null && expanded.record.id === record.id && (
            <div className={styles.expand}>
              {expanded.kind === 'review'
                ? <ReviewBody t={t} recordId={record.id} scope={record.scope} />
                : <EditForm t={t} record={record} onClose={() => { setExpanded(null) }}
                    onSaved={() => { setExpanded(null); reload() }} />}
            </div>
          )}
        </div>
      ))}
      <div className={styles.pager}>
        <button type="button" className={styles.button} disabled={offset === 0}
          onClick={() => { setOffset(Math.max(0, offset - PAGE_SIZE)) }}>{t('prevPage')}</button>
        <span>{t('pagerInfo', { page, pages, total: list?.total ?? 0 })}</span>
        <button type="button" className={styles.button}
          disabled={list === null || offset + PAGE_SIZE >= list.total}
          onClick={() => { setOffset(offset + PAGE_SIZE) }}>{t('nextPage')}</button>
      </div>
    </div>
  )
}
