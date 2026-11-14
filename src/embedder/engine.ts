/**
 * WASM 嵌入引擎的解析与装载（0.13.11「引擎出树」）。
 *
 * 引擎四个文件随包放在 `lib/engine/`（scripts/copy-engine.mjs 从 devDependencies
 * 拷入）：transformers.js 的 web 构建、自含 wasm 后端的 ORT bundle、ORT 的
 * emscripten 工厂与 wasm 二进制。技术路线来自 /tmp/wasm-spike/spike-web.mjs 的
 * 实跑验证，四步注入缺一不可：
 *
 *  1. Node 下 web 构建的 ONNX 后端是空壳（node:fs 被 stub），必须先把完整的
 *     ORT 挂到 `globalThis[Symbol.for('onnxruntime')]`，再 import 引擎入口；
 *  2. ORT 不能按包名 import（exports map 会解析到 onnxruntime-node 原生构建），
 *     只能从 ort.bundle.min.mjs 的 file: URL 进；
 *  3. wasm 二进制 readFileSync 后直接注入 `ORT.env.wasm.wasmBinary`，
 *     运行期不发起任何 wasm 网络加载；
 *  4. 工厂 mjs 以 file: URL 动态 import。
 *
 * 模块级只注入一次：globalThis 挂载与 wasmBinary 都是幂等写，重复注入徒增
 * 28MB 拷贝；同一 URL 的 ESM import 只求值一次，后续调用拿到的是同一模块。
 * @module @kenz1117/dsh-engram/embedder/engine
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { message } from '../i18n/messages.ts'
import { EngramError } from '../types.ts'

/**
 * 引擎目录的完备清单（与 scripts/copy-engine.mjs 的产出一致）。末两项是解析
 * shim：transformers web 构建的真实静态 import（"onnxruntime-web/webgpu" 与
 * "onnxruntime-common" 的 { Tensor }）需要包名 Specifier 可解析，缺了它们引擎
 * 在 import 时就 ERR_MODULE_NOT_FOUND。
 */
const ENGINE_ENTRY = 'transformers.web.js'
const ORT_MODULE_FILE = 'ort.bundle.min.mjs'
const ORT_FACTORY_FILE = 'ort-wasm-simd-threaded.jsep.mjs'
const ORT_WASM_FILE = 'ort-wasm-simd-threaded.jsep.wasm'
const ORT_SHIM_PACKAGES: readonly string[] = ['onnxruntime-web', 'onnxruntime-common']
const ENGINE_FILES: readonly string[] = [
  ENGINE_ENTRY,
  ORT_MODULE_FILE,
  ORT_FACTORY_FILE,
  ORT_WASM_FILE,
  ...ORT_SHIM_PACKAGES.map(packageName => `node_modules/${packageName}/package.json`),
]

/** 推导的引擎目录在「文件全在」时才成立：半个引擎比没有引擎更难排查。 */
function isCompleteEngineDir(dir: string): boolean {
  return ENGINE_FILES.every(name => existsSync(join(dir, name)))
}

/** 把 file: URL 换成 fs 路径：候选目录一律落回路径再检查，不带尾随分隔符。 */
function dirOf(url: URL): string {
  const dir = fileURLToPath(url)
  // new URL('./engine/', …) 保留尾斜杠；join 本不在意它，统一掉是给诊断看的。
  return dir.endsWith(sep) && dir.length > 1 ? dir.slice(0, -sep.length) : dir
}

/** 解析出的引擎文件位置：URL 给 import，fs 路径给 readFileSync。 */
export interface EnginePaths {
  /** 引擎目录（fs 绝对路径），诊断用。 */
  readonly dir: string
  /** transformers.web.js 的 file: URL。 */
  readonly entryUrl: string
  /** ort.bundle.min.mjs 的 file: URL（注入源）。 */
  readonly ortModuleUrl: string
  /** emscripten 工厂的 file: URL。 */
  readonly ortFactoryUrl: string
  /** wasm 二进制的 fs 路径。 */
  readonly ortWasmFile: string
}

/**
 * 定位随包引擎。顺序：
 *  1. `DSH_ENGRAM_ENGINE_DIR` 显式指定（tests/CI 可注入）；显式路径是明确的
 *     意图，缺文件直接报错而不是悄悄回退推导——否则配置错误会被掩盖；
 *  2. `moduleUrl` 相对推导：打包后本模块整体落在 `lib/index.js`，引擎在
 *     同级的 `lib/engine/`；开发态（vitest 直接跑 `src/embedder/local.ts`）
 *     则在仓库根的 `lib/engine/`。哪个候选四个文件齐全就用哪个。
 *  3. 都不成立 → EMBEDDER_DOWNLOAD_FAILED（调用方按既定链路降级），
 *     文案说清是引擎没随包，而不是网络问题。
 * @param explicitDir - 环境变量 `DSH_ENGRAM_ENGINE_DIR` 的值（可能为空串）。
 * @param moduleUrl - 调用方的 `import.meta.url`，推导锚点。
 * @throws EngramError(code=EMBEDDER_DOWNLOAD_FAILED) 引擎文件找不到。
 */
export function resolveEngine(explicitDir: string | undefined, moduleUrl: string): EnginePaths {
  const candidates: string[] = []
  const trimmed = explicitDir?.trim()
  if (trimmed !== undefined && trimmed !== '') {
    // 显式指定不参与回退：目录不对就明说。
    if (!isCompleteEngineDir(trimmed)) throw missingEngineError(trimmed)
    return engineAt(trimmed)
  }
  candidates.push(dirOf(new URL('./engine/', moduleUrl)), dirOf(new URL('../../lib/engine/', moduleUrl)))
  for (const dir of candidates) {
    if (isCompleteEngineDir(dir)) return engineAt(dir)
  }
  throw missingEngineError(candidates.at(-1))
}

/** 组装 EnginePaths：目录里四个文件名固定，URL 一律经 pathToFileURL 生成。 */
function engineAt(dir: string): EnginePaths {
  const url = (name: string): string => pathToFileURL(join(dir, name)).href
  return {
    dir,
    entryUrl: url(ENGINE_ENTRY),
    ortModuleUrl: url(ORT_MODULE_FILE),
    ortFactoryUrl: url(ORT_FACTORY_FILE),
    ortWasmFile: join(dir, ORT_WASM_FILE),
  }
}

/** 引擎缺位的人话错误：码不变（调用方降级逻辑只看码），文案单说这件事。 */
function missingEngineError(detail?: string): EngramError {
  const cause = detail === undefined ? undefined : new Error(`引擎目录候选/指定路径：${detail}`)
  return new EngramError('EMBEDDER_DOWNLOAD_FAILED', message('store.embedderEngineMissing'), cause === undefined ? undefined : { cause })
}

/** 本模块用到的 transformers.js 参数面；多余的运行时能力不声明。 */
export interface EngineEnv {
  remoteHost?: string | undefined
  allowLocalModels?: boolean | undefined
  useCustomCache?: boolean | undefined
  customCache?: unknown
}

/** dynamic import 到手的模块形状（web 构建无类型，这里只声明用到的）。 */
export interface EngineModule {
  pipeline(task: 'feature-extraction', model: string, options: Record<string, unknown>): Promise<unknown>
  env: EngineEnv
}

/** 注入只做一次的守卫：28MB wasmBinary 的拷贝不值得重复付。 */
let injected = false

/**
 * 装载引擎模块：先注入 ORT（仅一次），再 import 引擎入口。
 * 前提：调用方已确保注入先于引擎入口的首次 import（两步都在这里）。
 */
export async function loadEngineModule(paths: EnginePaths): Promise<EngineModule> {
  if (!injected) {
    await injectOnnxRuntime(paths)
    injected = true
  }
  return await import(paths.entryUrl) as EngineModule
}

/**
 * 四步注入（见文件头）。任一步失败都在 injected 置位前抛出：下次调用会重试，
 * 不会把半套注入钉死在全局上。
 */
async function injectOnnxRuntime(paths: EnginePaths): Promise<void> {
  const ort = await import(paths.ortModuleUrl) as {
    env: { wasm: Record<string, unknown> }
  }
  // Node 无法开 pthread（无 Worker API），单线程是唯一选项；proxy 同理关死。
  ort.env.wasm.wasmPaths = { mjs: paths.ortFactoryUrl, wasm: pathToFileURL(paths.ortWasmFile).href }
  ort.env.wasm.wasmBinary = new Uint8Array(readFileSync(paths.ortWasmFile))
  ort.env.wasm.numThreads = 1
  ort.env.wasm.proxy = false
  ;(globalThis as unknown as Record<symbol, unknown>)[Symbol.for('onnxruntime')] = ort
  // 工厂 mjs 以 file: URL 动态 import（spike 第 4 步）：预热 emscripten 工厂的解析。
  await import(paths.ortFactoryUrl)
}
