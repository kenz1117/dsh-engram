import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openEngramStore } from '../src/store/sqlite.ts'
import { parseImportData, parseMarkdownExport } from '../src/store/import.ts'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { EngramStore } from '../src/store/interface.ts'
import { asEntityId, asMemoryId } from '../src/types.ts'
import type { ExportData, MemoryRecord } from '../src/types.ts'

let dir: string
let store: EngramStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'engram-import-'))
  store = await openEngramStore(join(dir, 'user.db'))
})

afterEach(async () => {
  await store.close()
})

/** 造一条导出形状的记录（id 固定以便跨用例断言）。 */
function recordOf(overrides: { id: string; content: string } & Omit<Partial<MemoryRecord>, 'id'>): MemoryRecord {
  const { id, ...rest } = overrides
  return {
    scope: 'user',
    kind: 'fact',
    importance: 0.6,
    confidence: 0.5,
    status: 'active',
    createdAt: 1_700_000_000_000,
    lastAccessedAt: 1_700_000_000_000,
    accessCount: 0,
    sourceSessionId: null,
    sourceRound: null,
    sourceSeq: null,
    ...rest,
    id: asMemoryId(id),
  }
}

describe('parseImportData 结构校验', () => {
  it('合法 payload 原样通过（含边与实体）', () => {
    const parsed = parseImportData({
      exportedAt: 1,
      records: [recordOf({ id: 'a', content: '内容' })],
      edges: [{ from: 'a', to: 'a', type: 'related', createdAt: 1 }],
      entities: [{ id: 'e1', name: '实体', kind: 'concept', aliases: [], createdAt: 1, updatedAt: 1 }],
    })
    expect(typeof parsed).toBe('object')
    if (typeof parsed !== 'string') {
      expect(parsed.records).toHaveLength(1)
      expect(parsed.edges).toHaveLength(1)
      expect(parsed.entities).toHaveLength(1)
    }
  })

  it('records 缺失 / 非法枚举 / 坏字段分别报错', () => {
    expect(typeof parseImportData({})).toBe('string')
    expect(typeof parseImportData({ records: [{ id: 'a' }] })).toBe('string')
    expect(typeof parseImportData({ records: [recordOf({ id: 'a', content: 'x', scope: 'bogus' as never })] })).toBe('string')
    expect(typeof parseImportData({ records: [recordOf({ id: 'a', content: 'x', kind: 'bogus' as never })] })).toBe('string')
    expect(typeof parseImportData({ records: [], edges: [{ from: 'a', to: 'b', type: 'bogus' as never, createdAt: 1 }] })).toBe('string')
    expect(typeof parseImportData({ records: [], entities: [{ id: 'e', name: 'n', kind: 'bogus' as never, aliases: [], createdAt: 1, updatedAt: 1 }] })).toBe('string')
  })
})

describe('store.importPreview / importData', () => {
  it('exportAll → importPreview：回灌自己的备份全部判 duplicate，预览与提交一致（零写入）', async () => {
    const saved = await store.write({ scope: 'user', kind: 'fact', content: '既有记忆一', importance: 0.7 })
    await store.linkEdge(saved.id, saved.id, 'related')
    const data = await store.exportAll()
    const preview = await store.importPreview(data)
    expect(preview.entries.every(entry => entry.classification === 'duplicate')).toBe(true)
    expect(preview.edgesDangling).toBe(0)
    const result = await store.importData(data)
    expect(result.imported).toBe(0)
    expect(result.skippedDuplicates).toBe(data.records.length)
  })

  it('new 条目导入保留 id 与全字段，向量置空；keepDuplicates=false 时内容全等重复跳过', async () => {
    const exported = recordOf({ id: 'n1', content: '迁移来的记忆', importance: 0.9, accessCount: 3, slot: { room: 'fact', index: 2 } })
    const preview = await store.importPreview({ exportedAt: 1, records: [exported], edges: [] })
    expect(preview.entries[0]?.classification).toBe('new')
    const result = await store.importData({ exportedAt: 1, records: [exported], edges: [] })
    expect(result.imported).toBe(1)
    const fetched = await store.get('n1' as never)
    expect(fetched?.content).toBe('迁移来的记忆')
    expect(fetched?.importance).toBe(0.9)
    expect(fetched?.accessCount).toBe(3)
    expect(fetched?.slot?.index).toBe(2)
    // 再导一次：内容全等 → duplicate 跳过
    const again = await store.importData({ exportedAt: 2, records: [exported], edges: [] })
    expect(again.imported).toBe(0)
    expect(again.skippedDuplicates).toBe(1)
  })

  it('import 的 importance/confidence 同样收口 [0,1]——对抗审查 P2：不能绕过入库闸', async () => {
    // 第三方导出/被污染的备份带着 importance: 42 进来，同样不得霸榜 topActive。
    const bad = recordOf({ id: 'n2', content: '越界导入', importance: 42, confidence: -1 })
    const result = await store.importData({ exportedAt: 1, records: [bad], edges: [] })
    expect(result.imported).toBe(1)
    const fetched = await store.get(asMemoryId('n2'))
    expect(fetched?.importance).toBe(1)
    expect(fetched?.confidence).toBe(0)
  })

  it('id 被占用且内容不同 → conflict 跳过；attachEmbeddings 回填向量', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '库内现行版本', importance: 0.5 })
    const all = await store.exportAll()
    const existingId = all.records[0]!.id
    const conflicting = recordOf({ id: existingId, content: '同 id 异内容（旧备份）' })
    const result = await store.importData({ exportedAt: 1, records: [conflicting], edges: [] })
    expect(result.imported).toBe(0)
    expect(result.conflicts).toBe(1)
    // attachEmbeddings 只更新已存在行
    const vector = new Float32Array(512).fill(0.1)
    expect(await store.attachEmbeddings([{ id: existingId, embedding: vector }])).toBe(1)
    expect(await store.attachEmbeddings([{ id: asMemoryId('missing-id'), embedding: vector }])).toBe(0)
  })

  it('边只在双端可落地时连入；悬挂边丢弃并计数', async () => {
    const a = recordOf({ id: 'edge-a', content: '端点甲' })
    const b = recordOf({ id: 'edge-b', content: '端点乙' })
    const ghost = recordOf({ id: 'ghost', content: '不导入的悬空端点' })
    const data: ExportData = {
      exportedAt: 1,
      records: [a, b, ghost],
      edges: [
        { from: asMemoryId('edge-a'), to: asMemoryId('edge-b'), type: 'related', createdAt: 1 },
        { from: asMemoryId('ghost'), to: asMemoryId('edge-a'), type: 'related', createdAt: 1 },
      ],
    }
    // 只选 edge-a/edge-b：ghost 不导入，其触及的第二条边悬挂
    const result = await store.importData(data, { selectedIds: ['edge-a', 'edge-b'].map(asMemoryId) })
    expect(result.imported).toBe(2)
    expect(result.edgesLinked).toBe(1)
    expect(result.edgesDangling).toBe(1)
    const preview = await store.importPreview(data)
    expect(preview.edgesTotal).toBe(2)
  })

  it('实体按 id 合并（别名并集），不产生重复词典项', async () => {
    await store.resolveEntities([{ name: '项目X', kind: 'project', aliases: ['PX'] }])
    const existing = (await store.listEntities({ limit: 10, offset: 0 })).items[0]!.entity
    const incoming = { ...existing, aliases: ['PX', '项目十', 'px-alias'] }
    const result = await store.importData({ exportedAt: 1, records: [], edges: [], entities: [incoming] })
    expect(result.entitiesMerged).toBe(1)
    expect(result.entitiesNew).toBe(0)
    const merged = (await store.listEntities({ limit: 10, offset: 0 })).items[0]!.entity
    expect(merged.aliases).toContain('项目十')
    expect(merged.aliases).toContain('PX')
    // 新实体直插
    const fresh = { ...incoming, id: asEntityId('fresh-entity'), name: '新实体' }
    const second = await store.importData({ exportedAt: 2, records: [], edges: [], entities: [fresh] })
    expect(second.entitiesNew).toBe(1)
  })

  it('engram_import 工具：dryRun 预览 + 正式提交 + 写文件定位坏路径', async () => {
    const { createEngramTools } = await import('../src/tools/create.ts')
    const payload: ExportData = {
      exportedAt: 1,
      records: [recordOf({ id: 'tool-1', content: '工具导入的记忆' })],
      edges: [],
    }
    const filePath = join(dir, 'engram-user-test.json')
    await writeFile(filePath, JSON.stringify(payload))
    const fakeExec = {
      agent: { id: 'sess-1', session: { id: 'sess-1', snapshotEvents: () => [] } },
      signal: new AbortController().signal,
    } as unknown as ToolRunContext
    const tools = createEngramTools({
      openStore: async () => store,
      resolveProjectStore: async () => store,
      embedder: Promise.resolve(undefined),
      call: undefined,
      routeOverride: undefined,
      queryRewrite: false,
      exportDir: dir,
      language: 'zh',
    })
    const importTool = tools.find(tool => tool.name === 'engram_import')
    expect(importTool).toBeDefined()
    // dryRun
    const dryRun = await importTool!.execute({ path: filePath, scope: 'user', dryRun: true }, fakeExec) as { text: string }
    expect(dryRun.text).toContain('1')
    // 正式提交
    const commit = await importTool!.execute({ path: filePath, scope: 'user' }, fakeExec) as { text: string }
    expect(commit.text).toContain('导入完成')
    expect(await store.get('tool-1' as never)).toBeDefined()
    // 坏路径 loud 失败
    await expect(importTool!.execute({ path: join(dir, 'nope.json'), scope: 'user' }, fakeExec)).rejects.toThrow()
  })
})

describe('parseMarkdownExport（导出 MD 回解析）', () => {
  // zh 行全角括号逗号、en 行半角带空格——两种导出语言都要能解析。
  const md = [
    '# dsh-engram 导出（user）',
    '',
    '- [active/fact] 中文内容（id=md-1，importance 0.8）',
    '- [archived/skill] english line (id=md-2, importance 0.4)',
    '',
    '## 关系边',
    '- md-1 --related--> md-2',
    '',
  ].join('\n')

  it('zh/en 行双兼容解析出 records + edges，缺省字段补齐', () => {
    const parsed = parseMarkdownExport(md, 'user')
    expect(typeof parsed).toBe('object')
    if (typeof parsed !== 'string') {
      expect(parsed.redacted).toBe(false)
      expect(parsed.data.records.map(record => record.id)).toEqual(['md-1', 'md-2'])
      expect(parsed.data.records[0]?.content).toBe('中文内容')
      expect(parsed.data.records[0]?.importance).toBe(0.8)
      expect(parsed.data.records[1]?.confidence).toBe(0.5)
      expect(parsed.data.edges).toEqual([{ from: 'md-1', to: 'md-2', type: 'related', createdAt: expect.any(Number) }])
    }
  })

  it('脱敏标记检测（zh/en 头部）', () => {
    const zh = parseMarkdownExport('# dsh-engram 导出（user，脱敏视图）\n', 'user')
    const en = parseMarkdownExport('# dsh-engram export (user, redacted view)\n', 'user')
    expect(typeof zh).toBe('object')
    expect(typeof en).toBe('object')
    if (typeof zh !== 'string') expect(zh.redacted).toBe(true)
    if (typeof en !== 'string') expect(en.redacted).toBe(true)
  })

  it('解析结果直接可入库（importData 消费）', async () => {
    const parsed = parseMarkdownExport(md, 'user')
    if (typeof parsed === 'string') throw new Error(parsed)
    const result = await store.importData(parsed.data)
    expect(result.imported).toBe(2)
    expect(result.edgesLinked).toBe(1)
    expect(await store.get(asMemoryId('md-1'))).toBeDefined()
  })

  it('工具按 .md 扩展名自动识别格式并导入', async () => {
    const { createEngramTools } = await import('../src/tools/create.ts')
    const mdPath = join(dir, 'engram-user.md')
    await writeFile(mdPath, md, 'utf8')
    const fakeExec = {
      agent: { id: 'sess-1', session: { id: 'sess-1', snapshotEvents: () => [] } },
      signal: new AbortController().signal,
    } as unknown as ToolRunContext
    const tools = createEngramTools({
      openStore: async () => store,
      resolveProjectStore: async () => store,
      embedder: Promise.resolve(undefined),
      call: undefined,
      routeOverride: undefined,
      queryRewrite: false,
      exportDir: dir,
      language: 'zh',
    })
    const importTool = tools.find(tool => tool.name === 'engram_import')
    expect(importTool).toBeDefined()
    const commit = await importTool!.execute({ path: mdPath, scope: 'user' }, fakeExec) as { text: string }
    expect(commit.text).toContain('导入完成')
    expect(await store.get(asMemoryId('md-2'))).toBeDefined()
  })
})
