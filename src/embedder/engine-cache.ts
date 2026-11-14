/**
 * Web Cache API 的 fs 实现：transformers.js 的 web 构建里 `env.cacheDir` 无效
 * （node:fs 被构建 stub 掉，文件操作全部落空），模型文件只能走
 * `env.useCustomCache` + `env.customCache`。这个 shim 把缓存落到真文件系统，
 * 让「首次联网下载、之后完全离线」的契约在 WASM 引擎下继续成立。
 * @module @kenz1117/dsh-engram/embedder/engine-cache
 */

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 缓存键 → 落盘文件名。键是模型文件的下载 URL（可能带 query），直接当文件名
 * 既超长又含路径分隔符；取 sha256 前 32 个十六进制位加原始扩展名（截 12 字符），
 * 不同文件互不覆盖，排查时还能认出类型。
 */
function keyToPath(dir: string, key: unknown): string {
  const name = String(key)
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 32)
  const extension = (name.split('?')[0]?.match(/\.[A-Za-z0-9]+$/) ?? [''])[0]?.slice(0, 12) ?? ''
  return join(dir, `${hash}${extension}`)
}

/** transformers.js customCache 契约的最小面：match 未命中返回 undefined。 */
export interface FsModelCache {
  match(key: unknown): Promise<Response | undefined>
  put(key: unknown, response: Response): Promise<void>
}

/**
 * 建 fs 落盘的模型缓存。
 * @param dir - 缓存目录；createLocalEmbedder 已保证它存在（0o700）。
 */
export function createFsModelCache(dir: string): FsModelCache {
  return {
    async match(key) {
      try {
        const data = await readFile(keyToPath(dir, key))
        // content-length 与真实 Web Cache 对齐：transformers 按它核对完整性。
        return new Response(data, {
          status: 200,
          headers: { 'content-length': String(data.byteLength) },
        })
      } catch {
        return undefined // 未命中：交给 transformers 走网络下载
      }
    },
    async put(key, response) {
      // 读 clone 出的副本：transformers 首次加载还要消费原 response，
      // 先读原件会把它耗尽。
      const data = await response.clone().arrayBuffer()
      await writeFile(keyToPath(dir, key), Buffer.from(data))
    },
  }
}
