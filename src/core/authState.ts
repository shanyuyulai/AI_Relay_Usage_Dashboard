import type {
  AuthEvidence,
  AuthEvidenceReason,
  AuthState,
  CollectFailureReason,
  SiteConfig,
} from '../shared/types'

/** 当前轮次内的证据优先级：权威成功 > 权威明确未授权 > 不确定 > 候选拒绝。 */
const EVIDENCE_RANK: Record<AuthEvidenceReason, number> = {
  ACCOUNT_AUTHENTICATED: 400,
  ACCOUNT_UNAUTHORIZED: 300,
  AUTH_CONTEXT_INCOMPLETE: 220,
  NETWORK_OR_TIMEOUT: 210,
  NON_JSON_RESPONSE: 200,
  ACCOUNT_CONTRACT_MISMATCH: 190,
  ENDPOINT_UNAVAILABLE: 180,
  CANDIDATE_REJECTED: 100,
}

export function resolveAuthEvidence(evidence: AuthEvidence[]): AuthEvidence | null {
  if (!evidence.length) return null
  return [...evidence].sort((a, b) => {
    const rank = (EVIDENCE_RANK[b.reason] ?? 0) - (EVIDENCE_RANK[a.reason] ?? 0)
    if (rank !== 0) return rank
    return (b.observedAt ?? 0) - (a.observedAt ?? 0)
  })[0] ?? null
}

export function authReasonToFailure(reason: AuthEvidenceReason): CollectFailureReason {
  switch (reason) {
    case 'ACCOUNT_UNAUTHORIZED': return 'ACCOUNT_UNAUTHORIZED'
    case 'AUTH_CONTEXT_INCOMPLETE': return 'AUTH_CONTEXT_INCOMPLETE'
    case 'CANDIDATE_REJECTED': return 'CANDIDATE_REJECTED'
    case 'NETWORK_OR_TIMEOUT': return 'NETWORK_OR_TIMEOUT'
    case 'NON_JSON_RESPONSE': return 'NON_JSON_RESPONSE'
    case 'ACCOUNT_CONTRACT_MISMATCH': return 'ACCOUNT_CONTRACT_MISMATCH'
    default: return 'ENDPOINT_UNAVAILABLE'
  }
}

/** UI 只有在具备权威账户端点明确证据时才显示“需重新授权”。 */
export function shouldShowReauthorize(site: Pick<SiteConfig, 'lastStatus' | 'lastFailureReason' | 'lastAuthEvidence'>): boolean {
  const evidence = site.lastAuthEvidence
  return site.lastStatus === 'auth_expired' &&
    site.lastFailureReason === 'ACCOUNT_UNAUTHORIZED' &&
    evidence?.state === 'unauthorized' &&
    evidence.reason === 'ACCOUNT_UNAUTHORIZED' &&
    evidence.endpointRole === 'account_authority' &&
    evidence.contextComplete === true &&
    (evidence.httpStatus === 401 || evidence.httpStatus === 403)
}

export function authStateFromEvidence(evidence: AuthEvidence | null): AuthState {
  return evidence?.state ?? 'indeterminate'
}
