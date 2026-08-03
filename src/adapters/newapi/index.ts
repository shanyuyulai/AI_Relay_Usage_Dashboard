import type {
  SiteAdapter,
  CollectContext,
  SessionContext,
  UsageRange,
  UsageLog,
  SessionStatus,
} from '../../core/adapter/contracts'
import { CollectError, missingRequiredFields } from '../../core/adapter/contracts'
import { fetchJson } from '../../core/adapter/http'
import type { Snapshot } from '../../shared/types'
import { getPath, toNumber, hashResponse } from '../../shared/parse'

/** 由响应特征探测接口版本（New API 多数版本不回传 version 字段，故默认 null）。 */
function detectVersion(s: unknown): string | null {
  const v = getPath(s, 'version')
  return typeof v === 'string' ? v : null
}

/**
 * New API 各 fork 响应结构不一致：常见为 {success:true, data:{...}} 包装，
 * 也有直接返回 {...} 的。统一解包：若顶层存在 success 且 data 为对象，取 data。
 */
function unwrapNewApiResponse(raw: unknown): { success: boolean; data: unknown; message?: string } {
  if (raw == null || typeof raw !== 'object') return { success: true, data: raw }
  const obj = raw as Record<string, unknown>
  const hasWrapper = 'success' in obj || 'data' in obj
  if (!hasWrapper) return { success: true, data: raw }
  const success = obj.success === true || obj.success == null
  const message = typeof obj.message === 'string' ? obj.message : undefined
  return { success, data: obj.data, message }
}

/** 候选用户信息接口路径（按常见 New API / One API fork 排序）。 */
const USER_SELF_CANDIDATES = [
  '/api/user/self',
  '/api/user',
  '/api/user/info',
  '/api/v1/user',
  '/api/user/dashboard',
  '/api/user/profile',
  '/api/self',
  '/api/me',
  '/user/api/self',
]

/**
 * 连通性 + Cookie 预检：先请求 /api/status 判断站点是否可达、Cookie 是否有效。
 * 返回响应状态码，用于诊断。不抛异常（任何失败都返回状态码）。
 */
async function preflightCheck(baseUrl: string, siteId: string, cookieString?: string): Promise<{ reachable: boolean; statusCode: number; hasCookieAuth: boolean }> {
  const checkUrl = `${baseUrl}/api/status`
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (cookieString) headers['Cookie'] = cookieString
    const res = await fetch(checkUrl, {
      credentials: 'include',
      headers,
      signal: controller.signal,
    })
    clearTimeout(timer)
    // 200=可达+可能有鉴权; 302=可能需要登录; 404=接口不存在但站点可达
    const hasCookieAuth = res.status === 200
    console.log(`[AI Relay][newapi] 预检 ${checkUrl} → ${res.status} (${hasCookieAuth ? '已鉴权' : '未鉴权/不可用'})`)
    return { reachable: true, statusCode: res.status, hasCookieAuth }
  } catch {
    console.log(`[AI Relay][newapi] 预检 ${checkUrl} → 不可达`)
    return { reachable: false, statusCode: 0, hasCookieAuth: false }
  }
}

interface UserSelfResult {
  raw: unknown
  data: Record<string, unknown>
  url: string
  wrapped: boolean
}

/**
 * 探测可用的用户信息接口并解包。
 * 优先使用页面主世界探测到的 discoveredPath；没有则按候选列表探测。
 * 忽略 404（继续下一个候选），遇到 401/403 立即返回 AUTH_EXPIRED，
 * 最终仍未命中则抛 NOT_FOUND。
 */
async function fetchUserSelf(
  baseUrl: string,
  siteId: string,
  cookieString?: string,
  discoveredPath?: string,
): Promise<UserSelfResult> {
  let lastAuthExpired: CollectError | null = null

  // 探测顺序：discoveredPath 优先 → 内置候选列表
  const candidates = discoveredPath
    ? [discoveredPath, ...USER_SELF_CANDIDATES.filter((p) => p !== discoveredPath)]
    : USER_SELF_CANDIDATES

  console.log(`[AI Relay][newapi] 开始探测用户信息接口，候选: [${candidates.join(', ')}]`)
  for (const path of candidates) {
    const url = `${baseUrl}${path}`
    try {
      const raw = await fetchJson(url, siteId, cookieString, 8000)
      const { success, data, message } = unwrapNewApiResponse(raw)
      if (!success) {
        // 业务失败通常代表登录态失效（如 success:false, message:'未登录'）
        console.log(`[AI Relay][newapi] ${url} 返回 success=false, message="${message || '无'}"`)
        throw new CollectError('AUTH_EXPIRED', `业务失败: ${message || '未登录'}`, siteId)
      }
      if (data == null || typeof data !== 'object') {
        throw new CollectError('PARSE', `接口返回非对象: ${url}`, siteId)
      }
      const keys = Object.keys(data as Record<string, unknown>)
      console.log(`[AI Relay][newapi] ✓ 命中接口 ${url}，数据字段: [${keys.join(', ')}]`)
      return { raw, data: data as Record<string, unknown>, url, wrapped: raw !== data }
    } catch (e) {
      if (e instanceof CollectError) {
        if (e.kind === 'AUTH_EXPIRED') {
          console.log(`[AI Relay][newapi] ${url} 鉴权失败 (${e.kind})，停止探测`)
          lastAuthExpired = e
          break // 已登录态问题，无需再试其他路径
        }
        if (e.kind === 'NOT_FOUND') {
          console.log(`[AI Relay][newapi] ${url} → 404，尝试下一个候选接口`)
          continue
        }
        // 其他 CollectError（NETWORK/PARSE）也记录并继续
        console.log(`[AI Relay][newapi] ${url} → ${e.kind}: ${e.message}，尝试下一个候选接口`)
        continue
      }
      throw e
    }
  }

  if (lastAuthExpired) throw lastAuthExpired
  throw new CollectError('NOT_FOUND', `未找到可用的用户信息接口: ${candidates.join(', ')}`, siteId)
}

/** 查找第一个存在的数值字段（余额 / 已用）。 */
function findNumber(data: Record<string, unknown>, paths: string[]): number | null {
  for (const p of paths) {
    const v = getPath(data, p)
    if (v !== undefined && v !== null) {
      const n = toNumber(v)
      if (!Number.isNaN(n)) return n
    }
  }
  return null
}

/** 余额字段候选（不同 fork 命名不同）。 */
const BALANCE_PATHS = ['quota', 'balance', 'remain', 'remaining', 'available']
/** 已用额度字段候选。 */
const USED_PATHS = ['used_quota', 'used', 'consumption', 'total_spent', 'spent']

export const newApiAdapter: SiteAdapter = {
  id: 'newapi',
  name: 'New API',
  description: '兼容 OpenAI 格式的中转管理面板；自动探测 /api/user/self、/api/user 等接口',
  // 不写 *.com；运行时由注册逻辑按站点 baseUrl 归一化为具体 origin 后申请/注入（P0-5）
  requiredScopes: [],
  collectPageMatches: [],

  // 鉴权已合并进 collect（同响应判断），本方法仅用于「测试授权」（见 P0-1）
  async detectSession({ baseUrl, siteId, cookieString, discoveredPath }: SessionContext): Promise<SessionStatus> {
    try {
      const { data } = await fetchUserSelf(baseUrl, siteId, cookieString, discoveredPath)
      return getPath(data, 'id') != null ? 'ok' : 'expired'
    } catch (e) {
      if (e instanceof CollectError && e.kind === 'AUTH_EXPIRED') return 'expired'
      return 'unknown'
    }
  },

  async collect(ctx: CollectContext): Promise<Snapshot> {
    // 预检：测试连通性和 Cookie 有效性
    const preflight = await preflightCheck(ctx.baseUrl, ctx.siteId, ctx.cookieString)

    const { raw, data, url, wrapped } = await fetchUserSelf(
      ctx.baseUrl,
      ctx.siteId,
      ctx.cookieString,
      ctx.discoveredPath,
    )

    // 同响应内判断鉴权（见 P0-1）：无 id 即会话缺失
    if (getPath(data, 'id') == null) {
      throw new CollectError('AUTH_EXPIRED', '会话缺失（无 id）', ctx.siteId)
    }

    const balance = findNumber(data, BALANCE_PATHS)
    const used = findNumber(data, USED_PATHS)
    const version = detectVersion(data)

    console.log(
      `[AI Relay][newapi] 字段发现: balance=${balance} (来源路径搜索: [${BALANCE_PATHS.join(', ')}]) used=${used} (来源路径搜索: [${USED_PATHS.join(', ')}]) version=${version || '?'}`,
    )

    // 契约校验：至少要有余额或已用其一（不同 fork 字段名不同，P1-1）
    if (balance == null && used == null) {
      throw new CollectError(
        'PARSE',
        `缺少余额/已用字段（尝试了 ${BALANCE_PATHS.join('/')} 和 ${USED_PATHS.join('/')}）`,
        ctx.siteId,
        {
          endpoint: url,
          statusCode: 200,
          missingFields: BALANCE_PATHS,
          responseHash: hashResponse(raw),
          apiVersion: version,
        },
      )
    }

    const totalQuota = balance != null && used != null ? balance + used : null

    // 今日用量必须来自 fetchUsageLogs（P0-3），此处不差分余额；无则 null（UI 显「—」）
    const snapshot: Snapshot = {
      siteId: ctx.siteId,
      takenAt: Date.now(),
      balance: balance ?? 0,
      todayTokens: null,
      todayRequests: null,
      totalRequests: null,
      totalQuota,
      currency: 'USD', // New API 额度默认 USD 计价（平台原生单位）；部署为 RMB 时请调整此适配器
      modelUsages: [],
      status: 'ok',
      channel: 'sw', // 占位，collector 按真实来源覆盖（alarm / sw / content_script）
      apiVersion: version ?? undefined,
      responseHash: hashResponse(data),
      quality: 'partial', // 待 fetchUsageLogs 补充后可能升为 verified
    }
    return snapshot
  },

  /**
   * 今日用量唯一可信来源（P0-3）。
   * New API /api/user/usage 多数版本返回 7 日额度序列 { quota:[...], used:[...] }；
   * 形态不匹配契约时返回 null（表示「无精确用量来源」，区别于空数组「有来源但为 0」）；
   * 不报错，余额已采集，UI 用量显 unknown，collector 标记 no_source 且不落 dailyStats。
   */
  async fetchUsageLogs(ctx: CollectContext, range: UsageRange): Promise<UsageLog[] | null> {
    const url = `${ctx.baseUrl}/api/user/usage?from=${range.from}&to=${range.to}`
    try {
      const raw = await fetchJson(url, ctx.siteId, ctx.cookieString, 10000)
      const { success, data } = unwrapNewApiResponse(raw)
      if (!success) return null // 业务失败视为无精确用量来源，不阻断余额采集
      const used = getPath(data, 'used')
      if (!Array.isArray(used)) return null // 无精确用量来源
      return (used as unknown[]).map((v, i) => ({
        ts: range.from + i * 86_400_000,
        tokens: toNumber(v),
        requests: null, // 该序列为额度而非请求数，请求数未知
        model: '*',
      }))
    } catch (e) {
      // 用量接口可选，任何失败都不阻断余额采集
      console.log('[AI Relay][newapi] fetchUsageLogs 失败（非阻断）', e)
      return null
    }
  },

  // P1-1 契约：脱敏样本 + 必填字段（detectVersion 见本文件函数）
  contract: {
    sample: { id: 1, username: 'user_***', quota: 5, used_quota: 1.2, role: 1, status: 1 },
    requiredFields: ['id'],
    detectVersion,
  },
}
