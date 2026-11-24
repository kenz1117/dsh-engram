/**
 * 工具白名单的名单与判定（#65）。
 *
 * `src/tools/names.ts` 里的 23 个名字是配置校验与白名单过滤的依据——名单一旦与
 * 工具定义漂移，配置里的名字就会被判成「未知工具」，或者某个工具永远注册不上。
 * 这道测试把名单钉在工具定义上。
 */

import { describe, expect, it } from 'vitest'
import { createEngramTools } from '../src/tools/create.ts'
import { ENGRAM_TOOL_NAMES, isEngramToolName, stripUnavailableToolMentions, toolAvailability } from '../src/tools/names.ts'

/** 造一份最小依赖：只用来取工具名与描述，不执行任何工具。 */
function toolNamesAndDescriptions(): { name: string; description: string }[] {
  return createEngramTools({
    language: 'zh',
    openStore: async () => { throw new Error('not used') },
    resolveProjectStore: async () => { throw new Error('not used') },
    embedder: Promise.resolve(undefined),
    call: undefined,
    routeOverride: undefined,
    queryRewrite: false,
    exportDir: '/tmp/engram-names-test',
  }).map(tool => ({ name: tool.name, description: String(tool.description ?? '') }))
}

describe('工具名单（#65）', () => {
  it('名单与工具定义逐名相等（防止清单漂移）', () => {
    const actual = toolNamesAndDescriptions().map(tool => tool.name).sort()
    expect(actual).toEqual([...ENGRAM_TOOL_NAMES].sort())
    expect(actual).toHaveLength(23)
  })

  it('isEngramToolName 只认名单里的名字', () => {
    expect(isEngramToolName('engram_save')).toBe(true)
    expect(isEngramToolName('engram_sav')).toBe(false)
    expect(isEngramToolName('gpt_search')).toBe(false)
  })

  it('可用性判定：未配置=全开、空名单=全关、列表=子集', () => {
    const all = toolAvailability(undefined)
    expect(all.has('engram_save')).toBe(true)
    expect(all.has('engram_whatever')).toBe(true)

    const none = toolAvailability([])
    expect(none.has('engram_save')).toBe(false)

    const some = toolAvailability(['engram_save'])
    expect(some.has('engram_save')).toBe(true)
    expect(some.has('engram_search')).toBe(false)
  })

  it('不可用工具的括号注记被去掉，可用工具的保留', () => {
    const availability = toolAvailability(['engram_save'])
    expect(stripUnavailableToolMentions('换关键词再检索（engram_search）', availability)).toBe('换关键词再检索')
    expect(stripUnavailableToolMentions('search again (engram_search)', availability)).toBe('search again')
    // 在白名单里的工具：注记保留。
    expect(stripUnavailableToolMentions('保存用 engram_save', availability)).toBe('保存用 engram_save')
    expect(stripUnavailableToolMentions('检索（engram_search）', toolAvailability(undefined)))
      .toBe('检索（engram_search）')
  })
})
