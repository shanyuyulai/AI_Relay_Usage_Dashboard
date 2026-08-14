import { db } from './db'
import type { AuthEvidence, AuthState, CollectFailureReason } from '../shared/types'

export type AuthOutcome = {
  state: AuthState
  evidence?: AuthEvidence
  failureReason?: CollectFailureReason
  error?: string
  runId?: string
  collectedAt?: number
}

/** 统一更新站点与凭证状态，避免授权测试和采集结果发生状态漂移。 */
export const authStateRepo = {
  async apply(siteId: string, outcome: AuthOutcome): Promise<void> {
    await db.transaction('rw', db.sites, db.credentials, async () => {
      const site = await db.sites.get(siteId)
      if (!site) return
      // 旧轮次不得覆盖新轮次的状态（手动刷新、定时采集可能重叠）。
      if (outcome.runId && site.lastCollectRunId && site.lastCollectRunId !== outcome.runId) return
      const current = await db.credentials.get(siteId)
      const evidence = outcome.evidence
      const common = {
        lastAuthEvidence: evidence,
        lastCollectRunId: outcome.runId ?? site.lastCollectRunId,
        lastCollectAt: outcome.collectedAt ?? site.lastCollectAt,
      }
      if (outcome.state === 'authenticated') {
        await db.sites.update(siteId, {
          ...common,
          lastStatus: 'ok',
          lastFailureReason: undefined,
          lastError: undefined,
        })
        await db.credentials.put({
          siteId,
          method: 'cookie',
          authorized: true,
          authState: 'authenticated',
          lastEvidenceAt: evidence?.observedAt ?? Date.now(),
          updatedAt: Date.now(),
        })
        return
      }
      if (outcome.state === 'unauthorized') {
        await db.sites.update(siteId, {
          ...common,
          lastStatus: 'auth_expired',
          lastFailureReason: outcome.failureReason ?? 'ACCOUNT_UNAUTHORIZED',
          lastError: outcome.error ?? '权威账户端点明确返回未授权',
        })
        await db.credentials.put({
          siteId,
          method: 'cookie',
          authorized: false,
          authState: 'unauthorized',
          lastEvidenceAt: evidence?.observedAt ?? Date.now(),
          updatedAt: Date.now(),
        })
        return
      }

      // indeterminate：记录不确定证据，但保留最近一次明确的 authorized/authState。
      await db.sites.update(siteId, {
        ...common,
        lastStatus: 'error',
        lastFailureReason: outcome.failureReason ?? 'ENDPOINT_UNAVAILABLE',
        lastError: outcome.error ?? '无法确认站点授权状态，请重新检测',
      })
      if (current) {
        await db.credentials.put({
          ...current,
          authState: current.authState ?? (current.authorized ? 'authenticated' : 'unknown'),
          updatedAt: Date.now(),
        })
      }
    })
  },
}
