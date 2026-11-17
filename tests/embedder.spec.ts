import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalEmbedder } from '../src/embedder/local.ts'
import type { EngramEmbedder } from '../src/embedder/interface.ts'

// 需要下载真实模型（q8 约 50MB）：ENGRAM_E2E=1 且模型端点可达时执行。
// 端点经 HF_ENDPOINT 覆盖（网络受限环境配镜像，如 https://hf-mirror.com）。
// 0.13.11 起引擎随包在 lib/engine/：跑之前先 `pnpm bundle`（或把
// DSH_ENGRAM_ENGINE_DIR 指到已有引擎目录），否则报引擎缺位。
const endpoint = process.env.HF_ENDPOINT ?? 'https://huggingface.co'
const shouldRun = process.env.ENGRAM_E2E === '1'
const reachable = shouldRun
  && await fetch(`${endpoint}/Xenova/bge-small-zh-v1.5/resolve/main/config.json`, { signal: AbortSignal.timeout(8000) })
    .then(response => response.ok)
    .catch(() => false)

describe.runIf(reachable)('createLocalEmbedder (e2e)', () => {
  // 两个用例共用一个 embedder：模型缓存目录是临时目录，分开建会各自重新
  // 下载 50MB；共享实例也正贴近生产（进程级单例）。
  let dir: string
  let embedder: EngramEmbedder

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'engram-model-'))
    embedder = await createLocalEmbedder(dir, process.env.HF_ENDPOINT, {
      id: 'Xenova/bge-small-zh-v1.5',
      pooling: 'mean',
      dtype: 'q8',
    })
  }, 300_000) // 首次下载 ~50MB 模型：hook 默认 10s 不够，与用例同一预算。

  afterAll(async () => {
    await embedder.close()
    await rm(dir, { recursive: true, force: true })
  }, 300_000)

  it('产出 512 维归一化向量，语义相近句子相似度更高', async () => {
    const [first, second, third] = await embedder.embed([
      '今天天气很好，阳光明媚',
      '天气晴朗，适合出门散步',
      '正弦函数的导数是余弦函数',
    ])
    expect(first!.length).toBe(512)
    const norm = Math.sqrt(first!.reduce((sum, v) => sum + v * v, 0))
    expect(norm).toBeCloseTo(1, 1)
    const dot = (a: Float32Array, b: Float32Array): number =>
      a.reduce((sum, v, i) => sum + v * b[i]!, 0)
    expect(dot(first!, second!)).toBeGreaterThan(dot(first!, third!))
  }, 300_000)

  it('并发 embed 串行执行：3 路同时调用全部完成（issue #60，wasm session 不重入）', async () => {
    // 修复前：重叠推理报 "Session already started"，这里至少一路 reject。
    // 修复后：实例级串行队列让三路排队执行，全部 fulfilled 且维度正确。
    const results = await Promise.all([
      embedder.embed(['今天天气很好，阳光明媚']),
      embedder.embed(['天气晴朗，适合出门散步']),
      embedder.embed(['正弦函数的导数是余弦函数']),
    ])
    for (const vectors of results) {
      expect(vectors).toHaveLength(1)
      expect(vectors[0]!.length).toBe(512)
    }
  }, 300_000)
})
