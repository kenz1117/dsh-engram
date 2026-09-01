/**
 * dsh-engram client half: 注册设置页「记忆库」section。
 * 数据经回环 API（/api/engram/*）读取与操作，与 host 半的路由对齐。
 * @module @kenz1117/dsh-engram/client
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: ctx.slots（renderer 的 SlotMap 渲染接线）。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: settings.section 槽位的 SlotMap merge（ui-settings 契约）。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { EngramSection } from './EngramPanel.tsx'

/** 必需服务：slots 渲染接线。 */
export const inject = ['slots']

/**
 * Client plugin body: 设置页注册「记忆库」section（order 20，排在
 * general/models/plugins 之后）。
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'engram',
    order: 20,
    label: () => '记忆库',
  }, EngramSection))
}
