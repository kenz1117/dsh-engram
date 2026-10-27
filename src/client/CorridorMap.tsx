/**
 * 走廊鸟瞰：同一座宫殿的两种视图——「建筑平面图」与「关系图」。
 *
 * 设计要点：
 * 1. 两种视图共用同一套建筑几何（PLAN 尺寸、房间排布、外墙、中央主通道），
 *    平面图看「谁住在哪间房 + 容量」，关系图看「谁住在哪间房 + 谁和谁有关系」。
 *    房间位置在两个视图间保持一致（位置当索引），切换标签不重排。
 * 2. 关系图的节点锚在房间里（房 = kind），不再是满屏乱飞的力导向孤点：
 *    房内做一次确定性的排斥松弛（无随机、无 rAF 抖动），房与房之间画关系边。
 * 3. 节点不常驻文字标签（房间小、点多，标签必糊），hover 出提示卡；
 *    hover 节点时高亮它 + 一跳邻居 + 相关边，其余淡出。
 *
 * @module @kenz1117/dsh-engram/client/CorridorMap
 */

import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import styles from './panel.module.css'
import { KIND_KEY, type EngramKey } from './locales/index.ts'

/** 走廊图使用的翻译函数（渲染器合成的窄签名）。 */
type CorridorT = (key: EngramKey, params?: Record<string, unknown>) => string

/** kind → 本地化房间名（词典缺失时回退数据值）。 */
function roomLabel(t: CorridorT, kind: string): string {
  const key = KIND_KEY[kind]
  return key === undefined ? kind : t(key as EngramKey)
}

interface CorridorNode {
  readonly id: string
  readonly scope: string
  readonly kind: string
  readonly status: string
  readonly importance: number
  readonly confidence: number
  readonly title: string
  /** 后端可选字段：完整铭牌（用于 tooltip）。 */
  readonly content?: string
}
interface CorridorEdge {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly type: string
}

/** 房间色板：5 个语义色相（按 kind 分组）。导出供宿主面板的房间索引条共用同一色源。 */
export const KIND_PALETTE: Readonly<Record<string, string>> = {
  fact: '#5b8def',
  preference: '#f0a85c',
  decision: '#9b6bd9',
  episode: '#3cb489',
  skill: '#e26b86',
}

/** 边视觉语义。dash 显式允许 undefined：exactOptionalPropertyTypes 下字面量表无需逐项删键。 */
type EdgeStyle = { color: string; dash?: string | undefined; width: number }
/** 边样式表（导出给宿主面板的图例用，保证图例与画布同一色源）。 */
export const EDGE_STYLE: Readonly<Record<string, EdgeStyle>> = {
  related:   { color: 'rgba(120, 130, 150, 0.6)',  dash: undefined, width: 1 },
  refines:   { color: 'rgba(120, 130, 150, 0.6)',  dash: undefined, width: 1 },
  supports:  { color: 'rgba(120, 130, 150, 0.6)',  dash: undefined, width: 1 },
  supersedes:{ color: 'rgba(91, 141, 239, 0.85)', dash: undefined, width: 1.8 },
  contradicts:{ color: 'rgba(226, 107, 134, 0.9)', dash: '4 4',     width: 1.4 },
}

/** 房间容量（与 src/palace/slots.ts 的容量 9 对齐；满员开新房）。 */
const ROOM_CAPACITY = 9

/* ---------- 建筑几何（两种视图共用） ---------- */

/** 画布逻辑尺寸：与设计稿 prototypes/visual-upgrade.html #floorplan 对齐。 */
const PLAN_W = 720
const PLAN_H = 380
/** 房间列宽 / 顶边 / 底边 / 房间间隙 / 左右列起点。 */
const ROOM_COL_W = 320
const ROOM_TOP = 40
const ROOM_BOTTOM = PLAN_H - 14
const ROOM_GAP = 12
const ROOM_MAX_H = 160
const ROOM_LEFT_X = 20
const ROOM_RIGHT_X = 380

/** 一间房的几何矩形。 */
interface RoomBox {
  readonly kind: string
  readonly count: number
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/**
 * 房间排布：按驻留数降序取前 6 间（kind 理论 5 种 + 扩容房示意），
 * 偶数位进左列、奇数位进右列，两列纵向均分高度（单间最高 ROOM_MAX_H）。
 * 平面图与关系图共用此函数——房间位置在两个视图间必须一致。
 */
function roomBoxes(nodes: readonly CorridorNode[]): RoomBox[] {
  const counts = new Map<string, number>()
  for (const n of nodes) counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1)
  const kinds = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
  const boxes: RoomBox[] = []
  const column = (list: ReadonlyArray<readonly [string, number]>, x: number): void => {
    const n = list.length
    if (n === 0) return
    const h = Math.min(ROOM_MAX_H, (ROOM_BOTTOM - ROOM_TOP - (n - 1) * ROOM_GAP) / n)
    list.forEach(([kind, count], i) => {
      boxes.push({ kind, count, x, y: ROOM_TOP + i * (h + ROOM_GAP), w: ROOM_COL_W, h })
    })
  }
  column(kinds.filter((_, i) => i % 2 === 0), ROOM_LEFT_X)
  column(kinds.filter((_, i) => i % 2 === 1), ROOM_RIGHT_X)
  return boxes
}

/** 房内可用区（避开标题行与下边距）。 */
function roomInner(box: RoomBox): { x: number; y: number; w: number; h: number } {
  return { x: box.x + 14, y: box.y + 34, w: box.w - 28, h: Math.max(20, box.h - 46) }
}

/** 房间外壳（两种视图同款：淡填 + 描边 + hover 加深）。 */
function roomShell(box: RoomBox, color: string, hovered: boolean): ReactElement {
  return (
    <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={10}
      fill={color} fillOpacity={hovered ? 0.1 : 0.06}
      stroke={color} strokeOpacity={hovered ? 0.8 : 0.35}
      strokeWidth={hovered ? 2 : 1.2}
      style={{ transition: 'fill-opacity 160ms ease, stroke-opacity 160ms ease, stroke-width 160ms ease' }} />
  )
}

/** 房间门牌：房名 + 驻留数。 */
function roomPlate(box: RoomBox, color: string, t: CorridorT): ReactElement {
  return (
    <>
      <text x={box.x + 14} y={box.y + 24} fill={color} fontSize="12" fontWeight={600}
        fontFamily="ui-sans-serif, system-ui">{roomLabel(t, box.kind)}</text>
      <text x={box.x + box.w - 14} y={box.y + 24} textAnchor="end" fill="rgba(127,127,127,0.8)" fontSize="11"
        style={{ fontVariantNumeric: 'tabular-nums' }}
        fontFamily="ui-sans-serif, system-ui">{`${String(box.count)} / ${String(ROOM_CAPACITY)}`}</text>
    </>
  )
}

/** 中央主通道的虚线轮廓（两模式同款，铺在最底层）。 */
function hallStrip(): ReactElement {
  return (
    <rect x={PLAN_W / 2 - 11} y={64} width={22} height={PLAN_H - 110} rx={8}
      fill="none" stroke="var(--dsw-alias-brand-primary)" strokeOpacity={0.4}
      strokeWidth={1.2} strokeDasharray="5 4" />
  )
}

/**
 * 主通道门牌：旋转文字 + 底衬。
 * 画在边之上（关系图的连线会穿过通道），否则虚线与连线会把字切碎。
 */
function hallLabel(t: CorridorT): ReactElement {
  return (
    <g>
      <rect x={PLAN_W / 2 - 6} y={PLAN_H / 2 - 40} width={12} height={80} rx={6}
        fill="var(--dsw-alias-bg-base)" fillOpacity={0.92} />
      <text x={PLAN_W / 2} y={PLAN_H / 2} textAnchor="middle"
        fill="var(--dsw-alias-brand-primary)" fillOpacity={0.8} fontSize="10" fontWeight={600}
        fontFamily="ui-sans-serif, system-ui"
        transform={`rotate(-90 ${String(PLAN_W / 2)} ${String(PLAN_H / 2)})`}>
        {t('corridorHall')}
      </text>
    </g>
  )
}

/* ---------- 平面图 ---------- */

/**
 * 走廊 2.0 · 建筑平面图（设计稿 prototypes/visual-upgrade.html #floorplan 的落地版）：
 * 外墙包住整个宫殿，中央一条主通道，房间分左右两列驻留各 kind 的记忆。
 * 每间房：门牌（房名 + 驻留数）+ 底部 9 格桩位点阵（填充数 = 驻留数，满员出 +N 开新房提示）。
 * 点房间 → onOpenRoom(kind)（宿主接「陈展」按房筛选）。无关系边——边在「关系图」模式（CorridorMap）。
 */
export function FloorplanMap({ nodes, onOpenRoom, t }: {
  nodes: readonly CorridorNode[]
  onOpenRoom: (kind: string) => void
  t: CorridorT
}): ReactElement {
  const [hoverKind, setHoverKind] = useState<string | null>(null)
  const boxes = useMemo(() => roomBoxes(nodes), [nodes])

  const renderRoom = (box: RoomBox): ReactElement => {
    const color = KIND_PALETTE[box.kind] ?? '#7d8590'
    const hovered = hoverKind === box.kind
    const filled = Math.min(box.count, ROOM_CAPACITY)
    const pipSize = 12
    const pipGap = 5
    const overflow = box.count > ROOM_CAPACITY ? box.count - ROOM_CAPACITY : 0
    return (
      <g key={box.kind} onMouseEnter={() => { setHoverKind(box.kind) }}
        onMouseLeave={() => { setHoverKind(prev => prev === box.kind ? null : prev) }}
        onClick={() => onOpenRoom(box.kind)} style={{ cursor: 'pointer' }}>
        {roomShell(box, color, hovered)}
        {roomPlate(box, color, t)}
        {/* 桩位点阵：9 格，填充数 = 驻留数 */}
        {Array.from({ length: ROOM_CAPACITY }, (_, i) => (
          <rect key={i} x={box.x + 14 + i * (pipSize + pipGap)} y={box.y + box.h - 26} width={pipSize} height={pipSize} rx={3}
            fill={i < filled ? color : 'none'}
            fillOpacity={i < filled ? 0.85 : 0}
            stroke={color} strokeOpacity={i < filled ? 0 : 0.3} strokeWidth={1} />
        ))}
        {/* 满员开新房提示 */}
        {overflow > 0 && (
          <text x={box.x + 14 + ROOM_CAPACITY * (pipSize + pipGap) + 4} y={box.y + box.h - 16}
            fill={color} fontSize="10" fontFamily="ui-sans-serif, system-ui">
            {t('corridorOverflow', { n: overflow })}
          </text>
        )}
      </g>
    )
  }

  return (
    <div className={styles.mapWrap}>
      <svg viewBox={`0 0 ${String(PLAN_W)} ${String(PLAN_H)}`} className={`${styles.map} ${styles.mapFloorplan}`}
        preserveAspectRatio="xMidYMid meet" role="img" aria-label={t('corridorAria')} key={boxes.map(b => b.kind).join('-')}>
        {/* 外墙 */}
        <rect x={6} y={6} width={PLAN_W - 12} height={PLAN_H - 12} rx={14}
          fill="var(--dsw-alias-bg-base)" stroke="var(--dsw-alias-border-l2)" strokeWidth={1.5} />
        {/* 中央主通道：虚线描边 + 旋转门牌 */}
        {hallStrip()}
        {/* 左右两列房间（房间之间的间隙即走廊） */}
        {boxes.map(renderRoom)}
        {hallLabel(t)}
      </svg>
    </div>
  )
}

/* ---------- 关系图 ---------- */

/** 关系图里的一个记忆点（锚在房间里）。 */
interface GraphNode {
  readonly id: string
  readonly kind: string
  readonly status: string
  readonly title: string
  readonly content: string
  readonly r: number
  x: number
  y: number
}

/** 节点半径：房内小圆点，按重要度微调（4~8 逻辑像素）。 */
function graphRadius(n: CorridorNode): number {
  return 4 + 4 * n.importance * n.confidence
}

/**
 * 房内排布：确定性排斥松弛（无随机数、无 rAF 抖动，一次算完）。
 * 初始位置用黄金角螺旋铺开，之后按「最小间距 + 弱回中」迭代若干轮。
 */
function layoutRoom(nodes: GraphNode[], box: RoomBox): void {
  const area = roomInner(box)
  const cx = area.x + area.w / 2
  const cy = area.y + area.h / 2
  const golden = Math.PI * (3 - Math.sqrt(5))
  // 初始位置：黄金角螺旋铺满整间房（椭圆分布，别缩成一坨）。
  nodes.forEach((n, i) => {
    const t = (i + 0.5) / nodes.length
    const angle = i * golden
    n.x = cx + Math.sqrt(t) * area.w * 0.44 * Math.cos(angle)
    n.y = cy + Math.sqrt(t) * area.h * 0.44 * Math.sin(angle)
  })
  // 迭代数随房间规模缩档：O(n²·ITER) 在主线程一次算完——150+ 节点的大房间降到 60 轮
  // （视觉上仍收敛，排斥力主导相位在前 30 轮），避免走廊页签数秒冻结（审计 N20）。
  const ITER = nodes.length > 150 ? 60 : 220
  for (let iter = 0; iter < ITER; iter += 1) {
    const alpha = 1 - iter / ITER
    for (let i = 0; i < nodes.length; i += 1) {
      const a = nodes[i]!
      for (let j = i + 1; j < nodes.length; j += 1) {
        const b = nodes[j]!
        let dx = a.x - b.x
        let dy = a.y - b.y
        let dist = Math.sqrt(dx * dx + dy * dy)
        if (dist < 0.01) { dx = 0.1; dy = 0.05; dist = 0.112 }
        const minDist = a.r + b.r + 4
        const push = dist < minDist ? (minDist - dist) * 0.6 : 0
        const repulse = (220 / (dist * dist)) * alpha
        const fx = (dx / dist) * (push + repulse)
        const fy = (dy / dist) * (push + repulse)
        a.x += fx; a.y += fy
        b.x -= fx; b.y -= fy
      }
    }
    for (const n of nodes) {
      n.x += (cx - n.x) * 0.012 * alpha
      n.y += (cy - n.y) * 0.012 * alpha
      n.x = Math.max(area.x + n.r, Math.min(area.x + area.w - n.r, n.x))
      n.y = Math.max(area.y + n.r, Math.min(area.y + area.h - n.r, n.y))
    }
  }
}

/** 关系图的节点集合：按 kind 归房 + 房内排布。 */
function layoutGraph(nodes: readonly CorridorNode[], boxes: readonly RoomBox[]): GraphNode[] {
  const byKind = new Map<string, RoomBox>(boxes.map(b => [b.kind, b]))
  const groups = new Map<string, GraphNode[]>()
  const out: GraphNode[] = []
  for (const n of nodes) {
    const box = byKind.get(n.kind)
    if (box === undefined) continue // 房间位不足 6 间时，溢出 kind 不画（与平面图同源的上限）
    const g: GraphNode = {
      id: n.id,
      kind: n.kind,
      status: n.status,
      title: n.title,
      content: n.content ?? n.title,
      r: graphRadius(n),
      x: 0,
      y: 0,
    }
    const list = groups.get(n.kind)
    if (list === undefined) groups.set(n.kind, [g])
    else list.push(g)
    out.push(g)
  }
  for (const [kind, list] of groups) {
    const box = byKind.get(kind)
    if (box !== undefined) layoutRoom(list, box)
  }
  return out
}

/** 按可用宽度截断文本（CJK 记 1 字宽，西文记 0.55 字宽）。 */
function fitText(text: string, maxWidth: number, fontSize: number): string {
  let used = 0
  let out = ''
  for (const ch of text) {
    const w = /[　-鿿＀-￯]/.test(ch) ? fontSize : fontSize * 0.55
    if (used + w > maxWidth) return `${out}…`
    used += w
    out += ch
  }
  return out
}

interface CorridorMapProps {
  readonly scope: 'user' | 'project' | 'shared'
  readonly nodes: readonly CorridorNode[]
  readonly edges: readonly CorridorEdge[]
  readonly onSelect?: (id: string) => void
  readonly selectedId?: string
  /** 界面文案（房间名与图例走宿主 locale 词典）。 */
  readonly t: CorridorT
  /** 点房间空白处 → 宿主接「陈展」按房筛选（与平面图同款手势）。 */
  readonly onOpenRoom?: (kind: string) => void
}

/** 走廊关系图：房间即锚点，边即关系。 */
export function CorridorMap(props: CorridorMapProps): ReactElement {
  const { scope, nodes, edges, onSelect, selectedId, t, onOpenRoom } = props
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [hoverRoom, setHoverRoom] = useState<string | null>(null)
  const boxes = useMemo(() => roomBoxes(nodes), [nodes])
  const positions = useMemo(() => layoutGraph(nodes, boxes), [nodes, boxes])
  const posMap = useMemo(() => new Map(positions.map(p => [p.id, p])), [positions])
  /** 邻居表：node id → 邻居 id 集合（含一跳）。 */
  const neighborMap = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const n of nodes) map.set(n.id, new Set())
    for (const e of edges) {
      if (!map.has(e.from)) map.set(e.from, new Set())
      if (!map.has(e.to)) map.set(e.to, new Set())
      map.get(e.from)!.add(e.to)
      map.get(e.to)!.add(e.from)
    }
    return map
  }, [nodes, edges])
  const hoverNeighbors = useMemo(() => {
    if (hoverId === null) return null
    return neighborMap.get(hoverId) ?? new Set<string>()
  }, [hoverId, neighborMap])
  const isFaded = (nId: string): boolean => hoverId !== null && nId !== hoverId && !(hoverNeighbors?.has(nId) ?? false)
  const isEdgeHighlighted = (e: CorridorEdge): boolean => hoverId !== null && (e.from === hoverId || e.to === hoverId)

  if (nodes.length === 0) {
    return <div className={styles.empty}>{t('corridorEmpty')}</div>
  }

  return (
    <div className={styles.mapWrap}>
      <svg viewBox={`0 0 ${String(PLAN_W)} ${String(PLAN_H)}`} className={`${styles.map} ${styles.mapFloorplan}`}
        preserveAspectRatio="xMidYMid meet" role="img" aria-label={t('corridorAria')} key={scope}>
        {/* 外墙 */}
        <rect x={6} y={6} width={PLAN_W - 12} height={PLAN_H - 12} rx={14}
          fill="var(--dsw-alias-bg-base)" stroke="var(--dsw-alias-border-l2)" strokeWidth={1.5} />
        {/* 中央主通道（与平面图同款） */}
        {hallStrip()}
        {/* 房间外壳 + 门牌（与平面图同款） */}
        {boxes.map(box => {
          const color = KIND_PALETTE[box.kind] ?? '#7d8590'
          const hovered = hoverRoom === box.kind
          return (
            <g key={box.kind} onMouseEnter={() => { setHoverRoom(box.kind) }}
              onMouseLeave={() => { setHoverRoom(prev => prev === box.kind ? null : prev) }}
              onClick={() => onOpenRoom?.(box.kind)}
              style={{ cursor: onOpenRoom === undefined ? 'default' : 'pointer' }}>
              {roomShell(box, color, hovered)}
              {roomPlate(box, color, t)}
            </g>
          )
        })}
        {/* 关系边：跨房间的线走走廊。高亮时画弹簧弧线，其他边保持直线。 */}
        {edges.map((edge, idx) => {
          const a = posMap.get(edge.from)
          const b = posMap.get(edge.to)
          if (a === undefined || b === undefined) return null
          const style = EDGE_STYLE[edge.type] ?? EDGE_STYLE.related!
          const highlighted = isEdgeHighlighted(edge)
          const faded = hoverId !== null && !highlighted
          const dx = b.x - a.x
          const dy = b.y - a.y
          const length = Math.sqrt(dx * dx + dy * dy) || 1
          // 垂直偏移：同对节点的多条边错开，避免叠成一条。
          const bow = Math.min(18, length * 0.12)
          const mx = (a.x + b.x) / 2 + (-dy / length) * bow
          const my = (a.y + b.y) / 2 + (dx / length) * bow
          return (
            <path key={edge.id} data-edge-id={edge.id} d={`M ${String(a.x)} ${String(a.y)} Q ${String(mx)} ${String(my)} ${String(b.x)} ${String(b.y)}`}
              fill="none" stroke={style.color}
              strokeWidth={highlighted ? style.width + 1.2 : style.width}
              strokeDasharray={style.dash}
              opacity={faded ? 0.08 : highlighted ? 1 : 0.55}
              className={styles.edgeFade}
              style={{ transition: 'opacity 200ms ease, stroke-width 200ms ease', animationDelay: `${String(Math.min(idx, 24) * 24)}ms` }}>
              <title>{`${a.title} --${edge.type}--> ${b.title}`}</title>
            </path>
          )
        })}
        {/* 主通道门牌：压在边之上，避免连线把字切碎 */}
        {hallLabel(t)}
        {/* 房间里的记忆点 */}
        {positions.map((n, index) => {
          const color = KIND_PALETTE[n.kind] ?? '#7d8590'
          const isSelected = selectedId === n.id
          const isHovered = hoverId === n.id
          const faded = isFaded(n.id)
          return (
            <g key={n.id} data-node-id={n.id} className={styles.node} transform={`translate(${String(n.x)} ${String(n.y)})`}
              style={{ opacity: faded ? 0.2 : 1, transition: 'opacity 200ms ease', animationDelay: `${String(Math.min(index, 24) * 24)}ms` }}
              onMouseEnter={() => { setHoverId(n.id) }}
              onMouseLeave={() => { setHoverId(prev => prev === n.id ? null : prev) }}
              onClick={() => onSelect?.(n.id)}>
              {(isHovered || isSelected) && (
                <circle r={String(n.r + 5)} fill={color} fillOpacity={0.22} />
              )}
              <circle r={String(n.r)} fill={color} fillOpacity={n.status === 'active' ? 0.9 : 0.45}
                stroke={isSelected ? 'var(--dsw-alias-brand-primary)' : isHovered ? color : 'rgba(255,255,255,0.9)'}
                strokeWidth={isSelected ? 2 : isHovered ? 1.5 : 1}
                style={{ transition: 'stroke 160ms ease, stroke-width 160ms ease' }}>
                <title>{`${n.title}（${n.kind}/${n.status}）`}</title>
              </circle>
            </g>
          )
        })}
        {/* hover 提示卡：房间名 + 完整铭牌 */}
        {hoverId !== null && (() => {
          const node = posMap.get(hoverId)
          if (node === undefined) return null
          const boxW = 210
          const boxH = 46
          const tx = Math.min(PLAN_W - boxW - 6, Math.max(6, node.x + 12))
          const ty = Math.min(PLAN_H - boxH - 6, Math.max(6, node.y - boxH - 8))
          return (
            <g className={styles.tooltip} transform={`translate(${String(tx)} ${String(ty)})`}>
              <rect x={0} y={0} width={boxW} height={boxH} rx={6} ry={6}
                fill="var(--dsw-alias-bg-base)" stroke="var(--dsw-alias-border-l2)" strokeWidth={1} opacity={0.96} />
              <text x={8} y={16} fill="var(--dsw-alias-label-primary)" fontSize="11" fontWeight={600}
                fontFamily="ui-sans-serif, system-ui">{roomLabel(t, node.kind)}</text>
              <text x={8} y={32} fill="var(--dsw-alias-label-secondary)" fontSize="10"
                fontFamily="ui-sans-serif, system-ui">{fitText(node.content, boxW - 16, 10)}</text>
            </g>
          )
        })()}
        {/* 零边提示：关系图的价值在边;无边时明说,不要让用户看一堆孤点。
            放在顶部空白带（不放正中——那里是旋转的主通道门牌）。 */}
        {edges.length === 0 && (
          <text x={String(PLAN_W / 2)} y="25" textAnchor="middle"
            fill="rgba(127,127,127,0.75)" fontSize="12" fontFamily="ui-sans-serif, system-ui">
            {t('corridorNoEdges')}
          </text>
        )}
      </svg>
    </div>
  )
}
