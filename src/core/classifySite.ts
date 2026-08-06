/**
 * 站点分类引擎（SW 纯函数，可单测）。
 *
 * 架构原则（GPT 评审 P0-1 / P0-4）：
 * - MAIN 世界注入函数只负责同源 fetch + 脱敏指纹收集，不回传任何 JSON 原文/凭证。
 * - 本模块接收脱敏指纹，执行分类判定与采集策略构建。
 * - 分类不是互斥的——一个 Fork 过的 New-API 站点同时具有 new-api-capable 家族 + fork-path 路径特征。
 */

// ---- 类型定义 ----

export type Family = 'one-api-compatible' | 'new-api-capable' | 'independent' | 'unknown'
export type RouteProfile = 'standard' | 'fork-path' | 'discovered'
export type Capability = 'balance' | 'usageLogs' | 'hourlyUsage' | 'requestCount' | 'tokenSource' | 'usageList'
export type Confidence = 'high' | 'medium' | 'low'
export type UsageSource = 'hourly_aggregate' | 'raw_logs' | 'unavailable'
/** 当日用量明细列表适配器种类（P0：适配器隔离，禁把 hubway 约定泛化到所有站点） */
export type UsageListKind = 'hubway_v1' | 'generic'

export interface SiteClassification {
  family: Family
  routeProfile: RouteProfile
  capabilities: Capability[]
  confidence: Confidence
  userSelfPath: string | null
  /** 当日用量明细适配器种类；仅当 capabilities 含 'usageList' 时非 null */
  usageListKind?: UsageListKind | null
  usageListPath?: string | null
}

export interface EndpointActivation {
  role: 'balance' | 'usage' | 'usage_list'
  /** 可选端点 ID（如 'userSelf'、'logSelf'、'dataSelf'、'usageV1'） */
  endpointId: string
  /** 实际请求路径（相对于 origin） */
  path: string
  /** 仅 usage 角色 */
  source?: UsageSource
  /** 是否需 localStorage Token 注入 */
  needsToken?: boolean
  /** 仅 usage_list 角色：适配器种类，决定请求参数构造方式 */
  usageListKind?: UsageListKind
}

export interface CollectStrategy {
  endpoints: EndpointActivation[]
  family: Family
  confidence: Confidence
  currency?: string
  collectorVersion: number
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

const COLLECTOR_VERSION = 1

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
    } else if (types['balance'] !== undefined && best.hasUserId) {
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

  // Step 4: 置信度
  let confidence: Confidence = 'low'
  const validWithUser = valid.filter((s) => s.hasUserId && s.hasDataObject)
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

  return { family, routeProfile, capabilities, confidence, userSelfPath, usageListKind }
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
): CollectStrategy {
  const endpoints: EndpointActivation[] = []

  // 余额端点
  endpoints.push({
    role: 'balance',
    endpointId: 'userSelf',
    path: userSelfPath,
    needsToken: classification.capabilities.includes('tokenSource'),
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

  return {
    endpoints,
    family: classification.family,
    confidence: classification.confidence,
    currency,
    collectorVersion: COLLECTOR_VERSION,
  }
}
