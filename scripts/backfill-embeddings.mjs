#!/usr/bin/env node
/**
 * 嵌入回填：给已有记忆补算向量，或在换了嵌入模型之后重建全部向量。
 *
 * 场景 A（默认）：嵌入器曾降级（模型未就绪）时写入的记忆没有向量——语义检索
 * 上线后跑一次本脚本，让存量记忆参与向量道。
 * 场景 B（--force）：换了嵌入模型（`embedder.localModel` / `embedder.localPooling`）。
 * 库中旧向量与新模型维度不同，store 会用 EMBEDDER_DIMENSION_MISMATCH 拒绝写入与
 * 比较，所以换模型必须把向量整体重建，而不是逐条截断。
 *
 * 用法：
 *   node scripts/backfill-embeddings.mjs [dbDir] [--force] [--model <id>]
 *                                        [--pooling mean|cls] [--cache-dir <path>]
 *
 * 参数：
 *   dbDir             宫殿根目录；默认 ~/.dsh/engram。脚本扫描其中的
 *                     user.db / shared.db / project-<hash>.db——全部分库，
 *                     而不只是默认库。
 *   --force           重建全部向量，而不只补 NULL：nodes 里所有已有向量或 active
 *                     的行，observations 里所有已有向量或未被否定的行。
 *   --model <id>      嵌入模型标识；默认 Xenova/paraphrase-multilingual-MiniLM-L12-v2
 *                     （384 维，与插件默认一致）。
 *   --pooling <mode>  池化方式：mean（默认）| cls（bge-m3 等 XLM-R 同族模型）。
 *   --cache-dir <dir> 模型缓存目录；默认 <dbDir>/models。
 *   -h, --help        显示本说明。
 *
 * 维度是硬约束：不带 --force 时，若模型维度与库中已有向量不一致，脚本在写入前
 * 就报错退出，绝不会写出混合维度的库；--force 写完后校验全库只剩一个维度。
 *
 * 远程嵌入器（`embedder.kind = remote`）不在本脚本覆盖范围：这里跑的是
 * transformers.js 本地推理，复现不了远程端点的向量。请把 kind 切回 local 重建，
 * 或按端点自己的重建手段处理。
 */

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** 插件默认模型；与 src/embedder/local.ts 的 ENGRAM_MODEL_ID 保持一致。 */
const DEFAULT_MODEL_ID = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2'

/** 默认池化方式：多数句向量模型按 mean 训练。 */
const DEFAULT_POOLING = 'mean'

/** 单批推理的文本条数：太小拖慢，太大吃内存。 */
const CHUNK = 128

/** 浮点数在 BLOB 里的字节数：维度按浮点数个数算，不按字节。 */
const BYTES_PER_FLOAT = Float32Array.BYTES_PER_ELEMENT

/** 分库文件名：与插件 project/identity.ts、index.ts 的命名一致。 */
const DB_FILE_PATTERN = /^(?:user|shared|project-[0-9a-f]{24})\.db$/

const USAGE = `用法：node scripts/backfill-embeddings.mjs [dbDir] [--force] [--model <id>] [--pooling mean|cls] [--cache-dir <path>]

  dbDir             宫殿根目录；默认 ~/.dsh/engram
  --force           重建全部向量（换模型后用），而不只补 NULL
  --model <id>      嵌入模型标识；默认 ${DEFAULT_MODEL_ID}
  --pooling <mode>  mean（默认）| cls
  --cache-dir <dir> 模型缓存目录；默认 <dbDir>/models
  -h, --help        显示本说明`

/**
 * 报错退出：参数错误一律在动数据库之前失败。
 * @param {string} text 给人看的错误文本。
 */
function fail(text) {
  console.error(`[backfill] ${text}`)
  process.exit(1)
}

/**
 * 解析命令行。
 * @param {string[]} argv process.argv.slice(2)。
 * @returns {{dbDir: string | undefined, force: boolean, model: string, pooling: 'mean' | 'cls', cacheDir: string | undefined, help: boolean}}
 */
function parseArgs(argv) {
  const options = {
    dbDir: undefined,
    force: false,
    model: DEFAULT_MODEL_ID,
    pooling: DEFAULT_POOLING,
    cacheDir: undefined,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]
    if (raw === '--help' || raw === '-h') {
      options.help = true
      continue
    }
    if (raw === '--force') {
      options.force = true
      continue
    }
    if (raw.startsWith('--')) {
      const split = raw.indexOf('=')
      const name = split === -1 ? raw.slice(2) : raw.slice(2, split)
      const inline = split === -1 ? undefined : raw.slice(split + 1)
      if (name !== 'model' && name !== 'pooling' && name !== 'cache-dir') {
        fail(`未知参数 --${name}（用 --help 查看用法）`)
      }
      const value = inline ?? argv[(index += 1)]
      if (value === undefined) fail(`参数 --${name} 缺少取值`)
      if (name === 'model') options.model = value
      else if (name === 'pooling') options.pooling = value
      else options.cacheDir = value
      continue
    }
    if (options.dbDir !== undefined) fail(`多余的位置参数 ${raw}`)
    options.dbDir = raw
  }
  if (options.pooling !== 'mean' && options.pooling !== 'cls') {
    fail(`--pooling 只接受 mean 或 cls，收到 ${options.pooling}`)
  }
  if (options.model.trim() === '') fail('--model 不能为空')
  return options
}

/**
 * 表是否存在：旧库可能还没有 observations 表。
 * @param {DatabaseSync} db 已打开的库。
 * @param {string} name 表名。
 * @returns {boolean}
 */
function hasTable(db, name) {
  return db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
}

/**
 * 库中已有向量的维度（浮点数个数）。
 *
 * 与 store 的读法一致：nodes 与 observations 一起看，任一边维度不对都会让语义
 * 检索失真。库里还没有向量时返回 undefined。
 * @param {DatabaseSync} db 已打开的库。
 * @returns {number | undefined}
 */
function readStoredDim(db) {
  const queries = []
  if (hasTable(db, 'nodes')) queries.push('SELECT LENGTH(embedding) AS bytes FROM nodes WHERE embedding IS NOT NULL')
  if (hasTable(db, 'observations')) queries.push('SELECT LENGTH(embedding) AS bytes FROM observations WHERE embedding IS NOT NULL')
  if (queries.length === 0) return undefined
  const row = db.prepare(`${queries.join(' UNION ALL ')} LIMIT 1`).get()
  return row === undefined ? undefined : row.bytes / BYTES_PER_FLOAT
}

/**
 * 全库维度清单：写完后的校验依据。
 * @param {DatabaseSync} db 已打开的库。
 * @returns {number[]} 去重后的维度列表。
 */
function storedDims(db) {
  const dims = new Set()
  for (const table of ['nodes', 'observations']) {
    if (!hasTable(db, table)) continue
    const rows = db.prepare(`SELECT DISTINCT LENGTH(embedding) AS bytes FROM ${table} WHERE embedding IS NOT NULL`).all()
    for (const row of rows) dims.add(row.bytes / BYTES_PER_FLOAT)
  }
  return [...dims]
}

/**
 * 列出要处理的分库。
 *
 * 插件把三个作用域写成三种文件名：user.db、shared.db、project-<hash>.db。
 * 只按固定名字找会漏掉共享库与全部项目库，所以这里扫目录。
 * @param {string} dbDir 宫殿根目录。
 * @returns {string[]} 绝对路径列表（按文件名排序）。
 */
function findDatabases(dbDir) {
  if (!existsSync(dbDir)) return []
  return readdirSync(dbDir)
    .filter(name => DB_FILE_PATTERN.test(name))
    .sort()
    .map(name => join(dbDir, name))
}

/**
 * 建本地嵌入器：随包 WASM 引擎 + q8 量化权重，与插件默认路径一致。
 * @param {{model: string, pooling: 'mean' | 'cls', cacheDir: string}} options 嵌入参数。
 * @returns {Promise<(texts: string[]) => Promise<Float32Array[]>>} 批量取向量。
 */
async function createEmbedder(options) {
  // 动态 import：--help 与参数错误不加载引擎运行时。
  // 0.13.11 引擎出树：装载器随包在 lib/local.js（插件入口的导出面是宿主契约，
  // 嵌入器不在其上）。引擎目录缺失/不完整时 createLocalEmbedder 抛
  // EMBEDDER_DOWNLOAD_FAILED（人话文案指引用户重装插件）；这里只补构建产物
  // 缺失（源码安装没跑 pnpm bundle）的情形。
  let embedder
  try {
    ({ createLocalEmbedder } = await import(new URL('../lib/local.js', import.meta.url)))
  } catch {
    throw new Error('嵌入器装载器 lib/local.js 缺失——从源码安装请先运行 pnpm bundle，或直接重装插件')
  }
  return await createLocalEmbedder(options.cacheDir, process.env.HF_ENDPOINT, {
    id: options.model,
    pooling: options.pooling,
    dtype: 'q8',
  })
}

/**
 * 把一个分库里的目标行全部算成向量，再在一个事务里写回。
 *
 * 先算后写：推理可能要跑很久（首次还要下载模型），不该把写事务开在那里。
 * @param {DatabaseSync} db 已打开的库。
 * @param {string} name 显示用的库名。
 * @param {(texts: string[]) => Promise<Float32Array[]>} embed 批量取向量。
 * @param {boolean} force 是否重建已有向量。
 * @returns {Promise<{written: number, dim: number | undefined}>} 写入条数与最终维度。
 */
async function processDatabase(db, name, embed, force) {
  /** 一次处理的表：读哪列、挑哪些行、写回哪。 */
  const targets = []
  if (hasTable(db, 'nodes')) {
    targets.push({
      table: 'nodes',
      text: 'content',
      where: force ? "(status = 'active' OR embedding IS NOT NULL)" : "status = 'active' AND embedding IS NULL",
    })
  }
  if (hasTable(db, 'observations')) {
    targets.push({
      table: 'observations',
      text: 'belief',
      where: force ? "(status != 'refuted' OR embedding IS NOT NULL)" : "status != 'refuted' AND embedding IS NULL",
    })
  }

  // 先读出全部待办行：写事务之前就要知道有多少活。
  const jobs = []
  for (const target of targets) {
    const rows = db.prepare(`SELECT id, ${target.text} AS text FROM ${target.table} WHERE ${target.where}`).all()
    for (const row of rows) jobs.push({ table: target.table, id: row.id, text: row.text })
  }
  if (jobs.length === 0) {
    console.log(`[backfill] ${name}: 无待处理条目`)
    return { written: 0, dim: readStoredDim(db) }
  }

  const storedDim = readStoredDim(db)
  console.log(`[backfill] ${name}: 待处理 ${jobs.length} 条${storedDim === undefined ? '' : `，库中向量 ${storedDim} 维`}`)

  // 推理放在事务外：算完一批再写，事务不会挂很久。
  const vectors = []
  for (let start = 0; start < jobs.length; start += CHUNK) {
    const slice = jobs.slice(start, start + CHUNK)
    const computed = await embed(slice.map(job => job.text))
    if (computed.length !== slice.length) {
      throw new Error(`嵌入器返回 ${computed.length} 条向量，期望 ${slice.length} 条`)
    }
    vectors.push(...computed)
    console.log(`[backfill] ${name}: ${Math.min(start + CHUNK, jobs.length)}/${jobs.length}`)
  }

  const dim = vectors[0].length
  if (!force && storedDim !== undefined && storedDim !== dim) {
    throw new Error(
      `模型给出 ${dim} 维向量，库中已有 ${storedDim} 维——不加 --force 会写出混合维度的库。`
      + `换模型请用 --force 重建全部向量，或把模型改回与库一致。`,
    )
  }

  db.exec('BEGIN')
  try {
    for (const table of ['nodes', 'observations']) {
      if (!hasTable(db, table)) continue
      const statement = db.prepare(`UPDATE ${table} SET embedding = ? WHERE id = ?`)
      for (let index = 0; index < jobs.length; index += 1) {
        const job = jobs[index]
        if (job.table !== table) continue
        const vector = vectors[index]
        statement.run(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength), job.id)
      }
    }
    // 校验放在提交之前：维度一旦不一致就整体回滚，库保持原样。
    const dims = storedDims(db)
    if (dims.length > 1) {
      throw new Error(`写完后仍有多个维度 ${dims.join(', ')}——已回滚`)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return { written: jobs.length, dim }
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  console.log(USAGE)
  process.exit(0)
}

const dbDir = options.dbDir ?? join(homedir(), '.dsh', 'engram')
const cacheDir = options.cacheDir ?? join(dbDir, 'models')
const paths = findDatabases(dbDir)
if (paths.length === 0) {
  console.log(`[backfill] ${dbDir} 下没有记忆分库，无需回填`)
  process.exit(0)
}

console.log(
  `[backfill] 模型 ${options.model}（pooling=${options.pooling}），`
  + `${options.force ? '重建全部向量' : '只补缺失向量'}，共 ${paths.length} 个分库`,
)

const embed = await createEmbedder({ model: options.model, pooling: options.pooling, cacheDir })

let total = 0
for (const path of paths) {
  const name = basename(path)
  const db = new DatabaseSync(path)
  let written = 0
  try {
    const result = await processDatabase(db, name, embed, options.force)
    written = result.written
  } catch (error) {
    // 单个分库失败就整体停下：半新半旧的向量比没有向量更难查。
    db.close()
    fail(`${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
  db.close()
  total += written
}
console.log(`[backfill] 完成：共写入 ${total} 条向量`)
