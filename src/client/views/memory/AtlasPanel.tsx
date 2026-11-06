/**
 * Memory 工作面 · Atlas：结构鸟瞰（平面图 / 关系图）与时间螺旋。
 * 宫殿隐喻在这里降级为一张图——它不再是导航语言，只是记忆库的可视化模块。
 * @module @kenz1117/dsh-engram/client/views/memory/AtlasPanel
 */

import { useEffect, useMemo, useState } from 'react'
import styles from '../../panel.module.css'
import spiralStyles from '../../spiral.module.css'
import { api } from '../../rpc.ts'
import { usePersistedState } from '../../UiStorage.ts'
import { CorridorMap, EDGE_STYLE, FloorplanMap, KIND_PALETTE } from '../../CorridorMap.tsx'
import { SpiralMap, type SpiralRecord } from '../../SpiralMap.tsx'
import { EmptyState, kindLabel, type T } from '../../ui/panel-kit.tsx'

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

export function CorridorPanel({ t, scope, project, onSelect, onOpenRoom }: {
  t: T
  scope: 'user' | 'project' | 'shared'
  /** 项目宫殿选择器（仅用于重载依赖；注入在 api() 里做）。 */
  project: string | null
  onSelect: (id: string) => void
  /** 平面图模式点房间 → 宿主接「陈展」按房筛选。 */
  onOpenRoom: (kind: string) => void
}): React.ReactElement {
  const [graph, setGraph] = useState<CorridorGraph | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  // v0.8.4 走廊双模式：平面图（建筑平面,默认,设计稿 #floorplan）/ 关系图（力导向,保留边价值）
  const [mode, setMode] = usePersistedState<'floorplan' | 'graph'>('corridor.mode', 'floorplan', ['floorplan', 'graph'])
  // v0.8.7 右侧房间索引条：按驻留数降序（与平面图排房一致）
  const roomCounts = useMemo(() => {
    if (graph === null) return []
    const counts = new Map<string, number>()
    for (const n of graph.nodes) counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([kind, count]) => ({ kind, count }))
  }, [graph])
  // 自环边（from === to）不是「两条记忆之间的关系」，画不出线也进不了图例：
  // 存量库里存在这类历史脏行（早期写入路径未挡自己），这里直接剔除，
  // 让关系图与图例说的是实话（没有真关系就显示「还没有关系边」）。
  const edges = useMemo(() => (graph === null ? [] : graph.edges.filter(e => e.from !== e.to)), [graph])
  useEffect(() => {
    let cancelled = false
    api<CorridorGraph>(`corridor?status=active,archived&scope=${scope}`)
      .then(data => { if (!cancelled) setGraph(data); setFailed(null) })
      .catch((err: Error) => { if (!cancelled) setFailed(err.message) })
    return () => { cancelled = true }
  }, [scope, project])
  if (failed !== null) return <div className={styles.expandLoading}>{t('corridorFailed')}：{failed}</div>
  if (graph === null) return <div className={styles.expandLoading}>{t('corridorLoad')}</div>
  if (graph.nodes.length === 0) return <EmptyState title={t('corridorEmpty')} hint={t('emptyHint')} />
  return (
    <div>
      <div className={styles.toolbarCard}>
        <div className={styles.segGroup}>
          <button type="button" role="tab" aria-selected={mode === 'floorplan'}
            className={mode === 'floorplan' ? `${styles.segItem} ${styles.on}` : styles.segItem}
            onClick={() => { setMode('floorplan') }}>
            {t('corridorModeFloor')}
          </button>
          <button type="button" role="tab" aria-selected={mode === 'graph'}
            className={mode === 'graph' ? `${styles.segItem} ${styles.on}` : styles.segItem}
            onClick={() => { setMode('graph') }}>
            {t('corridorModeGraph')}
          </button>
        </div>
      </div>
      {mode === 'floorplan'
        ? (
          <div className={styles.floorplanGrid}>
            <FloorplanMap nodes={graph.nodes} onOpenRoom={onOpenRoom} t={t} />
            <RoomIndexAside
              t={t}
              nodes={graph.nodes}
              rooms={roomCounts}
              onOpenRoom={onOpenRoom}
              edges={null} />
          </div>
        )
        : (
          <div className={styles.floorplanGrid}>
            <CorridorMap scope={scope} nodes={graph.nodes} edges={edges} onSelect={onSelect}
              onOpenRoom={onOpenRoom} t={t} />
            <RoomIndexAside
              t={t}
              nodes={graph.nodes}
              rooms={roomCounts}
              onOpenRoom={onOpenRoom}
              edges={edges} />
          </div>
        )}
    </div>
  )
}

/** 右侧房间索引条：房间驻留条（两模式共用）+ 关系图模式追加边类型图例。 */
function RoomIndexAside({ t, nodes, rooms, onOpenRoom, edges }: {
  t: T
  nodes: ReadonlyArray<{ readonly kind: string }>
  rooms: ReadonlyArray<{ readonly kind: string; readonly count: number }>
  onOpenRoom: (kind: string) => void
  /** 非 null = 关系图模式，追加边类型图例。 */
  edges: ReadonlyArray<{ readonly type: string }> | null
}): React.ReactElement {
  return (
    <aside className={styles.roomIndex}>
      <div className={styles.roomIndexStat}>
        <b>{nodes.length}</b> {t('corridorIndexStaying')} · {t('corridorIndexRooms', { n: rooms.length })}
      </div>
      {rooms.map(room => (
        <button key={room.kind} type="button" className={styles.roomIndexRow}
          onClick={() => onOpenRoom(room.kind)}>
          <span className={styles.roomSwatch} style={{ background: KIND_PALETTE[room.kind] ?? '#7d8590' }} aria-hidden="true" />
          <span className={styles.roomIndexName}>{kindLabel(t, room.kind)}</span>
          <span className={styles.roomIndexMeta}>
            <span className={styles.roomBar} aria-hidden="true">
              <span className={styles.roomBarFill}
                style={{ width: `${String(Math.min(100, Math.round((room.count / 9) * 100)))}%`, background: KIND_PALETTE[room.kind] ?? '#7d8590' }} />
            </span>
            <span className={styles.roomIndexCount}>{String(room.count)} / 9</span>
          </span>
        </button>
      ))}
      {edges !== null && edges.length > 0 && (
        <div className={styles.edgeLegend}>
          {([
            ['other', t('edgeOther'), EDGE_STYLE.related!],
            ['supersedes', t('edgeSupersedes'), EDGE_STYLE.supersedes!],
            ['contradicts', t('edgeContradicts'), EDGE_STYLE.contradicts!],
          ] as const).map(([type, label, style]) => {
            const present = type === 'other'
              ? edges.some(e => e.type !== 'supersedes' && e.type !== 'contradicts')
              : edges.some(e => e.type === type)
            if (!present) return null
            return (
              <span key={type} className={styles.edgeLegendItem}>
                <svg width={20} height={6} aria-hidden="true">
                  <line x1={0} y1={3} x2={20} y2={3} stroke={style.color} strokeWidth={style.width} strokeDasharray={style.dash} />
                </svg>
                <span>{label}</span>
              </span>
            )
          })}
        </div>
      )}
      <span className={styles.sectionHint}>
        {edges === null ? t('corridorFloorHint', { nodes: nodes.length }) : t('corridorGraphHint', { nodes: nodes.length })}
      </span>
    </aside>
  )
}

/** Memory Spiral 端点返回形状（与 routes.ts 的 GET /api/engram/timeline 对齐）。 */
interface SpiralTimelineView {
  readonly scope: 'user' | 'project' | 'shared'
  readonly total: number
  readonly records: readonly SpiralRecord[]
}

/** 回忆螺旋视图包装：拉数据 + 工具条（时间窗 segmented）+ 把 records 喂给 SpiralMap 渲染。
 *  复用段控 .segGroup + .segItem 视觉语言，跟其他 tab 的过滤选择保持一致。 */
export function SpiralPanel({ t, scope, project, reloadTick }: {
  t: T
  scope: 'user' | 'project' | 'shared'
  project: string | null
  reloadTick: number
}): React.ReactElement {
  const [records, setRecords] = useState<readonly SpiralRecord[] | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  /** 时间窗：30 天 / 半年 / 全部（持久化——其他 segmented 控件也都持久化）。 */
  const [windowKey, setWindowKey] = usePersistedState<'30d' | '180d' | 'all'>('spiral.window', 'all', ['30d', '180d', 'all'])

  useEffect(() => {
    let cancelled = false
    setRecords(null)
    setFailed(null)
    api<SpiralTimelineView>(`timeline?scope=${scope}&limit=500`)
      .then(data => { if (!cancelled) setRecords(data.records) })
      .catch(err => { if (!cancelled) setFailed(err instanceof Error ? err.message : String(err)) })
    return () => { cancelled = true }
  }, [scope, project, reloadTick])

  const windowMs = windowKey === '30d' ? 30 * 86_400_000 : windowKey === '180d' ? 180 * 86_400_000 : null
  const filteredCount = records === null ? null : records.filter(rec => windowMs === null || (Date.now() - rec.createdAt) <= windowMs).length

  return (
    <div className={styles.tabPanel}>
      <div className={spiralStyles.toolbar}>
        <div className={styles.segGroup}>
          <button type="button" role="tab" aria-selected={windowKey === '30d'}
            className={windowKey === '30d' ? `${styles.segItem} ${styles.on}` : styles.segItem}
            onClick={() => { setWindowKey('30d') }}>
            {t('spiralRange30d')}
          </button>
          <button type="button" role="tab" aria-selected={windowKey === '180d'}
            className={windowKey === '180d' ? `${styles.segItem} ${styles.on}` : styles.segItem}
            onClick={() => { setWindowKey('180d') }}>
            {t('spiralRange180d')}
          </button>
          <button type="button" role="tab" aria-selected={windowKey === 'all'}
            className={windowKey === 'all' ? `${styles.segItem} ${styles.on}` : styles.segItem}
            onClick={() => { setWindowKey('all') }}>
            {t('spiralRangeAll')}
          </button>
        </div>
        <span className={spiralStyles.meta}>
          {filteredCount === null ? t('spiralLoading') : `${t('spiralStatCount')} · ${String(filteredCount)}`}
        </span>
      </div>
      {failed !== null && (
        <div className={styles.panelCard}><EmptyState title={t('spiralFailed')} hint={failed} /></div>
      )}
      {failed === null && records === null && (
        <div className={styles.panelCard}><EmptyState title={t('spiralLoading')} /></div>
      )}
      {failed === null && records !== null && records.length === 0 && (
        <div className={styles.panelCard}><EmptyState title={t('spiralEmpty')} hint={t('emptyHint')} /></div>
      )}
      {failed === null && records !== null && records.length > 0 && (
        <SpiralMap t={t} records={records} windowMs={windowMs} />
      )}
    </div>
  )
}
