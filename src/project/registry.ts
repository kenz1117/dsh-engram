/**
 * 项目宫殿清单：把 dsh 的工作区（`ctx.workspaceRegistry` 的注册表）与会话 cwd
 * 映射成记忆分库，供管理面板「切换/显示当前工作区」使用。
 *
 * 设计要点：
 * 1. **纯函数 + 注入式数据源**——不直接依赖宿主服务，index.ts 负责接
 *    `workspaceRegistry` 与 `sessionPersistence`，本模块只做映射与去重，便于单测；
 * 2. **零状态**——每次现算 `目录 → 分库名`（git origin 哈希 / cwd 全量哈希），
 *    不维护额外注册表文件：工作区改名/删除后清单自动跟上；
 * 3. **三级来源**——宿主注册表工作区 > 只从会话 header 见到的 cwd > 插件进程目录兜底；
 *    同一个分库只出现一次（同仓库的多个 worktree 共用一个项目宫殿）。
 * @module @kenz1117/dsh-engram/project/registry
 */

import { resolveProjectIdentity } from './identity.ts'

/** 宿主机工作区注册表的窄视图（`ctx.workspaceRegistry.list()` 的子集）。 */
export interface WorkspaceRef {
  /** 工作区 id（宿主生成的 uuid）。 */
  readonly id: string
  /** 规范目录路径（realpath 后的绝对路径）。 */
  readonly path: string
  /** 展示标题（用户可改；缺省为目录末段）。 */
  readonly title: string
}

/** 项目宫殿的来源类别。 */
export type ProjectPalaceKind = 'workspace' | 'session' | 'process'

/** 一个项目宫殿（= 一个项目分库）。 */
export interface ProjectPalace {
  /** 分库文件名，也是面板与 API 的选择器 id。 */
  readonly dbName: string
  /** 归属目录；无法归属目录时为 undefined（旧命名库等）。 */
  readonly path: string | undefined
  /** 展示标题。 */
  readonly title: string
  /** 标识来源：git origin 哈希 / cwd 全量哈希。 */
  readonly source: 'origin' | 'cwd'
  /** 来源类别：宿主注册表工作区 / 只从会话 cwd 见到 / 插件进程目录兜底。 */
  readonly kind: ProjectPalaceKind
  /** 宿主工作区 id（kind = workspace 时）。 */
  readonly workspaceId?: string
}

/** 路径末段作为标题（Windows 与 POSIX 分隔符都接受；根目录回退整串）。 */
export function pathTitle(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  const tail = cut === -1 ? trimmed : trimmed.slice(cut + 1)
  return tail === '' ? trimmed : tail
}

/** 目录 → 项目宫殿（kind 由调用方给出）。 */
function palaceFor(path: string, kind: ProjectPalaceKind, title: string, workspaceId?: string): ProjectPalace {
  const identity = resolveProjectIdentity(path)
  return {
    dbName: identity.dbName,
    path,
    title,
    source: identity.source,
    kind,
    ...(workspaceId === undefined ? {} : { workspaceId }),
  }
}

/**
 * 组装项目宫殿清单。
 *
 * **不变量**：清单必须恒定包含宿主注册表里的**每一个**工作区（即使它的分库文件还不存在）。
 * 面板的「跟随当前工作区」按 dbName / 路径在清单里匹配，缺行会静默降级为进程默认库。
 * @param input - 注册表工作区、会话 cwd 集合与插件进程目录。
 * @returns 按「注册表 → 会话 cwd → 进程目录」优先、按分库名去重的清单。
 */
export function listProjectPalaces(input: {
  readonly workspaces: readonly WorkspaceRef[]
  readonly sessionCwds: readonly string[]
  readonly processCwd: string
}): ProjectPalace[] {
  const palaces: ProjectPalace[] = []
  const seen = new Set<string>()
  const push = (palace: ProjectPalace): void => {
    if (seen.has(palace.dbName)) return
    seen.add(palace.dbName)
    palaces.push(palace)
  }
  for (const workspace of input.workspaces) {
    if (workspace.path === '') continue
    push(palaceFor(workspace.path, 'workspace', workspace.title === '' ? pathTitle(workspace.path) : workspace.title, workspace.id))
  }
  for (const cwd of input.sessionCwds) {
    if (cwd === '') continue
    push(palaceFor(cwd, 'session', pathTitle(cwd)))
  }
  push(palaceFor(input.processCwd, 'process', `${pathTitle(input.processCwd)}（进程目录）`))
  return palaces
}

/**
 * 按选择器找项目宫殿：`dbName` 优先，其次 `cwd`；都不给时返回进程目录兜底项。
 * @param palaces - 清单。
 * @param selector - 面板/API 传来的选择器。
 * @returns 命中的宫殿；未知选择器返回 undefined（调用方回 404）。
 */
export function findProjectPalace(
  palaces: readonly ProjectPalace[],
  selector: { readonly dbName?: string | undefined; readonly cwd?: string | undefined },
): ProjectPalace | undefined {
  if (selector.dbName !== undefined && selector.dbName !== '') {
    return palaces.find(palace => palace.dbName === selector.dbName)
  }
  if (selector.cwd !== undefined && selector.cwd !== '') {
    const dbName = resolveProjectIdentity(selector.cwd).dbName
    return palaces.find(palace => palace.dbName === dbName)
      ?? palaceFor(selector.cwd, 'session', pathTitle(selector.cwd))
  }
  return palaces.find(palace => palace.kind === 'process') ?? palaces[0]
}
