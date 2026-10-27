/**
 * Markdown 镜像：把 SQLite 记忆库导出为可被 Obsidian / VS Code / git 直接漫游的
 * 文件树：按房间（kind）分目录，每条记忆一个 .md + frontmatter，附房间清单 _meta.json 与全宫殿入口 _index.md。
 * 写入过程全部幂等：重复执行只会覆盖同名文件，不会向 SQLite 写任何东西（只读）。
 * @module @kenz1117/dsh-engram/mirror/markdown
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EngramScope } from '../types.ts'
import type { ExportData, MemoryEdge, MemoryRecord } from '../types.ts'
import type { EngramLanguage } from '../i18n/language.ts'
import { roomLabel } from '../i18n/rooms.ts'
import { message, messageIn } from '../i18n/messages.ts'

/** 记忆铭牌 URL/路径安全的 slug（仅 ASCII、连字符分隔）。 */
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

/** 单条记忆的 frontmatter 视图（暴露给 _meta.json 用，便于面板无须再读文件即可显示）。 */
export interface MirrorMemoryMeta {
  readonly id: string
  readonly scope: EngramScope
  readonly kind: string
  readonly status: string
  readonly file: string
  readonly importance: number
  readonly confidence: number
  readonly createdAt: number
}

/** 房间摘要（_meta.json 的 rooms 项）：按 kind 分组的记忆统计。 */
export interface MirrorRoomSummary {
  readonly kind: string
  readonly memoryCount: number
  readonly active: number
  readonly archived: number
  readonly forgotten: number
}

/** 镜像导出结果摘要（路由 / 工具返回用）。 */
export interface MirrorReport {
  readonly rootDir: string
  readonly fileCount: number
  readonly rooms: readonly MirrorRoomSummary[]
  readonly exportedAt: number
}

/** 借阅归还清单的「借阅」项（scope=shared 的记忆，对外可读）。 */
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

/** P1-4 借阅归还审计清单：明确 scope=shared 的记忆责任与访问痕迹。 */
export interface ShareManifest {
  readonly generatedAt: number
  readonly scope: 'shared'
  readonly memoryCount: number
  readonly loans: readonly SharedLoanEntry[]
}

/** 顶层 _index.md 的纯文本模板（房间导览 + 记忆清单链接）。 */
function renderIndex(scope: EngramScope, data: ExportData, rooms: readonly MirrorRoomSummary[], language: EngramLanguage): string {
  const total = data.records.length
  const active = data.records.filter(r => r.status === 'active').length
  const edges = data.edges.length
  const heading = `${messageIn(language, 'misc.mirrorTitle', {
    palace: messageIn(language, scope === 'user' ? 'misc.mirrorPalacePersonal' : 'misc.mirrorPalaceProject'),
  })}\n`
  const summary = [
    '',
    messageIn(language, 'misc.mirrorSummary', { at: iso(data.exportedAt), total, active, edges }),
    '',
    messageIn(language, 'misc.mirrorRoomsHeading'),
    '',
    ...rooms.map(room => messageIn(language, 'misc.mirrorRoomLine', {
      room: roomLabel(room.kind, language),
      count: room.memoryCount,
      active: room.active,
      archived: room.archived,
      forgotten: room.forgotten,
    })),
    '',
    messageIn(language, 'misc.mirrorRecordsHeading'),
    '',
    ...data.records
      .slice()
      .sort((a, b) => b.importance - a.importance)
      .map(record => `- [${record.status === 'active' ? '●' : record.status === 'archived' ? '◇' : '×'}][${roomLabel(record.kind, language)}] ${record.content.slice(0, 60)}${record.content.length > 60 ? '…' : ''} — [[${record.id.slice(0, 8)}]]`),
    '',
    messageIn(language, 'misc.mirrorCorridorsHeading'),
    '',
    ...(edges === 0 ? [messageIn(language, 'misc.mirrorNoCorridors')] : data.edges.map(edge => `- \`${edge.from.slice(0, 8)}\` --${edge.type}--> \`${edge.to.slice(0, 8)}\``)),
    '',
  ].join('\n')
  return heading + summary
}

/** 单条记忆 .md 模板：YAML frontmatter + 铭牌正文 + 走廊列表。 */
function renderMemory(record: MemoryRecord, edges: readonly MemoryEdge[]): string {
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
    `# ${record.content.split('\n')[0]?.slice(0, 80) ?? message('misc.mirrorUntitled')}`,
    '',
    record.content,
    '',
    message('misc.mirrorCorridorSection'),
    '',
    ...(relEdges.length === 0 ? [message('misc.mirrorNoEdges')] : relEdges.map(edge => {
      const other = edge.from === record.id ? edge.to : edge.from
      const direction = edge.from === record.id ? '→' : '←'
      return message('misc.mirrorEdgeLine', { direction, id: other.slice(0, 8), type: edge.type })
    })),
    '',
  ].join('\n')
  return `${frontmatter}\n${body}`
}

/** 房间清单 _meta.json 模板。 */
function renderMeta(scope: EngramScope, data: ExportData, rooms: readonly MirrorRoomSummary[]): string {
  const payload = {
    scope,
    exportedAt: data.exportedAt,
    total: data.records.length,
    rooms,
  }
  return `${JSON.stringify(payload, null, 2)}\n`
}

/** 计算房间摘要（按 kind 分组统计 active/archived/forgotten 的记忆条数）。 */
function summarizeRooms(records: readonly MemoryRecord[]): MirrorRoomSummary[] {
  const map = new Map<string, { memoryCount: number; active: number; archived: number; forgotten: number }>()
  for (const record of records) {
    const entry = map.get(record.kind) ?? { memoryCount: 0, active: 0, archived: 0, forgotten: 0 }
    entry.memoryCount += 1
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
 * @param language - 房间名的显示语言（目录名仍用 kind 原值，保持路径跨语言稳定）。
 * @returns 写入摘要（rootDir / fileCount / rooms）。
 */
export async function writeMirror(rootDir: string, data: ExportData, language: EngramLanguage): Promise<MirrorReport> {
  const scope = (data.records[0]?.scope ?? 'user') as EngramScope
  await mkdir(rootDir, { recursive: true, mode: 0o700 })
  const rooms = summarizeRooms(data.records)
  const recordsByKind = new Map<string, MemoryRecord[]>()
  for (const record of data.records) {
    const list = recordsByKind.get(record.kind) ?? []
    list.push(record)
    recordsByKind.set(record.kind, list)
  }
  let fileCount = 0
  for (const record of data.records) {
    const roomRecords = recordsByKind.get(record.kind)
    if (roomRecords === undefined) continue
    const indexInRoom = roomRecords.indexOf(record)
    // 目录名用 kind 原值（英文），保证跨语言与跨次导出路径稳定。
    const roomDir = join(rootDir, record.kind)
    await mkdir(roomDir, { recursive: true, mode: 0o700 })
    const fileName = `${record.id.slice(0, 8)}-${slugify(record.content)}-${String(indexInRoom).padStart(3, '0')}.md`
    await writeFile(join(roomDir, fileName), renderMemory(record, data.edges), { mode: 0o600 })
    fileCount += 1
  }
  await writeFile(join(rootDir, '_index.md'), renderIndex(scope, data, rooms, language), { mode: 0o600 })
  await writeFile(join(rootDir, '_meta.json'), renderMeta(scope, data, rooms), { mode: 0o600 })
  fileCount += 2
  // P1-4 借阅归还清单：scope=shared 时附 share-manifest.json。
  if (scope === 'shared') {
    const manifest = buildShareManifest(data)
    await writeFile(join(rootDir, 'share-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
    fileCount += 1
  }
  return { rootDir, fileCount, rooms, exportedAt: data.exportedAt }
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
  return { generatedAt: now, scope: 'shared', memoryCount: loans.length, loans }
}
