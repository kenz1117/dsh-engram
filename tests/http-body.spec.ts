/**
 * 回环 API 的 JSON body 读取器：上限口径、失败原因可辨、多字节解码不串字。
 *
 * 这组用例锁的是 issue #34 的根因：导入请求体曾被 64 KiB 的上限静默丢弃，
 * 报成「导入文件不是 JSON 对象」——用户的导出件（实测 117 KB / 165 KB）明明是
 * 合法 JSON 对象。真凶是服务端上限，提示却指向用户的文件。
 */

import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { BODY_LIMIT_BYTES, IMPORT_BODY_LIMIT_BYTES } from '../src/body-limits.ts'
import { readJsonBody, type JsonBodyResult } from '../src/http-body.ts'

let server: Server | undefined

afterEach(async () => {
  const running = server
  if (running !== undefined) {
    await new Promise<void>(resolve => { running.close(() => resolve()) })
    server = undefined
  }
})

/** 起一个只做 body 读取的小服务，把读取结果原样回传（便于断言可辨的原因）。 */
async function startReader(limit: number): Promise<number> {
  const created = createServer((req, res) => {
    void readJsonBody(req, limit).then((result: JsonBodyResult) => {
      const payload = JSON.stringify(result)
      // 显式 content-length：裸 socket 那边好直接取 body，不用解 chunked 响应。
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) })
      res.end(payload)
    })
  })
  server = created
  await new Promise<void>(resolve => { created.listen(0, '127.0.0.1', resolve) })
  return (created.address() as AddressInfo).port
}

/** POST 一段普通 body，返回服务端回传的读取结果。 */
async function post(port: number, body: string): Promise<JsonBodyResult> {
  return new Promise<JsonBodyResult>((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method: 'POST', headers: { 'content-type': 'application/json' } },
      res => {
        let text = ''
        res.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
        res.on('end', () => { resolve(JSON.parse(text) as JsonBodyResult) })
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

/** 裸 socket 发分块 body：块边界由自己定，用来复现「多字节字符跨块」。 */
async function postChunked(port: number, chunks: Buffer[]): Promise<JsonBodyResult> {
  return new Promise<JsonBodyResult>((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write('POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n')
      for (const chunk of chunks) {
        socket.write(`${chunk.length.toString(16)}\r\n`)
        socket.write(chunk)
        socket.write('\r\n')
      }
      socket.write('0\r\n\r\n')
    })
    let text = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => { text += chunk })
    socket.on('error', reject)
    socket.on('end', () => {
      // 裸 socket 收到的是完整 HTTP 响应，剥掉响应头再解析 body。
      const separator = text.indexOf('\r\n\r\n')
      if (separator === -1) { reject(new Error(`no header separator in: ${text.slice(0, 80)}`)); return }
      try {
        resolve(JSON.parse(text.slice(separator + 4)) as JsonBodyResult)
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })
}

describe('readJsonBody 上限口径', () => {
  it('issue #34 的现场导出件（165 KB 量级）：普通上限拒、导入上限放行', async () => {
    // 复刻现场：1200 条中文记录，导出件落在 165 KB 上下（现场是 117 KB 与 165 KB 两份）。
    const payload = JSON.stringify({
      records: Array.from({ length: 1200 }, (_, index) => ({ content: `中文记忆内容第${String(index)}条${'内'.repeat(20)}` })),
    })
    const bytes = Buffer.byteLength(payload, 'utf8')
    expect(bytes).toBeGreaterThan(64 * 1024)
    expect(bytes).toBeLessThan(512 * 1024)
    const port = await startReader(BODY_LIMIT_BYTES)
    const rejected = await post(port, payload)
    expect(rejected.ok).toBe(false)
    expect(rejected.ok === false && rejected.reason).toBe('too-large')

    const importPort = await startReader(IMPORT_BODY_LIMIT_BYTES)
    const accepted = await post(importPort, payload)
    expect(accepted.ok).toBe(true)
  })

  it('按字节算上限：30 KB 中文（90 KB 字节）算超限，按字符算不会', async () => {
    // 30K 个中文字符 = 30K 字符（字符口径下不超限），但 UTF-8 是 90 KB 字节（字节口径超限）。
    const payload = JSON.stringify({ content: '中'.repeat(30 * 1024) })
    expect(payload.length).toBeLessThan(BODY_LIMIT_BYTES)
    expect(Buffer.byteLength(payload, 'utf8')).toBeGreaterThan(BODY_LIMIT_BYTES)
    const port = await startReader(BODY_LIMIT_BYTES)
    const result = await post(port, payload)
    expect(result.ok === false && result.reason).toBe('too-large')
  })

  it('超限后不再累积 body——只报上限与原因', async () => {
    // 注：这里断言的是「读取器不再攒 body」（chunks 封顶在 limit）与「报出上限」。
    // 进程 RSS 仍会随 body 大小涨——那是 Node 流缓冲与 GC 滞后，与本读取器无关。
    const port = await startReader(1024)
    const result = await post(port, 'x'.repeat(64 * 1024))
    expect(result.ok === false && result.reason).toBe('too-large')
    expect(result.ok === false && result.reason === 'too-large' && result.limit).toBe(1024)
  })

  it('分块上传（无 Content-Length）同样受上限约束——不能只靠 Content-Length 早判', async () => {
    const port = await startReader(1024)
    const result = await postChunked(port, [Buffer.alloc(4096, 0x78)])
    expect(result.ok === false && result.reason).toBe('too-large')
  })

  it('分块上传的正常 body 读得出来（多块拼接后仍是一个完整 JSON）', async () => {
    const port = await startReader(BODY_LIMIT_BYTES)
    const payload = Buffer.from(JSON.stringify({ content: '中文' }), 'utf8')
    const result = await postChunked(port, [payload.subarray(0, 5), payload.subarray(5)])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.body.content).toBe('中文')
  })
})

describe('readJsonBody 失败原因可辨', () => {
  it('坏 JSON → malformed（带解析器原话）', async () => {
    const port = await startReader(BODY_LIMIT_BYTES)
    const result = await post(port, '{not json')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('malformed')
      expect(result.reason === 'malformed' && result.error.length).toBeGreaterThan(0)
    }
  })

  it('JSON 数组 / 标量 → not-object（不是「malformed」）', async () => {
    const port = await startReader(BODY_LIMIT_BYTES)
    for (const body of ['[1,2,3]', '"文本"', '42', 'null']) {
      const result = await post(port, body)
      expect(result.ok === false && result.reason).toBe('not-object')
    }
  })

  it('空 body 当空对象（与旧行为一致）', async () => {
    const port = await startReader(BODY_LIMIT_BYTES)
    const result = await post(port, '')
    expect(result.ok).toBe(true)
    expect(result.ok && result.body).toEqual({})
  })

  it('坏 body 不再降级成空对象——原因必须可辨', async () => {
    // v0.9.6 之前有个 readJsonBodyOrEmpty：坏 body 一律当空对象，于是超限会掉进
    // 字段校验、报成「id required」（#34 的同款甩锅）。这个宽容降级已删除。
    const port = await startReader(BODY_LIMIT_BYTES)
    const malformed = await post(port, '{not json')
    expect(malformed.ok === false && malformed.reason).toBe('malformed')
    const oversized = await post(port, 'x'.repeat(70 * 1024))
    expect(oversized.ok === false && oversized.reason).toBe('too-large')
  })
})

describe('readJsonBody 多字节解码', () => {
  it('多字节字符跨块边界不串字（逐块解码会把它切成两个 U+FFFD）', async () => {
    const port = await startReader(BODY_LIMIT_BYTES)
    const json = Buffer.from(JSON.stringify({ content: '中' }), 'utf8')
    const char = Buffer.from('中', 'utf8')
    expect(char.length).toBe(3)
    const at = json.indexOf(char)
    expect(at).toBeGreaterThan(0)
    // 块边界切在字符中间：第一块到字符首字节为止，第二块从余下 2 字节开始。
    const chunks = [json.subarray(0, at + 1), json.subarray(at + 1)]
    const result = await postChunked(port, chunks)
    expect(result.ok).toBe(true)
    if (result.ok) {
      // 逐块 String(chunk) 会得到「��」；整块解码才拿得到「中」。
      expect(result.body.content).toBe('中')
    }
  })
})
