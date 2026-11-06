/**
 * Memory 工作面 · Records：陈展列表（筛选 / 分页 / 批量遗忘与恢复 / 行内展开入口）。
 * 本面板自己拥有查询状态与列表请求——数据只在 Memory·Records 打开时才拉，
 * 其它工作面不再为一份看不见的列表付请求代价。
 * @module @kenz1117/dsh-engram/client/views/memory/RecordsPanel
 */

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import styles from '../../panel.module.css'
import { api } from '../../rpc.ts'
import { usePersistedState, usePersistedString } from '../../UiStorage.ts'
import { EmptyState, kindLabel, KINDS, roomPillClass, type T } from '../../ui/panel-kit.tsx'
import { fmtTime, type ListResult, type MemoryRow, PAGE_SIZE, relTime, SCOPE_KEY, sourceLabel, STATUS_KEY } from '../../ui/model.ts'
import type { ToastController } from '../../Toast.tsx'

/** 外部对列表过滤的请求（角标「今日到期」、Atlas 房间跳转）。 */
export type RecordsRequest =
  | { readonly kind: 'due' }
  | { readonly kind: 'room'; readonly value: string }
  | null

export interface RecordsPanelProps {
  readonly t: T
  readonly scope: 'user' | 'project' | 'shared'
  /** 项目宫殿选择器（仅作重载依赖；注入在 api() 里做）。 */
  readonly project: string | null
  /** 面板级重载信号：任何写操作后 +1，列表重新拉取。 */
  readonly reloadTick: number
  /** 今日到期的条目 id 集合（复习调度今天到期；页内过滤用）。 */
  readonly dueIds: ReadonlySet<string>
  /** 打开行内展开（review / edit）。 */
  readonly onToggle: (record: MemoryRow, kind: 'review' | 'edit') => void
  /** 写操作完成后的回调：让总览遥测等跟着重取。 */
  readonly onChanged: () => void
  readonly toast: ToastController
  /** 外部过滤请求（一次性）。 */
  readonly request: RecordsRequest
  /** 请求已被应用（宿主清空请求，避免重复应用）。 */
  readonly onRequestApplied: () => void
}

export function RecordsPanel({
  t, scope, project, reloadTick, dueIds, onToggle, onChanged, toast, request, onRequestApplied,
}: RecordsPanelProps): ReactElement {
  /** 库顶 status / kind / q 过滤器（持久化）。 */
  const [status, setStatus] = usePersistedState<string>('library.status', 'all', ['all', 'active', 'archived', 'forgotten'])
  const [kind, setKind] = usePersistedState<string>('library.kind', 'all', ['all', 'fact', 'preference', 'decision', 'episode', 'skill'])
  const [q, setQ] = usePersistedString('library.q', '')
  /** 排序：time = 开馆时间倒序；tour = 固定巡游路线桩位顺序。 */
  const [sort, setSort] = usePersistedState<'time' | 'tour'>('library.sort', 'time', ['time', 'tour'])
  /** 今日到期筛选：只显示复习调度今天到期的条目。 */
  const [dueOnly, setDueOnly] = useState(false)
  const [offset, setOffset] = useState(0)
  const [list, setList] = useState<ListResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 批量选择：条目 id 集合（scope/过滤/翻页/搜索变更时清空）。 */
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  /** 批量遗忘的两段式确认。 */
  const [confirmForget, setConfirmForget] = useState(false)

  /** 切换 scope 或项目分库时回到第 1 页并清掉跨库无意义的选择态。 */
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope/project 是分库边界——换库必须回到第 1 页并清空跨库选择
  useEffect(() => {
    setOffset(0)
    setSelected(new Set())
    setConfirmForget(false)
  }, [scope, project])

  /** 外部请求（角标 / 房间跳转）落地到过滤条件。 */
  useEffect(() => {
    if (request === null) return
    if (request.kind === 'due') setDueOnly(true)
    else setKind(request.value)
    setOffset(0)
    setSelected(new Set())
    onRequestApplied()
  }, [request, onRequestApplied, setKind])

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadTick/project 只作重载信号——实际选择器由 api() 在渲染期注入，换库时需重新取数
  useEffect(() => {
    let cancelled = false
    // q 保留原文（输入法/词组中间空格），只在请求边界 trim——trim 过早会让含空格查询永远打不出来。
    const query = q.trim()
    const qs = new URLSearchParams({
      scope, status, kind, redacted: 'all', limit: String(PAGE_SIZE), offset: String(offset),
    })
    if (query !== '') qs.set('q', query)
    if (sort === 'tour') qs.set('sort', 'tour')
    api<ListResult>(`list?${qs.toString()}`)
      .then((data) => { if (!cancelled) { setList(data); setError(null) } })
      .catch((loadError: Error) => { if (!cancelled) setError(loadError.message) })
    return () => { cancelled = true }
  }, [scope, status, kind, q, sort, offset, reloadTick, project])

  const act = (route: string, record: MemoryRow): void => {
    api(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: record.id, scope: record.scope }),
    })
      .then(onChanged)
      .catch((actError: Error) => { toast.push('error', actError.message) })
  }

  const allRecords = list?.records ?? []
  // 「今日到期」筛选是页内视图过滤（复习调度今天到期的 id 白名单）；分页仍按库内全量计算。
  const pageRecords = dueOnly ? allRecords.filter(record => dueIds.has(record.id)) : allRecords
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
      if (allSelected) for (const record of pageRecords) next.delete(record.id)
      else for (const record of pageRecords) next.add(record.id)
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
    }))).then(() => { clearSelection(); onChanged() })
  }

  const armBatchForget = (): void => {
    // 确认态保持到用户点击确认执行或清空选择，不做自动复位（3 秒窗口曾导致执行落空）。
    if (confirmForget) { runBatch('forget'); return }
    setConfirmForget(true)
  }

  const page = Math.floor(offset / PAGE_SIZE) + 1
  const pages = list === null ? 1 : Math.max(1, Math.ceil(list.total / PAGE_SIZE))

  return (
    <div>
      {/* v0.8.9 工具行收进工具条卡;房间 chips 仍单独一行。 */}
      <div className={styles.toolbarCard}>
        <span className={styles.searchBox}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M16.5 16.5 L21 21" /></svg>
          <input className={`${styles.input} ${styles.search}`} placeholder={t('searchPlaceholder')} value={q}
            onChange={event => { setQ(event.target.value); setOffset(0); clearSelection() }} />
        </span>
        <div className={styles.segGroup}>
          {([
            ['all', t('allStatuses')],
            ['active', t('statusActive')],
            ['archived', t('statusArchived')],
            ['forgotten', t('statusForgotten')],
          ] as const).map(([value, label]) => (
            <button key={value} type="button"
              className={status === value ? `${styles.segItem} ${styles.on}` : styles.segItem}
              onClick={() => { setStatus(value); setOffset(0); clearSelection() }}>
              {label}
            </button>
          ))}
        </div>
        {/* 今日到期：复习调度今天到期的条目（消费者是 agent，这里只做观测筛选）。
            单独一个按钮不嵌 .segGroup（没有玻璃指示器可滑动）；用 .chip/.chipOn 的视觉语言
            让激活态有清晰品牌色提示，跟其他激活态一致。 */}
        <button type="button" aria-pressed={dueOnly}
          className={dueOnly ? `${styles.chip} ${styles.chipOn}` : styles.chip}
          onClick={() => { setDueOnly(!dueOnly); setOffset(0); clearSelection() }}>
          {t('filterDueToday')}
        </button>
        <div className={styles.segGroup}>
          {([['time', t('sortTime')], ['tour', t('sortTour')]] as const).map(([value, label]) => (
            <button key={value} type="button"
              className={sort === value ? `${styles.segItem} ${styles.on}` : styles.segItem}
              onClick={() => { setSort(value); setOffset(0); clearSelection() }}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.chipRow}>
        {([
          ['all', t('allKinds')],
          ...KINDS.map(option => [option, kindLabel(t, option)] as const),
        ] as const).map(([value, label]) => (
          <button key={value} type="button" aria-pressed={kind === value}
            className={kind === value ? `${styles.chip} ${styles.chipOn}` : styles.chip}
            onClick={() => { setKind(value); setOffset(0); clearSelection() }}>
            {label}
          </button>
        ))}
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
        <EmptyState title={t('loadFailed', { msg: error })} hint={t('emptyHint')} />
      )}
      {error === null && list === null && (
        <div className={styles.skeletonList}>
          {[0, 1, 2, 3].map(index => (
            <div key={index} className={styles.skeleton} style={{ animationDelay: `${String(index * 60)}ms` }}><i /><i /><i /></div>
          ))}
        </div>
      )}
      {error === null && list !== null && pageRecords.length === 0 && (
        <EmptyState title={t('empty')} hint={t('emptyHint')} />
      )}

      {pageRecords.length > 0 && (
        <div className={styles.itemList}>
          {pageRecords.map((record, index) => (
            <div key={record.id}
              className={selected.has(record.id) ? `${styles.item} ${styles.selected}` : styles.item}
              style={{ animationDelay: `${String(Math.min(index, 12) * 36)}ms` }}>
              <input type="checkbox" className={styles.itemCheck} checked={selected.has(record.id)}
                aria-label={record.content.slice(0, 24)} onChange={() => toggleSelect(record.id)} />
              <div className={styles.itemBody}>
                <div className={styles.itemTags}>
                  <span className={`${styles.pill} ${styles[`status${record.status.charAt(0).toUpperCase()}${record.status.slice(1)}`] ?? ''}`}>{t(STATUS_KEY[record.status])}</span>
                  <span className={roomPillClass(record.kind)}>{kindLabel(t, record.kind)}</span>
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
                  <span className={styles.itemStamp} title={fmtTime(record.createdAt)}>
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
                  onClick={() => { onToggle(record, 'review') }}>{t('detail')}</button>
                <button type="button" className={styles.button}
                  onClick={() => { onToggle(record, 'edit') }}>{t('edit')}</button>
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
          onClick={() => { setOffset(Math.max(0, offset - PAGE_SIZE)); clearSelection() }}>‹</button>
        <span>{t('pagerInfo', { page, pages, total: list?.total ?? 0 })}</span>
        <button type="button" className={styles.button} disabled={list === null || offset + PAGE_SIZE >= list.total}
          aria-label={t('nextPage')}
          onClick={() => { setOffset(offset + PAGE_SIZE); clearSelection() }}>›</button>
      </div>
    </div>
  )
}
