/**
 * Markdown 镜像：把 SQLite 记忆库导出为可被 Obsidian / VS Code / git 直接漫游的
 * 文件树，每个房间一个 .md + frontmatter，附楼层清单 _meta.json 与全宫殿入口 _index.md。
 * 写入过程全部幂等：重复执行只会覆盖同名文件，不会向 SQLite 写任何东西（只读）。
 * @module @kenz1117/dsh-engram/mirror/markdown
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EngramScope } from '../types.ts'
import type { ExportData, MemoryEdge, MemoryRecord } from '../types.ts'

/** 房间铭牌 URL/路径安全的 slug（仅 ASCII、连字符分隔）。 */
function slugify(input: string): string {
  const stripped = input
    .toLowerCase()
    .replace(/[\u4e00-\u9fa5]+/g, '记')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return stripped === '' ? 'untitled' : stripped.slice(0, 32)
}

/** frontmatter 字段值序列化（string 原样、数字 / 布尔直接、null 空字符串）。 */
function yaml(value: unknown): string {
  if (value === null || value === undefined) return '""'
  if (typeof value === 'string') {
    const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', ' ')
    return `"${escaped}"`
  }
  return JSON.stringify(value)
}

/** ISO 时间戳（秒级，frontmatter 与 _meta 通用）。 */
function iso(ms: number): string {
  return new Date(ms).toISOString()
}

/** 楼层中文别名（与面板 i18n 的 kindLabel 保持一致；只用做目录名）。 */
const FLOOR_LABEL: Record<string, string> = {
  fact: 'fact',
  preference: 'preference',
  decision: 'decision',
  episode: 'episode',
  skill: 'skill',
}

/** 单房间 frontmatter 视图（暴露给 _meta.json 用，便于面板无须再读文件即可显示）。 */
export interface MirrorRoomMeta {
  readonly id: string
  readonly scope: EngramScope
  readonly kind: string
  readonly status: string
  readonly file: string
  readonly importance: number
  readonly confidence: number
  readonly createdAt: number
}

/** 楼层摘要（_meta.json 的 floors 项）。 */
export interface MirrorFloorSummary {
  readonly kind: string
  readonly roomCount: number
  readonly active: number
  readonly archived: number
  readonly forgotten: number
}

/** 镜像导出结果摘要（路由 / 工具返回用）。 */
export interface MirrorReport {
  readonly rootDir: string
  readonly fileCount: number
  readonly floors: readonly MirrorFloorSummary[]
  readonly exportedAt: number
}

/** 借阅归还清单的「借阅」项（scope=shared 的房间，对外可读）。 */
export interface SharedLoanEntry {
  readonly id: string
  readonly kind: string
  readonly status: string
  readonly importance: number
  readonly confidence: number
  readonly firstLentAt: number
  readonly lastAccessedAt: number
  readonly accessCount: number
}

/** P1-4 借阅归还审计清单：明确 scope=shared 的房间责任与访问痕迹。 */
export interface ShareManifest {
  readonly generatedAt: number
  readonly scope: 'shared'
  readonly roomCount: number
  readonly loans: readonly SharedLoanEntry[]
}

/** 顶层 _index.md 的纯文本模板（楼层卡片 + 房间清单链接）。 */
function renderIndex(scope: EngramScope, data: ExportData, floors: readonly MirrorFloorSummary[]): string {
  const total = data.records.length
  const active = data.records.filter(r => r.status === 'active').length
  const edges = data.edges.length
  const heading = `# 记忆宫殿 · ${scope === 'user' ? '私人宫殿' : '项目宫殿'}\n`
  const summary = [
    '',
    `> 导出时间 ${iso(data.exportedAt)} · 共 **${total}** 间房间（对外开放 ${active}） · 走廊 ${edges} 条`,
    '',
    '## 楼层导览',
    '',
    ...floors.map(f => `- **${FLOOR_LABEL[f.kind] ?? f.kind} 层** · ${f.roomCount} 间（开放 ${f.active} · 展厅 ${f.archived} · 闭馆 ${f.forgotten}）`),
    '',
    '## 房间清单',
    '',
    ...data.records
      .slice()
      .sort((a, b) => b.importance - a.importance)
      .map(record => `- [${record.status === 'active' ? '●' : record.status === 'archived' ? '◇' : '×'}][${FLOOR_LABEL[record.kind] ?? record.kind}] ${record.content.slice(0, 60)}${record.content.length > 60 ? '…' : ''} — [[${record.id.slice(0, 8)}]]`),
    '',
    '## 走廊（关系边）',
    '',
    ...(edges === 0 ? ['（暂无走廊）'] : data.edges.map(edge => `- \`${edge.from.slice(0, 8)}\` --${edge.type}--> \`${edge.to.slice(0, 8)}\``)),
    '',
  ].join('\n')
  return heading + summary
}

/** 单房间 .md 模板：YAML frontmatter + 铭牌正文 + 走廊列表。 */
function renderRoom(record: MemoryRecord, edges: readonly MemoryEdge[]): string {
  const relEdges = edges.filter(edge => edge.from === record.id || edge.to === record.id)
  const tags: string[] = []
  if (record.outcome !== undefined) tags.push(`outcome-${record.outcome}`)
  if (record.content.includes('[REDACTED:')) tags.push('redacted')
  const imagery = record.imagery
  const caption = imagery?.caption
  const sensory = imagery?.sensoryTags ?? []
  const frontmatter = [
    '---',
    `id: ${record.id}`,
    `scope: ${record.scope}`,
    `kind: ${record.kind}`,
    `status: ${record.status}`,
    `importance: ${record.importance.toFixed(3)}`,
    `confidence: ${record.confidence.toFixed(3)}`,
    `createdAt: "${iso(record.createdAt)}"`,
    `accessCount: ${record.accessCount}`,
    `sourceSession: ${record.sourceSessionId === null ? '""' : yaml(record.sourceSessionId)}`,
    `sourceRound: ${record.sourceRound ?? '""'}`,
    ...(tags.length === 0 ? [] : [`tags: [${tags.join(', ')}]`]),
    ...(caption !== undefined && caption !== null ? [`imageryCaption: ${yaml(caption)}`] : []),
    ...(sensory.length > 0 ? [`imagerySensory: [${sensory.map(s => yaml(s)).join(', ')}]`, `imageryValence: ${(imagery?.emotionalValence ?? 0).toFixed(3)}`] : []),
    '---',
  ].join('\n')
  const body = [
    `# ${record.content.split('\n')[0]?.slice(0, 80) ?? '房间铭牌'}`,
    '',
    record.content,
    '',
    '## 走廊',
    '',
    ...(relEdges.length === 0 ? ['（此房间暂未连接任何走廊）'] : relEdges.map(edge => {
      const other = edge.from === record.id ? edge.to : edge.from
      const direction = edge.from === record.id ? '→' : '←'
      return `- ${direction} \`${other.slice(0, 8)}\`（${edge.type}）`
    })),
    '',
  ].join('\n')
  return frontmatter + '\n' + body
}

/** 楼层 _meta.json 模板。 */
function renderMeta(scope: EngramScope, data: ExportData, floors: readonly MirrorFloorSummary[]): string {
  const payload = {
    scope,
    exportedAt: data.exportedAt,
    total: data.records.length,
    floors,
  }
  return JSON.stringify(payload, null, 2) + '\n'
}

/** 计算楼层摘要（按 kind 分组统计 active/archived/forgotten）。 */
function summarizeFloors(records: readonly MemoryRecord[]): MirrorFloorSummary[] {
  const map = new Map<string, { roomCount: number; active: number; archived: number; forgotten: number }>()
  for (const record of records) {
    const entry = map.get(record.kind) ?? { roomCount: 0, active: 0, archived: 0, forgotten: 0 }
    entry.roomCount += 1
    if (record.status === 'active') entry.active += 1
    else if (record.status === 'archived') entry.archived += 1
    else if (record.status === 'forgotten') entry.forgotten += 1
    map.set(record.kind, entry)
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, count]) => ({ kind, ...count }))
}

/**
 * 把一份 exportAll 数据写入镜像目录。
 * @param rootDir - 镜像根目录（通常 `${exportDir}/mirror/<scope>/`，由调用方拼）。
 * @param data - exportAll 的产物（含 records + edges）。
 * @returns 写入摘要（rootDir / fileCount / floors）。
 */
export async function writeMirror(rootDir: string, data: ExportData): Promise<MirrorReport> {
  const scope = (data.records[0]?.scope ?? 'user') as EngramScope
  await mkdir(rootDir, { recursive: true, mode: 0o700 })
  const floors = summarizeFloors(data.records)
  const recordsByKind = new Map<string, MemoryRecord[]>()
  for (const record of data.records) {
    const list = recordsByKind.get(record.kind) ?? []
    list.push(record)
    recordsByKind.set(record.kind, list)
  }
  let fileCount = 0
  for (const record of data.records) {
    const floor = recordsByKind.get(record.kind)
    if (floor === undefined) continue
    const indexInFloor = floor.indexOf(record)
    const floorDir = join(rootDir, FLOOR_LABEL[record.kind] ?? record.kind)
    await mkdir(floorDir, { recursive: true, mode: 0o700 })
    const fileName = `${record.id.slice(0, 8)}-${slugify(record.content)}-${String(indexInFloor).padStart(3, '0')}.md`
    await writeFile(join(floorDir, fileName), renderRoom(record, data.edges), { mode: 0o600 })
    fileCount += 1
  }
  await writeFile(join(rootDir, '_index.md'), renderIndex(scope, data, floors), { mode: 0o600 })
  await writeFile(join(rootDir, '_meta.json'), renderMeta(scope, data, floors), { mode: 0o600 })
  fileCount += 2
  // P1-4 借阅归还清单：scope=shared 时附 share-manifest.json。
  if (scope === 'shared') {
    const manifest = buildShareManifest(data)
    await writeFile(join(rootDir, 'share-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
    fileCount += 1
  }
  return { rootDir, fileCount, floors, exportedAt: data.exportedAt }
}

/**
 * 从导出数据构造借阅归还清单（仅 shared scope 调用）。
 * firstLentAt 用 createdAt 替代（数据库没记首次公开时刻，这是务实选择）。
 */
export function buildShareManifest(data: ExportData, now: number = Date.now()): ShareManifest {
  const loans: SharedLoanEntry[] = data.records
    .filter(record => record.scope === 'shared')
    .map(record => ({
      id: record.id,
      kind: record.kind,
      status: record.status,
      importance: record.importance,
      confidence: record.confidence,
      firstLentAt: record.createdAt,
      lastAccessedAt: record.lastAccessedAt,
      accessCount: record.accessCount,
    }))
  return { generatedAt: now, scope: 'shared', roomCount: loans.length, loans }
}
