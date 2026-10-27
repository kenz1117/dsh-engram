/**
 * 面板数据获取的公共 hook（审计 §10 / 2026-10-27 批次 3）：数据/失败两态 + 卸载守卫
 * + 手动重载。EngramPanel 里同一套「useState + useCallback(fetch) + useEffect」模式
 * 复制了 15 处——先在 OpsTab 落地为范式载体，其余调用点后续批次逐个迁移（各处自有
 * 的 busy/表单同步逻辑留在调用方，hook 只收敛请求-竞态-重载这条主干）。
 * @module @kenz1117/dsh-engram/client/useApi
 */

import { useCallback, useEffect, useState } from 'react'
import { api } from './rpc.ts'

/** useApi 的返回：data/failed 二态（加载中 = data 与 failed 皆 null，沿用面板 EmptyState 风格的判定）。 */
export interface UseApiResult<T> {
  readonly data: T | null
  readonly failed: string | null
  /** 重新发起请求（成功后清 failed；竞态由卸载守卫与后到丢弃兜底）。 */
  readonly reload: () => void
}

/**
 * GET 一条面板数据。deps 变化（或手动 reload）时重取；乱序响应只认最后发起的那次。
 * @param path - `/api/engram/` 之后的路径（含 query）。
 * @param deps - 重取依赖（与 useEffect 同语义）；path 变化本身就触发重取，无需重复声明。
 */
export function useApi<T>(path: string, deps: readonly unknown[] = []): UseApiResult<T> {
  const [data, setData] = useState<T | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let cancelled = false
    api<T>(path)
      .then((parsed) => {
        if (cancelled) return
        setData(parsed)
        setFailed(null)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setFailed(error instanceof Error ? error.message : String(error))
      })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps 由调用方按值声明；path 变化由调用方保证进 deps 或整体换 key
  }, [path, tick, ...deps])
  const reload = useCallback((): void => { setTick(value => value + 1) }, [])
  return { data, failed, reload }
}
