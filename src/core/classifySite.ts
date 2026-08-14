/**
 * 站点分类引擎（SW 纯函数，可单测）。
 *
 * 架构原则（GPT 评审 P0-1 / P0-4）：
 * - MAIN 世界注入函数只负责同源 fetch + 脱敏指纹收集，不回传任何 JSON 原文/凭证。
 * - 本模块接收脱敏指纹，执行分类判定与采集策略构建。
 * - 分类不是互斥的——一个 Fork 过的 New-API 站点同时具有 new-api-capable 家族 + fork-path 路径特征。
 */

// ---- 类型定义 ----

import type { AccountSemantics, SiteConfig } from '../shared/types'

export type Family = 'one-api-compatible' | 'new-api-capable' | 'independent' | 'unknown'
export type RouteProfile = 'standard' | 'fork-path' | 'discovered'
export type Capability =
  | 'balance'
  | 'usageLogs'
  | 'hourlyUsage'
  | 'requestCount'
  | 'tokenSource'
  | 'usageList'
  | 'usageDashboardStats'
export type Confidence = 'high' | 'medium' | 'low'
export type UsageSource = 'hourly_aggregate' | 'raw_logs' | 'unavailable'
/** 统计接口适配器种类（Hubway 类 /api/v1/usage/dashboard/stats）。 */
export type UsageStatsKind = 'hubway_dashboard_stats'
/** 当日用量明细列表适配器种类（P0：适配器隔离，禁把 hubway 约定泛化到所有站点） */
export type UsageListKind = 'hubway_v1' | 'generic'
/** 指标 Provider 标识（按响应结构指纹/路径绑定，而非按域名绑定）。 */
export type ProviderId =
  | 'hubway_dashboard_stats'
  | 'ikuncode_account_snapshot'
  | 'ikuncode_range_usage'
  | 'ikuncode_billing_config'

export interface SiteClassification {
  family: Family
  routeProfile: RouteProfile
  capabilities: Capability[]
  confidence: Confidence
  userSelfPath: string | null
  /** 当日用量明细适配器种类；仅当 capabilities 含 'usageList' 时非 null */
  usageListKind?: UsageListKind | null
  usageListPath?: string | null
  /** 统计接口（usage/dashboard/stats）已发现 pathname（不含 query）。 */
  usageStatsPath?: string | null
  usageStatsKind?: UsageStatsKind | null
  /** IKunCode 类组合 provider 已发现 pathname（不含 query）。 */
  accountSnapshotPath?: string | null
  rangeUsagePath?: string | null
  billingConfigPath?: string | null
}

export interface EndpointActivation {
  role: 'balance' | 'usage' | 'usage_list' | 'usage_stats' | 'account_snapshot' | 'range_usage' | 'billing_config'
  /** 可选端点 ID（如 'userSelf'、'logSelf'、'dataSelf'、'usageV1'、'usageDashboardStats'） */
  endpointId: string
  /** 实际请求路径（相对于 origin） */
  path: string
  /** 仅 usage 角色 */
  source?: UsageSource
  /** 是否需 localStorage Token 注入 */
  needsToken?: boolean
  /** 仅 usage_list 角色：适配器种类，决定请求参数构造方式 */
  usageListKind?: UsageListKind
  /** 请求方法（默认 GET）。POST 用于有副作用的会话刷新（如 IKunCode refresh）。 */
  method?: 'GET' | 'POST'
  /** 查询参数模板（通过 URL API 写入，不拼接未编码字符串） */
  queryTemplate?: Record<string, string | number>
  /** JSON 请求体模板（仅 POST 等允许 body 的方法） */
  bodyTemplate?: Record<string, unknown> | null
  /** 指标时间窗口：point/calendar_day/rolling_24h/range/lifetime */
  usageWindow?: 'point' | 'calendar_day' | 'rolling_24h' | 'range' | 'lifetime'
  /** 是否会改变会话状态：session_refresh 不能作为普通自动轮询端点 */
  sideEffect?: 'none' | 'session_refresh'
  /** 是否允许定时采集（false=不能进入普通定时任务，仅受控手动流程触发） */
  safeToAutoPoll?: boolean
  /** 同源端点调用冷却（ms），用于有副作用/高成本端点 */
  cooldownMs?: number
  /** 统计接口适配器种类 */
  usageStatsKind?: UsageStatsKind
  /** 关联 Provider 标识 */
  providerId?: ProviderId
  /** 只有权威账户端点可裁决登录失效；普通候选/用量接口没有该权限。 */
  authRole?: 'authority' | 'candidate' | 'none'
}

export interface CollectStrategy {
  endpoints: EndpointActivation[]
  family: Family
  confidence: Confidence
  currency?: string
  collectorVersion: number
  /** 账户快照语义契约（方案 027 §3.1）；由 discovered 透传，驱动 collectInPage 的字段口径。 */
  accountSemantics?: AccountSemantics
}

/**
 * 脱敏指纹：MAIN 世界探针产出，不含任何 JSON 原文、Token、Cookie。
 * 仅包含路径别名、HTTP 状态、内容类型、字段存在性与类型信息。
 */
export interface EndpointSignal {
  /** 候选路径的逻辑标识（如 'userSelf'、'userSelfV1'），非真实 URL */
  pathKey: string
  status: number
  contentType: string
  isJson: boolean
  /** data 是否为数组（日志端点特征） */
  hasDataArray: boolean
  /** 是否有 created_at + token_used / prompt_tokens 字段（小时聚合 / 日志特征） */
  hasHourlyStructure: boolean
  /** 顶层是否有 {success, data} wrapper */
  hasSuccessWrapper: boolean
  /** success 字段的布尔值（true / false / null 表示不存在） */
  successValue: boolean | null
  /** data 是否为对象 */
  hasDataObject: boolean
  /** data 对象各字段的 typeof 结果，如 {quota:'number', request_count:'number', balance:'string'} */
  dataFieldTypes: Record<string, string>
  /** data 对象的所有 key 名称 */
  dataFieldNames: string[]
  /** 是否有用户标识字段（id/user_id/username/email 任一） */
  hasUserId: boolean
  /** 是否命中 data.user.{quota,used_quota,request_count} 账户结构 */
  hasAccountSnapshot?: boolean
}

export interface SiteFingerprint {
  /** 所有候选端点的探测信号 */
  signals: EndpointSignal[]
  /** 最佳命中端点的 pathKey（无有效命中则为 null） */
  bestPathKey: string | null
  /** 是否检测到 localStorage 中有 JWT token */
  hasLocalStorageToken: boolean
}

// ---- 分类逻辑 ----

const COLLECTOR_VERSION = 6

/**
 * 从脱敏指纹判定站点分类。
 * 规则由精确到模糊：先判定 family，再判定 routeProfile，最后汇总 capabilities。
 */
export function classifySite(fp: SiteFingerprint): SiteClassification {
  // 过滤出有效信号：HTTP 2xx + JSON + 业务未拒绝
  const valid = fp.signals.filter(
    (s) =>
      s.status >= 200 &&
      s.status < 300 &&
      s.isJson &&
      s.successValue !== false, // success:false 通常表示未登录/业务拒绝
  )

  // 找到最佳匹配：有用户标识 + 有数据对象的优先
  const best =
    valid.find((s) => s.hasUserId && s.hasDataObject) ??
    valid.find((s) => s.hasDataObject) ??
    valid[0]

  // Step 1: 家族判定
  let family: Family = 'unknown'
  if (best && best.hasSuccessWrapper && best.hasDataObject) {
    const types = best.dataFieldTypes
    if (types['quota'] === 'number') {
      // One-API 家族：有 {success,data} + quota 为数值
      family = types['request_count'] === 'number' ? 'new-api-capable' : 'one-api-compatible'
    } else if ((types['balance'] !== undefined && best.hasUserId) || best.hasAccountSnapshot) {
      // 可能是独立站点（有 wrapper 但无 quota，有 balance）
      family = 'independent'
    }
  } else if (best && best.hasDataObject && best.hasUserId) {
    // 无标准 wrapper 但能找到用户数据
    family = 'independent'
  }

  // Step 2: 路径特征
  let routeProfile: RouteProfile = 'standard'
  if (best && fp.bestPathKey) {
    // 如果最佳命中的 pathKey 不是 'userSelf'（标准路径），则为 fork
    if (fp.bestPathKey !== 'userSelf' && fp.bestPathKey !== 'userSelfV1') {
      routeProfile = 'fork-path'
    }
  }
  // 'discovered' 由网络发现设置，此处不覆盖

  // Step 3: 能力集
  const capabilities: Capability[] = []
  if (family !== 'unknown' && best?.hasUserId) capabilities.push('balance')
  if (best && best.dataFieldTypes['request_count'] === 'number') capabilities.push('requestCount')

  // 检查是否有用量端点（GPT P0-1：自动主动探测 + 路径指纹，确定性判定）
  // 优先按已识别的用量端点 pathKey，再辅以结构启发兜底。
  let usageListKind: UsageListKind | null = null
  for (const s of valid) {
    if (s.pathKey === 'dataSelf' && s.hasDataObject) capabilities.push('hourlyUsage')
    else if (s.pathKey === 'logSelf' && s.hasDataObject) capabilities.push('usageLogs')
    // 当日用量明细列表端点（hubway_v1 = /api/v1/usage；generic = /api/usage）
    else if ((s.pathKey === 'usageV1' || s.pathKey === 'usageList') && (s.hasDataObject || s.hasDataArray)) {
      if (!capabilities.includes('usageList')) {
        capabilities.push('usageList')
        // 适配器隔离：仅当路径/结构满足 hubway 指纹时才定为 hubway_v1，否则 generic
        usageListKind = s.pathKey === 'usageV1' ? 'hubway_v1' : 'generic'
      }
    }
  }
  // 兜底启发：未命中已知路径但结构疑似（data 为对象）
  if (!capabilities.includes('hourlyUsage') && valid.some((s) => s.hasHourlyStructure && !s.hasDataArray && s.hasDataObject)) {
    capabilities.push('hourlyUsage')
  }
  if (!capabilities.includes('usageLogs') && valid.some((s) => s.hasDataArray && s.hasDataObject && s.pathKey !== 'usageV1' && s.pathKey !== 'usageList')) {
    capabilities.push('usageLogs')
  }
  // localStorage Token 扫描
  if (fp.hasLocalStorageToken) {
    capabilities.push('tokenSource')
  }

  // 统计接口（Hubway 类 usage/dashboard/stats）识别：路径别名 + 结构指纹（方案 §3.1/§6.4）
  // 仅靠 pathname + 字段结构识别，不按域名硬编码。
  const statsSignal = fp.signals.find((s) => s.pathKey === 'usageDashboardStats')
  let usageStatsPath: string | null = null
  let usageStatsKind: UsageStatsKind | null = null
  if (statsSignal) {
    const names = statsSignal.dataFieldNames || []
    const hitStatsField = ['today_actual_cost', 'total_tokens', 'total_input_tokens', 'total_output_tokens', 'average_duration_ms'].some(
      (n) => names.includes(n),
    )
    if (hitStatsField) {
      if (!capabilities.includes('usageDashboardStats')) capabilities.push('usageDashboardStats')
      // 标准候选路径（探针使用的即该规范路径）；真实 fork 变体的 pathname 由 DISCOVER_ENDPOINTS 从 attempt 实际 URL 持久化
      usageStatsPath = '/api/v1/usage/dashboard/stats'
      usageStatsKind = 'hubway_dashboard_stats'
    }
  }

  // Step 4: 置信度
  let confidence: Confidence = 'low'
  const validWithUser = valid.filter((s) => (s.hasUserId || s.hasAccountSnapshot) && s.hasDataObject)
  if (validWithUser.length >= 2 && family !== 'unknown') {
    confidence = 'high'
  } else if (validWithUser.length >= 1 && family !== 'unknown') {
    confidence = 'medium'
  }

  // 用户端点路径
  const userSelfPath = best
    ? (best.pathKey === 'userSelf'
        ? '/api/user/self'
        : best.pathKey === 'userSelfV1'
          ? '/api/v1/user/self'
          : best.pathKey === 'authMe'
            ? '/api/v1/auth/me'
            : null) // 非标准路径由 discovered.userSelfPath 单独记录
    : null

  return {
    family,
    routeProfile,
    capabilities,
    confidence,
    userSelfPath,
    usageListKind,
    usageStatsPath,
    usageStatsKind,
    // IKunCode 类组合 provider 的 pathname 依赖 userSelfPath / /api/data/self 等，由 DISCOVER_ENDPOINTS 从 attempt 实际 URL 持久化，此处不臆测
    accountSnapshotPath: null,
    rangeUsagePath: null,
    billingConfigPath: null,
  }
}

/**
 * 从分类结果构建采集策略。
 * 余额始终走 userSelfPath；用量按 capabilities 降级链：
 * hourlyUsage → usageLogs → unavailable。
 * usageList（当日用量明细列表）单独作为 role:'usage_list' 端点，携带适配器种类。
 */
export function buildStrategy(
  classification: SiteClassification,
  userSelfPath: string,
  currency?: string,
  discoveredPaths?: {
    usageStatsPath?: string | null
    usageStatsKind?: UsageStatsKind | null
    accountSnapshotPath?: string | null
    rangeUsagePath?: string | null
    billingConfigPath?: string | null
  },
): CollectStrategy {
  const endpoints: EndpointActivation[] = []

  // 余额端点
  endpoints.push({
    role: 'balance',
    endpointId: 'userSelf',
    path: userSelfPath,
    needsToken: classification.capabilities.includes('tokenSource'),
    authRole: 'authority',
  })

  // 用量端点：按 capabilities 优先级降级；同能力给出「标准 + fork 变体」候选，
  // collectInPage 会按顺序尝试，首个成功即采用（容忍 hubway 等 fork 改路径）。
  if (classification.capabilities.includes('hourlyUsage')) {
    endpoints.push({ role: 'usage', endpointId: 'dataSelf', path: '/api/data/self', source: 'hourly_aggregate' })
    endpoints.push({ role: 'usage', endpointId: 'dataSelfV1', path: '/api/v1/data/self', source: 'hourly_aggregate' })
  }
  if (classification.capabilities.includes('usageLogs')) {
    endpoints.push({ role: 'usage', endpointId: 'logSelf', path: '/api/log/self', source: 'raw_logs' })
    endpoints.push({ role: 'usage', endpointId: 'logSelfV1', path: '/api/v1/log/self', source: 'raw_logs' })
  }

  // 当日用量明细列表（hubway_v1 = /api/v1/usage，generic = /api/usage）
  const usageListCandidates: Array<{ path: string; kind: UsageListKind }> = []
  const addUsageListCandidate = (path: string, kind: UsageListKind) => {
    const normalized = path.startsWith('/') ? path : `/${path}`
    if (!usageListCandidates.some((c) => c.path === normalized)) usageListCandidates.push({ path: normalized, kind })
  }
  const discoveredKind = classification.usageListKind ?? null
  const discoveredPath = classification.usageListPath?.trim() || ''
  if (discoveredPath) {
    addUsageListCandidate(
      discoveredPath,
      discoveredKind ?? (discoveredPath === '/api/v1/usage' ? 'hubway_v1' : 'generic'),
    )
  }
  if (discoveredKind === 'generic') {
    addUsageListCandidate('/api/usage', 'generic')
    addUsageListCandidate('/api/v1/usage', 'hubway_v1')
  } else {
    addUsageListCandidate('/api/v1/usage', 'hubway_v1')
    addUsageListCandidate('/api/usage', 'generic')
  }
  for (const candidate of usageListCandidates) {
    endpoints.push({
      role: 'usage_list',
      endpointId: candidate.kind === 'hubway_v1' ? 'usageV1' : 'usageList',
      path: candidate.path,
      usageListKind: candidate.kind,
    })
  }

  // 统计接口（Hubway 类 usage/dashboard/stats）：权威累计 Token / 今日使用金额 / 平均响应。
  // 独立角色，不阻塞余额/明细采集；明细接口失败也不覆盖统计指标。
  if (discoveredPaths?.usageStatsPath || classification.capabilities.includes('usageDashboardStats')) {
    endpoints.push({
      role: 'usage_stats',
      endpointId: 'usageDashboardStats',
      path: discoveredPaths?.usageStatsPath ?? '/api/v1/usage/dashboard/stats',
      method: 'GET',
      queryTemplate: { timezone: 'Asia/Shanghai' },
      usageStatsKind: discoveredPaths?.usageStatsKind ?? 'hubway_dashboard_stats',
      providerId: 'hubway_dashboard_stats',
      sideEffect: 'none',
      safeToAutoPoll: true,
    })
  }

  // IKunCode 类组合 provider（方案 §3.4）：账户快照 / 区间用量 / 计价配置，按职责独立激活。
  // 账户快照与余额同源（/api/user/self 的 data.user.*），但明确声明新角色以区分口径。
  if (userSelfPath && (discoveredPaths?.accountSnapshotPath || classification.family === 'independent' || classification.capabilities.includes('hourlyUsage'))) {
    const accountPath = discoveredPaths?.accountSnapshotPath ?? userSelfPath
    const accountIsRefresh = accountPath === '/api/user/auth/refresh'
    endpoints.push({
      role: 'account_snapshot',
      endpointId: 'accountSnapshot',
      path: accountPath,
      method: accountIsRefresh ? 'POST' : 'GET',
      usageWindow: 'point',
      sideEffect: accountIsRefresh ? 'session_refresh' : 'none',
      safeToAutoPoll: !accountIsRefresh,
      providerId: 'ikuncode_account_snapshot',
      authRole: accountIsRefresh ? 'candidate' : 'authority',
    })
  }
  if (discoveredPaths?.rangeUsagePath || classification.capabilities.includes('hourlyUsage')) {
    endpoints.push({
      role: 'range_usage',
      endpointId: 'rangeUsage',
      path: discoveredPaths?.rangeUsagePath ?? '/api/data/self',
      method: 'GET',
      usageWindow: 'calendar_day',
      sideEffect: 'none',
      safeToAutoPoll: true,
      providerId: 'ikuncode_range_usage',
    })
  }
  if (discoveredPaths?.billingConfigPath || classification.family === 'independent' || classification.capabilities.includes('hourlyUsage')) {
    endpoints.push({
      role: 'billing_config',
      endpointId: 'billingConfig',
      path: discoveredPaths?.billingConfigPath ?? '/api/status',
      method: 'GET',
      usageWindow: 'point',
      sideEffect: 'none',
      safeToAutoPoll: true,
      providerId: 'ikuncode_billing_config',
    })
  }

  return {
    endpoints,
    family: classification.family,
    confidence: classification.confidence,
    currency,
    collectorVersion: COLLECTOR_VERSION,
    accountSemantics: undefined,
  }
}

/**
 * 从 SiteConfig 派生「实际生效策略」（方案 028 §5.2）。
 * pageCollect（采集）与 collectionProfile（展示）共用同一函数，避免策略默认值两处漂移。
 * 旧 discovered 缺字段时给出保守默认，确保首采也能尝试统计/账户 provider。
 */
export function buildEffectiveStrategy(site: SiteConfig, _manualCollect: boolean): CollectStrategy {
  const discovered = site.discovered
  const userSelfPath = discovered?.userSelfPath ?? '/api/user/self'
  const capabilities: Capability[] = [...((discovered?.capabilities as Capability[] | undefined) ?? [])]
  if (!capabilities.includes('usageDashboardStats')) capabilities.push('usageDashboardStats')
  // IKunCode 类（独立家族 / hourlyUsage 能力 / 未分类）默认启用账户快照/区间用量/计价配置候选。
  const ikuncodeLike =
    !discovered ||
    discovered.family === 'independent' ||
    discovered.family === 'unknown' ||
    capabilities.includes('hourlyUsage')
  // One API / New API 兼容站点都可能通过 /api/status 公开 quota_per_unit。
  // 不能只依赖 new-api-capable：DoCode 的脱敏指纹在部分版本会被归为 one-api-compatible，
  // 但 data.user.quota 仍是需要按 quota_per_unit 换算的账户余额。
  const quotaUnitAccountLike =
    discovered?.family === 'one-api-compatible' ||
    discovered?.family === 'new-api-capable' ||
    discovered?.accountSemantics === 'current_balance_and_historical_consumed'
  const classification: SiteClassification = {
    family: (discovered?.family as Family) || 'unknown',
    routeProfile: (discovered?.routeProfile as RouteProfile) || 'standard',
    capabilities,
    confidence: (discovered?.confidence as Confidence) || 'low',
    userSelfPath,
    usageListKind: discovered?.usageListKind ?? null,
    usageListPath: discovered?.usageListPath ?? null,
    usageStatsPath: discovered?.usageStatsPath ?? null,
    usageStatsKind: discovered?.usageStatsKind ?? null,
    accountSnapshotPath: discovered?.accountSnapshotPath ?? null,
    rangeUsagePath: discovered?.rangeUsagePath ?? null,
    billingConfigPath: discovered?.billingConfigPath ?? null,
  }
  const strategy = buildStrategy(
    classification,
    userSelfPath,
    site.currency ?? undefined,
    {
      usageStatsPath: discovered?.usageStatsPath ?? '/api/v1/usage/dashboard/stats',
      usageStatsKind: discovered?.usageStatsKind ?? 'hubway_dashboard_stats',
      accountSnapshotPath: discovered?.accountSnapshotPath ?? (ikuncodeLike ? userSelfPath : null),
      rangeUsagePath: discovered?.rangeUsagePath ?? (ikuncodeLike ? '/api/data/self' : null),
      billingConfigPath: discovered?.billingConfigPath ?? (ikuncodeLike || quotaUnitAccountLike ? '/api/status' : null),
    },
  )
  // 账户快照语义契约透传：驱动 collectInPage 在 DoCode 等契约下的字段口径（027 §3.3）。
  strategy.accountSemantics = (discovered?.accountSemantics as AccountSemantics | undefined) ?? undefined
  return strategy
}
