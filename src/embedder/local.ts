/**
 * transformers.js 本地嵌入实现：离线推理，模型首次使用需联网下载到 cacheDir；
 * 之后完全离线，数据不出机。
 *
 * Ни модель, ни способ сведения токенов, ни вид весов здесь не задаются: все три
 * приходят строкой каталога моделей (`registry/models.json`). В коде вшитых
 * параметров моделей нет — иначе выбор модели снова стал бы свойством кода, а не
 * данных.
 * @module @kenz1117/dsh-engram/embedder/local
 */

import { mkdir } from 'node:fs/promises'
import { message } from '../i18n/messages.ts'
import { EngramError } from '../types.ts'
import type { EngramEmbedder } from './interface.ts'

/**
 * 把 token 归并成单个向量的方式。
 *
 * bge-small-zh 与多数 sentence-transformers 模型按 mean 训练；bge-m3 与同族
 * XLM-R 模型需要 cls——用 mean 会损失向量质量。
 */
export type PoolingMode = 'mean' | 'cls'

/** Вид весов модели: множество, которое понимает pipeline. */
export type ModelDtype = 'q8' | 'fp32' | 'fp16' | 'int8' | 'uint8' | 'q4' | 'q4f16' | 'bnb4'

/** Строка каталога моделей в том виде, в каком её ждёт этот модуль. */
export interface LocalModelSpec {
  readonly id: string
  readonly pooling: PoolingMode
  readonly dtype: ModelDtype
}

/** Совпадают ли две строки каталога по всем трём полям. */
function sameSpec(left: LocalModelSpec, right: LocalModelSpec): boolean {
  return left.id === right.id && left.pooling === right.pooling && left.dtype === right.dtype
}

/** 进程内单例：重复调用 createLocalEmbedder 共享同一模型实例，避免重复加载权重。 */
let cached: { dir: string; spec: LocalModelSpec; embedder: EngramEmbedder } | undefined

/**
 * 创建本地嵌入器。
 * @param cacheDir - 模型缓存目录；不存在会自动创建（0o700）。
 * @param remoteHost - 模型下载端点；默认 huggingface.co，网络受限环境可配镜像（如 https://hf-mirror.com）。
 * @param spec - строка каталога моделей: идентификатор, сведение токенов, вид весов. Смена любого поля обесценивает закэшированный экземпляр, и модель загружается заново.
 * @returns готовый EngramEmbedder.
 * @throws EngramError(code=EMBEDDER_DOWNLOAD_FAILED) 模型下载/加载失败（调用方据此降级）。
 */
export async function createLocalEmbedder(
  cacheDir: string,
  remoteHost: string | undefined,
  spec: LocalModelSpec,
): Promise<EngramEmbedder> {
  if (cached?.dir === cacheDir && sameSpec(cached.spec, spec)) return cached.embedder
  await mkdir(cacheDir, { recursive: true, mode: 0o700 })
  try {
    const { pipeline, env } = await import('@huggingface/transformers')
    env.cacheDir = cacheDir
    if (remoteHost !== undefined && remoteHost !== '') env.remoteHost = remoteHost
    const extractor = await pipeline('feature-extraction', spec.id, { dtype: spec.dtype })
    const embedder: EngramEmbedder = {
      model: spec.id,
      async embed(texts) {
        if (texts.length === 0) return []
        const output = await extractor([...texts], { pooling: spec.pooling, normalize: true })
        const lists = output.tolist() as number[][]
        return lists.map(list => new Float32Array(list))
      },
      // 管线由模块级 cached 持有；close 仅解除本实例引用，不销毁共享权重。
      close: async () => {
        if (cached?.embedder === embedder) cached = undefined
      },
    }
    cached = { dir: cacheDir, spec, embedder }
    return embedder
  } catch (error) {
    throw new EngramError('EMBEDDER_DOWNLOAD_FAILED', message('store.embedderDownloadFailed'), { cause: error })
  }
}
