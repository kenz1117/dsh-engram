/**
 * transformers.js 本地嵌入实现（0.13.11「引擎出树」）：引擎以纯 WASM 形式随包
 * 放在 lib/engine/（scripts/copy-engine.mjs 拷入，spike-web.mjs 实跑验证的路线，
 * 见 src/embedder/engine.ts），模型首次使用需联网下载到 cacheDir；之后完全
 * 离线，数据不出机。安装树里不再有 transformers/onnxruntime 依赖，弱网机器的
 * 市场更新不会再被百 MB 的原生件卡死（issue #50/#54）。
 *
 * 性能换特点是这条路线的代价：WASM 单线程推理约 90ms/条（原生 onnxruntime-node
 * 约 10-20ms/条），批量回填相应变慢；换来的是零原生依赖、零构建脚本许可。
 *
 * 并发语义（issue #60）：transformers.js 底层 onnxruntime 的 wasm session 不允许
 * 重入 run()，两个重叠的推理会报 "Session already started"。因此每个 embedder
 * 实例带一条串行队列（runSerial），embed 调用逐个执行——检索与摄取即使撞在
 * 同一个单例上也只是排队，不再互相炸掉；对外接口与延迟特性不变。
 *
 * Ни модель, ни способ сведения токенов, ни вид весов здесь не задаются: все три
 * приходят строкой каталога моделей (`registry/models.json`). В коде вшитых
 * параметров моделей нет — иначе выбор модели снова стал бы свойством кода, а не
 * данных.
 * @module @kenz1117/dsh-engram/embedder/local
 */

import { mkdir } from 'node:fs/promises'
import { loadEngineModule, resolveEngine } from './engine.ts'
import type { EngineEnv } from './engine.ts'
import { createFsModelCache } from './engine-cache.ts'
import { recordEmbedAttempt } from './stats.ts'
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

/** 推理输出张量用到的面；dispose 是 wasm 内存回收的唯一出口（防御性调用）。 */
interface TensorOutput {
  tolist(): number[][]
  dispose?(): void
}

/** feature-extraction 管线在本模块用到的调用面。 */
type Extractor = (
  texts: readonly string[],
  options: { pooling: PoolingMode; normalize: boolean },
) => Promise<TensorOutput>

/** Совпадают ли две строки каталога по всем трём полям. */
function sameSpec(left: LocalModelSpec, right: LocalModelSpec): boolean {
  return left.id === right.id && left.pooling === right.pooling && left.dtype === right.dtype
}

/** 进程内单例：重复调用 createLocalEmbedder 共享同一模型实例，避免重复加载权重。 */
let cached: { dir: string; spec: LocalModelSpec; embedder: EngramEmbedder } | undefined

/** 串行队列句柄：tail 是链尾 promise（异常已吞掉），新调用排到它后面。 */
export interface SerialChain {
  /** 链尾；永远处于 fulfilled 状态（见 runSerial 的队尾吞异常）。 */
  tail: Promise<unknown>
}

/** 建一条空串行队列。每个 embedder 实例一条，与它独占的 extractor/session 对齐。 */
export function createSerialChain(): SerialChain {
  return { tail: Promise.resolve() }
}

/**
 * 把 fn 追加到链尾串行执行（issue #60）：wasm 的 ORT session 不允许重入，
 * 重叠调用会报 "Session already started"，这里保证同一链上的任务一个跑完
 * 才轮到下一个。返回值与异常原样透传给调用方；链上挂的是吞掉异常的镜像
 * （`then(() => undefined, () => undefined)`）——一次失败不断链，后续调用照常执行。
 * 提成独立导出是为了离线单测队列行为（tests/embedder-stats.spec.ts）。
 */
export function runSerial<T>(chain: SerialChain, fn: () => Promise<T>): Promise<T> {
  // then(fn, fn)：前序 reject 也直接开跑 fn，不把前序的失败传染给本次。
  const run = chain.tail.then(fn, fn)
  // 队尾吞异常：链本身永远可用，只有调用方自己的 promise 会 reject。
  chain.tail = run.then(() => undefined, () => undefined)
  return run
}

/**
 * 创建本地嵌入器。
 * @param cacheDir - 模型缓存目录；不存在会自动创建（0o700）。web 构建的
 *   `env.cacheDir` 无效（node:fs 被 stub），模型文件经 engine-cache 的 fs shim
 *   落在这个目录。
 * @param remoteHost - 模型下载端点；默认 huggingface.co，网络受限环境可配镜像（如 https://hf-mirror.com）。
 * @param spec - строка каталога моделей: идентификатор, сведение токенов, вид весов. Смена любого поля обесценивает закэшированный экземпляр, и модель загружается заново.
 * @returns готовый EngramEmbedder.
 * @throws EngramError(code=EMBEDDER_DOWNLOAD_FAILED) 引擎未随包安装，或模型下载/加载失败（调用方据此降级）。
 */
export async function createLocalEmbedder(
  cacheDir: string,
  remoteHost: string | undefined,
  spec: LocalModelSpec,
): Promise<EngramEmbedder> {
  if (cached?.dir === cacheDir && sameSpec(cached.spec, spec)) return cached.embedder
  // 引擎解析在 try 外：引擎未随包与模型下载失败是两件事，文案分开说；
  // 错误码同为 EMBEDDER_DOWNLOAD_FAILED，调用方的降级逻辑只看码。
  const engine = resolveEngine(process.env.DSH_ENGRAM_ENGINE_DIR, import.meta.url)
  await mkdir(cacheDir, { recursive: true, mode: 0o700 })
  try {
    const { pipeline, env } = await loadEngineModule(engine)
    const modelEnv = env as EngineEnv
    // 注入模式下不走本地路径检查（node:fs 被 stub，检查必然失败）；
    // device:'auto' 是唯一能走的设备值——ORT 落到它唯一的 wasm 后端。
    modelEnv.allowLocalModels = false
    modelEnv.useCustomCache = true
    modelEnv.customCache = createFsModelCache(cacheDir)
    if (remoteHost !== undefined && remoteHost !== '') modelEnv.remoteHost = remoteHost
    const extractor = await pipeline('feature-extraction', spec.id, { dtype: spec.dtype, device: 'auto' }) as Extractor
    // 加载后前 1~2 次推理慢 2~4 倍（ORT wasm 堆增长）：热身完再进 cached 单例，
    // 首条真实记忆不吃冷启动的亏。
    for (let round = 0; round < 2; round += 1) {
      const warm = await extractor(['模型热身'], { pooling: spec.pooling, normalize: true })
      warm.dispose?.()
    }
    // 本实例独占一个 extractor（即一个 ORT session），串行队列粒度与之对齐。
    const chain = createSerialChain()
    const embedder: EngramEmbedder = {
      model: spec.id,
      async embed(texts) {
        if (texts.length === 0) return []
        // 计数与推理收在同一个队列任务里：排队中的调用还没发生，不算尝试。
        return runSerial(chain, async () => {
          recordEmbedAttempt(false)
          try {
            const output = await extractor([...texts], { pooling: spec.pooling, normalize: true })
            try {
              const lists = output.tolist()
              return lists.map(list => new Float32Array(list))
            } finally {
              // wasm 内存不会自动回收：输出必须显式 dispose，长跑回填才不会一路涨。
              output.dispose?.()
            }
          } catch (error) {
            // 失败可见性（issue #60）：队列吞掉的是链上的异常镜像，这里先把
            // 真实错误记进计数器，再原样抛给调用方。
            recordEmbedAttempt(true, error)
            throw error
          }
        })
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
