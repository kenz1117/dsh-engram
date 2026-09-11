/**
 * /engram 管理页与 /api/engram/* 数据接口的回环路由。
 * 安全面：peer socket + Host 头必须为本机回环；写操作额外校验 Origin 与
 * Content-Type（billing guardLoopback 同款三重防线）。下游插件不进宿主
 * client 模块表，管理页为 host 直出的自包含单文件页。
 * @module @kenz1117/dsh-engram/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: merges the ctx.webServer service declaration.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { EngramKind, EngramScope, EngramStatus, ListFilter, ReviewGrade } from './types.ts'
import type { EngramStore } from './store/interface.ts'
import type { EngramEmbedder } from './embedder/interface.ts'
import type { HistoryBackfillRules, HistoryEstimate, HistoryRunProgress, HistoryRunResult } from './ingest/history.ts'
import type { ResolvedHistoryRules } from './config.ts'
import { writeMirror } from './mirror/markdown.ts'
import { createBackup, restoreBackup, BACKUP_SCHEMA_VERSION } from './backup/tar.ts'
import { runConsolidation } from './consolidation/run.ts'
import { aggregateTelemetry } from './telemetry/aggregate.ts'
import { buildTourProposal } from './tour-proposal.ts'
import { gatherRefurbSuggestions, DEFAULT_REFURB_OPTIONS } from './refurb.ts'

/** 回环 peer：IPv4 127/8、IPv6 ::1、IPv4-mapped IPv6。 */
function isLoopbackPeer(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress
  if (address === undefined) return false
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.')
}

/** Host 头必须为回环字面量（防 DNS rebinding：拒绝 `127.0.0.1.attacker.com`）。 */
function isLoopbackHost(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (host === undefined || host === '') return true
  const name = host.split(':')[0]
  return name === 'localhost' || name === '::1' || (name !== undefined && /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name))
}

/** 写操作的 Origin 必须为回环（防跨站表单/fetch）。缺失视为放行，由 Content-Type 兜底。 */
function isLoopbackOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === '') return true
  try {
    const host = new URL(origin).hostname
    return host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  } catch {
    return false
  }
}

/**
 * 回环守卫：仅放行回环 GET/POST 请求（peer + Host 同时校验）。
 * @returns 是否放行；false = 已拒绝并结束响应。
 */
export function guardLoopback(req: IncomingMessage, res: ServerResponse): boolean {
  const methodOk = req.method === 'GET' || req.method === 'POST'
  if (!methodOk || !isLoopbackPeer(req) || !isLoopbackHost(req)) {
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'forbidden: loopback only' }))
    return false
  }
  return true
}

/** 写操作守卫：Origin 回环 + Content-Type JSON。 */
function guardWrite(req: IncomingMessage, res: ServerResponse): boolean {
  if (!isLoopbackOrigin(req.headers.origin)) {
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'forbidden: loopback only' }))
    return false
  }
  if (!(req.headers['content-type'] ?? '').toLowerCase().includes('application/json')) {
    res.writeHead(415, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'unsupported content-type' }))
    return false
  }
  return true
}

/** 读取并解析 JSON body（上限 64 KiB，防坏/恶意 body 拖住 handler）。 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  let body = ''
  for await (const chunk of req) {
    body += String(chunk)
    if (body.length > 65_536) return null
  }
  try {
    const parsed: unknown = JSON.parse(body === '' ? '{}' : body)
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** 从 URL searchParams 收敛 scope（缺省 user）。 */
function scopeOf(raw: string | null, fallback: EngramScope): EngramScope {
  if (raw === 'user' || raw === 'project' || raw === 'shared') return raw
  return fallback
}

/** 宽松取数：数字与数字字符串都接受，其余返回 undefined（回退配置默认）。 */
function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** 宽松取布尔：真值/假值的字符串与布尔都接受，其余返回 undefined。 */
function toBoolean(value: unknown): boolean | undefined {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return undefined
}

/** 从 query 或 body 收敛历史回填规则（未给或非法的字段留给配置默认值）。 */
function historyRulesOf(raw: Readonly<Record<string, unknown>>): HistoryBackfillRules {
  const days = toNumber(raw['days'])
  const maxTurnsPerSession = toNumber(raw['maxTurnsPerSession'])
  const maxTotalTurns = toNumber(raw['maxTotalTurns'])
  const includeSubagents = toBoolean(raw['includeSubagents'])
  const includeSeeded = toBoolean(raw['includeSeeded'])
  const includeNoCwd = toBoolean(raw['includeNoCwd'])
  return {
    ...(days === undefined ? {} : { days }),
    ...(maxTurnsPerSession === undefined ? {} : { maxTurnsPerSession }),
    ...(maxTotalTurns === undefined ? {} : { maxTotalTurns }),
    ...(includeSubagents === undefined ? {} : { includeSubagents }),
    ...(includeSeeded === undefined ? {} : { includeSeeded }),
    ...(includeNoCwd === undefined ? {} : { includeNoCwd }),
  }
}

/** 管理面板的路由依赖。 */
export interface RouteDeps {
  readonly openStore: (scope: EngramScope) => Promise<EngramStore>
  readonly exportDir: string
  /** 嵌入器承诺（search-test 的语义道）；undefined = 纯关键词。 */
  readonly embedder: Promise<EngramEmbedder | undefined>
  /** 镜像根目录（默认 `${exportDir}/palaces`），面板「打开镜像目录」按钮会用到。 */
  readonly mirrorDir: string
  /** 备份目录（与 dbDir 同源），用于打包 .db 成 tar.gz。 */
  readonly dbDir: string
  /** 当前插件版本，写进备份 _meta.json 供恢复端校验。 */
  readonly pluginVersion: string
  /** 历史回填（面板「历史回填」tab）：估算 / 启动 / 取消 / 查进度 + 部署默认规则。 */
  readonly history: {
    /** 估算候选会话与轮数（不写库、不调 LLM）。 */
    readonly estimate: (rules: HistoryBackfillRules) => Promise<HistoryEstimate>
    /** 启动后台回填；已有任务在跑时拒绝。 */
    readonly start: (rules: HistoryBackfillRules) => { ok: boolean; reason?: string }
    /** 请求中止当前任务（已完成的轮次保留，可重跑续做）。 */
    readonly cancel: () => void
    /** 当前任务进度快照。 */
    readonly status: () => { progress: HistoryRunProgress; failures: HistoryRunResult['failures']; error?: string }
    /** 已注册的 provider 与模型清单（面板「辅助模型」下拉）。 */
    readonly models: () => Promise<{
      providers: { id: string; name: string; models: { id: string; name: string }[] }[]
      failures: string[]
    }>
    /** 部署配置里的默认规则（面板表单初始值）。 */
    readonly defaults: ResolvedHistoryRules
  }
}

/**
 * 注册 /engram 页面与 /api/engram/* 接口（effect 由调用方持有，disposer 可逆）。
 * @param ctx - 携带 webServer 服务的宿主上下文。
 */
export function registerEngramRoutes(ctx: Context, deps: RouteDeps): void {
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/engram',
      handler: async (req, res) => {
        if (!guardLoopback(req, res)) return
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const route = url.pathname.slice('/api/engram/'.length)
        try {
          if (req.method === 'GET' && route === 'stats') {
            const scopes: EngramScope[] = ['user', 'project']
            const parts = await Promise.all(scopes.map(async (scope) => ({ scope, stats: await (await deps.openStore(scope)).stats() })))
            json(res, 200, { parts })
            return
          }
          if (req.method === 'GET' && route === 'list') {
            const scope = scopeOf(url.searchParams.get('scope'), 'user')
            const status = url.searchParams.get('status')
            const kind = url.searchParams.get('kind')
            const q = url.searchParams.get('q')
            const redacted = url.searchParams.get('redacted')
            const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 20) || 20))
            const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0)
            const filter: ListFilter = {
              scope,
              ...(status !== null && status !== '' && status !== 'all' ? { status: status as EngramStatus } : {}),
              ...(kind !== null && kind !== '' && kind !== 'all' ? { kind: kind as EngramKind } : {}),
              ...(q !== null && q !== '' ? { q } : {}),
              ...(redacted === 'true' || redacted === 'false' ? { redacted: redacted === 'true' } : {}),
              // 巡游路线排序：面板「按巡游路线」开关；缺省 created_at 倒序。
              ...(url.searchParams.get('sort') === 'tour' ? { sort: 'tour' as const } : {}),
              limit,
              offset,
            }
            json(res, 200, await (await deps.openStore(scope)).list(filter))
            return
          }
          if (req.method === 'GET' && route === 'search-test') {
            // 召回测试台：跑真实检索（含命中强化），供面板核对召回质量与命中原委。
            const q = url.searchParams.get('q')
            if (q === null || q.trim() === '') { json(res, 400, { error: 'q required' }); return }
            const scopeParam = url.searchParams.get('scope')
            const scopes: EngramScope[] = scopeParam === 'all' || scopeParam === null || scopeParam === ''
              ? ['user', 'project']
              : [scopeOf(scopeParam, 'user')]
            const kind = url.searchParams.get('kind')
            const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit') ?? 10) || 10))
            const embedder = deps.embedder === undefined ? undefined : await deps.embedder
            const vector = embedder === undefined ? undefined : (await embedder.embed([q.trim()]))[0]
            const results = await Promise.all(scopes.map(async scope => {
              const store = await deps.openStore(scope)
              return store.search({ text: q, scopes: [scope], limit }, vector)
            }))
            const degraded = results.some(result => result.degraded)
            let hits = results.flatMap(result => result.hits)
            if (kind !== null && kind !== '' && kind !== 'all') hits = hits.filter(hit => hit.record.kind === kind)
            json(res, 200, {
              degraded,
              hits: hits.map(hit => ({
                id: hit.record.id,
                score: hit.score,
                via: hit.via,
                ...(hit.viaEdge === undefined ? {} : { viaEdge: hit.viaEdge }),
                scope: hit.record.scope,
                kind: hit.record.kind,
                status: hit.record.status,
                content: hit.record.content,
                createdAt: hit.record.createdAt,
              })),
            })
            return
          }
          if (req.method === 'GET' && route === 'activity') {
            // 最近活动：合并两库 op_log 倒序（摄取/检索改写/压缩/蒸馏/条目操作全貌）。
            const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? 20) || 20))
            const scopes: EngramScope[] = ['user', 'project']
            const merged = (await Promise.all(scopes.map(async scope => {
              const ops = await (await deps.openStore(scope)).recentOps(limit)
              return ops.map(op => ({ ...op, scope }))
            }))).flat().sort((a, b) => b.at - a.at).slice(0, limit)
            json(res, 200, { operations: merged })
            return
          }
          if (req.method === 'GET' && route === 'review-due') {
            // 今日待回忆（检索练习）：只给线索（坐标/门牌/逾期天数），不给正文——正文由面板「揭示」走 review 路由拉取。
            const scope = scopeOf(url.searchParams.get('scope'), 'user')
            const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? 20) || 20))
            const now = Date.now()
            const due = await (await deps.openStore(scope)).dueReviews(now, limit)
            json(res, 200, {
              scope,
              items: due.map(record => ({
                id: record.id,
                kind: record.kind,
                ...(record.slot === undefined ? {} : { slot: record.slot }),
                caption: record.imagery?.caption ?? null,
                nextReviewAt: record.review?.nextReviewAt ?? null,
                overdueDays: record.review?.nextReviewAt === null || record.review?.nextReviewAt === undefined
                  ? 0
                  : Math.max(0, Math.floor((now - record.review.nextReviewAt) / 86_400_000)),
                reps: record.review?.reps ?? 0,
              })),
            })
            return
          }
          if (req.method === 'POST' && route === 'review-answer') {
            // 检索练习自评：面板 记得/模糊/忘了 三档映射 SM-2 grade 5/3/1，推进调度。
            if (!guardWrite(req, res)) return
            const body = await readJsonBody(req)
            if (body === null || typeof body.id !== 'string' || body.id === '') { json(res, 400, { error: 'id required' }); return }
            const grade = typeof body.grade === 'number' && Number.isInteger(body.grade) && body.grade >= 0 && body.grade <= 5
              ? body.grade as 0 | 1 | 2 | 3 | 4 | 5
              : null
            if (grade === null) { json(res, 400, { error: 'grade must be an integer 0-5' }); return }
            const scope = scopeOf(typeof body.scope === 'string' ? body.scope : null, 'user')
            const store = await deps.openStore(scope)
            const record = await store.scheduleReview(body.id as never, grade)
            if (record === undefined) { json(res, 404, { error: `未找到条目 ${body.id}` }); return }
            json(res, 200, { id: record.id, review: record.review ?? null })
            return
          }
          if (req.method === 'GET' && route === 'review') {
            const scope = scopeOf(url.searchParams.get('scope'), 'user')
            const id = url.searchParams.get('id')
            if (id === null || id === '') { json(res, 400, { error: 'id required' }); return }
            const store = await deps.openStore(scope)
            const view = await store.review(id as never)
            if (view === undefined) { json(res, 404, { error: `未找到条目 ${id}` }); return }
            json(res, 200, view)
            return
          }
          if (req.method === 'GET' && route === 'review-due') {
            // 今日待回忆队列：只给坐标与门牌线索，不给正文（检索练习——先主动回忆再由面板揭示核对）。
            const scope = scopeOf(url.searchParams.get('scope'), 'user')
            const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? 20) || 20))
            const now = Date.now()
            const due = await (await deps.openStore(scope)).dueReviews(now, limit)
            json(res, 200, {
              scope,
              count: due.length,
              now,
              items: due.map(record => ({
                id: record.id,
                kind: record.kind,
                scope: record.scope,
                importance: record.importance,
                confidence: record.confidence,
                ...(record.slot === undefined ? {} : { slot: record.slot }),
                ...(typeof record.imagery?.caption === 'string' ? { caption: record.imagery.caption } : {}),
                ...(record.review?.nextReviewAt === null || record.review?.nextReviewAt === undefined
                  ? {}
                  : { overdueDays: Math.max(0, Math.floor((now - record.review.nextReviewAt) / 86_400_000)) }),
                ...(record.review === undefined ? {} : { reps: record.review.reps, intervalDays: record.review.intervalDays }),
              })),
            })
            return
          }
          if (req.method === 'POST' && route === 'review-answer') {
            // 复习自评：grade 0-5 推进 SM-2 调度（≥3 通过；<3 重置间隔）。
            if (!guardWrite(req, res)) return
            const body = await readJsonBody(req)
            if (body === null || typeof body.id !== 'string' || body.id === '') { json(res, 400, { error: 'id required' }); return }
            const grade = Number(body.grade)
            if (!Number.isInteger(grade) || grade < 0 || grade > 5) { json(res, 400, { error: 'grade must be an integer 0-5' }); return }
            const scope = scopeOf(typeof body.scope === 'string' ? body.scope : null, 'user')
            const record = await (await deps.openStore(scope)).scheduleReview(body.id as never, grade as ReviewGrade)
            if (record === undefined) { json(res, 404, { error: `未找到条目 ${body.id}` }); return }
            json(res, 200, { record })
            return
          }
          if (req.method === 'GET' && route === 'export') {
            const scope = scopeOf(url.searchParams.get('scope'), 'user')
            const format = url.searchParams.get('format') === 'json' ? 'json' : 'markdown'
            const data = await (await deps.openStore(scope)).exportAll()
            const stamp = new Date().toISOString().replaceAll(':', '-')
            const body = format === 'json'
              ? JSON.stringify(data, null, 2)
              : [
                  `# dsh-engram 导出（${scope}）`,
                  '',
                  ...data.records.map(record =>
                    `- [${record.status}/${record.kind}] ${record.content}（id=${record.id}，importance ${record.importance}）`),
                  '',
                  '## 关系边',
                  ...data.edges.map(edge => `- ${edge.from} --${edge.type}--> ${edge.to}`),
                  '',
                ].join('\n')
            res.writeHead(200, {
              'content-type': format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8',
              'content-disposition': `attachment; filename="engram-${scope}-${stamp}.${format}"`,
            })
            res.end(body)
            return
          }
          if (req.method === 'GET' && route === 'mirror') {
            // 镜像导出：与 engram_export format=markdown-mirror 同语义，HTTP 路由版（面板「导出镜像」按钮直接 GET）。
            const scope = scopeOf(url.searchParams.get('scope'), 'user')
            const data = await (await deps.openStore(scope)).exportAll()
            const stamp = new Date().toISOString().replaceAll(':', '-').slice(0, 19)
            const mirrorRoot = join(deps.mirrorDir, scope, stamp)
            const report = await writeMirror(mirrorRoot, data)
            json(res, 200, { ...report, scope, memoryCount: data.records.length, edgeCount: data.edges.length })
            return
          }
          if (req.method === 'GET' && route === 'health') {
            // 健康评分（Memory Prize scorecard）：5 维 0-100，越高宫殿越稳。
            //   - 信噪比 (0-40)：命中强化 / 候选数，0-1 线性
            //   - 活跃率 (0-25)：active / total，越接近目标活跃率越满分（user/project=0.85；shared=0.7）
            //   - 走廊密度 (0-15)：edges / active，封顶 0.5
            //   - 涂改率惩罚 (0-10)：redacted 占比反向
            //   - 衰减覆盖 (0-10)：archived / total 落入区间给满分（user/project=[0.15, 0.45]；
            //     shared=[0.25, 0.5]，更严因为公开过期的风险更高）
            // scope 查询参数：限定只看某一库（不传 = 现 user+project 合并，向后兼容）。
            const rawScope = url.searchParams.get('scope')
            const scopes: EngramScope[] = rawScope === 'user' || rawScope === 'project' || rawScope === 'shared'
              ? [rawScope]
              : ['user', 'project']
            const parts = await Promise.all(scopes.map(async scope => {
              const store = await deps.openStore(scope)
              const s = await store.stats()
              const edgeCount = (await store.exportAll()).edges.length
              const total = Math.max(s.total, 1)
              const signal = s.signalRatio
              const activeRatio = s.active / total
              const corridorRatio = Math.min(0.5, edgeCount / Math.max(s.active, 1)) / 0.5
              const redactedPenalty = Math.max(0, 1 - s.redacted / total)
              const archivedRatio = s.archived / total
              // shared 库的「最优活跃率」与「衰减区间」与 user/project 不同：公开意味着大部分应当有效，
              // 过期可见会让其他 agent 学到错误信息；门槛更高。
              const isShared = scope === 'shared'
              const targetActive = isShared ? 0.7 : 0.85
              const decayLow = isShared ? 0.25 : 0.15
              const decayHigh = isShared ? 0.5 : 0.45
              const decayWindow = isShared ? 0.25 : 0.3
              const decayCoverage = archivedRatio >= decayLow && archivedRatio <= decayHigh
                ? 1
                : Math.max(0, 1 - Math.min(Math.abs(archivedRatio - decayLow), Math.abs(archivedRatio - decayHigh)) / decayWindow)
              const score = Math.round(
                signal * 40
                + (1 - Math.abs(activeRatio - targetActive) / targetActive) * 25
                + corridorRatio * 15
                + redactedPenalty * 10
                + decayCoverage * 10,
              )
              return { scope, score: Math.min(100, Math.max(0, score)), signal, activeRatio, edgeCount, redacted: s.redacted, archivedRatio }
            }))
            const overall = Math.round(parts.reduce((sum, part) => sum + part.score, 0) / parts.length)
            json(res, 200, { overall, parts, evaluatedAt: Date.now() })
            return
          }
          if (req.method === 'GET' && route === 'corridor') {
            // 走廊图：节点 = 记忆（按房间分簇），边 = related/supersedes/contradicts/refines/supports。
            // 同一作用域只读一份；面板组件默认只画 active 记忆的子图，避免闭馆节点遮蔽。
            const scope = scopeOf(url.searchParams.get('scope'), 'user')
            const includeStatuses = new Set(['active'])
            const rawStatus = url.searchParams.get('status')
            if (rawStatus !== null && rawStatus !== '' && rawStatus !== 'all') {
              for (const s of rawStatus.split(',')) {
                if (s === 'active' || s === 'archived' || s === 'forgotten') includeStatuses.add(s)
              }
            }
            const data = await (await deps.openStore(scope)).exportAll()
            const nodes = data.records
              .filter(r => includeStatuses.has(r.status))
              .map(r => ({
                id: r.id,
                scope: r.scope,
                kind: r.kind,
                status: r.status,
                importance: r.importance,
                confidence: r.confidence,
                title: r.content.length > 40 ? `${r.content.slice(0, 40)}…` : r.content,
                content: r.content,
              }))
            const allowedIds = new Set(nodes.map(n => n.id))
            const edges = data.edges
              .filter(e => allowedIds.has(e.from) && allowedIds.has(e.to))
              .map(e => ({ id: `${e.from}-${e.to}-${e.type}`, from: e.from, to: e.to, type: e.type }))
            json(res, 200, { scope, nodes, edges })
            return
          }
          if (req.method === 'GET' && route === 'telemetry') {
            // 宫殿遥测：本地聚合 op_log 近 N 天的关键指标，全部数据本地保留。
            // 可选 scope 查询：限定只看某一库（不传 = 三库聚合，向后兼容）。
            const windowDays = Math.min(90, Math.max(1, Number(url.searchParams.get('days') ?? 7) || 7))
            const rawScope = url.searchParams.get('scope')
            const scopeFilter: 'user' | 'project' | 'shared' | undefined =
              rawScope === 'user' ? 'user' : rawScope === 'project' ? 'project' : rawScope === 'shared' ? 'shared' : undefined
            const snapshot = await aggregateTelemetry(deps.openStore, windowDays, scopeFilter)
            json(res, 200, snapshot)
            return
          }
          if (req.method === 'GET' && route === 'tour-proposal') {
            // 入殿导航：会话首轮时的开场建议（基于当前 scope 的 active 记忆）。
            // 仅取 active（greeting 区分空宫殿与多房间两种文案），suggestedStops ≤ 5。
            const rawScope = url.searchParams.get('scope')
            const scope: EngramScope = rawScope === 'project' ? 'project' : rawScope === 'shared' ? 'shared' : 'user'
            const store = await deps.openStore(scope)
            const filter = await store.list({ scope, status: 'active', limit: 200, offset: 0 })
            const focusKind = url.searchParams.get('focusKind')
            const proposal = buildTourProposal(scope, filter.records, focusKind ?? undefined)
            json(res, 200, {
              scope: proposal.empty ? 'empty' : scope,
              greeting: proposal.greeting,
              activeCount: proposal.activeCount,
              empty: proposal.empty,
              suggestedStops: proposal.suggestedStops.map(record => ({
                id: record.id,
                kind: record.kind,
                content: record.content,
                importance: record.importance,
                confidence: record.confidence,
              })),
            })
            return
          }
          if (req.method === 'GET' && route === 'refurb') {
            // 翻新清单：扫描当前 scope 的 active 条目，按规则生成 merge/demote/review/split 建议。
            const rawScope = url.searchParams.get('scope')
            const scope: EngramScope = rawScope === 'project' ? 'project' : rawScope === 'shared' ? 'shared' : 'user'
            const store = await deps.openStore(scope)
            const filter = await store.list({ scope, status: 'active', limit: 500, offset: 0 })
            const suggestions = gatherRefurbSuggestions(filter.records, DEFAULT_REFURB_OPTIONS)
            json(res, 200, {
              scope,
              count: suggestions.length,
              suggestions: suggestions.map(suggestion => ({
                action: suggestion.action,
                primaryId: suggestion.primaryId,
                candidates: [...suggestion.candidates],
                scope: suggestion.scope,
                reason: suggestion.reason,
                confidence: suggestion.confidence,
              })),
            })
            return
          }
          if (req.method === 'GET' && route === 'models') {
            // 已注册的 provider 与模型清单：面板「辅助模型」下拉的数据源。
            json(res, 200, await deps.history.models())
            return
          }
          if (req.method === 'GET' && route === 'history-backfill') {
            // 历史回填估算：规则走 query（面板表单直接 GET），返回候选/轮数/预计调用次数；不写库不调 LLM。
            json(res, 200, {
              defaults: deps.history.defaults,
              estimate: await deps.history.estimate(historyRulesOf(Object.fromEntries(url.searchParams))),
            })
            return
          }
          if (req.method === 'GET' && route === 'history-backfill/status') {
            json(res, 200, deps.history.status())
            return
          }
          if (req.method === 'POST' && route === 'history-backfill/start') {
            if (!guardWrite(req, res)) return
            const body = await readJsonBody(req)
            const started = deps.history.start(historyRulesOf(body ?? {}))
            if (!started.ok) { json(res, 409, { ok: false, error: started.reason ?? '无法启动回填' }); return }
            json(res, 200, { ok: true, status: deps.history.status() })
            return
          }
          if (req.method === 'POST' && route === 'history-backfill/cancel') {
            if (!guardWrite(req, res)) return
            deps.history.cancel()
            json(res, 200, { ok: true, status: deps.history.status() })
            return
          }
          if (req.method === 'POST' && route === 'consolidate') {
            // 闭馆整理手动触发：面板「管家整理」按钮；嵌入不可用时仅归档 + 启发式去重。
            // 可选 candidates：仅把指定 ids 当作合并阶段种子（其它条目仅在与种子相似时被并入）。
            if (!guardWrite(req, res)) return
            const body = await readJsonBody(req)
            const rawScope = typeof body?.scope === 'string' ? body.scope : 'user'
            const scope: 'user' | 'project' | 'shared' = rawScope === 'project' ? 'project' : rawScope === 'shared' ? 'shared' : 'user'
            const candidates = Array.isArray(body?.candidates)
              ? body.candidates.filter((value: unknown): value is string => typeof value === 'string')
              : undefined
            const store = await deps.openStore(scope)
            const report = await runConsolidation(store, deps.embedder, candidates === undefined
              ? { scope }
              : { scope, mergeCandidateIds: candidates })
            json(res, 200, report)
            return
          }
          if (req.method === 'POST' && route === 'backup') {
            if (!guardWrite(req, res)) return
            const result = await createBackup(deps.dbDir, deps.pluginVersion)
            json(res, 200, { archivePath: result.archivePath, bytes: result.bytes, meta: result.meta, schemaVersion: BACKUP_SCHEMA_VERSION })
            return
          }
          if (req.method === 'POST' && route === 'restore-backup') {
            if (!guardWrite(req, res)) return
            const body = await readJsonBody(req)
            if (body === null || typeof body.archivePath !== 'string' || body.archivePath === '') {
              json(res, 400, { error: 'archivePath required' })
              return
            }
            // 路径安全：必须在 dbDir 子树内（防止任意文件覆盖）。
            const normalized = join(deps.dbDir, body.archivePath.replace(/^\/+/, ''))
            if (!normalized.startsWith(deps.dbDir + '/') && normalized !== deps.dbDir) {
              json(res, 400, { error: 'archivePath 必须在 dbDir 内' })
              return
            }
            try {
              const result = await restoreBackup(normalized, deps.dbDir)
              json(res, 200, { restored: result.restored, meta: result.archiveMeta })
            } catch (restoreError: unknown) {
              const message = restoreError instanceof Error ? restoreError.message : String(restoreError)
              json(res, 400, { error: `恢复失败：${message}` })
            }
            return
          }
          if (req.method === 'POST' && (route === 'update' || route === 'forget' || route === 'restore')) {
            if (!guardWrite(req, res)) return
            const body = await readJsonBody(req)
            if (body === null || typeof body.id !== 'string' || body.id === '') { json(res, 400, { error: 'id required' }); return }
            const scope = scopeOf(typeof body.scope === 'string' ? body.scope : null, 'user')
            const store = await deps.openStore(scope)
            if (route === 'update') {
              if (typeof body.content !== 'string' || body.content.trim() === '') { json(res, 400, { error: 'content required' }); return }
              const old = await store.get(body.id as never)
              if (old === undefined) { json(res, 404, { error: `未找到条目 ${body.id}` }); return }
              const record = await store.update({
                id: body.id as never,
                scope,
                kind: typeof body.kind === 'string' && ['fact', 'preference', 'decision', 'episode', 'skill'].includes(body.kind)
                  ? body.kind as EngramKind
                  : old.kind,
                content: body.content,
                ...(typeof body.importance === 'number' && Number.isFinite(body.importance)
                  ? { importance: Math.min(1, Math.max(0, body.importance)) }
                  : {}),
              })
              json(res, 200, { record })
              return
            }
            const record = route === 'forget'
              ? await store.forget(body.id as never)
              : await store.restore(body.id as never)
            json(res, 200, { record })
            return
          }
          json(res, 404, { error: 'unknown route' })
        } catch (error) {
          json(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),
    'dsh-engram: api routes',
  )
}
