import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeMirror } from '../src/mirror/markdown.ts'
import { openEngramStore } from '../src/store/sqlite.ts'
import type { EngramStore } from '../src/store/interface.ts'

let dir: string
let store: EngramStore
let mirrorRoot: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'engram-mirror-'))
  store = await openEngramStore(join(dir, 'user.db'))
  mirrorRoot = join(dir, 'mirror')
})

afterEach(async () => {
  await store.close()
})

describe('Markdown 镜像导出', () => {
  it('每条记忆生成一个 .md：含 frontmatter、铭牌正文、走廊列表', async () => {
    const a = await store.write({ scope: 'user', kind: 'fact', content: '部署端口是 4000', importance: 0.7, confidence: 0.8 })
    const b = await store.write({ scope: 'user', kind: 'preference', content: '偏好简体中文界面', importance: 0.6, confidence: 0.7 })
    await store.linkEdge(a.id, b.id, 'related')
    const data = await store.exportAll()
    const report = await writeMirror(mirrorRoot, data)
    expect(report.fileCount).toBe(2 + 2) // 2 memories + _index.md + _meta.json
    expect(report.rooms).toHaveLength(2)

    // fact 房间：应有 a 的文件
    const factDir = join(mirrorRoot, 'fact')
    const factFiles = await readdir(factDir)
    expect(factFiles).toHaveLength(1)
    const factContent = await readFile(join(factDir, factFiles[0]!), 'utf8')
    expect(factContent).toContain('id: ' + a.id)
    expect(factContent).toContain('kind: fact')
    expect(factContent).toContain('importance: 0.700')
    expect(factContent).toContain('部署端口是 4000')
    expect(factContent).toContain('走廊')
    expect(factContent).toContain(b.id.slice(0, 8))
    expect(factContent).toContain('related')

    // preference 房间：应有 b 的文件
    const prefDir = join(mirrorRoot, 'preference')
    const prefFiles = await readdir(prefDir)
    expect(prefFiles).toHaveLength(1)
    const prefContent = await readFile(join(prefDir, prefFiles[0]!), 'utf8')
    expect(prefContent).toContain('偏好简体中文界面')
    expect(prefContent).toContain(a.id.slice(0, 8)) // 走廊条目
  })

  it('_index.md 含房间导览 + 记忆清单 + 走廊汇总', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '事实一', importance: 0.9 })
    await store.write({ scope: 'user', kind: 'fact', content: '事实二', importance: 0.4 })
    await store.write({ scope: 'user', kind: 'episode', content: '事件一', importance: 0.6 })
    const report = await writeMirror(mirrorRoot, await store.exportAll())
    const index = await readFile(join(mirrorRoot, '_index.md'), 'utf8')
    expect(index).toContain('# 记忆宫殿 · 私人宫殿')
    expect(index).toContain('## 房间导览')
    expect(index).toContain('**事实厅** · 2 条记忆')
    expect(index).toContain('**往事廊** · 1 条记忆')
    expect(index).toContain('## 记忆清单')
    expect(index).toContain('## 走廊（关系边）')
    expect(report.exportedAt).toBeGreaterThan(0)
  })

  it('_meta.json 含房间汇总与总数，可被面板二次消费', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '活跃', importance: 0.5 })
    const forgotten = await store.write({ scope: 'user', kind: 'fact', content: '已闭馆', importance: 0.5 })
    await store.forget(forgotten.id)
    await writeMirror(mirrorRoot, await store.exportAll())
    const meta = JSON.parse(await readFile(join(mirrorRoot, '_meta.json'), 'utf8')) as {
      scope: string
      total: number
      rooms: Array<{ kind: string; memoryCount: number; active: number; archived: number; forgotten: number }>
    }
    expect(meta.scope).toBe('user')
    expect(meta.total).toBe(2)
    const fact = meta.rooms.find(room => room.kind === 'fact')!
    expect(fact.memoryCount).toBe(2)
    expect(fact.active).toBe(1)
    expect(fact.forgotten).toBe(1)
  })

  it('空宫殿也能正常写镜像（_index.md + _meta.json + 0 房间）', async () => {
    const report = await writeMirror(mirrorRoot, await store.exportAll())
    expect(report.fileCount).toBe(2)
    expect(report.rooms).toEqual([])
    const meta = JSON.parse(await readFile(join(mirrorRoot, '_meta.json'), 'utf8')) as { total: number }
    expect(meta.total).toBe(0)
  })

  it('镜像文件名为 `<id8>-<slug>-<idx>.md`，id 前 8 位稳定前缀', async () => {
    const r = await store.write({ scope: 'user', kind: 'skill', content: 'Rust 所有权：所有权 + 借用检查器', importance: 0.8 })
    await writeMirror(mirrorRoot, await store.exportAll())
    const skillDir = join(mirrorRoot, 'skill')
    const files = await readdir(skillDir)
    expect(files).toHaveLength(1)
    expect(files[0]!.startsWith(r.id.slice(0, 8))).toBe(true)
    expect(files[0]!.endsWith('-000.md')).toBe(true)
  })
})
