/**
 * EngramEmbedder：嵌入 Provider 的可替换接口。实现负责池化与归一化。
 * @module @kenz1117/dsh-engram/embedder/interface
 */

/** 嵌入 Provider 接口。 */
export interface EngramEmbedder {
  /**
   * 批量嵌入；实现可内部分批。
   * @param texts - 待嵌入文本列表。
   * @returns 与输入同序的归一化向量（bge-small-zh-v1.5 为 512 维）。
   */
  embed(texts: readonly string[]): Promise<Float32Array[]>
  /** 模型标识（写入诊断）。 */
  readonly model: string
  /** 释放实现持有的资源（单例缓存解除；测试隔离用）。 */
  close(): Promise<void>
}

/**
 * 可重试的嵌入器句柄（审计 N11）：`await` 一个 PromiseLike，消费方代码与旧的单发
 * Promise 完全同形。语义差异在句柄内部——
 *  - 加载失败不缓存：下一次 `await` 自动重新尝试（同分库缓存的 F17 范式）；
 *  - 加载挂起不让消费者无限等：超过宽限期先按 `undefined`（降级纯关键词）放行，
 *    下载在后台继续，成功后后续 `await` 自然拿到真嵌入器。
 */
export type EmbedderHandle = PromiseLike<EngramEmbedder | undefined>
