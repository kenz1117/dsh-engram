/**
 * 极简 tar 流的写入与解包：UStar 格式（POSIX.1-1988），足够本插件「打包几个 .db + _meta.json」场景。
 * 文件名长度 ≤ 99 字节、文件 ≤ 8 GiB 已覆盖本插件的备份规模；超过则抛错。
 * 不依赖 npm 包（无第三方 = 无供应链风险）；可被测试套件无障碍运行。
 * @module @kenz1117/dsh-engram/backup/tar-stream
 */

import { join } from 'node:path'
import type { Writable } from 'node:stream'

/** UStar 头字段宽度（POSIX.1-1988）。 */
const BLOCK_SIZE = 512
const NAME_LEN = 100
const SIZE_LEN = 12

/** 把数字按八进制 + ASCII 写入固定宽度（末尾置空）。 */
function writeOctal(buf: Buffer, offset: number, length: number, value: number): void {
  const str = value.toString(8).padStart(length - 1, '0')
  buf.write(str, offset, length - 1, 'ascii')
  buf.write('\0', offset + length - 1, 1, 'ascii')
}

/** 校验和：头块 0-511 字节所有字节求和（chksum 字段本身按空格处理）。 */
function computeChecksum(header: Buffer): number {
  let sum = 0
  for (let i = 0; i < BLOCK_SIZE; i += 1) sum += header[i]!
  return sum
}

/** 写一个文件条目到 tar 流（UStar 头 + 数据 + 填充到 512 边界）。 */
export function createTarPack(out: Writable, name: string, data: Buffer): void {
  if (name.length >= NAME_LEN) throw new Error(`tar 文件名过长（${String(name.length)} / ${String(NAME_LEN - 1)}）：${name}`)
  if (data.length >= 2 ** (8 * (SIZE_LEN - 1)) - 1) throw new Error(`tar 文件过大：${name}（${String(data.length)} bytes）`)
  const header = Buffer.alloc(BLOCK_SIZE)
  header.write(name, 0, NAME_LEN, 'ascii')
  // mode: 0o600
  writeOctal(header, 100, 8, 0o600)
  // uid / gid: 0
  writeOctal(header, 108, 8, 0)
  writeOctal(header, 116, 8, 0)
  // size
  writeOctal(header, 124, SIZE_LEN, data.length)
  // mtime: 当前时间
  writeOctal(header, 136, 12, Math.floor(Date.now() / 1000))
  // typeflag: '0' = regular file
  header.write('0', 156, 1, 'ascii')
  // magic: 'ustar\0'
  header.write('ustar\0', 257, 6, 'ascii')
  // version: '00'
  header.write('00', 263, 2, 'ascii')
  // magic + version 共 8 字节，chksum 在 offset 148..155
  // 先填 chksum 字段为 8 个空格，再算校验和回填。
  header.write('        ', 148, 8, 'ascii')
  const sum = computeChecksum(header)
  writeOctal(header, 148, 8, sum)
  out.write(header)
  out.write(data)
  // 填充到 512 边界。
  const padLen = (BLOCK_SIZE - (data.length % BLOCK_SIZE)) % BLOCK_SIZE
  if (padLen > 0) out.write(Buffer.alloc(padLen))
}

/** 写两个全 0 块作为 tar 结束标记（EOF）。 */
export function endTarPack(out: Writable): void {
  out.write(Buffer.alloc(BLOCK_SIZE * 2))
}

/** 解 tar 字节流到目标目录。整段读完再解析（备份场景文件小、可接受）。 */
export async function extractTar(buffer: Buffer, destDir: string): Promise<void> {
  const { writeFile, mkdir } = await import('node:fs/promises')
  const { dirname } = await import('node:path')
  let offset = 0
  while (offset + BLOCK_SIZE <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK_SIZE)
    if (header.every(b => b === 0)) return // tar EOF
    const name = header.toString('ascii', 0, NAME_LEN).replace(/\0+$/, '')
    const sizeOct = header.toString('ascii', 124, 124 + SIZE_LEN).replace(/\0+$/, '')
    const size = parseInt(sizeOct, 8)
    offset += BLOCK_SIZE
    if (size > 0) {
      const data = buffer.subarray(offset, offset + size)
      const target = join(destDir, name)
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      await writeFile(target, data, { mode: 0o600 })
      const pad = (BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE
      offset += size + pad
    } else {
      offset += (BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE
    }
  }
}


