import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createLocalEmbedder } from '../src/embedder/local.ts'

// 需要下载真实模型（q8 约 50MB）：ENGRAM_E2E=1 且模型端点可达时执行。
// 端点经 HF_ENDPOINT 覆盖（网络受限环境配镜像，如 https://hf-mirror.com）。
const endpoint = process.env.HF_ENDPOINT ?? 'https://huggingface.co'
const shouldRun = process.env.ENGRAM_E2E === '1'
const reachable = shouldRun
  && await fetch(`${endpoint}/Xenova/bge-small-zh-v1.5/resolve/main/config.json`, { signal: AbortSignal.timeout(8000) })
    .then(response => response.ok)
    .catch(() => false)

describe.runIf(reachable)('createLocalEmbedder (e2e)', () => {
  it('产出 512 维归一化向量，语义相近句子相似度更高', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'engram-model-'))
    const embedder = await createLocalEmbedder(dir, process.env.HF_ENDPOINT)
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
    await embedder.close()
  }, 300_000)
})
