/**
 * 共享账户契约归一化（方案 029 §5.5）。
 *
 * 纯函数、可单测、不依赖 DOM / chrome.* / 任何凭证。
 * 页面主世界（probe.ts）只回传 AccountMetricCandidate（数值原值），
 * 后台 pageCollect / swCollect 在落库前统一调用 normalizeAccount()，
 * 避免「页面」与「SW」两套余额公式漂移（DoCode 余额口径统一为 quota）。
 *
 * 绝不在此处读取/传递 Cookie、Token、账号标识或响应正文。
 */

import type { AccountMetricCandidate, AccountSemantics } from '../shared/types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

export interface NormalizedAccount {
  /** 当前余额。DoCode 语义 = quota；通用额度 = quota - usedQuota；其余优先直接余额。 */
  balance: number | null
  /** 历史累计消耗（DoCode = used_quota；通用 = usedQuota）。 */
  totalConsumedCost: number | null
  /** 累计请求数。 */
  totalRequests: number | null
  /** 明确总额度（仅站点显式给出时；否则 null，绝不臆测）。 */
  totalQuota: number | null
  /** 币种（响应优先，否则站点兜底）。 */
  currency: string | null
}

/**
 * 账户归一化：按语义契约统一字段口径。
 * 关键约束（方案 029 §3.2 / §5.5 / §D）：
 * - current_balance_and_historical_consumed：余额恒为 quota（绝不 quota - usedQuota）。
 * - quota_limit_and_used：余额 = quota - usedQuota（通用额度口径）。
 * - unknown / direct_balance：不臆测 quota - usedQuota；优先直接余额，否则 quota。
 */
export function normalizeAccount(
  candidate: AccountMetricCandidate,
  semantics: AccountSemantics | null | undefined,
  fallbackCurrency: string,
): NormalizedAccount {
  const currency = candidate.currency ?? fallbackCurrency

  if (semantics === 'current_balance_and_historical_consumed') {
    return {
      balance: candidate.quota,
      totalConsumedCost: candidate.usedQuota,
      totalRequests: candidate.requestCount,
      // 充值/赠送会破坏 quota + used 的「总额度」假设；无明确字段不推导。
      totalQuota: candidate.explicitTotalQuota,
      currency,
    }
  }

  if (semantics === 'quota_limit_and_used') {
    const balance =
      candidate.quota != null && candidate.usedQuota != null
        ? Math.max(0, candidate.quota - candidate.usedQuota)
        : (candidate.directBalance ?? candidate.quota)
    return {
      balance,
      totalConsumedCost: candidate.usedQuota,
      totalRequests: candidate.requestCount,
      totalQuota: candidate.quota,
      currency,
    }
  }

  // unknown / direct_balance：不臆测 quota - usedQuota，避免把历史消耗当成余额扣除。
  const balance = candidate.directBalance ?? candidate.quota
  return {
    balance,
    totalConsumedCost: candidate.usedQuota,
    totalRequests: candidate.requestCount,
    totalQuota: candidate.explicitTotalQuota,
    currency,
  }
}

/**
 * 明确未授权判定（方案 029 §5.6 / §3.2）：仅 HTTP 401/403 或站点明确认证业务码。
 * 普通 success:false / 404 / 非 JSON / 注入失败一律不算未授权。
 * 注：页面主世界注入函数需自包含副本（不能 import 本模块），此处供后台 SW / handlers 复用。
 */
export function isExplicitUnauthorized(raw: unknown): boolean {
  if (!isRecord(raw)) return false
  const error = isRecord(raw.error) ? raw.error : null
  return (
    raw.code === 'AUTH_UNAUTHORIZED' ||
    raw.code === 'UNAUTHORIZED' ||
    error?.code === 'AUTH_UNAUTHORIZED' ||
    error?.code === 'UNAUTHORIZED'
  )
}

/**
 * 从脱敏指纹识别账户语义（方案 029 §2.1）：命中 data.user.{quota,used_quota,request_count}
 * 且业务成功时，判定为 current_balance_and_historical_consumed（如 DoCode）。
 * 仅依据结构化指纹，不依赖域名硬编码。
 */
export function detectAccountSemantics(signal: {
  hasAccountSnapshot?: boolean
  successValue?: boolean | null
}): AccountSemantics {
  if (signal.hasAccountSnapshot && signal.successValue === true) {
    return 'current_balance_and_historical_consumed'
  }
  return 'unknown'
}
