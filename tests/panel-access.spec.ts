/**
 * 面板访问面守卫的单元测试（issue #49：panelAccess 档位开关）。
 *
 * guardLoopback 是面板 API 的第一道门：method + peer + Host 三重校验，lan=true
 * 才放宽到私网；guardWrite 是写操作的第二道门（Origin + Content-Type）。这组用例
 * 把两道门在 loopback / lan 两种档位下的放行与拒绝矩阵逐格钉死——方括号 IPv6
 * Host、mapped 地址、DNS rebinding 域名这些边界值一并锁进矩阵，拒绝文案与状态码
 * 也钉死，防止提示悄悄变样。全部进程内 fake，不发真实网络请求。
 * @module tests/panel-access
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { guardLoopback, guardWrite } from '../src/routes.ts'

/** 守卫只读 method / headers / socket.remoteAddress 三处，fake 到位即可，无需真请求。 */
function fakeReq(method: string, remoteAddress: string | undefined, headers: Record<string, string | undefined> = {}): IncomingMessage {
  return { method, headers, socket: { remoteAddress } } as unknown as IncomingMessage
}

/** 截 writeHead/end 的假响应：status()/body() 读回被写下的状态码与文案，未写即 undefined。 */
function fakeRes(): { res: ServerResponse, status: () => number | undefined, body: () => string | undefined } {
  const written: { code?: number | undefined, text?: string | undefined } = {}
  const res = {
    writeHead: (code: number) => {
      written.code = code
      return res
    },
    end: (text?: string | undefined) => {
      written.text = text
    },
  } as unknown as ServerResponse
  return { res, status: () => written.code, body: () => written.text }
}

/** 断言放行：返回 true 且守卫没有碰响应。 */
function expectAllowed(ok: boolean, res: ReturnType<typeof fakeRes>, context: string): void {
  expect(ok, context).toBe(true)
  expect(res.status(), context).toBeUndefined()
  expect(res.body(), context).toBeUndefined()
}

/** 断言拒绝：返回 false，状态码与 JSON 文案一并钉死。 */
function expectRejected(ok: boolean, res: ReturnType<typeof fakeRes>, code: number, reason: string, context: string): void {
  expect(ok, context).toBe(false)
  expect(res.status(), context).toBe(code)
  expect(res.body(), context).toBe(JSON.stringify({ error: reason }))
}

describe('guardLoopback(loopback 模式)', () => {
  const LOOPBACK_ONLY = 'forbidden: loopback only'

  it('回环 peer 的 GET/POST 放行且不写响应', () => {
    for (const peer of ['127.0.0.1', '127.255.0.9', '::1', '::ffff:127.0.0.1']) {
      for (const method of ['GET', 'POST']) {
        const res = fakeRes()
        expectAllowed(guardLoopback(fakeReq(method, peer), res.res), res, `peer=${peer} method=${method}`)
      }
    }
  })

  it('缺省参数即 loopback 档（lan 不传时与显式 false 等价）', () => {
    for (const lan of [undefined, false] as const) {
      const res = fakeRes()
      const req = fakeReq('GET', '192.168.1.10')
      expectRejected(
        lan === undefined ? guardLoopback(req, res.res) : guardLoopback(req, res.res, lan),
        res,
        403,
        LOOPBACK_ONLY,
        `lan=${String(lan)}`,
      )
    }
  })

  it('非回环 peer 403 loud 失败', () => {
    for (const peer of ['8.8.8.8', '11.12.13.14', '192.168.1.10', '10.0.0.5', '172.20.0.5', '::ffff:192.168.1.10', 'fe80::1', 'fd00::1', undefined]) {
      const res = fakeRes()
      expectRejected(guardLoopback(fakeReq('GET', peer), res.res), res, 403, LOOPBACK_ONLY, `peer=${String(peer)}`)
    }
  })

  it('非 GET/POST 方法 403 loud 失败', () => {
    for (const method of ['DELETE', 'PUT', 'PATCH', 'OPTIONS']) {
      const res = fakeRes()
      expectRejected(guardLoopback(fakeReq(method, '127.0.0.1'), res.res), res, 403, LOOPBACK_ONLY, `method=${method}`)
    }
  })

  it('Host 缺省或回环名放行（含方括号 IPv6 与去端口）', () => {
    for (const host of [undefined, '', 'localhost', 'localhost:5655', '127.0.0.1', '127.0.0.1:5655', '127.255.255.254', '[::1]', '[::1]:5655']) {
      const res = fakeRes()
      expectAllowed(
        guardLoopback(fakeReq('GET', '127.0.0.1', { host }), res.res),
        res,
        `host=${host === undefined ? '(缺省)' : `'${host}'`}`,
      )
    }
  })

  it('非回环 Host 403 loud 失败', () => {
    for (const host of ['evil.com', 'evil.com:5655', '127.0.0.1.attacker.com', '192.168.1.10', '999.1.1.1', 'nas', 'Desktop.local']) {
      const res = fakeRes()
      expectRejected(guardLoopback(fakeReq('GET', '127.0.0.1', { host }), res.res), res, 403, LOOPBACK_ONLY, `host='${host}'`)
    }
  })

  it('裸 ::1 的 Host 不在放行面（与旧版 split 行为一致；实际流量走方括号形式）', () => {
    // hostNameOf 的去端口启发式会把不带方括号的 '::1' 截成 ':'（末冒号后是数字 '1'，
    // 被当作端口切掉），旧版 split(':')[0] 同样拒绝它。方括号形式才是 IPv6 Host 的
    // 真实放行面——浏览器与 fetch 发 IPv6 Host 时必带方括号（见上一条矩阵）。
    const res = fakeRes()
    expectRejected(guardLoopback(fakeReq('GET', '127.0.0.1', { host: '::1' }), res.res), res, 403, LOOPBACK_ONLY, "host='::1'")
  })
})

describe('guardLoopback(lan 模式)', () => {
  const LAN_ONLY = 'forbidden: loopback or private LAN only'

  it('私网 peer 放行（RFC1918 / ULA / 链路本地 / mapped，回环仍在内）', () => {
    for (const peer of [
      '127.0.0.1', '::1', '::ffff:127.0.0.1',
      '10.1.2.3', '10.255.255.255', '172.16.0.1', '172.20.14.6', '172.31.255.255', '192.168.1.10',
      'fc00::1', 'fdab:1234::1', 'fe80::1', 'febf::1',
      '::ffff:192.168.1.10', '::ffff:10.0.0.5', '::ffff:172.16.0.1',
    ]) {
      const res = fakeRes()
      expectAllowed(guardLoopback(fakeReq('GET', peer), res.res, true), res, `peer=${peer}`)
    }
  })

  it('公网与非私网 peer 仍 403 loud 失败', () => {
    for (const peer of ['8.8.8.8', '11.12.13.14', '172.32.0.5', '172.15.0.5', '999.1.1.1', '::ffff:8.8.8.8', '::ffff:172.32.0.5', 'fec0::1']) {
      const res = fakeRes()
      expectRejected(guardLoopback(fakeReq('GET', peer), res.res, true), res, 403, LAN_ONLY, `peer=${peer}`)
    }
  })

  it('lan 模式 Host 面放行（字面量 / 单标签 / .local，大小写不敏感）', () => {
    for (const host of [
      'localhost', 'localhost:5655', '127.0.0.1', '127.0.0.1:5655',
      '192.168.1.10', '192.168.1.10:3000', '10.8.8.8:80', '172.16.0.1',
      '::1', 'fd00::1', '[::1]:5655', '[fd00::1]:5655',
      'nas', 'MyNAS', 'Desktop.local', 'DESKTOP.LOCAL', 'nas.local:8080',
    ]) {
      const res = fakeRes()
      expectAllowed(guardLoopback(fakeReq('GET', '192.168.1.10', { host }), res.res, true), res, `host='${host}'`)
    }
  })

  it('lan 模式仍拒绝多标签域名 loud 失败（防 DNS rebinding）', () => {
    for (const host of ['evil.com', 'evil.com:5655', '127.0.0.1.attacker.com', 'a.b.local.evil.com']) {
      const res = fakeRes()
      expectRejected(guardLoopback(fakeReq('GET', '192.168.1.10', { host }), res.res, true), res, 403, LAN_ONLY, `host='${host}'`)
    }
  })

  it('lan 模式 Host 非字面量点串（越界段）仍拒——字面性要带 ≤255 上界', () => {
    for (const host of ['999.1.1.1', '256.1.1.1', '1.1.1.256']) {
      const res = fakeRes()
      expectRejected(guardLoopback(fakeReq('GET', '192.168.1.10', { host }), res.res, true), res, 403, LAN_ONLY, `host='${host}'`)
    }
  })
})

describe('guardWrite', () => {
  const LOOPBACK_ONLY = 'forbidden: loopback only'
  const LAN_ONLY = 'forbidden: loopback or private LAN only'

  /** guardWrite 只看 headers，peer 无关；统一 POST。 */
  function writeWith(origin: string | undefined, contentType: string | undefined, lan: boolean): { ok: boolean, res: ReturnType<typeof fakeRes> } {
    const res = fakeRes()
    const req = fakeReq('POST', '127.0.0.1', { origin, 'content-type': contentType })
    return { ok: guardWrite(req, res.res, lan), res }
  }

  it('Origin 缺省与回环 Origin 在 loopback 模式放行且不写响应', () => {
    for (const origin of [undefined, '', 'http://localhost:5655', 'http://127.0.0.1:5655']) {
      const run = writeWith(origin, 'application/json', false)
      expectAllowed(run.ok, run.res, `origin=${origin === undefined ? '(缺省)' : `'${origin}'`}`)
    }
  })

  it('私网 Origin 仅 lan 模式放行', () => {
    const resLoopback = writeWith('http://192.168.1.10:3000', 'application/json', false)
    expectRejected(resLoopback.ok, resLoopback.res, 403, LOOPBACK_ONLY, "origin='http://192.168.1.10:3000' lan=false")
    for (const origin of ['http://192.168.1.10:3000', 'http://10.0.0.5:3000', 'http://nas:3000', 'http://Desktop.local:3000']) {
      const run = writeWith(origin, 'application/json', true)
      expectAllowed(run.ok, run.res, `origin='${origin}' lan=true`)
    }
  })

  it('外域与无法解析的 Origin 两种模式都 403 loud 失败', () => {
    for (const origin of ['https://evil.example', 'not-a-url']) {
      const loopback = writeWith(origin, 'application/json', false)
      expectRejected(loopback.ok, loopback.res, 403, LOOPBACK_ONLY, `origin='${origin}' lan=false`)
      const lan = writeWith(origin, 'application/json', true)
      expectRejected(lan.ok, lan.res, 403, LAN_ONLY, `origin='${origin}' lan=true`)
    }
  })

  it('Content-Type 非 JSON 415 unsupported content-type loud 失败（两种模式一致）', () => {
    for (const contentType of [undefined, 'text/plain', 'application/x-www-form-urlencoded']) {
      for (const lan of [false, true]) {
        const run = writeWith(undefined, contentType, lan)
        expectRejected(run.ok, run.res, 415, 'unsupported content-type', `content-type=${String(contentType)} lan=${String(lan)}`)
      }
    }
  })

  it('Content-Type 为 application/json 时放行（带参与大小写均可）', () => {
    for (const contentType of ['application/json', 'application/json; charset=utf-8', 'Application/JSON; charset=UTF-8']) {
      for (const lan of [false, true]) {
        const run = writeWith(undefined, contentType, lan)
        expectAllowed(run.ok, run.res, `content-type='${contentType}' lan=${String(lan)}`)
      }
    }
  })
})
