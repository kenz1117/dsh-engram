/**
 * 导入 payload 的结构校验（engram_import 工具与面板 POST /api/engram/import 共用）。
 * 只做结构/枚举校验与字段裁剪，不触库；语义层面的去重分类在 store.importData。
 * @module @kenz1117/dsh-engram/store/import
 */

import type { EngramEmbedder } from '../embedder/interface.ts'
import { asEntityId, asMemoryId } from '../types.ts'
import type { EngramScope, EngramEdgeType, EngramKind, EngramStatus, EntityRecord, ExportData, MemoryEdge, MemoryId, MemoryRecord } from '../types.ts'
import type { EngramStore } from './interface.ts'

const SCOPES: readonly EngramScope[] = ['user', 'project', 'shared']
const KINDS: readonly EngramKind[] = ['fact', 'preference', 'decision', 'episode', 'skill']
const STATUSES: readonly EngramStatus[] = ['active', 'archived', 'forgotten']
const EDGE_TYPES: readonly EngramEdgeType[] = ['supports', 'contradicts', 'refines', 'related', 'supersedes']

type Json = Record<string, unknown>

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): v is T => isStr(v) && (allowed as readonly string[]).includes(v)

const parseRecord = (raw: unknown, index: number): MemoryRecord | string => {
  if (!isObj(raw)) return `records[${index}] 不是对象`
  const id = raw.id
  if (!isStr(id) || id.trim() === '') return `records[${index}].id 缺失或为空`
  const content = raw.content
  if (!isStr(content)) return `records[${index}].content 不是字符串`
  if (!oneOf(raw.scope, SCOPES)) return `records[${index}].scope 非法：${JSON.stringify(raw.scope)}`
  if (!oneOf(raw.kind, KINDS)) return `records[${index}].kind 非法：${JSON.stringify(raw.kind)}`
  if (!oneOf(raw.status, STATUSES)) return `records[${index}].status 非法：${JSON.stringify(raw.status)}`
  const importance = raw.importance
  const confidence = raw.confidence
  const createdAt = raw.createdAt
  const lastAccessedAt = raw.lastAccessedAt
  const accessCount = raw.accessCount
  if (!isNum(importance)) return `records[${index}].importance 不是有限数字`
  if (!isNum(confidence)) return `records[${index}].confidence 不是有限数字`
  if (!isNum(createdAt)) return `records[${index}].createdAt 不是有限数字`
  if (!isNum(lastAccessedAt)) return `records[${index}].lastAccessedAt 不是有限数字`
  if (!isNum(accessCount)) return `records[${index}].accessCount 不是有限数字`
  if (raw.outcome !== undefined && raw.outcome !== null && !oneOf(raw.outcome, ['success', 'failure'] as const)) {
    return `records[${index}].outcome 非法：${JSON.stringify(raw.outcome)}`
  }
  const slot = raw.slot
  if (slot !== undefined && slot !== null
    && !(isObj(slot) && isStr(slot.room) && slot.room !== '' && isNum(slot.index))) {
    return `records[${index}].slot 非法`
  }
  const review = raw.review
  if (review !== undefined && review !== null
    && !(isObj(review) && (review.nextReviewAt === null || isNum(review.nextReviewAt))
      && isNum(review.easeFactor) && isNum(review.intervalDays) && isNum(review.reps))) {
    return `records[${index}].review 非法`
  }
  const imagery = raw.imagery
  if (imagery !== undefined && imagery !== null
    && !(isObj(imagery) && isStr(imagery.caption) && Array.isArray(imagery.sensoryTags)
      && isNum(imagery.emotionalValence) && typeof imagery.provisional === 'boolean')) {
    return `records[${index}].imagery 非法`
  }
  return {
    id: asMemoryId(id),
    memoryId: asMemoryId(isStr(raw.memoryId) && raw.memoryId !== '' ? raw.memoryId : id),
    scope: raw.scope,
    kind: raw.kind,
    content,
    importance,
    confidence,
    status: raw.status,
    ...(raw.outcome === 'success' || raw.outcome === 'failure' ? { outcome: raw.outcome } : {}),
    createdAt,
    lastAccessedAt,
    accessCount,
    sourceSessionId: raw.sourceSessionId === null ? null : isStr(raw.sourceSessionId) ? raw.sourceSessionId : null,
    sourceRound: isNum(raw.sourceRound) ? raw.sourceRound : null,
    sourceSeq: isNum(raw.sourceSeq) ? raw.sourceSeq : null,
    ...(isObj(raw.imagery) && isStr(raw.imagery.caption) && Array.isArray(raw.imagery.sensoryTags)
      && isNum(raw.imagery.emotionalValence) && typeof raw.imagery.provisional === 'boolean' ? {
      imagery: {
        caption: raw.imagery.caption,
        sensoryTags: raw.imagery.sensoryTags.filter(isStr),
        emotionalValence: raw.imagery.emotionalValence,
        provisional: raw.imagery.provisional,
      },
    } : {}),
    ...(isObj(raw.slot) && isStr(raw.slot.room) && isNum(raw.slot.index) ? { slot: { room: raw.slot.room, index: raw.slot.index } } : {}),
    ...(isNum(raw.imageryScore) ? { imageryScore: raw.imageryScore } : {}),
    ...(isObj(raw.review) && isNum(raw.review.easeFactor) && isNum(raw.review.intervalDays) && isNum(raw.review.reps) ? {
      review: {
        nextReviewAt: isNum(raw.review.nextReviewAt) ? raw.review.nextReviewAt : null,
        easeFactor: raw.review.easeFactor,
        intervalDays: raw.review.intervalDays,
        reps: raw.review.reps,
      },
    } : {}),
  } satisfies MemoryRecord
}

const parseEdge = (raw: unknown, index: number): MemoryEdge | string => {
  if (!isObj(raw)) return `edges[${index}] 不是对象`
  if (!isStr(raw.from) || !isStr(raw.to)) return `edges[${index}].from/to 缺失`
  if (!oneOf(raw.type, EDGE_TYPES)) return `edges[${index}].type 非法：${JSON.stringify(raw.type)}`
  if (!isNum(raw.createdAt)) return `edges[${index}].createdAt 不是有限数字`
  return { from: asMemoryId(raw.from), to: asMemoryId(raw.to), type: raw.type, createdAt: raw.createdAt }
}

const parseEntity = (raw: unknown, index: number): EntityRecord | string => {
  if (!isObj(raw)) return `entities[${index}] 不是对象`
  if (!isStr(raw.id) || raw.id.trim() === '') return `entities[${index}].id 缺失或为空`
  if (!isStr(raw.name) || raw.name.trim() === '') return `entities[${index}].name 缺失或为空`
  if (!oneOf(raw.kind, ['person', 'project', 'tool', 'concept', 'other'] as const)) {
    return `entities[${index}].kind 非法：${JSON.stringify(raw.kind)}`
  }
  if (!Array.isArray(raw.aliases) || !raw.aliases.every(isStr)) return `entities[${index}].aliases 不是字符串数组`
  const entityCreatedAt = raw.createdAt
  const entityUpdatedAt = raw.updatedAt
  if (!isNum(entityCreatedAt)) return `entities[${index}].createdAt 不是有限数字`
  if (!isNum(entityUpdatedAt)) return `entities[${index}].updatedAt 不是有限数字`
  return {
    id: asEntityId(raw.id),
    name: raw.name,
    kind: raw.kind,
    aliases: raw.aliases,
    createdAt: entityCreatedAt,
    updatedAt: entityUpdatedAt,
  } satisfies EntityRecord
}

/**
 * 校验并裁剪导入 payload。返回 string = 首个校验错误（调用方原样呈现给用户）。
 * 空文件（records 为空数组）合法——预览为空、提交零写入。
 */
export function parseImportData(raw: unknown): ExportData | string {
  if (!isObj(raw)) return '文件顶层不是 JSON 对象（顶层须是 {"records": [...]}；若文件本身就是数组，请包成 {"records": 数组}）'
  if (!Array.isArray(raw.records)) return 'records 不是数组（不是 dsh-engram 导出文件？）'
  if (raw.edges !== undefined && !Array.isArray(raw.edges)) return 'edges 不是数组'
  if (raw.entities !== undefined && !Array.isArray(raw.entities)) return 'entities 不是数组'
  const records: MemoryRecord[] = []
  for (let i = 0; i < raw.records.length; i++) {
    const parsed = parseRecord(raw.records[i], i)
    if (typeof parsed === 'string') return parsed
    records.push(parsed)
  }
  const edgeList: unknown[] = Array.isArray(raw.edges) ? raw.edges : []
  const entityList: unknown[] = Array.isArray(raw.entities) ? raw.entities : []
  const edges: MemoryEdge[] = []
  for (let i = 0; i < edgeList.length; i++) {
    const parsed = parseEdge(edgeList[i], i)
    if (typeof parsed === 'string') return parsed
    edges.push(parsed)
  }
  const entities: EntityRecord[] = []
  for (let i = 0; i < entityList.length; i++) {
    const parsed = parseEntity(entityList[i], i)
    if (typeof parsed === 'string') return parsed
    entities.push(parsed)
  }
  return {
    exportedAt: isNum(raw.exportedAt) ? raw.exportedAt : Date.now(),
    records,
    edges,
    ...(entities.length > 0 ? { entities } : {}),
  }
}

/** 就地补嵌入的单批大小：导出格式不携带向量，导入后分批补齐，单批失败不拖垮整批。 */
const EMBED_BATCH_SIZE = 32

/**
 * 导出 Markdown 的回解析（engram_export format=markdown 的产物 → ExportData）。
 * 有损恢复：MD 行只携带 status/kind/content/id/importance（记录）与 from/type/to（边），
 * 其余字段取缺省（confidence 0.5、时间取当前、accessCount 0）。不匹配导出行格式的行静默跳过。
 * 头部带脱敏标记（zh/en/ru 三语）时返回 redacted=true——调用方应提示用户内容是截断预览。
 */
export function parseMarkdownExport(raw: string, scope: EngramScope): { data: ExportData; redacted: boolean } | string {
  const at = Date.now()
  // 记录行：'- [status/kind] content（id=…，importance …）'（zh 全角括号无空格 / en、ru 半角带空格，双兼容）。
  const recordRe = /^- \[([a-z]+)\/([a-z]+)\] (.*[^\s])?\s*[（(]id=([^，()\s]+)[，,]\s*importance ([0-9.]+)[)）]\s*$/
  const edgeRe = /^- (\S+) --([a-z]+)--> (\S+)\s*$/
  const headerRe = /^#\s*(?:dsh-engram\s*导出|dsh-engram\s*export|Экспорт\s*dsh-engram)\s*[（(](.*)[)）]\s*$/
  const edgesHeadingRe = /^##\s*(?:关系边|Relation edges|Связи)\s*$/
  let redacted = false
  let inEdges = false
  const records: MemoryRecord[] = []
  const edges: MemoryEdge[] = []
  for (const line of raw.split(/\r?\n/)) {
    const header = headerRe.exec(line)
    if (header !== null) {
      const label = header[1] ?? ''
      redacted = label.includes('脱敏视图') || label.includes('redacted view') || label.includes('обезличенный')
      continue
    }
    if (edgesHeadingRe.test(line)) {
      inEdges = true
      continue
    }
    if (inEdges) {
      const edge = edgeRe.exec(line)
      if (edge === null) continue
      const from = edge[1]
      const type = edge[2]
      const to = edge[3]
      if (from === undefined || to === undefined || !oneOf(type, EDGE_TYPES)) continue
      edges.push({ from: asMemoryId(from), to: asMemoryId(to), type, createdAt: at })
      continue
    }
    const record = recordRe.exec(line)
    if (record === null) continue
    const status = record[1]
    const kind = record[2]
    const content = record[3]
    const id = record[4]
    const importanceRaw = record[5]
    if (status === undefined || kind === undefined || content === undefined || content === ''
      || id === undefined || id === '' || importanceRaw === undefined) continue
    if (!oneOf(status, STATUSES) || !oneOf(kind, KINDS)) continue
    const importance = Number(importanceRaw)
    if (!Number.isFinite(importance)) continue
    records.push({
      id: asMemoryId(id),
      memoryId: asMemoryId(id),
      scope,
      kind,
      content,
      importance,
      confidence: 0.5,
      status,
      createdAt: at,
      lastAccessedAt: at,
      accessCount: 0,
      sourceSessionId: null,
      sourceRound: null,
      sourceSeq: null,
    })
  }
  return {
    data: {
      exportedAt: at,
      records,
      edges,
    },
    redacted,
  }
}

/**
 * 导入后就地补嵌入（engram_import 工具与面板导入路由共用）：按批嵌入导入条目并经
 * store.attachEmbeddings 回填。嵌入器不可用返回 0；单批失败只跳过该批不中断。
 */
export async function embedImportedRecords(
  store: EngramStore,
  embedder: EngramEmbedder | undefined,
  importedIds: readonly MemoryId[],
): Promise<number> {
  if (embedder === undefined || importedIds.length === 0) return 0
  const records = await store.getMany(importedIds)
  let embedded = 0
  for (let i = 0; i < records.length; i += EMBED_BATCH_SIZE) {
    const batch = records.slice(i, i + EMBED_BATCH_SIZE)
    try {
      const vectors = await embedder.embed(batch.map(record => record.content))
      const attached = batch
        .map((record, position) => ({ id: record.id, embedding: vectors[position] }))
        .filter((entry): entry is { id: MemoryId; embedding: Float32Array } => entry.embedding !== undefined)
      embedded += await store.attachEmbeddings(attached)
    } catch {
      // 单批嵌入失败：该批留空向量，可由后续导入或补嵌入路径覆盖。
    }
  }
  return embedded
}
