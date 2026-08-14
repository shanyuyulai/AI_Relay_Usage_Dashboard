/**
 * 站点类型与采集方案可视化（方案 028）。
 *
 * 只读展示模型：从 SiteConfig.discovered + buildEffectiveStrategy() 派生，
 * 绝不持久化第二份策略副本（buildEffectiveStrategy 是唯一策略来源）。
 * 不读取 Cookie / localStorage / 捕获响应原文，不回传任何凭证。
 */

import { buildEffectiveStrategy, type CollectStrategy, type EndpointActivation } from './classifySite'
import { registry } from '../adapters'
import { shouldShowReauthorize } from './authState'
import type {
  SiteConfig,
  SiteCollectionProfile,
  CollectionPlanStep,
  SafeFailureSummary,
  CollectFailureReason,
  AccountSemantics,
  SiteStatus,
  DiagnosticEntry,
} from '../shared/types'

/** 各角色的中文指标标签。 */
const ROLE_LABELS: Record<CollectionPlanStep['role'], string> = {
  balance: '余额',
  usage: '今日/区间用量',
  usage_list: '当日用量明细',
  usage_stats: '统计指标',
  account_snapshot: '账户快照',
  range_usage: '区间用量',
  billing_config: '计价配置',
}

/** 各角色预期产出指标的中文标签。 */
const ROLE_EXPECTED: Record<CollectionPlanStep['role'], string[]> = {
  balance: ['余额', '累计请求'],
  usage: ['今日用量', '今日请求'],
  usage_list: ['当日用量明细', '模型分布'],
  usage_stats: ['今日消费', '累计 Token', '平均响应'],
  account_snapshot: ['当前余额', '历史消耗', '累计请求'],
  range_usage: ['区间用量', '区间 Token'],
  billing_config: ['计价单位', '汇率'],
}

/** 采集失败时的建议动作（固定中文文案，不依赖原始错误）。 */
const FAILURE_ACTION: Record<CollectFailureReason, string> = {
  HOST_PERMISSION_MISSING: '请在设置页授予该站点 host 权限',
  NO_MATCHING_OPEN_TAB: '请打开并登录该站点的控制台页面',
  PANEL_ORIGIN_SESSION_MISMATCH: '面板地址与已登录控制台域不一致，请填写控制台地址',
  ACCOUNT_UNAUTHORIZED: '请在控制台重新登录后再同步',
  AUTH_CONTEXT_INCOMPLETE: '请保持控制台登录后重新检测',
  CANDIDATE_REJECTED: '重新探测接口以确认账户端点',
  NETWORK_OR_TIMEOUT: '检查网络后重新同步',
  NON_JSON_RESPONSE: '查看诊断日志确认接口是否仍有效',
  ACCOUNT_CONTRACT_MISMATCH: '重新探测接口以更新站点类型',
  ENDPOINT_UNAVAILABLE: '查看诊断日志确认接口路径',
  SCRIPT_INJECTION_FAILED: '刷新扩展后重试',
  SW_SESSION_UNAVAILABLE: '实验室零标签无法复用会话，请保持控制台标签页并使用标准采集',
}

/** 仅保留 pathname（去掉 origin 与 query 值）。 */
function safePathname(url: string, origin: string): string {
  try {
    const u = new URL(url, origin)
    return u.pathname
  } catch {
    return url
  }
}

/**
 * 从站点最近一条诊断推导脱敏失败摘要（方案 028 §5.1）。
 * 仅含枚举错误码 / HTTP 状态 / pathname / 时间 / 建议动作；不写入任何私密值。
 */
export function deriveFailureSummary(
  site: SiteConfig,
  latestDiag: DiagnosticEntry | null,
): SafeFailureSummary | null {
  const status: SiteStatus = site.lastStatus
  // 方案 029 §6：优先采用结构化失败原因（如 SW_SESSION_UNAVAILABLE / PANEL_ORIGIN_SESSION_MISMATCH），
  // 否则按 status 兜底推导。结构化原因已自带建议动作映射。
  if (site.lastFailureReason) {
    const pathname = latestDiag ? safePathname(latestDiag.url, site.origin) : null
    return {
      reason: site.lastFailureReason,
      httpStatus: latestDiag ? latestDiag.status : null,
      pathname,
      at: latestDiag ? latestDiag.at : null,
      suggestedAction: FAILURE_ACTION[site.lastFailureReason],
    }
  }
  let reason: CollectFailureReason | null = null
  if (status === 'auth_expired' && shouldShowReauthorize(site)) reason = 'ACCOUNT_UNAUTHORIZED'
  else if (status === 'auth_expired') reason = 'ENDPOINT_UNAVAILABLE'
  else if (status === 'error') reason = 'ENDPOINT_UNAVAILABLE'

  if (reason === null && !latestDiag) return null
  if (reason === null && latestDiag && (latestDiag.status >= 400 || latestDiag.status === 0)) {
    reason = latestDiag.status === 0 ? 'NETWORK_OR_TIMEOUT' : 'ENDPOINT_UNAVAILABLE'
  }
  if (reason == null) return null

  const pathname = latestDiag ? safePathname(latestDiag.url, site.origin) : null
  return {
    reason,
    httpStatus: latestDiag ? latestDiag.status : null,
    pathname,
    at: latestDiag ? latestDiag.at : null,
    suggestedAction: FAILURE_ACTION[reason],
  }
}

/** 将单个策略端点映射为展示步骤，并按运行状况标注状态。 */
function endpointToStep(
  ep: EndpointActivation,
  site: SiteConfig,
  strategy: CollectStrategy,
): CollectionPlanStep {
  const role = ep.role
  const isSessionRefresh = ep.sideEffect === 'session_refresh' || ep.path === '/api/user/auth/refresh'
  const isAccountEndpoint = role === 'balance' || role === 'account_snapshot'
  const matchedPath = site.discovered?.userSelfPath

  let state: CollectionPlanStep['state'] = 'planned'
  if (site.lastStatus === 'ok' && site.lastCollectAt != null) {
    // 最近一次采集成功：匹配到的账户/余额主端点标记为已验证。
    if (isAccountEndpoint && (matchedPath == null || ep.path === matchedPath)) state = 'verified'
    else if (matchedPath && ep.path === matchedPath) state = 'verified'
    else state = 'planned'
  } else if (site.lastStatus === 'auth_expired' && shouldShowReauthorize(site) && isAccountEndpoint) {
    state = 'unauthorized'
  } else if (site.lastStatus === 'error' && isAccountEndpoint) {
    state = 'failed'
  }

  // 未探测站点（无 discovered）一律待探测，端点不标已验证。
  if (!site.discovered?.probedAt) state = 'planned'

  return {
    id: ep.endpointId || `${role}:${ep.path}`,
    role,
    label: ROLE_LABELS[role] ?? role,
    method: ep.method ?? 'GET',
    path: safePathname(ep.path.startsWith('/') ? site.origin + ep.path : ep.path, site.origin),
    automatic: ep.safeToAutoPoll !== false && !isSessionRefresh,
    sideEffect: isSessionRefresh ? 'session_refresh' : 'none',
    expectedMetrics: ROLE_EXPECTED[role] ?? [],
    state,
  }
}

/**
 * 构建单站「类型与采集方案」只读展示模型（方案 028 §5.1 / §6 阶段 A）。
 * @param site 站点配置（含 discovered）
 * @param engine 实际采集引擎：page_main_world（默认）或 sw_lab（零标签实验室开启时）
 * @param latestDiag 该站最近一条脱敏诊断（可选，用于健康摘要）
 */
export function buildSiteCollectionProfile(
  site: SiteConfig,
  engine: 'page_main_world' | 'sw_lab',
  latestDiag: DiagnosticEntry | null,
): SiteCollectionProfile {
  const strategy = buildEffectiveStrategy(site, false)
  const d = site.discovered
  const accountSemantics: AccountSemantics | null = (d?.accountSemantics as AccountSemantics | undefined) ?? null

  const steps: CollectionPlanStep[] = strategy.endpoints.map((ep) => endpointToStep(ep, site, strategy))

  // 自动采集状态：站点禁用 → unavailable；仅含 session_refresh 端点 → manual_only；否则 enabled。
  let automaticCollection: SiteCollectionProfile['execution']['automaticCollection'] = 'enabled'
  if (!site.enabled) automaticCollection = 'unavailable'
  else if (strategy.endpoints.length > 0 && strategy.endpoints.every((e) => e.sideEffect === 'session_refresh' || e.path === '/api/user/auth/refresh')) {
    automaticCollection = 'manual_only'
  }

  return {
    siteId: site.id,
    configuredAdapter: {
      id: site.adapter,
      label: registry.get(site.adapter)?.name ?? site.adapter,
    },
    classification: {
      family: (d?.family as SiteCollectionProfile['classification']['family']) || 'unknown',
      routeProfile: (d?.routeProfile as SiteCollectionProfile['classification']['routeProfile']) ?? null,
      confidence: (d?.confidence as SiteCollectionProfile['classification']['confidence']) ?? null,
      probedAt: d?.probedAt ?? null,
      accountSemantics,
      capabilities: d?.capabilities ?? [],
    },
    execution: {
      engine,
      collectorVersion: strategy.collectorVersion,
      requiresSameOriginSession: true,
      automaticCollection,
    },
    steps,
    health: {
      lastStatus: site.lastStatus,
      lastCollectAt: site.lastCollectAt,
      latestFailure: deriveFailureSummary(site, latestDiag),
    },
  }
}
