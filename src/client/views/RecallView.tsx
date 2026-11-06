/**
 * Recall workface：真实召回实验台。
 * 输入查询跑真实检索，展示命中道（关键词/语义/边扩展）、得分与稳定身份 provenance；
 * 降级（向量不可用）必须显式标出，不能让关键词结果冒充完整召回。
 * @module @kenz1117/dsh-engram/client/views/RecallView
 */

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import styles from '../panel.module.css'
import { api } from '../rpc.ts'
import { EmptyState, kindLabel, roomPillClass, SelectField, type T } from '../ui/panel-kit.tsx'
import { IdentityBadge } from '../ui/IdentityBadge.tsx'

interface RecallHit {
  readonly id: string
  readonly memoryId: string
  readonly revisionId: string
  readonly score: number
  readonly via: 'fts' | 'vec' | 'both'
  readonly viaEdge?: { readonly from: string; readonly type: string }
  readonly scope: string
  readonly kind: string
  readonly content: string
}

interface RecallResult {
  readonly degraded: boolean
  readonly hits: readonly RecallHit[]
}

interface RecallViewProps {
  readonly t: T
  readonly scope: 'user' | 'project' | 'shared'
  readonly onSelect?: (id: string) => void
}

const VIA_KEY: Record<RecallHit['via'], Parameters<T>[0]> = { fts: 'viaFts', vec: 'viaVec', both: 'viaBoth' }

export function RecallView({ t, scope, onSelect }: RecallViewProps): ReactElement {
  const [query, setQuery] = useState('')
  const [recallScope, setRecallScope] = useState<string>(scope)
  const [result, setResult] = useState<RecallResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { setRecallScope(scope) }, [scope])

  const run = (): void => {
    if (query.trim() === '' || busy) return
    setBusy(true)
    api<RecallResult>(`search-test?q=${encodeURIComponent(query.trim())}&scope=${recallScope}`, undefined, true)
      .then((data) => { setResult(data); setError(null) })
      .catch((recallError: Error) => setError(recallError.message))
      .finally(() => setBusy(false))
  }

  const hits = result?.hits ?? []
  return (
    <div>
      <div className={styles.sectionHead}>
        <h4 className={styles.sectionTitle}>{t('benchTitle')}</h4>
        <span className={styles.sectionHint}>{t('benchNote')}</span>
      </div>
      <div className={styles.benchBar}>
        <input className={`${styles.input} ${styles.search}`} placeholder={t('benchPlaceholder')} value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') run() }} />
        <SelectField selectClassName={styles.input} value={recallScope}
          onChange={event => setRecallScope(event.target.value)}>
          <option value="all">{t('benchScopeAll')}</option>
          <option value="user">{t('scopeUser')}</option>
          <option value="project">{t('scopeProject')}</option>
          <option value="shared">{t('scopeShared')}</option>
        </SelectField>
        <button type="button" className={`${styles.button} ${styles.primary}`}
          disabled={busy || query.trim() === ''} onClick={run}>{t('benchRun')}</button>
      </div>
      {error !== null && <div className={styles.expandLoading}>{t('loadFailed', { msg: error })}</div>}
      {result !== null && error === null && (
        <div className={styles.benchMeta}>
          <span>{t('benchHits', { n: hits.length })}</span>
          {result.degraded && <span className={styles.degradedNote}>{t('benchDegraded')}</span>}
        </div>
      )}
      {result !== null && hits.length === 0 && error === null && (
        <EmptyState title={t('benchEmpty')} hint={t('emptyHint')} />
      )}
      <div className={styles.benchList}>
        {hits.map(hit => (
          <div key={hit.id} className={styles.benchRow}>
            <div className={styles.benchHead}>
              <span className={styles.viaChip}>{t(VIA_KEY[hit.via])}</span>
              {hit.viaEdge !== undefined && (
                <span className={styles.viaChip}
                  title={`${hit.viaEdge.type} ${hit.viaEdge.from}`}>{t('viaEdgeLabel')} · {hit.viaEdge.type}</span>
              )}
              <span className={roomPillClass(hit.kind)}>{kindLabel(t, hit.kind)}</span>
              <span className={styles.benchScore}>{hit.score.toFixed(4)}</span>
            </div>
            <div className={styles.benchContent}>{hit.content}</div>
            <IdentityBadge memoryId={hit.memoryId} revisionId={hit.revisionId}
              memoryLabel="M" revisionLabel="R" />
            {onSelect !== undefined && (
              <button type="button" className={styles.button}
                onClick={() => { onSelect(hit.revisionId) }}>{t('benchInspect')}</button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
