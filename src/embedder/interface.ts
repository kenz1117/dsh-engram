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
