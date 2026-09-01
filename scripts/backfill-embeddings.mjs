#!/usr/bin/env node
/**
 * 嵌入回填：给已有但缺向量的记忆补算 embedding。
 * 场景：嵌入器曾降级（模型未就绪）时摄取/保存的记忆没有向量，
 * 语义检索上线后运行本脚本一次，让存量记忆参与向量道。
 *
 * 用法：node scripts/backfill-embeddings.mjs [dbDir]
 * 默认 dbDir = ~/.dsh/engram；只处理 active 且 embedding IS NULL 的条目。
 */

import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pipeline, env } from '@huggingface/transformers'

const dbDir = process.argv[2] ?? join(homedir(), '.dsh', 'engram')
const modelCacheDir = join(dbDir, 'models')
const MODEL_ID = 'Xenova/bge-small-zh-v1.5'

const dbs = ['user.db', 'project-db'].map(name => join(dbDir, name)).filter(p => {
  try { return new DatabaseSync(p, { readOnly: true }) && true } catch { return false }
})
if (dbs.length === 0) {
  console.log('[backfill] 未找到任何记忆分库，无需回填')
  process.exit(0)
}

env.cacheDir = modelCacheDir
// 下载端点可经 HF_ENDPOINT 覆盖（镜像）；模型已在缓存时不会访问网络。
if (process.env.HF_ENDPOINT) env.remoteHost = process.env.HF_ENDPOINT
const extractor = await pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' })
const embed = async text => {
  const output = await extractor([text], { pooling: 'mean', normalize: true })
  return new Float32Array(output.tolist()[0])
}

let patched = 0
for (const path of dbs) {
  const db = new DatabaseSync(path)
  const rows = db.prepare("SELECT id, content FROM nodes WHERE status = 'active' AND embedding IS NULL").all()
  if (rows.length === 0) {
    console.log(`[backfill] ${path}: 无缺向量条目`)
    db.close()
    continue
  }
  db.exec('BEGIN')
  try {
    for (const row of rows) {
      const vector = await embed(row.content)
      db.prepare('UPDATE nodes SET embedding = ? WHERE id = ?')
        .run(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength), row.id)
      patched += 1
      console.log(`[backfill] ${path}: ${row.content.slice(0, 24)}… ✓`)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    db.close()
    throw error
  }
  db.close()
}
console.log(`[backfill] 完成：共补算 ${patched} 条向量`)
