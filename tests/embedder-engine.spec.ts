import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFsModelCache } from '../src/embedder/engine-cache.ts'
import { resolveEngine } from '../src/embedder/engine.ts'
import { createLocalEmbedder } from '../src/embedder/local.ts'
import { EngramError } from '../src/types.ts'

// 引擎目录的完备清单（scripts/copy-engine.mjs 的产出，含解析 shim 的
// package.json）：本文件只关心 resolveEngine 的推导逻辑，文件内容无关紧要。
const ENGINE_FILES = [
  'transformers.web.js',
  'ort.bundle.min.mjs',
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'node_modules/onnxruntime-web/package.json',
  'node_modules/onnxruntime-common/package.json',
]

/**
 * 建一个「引擎齐全」的假目录。走 node:fs 同步 API：本文件把
 * node:fs/promises 的 readFile/writeFile mock 掉了，夹具不能再经它建文件。
 */
function makeEngineDir(root: string, name: string): string {
  const dir = join(root, name)
  // 逐文件递归建父目录：清单里有 node_modules/<pkg>/package.json 这类嵌套路径。
  for (const file of ENGINE_FILES) {
    mkdirSync(join(dir, dirname(file)), { recursive: true })
    writeFileSync(join(dir, file), 'placeholder')
  }
  return dir
}

describe('resolveEngine', () => {
  it('DSH_ENGRAM_ENGINE_DIR 显式路径优先且原样采用', async () => {
    const root = await mkdtemp(join(tmpdir(), 'engram-engine-'))
    try {
      const dir = await makeEngineDir(root, 'engine')
      const paths = resolveEngine(dir, 'file:///irrelevant/index.js')
      expect(paths.dir).toBe(dir)
      expect(paths.entryUrl).toBe(pathToFileURL(join(dir, 'transformers.web.js')).href)
      expect(paths.ortWasmFile).toBe(join(dir, 'ort-wasm-simd-threaded.jsep.wasm'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('显式路径缺文件时不回退推导，直接报引擎缺位', async () => {
    const root = await mkdtemp(join(tmpdir(), 'engram-engine-'))
    try {
      const empty = join(root, 'empty')
      await mkdir(empty, { recursive: true })
      expect(() => resolveEngine(empty, 'file:///irrelevant/index.js')).toThrowError(EngramError)
      expect(() => resolveEngine(empty, 'file:///irrelevant/index.js'))
        .toThrowError(expect.objectContaining({ code: 'EMBEDDER_DOWNLOAD_FAILED' }))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('打包形态：moduleUrl 落在 lib/index.js 时推导同级 lib/engine/', async () => {
    const root = await mkdtemp(join(tmpdir(), 'engram-engine-'))
    try {
      const libDir = join(root, 'lib')
      mkdirSync(libDir, { recursive: true })
      makeEngineDir(libDir, 'engine')
      writeFileSync(join(libDir, 'index.js'), 'placeholder')
      const moduleUrl = pathToFileURL(join(libDir, 'index.js')).href
      expect(resolveEngine(undefined, moduleUrl).dir).toBe(join(libDir, 'engine'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('开发形态：moduleUrl 落在 src/embedder/local.ts 时推导仓库根 lib/engine/', async () => {
    const root = await mkdtemp(join(tmpdir(), 'engram-engine-'))
    try {
      await makeEngineDir(join(root, 'lib'), 'engine')
      const localTs = join(root, 'src', 'embedder', 'local.ts')
      mkdirSync(join(root, 'src', 'embedder'), { recursive: true })
      writeFileSync(localTs, 'placeholder')
      expect(resolveEngine(undefined, pathToFileURL(localTs).href).dir).toBe(join(root, 'lib', 'engine'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('哪里都没有引擎时报 EMBEDDER_DOWNLOAD_FAILED', async () => {
    const root = await mkdtemp(join(tmpdir(), 'engram-engine-'))
    try {
      writeFileSync(join(root, 'index.js'), 'placeholder')
      const error = (() => {
        try {
          resolveEngine(undefined, pathToFileURL(join(root, 'index.js')).href)
          return undefined
        } catch (caught) {
          return caught
        }
      })()
      expect(error).toBeInstanceOf(EngramError)
      expect((error as EngramError).code).toBe('EMBEDDER_DOWNLOAD_FAILED')
      expect((error as EngramError).message).toContain('lib/engine')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// createFsModelCache 是纯逻辑（URL → 哈希文件名 → fs 读写），node:fs/promises
// 整个 mock 掉：不碰真盘，断言落在调用参数上。其余真实导出保留给本文件自用。
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(), writeFile: vi.fn() }
})

describe('createFsModelCache', () => {
  const cache = (dir: string) => createFsModelCache(dir)

  it('match 命中：读出的内容包成 200 Response 且带 content-length', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(Buffer.from([1, 2, 3]))
    const response = await cache('/data').match('https://hf.co/Xenova/m/resolve/main/config.json')
    expect(response?.status).toBe(200)
    expect(response?.headers.get('content-length')).toBe('3')
    expect(Buffer.from(await response!.arrayBuffer()).equals(Buffer.from([1, 2, 3]))).toBe(true)
  })

  it('match 未命中（文件不存在）：返回 undefined，交给网络下载', async () => {
    vi.mocked(readFile).mockRejectedValueOnce(Object.assign(new Error('nope'), { code: 'ENOENT' }))
    expect(await cache('/data').match('https://hf.co/x/y')).toBeUndefined()
  })

  it('put：按哈希文件名落盘，路径落在缓存目录里且保留原始扩展名', async () => {
    const body = Uint8Array.from([9, 8, 7])
    await cache('/data').put('https://hf.co/x/model.onnx?q=1', new Response(body))
    const [path, data] = vi.mocked(writeFile).mock.calls[0]!
    expect(String(path).startsWith(`/data${sep}`)).toBe(true)
    // 文件名 = 32 个十六进制位 + 截断的扩展名（query 不参与扩展名识别）。
    const name = String(path).split(sep).at(-1)!
    expect(/^([0-9a-f]{32})\.onnx$/.test(name)).toBe(true)
    expect(Buffer.from(data as Uint8Array).equals(Buffer.from(body))).toBe(true)
  })

  it('同一个键映射到同一个文件名（match 与 put 走同一路径）', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(Buffer.alloc(1))
    await cache('/data').match('https://hf.co/x/a.onnx')
    await cache('/data').put('https://hf.co/x/a.onnx', new Response(Uint8Array.of(1)))
    const readPath = vi.mocked(readFile).mock.calls[0]![0]
    const writtenPath = vi.mocked(writeFile).mock.calls[0]![0]
    expect(readPath).toBe(writtenPath)
  })
})

describe('createLocalEmbedder（引擎缺位）', () => {
  const savedEngineDir = process.env.DSH_ENGRAM_ENGINE_DIR

  beforeEach(() => {
    vi.mocked(readFile).mockReset()
    vi.mocked(writeFile).mockReset()
  })

  it('引擎目录指向空目录时人话报错，错误码保持 EMBEDDER_DOWNLOAD_FAILED', async () => {
    const root = await mkdtemp(join(tmpdir(), 'engram-engine-'))
    try {
      process.env.DSH_ENGRAM_ENGINE_DIR = join(root, 'empty')
      mkdirSync(join(root, 'empty'), { recursive: true })
      const error = await createLocalEmbedder(join(root, 'cache'), undefined, {
        id: 'Xenova/bge-small-zh-v1.5',
        pooling: 'mean',
        dtype: 'q8',
      }).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(EngramError)
      expect((error as EngramError).code).toBe('EMBEDDER_DOWNLOAD_FAILED')
      expect((error as EngramError).message).toContain('lib/engine')
    } finally {
      if (savedEngineDir === undefined) delete process.env.DSH_ENGRAM_ENGINE_DIR
      else process.env.DSH_ENGRAM_ENGINE_DIR = savedEngineDir
      await rm(root, { recursive: true, force: true })
    }
  })
})
