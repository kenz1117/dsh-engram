/**
 * Memory 工作面 · Timeline：情景时间线（按会话分组 + 邻近扩展）。
 * 形状与服务器共用 src/types.ts：形状对不上是编译错误，不会变成「点开邻近时视图崩掉」。
 * @module @kenz1117/dsh-engram/client/views/memory/TimelinePanel
 */

import { useEffect, useState } from 'react'
import styles from '../../panel.module.css'
import { api } from '../../rpc.ts'
import { EmptyState, kindLabel, type T } from '../../ui/panel-kit.tsx'
import { fmtTime } from '../../ui/model.ts'
import type {
  EpisodeTimelineAround,
  EpisodeTimelineAroundResponse,
  EpisodeTimelineGroupsResponse,
  EpisodeTimelineRow,
} from '../../../types.ts'

/* 情景时间线的载荷形状与服务器共用（src/types.ts）：形状对不上是编译错误，
   不会再变成「点「邻近」时视图崩掉」。 */
type EpisodeRowView = EpisodeTimelineRow
type EpisodeGroupsView = EpisodeTimelineGroupsResponse

/** 邻近扩展（around 模式）返回：锚点条目 + 窗口内的情景邻居。 */
type EpisodeAroundView = EpisodeTimelineAround

/**
 * 情景时间线视图：按会话分组浏览 episode 往事，组头展示摄取期生成的一句话摘要；
 * 条目点「邻近」展开该时刻 ± 窗口的时间邻近扩展卡（回答「当时前后还发生了什么」）。
 */
export function EpisodeTimelineView({ t, scope, project, reloadTick }: {
  t: T
  scope: 'user' | 'project' | 'shared'
  /** 项目宫殿选择器（仅用于重载依赖；注入在 api() 里做）。 */
  project: string | null
  reloadTick: number
}): React.ReactElement {
  const [sinceDate, setSinceDate] = useState('')
  const [untilDate, setUntilDate] = useState('')
  const [sessionIdInput, setSessionIdInput] = useState('')
  /** 已应用的过滤条件：date/文本输入不即时触发请求，点「应用」才生效。 */
  const [applied, setApplied] = useState<{ readonly since: string; readonly until: string; readonly sessionId: string }>({ since: '', until: '', sessionId: '' })
  const [data, setData] = useState<EpisodeGroupsView | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  /** 邻近扩展卡（null = 未展开）；busy 防重复点击。 */
  const [around, setAround] = useState<EpisodeAroundView | null>(null)
  const [aroundBusy, setAroundBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams({ scope })
    // date input 值按本地时区折算成当天首尾毫秒（T00:00:00 / T23:59:59.999）。
    if (applied.since !== '') params.set('since', String(new Date(`${applied.since}T00:00:00`).getTime()))
    if (applied.until !== '') params.set('until', String(new Date(`${applied.until}T23:59:59.999`).getTime()))
    if (applied.sessionId !== '') params.set('sessionId', applied.sessionId)
    api<EpisodeGroupsView>(`episode-timeline?${params.toString()}`)
      .then(d => { if (!cancelled) { setData(d); setFailed(null) } })
      .catch((err: Error) => { if (!cancelled) setFailed(err.message) })
    return () => { cancelled = true }
  }, [scope, project, applied, reloadTick])

  /** 展开邻近扩展：以该条目为锚点查同库 ±60 分钟窗口内的情景（窗口由 host 缺省）。 */
  const openAround = (id: string): void => {
    setAroundBusy(true)
    // 服务器的形状是 `{ around: { anchor, neighbors } }`（同一条路由在分组模式下回
    // `{ groups }`），这里必须取出内层：直接当 `EpisodeAroundView` 用会得到
    // `anchor === undefined`，渲染锚点行时读 `.id` 就把整个视图带崩了。
    api<EpisodeTimelineAroundResponse>(`episode-timeline?scope=${scope}&around=${encodeURIComponent(id)}`)
      .then(d => {
        const view = d.around
        if (view === undefined) {
          setFailed(t('episodeAroundMissing'))
          setAround(null)
        } else {
          setAround(view)
          setFailed(null)
        }
        setAroundBusy(false)
      })
      .catch((err: Error) => { setFailed(err.message); setAroundBusy(false) })
  }

  /** 条目行：时刻 + 房间 + 内容 + 邻近按钮；id 放 title 便于复制。 */
  const renderRow = (row: EpisodeRowView): React.ReactElement => (
    <div key={row.id} className={styles.episodeRow} title={row.id}>
      <time className={styles.episodeRowTime}>{fmtTime(row.createdAt)}</time>
      <span className={styles.episodeRowKind}>{kindLabel(t, row.kind)}</span>
      <span className={styles.episodeRowText}>{row.content}</span>
      <button type="button" className={styles.button} disabled={aroundBusy}
        onClick={() => { openAround(row.id) }}>
        {t('episodeNearby')}
      </button>
    </div>
  )

  return (
    <>
      {/* v0.8.9 过滤行收进工具条卡。 */}
      <div className={styles.toolbarCard}>
        <input type="date" className={styles.input} value={sinceDate} aria-label={t('episodeSince')}
          onChange={event => { setSinceDate(event.target.value) }} />
        <span className={styles.episodeRangeSep} aria-hidden="true">–</span>
        <input type="date" className={styles.input} value={untilDate} aria-label={t('episodeUntil')}
          onChange={event => { setUntilDate(event.target.value) }} />
        <input className={`${styles.input} ${styles.search}`} placeholder={t('episodeSessionId')} value={sessionIdInput}
          onChange={event => { setSessionIdInput(event.target.value) }} />
        <button type="button" className={`${styles.button} ${styles.primary}`}
          onClick={() => { setApplied({ since: sinceDate, until: untilDate, sessionId: sessionIdInput.trim() }); setAround(null) }}>
          {t('episodeApply')}
        </button>
        <button type="button" className={styles.button}
          onClick={() => {
            setSinceDate(''); setUntilDate(''); setSessionIdInput('')
            setApplied({ since: '', until: '', sessionId: '' }); setAround(null)
          }}>
          {t('episodeReset')}
        </button>
      </div>
      {failed !== null && <div className={styles.expandLoading}>{t('loadFailed', { msg: failed })}</div>}
      {around !== null && (
        <section className={`${styles.panelCard} ${styles.episodeAround}`}>
          <header className={styles.episodeAroundHead}>
            <b>{t('episodeAroundTitle')}</b>
            <button type="button" className={styles.button} onClick={() => { setAround(null) }}>
              {t('episodeClose')}
            </button>
          </header>
          {around.anchor !== undefined && renderRow(around.anchor)}
          {(around.neighbors ?? []).length === 0
            ? <p className={styles.sectionHint}>{t('episodeAroundEmpty')}</p>
            : (around.neighbors ?? []).map(renderRow)}
        </section>
      )}
      {data === null && failed === null && <div className={styles.expandLoading}>{t('loading')}</div>}
      {data !== null && data.groups.length === 0 && <EmptyState title={t('episodeNoGroups')} hint={t('emptyHint')} />}
      {data?.groups.map(group => (
        <section key={group.sessionId ?? 'none'} className={styles.panelCard}>
          <header className={styles.episodeHead}>
            {group.summary === undefined
              ? <p className={`${styles.episodeSummary} ${styles.episodeSummaryMissing}`}>{t('episodeSummaryMissing')}</p>
              : <p className={styles.episodeSummary}>{group.summary}</p>}
            <span className={styles.episodeHeadMeta}>
              {group.sessionId === null ? t('episodeNoSession') : `#${group.sessionId}`}
              {' · '}
              {new Date(group.startedAt).toLocaleDateString()} ~ {new Date(group.endedAt).toLocaleDateString()}
              {' · '}
              {t('episodeEntries', { n: group.episodes.length })}
            </span>
          </header>
          <div>{group.episodes.map(renderRow)}</div>
        </section>
      ))}
    </>
  )
}
