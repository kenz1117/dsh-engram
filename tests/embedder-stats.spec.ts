import { describe, expect, it, vi } from 'vitest'
import { createSerialChain, runSerial } from '../src/embedder/local.ts'

// 进程级计数器在模块里是单例：每个用例经 vi.resetModules + 动态 import 拿
// 全新实例，互不污染（真实代码路径里它就该跨实例共享，这里只测行为）。
const freshStats = async (): Promise<typeof import('../src/embedder/stats.ts')> => {
  vi.resetModules()
  return await import('../src/embedder/stats.ts')
}

describe('runSerial 串行队列', () => {
  /** 手动放行的 promise（观察重叠与顺序用）。 */
  const deferred = <T,>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } => {
    let resolve!: (value: T) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
  }

  it('并发入队保序完成：先入队先执行，结果与入队顺序一致', async () => {
    const chain = createSerialChain()
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()]
    const order: string[] = []
    // 三路「同时」入队：若实现真的并发（或乱序），完成顺序就会与入队顺序脱钩。
    const runs = [
      runSerial(chain, async () => { order.push('a-start'); await gates[0]!.promise; order.push('a-done'); return 'a' }),
      runSerial(chain, async () => { order.push('b-start'); await gates[1]!.promise; order.push('b-done'); return 'b' }),
      runSerial(chain, async () => { order.push('c-start'); await gates[2]!.promise; order.push('c-done'); return 'c' }),
    ]
    // 微任务排水：setTimeout 排在所有挂起的微任务之后，用于观察队列当前状态。
    const flush = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })
    await flush()
    // b、c 已入队但 a 没完成：谁都不能先跑。
    expect(order).toEqual(['a-start'])
    gates[0]!.resolve('x')
    await flush()
    expect(order).toEqual(['a-start', 'a-done', 'b-start'])
    gates[1]!.resolve('y')
    gates[2]!.resolve('z')
    expect(await Promise.all(runs)).toEqual(['a', 'b', 'c'])
    expect(order).toEqual(['a-start', 'a-done', 'b-start', 'b-done', 'c-start', 'c-done'])
  })

  it('前序 reject 不连坐：链不断，后续调用照常执行并透传返回值', async () => {
    const chain = createSerialChain()
    const first = runSerial(chain, async () => { throw new Error('首战失利') })
    const second = runSerial(chain, async () => 'second-ok')
    await expect(first).rejects.toThrow('首战失利')
    expect(await second).toBe('second-ok')
    // 再来一路：链尾保持可用，队列可继续复用。
    expect(await runSerial(chain, async () => 'third-ok')).toBe('third-ok')
  })

  it('返回值与异常各自透传：调用方拿到的就是自己那一路的结果', async () => {
    const chain = createSerialChain()
    expect(await runSerial(chain, async () => [1, 2, 3])).toEqual([1, 2, 3])
    await expect(runSerial(chain, async () => { throw new Error('boom') })).rejects.toThrow('boom')
  })
})

describe('嵌入调用计数（进程级，本次运行）', () => {
  it('成功与失败分别累加，lastError 截断到 ~200 字符', async () => {
    const { recordEmbedAttempt, embedderStatsSnapshot } = await freshStats()
    recordEmbedAttempt(false)
    recordEmbedAttempt(false)
    recordEmbedAttempt(true, new Error('Session already started'))
    const snapshot = embedderStatsSnapshot()
    expect(snapshot.attempts).toBe(3)
    expect(snapshot.failures).toBe(1)
    expect(snapshot.lastError).toBe('Session already started')
    expect(snapshot.lastFailureAtMs).toBeGreaterThan(0)
    recordEmbedAttempt(true, new Error('x'.repeat(500)))
    const truncated = embedderStatsSnapshot()
    expect(truncated.failures).toBe(2)
    expect(truncated.lastError!.length).toBeLessThanOrEqual(201) // 200 字符 + 省略号
    expect(truncated.lastError!.endsWith('…')).toBe(true)
  })

  it('快照是幂等副本：改快照、重复取值都不影响内部计数', async () => {
    const { recordEmbedAttempt, embedderStatsSnapshot } = await freshStats()
    recordEmbedAttempt(false)
    const first = embedderStatsSnapshot()
    expect(embedderStatsSnapshot()).toEqual(first)
    // 可选字段只在有值时出现：尚未失败时没有 lastError/lastFailureAtMs。
    expect('lastError' in first).toBe(false)
    expect('lastFailureAtMs' in first).toBe(false)
  })

  it('非 Error 的抛出物也计入 lastError（String 化）', async () => {
    const { recordEmbedAttempt, embedderStatsSnapshot } = await freshStats()
    recordEmbedAttempt(true, 'plain string failure')
    expect(embedderStatsSnapshot().lastError).toBe('plain string failure')
  })
})
