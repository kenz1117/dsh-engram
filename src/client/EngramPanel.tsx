/**
 * 记忆库设置面板：统计卡片、过滤列表、编辑（取代链）、遗忘/恢复、导出。
 * 数据经回环 API（/api/engram/*）读写；内容节点一律 DOM API 构建（防 XSS）。
 * @module @kenz1117/dsh-engram/client/EngramPanel
 */

import { useCallback, useEffect, useState } from 'react'
import styles from './panel.module.css'

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

const KINDS = ['fact', 'preference', 'decision', 'episode', 'skill'] as const
const PAGE_SIZE = 20

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/engram/${path}`, init)
  const body = (await response.json()) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${String(response.status)}`)
  return body
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}

/** 审计弹层视图。 */
function ReviewBody({ recordId, scope }: { recordId: string; scope: 'user' | 'project' }): React.ReactElement | null {
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    api<Record<string, unknown>>(`review?scope=${scope}&id=${encodeURIComponent(recordId)}`)
      .then((view) => {
        if (cancelled) return
        const record = view.record as MemoryRow
        const lines = [
          `内容: ${record.content}`,
          `属性: kind=${record.kind}, status=${record.status}, importance=${record.importance}, confidence=${record.confidence}, 访问 ${record.accessCount} 次`,
          `来源: ${record.sourceSessionId ?? '显式保存'}${record.sourceRound === null ? '' : ` 第${String(record.sourceRound)}轮`}`,
        ]
        for (const key of ['supersededBy', 'supersedes', 'contradicts', 'related'] as const) {
          const ids = view[key] as string[] | undefined
          if (ids !== undefined && ids.length > 0) lines.push(`${key}: ${ids.join(', ')}`)
        }
        const operations = view.operations as { at: number; op: string; detail: string | null }[] | undefined
        if (operations !== undefined && operations.length > 0) {
          lines.push('最近操作:')
          operations.forEach(op => lines.push(`  ${fmtTime(op.at)} ${op.op}${op.detail ? ` ${op.detail}` : ''}`))
        }
        setText(lines.join('\n'))
      })
      .catch((error: Error) => { if (!cancelled) setText(`加载失败：${error.message}`) })
    return () => { cancelled = true }
  }, [recordId, scope])
  if (text === null) return null
  return <pre className={styles.review}>{text}</pre>
}

/** 编辑弹层：内容/种类/重要性 → POST update（旧条目归档，取代链保留）。 */
function EditDialog({ record, onClose, onSaved }: {
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
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.dialog} onClick={event => event.stopPropagation()}>
        <h3>编辑记忆（写入取代链）</h3>
        <label className={styles.fieldLabel}>内容</label>
        <textarea className={styles.input} rows={3} value={content} onChange={event => setContent(event.target.value)} />
        <label className={styles.fieldLabel}>种类</label>
        <select className={styles.input} value={kind} onChange={event => setKind(event.target.value)}>
          {KINDS.map(option => <option key={option} value={option}>{option}</option>)}
        </select>
        <label className={styles.fieldLabel}>重要性 {importance.toFixed(2)}</label>
        <input type="range" min={0} max={1} step={0.05} value={importance}
          onChange={event => setImportance(Number(event.target.value))} />
        <div className={styles.modalFoot}>
          <button type="button" className={styles.button} onClick={onClose}>取消</button>
          <button type="button" className={`${styles.button} ${styles.primary}`} onClick={save}>保存（旧条目归档）</button>
        </div>
      </div>
    </div>
  )
}

/** 设置页「记忆库」section 主组件。 */
export function EngramSection(): React.ReactElement {
  const [scope, setScope] = useState<'user' | 'project'>('user')
  const [status, setStatus] = useState('all')
  const [kind, setKind] = useState('all')
  const [q, setQ] = useState('')
  const [offset, setOffset] = useState(0)
  const [list, setList] = useState<ListResult | null>(null)
  const [stats, setStats] = useState<StatsPart[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<MemoryRow | null>(null)
  const [reviewId, setReviewId] = useState<MemoryRow | null>(null)
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

  const page = Math.floor(offset / PAGE_SIZE) + 1
  const pages = list === null ? 1 : Math.max(1, Math.ceil(list.total / PAGE_SIZE))

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <div className={styles.scopeTabs}>
          {(['user', 'project'] as const).map(option => (
            <button key={option} type="button"
              className={scope === option ? styles.scopeOn : styles.scopeOff}
              onClick={() => { setScope(option); setOffset(0) }}>
              {option === 'user' ? '用户级' : '项目级'}
            </button>
          ))}
        </div>
        <button type="button" className={styles.button} onClick={reload}>刷新</button>
        <button type="button" className={styles.button}
          onClick={() => { location.href = `/api/engram/export?scope=${scope}&format=markdown` }}>导出 MD</button>
        <button type="button" className={styles.button}
          onClick={() => { location.href = `/api/engram/export?scope=${scope}&format=json` }}>导出 JSON</button>
      </div>
      <div className={styles.cards}>
        {(stats ?? []).map(part => (
          <button key={part.scope} type="button" className={styles.card}
            style={part.scope === scope ? { borderColor: 'var(--dsw-alias-brand-primary)' } : undefined}
            onClick={() => { setScope(part.scope); setOffset(0) }}>
            <b>{part.stats.total}</b>
            <span>{part.scope} · active {part.stats.active} · 信噪比 {Math.round(part.stats.signalRatio * 100)}%</span>
          </button>
        ))}
      </div>
      <div className={styles.filters}>
        <select className={styles.input} value={status}
          onChange={event => { setStatus(event.target.value); setOffset(0) }}>
          <option value="all">全部状态</option>
          <option value="active">active</option>
          <option value="archived">archived</option>
          <option value="forgotten">forgotten</option>
        </select>
        <select className={styles.input} value={kind}
          onChange={event => { setKind(event.target.value); setOffset(0) }}>
          <option value="all">全部种类</option>
          {KINDS.map(option => <option key={option} value={option}>{option}</option>)}
        </select>
        <input className={styles.input} placeholder="按内容搜索…" value={q}
          onChange={event => { setQ(event.target.value.trim()); setOffset(0) }} />
      </div>
      {error !== null && <div className={styles.empty}>{`加载失败：${error}`}</div>}
      {error === null && list !== null && list.records.length === 0 && (
        <div className={styles.empty}>没有符合条件的记忆</div>
      )}
      {(list?.records ?? []).map(record => (
        <div key={record.id} className={styles.item}>
          <div className={styles.row1}>
            <span className={`${styles.badge} ${styles[record.status]}`}>{record.status}</span>
            <span className={styles.badge}>{record.kind}</span>
            <span className={styles.badge}>{record.scope}</span>
          </div>
          <div className={styles.content}>{record.content}</div>
          <div className={styles.meta}>
            <span>重要性 {record.importance.toFixed(2)}</span>
            <span>置信 {record.confidence.toFixed(2)}</span>
            <span>访问 {record.accessCount} 次</span>
            <span>{record.sourceSessionId === null
              ? '显式保存'
              : `来源 ${record.sourceSessionId.slice(0, 16)}…${record.sourceRound === null ? '' : ` 第${String(record.sourceRound)}轮`}`}</span>
            <span>{fmtTime(record.createdAt)}</span>
          </div>
          <div className={styles.ops}>
            <button type="button" className={styles.button}
              onClick={() => { setReviewId(record) }}>详情</button>
            <button type="button" className={styles.button}
              onClick={() => { setEditing(record) }}>编辑</button>
            {record.status === 'active'
              ? <button type="button" className={styles.button}
                  onClick={() => { act('forget', record) }}>遗忘</button>
              : <button type="button" className={styles.button}
                  onClick={() => { act('restore', record) }}>恢复</button>}
          </div>
        </div>
      ))}
      <div className={styles.pager}>
        <button type="button" className={styles.button} disabled={offset === 0}
          onClick={() => { setOffset(Math.max(0, offset - PAGE_SIZE)) }}>上一页</button>
        <span>第 {page} / {pages} 页 · 共 {list?.total ?? 0} 条</span>
        <button type="button" className={styles.button}
          disabled={list === null || offset + PAGE_SIZE >= list.total}
          onClick={() => { setOffset(offset + PAGE_SIZE) }}>下一页</button>
      </div>
      {editing !== null && (
        <EditDialog record={editing} onClose={() => { setEditing(null) }} onSaved={() => { setEditing(null); reload() }} />
      )}
      {reviewId !== null && (
        <div className={styles.backdrop} onClick={() => { setReviewId(null) }}>
          <div className={styles.dialog} onClick={event => event.stopPropagation()}>
            <h3>记忆审计</h3>
            <ReviewBody recordId={reviewId.id} scope={reviewId.scope} />
            <div className={styles.modalFoot}>
              <button type="button" className={styles.button}
                onClick={() => { setReviewId(null) }}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
