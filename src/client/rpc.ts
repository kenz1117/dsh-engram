/**
 * 面板的唯一请求出口与项目作用域注入（从 EngramPanel 抽出，审计批次 3）：
 * 抽成独立模块让 useApi 可以复用 api() 而不与之构成循环导入——client 半按 CJS 打包，
 * 循环依赖在闭包工厂产物里会变成「用到时还是 undefined」的运行时地雷。
 * @module @kenz1117/dsh-engram/client/rpc
 */

/**
 * 当前项目宫殿的选择器（host 的项目分库 dbName）；null = 不注入，服务端走进程默认库。
 * 由 EngramSection 在**渲染期**赋值：父组件先于子组件渲染，保证子组件 effect 里的首批
 * 请求就带上选择器（放进 useEffect 会因「子 effect 先跑」而漏掉首帧那批请求）。
 */
let activeProjectSelector: string | null = null

/**
 * 固定的项目选择器失效时的自愈入口（host 回 404 unknown project）：
 * EngramSection 挂载时注册、卸载时清空——清掉固定的 library.project 回到 follow 并重载。
 */
let healDeadProject: (() => void) | null = null

/** 渲染期注入点（EngramSection 渲染体调用；测试用它固定选择器）。 */
export function setActiveProjectSelector(selector: string | null): void {
  activeProjectSelector = selector
}

/** 自愈入口注册/注销（EngramSection 的 effect 调用）。 */
export function setProjectHealHandler(heal: (() => void) | null): void {
  healDeadProject = heal
}

/** 请求是否属于 project 作用域：URL 里的 scope=project，或 POST JSON body 的 scope === 'project'。 */
function isProjectScoped(path: string, init?: RequestInit): boolean {
  if (/(?:^|[?&])scope=project(?:&|$)/.test(path)) return true
  const body = init?.body
  if (typeof body !== 'string' || body === '') return false
  try {
    const parsed = JSON.parse(body) as { scope?: unknown } | null
    return typeof parsed === 'object' && parsed !== null && parsed.scope === 'project'
  } catch {
    // body 不是 JSON：按「非 project 作用域」处理，不抛错（偏好类请求可能带自由文本）。
    return false
  }
}

/** 往 JSON 对象 body 里加 project 字段；不可解析或非对象时返回 undefined（调用方退回 query 兜底）。 */
function withProjectField(body: string, selector: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return JSON.stringify({ ...(parsed as Record<string, unknown>), project: selector })
  } catch {
    return undefined
  }
}

/** 追加 project 查询参数（GET，以及无法改写 body 时的兜底路径）。 */
function withProjectParam(path: string, selector: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}project=${encodeURIComponent(selector)}`
}

/**
 * 唯一的请求出口：project 作用域的请求统一注入当前项目宫殿选择器。
 * POST 优先写进 JSON body（host 契约：POST 经 body 传选择器），body 不可解析时退回 query。
 * project 请求收到 404 unknown project 时触发一次自愈（清固定值回到 follow），随后照常抛错。
 * @param path - `/api/engram/` 之后的路径（含 query）；不要以 `/` 开头。
 * @param init - fetch 参数。
 * @param forceProject - 显式要求注入（合并视图如管家日志：user 侧照旧、project 侧跟随选择器）。
 * @returns 解析后的响应体；非 2xx 抛错（错误文案取 body.error）。
 */
export async function api<T>(path: string, init?: RequestInit, forceProject = false): Promise<T> {
  const selector = activeProjectSelector
  let target = path
  // Записи у сервера закрыты Content-Type-замком: POST без `application/json` отбивается
  // ответом 415 unsupported content-type ещё до обработчика. Держим это правило здесь, в
  // единственном выходе к серверу, а не в каждом вызове: иначе один забытый заголовок
  // выглядит как «кнопка ничего не делает» — именно так и вышло с починкой баз.
  let requestInit = init
  if (init !== undefined && (init.method ?? '').toUpperCase() === 'POST') {
    const headers = new Headers(init.headers)
    if (!headers.has('content-type')) headers.set('content-type', 'application/json')
    requestInit = { ...init, headers }
  }
  const projectScoped = selector !== null && (forceProject || isProjectScoped(path, requestInit))
  if (projectScoped) {
    const body = requestInit?.body
    const fromBody = typeof body === 'string' && body !== '' ? withProjectField(body, selector) : undefined
    // 在 requestInit（已补 content-type）之上改写 body，而不是在原始 init 上——
    // 后者会把刚补的 content-type 头丢掉，注入分支的 POST 会被服务端 415 挡下。
    if (fromBody !== undefined && requestInit !== undefined) requestInit = { ...requestInit, body: fromBody }
    else target = withProjectParam(path, selector)
  }
  const response = await fetch(`/api/engram/${target}`, requestInit)
  // 先读文本、后判 ok、再尝试按 JSON 解析：代理/宿主的错误页不是 JSON，
  // 直接 json() 会把 HTTP 502 伪装成 «Unexpected token <» —— 状态码反而丢了。
  const raw = await response.text()
  let parsed: (T & { error?: string }) | undefined
  try { parsed = raw === '' ? undefined : JSON.parse(raw) as T & { error?: string } } catch { parsed = undefined }
  if (!response.ok) {
    // 自愈：固定的分库已失效（工作区被删/改名）→ 回到跟随并重载，避免面板卡在错误态。
    if (projectScoped && response.status === 404 && parsed?.error === 'unknown project') healDeadProject?.()
    throw new Error(parsed?.error ?? `HTTP ${String(response.status)}`)
  }
  if (parsed === undefined) throw new Error(`HTTP ${String(response.status)}`)
  return parsed
}
