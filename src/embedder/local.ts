/**
 * transformers.js 本地嵌入实现：Xenova/bge-small-zh-v1.5，量化权重（q8），离线推理。
 * 模型首次使用需联网下载到 cacheDir；之后完全离线，数据不出机。
 * @module @kenz1117/dsh-engram/embedder/local
 */

import { mkdir } from 'node:fs/promises'
import { EngramError } from '../types.ts'
import type { EngramEmbedder } from './interface.ts'

/** 模型标识（bge 中文小模型，512 维输出）。 */
export const ENGRAM_MODEL_ID = 'Xenova/bge-small-zh-v1.5'

/** 进程内单例：重复调用 createLocalEmbedder 共享同一模型实例，避免重复加载权重。 */
let cached: { dir: string; embedder: EngramEmbedder } | undefined

/**
 * 创建本地嵌入器。
 * @param cacheDir - 模型缓存目录；不存在会自动创建（0o700）。
 * @param remoteHost - 模型下载端点；默认 huggingface.co，网络受限环境可配镜像（如 https://hf-mirror.com）。
 * @returns 就绪的 EngramEmbedder。
 * @throws EngramError(code=EMBEDDER_DOWNLOAD_FAILED) 模型下载/加载失败（调用方据此降级）。
 */
export async function createLocalEmbedder(cacheDir: string, remoteHost?: string): Promise<EngramEmbedder> {
  if (cached?.dir === cacheDir) return cached.embedder
  await mkdir(cacheDir, { recursive: true, mode: 0o700 })
  try {
    const { pipeline, env } = await import('@huggingface/transformers')
    env.cacheDir = cacheDir
    if (remoteHost !== undefined && remoteHost !== '') env.remoteHost = remoteHost
    const extractor = await pipeline('feature-extraction', ENGRAM_MODEL_ID, { dtype: 'q8' })
    const embedder: EngramEmbedder = {
      model: ENGRAM_MODEL_ID,
      async embed(texts) {
        if (texts.length === 0) return []
        const output = await extractor([...texts], { pooling: 'mean', normalize: true })
        const lists = output.tolist() as number[][]
        return lists.map(list => new Float32Array(list))
      },
      // 管线由模块级 cached 持有；close 仅解除本实例引用，不销毁共享权重。
      close: async () => {
        if (cached?.embedder === embedder) cached = undefined
      },
    }
    cached = { dir: cacheDir, embedder }
    return embedder
  } catch (error) {
    throw new EngramError('EMBEDDER_DOWNLOAD_FAILED', '嵌入模型下载/加载失败；检索已降级为纯关键词模式，可检查网络后重试', { cause: error })
  }
}
