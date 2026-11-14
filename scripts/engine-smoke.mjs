#!/usr/bin/env node
/**
 * 引擎烟测（0.13.11「引擎出树」的发布面回归）：真实走完
 * build 产物 → npm pack → 临时目录安装 → 从安装形态的 lib/index.js import
 * createLocalEmbedder → 真实下载模型并 embed 两条中文文本。
 *
 * 它专查「打包后的路径推导」这类源码形态测不到的问题：
 *  - 引擎四文件在 tarball 里、解包后从 lib/engine/ 装载（spike 的四步注入）；
 *  - resolveEngine 不靠 DSH_ENGRAM_ENGINE_DIR，纯 import.meta.url 推导；
 *  - fs customCache shim 把模型缓存落盘（下一轮烟测可复用端点测得的热身差异）。
 *
 * 用法：
 *   node scripts/engine-smoke.mjs [--work-dir <dir>] [--tarball <path.tgz>]
 *
 *   --work-dir  工作目录（装 tarball、模型缓存）；默认 <系统临时目录>/dsh-engine-smoke。
 *               每次运行先整目录清空——模型每次冷下载是有意的：烟测要测的正是
 *               「全新安装 + 首次下载」这条最坏路径。
 *   --tarball   跳过打包直接用现成 tarball（CI 里 bundle 与 pack 分步时用）。
 *   --keep-cache 跨运行保留模型缓存（model-cache 目录不随清空丢失）：本地反复
 *               重跑时不吃模型端点的网络抖动；CI 不用（CI 要测的正是冷路径）。
 *
 * 退出码非 0 即烟测失败（维度不对 / 模长偏离 / 引擎装载失败）。CI 用法见
 * .github/workflows/engine-smoke.yml（windows-latest 主 + ubuntu-latest 对照，
 * 模型端点优先 https://hf-mirror.com/，不可达回退 huggingface.co）。
 */

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 烟测对象模型：zh 默认模型（registry/models.json 的 zh 绑定），512 维。 */
const MODEL_ID = 'Xenova/bge-small-zh-v1.5'
const EXPECTED_DIMENSIONS = 512
/** 优先端点与回退端点：弱网/受限网络环境里镜像通常更可达（issue #50/#54）。 */
const HOSTS = ['https://hf-mirror.com/', 'https://huggingface.co/']
/** 单阶段看门狗：模型下载 + 首次装载在慢机上也很少超过 10 分钟。 */
const PHASE_TIMEOUT_MS = 10 * 60 * 1000

const argv = process.argv.slice(2)
function argValue(name) {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

const workDir = argValue('--work-dir') ?? join(tmpdir(), 'dsh-engine-smoke')
const tarballArg = argValue('--tarball')
const keepCache = argv.includes('--keep-cache')

const fail = message => {
  console.error(`[engine-smoke] FAIL: ${message}`)
  process.exit(1)
}

const withTimeout = (promise, tag) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${tag} 超时（${PHASE_TIMEOUT_MS}ms）`)), PHASE_TIMEOUT_MS)),
  ])

const seconds = ms => `${(ms / 1000).toFixed(1)}s`
const megabytes = bytes => `${(bytes / 1048576).toFixed(1)}MB`

console.log(`[engine-smoke] node ${process.version} | ${process.platform} ${process.arch}`)
console.log(`[engine-smoke] work dir: ${workDir}`)

// 每次都从零开始：全新安装 + 冷模型缓存，正是弱网机器市场更新的那条路径。
// --keep-cache：模型缓存目录先挪出去，清空后放回——本地重跑不再吃端点抖动。
// 挪动用 fs.renameSync（同盘原子），不用 shell mv（Windows 兼容纪律）。
const modelCacheToKeep = keepCache ? join(workDir, 'model-cache') : undefined
if (modelCacheToKeep !== undefined && existsSync(modelCacheToKeep)) {
  // 保留目录必须是 workDir 的兄弟：放里面会被下一步的整目录清空连带删掉。
  const preserved = `${workDir}.model-cache-keep`
  rmSync(preserved, { recursive: true, force: true })
  renameSync(modelCacheToKeep, preserved)
  rmSync(workDir, { recursive: true, force: true })
  mkdirSync(workDir, { recursive: true })
  mkdirSync(dirname(modelCacheToKeep), { recursive: true })
  renameSync(preserved, modelCacheToKeep)
} else {
  rmSync(workDir, { recursive: true, force: true })
  mkdirSync(workDir, { recursive: true })
}

// —— 1. 打包（或用现成 tarball）——
let tarball = tarballArg !== undefined ? resolve(tarballArg) : undefined
if (tarball === undefined) {
  console.log('[engine-smoke] npm pack ...')
  execSync(`npm pack "${repoRoot}" --pack-destination .`, { cwd: workDir, stdio: ['ignore', 'ignore', 'inherit'] })
  const packed = readdirSync(workDir).find(name => name.endsWith('.tgz'))
  if (packed === undefined) fail('npm pack 没有产出 tarball')
  tarball = join(workDir, packed)
}
const tarballBytes = statSync(tarball).size
console.log(`[engine-smoke] tarball: ${basename(tarball)} (${megabytes(tarballBytes)})`)

// —— 2. 临时目录安装（等价于用户 `npm install <tarball>`）——
const installDir = join(workDir, 'install')
mkdirSync(installDir, { recursive: true })
writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: 'engine-smoke-fixture', private: true }, null, 2))
console.log('[engine-smoke] npm install <tarball> ...')
execSync(`npm install "${tarball}" --no-audit --no-fund`, {
  cwd: installDir,
  stdio: ['ignore', 'ignore', 'inherit'],
  env: { ...process.env, // 安装时不要被开发机的引擎目录环境变量干扰
    DSH_ENGRAM_ENGINE_DIR: '' },
})

// —— 3. 核对随包引擎四文件——
const installedPkg = join(installDir, 'node_modules', '@kenz1117', 'dsh-engram')
const engineDir = join(installedPkg, 'lib', 'engine')
const expectedFiles = [
  'transformers.web.js',
  'ort.bundle.min.mjs',
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  join('node_modules', 'onnxruntime-web', 'package.json'),
  join('node_modules', 'onnxruntime-common', 'package.json'),
]
for (const name of expectedFiles) {
  const file = join(engineDir, name)
  if (!existsSync(file)) fail(`安装形态缺引擎文件 ${name}（lib/engine 不完整）`)
  console.log(`[engine-smoke] lib/engine/${name}: ${statSync(file).size.toLocaleString('en-US')} bytes`)
}

// —— 4. 给 fixture 供 peer（模拟 dsh profile 的角色）——
// 发布形态里 @deepseek-ai/* 是 peerDependencies，由宿主 profile 的 node_modules
// 提供（ESM 沿安装树向上解析）。裸 fixture 里没有宿主，这里从 bundle 的 import
// 语句机械生成同名的桩包：任意属性/调用/构造都返回自身代理，恰好够模块求值用。
// 生成是机械的：bundle 的 peer 面变了，桩跟着变，不需要维护清单。
function installStubPeers(bundleFile, intoDir) {
  const source = readFileSync(bundleFile, 'utf8')
  const imports = new Map() // 包名 → 导入名集合
  const pattern = /(?:import|export)\s+(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\*\s+as\s+[A-Za-z_$][\w$]*\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*"(@deepseek-ai\/[^"]+)"/g
  for (const [, def, brace, pkg] of source.matchAll(pattern)) {
    if (!imports.has(pkg)) imports.set(pkg, new Set())
    if (def !== undefined) imports.get(pkg).add(def)
    if (brace !== undefined) {
      for (const part of brace.split(',')) {
        const name = part.split(' as ')[0]?.trim()
        if (name !== '') imports.get(pkg).add(name)
      }
    }
  }
  if (imports.size === 0) fail('bundle 里没有找到任何 @deepseek-ai/* 静态导入——桩无从生成')
  for (const [pkg, names] of imports) {
    const pkgDir = join(intoDir, pkg)
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: pkg, version: '0.0.0-peer-stub', type: 'module', main: 'index.js', exports: './index.js' }))
    const lines = [
      '// 机械生成的桩（scripts/engine-smoke.mjs）：任何属性、调用、构造都返回自身。',
      'const stub = new Proxy(function () {}, {',
      '  get: (_target, prop) => (prop === Symbol.toPrimitive ? () => "" : stub),',
      '  apply: () => stub,',
      '  construct: () => stub,',
      '})',
      ...[...names].map(name => `export const ${name} = stub`),
      'export default stub',
    ]
    writeFileSync(join(pkgDir, 'index.js'), `${lines.join('\n')}\n`)
    console.log(`[engine-smoke] peer 桩 ${pkg}: { ${[...names].join(', ')} }`)
  }
}
installStubPeers(join(installedPkg, 'lib', 'index.js'), join(installDir, 'node_modules'))

// —— 5. 端点探测：镜像优先，回退默认——
async function probeHost(host) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch(`${host}${MODEL_ID}/resolve/main/config.json`, {
      method: 'HEAD', redirect: 'follow', signal: controller.signal,
    })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

let hosts = [...HOSTS]
const reachable = await probeHost(hosts[0])
if (!reachable) {
  console.log(`[engine-smoke] ${hosts[0]} 不可达（10s 探测），回退默认端点`)
  hosts = [hosts[1], hosts[0]]
}

// —— 6. 从安装形态 import（真实验证打包后的路径推导）——
// 嵌入器入口是 lib/local.js（见 tsdown.config.ts）：插件入口 lib/index.js 的
// 导出面是宿主契约（name/apply/inject…），createLocalEmbedder 不在其上。
// 两个入口的引擎路径推导同构——import.meta.url 都锚在 lib/<x>.js，引擎都在
// 同级 lib/engine/；lib/index.js 的模块图由 peer 桩加载（第 4 步已验）。
// 只删不设：DSH_ENGRAM_ENGINE_DIR 若在环境里，这次烟测就白做了。
delete process.env.DSH_ENGRAM_ENGINE_DIR
const { createLocalEmbedder } = await import(pathToFileURL(join(installedPkg, 'lib', 'local.js')))

const modelCacheDir = join(workDir, 'model-cache')
const texts = ['今天天气很好，阳光明媚，适合出门散步', '正弦函数的导数是余弦函数，这在微积分里是基本公式']

let lastError = undefined
let embedder
let loadMs = 0
for (const host of hosts) {
  const started = performance.now()
  try {
    console.log(`[engine-smoke] createLocalEmbedder（remoteHost=${host}，模型 ${MODEL_ID} q8，冷缓存）...`)
    embedder = await withTimeout(
      createLocalEmbedder(modelCacheDir, host, { id: MODEL_ID, pooling: 'mean', dtype: 'q8' }),
      '模型下载+装载',
    )
    loadMs = performance.now() - started
    console.log(`[engine-smoke] 模型就绪：${seconds(loadMs)}（含下载；热身 2 次在内）`)
    break
  } catch (error) {
    lastError = error
    const cause = error instanceof Error ? error.cause : undefined
    console.log(`[engine-smoke] ${host} 装载失败：${error instanceof Error ? error.message.split('\n')[0] : error}`
      + (cause instanceof Error ? `；cause: ${cause.message.split('\n')[0]}` : ''))
  }
}
if (embedder === undefined) fail(`两个端点都装不出嵌入器；最后一次错误：${lastError instanceof Error ? lastError.message : lastError}`)

// —— 7. 真实 embed：维度与归一化断言——
let vectors
try {
  const started = performance.now()
  vectors = await withTimeout(embedder.embed(texts), 'embed')
  const embedMs = performance.now() - started
  console.log(`[engine-smoke] embed(${texts.length} 条): ${seconds(embedMs)}`)
  if (vectors.length !== texts.length) fail(`返回 ${vectors.length} 条向量，期望 ${texts.length} 条`)
  for (const [index, vector] of vectors.entries()) {
    if (!(vector instanceof Float32Array)) fail(`第 ${index} 条不是 Float32Array`)
    if (vector.length !== EXPECTED_DIMENSIONS) fail(`第 ${index} 条 ${vector.length} 维，期望 ${EXPECTED_DIMENSIONS} 维`)
    let sum = 0
    for (const value of vector) sum += value * value
    const norm = Math.sqrt(sum)
    if (Math.abs(norm - 1) > 1e-2) fail(`第 ${index} 条模长 ${norm}，偏离 1 超过 1e-2`)
    console.log(`[engine-smoke] vector[${index}]: dims=${vector.length}, norm=${norm.toFixed(6)}`)
  }
} finally {
  await embedder.close()
}

// 两条断言（512 维、模长≈1）已足够说明引擎、模型与缓存链路全通。
console.log('[engine-smoke] OK：随包引擎在安装形态下完成真实推理')
