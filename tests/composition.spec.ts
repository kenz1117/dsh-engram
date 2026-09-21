/**
 * REAL-composition coverage：测试用 cordis.yml 经真实 Loader 装载
 * webserver + system-prompt + tools + llm 替身 + dsh-engram，HTTP 断言
 * 管理页与 /api/engram/* 全链路（列表/统计/修正/遗忘/导出/复习队列/回环写守卫），
 * 以及 15 个工具注册与 fiber 卸载（HMR 安全）。替身只用于外部网络
 *（fetch 一律拒绝，嵌入器立即降级——降级路径本身是被测行为的一部分）
 * 与 llm 辅助调用端点。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { openEngramStore } from '../src/store/sqlite.ts'
import { markPendingIngest } from '../src/ingest/hook.ts'
import { readMigrationPointer, resolveProjectIdentity } from '../src/project/identity.ts'
import * as Engram from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

beforeEach(() => {
  // 外网一律拒绝（嵌入模型下载立即失败，插件按设计降级）；本地回环放行给 API 断言用 fetch。
  const realFetch = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.startsWith('http://127.0.0.1')) return realFetch(input, init)
    throw new Error(`offline in test: ${url}`)
  }))
})

afterEach(async () => {
  await context?.fiber?.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** 记录 llm 替身收到的调用参数（断言辅助调用的路由归属）。 */
const llmCalls: { route?: unknown }[] = []

/** llm 服务替身：辅助调用端点存在但不可用（摄取/蒸馏运行时失败路径不属于本测试）。 */
const llmDouble = {
  name: 'test-engram-llm',
  apply(ctx: Context): void {
    ctx.provide('llm', {
      stream: async function* (params: { route?: unknown }) {
        llmCalls.push(params)
        throw new Error('llm offline in test')
      },
      // 模型清单（面板「辅助模型」下拉的数据源）。
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'deepseek-v4', name: 'DeepSeek V4' }],
    } as never)
  },
}

const EXPECTED_TOOLS = [
  'engram_assess', 'engram_audit_forgotten', 'engram_distill', 'engram_episode_timeline', 'engram_examine',
  'engram_export', 'engram_facts', 'engram_forget', 'engram_ingest_history', 'engram_neighbors', 'engram_profile_edit',
  'engram_report', 'engram_review', 'engram_review_queue', 'engram_save', 'engram_search', 'engram_stats',
  'engram_timeline', 'engram_tour', 'engram_update',
]

/** 预置到 user 库的待补做摄取键（跨会话 pending 重放用例用）。 */
interface PendingSeed {
  readonly sessionId: string
  readonly turn: number
}

/** 会话持久化替身：新版 dsh 的句柄式 API（`list()` 给快照，日志经 `open(id,'read')` 句柄读，
 *  句柄带 header —— 补做轮次据此决定写进哪座项目宫殿）。
 *  calls 记录每次 open 及其句柄用量，用于断言「跨会话读取确实走宿主服务」。 */
function makePersistenceDouble(
  header: { id: string; createdAt: number; cwd: string },
  events: readonly unknown[],
  calls: { id: string; access: string; reads: number; closed: boolean }[] = [],
): unknown {
  return {
    list: async () => [{ header }],
    open: async (id: string, access: string) => {
      const record = { id, access, reads: 0, closed: false }
      calls.push(record)
      return {
        id,
        header,
        read: async () => {
          record.reads += 1
          return { eventState: 'detached', events }
        },
        close: async () => { record.closed = true },
      }
    },
  }
}

/** 在宿主打开分库前写入种子记忆（同进程先后连接，时序安全）。
 *  keep 条目的复习日程拨到 1 天前，让 review-due / review-answer 链路可断言。 */
async function seedMemories(dbPath: string, pending?: PendingSeed): Promise<{ keep: string; dropped: string }> {
  const store = await openEngramStore(dbPath)
  const keep = (await store.write({ scope: 'user', kind: 'preference', content: '种子偏好：回复用简体中文', importance: 0.8 })).id
  const dropped = (await store.write({ scope: 'user', kind: 'fact', content: '种子事实：将被遗忘', importance: 0.5 })).id
  if (pending !== undefined) await markPendingIngest(store, pending.sessionId, pending.turn)
  await store.close()
  const { DatabaseSync } = await import('node:sqlite')
  const raw = new DatabaseSync(dbPath)
  raw.prepare('UPDATE nodes SET next_review_at = ? WHERE id = ?').run(Date.now() - 86_400_000, keep)
  raw.close()
  return { keep, dropped }
}

/** 六行 cordis.yml（webserver + system-prompt + tools + llm 替身 + engram）经真实 Loader 启动。
 *  extraConfig 追加到 engram 行 config 下（如 `    ingest: 'light'`）；
 *  pending 预置一个待补做摄取键（跨会话 pending 重放用例）。 */
async function loadComposition(extraConfig: readonly string[] = [], pending?: PendingSeed, prepare?: (dbDir: string) => Promise<void>): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-engram-'))
  const dbPath = join(root, 'engram', 'user.db')
  await seedMemories(dbPath, pending)
  await prepare?.(join(root, 'engram'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: 'virtual:engram-llm'",
    "- name: '@kenz1117/dsh-engram'",
    '  config:',
    `    dbDir: '${join(root, 'engram')}'`,
    ...extraConfig,
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['virtual:engram-llm', llmDouble],
    ['@kenz1117/dsh-engram', Engram],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  // 注入子 fiber（webServer 就绪后注册路由）的完成等待。
  await new Promise(resolve => setTimeout(resolve, 300))
  return context
}

/** GET/POST one engram API path; returns status and the parsed JSON body. */
async function call(port: number, method: 'GET' | 'POST', path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; json: unknown; text: string; contentType: string }> {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } }),
    ...(body === undefined && headers !== undefined ? { headers } : {}),
  })
  const text = await response.text()
  let json: unknown
  try { json = JSON.parse(text) } catch { json = undefined }
  return { status: response.status, json, text, contentType: response.headers.get('content-type') ?? '' }
}

describe('dsh-engram real Loader composition', () => {
  it('装载后 20 个工具可见，engram 行卸载后消失', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const names = () => loaded.tools.schemas().map(schema => schema.name)
    for (const expected of EXPECTED_TOOLS) {
      expect(names()).toContain(expected)
    }

    // HMR 安全：卸载 engram 行后 20 个工具全部释放（tools 服务仍在，其余工具不受影响）。
    const entry = [...loaded.loader.entries()]
      .find(candidate => candidate.options.name === '@kenz1117/dsh-engram')
    expect(entry).toBeDefined()
    await entry!.fiber?.dispose()
    for (const expected of EXPECTED_TOOLS) {
      expect(names()).not.toContain(expected)
    }
  })

  it('管理页与 API 全链路：页面/统计/列表/更新/遗忘/恢复/导出/回环写守卫', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const port = loaded.webServer.port

    // 独立管理页已移除（v0.4.0 起 UI 走设置页 tab）：/engram 不再服务。
    const page = await call(port, 'GET', '/engram')
    expect(page.status).toBe(404)

    // 统计：两库 parts，user 库有种子 2 条。
    const stats = await call(port, 'GET', '/api/engram/stats')
    expect(stats.status).toBe(200)
    const userPart = (stats.json as { parts: { scope: string; stats: { total: number } }[] }).parts
      .find(part => part.scope === 'user')
    expect(userPart?.stats.total).toBe(2)

    // 列表：种子数据可见（管理视图含全部状态）。
    const list = await call(port, 'GET', '/api/engram/list?scope=user&limit=10')
    expect(list.status).toBe(200)
    expect((list.json as { total: number }).total).toBe(2)

    // 巡游路线排序：按排桩先后（种子偏好先写先上路线）。
    const tourList = await call(port, 'GET', '/api/engram/list?scope=user&sort=tour&limit=10')
    expect((tourList.json as { records: { content: string, slot?: { room: string, index: number } }[] }).records
      .map(record => record.content)).toEqual(['种子偏好：回复用简体中文', '种子事实：将被遗忘'])
    // 列表行带桩位坐标（宫殿位置感）。
    expect((tourList.json as { records: { slot?: { room: string } }[] }).records[0]?.slot).toEqual({ room: '偏好阁', index: 1 })

    // 今日待回忆：只给线索不给正文（检索练习的刻意设计）。
    const due = await call(port, 'GET', '/api/engram/review-due?scope=user')
    expect(due.status).toBe(200)
    const dueItems = (due.json as { items: { id: string, overdueDays: number, slot?: { room: string } }[] }).items
    expect(dueItems).toHaveLength(1)
    expect(dueItems[0]?.overdueDays).toBeGreaterThanOrEqual(1)
    expect(dueItems[0]?.slot).toEqual({ room: '偏好阁', index: 1 })
    expect(due.text).not.toContain('简体中文')

    // 自评推进 SM-2：首次通过间隔 1 天；非法 grade 拒绝。
    const keepId = dueItems[0]!.id
    const answered = await call(port, 'POST', '/api/engram/review-answer', { id: keepId, scope: 'user', grade: 5 })
    expect(answered.status).toBe(200)
    expect((answered.json as { review: { intervalDays: number, reps: number } }).review).toEqual(
      expect.objectContaining({ intervalDays: 1, reps: 1 }),
    )
    expect((await call(port, 'POST', '/api/engram/review-answer', { id: keepId, scope: 'user', grade: 9 })).status).toBe(400)
    // 答题后不再出现在今日队列。
    const afterAnswer = await call(port, 'GET', '/api/engram/review-due?scope=user')
    expect((afterAnswer.json as { items: unknown[] }).items).toHaveLength(0)

    // 更新：走取代链（旧条目 archived、新条目 active）。
    const dropped = (list.json as { records: { id: string; content: string }[] }).records
      .find(record => record.content === '种子事实：将被遗忘')
    expect(dropped).toBeDefined()
    const updated = await call(port, 'POST', '/api/engram/update', {
      id: dropped!.id, scope: 'user', content: '修正后的种子事实', importance: 0.7,
    })
    expect(updated.status).toBe(200)
    const afterUpdate = await call(port, 'GET', '/api/engram/list?scope=user&status=archived')
    expect((afterUpdate.json as { total: number }).total).toBe(1)

    // 遗忘/恢复。
    const forgotten = await call(port, 'POST', '/api/engram/forget', {
      id: dropped!.id, scope: 'user',
      reason: '种子数据清理', affects: '无', stillUseful: '单元测试用例',
    })
    expect(forgotten.status).toBe(200)
    const restored = await call(port, 'POST', '/api/engram/restore', { id: dropped!.id, scope: 'user' })
    expect((restored.json as { record: { status: string } }).record.status).toBe('active')

    // 审计视图：来源链与操作日志。
    const review = await call(port, 'GET', `/api/engram/review?scope=user&id=${encodeURIComponent(dropped!.id)}`)
    expect(review.status).toBe(200)
    expect((review.json as { operations: unknown[] }).operations.length).toBeGreaterThan(0)

    // 导出：markdown 下载。
    const exported = await call(port, 'GET', '/api/engram/export?scope=user&format=markdown')
    expect(exported.status).toBe(200)
    expect(exported.contentType).toContain('text/markdown')
    expect(exported.text).toContain('种子偏好')

    // 回环写守卫：跨站 Origin 的 POST 被 403 拒绝。
    const evil = await call(port, 'POST', '/api/engram/forget',
      { id: dropped!.id, scope: 'user', reason: 'x', affects: 'x', stillUseful: 'x' },
      { origin: 'https://evil.example' })
    expect(evil.status).toBe(403)
  })

  it('情景时间线 HTTP 链路：组头带会话摘要，around 查邻近扩展', { timeout: 60_000 }, async () => {
    let anchorId = ''
    const loaded = await loadComposition([], undefined, async (dbDir) => {
      // 在宿主打开前预置两个来源会话的情景 + 一份会话摘要。
      const store = await openEngramStore(join(dbDir, 'user.db'))
      anchorId = (await store.write({ scope: 'user', kind: 'episode', content: '周一：讨论了记忆宫殿的摘要链路', sourceSessionId: 'sess-1' })).id
      await store.write({ scope: 'user', kind: 'episode', content: '周一：补齐了组头渲染', sourceSessionId: 'sess-1' })
      await store.write({ scope: 'user', kind: 'episode', content: '周五：重构了时间线查询', sourceSessionId: 'sess-2' })
      await store.setSessionSummary('sess-1', '一场关于会话摘要的会话')
      await store.close()
    })
    const port = loaded.webServer.port

    // 组模式：按会话分组（组间新→旧），sess-1 组头带摘要，sess-2 未生成不带 summary 键。
    const timeline = await call(port, 'GET', '/api/engram/episode-timeline?scope=user')
    expect(timeline.status).toBe(200)
    const groups = (timeline.json as {
      groups: { sessionId: string | null; summary?: string; startedAt: number; endedAt: number; episodes: { id: string; kind: string; content: string; createdAt: number }[] }[]
    }).groups
    expect(groups).toHaveLength(2)
    const withSummary = groups.find(group => group.sessionId === 'sess-1')!
    expect(withSummary.summary).toBe('一场关于会话摘要的会话')
    expect(withSummary.episodes).toHaveLength(2)
    const withoutSummary = groups.find(group => group.sessionId === 'sess-2')!
    expect('summary' in withoutSummary).toBe(false)
    // 行精简为四字段：kind 原样透传（episode）。
    expect(withSummary.episodes[0]?.kind).toBe('episode')

    // 邻近扩展：以 sess-1 首条为锚点，±60 分钟窗口内的另两条情景按时间升序返回。
    const around = await call(port, 'GET', `/api/engram/episode-timeline?scope=user&around=${encodeURIComponent(anchorId)}`)
    expect(around.status).toBe(200)
    const view = (around.json as { around: { anchor: { id: string }; neighbors: { content: string }[] } }).around
    expect(view.anchor.id).toBe(anchorId)
    expect(view.neighbors).toHaveLength(2)
  })

  it('实体词典 HTTP 链路：列表带关联记忆数，详情返回实体与关联记忆，缺 id 与未找到有明确状态码', { timeout: 60_000 }, async () => {
    let kenId = ''
    const loaded = await loadComposition([], undefined, async (dbDir) => {
      // 在宿主打开前预置一条记忆并挂载两个实体（ken 消解时带别名）。
      const store = await openEngramStore(join(dbDir, 'user.db'))
      const record = await store.write({ scope: 'user', kind: 'fact', content: 'ken 负责 dsh-engram 插件的开发' })
      const [ken, project] = await store.resolveEntities([
        { name: 'ken', kind: 'person' },
        { name: 'dsh-engram', kind: 'project', aliases: ['记忆插件'] },
      ])
      await store.linkNodeEntities(record.id, [ken!.id, project!.id])
      kenId = String(ken!.id)
      await store.close()
    })
    const port = loaded.webServer.port

    // 列表：scope 回显、total 计数、每行带关联 active 记忆数。
    const list = await call(port, 'GET', '/api/engram/entities?scope=user')
    expect(list.status).toBe(200)
    const listJson = list.json as {
      scope: string
      total: number
      items: { entity: { name: string; kind: string; aliases: string[] }; memoryCount: number }[]
    }
    expect(listJson.scope).toBe('user')
    expect(listJson.total).toBe(2)
    const kenItem = listJson.items.find(item => item.entity.name === 'ken')!
    expect(kenItem.entity.kind).toBe('person')
    expect(kenItem.memoryCount).toBe(1)
    const projectItem = listJson.items.find(item => item.entity.name === 'dsh-engram')!
    expect(projectItem.entity.aliases).toEqual(['记忆插件'])

    // 详情：实体记录 + 最近关联记忆。
    const detail = await call(port, 'GET', `/api/engram/entity?scope=user&id=${encodeURIComponent(kenId)}`)
    expect(detail.status).toBe(200)
    const detailJson = detail.json as { entity: { name: string; kind: string }; memories: { content: string }[] }
    expect(detailJson.entity.name).toBe('ken')
    expect(detailJson.entity.kind).toBe('person')
    expect(detailJson.memories).toHaveLength(1)
    expect(detailJson.memories[0]!.content).toContain('dsh-engram')

    // 缺 id 400；不存在的 id 404。
    const missingId = await call(port, 'GET', '/api/engram/entity?scope=user')
    expect(missingId.status).toBe(400)
    const notFound = await call(port, 'GET', '/api/engram/entity?scope=user&id=no-such-entity')
    expect(notFound.status).toBe(404)
  })

  it('会话 dispose 且事件源不可用时，摄取不产生未处理 rejection', { timeout: 60_000 }, async () => {
    // 回归：disposed 观察器是 fire-and-forget，逃逸的 rejection 会被宿主 fail-loud 当致命错误
    // 直接退出进程（社区 issue #1：turnStarts 读 undefined.length）。
    const loaded = await loadComposition(["    ingest: 'light'"])
    // 模拟 dispose 后事件源已 detach：snapshotEvents 给不出日志。
    const fakeSession = { id: 'sess-disposed', snapshotEvents: () => undefined }
    loaded.emit('session/disposed', fakeSession as never)
    // 给 fire-and-forget 摄取一个跑完的窗口；若产生未处理 rejection，vitest 会判定本用例失败。
    await new Promise(resolve => setTimeout(resolve, 300))
  })

  it('历史回填 HTTP 链路：估算 → 启动 → 轮询到结束（LLM 失败只计数不中断）', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition(["    ingest: 'light'"])
    const port = loaded.webServer.port
    // 会话持久化替身：一个可回填会话（一轮，活动信号充足以越过节流）。
    const pad = '这是一段足够长的具体描述，用来越过节流阈值。'.repeat(12)
    const events = [
      { type: 'turn/start', data: { turn: 1 }, seq: 1, time: Date.now() },
      { type: 'user/message', data: { content: [{ type: 'text', text: pad }] }, seq: 2, time: Date.now() },
      { type: 'assistant/message', data: { content: [{ type: 'text', text: '答' }] }, seq: 3, time: Date.now() },
      // 路由必须能从日志解析（插件未配 provider/model），否则摄取会在路由检查处跳过。
      { type: 'request/header', data: { header: { config: { provider: 'deepseek', model: 'deepseek-v4-flash' } } }, seq: 4, time: Date.now() },
      ...[0, 1, 2, 3, 4].map(index => ({ type: 'tool/result', data: { callId: `c${String(index)}`, isError: false }, seq: 5 + index, time: Date.now() })),
    ]
    loaded.provide('sessionPersistence' as never, makePersistenceDouble(
      { id: 'hist-1', createdAt: Date.now() - 1000, cwd: process.cwd() }, events,
    ) as never)

    // 模型清单接口：面板「辅助模型」下拉的数据源。
    const modelsResponse = await call(port, 'GET', '/api/engram/models')
    expect(modelsResponse.status).toBe(200)
    const modelsBody = modelsResponse.json as { providers: { id: string; models: { id: string }[] }[] }
    expect(modelsBody.providers[0]?.id).toBe('deepseek')
    expect(modelsBody.providers[0]?.models[0]?.id).toBe('deepseek-v4')

    // 估算：不写库、不调 LLM。
    const estimate = await call(port, 'GET', '/api/engram/history-backfill?days=7&maxTotalTurns=5')
    expect(estimate.status).toBe(200)
    const estimateBody = estimate.json as { estimate: { candidates: number; pendingTurns: number, unavailable?: string } }
    expect(estimateBody.estimate.unavailable).toBeUndefined()
    expect(estimateBody.estimate.candidates).toBe(1)
    expect(estimateBody.estimate.pendingTurns).toBeGreaterThan(0)

    // 未挂载持久化服务时不可用的说明路径：这里已提供替身，应能启动。
    const started = await call(port, 'POST', '/api/engram/history-backfill/start',
      { days: 7, maxTotalTurns: 5, maxTurnsPerSession: 1 })
    expect(started.status).toBe(200)

    // 轮询到结束（期间 LLM 替身抛错 → 该轮记失败，整批不中断）。
    let status = await call(port, 'GET', '/api/engram/history-backfill/status')
    for (let attempt = 0; attempt < 40 && (status.json as { progress: { state: string } }).progress.state === 'running'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 100))
      status = await call(port, 'GET', '/api/engram/history-backfill/status')
    }
    const finalBody = status.json as {
      progress: { state: string; turnsDone: number; turnsFailed: number }
      failures: { reason: string }[]
    }
    expect(finalBody.progress.state).toBe('done')
    expect(finalBody.progress.turnsDone).toBeGreaterThan(0)
    // LLM 替身离线：该轮必须被记成失败而不是静默吞掉或整批中断。
    expect(finalBody.progress.turnsFailed).toBeGreaterThan(0)
    expect(finalBody.failures[0]?.reason).toContain('llm offline in test')
  })

  it('历史回填优先复用当前会话在用的路由（而不是历史日志里的旧模型）', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition(["    ingest: 'light'"])
    const port = loaded.webServer.port
    // 历史会话日志里记录的是旧模型 zai/glm-4.5-air（当前环境没有该 provider 配置）。
    const pad = '这是一段足够长的具体描述，用来越过节流阈值。'.repeat(12)
    const historicalEvents = [
      { type: 'request/header', data: { header: { config: { provider: 'zai', model: 'glm-4.5-air' } } }, seq: 1, time: Date.now() },
      { type: 'turn/start', data: { turn: 1 }, seq: 2, time: Date.now() },
      { type: 'user/message', data: { content: [{ type: 'text', text: pad }] }, seq: 3, time: Date.now() },
      { type: 'assistant/message', data: { content: [{ type: 'text', text: '答' }] }, seq: 4, time: Date.now() },
      ...[0, 1, 2, 3, 4].map(index => ({ type: 'tool/result', data: { callId: `c${String(index)}`, isError: false }, seq: 5 + index, time: Date.now() })),
    ]
    loaded.provide('sessionPersistence' as never, makePersistenceDouble(
      { id: 'hist-old-model', createdAt: Date.now() - 1000, cwd: process.cwd() }, historicalEvents,
    ) as never)
    // 模拟「当前会话在用 deepseek」：preStep 每轮第一步记录该路由。
    const fakeAgent = {
      id: 'sess-current',
      session: {
        id: 'sess-current',
        header: { cwd: process.cwd() },
        snapshotEvents: () => [{ type: 'request/header', data: { header: { config: { provider: 'deepseek', model: 'deepseek-v4' } } }, seq: 1, time: Date.now() }],
      },
    }
    // emit 的重载签名较窄，这里用最小可调用视图派发事件；决策按真实契约返回 enter + messages
    // （空批即可，本用例只关心路由记录），并 await 让 preStep 的失败直接暴露为测试失败。
    const emitter = loaded as unknown as { emit: (name: string, ...args: unknown[]) => unknown }
    await (emitter.emit('agent/pre-step', {
      agent: fakeAgent, step: 1, turn: 1, signal: new AbortController().signal,
    }, async () => ({ kind: 'enter', messages: [] })) as Promise<unknown>)
    await new Promise(resolve => setTimeout(resolve, 50))
    llmCalls.length = 0

    const estimate = await call(port, 'GET', '/api/engram/history-backfill?days=7&maxTurnsPerSession=1&maxTotalTurns=1')
    expect((estimate.json as { estimate: { candidates: number } }).estimate.candidates).toBe(1)
    const started = await call(port, 'POST', '/api/engram/history-backfill/start', { days: 7, maxTurnsPerSession: 1, maxTotalTurns: 1 })
    expect(started.status).toBe(200)
    let status = await call(port, 'GET', '/api/engram/history-backfill/status')
    for (let attempt = 0; attempt < 40 && (status.json as { progress: { state: string } }).progress.state === 'running'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 100))
      status = await call(port, 'GET', '/api/engram/history-backfill/status')
    }
    // 辅助调用必须走当前在用的 deepseek，而不是历史日志里的 zai（否则会因 provider 无该模型而失败）。
    expect(llmCalls.length).toBeGreaterThan(0)
    expect(JSON.stringify(llmCalls)).toContain('deepseek')
    expect(JSON.stringify(llmCalls)).not.toContain('zai')
  })

  it('跨会话 pending 重放经持久化只读句柄读日志（load(id) 已移除）', { timeout: 60_000 }, async () => {
    // 回归：新版 dsh 的 sessionPersistence 只有句柄式 open(id,'read')+read()，已无 load(id)。
    // 适配层若还调 load，跨会话 pending 会被 catch 吞掉 TypeError 而永远保留（静默失效）。
    const loaded = await loadComposition(["    ingest: 'light'"], { sessionId: 'sess-foreign', turn: 1 })
    const pad = '这是一段足够长的具体描述，用来越过节流阈值。'.repeat(12)
    const events = [
      { type: 'request/header', data: { header: { config: { provider: 'deepseek', model: 'deepseek-v4' } } }, seq: 1, time: Date.now() },
      { type: 'turn/start', data: { turn: 1 }, seq: 2, time: Date.now() },
      { type: 'user/message', data: { content: [{ type: 'text', text: pad }] }, seq: 3, time: Date.now() },
      { type: 'assistant/message', data: { content: [{ type: 'text', text: '答' }] }, seq: 4, time: Date.now() },
    ]
    const calls: { id: string; access: string; reads: number; closed: boolean }[] = []
    loaded.provide('sessionPersistence' as never, makePersistenceDouble(
      { id: 'sess-foreign', createdAt: Date.now() - 1000, cwd: process.cwd() }, events, calls,
    ) as never)

    // 当前会话 id 与 pending 会话不同：preStep 第一步触发 pending 重放（fire-and-forget）。
    const fakeAgent = { id: 'sess-current', session: { id: 'sess-current', header: { cwd: process.cwd() }, snapshotEvents: () => [] } }
    const emitter = loaded as unknown as { emit: (name: string, ...args: unknown[]) => unknown }
    await (emitter.emit('agent/pre-step', {
      agent: fakeAgent, step: 1, turn: 1, signal: new AbortController().signal,
    }, async () => ({ kind: 'enter', messages: [] })) as Promise<unknown>)
    // 给异步重放（打开句柄 → 读日志 → 关闭）一个跑完的窗口。
    await new Promise(resolve => setTimeout(resolve, 600))

    expect(calls.length).toBeGreaterThan(0)
    expect(calls[0]?.id).toBe('sess-foreign')
    expect(calls[0]?.access).toBe('read')
    expect(calls[0]?.reads).toBeGreaterThan(0)
    // 只读句柄必须释放：否则每次重放都在后端漏一个句柄。
    expect(calls[0]?.closed).toBe(true)
  })

  it('项目宫殿随工作区切换：/workspaces 列出工作区，?project= 落到对应分库', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const port = loaded.webServer.port
    // 造一个真实存在的「工作区」目录（无 git → cwd 全量哈希命名）。
    const workspacePath = await mkdtemp(join(tmpdir(), 'engram-ws-'))
    loaded.provide('workspaceRegistry' as never, {
      list: () => [{ id: 'ws-1', path: workspacePath, title: '测试工作区' }],
    } as never)
    const dbName = resolveProjectIdentity(workspacePath).dbName
    // 预置该项目宫殿里的一条记忆（先写后关，避免与插件连接并存）。
    const seeded = await openEngramStore(join(root!, 'engram', dbName))
    await seeded.write({ scope: 'project', kind: 'decision', content: '该工作区的项目约定', importance: 0.6 })
    await seeded.close()

    const workspaces = await call(port, 'GET', '/api/engram/workspaces')
    expect(workspaces.status).toBe(200)
    const items = (workspaces.json as {
      items: { dbName: string; title: string; path: string | null; kind: string; exists: boolean; memories: number | null }[]
      processDefault: { dbName: string } | null
    }).items
    const hit = items.find(item => item.dbName === dbName)
    expect(hit).toMatchObject({ title: '测试工作区', kind: 'workspace', exists: true, memories: 1 })
    expect(hit?.path).toBe(workspacePath)
    expect(items.some(item => item.kind === 'process')).toBe(true)

    // 显式选择该工作区：项目 scope 读到的正是它的库。
    const scoped = await call(port, 'GET', `/api/engram/list?scope=project&project=${dbName}&limit=10`)
    expect(scoped.status).toBe(200)
    expect((scoped.json as { records: { content: string }[] }).records.map(record => record.content))
      .toContain('该工作区的项目约定')

    // 未知选择器 → 404（面板据此回退「跟随当前工作区」）。
    const unknown = await call(port, 'GET', '/api/engram/list?scope=project&project=project-000000000000000000000000.db')
    expect(unknown.status).toBe(404)
    expect((unknown.json as { error: string }).error).toBe('unknown project')

    // 不带选择器 = 进程目录兜底（向后兼容），照常 200。
    expect((await call(port, 'GET', '/api/engram/list?scope=project&limit=5')).status).toBe(200)
  })

  it('未知配置键经 Loader 装载 loud 失败', { timeout: 60_000 }, async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-engram-bad-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-host-webserver'",
      '  config:',
      "    host: '127.0.0.1'",
      '    port: 0',
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: 'virtual:engram-llm'",
      "- name: '@kenz1117/dsh-engram'",
      '  config:',
      '    noSuchField: 1',
      '',
    ].join('\n'))
    const bad = new Context()
    bad.baseUrl = pathToFileURL(root).href + '/'
    await bad.plugin(Loader)
    bad.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-host-webserver', HttpServer],
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['virtual:engram-llm', llmDouble],
      ['@kenz1117/dsh-engram', Engram],
    ])
    bad.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof bad.loader.internal>
    // loud 失败：未知配置键在 loader.create 阶段同步抛出（fail loud，不静默跳过）。
    await expect(bad.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })).rejects.toThrow(/unknown config key/)
  })
})


describe('migration policy through the real Loader and session tools', () => {
  for (const phase of ['boot', 'session'] as const) {
    for (const policy of ['eager', 'conservative'] as const) {
      it(`${phase}: ${policy} is applied before project-store access`, async () => {
        const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
        let cwd = process.cwd()
        let before: Buffer | undefined
        const seed = async (dbDir: string) => {
          const identity = resolveProjectIdentity(cwd)
          const path = join(dbDir, identity.legacyDbName)
          const store = await openEngramStore(path)
          await store.write({ scope: 'project', kind: 'fact', content: 'synthetic legacy memory', importance: 0.5 })
          await store.close()
          before = await readFile(path)
        }
        const loaded = await loadComposition(
          [`    legacyMigration: '${policy}'`, '    injectProfile: false', '    queryRewrite: false'],
          undefined,
          phase === 'boot' ? seed : undefined,
        )
        if (phase === 'session') {
          cwd = join(root!, 'workspace-a')
          await mkdir(cwd)
          loaded.provide('workspaceRegistry' as never, {
            list: () => [{ id: 'migration-ws', path: cwd, title: 'Migration fixture' }],
          } as never)
          await seed(join(root!, 'engram'))
        }
        if (phase === 'session') {
          const result = await loaded.tools.execute({
            name: 'engram_stats', arguments: { scope: 'project' },
            agent: { id: 'migration-agent', session: { id: 'migration-session', header: { cwd } } } as never,
            callId: 'migration-stats' as never, signal: new AbortController().signal,
          })
          expect(result.isError).not.toBe(true)
        }
        const identity = resolveProjectIdentity(cwd)
        const dbDir = join(root!, 'engram')
        const query = phase === 'boot' ? '' : `&project=${identity.dbName}`
        const response = await call(loaded.webServer.port, 'GET', `/api/engram/list?scope=project${query}`)
        expect(response.status).toBe(200)
        const contents = (response.json as { records: { content: string }[] }).records.map(record => record.content)
        const logged = warnings.mock.calls.flat().join('\n')
        expect(logged).toContain(identity.legacyDbName)
        expect(logged).toContain(identity.dbName)
        if (policy === 'eager') {
          expect(contents).toContain('synthetic legacy memory')
          expect(readMigrationPointer(dbDir, identity)?.claimedByCwd).toBe(cwd)
          expect(existsSync(join(dbDir, identity.legacyDbName))).toBe(false)
        } else {
          expect(contents).toEqual([])
          expect(existsSync(join(dbDir, identity.dbName))).toBe(true)
          expect(await readFile(join(dbDir, identity.legacyDbName))).toEqual(before)
          expect(readMigrationPointer(dbDir, identity)).toBeUndefined()
          expect(logged).toContain('请勿直接覆盖')
        }
      })
    }
  }
})
