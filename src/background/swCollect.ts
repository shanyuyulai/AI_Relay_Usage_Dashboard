/**
 * 实验室：Service Worker 零标签后台采集。
 *
 * 这是知情例外路径：仅在实验室开关开启、且站点没有已打开标签时使用。
 * Cookie 只在本次请求内存中使用，不写入 IndexedDB、不回传给页面。
 * 由于 SW fetch 受 CORS 与站点鉴权实现限制，本路径允许部分指标成功，但不伪造缺失值。
 */
import type { SiteConfig, Snapshot, AccountMetricCandidate } from '../shared/types'
import type { CollectResult } from './collector'
import { normalizeAccount } from '../core/accountContract'
import { siteRepo, snapshotRepo, dailyStatRepo, authStateRepo } from '../storage'

type DashboardStats = {
  todayCost: number | null
  cumulativeTokens: number | null
  cumulativeInputTokens: number | null
  cumulativeOutputTokens: number | null
  avgResponseTimeMs: number | null
}

type AccountSnapshot = {
  balanceQuota: number | null
  consumedQuota: number | null
  lifetimeRequests: number | null
  currency: string | null
}

type BalanceResult = {
  balance: number | null
  totalQuota: number | null
  currency: string
  totalConsumedCost: number | null
  totalRequests: number | null
}

type UsageResult = {
  todayTokens: number | null
  todayRequests: number | null
  todayCost: number | null
}

type FetchResult = {
  status: number
  json: any | null
  isJson: boolean
}

function isRecord(value: unknown): value is Record<string, any> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function toFiniteNonNegative(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null
  if (typeof value !== 'string' || value.trim() === '') return null
  const number = Number(value.replace(/,/g, '').trim())
  return Number.isFinite(number) && number >= 0 ? number : null
}

function isBusinessAuthFailure(value: unknown): boolean {
  if (!isRecord(value)) return false
  const error = isRecord(value.error) ? value.error : null
  return (
    value.success === false ||
    value.code === 'AUTH_UNAUTHORIZED' ||
    value.code === 'UNAUTHORIZED' ||
    error?.code === 'AUTH_UNAUTHORIZED' ||
    error?.code === 'UNAUTHORIZED'
  )
}

/** 解包常见响应包装，最多 5 层，避免对未知对象无限递归。 */
function unwrap(value: unknown): any | null {
  if (Array.isArray(value)) return value
  if (!isRecord(value) || isBusinessAuthFailure(value)) return null
  let current: any = value
  for (let depth = 0; depth < 5; depth++) {
    if (!isRecord(current) || isBusinessAuthFailure(current)) return null
    let advanced = false
    for (const key of ['data', 'payload', 'response', 'result']) {
      const nested = current[key]
      if (isRecord(nested) || Array.isArray(nested)) {
        current = nested
        advanced = true
        break
      }
    }
    if (!advanced) break
  }
  return current
}

function findMetricObject(value: unknown, keys: string[], depth = 0): Record<string, any> | null {
  if (depth > 5 || !isRecord(value)) return null
  if (keys.some((key) => Object.prototype.hasOwnProperty.call(value, key))) return value
  for (const key of ['data', 'stats', 'summary', 'result', 'usage', 'payload', 'response']) {
    const found = findMetricObject(value[key], keys, depth + 1)
    if (found) return found
  }
  return null
}

function findList(value: unknown, depth = 0): any[] | null {
  if (Array.isArray(value)) return value
  if (depth > 5 || !isRecord(value)) return null
  for (const key of ['items', 'list', 'records', 'rows', 'results', 'data', 'payload', 'response', 'result', 'usage']) {
    const nested = value[key]
    if (Array.isArray(nested)) return nested
    const found = findList(nested, depth + 1)
    if (found) return found
  }
  return null
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.filter((path) => typeof path === 'string' && path.startsWith('/')))]
}

function findAccount(value: unknown, depth = 0): Record<string, any> | null {
  if (depth > 5 || !isRecord(value)) return null
  if (isRecord(value.user)) return value.user
  for (const key of ['data', 'payload', 'response', 'result', 'stats', 'summary']) {
    const found = findAccount(value[key], depth + 1)
    if (found) return found
  }
  return null
}

function parseAccount(json: unknown, fallbackCurrency: string): AccountSnapshot | null {
  const root = unwrap(json)
  if (!root) return null
  const user = findAccount(root) ?? (isRecord(root) ? root : null)
  if (!user) return null
  const balanceQuota = toFiniteNonNegative(user.quota ?? user.balance ?? user.remain_quota)
  const consumedQuota = toFiniteNonNegative(user.used_quota ?? user.consumption ?? user.total_spent)
  const lifetimeRequests = toFiniteNonNegative(
    user.request_count ?? user.total_request_count ?? user.total_requests ?? user.requests,
  )
  const currency = typeof user.currency === 'string' && user.currency ? user.currency : fallbackCurrency
  if (balanceQuota == null && consumedQuota == null && lifetimeRequests == null) return null
  return { balanceQuota, consumedQuota, lifetimeRequests, currency }
}

function parseBalance(json: unknown, fallbackCurrency: string): BalanceResult {
  const root = unwrap(json)
  const account = parseAccount(json, fallbackCurrency)
  const data = findMetricObject(root, [
    'balance',
    'remain_quota',
    'remain',
    'remaining',
    'available',
    'quota',
    'used_quota',
  ]) ?? (isRecord(root) ? root : null)
  const directBalance = data
    ? toFiniteNonNegative(data.balance ?? data.remain_quota ?? data.remain ?? data.remaining ?? data.available)
    : null
  const quota = data ? toFiniteNonNegative(data.quota ?? account?.balanceQuota) : account?.balanceQuota ?? null
  const usedQuota = data ? toFiniteNonNegative(data.used_quota ?? account?.consumedQuota) : account?.consumedQuota ?? null
  const balance = directBalance ?? (quota != null && usedQuota != null ? Math.max(0, quota - usedQuota) : quota)
  const currency =
    (data && typeof data.currency === 'string' && data.currency ? data.currency : null) ??
    account?.currency ??
    fallbackCurrency
  return {
    balance,
    totalQuota: quota,
    currency,
    totalConsumedCost: usedQuota,
    totalRequests: account?.lifetimeRequests ?? null,
  }
}

function parseDashboardStats(json: unknown): DashboardStats | null {
  const root = unwrap(json)
  const metric = findMetricObject(root, [
    'today_actual_cost',
    'total_tokens',
    'total_input_tokens',
    'total_output_tokens',
    'average_duration_ms',
  ])
  if (!metric) return null
  const result: DashboardStats = {
    todayCost: toFiniteNonNegative(metric.today_actual_cost),
    cumulativeTokens: toFiniteNonNegative(metric.total_tokens),
    cumulativeInputTokens: toFiniteNonNegative(metric.total_input_tokens),
    cumulativeOutputTokens: toFiniteNonNegative(metric.total_output_tokens),
    avgResponseTimeMs: toFiniteNonNegative(metric.average_duration_ms),
  }
  return Object.values(result).some((value) => value != null) ? result : null
}

function parseUsage(json: unknown): UsageResult {
  const root = unwrap(json)
  const list = findList(root)
  if (list) {
    let tokens = 0
    let requests = 0
    let cost = 0
    let tokenHit = false
    let requestHit = false
    let costHit = false
    for (const item of list) {
      if (!isRecord(item)) continue
      const token = toFiniteNonNegative(item.tokens ?? item.total_tokens ?? item.token_used ?? item.count)
      const request = toFiniteNonNegative(item.requests ?? item.total_requests ?? item.request_count)
      const amount = toFiniteNonNegative(item.cost ?? item.amount ?? item.fee ?? item.spend ?? item.price)
      if (token != null) {
        tokens += token
        tokenHit = true
      }
      if (request != null) {
        requests += request
        requestHit = true
      }
      if (amount != null) {
        cost += amount
        costHit = true
      }
    }
    return {
      todayTokens: tokenHit ? tokens : null,
      todayRequests: requestHit ? requests : null,
      todayCost: costHit ? cost : null,
    }
  }
  const data = findMetricObject(root, [
    'total_tokens',
    'tokens',
    'total_requests',
    'request_count',
    'cost',
    'amount',
  ])
  return {
    todayTokens: data ? toFiniteNonNegative(data.total_tokens ?? data.tokens) : null,
    todayRequests: data ? toFiniteNonNegative(data.total_requests ?? data.request_count) : null,
    todayCost: data ? toFiniteNonNegative(data.cost ?? data.amount ?? data.fee) : null,
  }
}

/** 读取站点 Cookie 并拼成请求头字符串；读不到返回 null。 */
async function readCookieHeader(origin: string): Promise<string | null> {
  let list = await chrome.cookies.getAll({ url: origin })
  if (!list || list.length === 0) list = await chrome.cookies.getAll({ url: origin + '/' })
  if (!list || list.length === 0) return null
  return list.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
}

async function fetchJson(url: string, cookie: string): Promise<FetchResult> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'error',
      headers: { Cookie: cookie, Accept: 'application/json' },
    })
    const contentType = response.headers.get('content-type') || ''
    let json: any | null = null
    if (contentType.includes('json')) {
      try {
        json = await response.json()
      } catch {
        json = null
      }
    }
    return { status: response.status, json, isJson: contentType.includes('json') }
  } catch {
    // CORS / 网络 / 重定向错误由调用方作为该端点不可用处理。
    return { status: 0, json: null, isJson: false }
  }
}

function withQuery(path: string, query: Record<string, string | number>): string {
  const url = new URL(path, 'https://placeholder.invalid')
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value))
  return `${url.pathname}${url.search}`
}

function quotaToCurrency(value: number | null, currency: string): number | null {
  if (value == null) return null
  // SW 零标签路径没有可靠的站点计价配置；仅对 New-API 标准 quota 使用已知换算，
  // IKunCode/独立站点的账户费用保留原始数值，避免假设币种或汇率。
  return currency === 'USD' ? value / 500000 : value
}

/**
 * 实验室零标签采集（SW 内）。不调用 refresh 等有副作用 POST。
 * 统计接口即使余额端点不可用，也会尽量保存可验证的部分快照。
 */
export async function collectViaSw(site: SiteConfig): Promise<CollectResult> {
  const cookie = await readCookieHeader(site.origin)
  if (!cookie) {
    // 方案 029 §5.6 / §D：读不到 Cookie 不等于登录失效；标记为实验室会话不可用，
    // 不影响标准页面采集的授权结论，也绝不触发 refresh。
    const msg = '实验室零标签采集：当前无可复用会话（读不到站点 Cookie，可能未登录或缺少 host 权限）'
    await siteRepo.update(site.id, { lastStatus: 'error', lastCollectAt: Date.now(), lastError: msg, lastFailureReason: 'SW_SESSION_UNAVAILABLE' })
    return { siteId: site.id, ok: false, errorKind: 'NOT_FOUND', message: msg }
  }

  const fallbackCurrency = site.currency ?? 'USD'
  const balancePaths = uniquePaths([
    site.discovered?.userSelfPath ?? '',
    '/api/user/self',
    '/api/v1/auth/me',
    '/api/user/info',
    '/api/account',
  ])
  const statsPath = site.discovered?.usageStatsPath ?? '/api/v1/usage/dashboard/stats'
  const accountPath = site.discovered?.accountSnapshotPath
  const rangePath = site.discovered?.rangeUsagePath
  // 方案 029 §D：构造上海自然日区间，而非 now - 24h（避免把「近 24 小时」冒充「今日」）
  const nowMs = Date.now()
  const shanghaiNow = new Date(nowMs + 480 * 60 * 1000)
  const shanghaiStartMs = Date.UTC(shanghaiNow.getUTCFullYear(), shanghaiNow.getUTCMonth(), shanghaiNow.getUTCDate()) - 480 * 60 * 1000
  const endSec = Math.floor(nowMs / 1000)
  const startSec = Math.floor(shanghaiStartMs / 1000)
  const usagePaths = uniquePaths([
    rangePath ? withQuery(rangePath, { start_timestamp: startSec, end_timestamp: endSec, default_time: 'hour' }) : '',
    '/api/data/self?start_timestamp=' + startSec + '&end_timestamp=' + endSec + '&default_time=hour',
    '/api/user/usage',
    '/api/v1/user/usage',
    '/api/usage',
  ])

  let balanceResult: BalanceResult = {
    balance: null,
    totalQuota: null,
    currency: fallbackCurrency,
    totalConsumedCost: null,
    totalRequests: null,
  }
  for (const path of balancePaths) {
    const result = await fetchJson(site.origin + path, cookie)
    if (result.status < 200 || result.status >= 300 || !result.isJson || !result.json || isBusinessAuthFailure(result.json)) continue
    const parsed = parseBalance(result.json, fallbackCurrency)
    if (parsed.balance != null || parsed.totalRequests != null) {
      balanceResult = parsed
      break
    }
  }

  let account: AccountSnapshot | null = null
  // refresh 是有副作用的 POST，零标签路径明确跳过；已发现的 GET 账户接口仍可复用。
  if (accountPath && accountPath !== '/api/user/auth/refresh') {
    const result = await fetchJson(site.origin + accountPath, cookie)
    if (result.status >= 200 && result.status < 300 && result.isJson && result.json && !isBusinessAuthFailure(result.json)) {
      account = parseAccount(result.json, fallbackCurrency)
    }
  }

  let stats: DashboardStats | null = null
  const statsUrl = withQuery(statsPath, { timezone: 'Asia/Shanghai' })
  const statsResult = await fetchJson(site.origin + statsUrl, cookie)
  if (statsResult.status >= 200 && statsResult.status < 300 && statsResult.isJson && statsResult.json && !isBusinessAuthFailure(statsResult.json)) {
    stats = parseDashboardStats(statsResult.json)
  }

  let usage: UsageResult = { todayTokens: null, todayRequests: null, todayCost: null }
  for (const path of usagePaths) {
    const result = await fetchJson(site.origin + path, cookie)
    if (result.status < 200 || result.status >= 300 || !result.isJson || !result.json || isBusinessAuthFailure(result.json)) continue
    const parsed = parseUsage(result.json)
    if (parsed.todayTokens != null || parsed.todayRequests != null || parsed.todayCost != null) {
      usage = parsed
      break
    }
  }

  const effectiveAccount = account ?? (balanceResult.totalRequests != null ? {
    balanceQuota: balanceResult.totalQuota,
    consumedQuota: balanceResult.totalConsumedCost,
    lifetimeRequests: balanceResult.totalRequests,
    currency: balanceResult.currency,
  } : null)
  const currency = effectiveAccount?.currency ?? balanceResult.currency ?? fallbackCurrency
  // 方案 029 §5.5 / §D：统一经共享 normalizeAccount 归一化，避免 DoCode 误用 quota - usedQuota 计算余额。
  const candidate: AccountMetricCandidate = {
    quota: effectiveAccount?.balanceQuota ?? balanceResult.totalQuota,
    usedQuota: effectiveAccount?.consumedQuota ?? balanceResult.totalConsumedCost,
    requestCount: effectiveAccount?.lifetimeRequests ?? balanceResult.totalRequests,
    directBalance: balanceResult.balance,
    explicitTotalQuota: null,
    currency,
  }
  const norm = normalizeAccount(candidate, site.discovered?.accountSemantics ?? 'unknown', fallbackCurrency)
  const balance = norm.balance
  const now = Date.now()
  const hasMetrics =
    balance != null ||
    stats != null ||
    usage.todayTokens != null ||
    usage.todayRequests != null ||
    usage.todayCost != null ||
    effectiveAccount != null
  if (!hasMetrics) {
    const msg = '实验室零标签采集失败（多为 CORS 拦截 / 需 Token / 路径不匹配），建议关闭该选项或保持标签登录'
    await siteRepo.update(site.id, { lastStatus: 'error', lastCollectAt: now, lastError: msg })
    return { siteId: site.id, ok: false, errorKind: 'NOT_FOUND', message: msg }
  }

  const snapshot: Snapshot = {
    siteId: site.id,
    takenAt: now,
    balance,
    todayTokens: usage.todayTokens,
    todayRequests: usage.todayRequests,
    todayCost: stats?.todayCost ?? usage.todayCost,
    totalRequests: norm.totalRequests ?? null,
    totalQuota: norm.totalQuota,
    currency,
    modelUsages: [],
    status: 'ok',
    channel: 'sw_lab',
    quality: stats || usage.todayTokens != null ? 'partial' : 'unknown',
    family: site.discovered?.family,
    routeProfile: site.discovered?.routeProfile,
    confidence: site.discovered?.confidence,
    balanceSource: balance != null ? 'userSelf' : undefined,
    usageSource: usage.todayTokens != null ? 'swLab' : 'unavailable',
    isPartial: stats == null || usage.todayTokens == null,
    collectorVersion: 4,
    cumulativeTokens: stats?.cumulativeTokens ?? null,
    cumulativeTokensSource: stats?.cumulativeTokens != null ? 'dashboard' : null,
    apiRoundTripMs: null,
    avgResponseTimeMs: stats?.avgResponseTimeMs ?? null,
    metricsPartial: stats == null,
    cumulativeInputTokens: stats?.cumulativeInputTokens ?? null,
    cumulativeOutputTokens: stats?.cumulativeOutputTokens ?? null,
    totalConsumedCost: norm.totalConsumedCost,
    recent24hCost: null,
    recent24hTokens: null,
    usageWindow: stats?.todayCost != null ? 'calendar_day' : null,
    todayCostSource: stats?.todayCost != null ? 'dashboard_stats' : usage.todayCost != null ? 'logs' : null,
    usageStatsSource: stats != null ? 'dashboard_stats' : effectiveAccount != null ? 'account_snapshot' : null,
  }
  await snapshotRepo.append(snapshot)
  if (snapshot.todayTokens != null) await dailyStatRepo.upsertForDay(snapshot)
  await authStateRepo.apply(site.id, {
    state: 'authenticated',
    evidence: {
      state: 'authenticated',
      reason: 'ACCOUNT_AUTHENTICATED',
      endpointRole: 'candidate',
      path: '/api/user/self',
      httpStatus: 200,
      provider: 'unknown',
      contextComplete: false,
      observedAt: now,
    },
    collectedAt: now,
  })
  return { siteId: site.id, ok: true, snapshot }
}
