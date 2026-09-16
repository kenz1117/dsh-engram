/**
 * dsh-engram client half: 注册设置页「记忆库」section。
 * 数据经回环 API（/api/engram/*）读取与操作，与 host 半的路由对齐。
 * 文案经宿主 locale 服务（zh/en 词典，语言切换由渲染器自动重渲染）。
 * @module @kenz1117/dsh-engram/client
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: ctx.locale 服务声明（宿主 locale 插件的 Context merge）。
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: ctx.slots（renderer 的 SlotMap 渲染接线）。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: settings.section 槽位的 SlotMap merge（ui-settings 契约）。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: LocaleNamespaceMap 声明合并目标（t 席位的键类型检查）。
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { bindEngramSection } from './EngramPanel.tsx'
import type { SessionsLike, WorkspacesLike } from './EngramPanel.tsx'
import { NS, en, zh, type EngramKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    [NS]: EngramKey
  }
}

/** 必需服务：slots 渲染接线 + locale 词典注册。 */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: 注册 zh/en 词典与设置页「记忆库」section（order 20，
 * 排在 general/models/plugins 之后）。
 *
 * 面板的「项目宫殿」跟随 GUI 当前工作区，需要宿主的工作区/会话清单服务；
 * 两者都**可选取用**（`ctx.get`，不写进必需 inject）：缺席时面板其余功能照常，
 * 只有项目宫殿来源 chip 显示「无工作区信息（进程默认）」。
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-engram: dictionaries')
  const t = ctx.locale.bind(NS)
  // 可选服务：按运行时形状取用（不硬依赖 @deepseek-ai/dsh-api-* 客户端包）；
  // 用 getter 现取而不是 apply 时取实例——这两个服务可能在本插件之后才挂载。
  const workspaces = (): WorkspacesLike | undefined => ctx.get('workspaces' as never) as WorkspacesLike | undefined
  const sessions = (): SessionsLike | undefined => ctx.get('sessions' as never) as SessionsLike | undefined
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'engram',
    order: 20,
    label: () => t('nav'),
    locale: NS,
  }, bindEngramSection({ workspaces, sessions })))
}
