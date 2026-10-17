/**
 * transformers.js 本地嵌入实现：量化权重（q8），离线推理。模型首次使用需联网
 * 下载到 cacheDir；之后完全离线，数据不出机。
 *
 * 默认模型是多语言 MiniLM（384 维）：宫殿里存的常是俄语、英语与中文混排的文字，
 * 中文专用小模型在这类文本上明显掉分。模型标识与池化方式都来自配置——换模型是
 * 改配置，不是改代码；但换模型必须重建库中向量（维度不符会被 store 拒绝）。
 * @module @kenz1117/dsh-engram/embedder/local
 */

import { mkdir } from 'node:fs/promises'
import { message } from '../i18n/messages.ts'
import { EngramError } from '../types.ts'
import type { EngramEmbedder } from './interface.ts'

/**
 * 默认模型标识：多语言 MiniLM，384 维。
 *
 * 旧默认值 Xenova/bge-small-zh-v1.5（512 维）仍是合法取值，写进配置即可回到它；
 * 但两套向量不可比，切换时要么把模型改回去，要么用新模型重建库中向量。
 */
export const ENGRAM_MODEL_ID = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2'

/**
 * 把 token 归并成单个向量的方式。
 *
 * bge-small-zh 与多数 sentence-transformers 模型按 mean 训练；bge-m3 与同族
 * XLM-R 模型需要 cls——用 mean 会损失向量质量。
 */
export type PoolingMode = 'mean' | 'cls'

/** 进程内单例：重复调用 createLocalEmbedder 共享同一模型实例，避免重复加载权重。 */
let cached: { dir: string; model: string; pooling: PoolingMode; embedder: EngramEmbedder } | undefined

/**
 * 创建本地嵌入器。
 * @param cacheDir - 模型缓存目录；不存在会自动创建（0o700）。
 * @param remoteHost - 模型下载端点；默认 huggingface.co，网络受限环境可配镜像（如 https://hf-mirror.com）。
 * @param modelId - 模型标识；默认 ENGRAM_MODEL_ID。更换模型会让进程内单例失效并重新加载。
 * @param pooling - 池化方式；默认 mean。
 * @returns 就绪的 EngramEmbedder。
 * @throws EngramError(code=EMBEDDER_DOWNLOAD_FAILED) 模型下载/加载失败（调用方据此降级）。
 */
export async function createLocalEmbedder(
  cacheDir: string,
  remoteHost?: string,
  modelId: string = ENGRAM_MODEL_ID,
  pooling: PoolingMode = 'mean',
): Promise<EngramEmbedder> {
  if (cached?.dir === cacheDir && cached.model === modelId && cached.pooling === pooling) return cached.embedder
  await mkdir(cacheDir, { recursive: true, mode: 0o700 })
  try {
    const { pipeline, env } = await import('@huggingface/transformers')
    env.cacheDir = cacheDir
    if (remoteHost !== undefined && remoteHost !== '') env.remoteHost = remoteHost
    const extractor = await pipeline('feature-extraction', modelId, { dtype: 'q8' })
    const embedder: EngramEmbedder = {
      model: modelId,
      async embed(texts) {
        if (texts.length === 0) return []
        const output = await extractor([...texts], { pooling, normalize: true })
        const lists = output.tolist() as number[][]
        return lists.map(list => new Float32Array(list))
      },
      // 管线由模块级 cached 持有；close 仅解除本实例引用，不销毁共享权重。
      close: async () => {
        if (cached?.embedder === embedder) cached = undefined
      },
    }
    cached = { dir: cacheDir, model: modelId, pooling, embedder }
    return embedder
  } catch (error) {
    throw new EngramError('EMBEDDER_DOWNLOAD_FAILED', message('store.embedderDownloadFailed'), { cause: error })
  }
}
