/**
 * dsh-engram client half: 注册顶层侧栏「记忆宫殿」入口与主列面板。
 * v0.7.16+ 由设置弹窗内的 section 升级为顶层入口，与「Hyreal FDE 工作台」平起平坐：
 * 一击进入 + 主列满宽，不再被设置弹窗的 ~600px 限制。
 * 数据经回环 API（/api/engram/*）读取与操作，与 host 半的路由对齐。
 * 文案经宿主 locale 服务（zh/en 词典，语言切换由渲染器自动重渲染）。
 * @module @kenz1117/dsh-engram/client
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: ctx.locale 服务声明（宿主 locale 插件的 Context merge）。
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: ctx.slots（renderer 的 SlotMap 渲染接线）。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: 'main' 槽位与 MainPanelId 类型（ui-layout 契约）。
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: 'sidebar.panellist' 槽位（ui-sidebar 契约）。
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: LocaleNamespaceMap 声明合并目标（t 席位的键类型检查）。
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { bindEngramSection } from './EngramPanel.tsx'
import type { SessionsLike, WorkspacesLike } from './EngramPanel.tsx'
import { EngramPanelIcon } from './EngramPanelIcon.tsx'
import { NS, en, ru, zh, type EngramKey } from './locales/index.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    [NS]: EngramKey
  }
}

/** 必需服务：slots 渲染接线 + locale 词典注册。 */
export const inject = ['slots', 'locale']

/** 顶层侧栏入口与主列内容的共享 key：与 ui-layout 的 MainPanelId 对齐。 */
export const PANEL_ID = 'engram' as MainPanelId

/**
 * Форма кода языка, который пришёл с сервера словарём.
 *
 * Те же правила, что у сервера (`src/i18n/language.ts`), и не ради красоты: код
 * объявляется хосту через `addLanguage`, а тот проверяет форму сам и отказывает
 * всему пакету — одна кривая строка из ответа отняла бы язык целиком.
 */
const LANGUAGE_ID = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/

/**
 * Client plugin body: 注册 zh/en 词典、双槽位（main + sidebar.panellist）。
 *
 * 面板的「项目宫殿」跟随 GUI 当前工作区，需要宿主的工作区/会话清单服务；
 * 两者都**可选取用**（`ctx.get`，不写进必需 inject）：缺席时面板其余功能照常，
 * 只有项目宫殿来源 chip 显示「无工作区信息（进程默认）」。
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  // Встроенные словари: объектная форма требует обе локали, поставляемые хостом (zh/en).
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-engram: built-in dictionaries')
  // Русский — внешний язык: хост поставляет только zh и en, поэтому плагин объявляет
  // язык сам. Без addLanguage «русский» нельзя было бы выбрать в настройках DSH.
  // Цепочка отката обязана сходиться к английскому — он язык по умолчанию.
  // Язык мог быть объявлен и раньше (например, отдельным плагином локализации):
  // повторное объявление бросает, и это не ошибка — словарь ниже подхватится всё равно.
  ctx.effect(() => {
    try {
      return ctx.locale.addLanguage({ id: 'ru', label: 'Русский', fallback: 'en' })
    } catch {
      return () => {}
    }
  }, 'dsh-engram: ru language')
  // Словарь внешнего языка регистрируется по-локально, отдельно от встроенных.
  ctx.effect(() => ctx.locale.register(NS, 'ru', ru), 'dsh-engram: ru dictionary')
  // Языки, чьи тексты панели приходят словарём из файла (`<dbDir>/i18n/panel.<код>.txt`).
  //
  // Хост знает только те языки, которые объявили плагины, поэтому язык, добавленный
  // файлом реестра и словарём, до сих пор был виден серверу и невидим переключателю:
  // человек выбирал «французский» для дворца и не мог выбрать его для интерфейса.
  // Здесь язык объявляется, а его словарь регистрируется — тем же способом, каким это
  // делает любой пакет языка, только словарь не вшит в сборку, а приходит с сервера.
  //
  // Запрос асинхронный и необязательный: не ответил — работаем вшитыми языками, как
  // и раньше. Откат снимает и словарь, и язык: перезагрузка не должна копить объявления.
  ctx.effect(() => {
    const disposers: (() => void)[] = []
    let stopped = false
    void (async () => {
      try {
        const response = await fetch('/api/engram/locales')
        if (!response.ok) return
        const payload = (await response.json()) as { packs?: unknown }
        const packs = Array.isArray(payload.packs) ? (payload.packs as unknown[]) : []
        for (const raw of packs) {
          if (stopped) return
          const pack = raw as { code?: unknown, label?: unknown, entries?: unknown }
          const code = typeof pack.code === 'string' ? pack.code.toLowerCase() : ''
          if (!LANGUAGE_ID.test(code)) continue
          const entries: Record<string, string> = {}
          if (typeof pack.entries === 'object' && pack.entries !== null) {
            for (const [left, right] of Object.entries(pack.entries as Record<string, unknown>)) {
              if (typeof right === 'string' && right !== '') entries[left] = right
            }
          }
          if (Object.keys(entries).length === 0) continue
          // Язык мог быть объявлен раньше: повторное объявление бросает, и это не ошибка —
          // словарь ниже подхватится всё равно.
          try {
            disposers.push(ctx.locale.addLanguage({
              id: code,
              label: typeof pack.label === 'string' && pack.label !== '' ? pack.label : code,
              fallback: 'en',
            }))
          } catch {
            // Язык уже объявлен (например, пакетом локализации): словарь ниже всё равно нужен.
          }
          disposers.push(ctx.locale.register(NS, code, entries as Record<EngramKey, string>))
        }
      } catch {
        // Сети или маршрута нет: остаёмся на вшитых языках, панель работает как прежде.
      }
    })()
    return () => {
      stopped = true
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          // Снятие уже снятого не чинится: это уборка, а не работа панели.
        }
      }
    }
  }, 'dsh-engram: file languages')
  const t = ctx.locale.bind(NS)
  // 可选服务：按运行时形状取用（不硬依赖 @deepseek-ai/dsh-api-* 客户端包）；
  // 用 getter 现取而不是 apply 时取实例——这两个服务可能在本插件之后才挂载。
  const workspaces = (): WorkspacesLike | undefined => ctx.get('workspaces' as never) as WorkspacesLike | undefined
  const sessions = (): SessionsLike | undefined => ctx.get('sessions' as never) as SessionsLike | undefined
  // 主列面板：选中侧栏入口后，layout 把 main 切到 key=PANEL_ID 的组件上。
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
  }, bindEngramSection({ workspaces, sessions })))
  // 顶层侧栏入口：order=50 排在「上下文洞察」「Hyreal FDE 工作台」之后。
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 50,
    label: () => t('nav'),
    locale: NS,
  }, EngramPanelIcon))
}
