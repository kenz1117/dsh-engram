/**
 * 记忆写命令：工具、面板与后续摄取适配器共用的内容更新边界。
 * 集中执行清洗、脱敏、重嵌与旧向量失效，避免每个入口各补一份规则。
 * @module @kenz1117/dsh-engram/application/memory-commands
 */

import type { EmbedderHandle } from '../embedder/interface.ts'
import { message } from '../i18n/messages.ts'
import { redactSecrets } from '../security/redact.ts'
import { sanitizeProtocolText } from '../security/sanitize.ts'
import type { EngramStore } from '../store/interface.ts'
import type { EngramKind, EngramScope, ImageryLabel, MemoryId, MemoryRecord } from '../types.ts'
import { EngramError } from '../types.ts'

export interface UpdateMemoryCommand {
  readonly id: MemoryId
  readonly scope: EngramScope
  readonly content: string
  readonly kind?: EngramKind
  readonly importance?: number
  readonly imagery?: ImageryLabel
}

export interface MemoryCommandDeps {
  readonly store: EngramStore
  readonly embedder: EmbedderHandle
}

/**
 * 更新一条记忆。不存在返回 undefined，让工具与 HTTP 各自保留既有错误协议。
 * 内容变化必须产生新向量；embedder 不可用时显式清空旧向量，禁止语义索引停在旧正文。
 */
export async function updateMemory(
  deps: MemoryCommandDeps,
  input: UpdateMemoryCommand,
): Promise<MemoryRecord | undefined> {
  const content = redactSecrets(sanitizeProtocolText(input.content))
  if (content.trim() === '') {
    throw new EngramError('EMPTY_CONTENT', message('tool.updateContentEmptyAfterSanitize'))
  }
  // id 可以是当前 revision，也可以是稳定 memory_id；后者解析到当前修订后再更新。
  const old = await deps.store.get(input.id) ?? await deps.store.getMemory(input.id)
  if (old === undefined) return undefined

  let embedding: Float32Array | null = null
  const embedder = await deps.embedder
  if (embedder !== undefined) {
    const vectors = await embedder.embed([content.trim()])
    embedding = vectors[0] ?? null
  }
  return deps.store.update({
    id: old.id,
    scope: input.scope,
    kind: input.kind ?? old.kind,
    content,
    embedding,
    ...(input.importance === undefined ? {} : { importance: Math.min(1, Math.max(0, input.importance)) }),
    ...(input.imagery === undefined ? {} : { imagery: input.imagery }),
  })
}
