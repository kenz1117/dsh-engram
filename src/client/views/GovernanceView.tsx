/**
 * Governance workface：矛盾队列与治理审计。
 * 处置前完整展示双侧记忆与稳定身份；“改判为相关”保留两条，“闭馆此条”归档所选侧。
 * 只展示后端真实产出：矛盾来自 governance 路由，作业状态来自 jobs 路由。
 * @module @kenz1117/dsh-engram/client/views/GovernanceView
 */

import { useState } from 'react'
import type { ReactElement } from 'react'
import styles from '../panel.module.css'
import { api } from '../rpc.ts'
import { useApi } from '../useApi.ts'
import { EmptyState, kindLabel, roomPillClass, type T } from '../ui/panel-kit.tsx'
import { IdentityBadge } from '../ui/IdentityBadge.tsx'
import { ConfirmButton } from '../ui/ConfirmButton.tsx'

interface GovernanceSide {
  readonly id: string
  readonly memoryId: string
  readonly kind: string
  readonly content: string
  readonly status: string
}

interface GovernancePair {
  readonly first: GovernanceSide
  readonly second: GovernanceSide
  readonly createdAt: number
}

interface GovernanceList {
  readonly items: readonly GovernancePair[]
  readonly total: number
}

interface JobSummary {
  readonly id: string
  readonly kind: string
  readonly status: 'queued' | 'running' | 'done' | 'dead'
  readonly attempts: number
  readonly maxAttempts: number
  readonly lastError: string | null
}

interface JobsList {
  readonly available: boolean
  readonly summary: { readonly total: number; readonly queued: number; readonly running: number; readonly done: number; readonly dead: number }
  readonly items: readonly JobSummary[]
}

interface GovernanceViewProps {
  readonly t: T
  readonly scope: 'user' | 'project' | 'shared'
  readonly reloadTick: number
  readonly onChanged: () => void
}

interface GovernanceAction {
  readonly action: 'dismiss' | 'forget-loser'
  readonly firstId: string
  readonly secondId: string
  readonly loserId?: string
}

export function GovernanceView({ t, scope, reloadTick, onChanged }: GovernanceViewProps): ReactElement {
  const path = `governance?scope=${scope}&limit=50&tick=${String(reloadTick)}`
  const { data, failed, reload } = useApi<GovernanceList>(path)
  const jobs = useApi<JobsList>('jobs?limit=20')
  const [busy, setBusy] = useState<string | null>(null)
  const [failedAction, setFailedAction] = useState<string | null>(null)
  const items = data?.items ?? []

  const act = (body: GovernanceAction, key: string): void => {
    if (busy !== null) return
    setBusy(key)
    setFailedAction(null)
    api('governance', {
      method: 'POST',
      body: JSON.stringify({ ...body, scope }),
    })
      .then(() => { reload(); onChanged() })
      .catch((actionError: unknown) => {
        setFailedAction(actionError instanceof Error ? actionError.message : String(actionError))
      })
      .finally(() => setBusy(null))
  }

  /**
   * 一侧记忆的卡片：正文、身份与「闭馆此条」。
   * 闭馆按钮长在它要闭的那条记忆上——两个同名按钮并排时，人无法知道点的是哪一侧。
   */
  const side = (row: GovernanceSide, pair: GovernancePair, key: string): ReactElement => (
    <div className={styles.govSide}>
      <span className={roomPillClass(row.kind)}>{kindLabel(t, row.kind)}</span>
      <p>{row.content}</p>
      <IdentityBadge memoryId={row.memoryId} memoryLabel={t('governanceStableId')} />
      <ConfirmButton className={styles.govSideAction ?? ''} disabled={busy !== null}
        label={t('governanceForgetSide')} confirmLabel={t('governanceForgetConfirm')}
        title={t('governanceForgetConfirm')}
        onConfirm={() => {
          act({
            action: 'forget-loser',
            firstId: pair.first.id,
            secondId: pair.second.id,
            loserId: row.id,
          }, key)
        }} />
    </div>
  )

  return (
    <div>
      {failed !== null && <div className={styles.expandLoading}>{t('governanceFailed')}</div>}
      {failed === null && (
        <>
          <div className={styles.sectionHead}>
            <h4 className={styles.sectionTitle}>{t('governanceTitle')}</h4>
            <span className={styles.sectionHint}>{t('governanceHint')}</span>
          </div>
          <div className={styles.toolbarRow}>
            <span className={styles.toolbarCount}>{t('governanceCount', { n: items.length })}</span>
            {jobs.data !== null && (
              <span className={styles.toolbarCount}>
                {t('attentionJobsQueued', { n: jobs.data.summary.queued })}
                {jobs.data.summary.dead > 0 ? ` · ${t('attentionJobsDead', { n: jobs.data.summary.dead })}` : ''}
              </span>
            )}
          </div>
          {items.length === 0 && <EmptyState title={t('governanceEmpty')} />}
          <div className={styles.govList}>
            {items.map(pair => {
              const pairKey = `${String(pair.first.id)}:${String(pair.second.id)}`
              return (
                <article key={pairKey} className={styles.govCard}>
                  <div className={styles.govSides}>
                    {side(pair.first, pair, `${pairKey}:first`)}
                    {side(pair.second, pair, `${pairKey}:second`)}
                  </div>
                  <div className={styles.govActions}>
                    <button type="button" className={styles.button}
                      disabled={busy !== null}
                      onClick={() => { act({ action: 'dismiss', firstId: pair.first.id, secondId: pair.second.id }, `${pairKey}:dismiss`) }}>
                      {t('governanceDismiss')}
                    </button>
                    <span className={styles.sectionHint}>{t('governanceDismissHint')}</span>
                  </div>
                </article>
              )
            })}
          </div>
          {failedAction !== null && (
            <div className={styles.expandLoading}>{t('governanceActionFailed')}: {failedAction}</div>
          )}
        </>
      )}
    </div>
  )
}
