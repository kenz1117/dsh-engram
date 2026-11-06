/**
 * Memory 工作面 · Entities：实体词典（人物 / 项目 / 工具 / 概念）与关联记忆、事实链。
 * @module @kenz1117/dsh-engram/client/views/memory/EntitiesPanel
 */

import { useEffect, useState } from 'react'
import styles from '../../panel.module.css'
import { api } from '../../rpc.ts'
import { EmptyState, kindLabel, type T } from '../../ui/panel-kit.tsx'
import { fmtTime, type MemoryRow } from '../../ui/model.ts'
import type { EngramKey } from '../../locales/index.ts'

/** GET /api/engram/entities 的行（host 返回 { entity, memoryCount }，entity 为实体记录的显示字段）。 */
interface EntityListItemView {
  readonly entity: {
    readonly id: string
    readonly name: string
    readonly kind: string
    readonly aliases: readonly string[]
  }
  readonly memoryCount: number
}

/** GET /api/engram/entities 返回（updated_at 倒序，附总数）。 */
interface EntityListView {
  readonly items: readonly EntityListItemView[]
  readonly total: number
}

/** GET /api/engram/entity 返回：实体 + 关联 active 记忆（创建时间倒序）。 */
interface EntityDetailView {
  readonly entity: EntityListItemView['entity']
  readonly memories: readonly MemoryRow[]
}

/** GET /api/engram/facts 返回的单条事实（面板只读显示所需字段）。 */
interface FactView {
  readonly id: string
  readonly content: string
  readonly validAt: number
  readonly invalidAt: number | null
  readonly replacedBy: string | null
}

/** GET /api/engram/facts 返回（valid_at 倒序，附总数）。 */
interface EntityFactsView {
  readonly items: readonly FactView[]
  readonly total: number
}

/** 实体类别数据值 → 词典键（筛选 chips、列表行与详情卡共用一份映射）。 */
const ENTITY_KIND_KEY: Record<string, EngramKey> = {
  person: 'entityKindPerson',
  project: 'entityKindProject',
  tool: 'entityKindTool',
  concept: 'entityKindConcept',
  other: 'entityKindOther',
}
/** 实体类别 → 色点（人物蓝/项目橙/工具青/概念紫/其他灰）。 */
/** 实体类别 → 色点（CSS 变量名；色值在 panel.module.css 的 --entity-*）。 */
const ENTITY_DOT: Readonly<Record<string, string>> = {
  person: 'var(--entity-person)',
  project: 'var(--entity-project)',
  tool: 'var(--entity-tool)',
  concept: 'var(--entity-concept)',
  other: 'var(--entity-other)',
}

const ENTITY_KINDS = ['person', 'project', 'tool', 'concept', 'other'] as const

/** 实体行的类别标签（未知 kind 回退「其他」）。 */
function entityKindLabel(t: T, kind: string): string {
  return t(ENTITY_KIND_KEY[kind] ?? 'entityKindOther')
}

/**
 * 实体词典视图：浏览摄取期从记忆中抽取的实体（人物/项目/工具/概念），
 * 类别 chips + 名称/别名子串过滤；点「查看」展开该实体牵出的关联记忆卡。
 */
export function EntityView({ t, scope, project, reloadTick }: {
  t: T
  scope: 'user' | 'project' | 'shared'
  /** 项目宫殿选择器（仅用于重载依赖；注入在 api() 里做）。 */
  project: string | null
  reloadTick: number
}): React.ReactElement {
  const [kind, setKind] = useState<'all' | (typeof ENTITY_KINDS)[number]>('all')
  const [q, setQ] = useState('')
  const [data, setData] = useState<EntityListView | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  /** 展开的实体详情卡（null = 未展开）；busy 防重复点击。 */
  const [detail, setDetail] = useState<EntityDetailView | null>(null)
  const [facts, setFacts] = useState<EntityFactsView | null>(null)
  const [detailBusy, setDetailBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    const query = q.trim()
    const params = new URLSearchParams({ scope })
    if (kind !== 'all') params.set('kind', kind)
    if (query !== '') params.set('q', query)
    api<EntityListView>(`entities?${params.toString()}`)
      .then(d => { if (!cancelled) { setData(d); setFailed(null) } })
      .catch((err: Error) => { if (!cancelled) setFailed(err.message) })
    return () => { cancelled = true }
  }, [scope, project, kind, q, reloadTick])

  /** 展开实体详情：实体记录 + 关联记忆 + 事实链全貌（含已失效，看事实如何演变）。 */
  const openDetail = (id: string): void => {
    setDetailBusy(true)
    Promise.all([
      api<EntityDetailView>(`entity?scope=${scope}&id=${encodeURIComponent(id)}`),
      api<EntityFactsView>(`facts?scope=${scope}&entityId=${encodeURIComponent(id)}&includeInvalid=1`),
    ])
      .then(([d, f]) => { setDetail(d); setFacts(f); setDetailBusy(false); setFailed(null) })
      .catch((err: Error) => { setFailed(err.message); setDetailBusy(false) })
  }

  /** 详情卡里的关联记忆行：时刻 + 房间 + 内容（只读观测，不提供编辑入口）。 */
  const renderMemory = (row: MemoryRow): React.ReactElement => (
    <div key={row.id} className={styles.episodeRow} title={row.id}>
      <time className={styles.episodeRowTime}>{fmtTime(row.createdAt)}</time>
      <span className={styles.episodeRowKind}>{kindLabel(t, row.kind)}</span>
      <span className={styles.episodeRowText}>{row.content}</span>
    </div>
  )

  /** 详情卡里的事实行：生效日期 + 状态标签 + 陈述；失效行标「已失效」。 */
  const renderFact = (fact: FactView): React.ReactElement => (
    <div key={fact.id} className={styles.episodeRow} title={fact.id}>
      <time className={styles.episodeRowTime}>{new Date(fact.validAt).toLocaleDateString()}</time>
      <span className={styles.episodeRowKind}>{fact.invalidAt === null ? t('factValid') : t('factInvalid')}</span>
      <span className={styles.episodeRowText}>{fact.content}</span>
    </div>
  )

  return (
    <>
      {/* 工具条：类别 chips（带色点，色码自解释）+ 搜索 + 计数，一个容器。 */}
      <div className={styles.toolbarCard}>
        {([
          ['all', t('entityKindAll')],
          ...ENTITY_KINDS.map(option => [option, t(ENTITY_KIND_KEY[option] ?? 'entityKindOther')] as const),
        ] as const).map(([value, label]) => (
          <button key={value} type="button" aria-pressed={kind === value}
            className={kind === value ? `${styles.chip} ${styles.chipOn}` : styles.chip}
            onClick={() => { setKind(value); setDetail(null); setFacts(null) }}>
            {value !== 'all' && (
              <span className={styles.chipDot} style={{ background: ENTITY_DOT[value] ?? 'var(--entity-other)' }} aria-hidden="true" />
            )}
            {label}
          </button>
        ))}
        <span className={styles.searchBox}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M16.5 16.5 L21 21" /></svg>
          <input className={`${styles.input} ${styles.search}`} placeholder={t('entitySearchPlaceholder')} value={q}
            onChange={event => { setQ(event.target.value); setDetail(null); setFacts(null) }} />
        </span>
        {data !== null && <span className={styles.toolbarCount}>{t('entityCount', { n: data.total })}</span>}
      </div>
      {failed !== null && <div className={styles.expandLoading}>{t('loadFailed', { msg: failed })}</div>}
      {detail !== null && (
        <section className={`${styles.panelCard} ${styles.episodeAround}`}>
          <header className={styles.episodeAroundHead}>
            <b>{detail.entity.name}</b>
            <span className={styles.episodeRowKind}>{entityKindLabel(t, detail.entity.kind)}</span>
            <button type="button" className={styles.button} onClick={() => { setDetail(null); setFacts(null) }}>
              {t('episodeClose')}
            </button>
          </header>
          {detail.entity.aliases.length > 0 && (
            <p className={styles.sectionHint}>{`${t('entityAliases')}：${detail.entity.aliases.join('、')}`}</p>
          )}
          {detail.memories.length === 0
            ? <p className={styles.sectionHint}>{t('entityNoMemories')}</p>
            : <div>{detail.memories.map(renderMemory)}</div>}
          {facts !== null && (
            <>
              <p className={styles.sectionHint}>{t('factSection', { n: facts.total })}</p>
              {facts.items.length === 0
                ? <p className={styles.sectionHint}>{t('factEmpty')}</p>
                : <div>{facts.items.map(renderFact)}</div>}
            </>
          )}
        </section>
      )}
      {data === null && failed === null && <div className={styles.expandLoading}>{t('loading')}</div>}
      {data !== null && data.items.length === 0 && <EmptyState title={t('entityEmpty')} hint={t('emptyHint')} />}
      {data !== null && data.items.length > 0 && (
        <div className={styles.entityList}>
          {data.items.map((item, index) => (
            <button key={item.entity?.id ?? `entity-${String(index)}`} type="button" className={styles.entityRow}
              title={item.entity?.id} disabled={detailBusy}
              onClick={() => { if (item.entity !== undefined) openDetail(item.entity.id) }}>
              <span className={styles.entityDot} style={{ background: ENTITY_DOT[item.entity?.kind ?? ''] ?? 'var(--entity-other)' }} aria-hidden="true" />
              <span className={styles.entityMain}>
                <span className={styles.entityName}>{item.entity?.name ?? '—'}</span>
                {(item.entity?.aliases.length ?? 0) > 0 && (
                  <span className={styles.entityAliases}>{item.entity?.aliases.join('、')}</span>
                )}
              </span>
              <span className={styles.entityTag}>{entityKindLabel(t, item.entity?.kind ?? 'other')}</span>
              <span className={styles.entityCount}>{t('entityMemories', { n: item.memoryCount })}</span>
              <svg className={styles.entityChevron} viewBox="0 0 24 24" aria-hidden="true">
                <path d="M9 5l7 7-7 7" />
              </svg>
            </button>
          ))}
        </div>
      )}
    </>
  )
}
