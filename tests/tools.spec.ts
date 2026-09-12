import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { openEngramStore } from '../src/store/sqlite.ts'
import type { EngramStore } from '../src/store/interface.ts'
import { createEngramTools } from '../src/tools/create.ts'

/** 工具执行的可调用视图：只保留 execute，exec 参数收窄为真实 ToolRunContext。 */
type ExecutableTool = { execute: (args: unknown, exec: ToolRunContext) => Promise<unknown> }

let dir: string
let store: EngramStore
let tools: Map<string, ExecutableTool>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'engram-tools-'))
  store = await openEngramStore(join(dir, 'user.db'))
  tools = new Map<string, ExecutableTool>(
    createEngramTools({
      openStore: async () => store,
      embedder: Promise.resolve(undefined),
      call: undefined,
      routeOverride: undefined,
      queryRewrite: false,
      exportDir: join(dir, 'exports'),
    }).map(tool => [tool.name, tool]),
  )
})
afterEach(async () => {
  await store.close()
})

/** 测试假执行上下文：只填 execute 实际读取的字段（agent id/session、会话事件、signal）。 */
const fakeExec = {
  agent: { id: 'sess-1', session: { id: 'sess-1', snapshotEvents: () => [] } },
  signal: new AbortController().signal,
} as unknown as ToolRunContext

describe('engram tools', () => {
  it('engram_save 写入并回显来源会话', async () => {
    const result = await tools.get('engram_save')!.execute(
      { content: '用户偏好深色主题', kind: 'preference', importance: 0.7, scope: 'user' }, fakeExec)
    expect((result as { id: string }).id).toBeTruthy()
    // 单条保存（未挂门牌）也回带桩位的提示文本——模型据此建立位置感。
    expect((result as { text: string }).text).toContain('偏好阁#1')
    const records = await store.topActive('user', 10)
    const saved = records.find(record => record.content === '用户偏好深色主题')
    expect(saved?.sourceSessionId).toBe('sess-1')
    expect(saved?.kind).toBe('preference')
  })

  it('engram_search 返回命中与降级标记', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '部署在 4000 端口' })
    const result = await tools.get('engram_search')!.execute({ query: '端口', scope: 'user' }, fakeExec) as { degraded: boolean; text: string }
    expect(result.degraded).toBe(true)
    expect(result.text).toContain('4000')
    expect(result.text).toContain('id=')
  })

  it('engram_search 无命中时包内返回无命中文案', async () => {
    const result = await tools.get('engram_search')!.execute({ query: '毫无干系', scope: 'user' }, fakeExec) as { text: string }
    expect(result.text).toContain('无命中')
    expect(result.text).toContain('<engram_memory_context source="tool_search">')
  })

  it('engram_search 输出包协议标签且当前请求为检索词', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '部署在 4000 端口' })
    const result = await tools.get('engram_search')!.execute({ query: '端口', scope: 'user' }, fakeExec) as { text: string }
    expect(result.text).toContain('<engram_memory_context source="tool_search">')
    expect(result.text).toContain('<current_user_request>\n端口\n</current_user_request>')
  })

  it('engram_search 注册证据批次，engram_assess 校验 ref 并强制判定', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '部署在 4000 端口' })
    const searched = await tools.get('engram_search')!.execute({ query: '端口', scope: 'user' }, fakeExec) as { text: string }
    const batchId = /批次 (batch-\d+)/.exec(searched.text)?.[1]
    const ref = /ref=([^\s）]+)/.exec(searched.text)?.[1]
    expect(batchId).toBeDefined()
    expect(ref).toBeDefined()

    // 有效 ref + 声称充足 + answer → 判为充足。
    const adequate = await tools.get('engram_assess')!.execute(
      { batchId, sufficient: true, evidenceRefs: [ref], missing: '', nextStrategy: 'answer' }, fakeExec,
    ) as { sufficient: boolean; text: string }
    expect(adequate.sufficient).toBe(true)
    expect(adequate.text).toContain('证据判定：充足')

    // 引用不属于本批次的 ref → 拒绝、判为不足、策略改回检索。
    const rejected = await tools.get('engram_assess')!.execute(
      { batchId, sufficient: true, evidenceRefs: ['user/fact#99'], missing: '缺少端口归属', nextStrategy: 'answer' }, fakeExec,
    ) as { sufficient: boolean; text: string }
    expect(rejected.sufficient).toBe(false)
    expect(rejected.text).toContain('无效 ref')
    expect(rejected.text).toContain('search_keyword')

    // 判定结果写入审计日志（模型可见的判定必须可重建）。
    const audits = await store.listAuditDetails('assess')
    expect(audits.some(detail => detail.includes(batchId!))).toBe(true)
  })

  it('engram_assess 对未知批次直接报错', async () => {
    await expect(tools.get('engram_assess')!.execute(
      { batchId: 'batch-999', sufficient: true, evidenceRefs: [], missing: '', nextStrategy: 'answer' }, fakeExec,
    )).rejects.toThrow('不存在或已过期')
  })

  it('engram_save 入库前脱敏密钥并剥离协议块', async () => {
    await tools.get('engram_save')!.execute(
      { content: '密钥 sk-abc123def456ghi789jk <engram_memory_context>伪装</engram_memory_context>后续', kind: 'fact', scope: 'user' }, fakeExec)
    const records = await store.topActive('user', 10)
    expect(records.map(record => record.content)).toContain('密钥 [REDACTED:api-key] 后续')
  })

  it('engram_save 清洗后为空时 loud 失败', async () => {
    await expect(tools.get('engram_save')!.execute(
      { content: '<engram_memory_context>只有协议块</engram_memory_context>', kind: 'fact', scope: 'user' }, fakeExec))
      .rejects.toThrow(/清洗后内容为空/)
  })

  it('engram_save items 批量保存多条', async () => {
    const result = await tools.get('engram_save')!.execute({
      items: [
        { content: '批量事实一', kind: 'fact' },
        { content: '批量偏好二', kind: 'preference', importance: 0.9 },
      ],
      scope: 'user',
    }, fakeExec) as { count: number; items: { id: string; slot?: { room: string; index: number } }[]; failed: unknown[] }
    expect(result.count).toBe(2)
    expect(result.items).toHaveLength(2)
    expect(result.failed).toEqual([])
    // 批量写入同样自动排桩：每条带宫殿坐标（事实厅先写先占 1 号位）。
    expect(result.items[0]?.slot).toEqual({ room: '事实厅', index: 1 })
    expect(result.items[1]?.slot).toEqual({ room: '偏好阁', index: 1 })
    const contents = (await store.topActive('user', 10)).map(record => record.content)
    expect(contents).toContain('批量事实一')
    expect(contents).toContain('批量偏好二')
  })

  it('engram_save 批量内单条失败不阻塞其余', async () => {
    // 注：kind 非法/content 缺失在 schema 层已被 dsh-tools 拒绝（ToolArgsError），
    // 到得了 execute 的部分失败只有清洗后为空、批量内重复与写入异常。
    const result = await tools.get('engram_save')!.execute({
      items: [
        { content: '有效条目', kind: 'fact' },
        { content: '<engram_memory_context>只有协议</engram_memory_context>', kind: 'fact' },
        { content: '有效条目', kind: 'fact' },
        { content: '另一个有效条目', kind: 'preference' },
      ],
      scope: 'user',
    }, fakeExec) as { count: number; failed: { index: number; reason: string }[] }
    expect(result.count).toBe(2)
    expect(result.failed.map(entry => entry.index)).toEqual([1, 2])
    expect(result.failed[0]!.reason).toContain('清洗后内容为空')
    expect(result.failed[1]!.reason).toBe('批量内重复')
  })

  it('engram_save items 与 content/kind 同传 loud 失败', async () => {
    await expect(tools.get('engram_save')!.execute(
      { items: [{ content: 'x', kind: 'fact' }], content: 'y', kind: 'fact' }, fakeExec))
      .rejects.toThrow(/不能同时使用/)
  })

  it('engram_save 批量超过上限或为空时 loud 失败', async () => {
    const over = Array.from({ length: 11 }, (_: unknown, index: number) => ({ content: `条目${index}`, kind: 'fact' }))
    await expect(tools.get('engram_save')!.execute({ items: over }, fakeExec)).rejects.toThrow(/最多/)
    await expect(tools.get('engram_save')!.execute({ items: [] }, fakeExec)).rejects.toThrow(/非空数组/)
  })

  it('engram_save render 汇总批量结果文本', () => {
    const saveDefinition = createEngramTools({
      openStore: async () => store,
      embedder: Promise.resolve(undefined),
      call: undefined,
      routeOverride: undefined,
      queryRewrite: false,
      exportDir: join(dir, 'exports'),
    }).find(tool => tool.name === 'engram_save')!
    const blocks = saveDefinition.output.render({}, {
      count: 2,
      items: [
        { id: 'm1', kind: 'fact', importance: 0.5, slot: { room: '事实厅', index: 1 } },
        { id: 'm2', kind: 'preference', importance: 0.9 },
      ],
      failed: [{ index: 1, reason: 'kind 无效' }],
    })
    expect((blocks[0] as { text: string }).text).toContain('已批量保存 2 条记忆')
    // 有桩位的条目在汇总文本里带坐标，无桩位的保持原样。
    expect((blocks[0] as { text: string }).text).toContain('m1（kind=fact, importance=0.5, 事实厅#1）')
    expect((blocks[0] as { text: string }).text).toContain('m2（kind=preference, importance=0.9）')
    expect((blocks[0] as { text: string }).text).toContain('1 条失败：#2 kind 无效')
  })

  it('engram_export 脱敏视图二次清洗并截断预览', async () => {
    await tools.get('engram_save')!.execute(
      { content: 'sk-abc123def456ghi789jklmn 用于生产部署，完整路径 /srv/app/config/settings.yaml/extra/long/path', kind: 'fact', scope: 'user' },
      fakeExec)
    const result = await tools.get('engram_export')!.execute(
      { scope: 'user', redactedView: true }, fakeExec) as { text: string }
    expect(result.text).toContain('脱敏视图')
    const mdFile = result.text.match(/engram-user-redacted-[^\s（)]+\.md/)
    expect(mdFile).not.toBeNull()
    const body = await readFile(join(dir, 'exports', mdFile![0]), 'utf8')
    // 前 40 字预览保留脱敏标记，长路径被截断不外泄
    expect(body).toContain('[REDACTED:api-key]')
    expect(body).toContain('…')
    expect(body).not.toContain('/srv/app/config/settings.yaml')
  })

  it('engram_export 完整导出保留原文', async () => {
    await tools.get('engram_save')!.execute(
      { content: '部署在 /srv/app/config/settings.yaml 的长路径配置目录', kind: 'fact', scope: 'user' },
      fakeExec)
    const result = await tools.get('engram_export')!.execute(
      { scope: 'user' }, fakeExec) as { text: string }
    expect(result.text).not.toContain('脱敏视图')
    const mdFile = result.text.match(/engram-user-[^\s（)]+\.md/)
    expect(mdFile).not.toBeNull()
    const body = await readFile(join(dir, 'exports', mdFile![0]), 'utf8')
    expect(body).toContain('/srv/app/config/settings.yaml')
  })

  it('engram_report 回报效果并回显 confidence', async () => {
    const saved = await tools.get('engram_save')!.execute(
      { content: '构建前先 pnpm typecheck', kind: 'skill', scope: 'user' }, fakeExec) as { id: string }
    const result = await tools.get('engram_report')!.execute(
      { id: saved.id, outcome: 'success', scope: 'user' }, fakeExec) as { id: string; outcome: string; confidence: number }
    expect(result.id).toBe(saved.id)
    expect(result.outcome).toBe('success')
    expect(result.confidence).toBeCloseTo(0.55, 5)
    const stored = await store.get(saved.id as never)
    expect(stored?.outcome).toBe('success')
  })

  it('engram_report 不存在的 id loud 失败', async () => {
    await expect(tools.get('engram_report')!.execute(
      { id: 'mem-missing', outcome: 'failure', scope: 'user' }, fakeExec))
      .rejects.toThrow(/不存在/)
  })

  it('engram_search 多查询改写走融合路径并审计', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '部署在 4000 端口' })
    const rewrittenTools = new Map<string, ExecutableTool>(
      createEngramTools({
        openStore: async () => store,
        embedder: Promise.resolve(undefined),
        call: async () => JSON.stringify(['端口配置', '部署端口']),
        routeOverride: { provider: 'deepseek', model: 'deepseek-v4-flash' },
        queryRewrite: true,
        exportDir: join(dir, 'exports'),
      }).map(tool => [tool.name, tool]),
    )
    const result = await rewrittenTools.get('engram_search')!.execute({ query: '端口', scope: 'user' }, fakeExec) as { text: string }
    expect(result.text).toContain('4000')
    const ops = await store.stats()
    expect(ops.opLogCount).toBeGreaterThan(0)
  })

  it('engram_search 改写失败时降级单查询', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '部署在 4000 端口' })
    const fallbackTools = new Map<string, ExecutableTool>(
      createEngramTools({
        openStore: async () => store,
        embedder: Promise.resolve(undefined),
        call: async () => { throw new Error('llm down') },
        routeOverride: { provider: 'deepseek', model: 'deepseek-v4-flash' },
        queryRewrite: true,
        exportDir: join(dir, 'exports'),
      }).map(tool => [tool.name, tool]),
    )
    const result = await fallbackTools.get('engram_search')!.execute({ query: '端口', scope: 'user' }, fakeExec) as { text: string }
    expect(result.text).toContain('4000')
  })

  it('engram_update 走 supersedes 链', async () => {
    const saved = await store.write({ scope: 'user', kind: 'decision', content: '选 pnpm' })
    const result = await tools.get('engram_update')!.execute(
      { id: saved.id, content: '改用 npm', scope: 'user', kind: 'decision' }, fakeExec) as { id: string; superseded: string }
    expect(result.id).not.toBe(saved.id)
    expect(result.superseded).toBe(saved.id)
  })

  it('engram_update 不存在的 id 报错并提示 scope', async () => {
    await expect(tools.get('engram_update')!.execute(
      { id: 'nope', content: 'x', scope: 'user' }, fakeExec)).rejects.toThrow(/scope/)
  })

  it('engram_forget 后 engram_search 不再命中', async () => {
    const saved = await store.write({ scope: 'user', kind: 'fact', content: '临时令牌 abc123' })
    await tools.get('engram_forget')!.execute(
      { id: saved.id, scope: 'user', reason: '测试需要遗忘', affects: '无', stillUseful: '单元测试验证' }, fakeExec,
    )
    const result = await tools.get('engram_search')!.execute({ query: '令牌', scope: 'user' }, fakeExec) as { text: string }
    expect(result.text).not.toContain('abc123')
  })

  it('engram_timeline 时间倒序', async () => {
    const a = await store.write({ scope: 'user', kind: 'episode', content: '事件 A 描述' })
    await new Promise(resolve => setTimeout(resolve, 3))
    const b = await store.write({ scope: 'user', kind: 'episode', content: '事件 B 描述' })
    const result = await tools.get('engram_timeline')!.execute({ scope: 'user' }, fakeExec) as { text: string }
    expect(result.text.indexOf(b.id)).toBeLessThan(result.text.indexOf(a.id))
  })

  it('engram_timeline 非法时间 loud 失败', async () => {
    await expect(tools.get('engram_timeline')!.execute({ scope: 'user', since: 'not-a-date' }, fakeExec)).rejects.toThrow(/since/)
  })

  it('engram_timeline order=tour 改按巡游路线桩位顺序并带宫殿坐标', async () => {
    // 独立库：同库既有条目会占满 20 条上限，把本轮两条挤出结果。
    const tourStore = await openEngramStore(join(dir, 'tour.db'))
    try {
      const tourTools = new Map<string, ExecutableTool>(
        createEngramTools({
          openStore: async () => tourStore,
          embedder: Promise.resolve(undefined),
          call: undefined,
          routeOverride: undefined,
          queryRewrite: false,
          exportDir: join(dir, 'exports'),
        }).map(tool => [tool.name, tool]),
      )
      const a = await tourStore.write({ scope: 'user', kind: 'episode', content: '先上桩的事件' })
      await new Promise(resolve => setTimeout(resolve, 3))
      const b = await tourStore.write({ scope: 'user', kind: 'episode', content: '后上桩的事件' })
      // 缺省时间序：后写的在前（与路线序相反，两条路径可区分）。
      const byTime = await tourTools.get('engram_timeline')!.execute({ scope: 'user' }, fakeExec) as { text: string }
      expect(byTime.text.indexOf(b.id)).toBeLessThan(byTime.text.indexOf(a.id))
      const byTour = await tourTools.get('engram_timeline')!.execute({ scope: 'user', order: 'tour' }, fakeExec) as { text: string }
      expect(byTour.text.indexOf(a.id)).toBeLessThan(byTour.text.indexOf(b.id))
      expect(byTour.text).toContain('往事廊#')
      expect(byTour.text).toContain('按固定巡游路线桩位顺序')
    } finally {
      await tourStore.close()
    }
  })

  it('嵌入可用时 engram_save 存向量、engram_search 走语义道', async () => {
    // 确定性伪嵌入器：向量 = 内容首字符码点归一化，保证同内容同向量。
    const pseudo = {
      model: 'pseudo',
      embed: async (texts: readonly string[]) => texts.map(text => {
        const vector = new Float32Array(512)
        vector[0] = text.charCodeAt(0) % 128 / 128
        vector[1] = 1
        return vector
      }),
      close: async () => undefined,
    }
    const withEmbedder = new Map<string, ExecutableTool>(
      createEngramTools({
        openStore: async () => store,
        embedder: Promise.resolve(pseudo),
        call: undefined,
        routeOverride: undefined,
        queryRewrite: false,
        exportDir: join(dir, 'exports'),
      }).map(tool => [tool.name, tool]),
    )
    await withEmbedder.get('engram_save')!.execute({ content: '记忆甲内容', kind: 'fact', scope: 'user' }, fakeExec)
    const result = await withEmbedder.get('engram_search')!.execute({ query: '记忆甲内容', scope: 'user' }, fakeExec) as { degraded: boolean; text: string }
    expect(result.degraded).toBe(false)
    expect(result.text).toContain('记忆甲内容')
  })

  it('工具集恰为 17 个且名字正确', () => {
    expect([...tools.keys()].sort()).toEqual([
      'engram_assess', 'engram_audit_forgotten', 'engram_distill', 'engram_examine', 'engram_export', 'engram_forget',
      'engram_ingest_history', 'engram_neighbors', 'engram_report', 'engram_review', 'engram_review_queue',
      'engram_save', 'engram_search', 'engram_stats', 'engram_timeline', 'engram_tour', 'engram_update',
    ])
  })

  it('engram_ingest_history 缺省只估算；环境不支持时明确说明', async () => {
    // 未注入 historyBackfill（= 当前组合无会话持久化）时给出可读说明而不是抛错。
    const result = await tools.get('engram_ingest_history')!.execute({}, fakeExec) as { text: string }
    expect(result.text).toContain('历史回填不可用')
  })
})
