/**
 * 新手脚手架：宫殿为空时调用，把 4 条示例记忆写入 user 库，引导用户上手。
 * 幂等：检测到 user 库已有 active 条目则跳过，避免覆盖真实数据。
 * @module @kenz1117/dsh-engram/palace-sample
 */

import type { EngramStore } from './store/interface.ts'
import type { ImageryLabel } from './types.ts'

/** 4 条示例记忆：覆盖 4 种 kind 各一。 */
const SAMPLE_MEMORIES: readonly { kind: 'fact' | 'preference' | 'decision' | 'episode'; content: string; importance: number; imagery: ImageryLabel }[] = [
  {
    kind: 'preference',
    content: '我喜欢简洁的命令行界面与键盘流胜过鼠标点击。',
    importance: 0.7,
    imagery: { caption: '竹简翻页', sensoryTags: ['纸香', '木桌'], emotionalValence: 0.4, provisional: false },
  },
  {
    kind: 'fact',
    content: '默认使用 macOS，shell 是 zsh + oh-my-zsh，编辑用 Neovim。',
    importance: 0.6,
    imagery: { caption: '磨砂铝机', sensoryTags: ['金属凉', '键声脆'], emotionalValence: 0.2, provisional: false },
  },
  {
    kind: 'decision',
    content: '2024 年起所有个人项目都用 TypeScript + pnpm 工作区，理由：单仓库多包协作最稳。',
    importance: 0.8,
    imagery: { caption: '白漆棋盘', sensoryTags: ['釉面凉'], emotionalValence: 0.3, provisional: false },
  },
  {
    kind: 'episode',
    content: '第一次完整读《记忆宫殿》那本书——上中学时在图书馆角落读完，窗外是雨。',
    importance: 0.5,
    imagery: { caption: '雨窗铜铃', sensoryTags: ['钟声', '潮气'], emotionalValence: 0.7, provisional: false },
  },
]

/**
 * 若 user 库 active 为空，写入 4 条示例并返回写入的记忆 id 列表；
 * 已存在条目则直接返回空数组（不覆盖）。
 */
export async function initPalaceSample(store: EngramStore): Promise<readonly string[]> {
  const stats = await store.stats()
  if (stats.active > 0) return []
  const ids: string[] = []
  for (const memory of SAMPLE_MEMORIES) {
    const record = await store.write({
      scope: 'user',
      kind: memory.kind,
      content: memory.content,
      importance: memory.importance,
      sourceSessionId: null,
      imagery: memory.imagery,
    })
    ids.push(record.id)
  }
  return ids
}