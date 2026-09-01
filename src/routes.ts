/**
 * /engram 管理页与 /api/engram/* 数据接口的回环路由。
 * 安全面：peer socket + Host 头必须为本机回环；写操作额外校验 Origin 与
 * Content-Type（billing guardLoopback 同款三重防线）。下游插件不进宿主
 * client 模块表，管理页为 host 直出的自包含单文件页。
 * @module @kenz1117/dsh-engram/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: merges the ctx.webServer service declaration.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { EngramKind, EngramScope, EngramStatus, ListFilter } from './types.ts'
import type { EngramStore } from './store/interface.ts'

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
  return raw === 'user' || raw === 'project' ? raw : fallback
}

/** 管理面板的路由依赖。 */
export interface RouteDeps {
  readonly openStore: (scope: EngramScope) => Promise<EngramStore>
  readonly exportDir: string
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
            const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 20) || 20))
            const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0)
            const filter: ListFilter = {
              scope,
              ...(status !== null && status !== '' && status !== 'all' ? { status: status as EngramStatus } : {}),
              ...(kind !== null && kind !== '' && kind !== 'all' ? { kind: kind as EngramKind } : {}),
              ...(q !== null && q !== '' ? { q } : {}),
              limit,
              offset,
            }
            json(res, 200, await (await deps.openStore(scope)).list(filter))
            return
          }
          if (req.method === 'GET' && route === 'review') {
            const scope = scopeOf(url.searchParams.get('scope'), 'user')
            const id = url.searchParams.get('id')
            if (id === null || id === '') { json(res, 400, { error: 'id required' }); return }
            const store = await deps.openStore(scope)
            const view = await store.review(id as never)
            const operations = view === undefined ? [] : view.operations
            if (view === undefined) { json(res, 404, { error: `未找到条目 ${id}` }); return }
            void operations
            json(res, 200, view)
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
