/**
 * 页面主世界注入函数。
 *
 * ⚠️ 关键约束：通过 chrome.scripting.executeScript({ world: 'MAIN', func }) 注入时，
 * Chrome 只序列化「函数本身」的源码，不会把本文件顶层的 const / 函数一起带进页面。
 * 因此每个导出函数都必须「完全自包含」——所有用到的常量与 helper 必须写在函数体内部，
 * 不能引用函数外部的任何符号，否则页面里会 ReferenceError、函数无返回 → 「探测脚本未返回结果」。
 */

import type { UsageRecord, AccountSemantics, AuthEvidence, AuthState } from '../shared/types'

export interface ProbeAttempt {
  url: string
  status: number
  contentType: string
  topKeys: string[]
  hasWrapper: boolean
  error?: string
  /** data 对象各字段的 typeof 结果（脱敏指纹，绝不含值原文）。如 {quota:'number', balance:'number'} */
  dataFieldTypes?: Record<string, string>
  /** data 对象的所有 key 名称 */
  dataFieldNames?: string[]
  /** data 是否为数组（日志端点 /api/log/self 的特征） */
  hasDataArray?: boolean
  /** 是否有 created_at + token_used/prompt_tokens 字段（小时聚合/日志特征） */
  hasHourlyStructure?: boolean
  /** 是否有用户标识字段（id/user_id/username/email 任一） */
  hasUserId?: boolean
  /** 是否命中 data.user.{quota,used_quota,request_count} 账户结构 */
  hasAccountSnapshot?: boolean
  /** success wrapper 的业务结果；undefined 表示响应没有 success 字段 */
  successValue?: boolean | null
}

export interface ProbeMatch {
  url: string
  path: string
  topKeys: string[]
  idValue: unknown
  idPath: string
  balancePath: string | null
  usedPath: string | null
  wrapped: boolean
}

export interface ProbeResult {
  cookiePresent: boolean
  cookieNames: string[]
  localStorageKeys: string[]
  sessionStorageKeys: string[]
  match?: ProbeMatch
  attempts: ProbeAttempt[]
}

/** collectInPage 的返回结构（SW 侧据此落库）。完全可序列化。 */
export interface PageCollectResult {
  ok: boolean
  reason: string
  authExpired: boolean
  /** 三态授权结论；authExpired 仅为兼容字段。 */
  authState: AuthState
  /** 最近一次脱敏授权证据，不含 Cookie / Token / 用户 ID。 */
  authEvidence: AuthEvidence | null
  /** 页面请求上下文的脱敏状态；只用于诊断，绝不包含凭证原文。 */
  authContext: {
    userStoragePresent: boolean
    userStorageParseable: boolean
    userIdPresent: boolean
    bearerTokenPresent: boolean
    browserIdPresent: boolean
    newApiUserHeaderSent: boolean
    browserIdHeaderSent: boolean
  }
  cookiePresent: boolean
  cookieNames: string[]
  localStorageKeys: string[]
  sessionStorageKeys: string[]
  balance: number | null
  used: number | null
  totalQuota: number | null
  totalRequests: number | null
  currency: string | null
  todayTokens: number | null
  todayRequests: number | null
  /** 今日使用金额（本币）。来自用量日志 cost/quota 字段；无则 null。 */
  todayCost: number | null
  modelUsages: { model: string; tokens: number; cost: number }[]
  path: string | null
  rawKeys: string[]
  /** 用量来源：hourly_aggregate | raw_logs | unavailable */
  usageSource?: string
  /** 用量数据是否不完整（分页超限） */
  isPartial?: boolean
  /** 采集器版本号 */
  collectorVersion?: number
  // ===== A0 新增：指标与来源可信度（GPT P0-2/P0-5）=====
  /** 累计 Token（仅权威 token 命名字段，绝不来自 quota/used_quota 额度）。无则 null。 */
  cumulativeTokens: number | null
  /** 累计 Token 来源（dashboard = 站点权威接口；null = 无权威源） */
  cumulativeTokensSource?: 'dashboard' | null
  /** 本次采集对余额接口实测往返耗时（ms） */
  apiRoundTripMs: number | null
  /** 站点自报平均 API 响应时间（ms，仅权威时间字段；否则 null） */
  avgResponseTimeMs: number | null
  /** 指标是否不完整 */
  metricsPartial?: boolean
  // ===== 统计接口 + IKunCode provider 采集字段（方案 §2/§7）=====
  /** 账户累计输入 Token（仅权威 total_input_tokens；否则 null） */
  cumulativeInputTokens: number | null
  /** 账户累计输出 Token（仅权威 total_output_tokens；否则 null） */
  cumulativeOutputTokens: number | null
  /** 账户累计消费额度/费用（如 IKunCode used_quota 经 quotaToCurrency；否则 null） */
  totalConsumedCost: number | null
  /** 滚动 24h 使用金额（range_usage rolling_24h；否则 null） */
  recent24hCost: number | null
  /** 滚动 24h Token（range_usage rolling_24h；否则 null） */
  recent24hTokens: number | null
  /** 指标时间窗口：calendar_day / rolling_24h / range */
  usageWindow: 'calendar_day' | 'rolling_24h' | 'range' | null
  /** 今日使用金额来源：dashboard_stats(权威) / range_usage / logs(降级) */
  todayCostSource: 'dashboard_stats' | 'range_usage' | 'logs' | null
  /** 统计/账户指标来源：dashboard_stats / account_snapshot / range_usage / null */
  usageStatsSource: 'dashboard_stats' | 'account_snapshot' | 'range_usage' | null
  // ===== 诊断日志（脱敏指纹，P0-1/P0-4 安全边界）=====
  /** 每个端点请求的脱敏诊断条目（不含任何私密值原文） */
  diags: Array<{
    phase: 'balance' | 'usage'
    url: string
    status: number
    contentType: string
    elapsedMs: number
    fieldFingerprint: Record<string, string>
    note: string
  }>
  // ===== 当日用量明细记录（来自 /api/v1/usage 等用量明细列表端点，P0-2 白名单）=====
  /** 归一化后的用量明细（已按 ts 升序；仅白名单字段，无服务端 id/嵌套/原文） */
  usageRecords: UsageRecord[]
  /** 明细是否完整采集（false=命中分页上限被截断） */
  usageRecordsComplete: boolean
  /** 截断原因（人类可读；无则 null） */
  usageRecordsTruncatedReason: string | null
  /** 用量明细采集是否真正执行过（true=即使结果为空也应覆盖旧批次；undefined=未尝试，不动旧批次） */
  usageCollected?: boolean
  /** 用量采集是否失败（请求/解析/分页异常）。失败时绝不当作「成功空日」覆盖历史批次（GPT P0-I2） */
  usageFailed?: boolean
  /** 页面世界实际使用的业务日（YYYY-MM-DD），供 SW 落库批次与缓存失效对齐，避免跨午夜错位 */
  usageListDay?: string | null
  usageListPath?: string | null
  usageListKind?: 'hubway_v1' | 'generic' | null
  /** 本次采集识别到的账户快照语义契约（方案 027 §3.1）。仅回传枚举，不回传数值/原文。 */
  accountSemantics?: AccountSemantics | null
}

// ⚠️ 候选路径列表已内联到各页面世界函数体内。
// executeScript 只序列化函数体、不携带模块作用域；若函数引用本文件顶层 const，
// 页面里会 ReferenceError → 无返回 → “未返回结果”。故 CANDIDATE_PATHS 不得定义在模块顶层。

/**
 * 在页面主世界执行的端点探测。
 * 仅用于「探测接口」按钮：找到返回用户信息 JSON 的真实路径并回传，供后续采集复用。
 */
export async function probeSiteEndpoints(origin: string): Promise<ProbeResult> {
  // —— 以下全部自包含，不得引用本文件顶层符号 ——
  const BALANCE_PATHS = ['quota', 'balance', 'remain', 'remaining', 'available', 'totalQuota', 'total_quota']
  const USED_PATHS = ['used_quota', 'used', 'consumption', 'total_spent', 'spent']
  const ID_PATHS = ['id', 'user_id', 'userId', 'username', 'email']

  // 候选路径必须内联（executeScript 不携带模块作用域）
  const CANDIDATE_PATHS = [
    '/api/v1/auth/me',
    '/api/user/self',
    '/api/user',
    '/api/user/info',
    '/api/v1/user',
    '/api/user/dashboard',
    '/api/user/profile',
    '/api/self',
    '/api/me',
    '/user/api/self',
    '/api/user/status',
    '/api/v1/user/self',
    '/api/v1/me',
    '/api/profile',
    '/api/account',
    '/api/account/info',
    '/api/auth/me',
    '/api/session',
    '/api/user/session',
    '/api/user/token',
    '/api/token',
    '/api/index/user',
  ]

  function getPath(obj: any, path: string): any {
    return path.split('.').reduce((o: any, k: string) => (o && typeof o === 'object' ? o[k] : undefined), obj)
  }
  function toNumber(v: any): number {
    if (typeof v === 'number') return Number.isFinite(v) ? v : NaN
    if (typeof v === 'string') {
      const n = Number(v.replace(/,/g, ''))
      return Number.isFinite(n) ? n : NaN
    }
    return NaN
  }
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
  function findField(data: Record<string, unknown>, paths: string[]): { path: string; value: unknown } | null {
    for (const p of paths) {
      const v = getPath(data, p)
      if (v !== undefined && v !== null) return { path: p, value: v }
    }
    return null
  }
  function isRecord(v: unknown): v is Record<string, unknown> {
    return v != null && typeof v === 'object' && !Array.isArray(v)
  }
  function isBusinessAuthFailure(raw: unknown): boolean {
    if (!isRecord(raw)) return false
    const error = isRecord(raw.error) ? raw.error : null
    return (
      raw.success === false ||
      raw.code === 'AUTH_UNAUTHORIZED' ||
      raw.code === 'UNAUTHORIZED' ||
      error?.code === 'AUTH_UNAUTHORIZED' ||
      error?.code === 'UNAUTHORIZED'
    )
  }
  /**
   * 明确未授权（方案 027 §3.2）：仅识别显式未授权业务码。
   * 普通 success:false（功能关闭 / 参数错误 / 不支持的路径）属业务失败，不得据此判定登录失效。
   * HTTP 401/403 由调用处按状态码单独判定。
   */
  function isExplicitUnauthorized(raw: unknown): boolean {
    if (!isRecord(raw)) return false
    const error = isRecord(raw.error) ? raw.error : null
    return (
      raw.code === 'AUTH_UNAUTHORIZED' ||
      raw.code === 'UNAUTHORIZED' ||
      error?.code === 'AUTH_UNAUTHORIZED' ||
      error?.code === 'UNAUTHORIZED'
    )
  }
  function unwrap(raw: unknown): any {
    if (Array.isArray(raw)) return raw
    if (!isRecord(raw)) return null
    if (isBusinessAuthFailure(raw)) return null
    let value: any = raw
    for (let depth = 0; depth < 5; depth++) {
      if (!isRecord(value) || isBusinessAuthFailure(value)) return null
      let advanced = false
      for (const key of ['data', 'payload', 'response', 'result']) {
        const nested = (value as any)[key]
        if (isRecord(nested) || Array.isArray(nested)) {
          value = nested
          advanced = true
          break
        }
      }
      if (!advanced) break
    }
    return value
  }

  /** 在有限深度的常见响应 wrapper 中定位字段对象，仅回传字段名和类型。 */
  function findNestedObject(raw: any, keys: string[], depth = 0): Record<string, unknown> | null {
    if (depth > 5 || !isRecord(raw)) return null
    if (keys.some((key) => Object.prototype.hasOwnProperty.call(raw, key))) return raw
    for (const key of ['data', 'stats', 'summary', 'result', 'usage', 'payload', 'response']) {
      const nested = findNestedObject((raw as any)[key], keys, depth + 1)
      if (nested) return nested
    }
    return null
  }

  function hasAccountSnapshot(data: any): boolean {
    const root = findNestedObject(data, ['user'])
    const nestedUser = root && isRecord((root as any).user) ? (root as any).user : null
    // DoCode 当前部署的 /api/user/self 在 data 下直接返回用户字段，不再包一层 data.user。
    // 只有同时具备身份字段与账户额度字段时才作为快照，避免把普通统计对象误认成用户。
    const direct = unwrap(data)
    const user = nestedUser ?? (isRecord(direct) ? direct : null)
    if (!user) return false
    const hasIdentity = ['id', 'user_id', 'username', 'email'].some((key) => user[key] !== undefined && user[key] !== null)
    const hasAccountFields = ['quota', 'used_quota', 'request_count'].some((key) => user[key] !== undefined && user[key] !== null)
    return hasIdentity && hasAccountFields
  }

  function buildPageAuthContext() {
    const headers: Record<string, string> = { Accept: 'application/json', 'Cache-Control': 'no-store' }
    let user: Record<string, unknown> | null = null
    let userStoragePresent = false
    let userStorageParseable = false
    try {
      const raw = localStorage.getItem('user')
      userStoragePresent = raw != null
      const parsed = raw ? JSON.parse(raw) : null
      userStorageParseable = raw != null
      if (isRecord(parsed)) user = parsed
    } catch {}
    const idRaw = user?.id
    const userId = (typeof idRaw === 'number' && Number.isFinite(idRaw)) ||
      (typeof idRaw === 'string' && idRaw.trim().length > 0) ? String(idRaw) : null
    const nestedToken = user?.token
    let token: string | null = typeof nestedToken === 'string' && nestedToken.trim().length > 8 ? nestedToken.trim() : null
    if (!token) {
      try {
        for (const key of ['token', 'access_token', 'auth_token', 'userToken', 'Authorization', 'auth', 'accessToken', 'id_token']) {
          const value = localStorage.getItem(key)
          if (value && value.length > 8) { token = value.trim(); break }
        }
      } catch {}
    }
    if (token?.startsWith('Bearer ')) token = token.slice(7).trim()
    let browserId: string | null = null
    try {
      const value = localStorage.getItem('docode_browser_id')
      if (value && value.length >= 16 && value.length <= 128) browserId = value
      if (!browserId) {
        const generated = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
        localStorage.setItem('docode_browser_id', generated)
        browserId = generated
      }
    } catch {}
    // 与 DoCode 官方 Axios 拦截器一致：用户 ID、Bearer 和浏览器 ID 是独立头部。
    if (userId) headers['New-API-User'] = userId
    if (token) headers.Authorization = 'Bearer ' + token
    if (browserId) headers['X-Docode-Browser-Id'] = browserId
    return { headers, token, provider: userId ? 'new_api_user_object' : 'generic_cookie_or_token' }
  }

  /** Find a paginated list without assuming the server's exact wrapper depth. */
  function findList(data: any, depth = 0): any[] | null {
    if (Array.isArray(data)) return data
    if (!isRecord(data) || depth > 5) return null
    for (const key of ['items', 'list', 'records', 'rows', 'results', 'data']) {
      const value = (data as any)[key]
      if (Array.isArray(value)) return value
      if (isRecord(value)) {
        const nested = findList(value, depth + 1)
        if (nested) return nested
      }
    }
    for (const key of ['payload', 'response', 'result', 'usage']) {
      const nested = findList((data as any)[key], depth + 1)
      if (nested) return nested
    }
    return null
  }

  const cookiePresent = document.cookie.length > 0
  const cookieNames = document.cookie
    .split(';')
    .map((c) => c.split('=')[0].trim())
    .filter(Boolean)
  const localStorageKeys = Object.keys(localStorage)
  const sessionStorageKeys = Object.keys(sessionStorage)

  const attempts: ProbeAttempt[] = []
  let match: ProbeMatch | undefined
  const pageAuthContext = buildPageAuthContext()

  // 同一标签页/页面内共享的探测逻辑（自包含）：fetch + 脱敏指纹。
  // 不回传任何 JSON 原文/Token/Cookie（P0-4 安全边界）。
  async function probeOne(url: string): Promise<ProbeAttempt> {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5000)
      const headers: Record<string, string> = { ...pageAuthContext.headers }
      const fetchOnce = async (requestHeaders: Record<string, string>) => {
        const response = await fetch(url, { credentials: 'include', headers: requestHeaders, signal: controller.signal })
        const responseContentType = response.headers.get('content-type') || ''
        let responseJson: any = undefined
        if (responseContentType.includes('json')) {
          try {
            const text = await response.text()
            responseJson = text ? JSON.parse(text) : null
          } catch {
            responseJson = null
          }
        }
        return { response, responseContentType, responseJson }
      }
      let fetched = await fetchOnce(headers)
      if (pageAuthContext.token && pageAuthContext.provider !== 'new_api_user_object' &&
        (fetched.response.status === 401 || fetched.response.status === 403 || isBusinessAuthFailure(fetched.responseJson))) {
        fetched = await fetchOnce({ Accept: 'application/json' })
      }
      const res = fetched.response
      clearTimeout(timer)

      const contentType = fetched.responseContentType
      let topKeys: string[] = []
      let hasWrapper = false
      const sample: unknown = fetched.responseJson
      if (isRecord(sample) || Array.isArray(sample)) {
        topKeys = Object.keys(sample)
        hasWrapper = isRecord(sample) && ('success' in sample || 'data' in sample || 'payload' in sample || 'response' in sample)
      }

      let dataFieldTypes: Record<string, string> | undefined
      let dataFieldNames: string[] | undefined
      let hasDataArray = false
      let hasHourlyStructure = false
      let hasUserId = false
      let hasAccount = false
      let probeData: any = null
      let successValue: boolean | null | undefined
      if (sample != null) {
      if (isRecord(sample) && typeof (sample as any).success === 'boolean') successValue = (sample as any).success
      const data = unwrap(sample)
      probeData = data
      const list = findList(data)
      if (list && list.some((v: unknown) => isRecord(v))) {
        const first = list.find((v: unknown) => isRecord(v)) as Record<string, unknown> | undefined
        dataFieldNames = first ? Object.keys(first) : []
        const types: Record<string, string> = {}
        for (const k of dataFieldNames) types[k] = typeof first?.[k]
        dataFieldTypes = types
        hasDataArray = true
        hasHourlyStructure =
          dataFieldNames.includes('created_at') &&
          (dataFieldNames.includes('token_used') || dataFieldNames.includes('prompt_tokens'))
        hasUserId = !!first && ID_PATHS.some((p) => getPath(first, p) != null)
      } else if (data) {
        const metric = findNestedObject(data, [
          'today_actual_cost',
          'total_tokens',
          'total_input_tokens',
          'total_output_tokens',
          'average_duration_ms',
        ])
        const fieldData = metric ?? data
        dataFieldNames = Object.keys(fieldData)
        const types: Record<string, string> = {}
        for (const k of dataFieldNames) types[k] = typeof (fieldData as any)[k]
        dataFieldTypes = types
          // 数组特征：data 第一个值为数组，或 data 仅一个数组字段
          hasDataArray =
            Array.isArray(Object.values(data)[0]) ||
            (dataFieldNames.length === 1 && Array.isArray((data as any)[dataFieldNames[0]]))
          // 小时聚合/用量特征（放宽）：created_at+token 字段，或含 used/total_tokens/tokens 数组/数值
          hasHourlyStructure =
            (dataFieldNames.includes('created_at') &&
              (dataFieldNames.includes('token_used') || dataFieldNames.includes('prompt_tokens'))) ||
            dataFieldNames.includes('used') ||
            dataFieldNames.includes('total_tokens') ||
            dataFieldNames.includes('tokens') ||
            dataFieldNames.includes('data')
          hasUserId = ID_PATHS.some((p) => getPath(data, p) != null) || ID_PATHS.some((p) => getPath(fieldData, p) != null)
        }
      }

      hasAccount = hasAccountSnapshot(probeData)
      return {
        url, status: res.status, contentType, topKeys, hasWrapper,
        dataFieldTypes, dataFieldNames, hasDataArray, hasHourlyStructure,
        hasUserId: hasUserId || hasAccount,
        hasAccountSnapshot: hasAccount,
        successValue,
      }
    } catch (e) {
      return { url, status: 0, contentType: '', topKeys: [], hasWrapper: false, error: (e as Error).message }
    }
  }

  // 第一遍：余额候选（命中即 break）
  for (const path of CANDIDATE_PATHS) {
    const url = origin + path
    const attempt = await probeOne(url)
    attempts.push(attempt)
    if (attempt.status >= 200 && attempt.status < 300 && attempt.dataFieldNames) {
      // 在页面主世界内直接判定余额命中（仅用脱敏字段类型，不回传值原文；P0-4 安全边界）
      const dt = attempt.dataFieldTypes || {}
      const hasIdType = ID_PATHS.some((p) => Object.prototype.hasOwnProperty.call(dt, p))
      const hasBalanceType =
        dt['quota'] !== undefined || dt['balance'] !== undefined || dt['used_quota'] !== undefined || dt['used'] !== undefined
      if ((hasIdType && hasBalanceType) || attempt.hasAccountSnapshot) {
        const accountBalancePath = attempt.hasAccountSnapshot
          ? 'user.quota'
          : dt['quota'] !== undefined
            ? 'quota'
            : dt['balance'] !== undefined
              ? 'balance'
              : 'used_quota'
        match = {
          url,
          path,
          topKeys: attempt.topKeys,
          idValue: null,
          idPath: ID_PATHS.find((p) => Object.prototype.hasOwnProperty.call(dt, p)) || 'user',
          balancePath: accountBalancePath,
          usedPath: dt['used_quota'] !== undefined ? 'used_quota' : dt['used'] !== undefined ? 'used' : null,
          wrapped: attempt.hasWrapper,
        }
        break
      }
    }
  }

  // 第二遍：用量候选（GPT P0-1 自动主动探测，不 break，记录全部指纹供分类）
  const probeDay = new Date(Date.now() + 480 * 60 * 1000)
  const probeDayKey = `${probeDay.getUTCFullYear()}-${String(probeDay.getUTCMonth() + 1).padStart(2, '0')}-${String(probeDay.getUTCDate()).padStart(2, '0')}`
  const USAGE_CANDIDATE_PATHS = [
    `/api/v1/usage?page=1&page_size=20&start_date=${probeDayKey}&end_date=${probeDayKey}&sort_by=created_at&sort_order=desc&timezone=Asia%2FShanghai`,
    '/api/usage?page=1&page_size=50',
    // 统计接口（Hubway 类 usage/dashboard/stats），按结构指纹识别，不按域名硬编码（方案 §3.1）
    '/api/v1/usage/dashboard/stats?timezone=Asia%2FShanghai',
    '/api/data/self',
    '/api/v1/data/self',
    '/api/user/usage',
    '/api/v1/user/usage',
    '/api/log/self',
    '/api/v1/log/self',
    // IKunCode 类计价/公共配置接口（只读，不作为用户指标）
    '/api/status',
  ]
  for (const path of USAGE_CANDIDATE_PATHS) {
    const url = origin + path
    const attempt = await probeOne(url)
    attempts.push(attempt)
  }

  return { cookiePresent, cookieNames, localStorageKeys, sessionStorageKeys, attempts, match }
}

/**
 * 在页面主世界执行的完整采集。
 * 页面 fetch 同源、自动携带 Cookie，从根本上绕过 MV3 Service Worker 读不到 Cookie / fetch 不带鉴权的问题。
 * 返回解析后的余额/已用/今日用量；失败则返回 ok:false + 原因（SW 据此标记状态，不落库任何私密）。
 */
export async function collectInPage(
  origin: string,
  /**
   * 采集策略：由 SW 侧 buildStrategy() 构建，通过 executeScript args 传入。
   * 必须自包含——函数体内不引用外部类型定义。
   * 结构: { endpoints: [{role,path,source?,needsToken?}], family, confidence, currency, collectorVersion }
   */
  strategy: any,
): Promise<PageCollectResult> {
  // —— 以下全部自包含 ——
  const BALANCE_PATHS = ['quota', 'balance', 'remain', 'remaining', 'available', 'totalQuota', 'total_quota']
  const USED_PATHS = ['used_quota', 'used', 'consumption', 'total_spent', 'spent']
  const ID_PATHS = ['id', 'user_id', 'userId', 'username', 'email']

  // 候选路径必须内联（executeScript 不携带模块作用域）
  const CANDIDATE_PATHS = [
    '/api/v1/auth/me',
    '/api/user/self',
    '/api/user',
    '/api/user/info',
    '/api/v1/user',
    '/api/user/dashboard',
    '/api/user/profile',
    '/api/self',
    '/api/me',
    '/user/api/self',
    '/api/user/status',
    '/api/v1/user/self',
    '/api/v1/me',
    '/api/profile',
    '/api/account',
    '/api/account/info',
    '/api/auth/me',
    '/api/session',
    '/api/user/session',
    '/api/user/token',
    '/api/token',
    '/api/index/user',
  ]

  // 回退候选列表（若 strategy 未提供路径或 strategy 路径失败时使用）
  const CANDIDATES = (strategy?.endpoints?.find((e: any) => e.role === 'balance')?.path
    ? [strategy.endpoints.find((e: any) => e.role === 'balance').path]
    : []).concat(CANDIDATE_PATHS)

  // 账户快照语义契约（方案 027 §3.1）：由 SW 侧 buildStrategy 透传，驱动字段口径。
  const strategyAccountSemantics: AccountSemantics | null = strategy?.accountSemantics ?? null

  function getPath(obj: any, path: string): any {
    return path.split('.').reduce((o: any, k: string) => (o && typeof o === 'object' ? o[k] : undefined), obj)
  }
  function toNumber(v: any): number {
    if (typeof v === 'number') return Number.isFinite(v) ? v : NaN
    if (typeof v === 'string') {
      const n = Number(v.replace(/,/g, ''))
      return Number.isFinite(n) ? n : NaN
    }
    return NaN
  }
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
  function isRecord(v: unknown): v is Record<string, unknown> {
    return v != null && typeof v === 'object' && !Array.isArray(v)
  }
  function isBusinessAuthFailure(raw: unknown): boolean {
    if (!isRecord(raw)) return false
    const error = isRecord(raw.error) ? raw.error : null
    return (
      raw.success === false ||
      raw.code === 'AUTH_UNAUTHORIZED' ||
      raw.code === 'UNAUTHORIZED' ||
      error?.code === 'AUTH_UNAUTHORIZED' ||
      error?.code === 'UNAUTHORIZED'
    )
  }
  /**
   * 明确未授权（方案 027 §3.2）：仅识别显式未授权业务码。
   * 普通 success:false（功能关闭 / 参数错误 / 不支持的路径）属业务失败，不得据此判定登录失效。
   * HTTP 401/403 由调用处按状态码单独判定。
   */
  function isExplicitUnauthorized(raw: unknown): boolean {
    if (!isRecord(raw)) return false
    const error = isRecord(raw.error) ? raw.error : null
    return (
      raw.code === 'AUTH_UNAUTHORIZED' ||
      raw.code === 'UNAUTHORIZED' ||
      error?.code === 'AUTH_UNAUTHORIZED' ||
      error?.code === 'UNAUTHORIZED'
    )
  }
  function unwrap(raw: unknown): any {
    if (Array.isArray(raw)) return raw
    if (!isRecord(raw)) return null
    if (isBusinessAuthFailure(raw)) return null
    let value: any = raw
    for (let depth = 0; depth < 5; depth++) {
      if (!isRecord(value) || isBusinessAuthFailure(value)) return null
      let advanced = false
      for (const key of ['data', 'payload', 'response', 'result']) {
        const nested = (value as any)[key]
        if (isRecord(nested) || Array.isArray(nested)) {
          value = nested
          advanced = true
          break
        }
      }
      if (!advanced) break
    }
    return value
  }

  /** 在有限深度的常见响应 wrapper 中定位目标字段对象。 */
  function findNestedObject(raw: any, keys: string[], depth = 0): Record<string, unknown> | null {
    if (depth > 5 || !isRecord(raw)) return null
    if (keys.some((key) => Object.prototype.hasOwnProperty.call(raw, key))) return raw
    for (const key of ['data', 'stats', 'summary', 'result', 'usage', 'payload', 'response']) {
      const nested = findNestedObject((raw as any)[key], keys, depth + 1)
      if (nested) return nested
    }
    return null
  }

  /** Find a paginated list without assuming the server's exact wrapper depth. */
  function findList(data: any, depth = 0): any[] | null {
    if (Array.isArray(data)) return data
    if (!isRecord(data) || depth > 5) return null
    for (const key of ['items', 'list', 'records', 'rows', 'results', 'data']) {
      const value = (data as any)[key]
      if (Array.isArray(value)) return value
      if (isRecord(value)) {
        const nested = findList(value, depth + 1)
        if (nested) return nested
      }
    }
    for (const key of ['payload', 'response', 'result', 'usage']) {
      const nested = findList((data as any)[key], depth + 1)
      if (nested) return nested
    }
    return null
  }
  /**
   * DoCode / New API 类站点把用户会话放在 localStorage.user，官方前端请求会同时发送
   * New-API-User 和 Bearer。所有敏感值仅留在当前页面函数闭包内，绝不返回给 SW。
   */
  function buildPageAuthContext() {
    const headers: Record<string, string> = { Accept: 'application/json', 'Cache-Control': 'no-store' }
    let user: Record<string, unknown> | null = null
    let userStoragePresent = false
    let userStorageParseable = false
    try {
      const raw = localStorage.getItem('user')
      userStoragePresent = raw != null
      const parsed = raw ? JSON.parse(raw) : null
      userStorageParseable = raw != null
      if (isRecord(parsed)) user = parsed
    } catch {}
    const idRaw = user?.id
    const userId = (typeof idRaw === 'number' && Number.isFinite(idRaw)) ||
      (typeof idRaw === 'string' && idRaw.trim().length > 0)
      ? String(idRaw)
      : null
    let token: string | null = null
    const nestedToken = user?.token
    if (typeof nestedToken === 'string' && nestedToken.trim().length > 8) token = nestedToken.trim()
    if (!token) {
      try {
        const keys = ['token', 'access_token', 'auth_token', 'userToken', 'Authorization', 'auth', 'accessToken', 'id_token']
        for (const key of keys) {
          const value = localStorage.getItem(key)
          if (value && value.length > 8) {
            token = value.trim()
            break
          }
        }
      } catch {}
    }
    if (token?.startsWith('Bearer ')) token = token.slice(7).trim()
    let browserId: string | null = null
    try {
      const value = localStorage.getItem('docode_browser_id')
      if (value && value.length >= 16 && value.length <= 128) browserId = value
      if (!browserId) {
        const generated = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
        localStorage.setItem('docode_browser_id', generated)
        browserId = generated
      }
    } catch {}
    // 对齐 DoCode 官方 Axios：这三个请求头彼此独立，不以 user.token 作为前置条件。
    if (userId) headers['New-API-User'] = userId
    if (token) headers.Authorization = 'Bearer ' + token
    if (browserId) headers['X-Docode-Browser-Id'] = browserId
    return {
      headers,
      token,
      provider: userId ? ('new_api_user_object' as const) : ('generic_cookie_or_token' as const),
      // 官方客户端可用的 DoCode 请求上下文由用户 ID + 浏览器标识构成；Bearer 为可选增强。
      contextComplete: !!userId && !!browserId,
      authContext: {
        userStoragePresent,
        userStorageParseable,
        userIdPresent: !!userId,
        bearerTokenPresent: !!token,
        browserIdPresent: !!browserId,
        newApiUserHeaderSent: !!headers['New-API-User'],
        browserIdHeaderSent: !!headers['X-Docode-Browser-Id'],
      },
    }
  }
  const pageAuthContext = buildPageAuthContext()
  // 采集重试基础设施（自包含，页面主世界可用）：指数退避 + 抖动 + 单站总预算。
  // 仅重试瞬时/可恢复故障：超时 / 网络错误 / 5xx / 429(尊重 Retry-After)；绝不重试鉴权失效/路径变更/语义空。
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
  const SITE_FETCH_BUDGET_MS = 45000 // 单站全部 fetch 的总预算（线缆层 COLLECT_NOW 超时 60s，预留 SW 开销与标签页等待）
  const COLLECT_DEADLINE = Date.now() + SITE_FETCH_BUDGET_MS
  function parseRetryAfter(res: any): number {
    const h = res && res.headers && res.headers.get ? res.headers.get('retry-after') : null
    if (!h) return 0
    const sec = parseInt(h, 10)
    if (!Number.isNaN(sec)) return sec * 1000
    const d = Date.parse(h)
    if (!Number.isNaN(d)) return Math.max(0, d - Date.now())
    return 0
  }

  async function fetchJson(url: string): Promise<{ status: number; json: any; isJson: boolean }> {
    const TIMEOUT_MS = 5000
    const BASE = 800
    const MAX_DELAY = 5000
    const MAX_ATTEMPTS = 3 // 1 次初始请求 + 最多 2 次重试
    const JITTER = 300

    const fetchOnce = async (requestHeaders: Record<string, string>, signal: AbortSignal) => {
      const res = await fetch(url, {
        credentials: 'include',
        headers: requestHeaders,
        signal,
      })
      const ct = res.headers.get('content-type') || ''
      const isJson = ct.includes('json')
      let json: any = null
      if (isJson) {
        try {
          json = JSON.parse(await res.text())
        } catch {
          json = null
        }
      }
      return { status: res.status, json, isJson }
    }

    let lastResult: { status: number; json: any; isJson: boolean } | null = null
    let lastErr: unknown = null
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
      try {
        const headers: Record<string, string> = { ...pageAuthContext.headers }
        const bearerToken = sessionAccessToken ?? pageAuthContext.token
        if (bearerToken) headers.Authorization = 'Bearer ' + bearerToken
        let result = await fetchOnce(headers, controller.signal)
        // 鉴权重试：401/403 或业务层未授权时，去掉 Bearer 仅用 Cookie 再试一次（同一逻辑请求内单次触发）。
        let rejectedByAuth = false
        if (isRecord(result.json)) {
          const error = isRecord(result.json.error) ? result.json.error : null
          rejectedByAuth =
            result.json.success === false ||
            result.json.code === 'AUTH_UNAUTHORIZED' ||
            result.json.code === 'UNAUTHORIZED' ||
            error?.code === 'AUTH_UNAUTHORIZED' ||
            error?.code === 'UNAUTHORIZED'
        }
        // New API 的完整上下文不仅是 Bearer；不能去掉 New-API-User 后再把失败误判为登出。
        if ((sessionAccessToken || pageAuthContext.token) && pageAuthContext.provider !== 'new_api_user_object') {
          const bearerRejected = result.status === 401 || result.status === 403 || rejectedByAuth
          if (bearerRejected) {
            const cookieHeaders = { Accept: 'application/json' }
            result = await fetchOnce(cookieHeaders, controller.signal)
          }
        }
        lastResult = result
        if (result.status >= 200 && result.status < 300) return result // 成功（含语义空）不重试
        if (result.status === 401 || result.status === 403) return result // 鉴权失效不重试，交上层语义处理
        if (result.status === 404) return result // 路径变更不重试
        if (result.status >= 500) {
          const err: any = new Error(`HTTP ${result.status}`)
          err.__kind = 'HTTP_5XX'
          err.status = result.status
          throw err
        }
        if (result.status === 429) {
          const err: any = new Error('HTTP 429')
          err.__kind = 'HTTP_429'
          err.retryAfter = parseRetryAfter(result) // ms
          throw err
        }
        return result // 其他非 2xx（如 400）请求类错误，不重试
      } catch (e: any) {
        lastErr = e
        // 页面世界中仅有本控制器 5s 超时会产生 AbortError，故 AbortError 一律视为可重试的 TIMEOUT。
        const kind = e && e.__kind ? e.__kind : e && e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK'
        const retryable = kind === 'TIMEOUT' || kind === 'NETWORK' || kind === 'HTTP_5XX' || kind === 'HTTP_429'
        if (!retryable || attempt >= MAX_ATTEMPTS) {
          if (lastResult && (lastResult.status === 401 || lastResult.status === 403)) return lastResult
          throw e
        }
        // 指数退避 + 抖动；429 取服务端 Retry-After 与本地退避的较大值，并受 MAX_DELAY 约束。
        let delay = Math.min(BASE * Math.pow(2, attempt - 1), MAX_DELAY) + Math.floor(Math.random() * (JITTER + 1))
        if (kind === 'HTTP_429' && e.retryAfter) {
          delay = Math.min(Math.max(delay, e.retryAfter), MAX_DELAY)
        }
        // 单站总预算约束：剩余时间不足以发起下次尝试则停止重试，收敛为失败。
        if (Date.now() + delay > COLLECT_DEADLINE) {
          if (lastResult && (lastResult.status === 401 || lastResult.status === 403)) return lastResult
          throw e
        }
        console.warn(`[AI Relay][retry] fetch 瞬时故障(${kind}) 第${attempt}次, ${delay}ms 后重试 url=${url}`)
        await sleep(delay)
      } finally {
        clearTimeout(timer)
      }
    }
    if (lastResult && (lastResult.status === 401 || lastResult.status === 403)) return lastResult
    throw lastErr
  }

  // ikuncode 「/api/data/self」区间用量解析：宽匹配小时趋势数组或汇总对象。
  // 未知响应形态时尽量提取；无法识别返回 null（不影响余额采集主流程）。
  function extractUsage(
    data: any,
  ): { tokens: number | null; requests: number | null; byModel: { model: string; tokens: number }[] } | null {
    const byModel: { model: string; tokens: number }[] = []
    if (Array.isArray(data)) {
      let tokens = 0
      let requests = 0
      let hit = false
      const modelMap = new Map<string, number>()
      for (const item of data) {
        if (!isRecord(item)) continue
        const t = findNumber(item, [
          'tokens', 'token', 'token_used', 'total_tokens', 'totalTokens',
        ])
        const r = findNumber(item, ['requests', 'request', 'count', 'calls', 'total_requests', 'totalRequests'])
        const m =
          typeof item['model'] === 'string'
            ? item['model']
            : typeof item['name'] === 'string'
              ? item['name']
              : null
        if (t != null) {
          tokens += t
          hit = true
          if (m) modelMap.set(m, (modelMap.get(m) || 0) + t)
        }
        if (r != null) {
          requests += r
          hit = true
        }
      }
      modelMap.forEach((v, k) => byModel.push({ model: k, tokens: v }))
      return hit ? { tokens, requests, byModel } : null
    }
    const tokens = findNumber(data, ['total_tokens', 'tokens'])
    const requests = findNumber(data, ['total_requests', 'requests', 'total_request', 'request_count', 'total_request_count', 'count', 'total_count'])
    const list =
      getPath(data, 'items') ??
      getPath(data, 'list') ??
      getPath(data, 'data.items') ??
      getPath(data, 'data.list')
    const nestedList = Array.isArray(list) ? list : findList(data)
    if (Array.isArray(nestedList)) {
      const sub = extractUsage(nestedList)
      if (sub && (sub.tokens != null || sub.requests != null)) {
        return { tokens: tokens ?? sub.tokens, requests: requests ?? sub.requests, byModel: sub.byModel }
      }
    }
    // A1：new-api 聚合端点形态（data.used / data.total_tokens 为按小时数组，hubway 等 fork 同源）
    const usedArr = getPath(data, 'used') ?? getPath(data, 'total_tokens')
    if (Array.isArray(usedArr)) {
      const nums = (usedArr as unknown[]).map(toNumber).filter((n) => !Number.isNaN(n))
      if (nums.length > 0) {
        const reqArr = getPath(data, 'total_requests') ?? getPath(data, 'request_count')
        const reqs = Array.isArray(reqArr)
          ? (reqArr as unknown[]).map(toNumber).filter((n) => !Number.isNaN(n)).reduce((s, v) => s + v, 0)
          : null
        return { tokens: nums.reduce((s, v) => s + v, 0), requests: reqs, byModel: [] }
      }
    }
    if (tokens != null || requests != null) {
      return { tokens: tokens ?? null, requests: requests ?? null, byModel }
    }
    return null
  }

  const cookiePresent = document.cookie.length > 0
  const cookieNames = document.cookie
    .split(';')
    .map((c) => c.split('=')[0].trim())
    .filter(Boolean)
  const localStorageKeys = Object.keys(localStorage)
  const sessionStorageKeys = Object.keys(sessionStorage)

  // 解析 strategy（executeScript 序列化为普通对象，此处用 any 访问）
  const endpoints: Array<{ role: string; path: string; source?: string; needsToken?: boolean; usageListKind?: string }> =
    strategy?.endpoints ?? []
  const balanceEp = endpoints.find((e: any) => e.role === 'balance')
  const usageEps = endpoints.filter((e: any) => e.role === 'usage')
  const stratCurrency = strategy?.currency || 'USD'
  const collectorVersion = strategy?.collectorVersion ?? 0
  // 受控手动流程标志（仅用户「立即同步」时为 true），用于 IKunCode refresh 这类有副作用端点。
  // 必须在余额早退分支之前声明，因为 refresh 可能是余额接口失败后的唯一账户来源。
  const manualCollect = !!(strategy?.manualCollect)
  // 同一轮采集内 refresh 最多执行一次。余额阶段和 account_snapshot provider
  // 可能都需要它，但重复 POST 会造成不必要的会话副作用。
  let refreshAttempted = false
  let refreshSnapshotRaw: any = null
  // IKunCode refresh token remains in memory for this collection only.
  let sessionAccessToken: string | null = null

  // 若 strategy 为空或无余额端点，回退旧逻辑（向后兼容）
  let matchedPath: string | null = null
  let dataObj: Record<string, unknown> | null = null
  // 账户快照可以位于 data.user，不能强行压平成余额端点的顶层字段。
  let accountSnapshotRaw: any = null
  let authExpired = false
  const collectRunId = typeof strategy?.collectRunId === 'string' && strategy.collectRunId
    ? strategy.collectRunId
    : crypto.randomUUID()
  const authorityPaths = new Set<string>(['/api/user/self'])
  for (const endpoint of strategy?.endpoints ?? []) {
    if (endpoint?.authRole === 'authority' && typeof endpoint.path === 'string') authorityPaths.add(endpoint.path)
  }
  const authEvidenceList: AuthEvidence[] = []
  function noteAuth(
    state: AuthState,
    reason: AuthEvidence['reason'],
    endpointRole: AuthEvidence['endpointRole'],
    path: string | null,
    httpStatus: number | null,
  ) {
    authEvidenceList.push({
      state,
      reason,
      endpointRole,
      path,
      httpStatus,
      provider: pageAuthContext.provider,
      contextComplete: pageAuthContext.contextComplete,
      collectRunId,
      observedAt: Date.now(),
    })
  }
  function noteAuthFailure(path: string, status: number, json: any, endpointRole: AuthEvidence['endpointRole'] = 'candidate') {
    const explicitUnauthorized = status === 401 || status === 403 || isExplicitUnauthorized(json)
    const authority = authorityPaths.has(path)
    if (authority && explicitUnauthorized) {
      if (pageAuthContext.contextComplete) {
        noteAuth('unauthorized', 'ACCOUNT_UNAUTHORIZED', 'account_authority', path, status || null)
      } else {
        noteAuth('indeterminate', 'AUTH_CONTEXT_INCOMPLETE', 'account_authority', path, status || null)
      }
    } else if (!authority && explicitUnauthorized) {
      noteAuth('indeterminate', 'CANDIDATE_REJECTED', endpointRole, path, status || null)
    } else if (authority && status === 0) {
      noteAuth('indeterminate', 'NETWORK_OR_TIMEOUT', 'account_authority', path, null)
    }
  }
  function noteAccountSuccess(path: string, status: number) {
    if (authorityPaths.has(path)) {
      noteAuth('authenticated', 'ACCOUNT_AUTHENTICATED', 'account_authority', path, status)
    }
  }
  function resolveAuthEvidence(): AuthEvidence | null {
    const ranks: Record<AuthEvidence['reason'], number> = {
      ACCOUNT_AUTHENTICATED: 400,
      ACCOUNT_UNAUTHORIZED: 300,
      AUTH_CONTEXT_INCOMPLETE: 220,
      NETWORK_OR_TIMEOUT: 210,
      NON_JSON_RESPONSE: 200,
      ACCOUNT_CONTRACT_MISMATCH: 190,
      ENDPOINT_UNAVAILABLE: 180,
      CANDIDATE_REJECTED: 100,
    }
    let best: AuthEvidence | null = null
    for (const evidence of authEvidenceList) {
      if (!best || ranks[evidence.reason] > ranks[best.reason] ||
        (ranks[evidence.reason] === ranks[best.reason] && evidence.observedAt > best.observedAt)) best = evidence
    }
    return best
  }
  // A0：本次采集对余额接口的实测往返耗时（GPT P0-5：非纯延迟、非站点平均响应）
  let apiRoundTripMs: number | null = null
  const needsToken = !!(balanceEp?.needsToken)

  // 当日用量明细（usage_list）采集结果容器：提前声明，供 early-return 与最终返回共用
  let usageRecords: UsageRecord[] = []
  let usageRecordsComplete = false
  let usageRecordsTruncatedReason: string | null = null
  // 是否真正进入过 usage_list 采集（供 SW 区分「成功但空」与「未尝试」，GPT P1-scope）
  let usageCollected = false
  // 用量采集是否失败（请求/解析/分页异常）：失败时绝不当作「成功空日」覆盖历史批次（GPT P0-I2）
  let usageFailed = false
  // 页面世界实际使用的业务日（跨午夜时与 SW 的 now 可能不同，供 SW 落库对齐）
  let targetDay: string | null = null
  let selectedUsageListPath: string | null = null
  let selectedUsageListKind: 'hubway_v1' | 'generic' | null = null

  // ===== 诊断日志（脱敏指纹，P0-1/P0-4）=====
  const diags: Array<{
    phase: 'balance' | 'usage'
    url: string
    status: number
    contentType: string
    elapsedMs: number
    fieldFingerprint: Record<string, string>
    note: string
  }> = []

  /** 记录一次端点请求的脱敏诊断（仅字段路径/类型/状态码/耗时，不含值原文）。P0-4：url 仅留 pathname，剥离 query（防泄露敏感参数）。 */
  function recordDiag(phase: 'balance' | 'usage', url: string, status: number, contentType: string, elapsedMs: number, data: Record<string, unknown> | null, note: string) {
    let fp: Record<string, string> = {}
    if (data) {
      fp = {}
      for (const k of Object.keys(data)) fp[k] = typeof (data as any)[k]
    }
    const safeUrl = String(url).split('?')[0]
    diags.push({ phase, url: safeUrl, status, contentType, elapsedMs, fieldFingerprint: fp, note })
  }

  if (balanceEp && balanceEp.path) {
    // —— strategy 驱动：直接请求已知路径 ——
    const url = origin + balanceEp.path
    try {
      const t0 = performance.now()
      const { status, json, isJson } = await fetchJson(url)
      const dt = performance.now() - t0
      if (status === 401 || status === 403) {
        noteAuthFailure(balanceEp.path, status, json)
        recordDiag('balance', url, status, '', Math.round(dt), null, '401/403 未授权')
      } else if (status && status < 400 && isJson && json) {
        const data = unwrap(json)
        const account = extractAccountSnapshot(json)
        if (data && (ID_PATHS.some((p) => getPath(data, p) != null) || account)) {
          matchedPath = balanceEp.path
          dataObj = data
          accountSnapshotRaw = account ? json : null
          apiRoundTripMs = Math.round(dt)
          noteAccountSuccess(balanceEp.path, status)
          recordDiag('balance', url, status, isJson ? 'application/json' : '', Math.round(dt), data, '命中用户信息')
        } else {
          recordDiag('balance', url, status, isJson ? 'application/json' : '', Math.round(dt), data ?? null, '响应缺少用户标识字段')
        }
      } else {
        recordDiag('balance', url, status, isJson ? 'application/json' : '', Math.round(dt), null, `HTTP ${status} 或非 JSON`)
      }
    } catch (e) {
      recordDiag('balance', url, 0, '', 0, null, `网络错误: ${(e as Error).message}`)
    } /* 继续回退 */
  }

  // 若 strategy 路径失败，回退遍历 CANDIDATE_PATHS（与旧逻辑一致）
  if (!dataObj) {
    for (const path of CANDIDATES) {
      const url = origin + path
      try {
        const t0 = performance.now()
        const { status, json, isJson } = await fetchJson(url)
        const dt = performance.now() - t0
        if (status === 401 || status === 403) { noteAuthFailure(path, status, json); recordDiag('balance', url, status, '', Math.round(dt), null, '401/403 未授权'); continue }
        if (!status || status >= 400 || !isJson || !json) { recordDiag('balance', url, status || 0, isJson ? 'application/json' : '', Math.round(dt), null, `HTTP ${status ?? '?'} 或非 JSON`); continue }
        const wrapped = isRecord(json) && ('success' in json || 'data' in json)
        if (wrapped && (json as any).success === false) {
          // 非认证的 success:false（功能关闭/参数错误/不支持路径）属业务失败，不得判定登录失效（方案 027 §3.2）。
          if (isExplicitUnauthorized(json)) noteAuthFailure(path, status, json)
          recordDiag('balance', url, status, 'application/json', Math.round(dt), null, isExplicitUnauthorized(json) ? 'success:false 明确未授权' : 'success:false（业务失败，非认证）')
          continue
        }
        const data = unwrap(json)
        if (!data) { recordDiag('balance', url, status, 'application/json', Math.round(dt), null, '无法 unwrap 响应'); continue }
        const hasId = ID_PATHS.some((p) => getPath(data, p) != null)
        const account = extractAccountSnapshot(json)
        if (!hasId && !account) { recordDiag('balance', url, status, 'application/json', Math.round(dt), data, '缺少用户标识字段'); continue }
        matchedPath = path
        dataObj = data
        accountSnapshotRaw = account ? json : null
        apiRoundTripMs = Math.round(dt)
        noteAccountSuccess(path, status)
        recordDiag('balance', url, status, 'application/json', Math.round(dt), data, '回退命中')
        break
      } catch (e) {
        recordDiag('balance', url, 0, '', 0, null, `网络错误: ${(e as Error).message}`)
        continue
      }
    }
  }

  // IKunCode 只有 POST /api/user/auth/refresh 能返回账户快照时，必须在用户主动同步时受控调用。
  // 该调用不能放在 dataObj 失败后的 early return 之后，否则永远不会执行。
  if (!dataObj && manualCollect) {
    const refreshPath = '/api/user/auth/refresh'
    refreshAttempted = true
    const ref = await requestEndpoint({
      path: refreshPath,
      method: 'POST',
      // IKunCode 前端以 undefined body 调用 refresh；空 JSON body 会触发部分部署的参数校验。
      bodyTemplate: null,
      sideEffect: 'session_refresh',
      safeToAutoPoll: false,
    })
    if (ref.status >= 200 && ref.status < 400 && ref.isJson && (hasAuthBundle(ref.json) || extractAccountSnapshot(ref.json))) {
      dataObj = unwrapStats(ref.json) ?? ref.json
      accountSnapshotRaw = ref.json
      refreshSnapshotRaw = ref.json
      matchedPath = refreshPath
      apiRoundTripMs = ref.elapsedMs
      recordDiag(
        'balance',
        `${origin}${refreshPath}`,
        ref.status,
        'application/json',
        ref.elapsedMs,
        dataObj,
        hasAuthBundle(ref.json) ? 'POST refresh 认证 Bundle 成功' : 'POST refresh 命中账户快照',
      )
    } else {
      noteAuthFailure(refreshPath, ref.status, ref.json, 'refresh')
      recordDiag('balance', `${origin}${refreshPath}`, ref.status || 0, ref.isJson ? 'application/json' : '', ref.elapsedMs, null, 'POST refresh 未取得账户快照')
    }
  }

  const accountSnapshot = accountSnapshotRaw ? extractAccountSnapshot(accountSnapshotRaw) : dataObj ? extractAccountSnapshot(dataObj) : null
  // DoCode / New API 的 data.user.quota 是“当前可用额度”，而非“总额度”。
  // 必须在通用余额回退前读取 /api/status 的 quota_per_unit：此前把这一步放在
  // 可选 provider 阶段，任何用量采集异常都会让旧的 quota - used_quota 结果落库。
  let billingConfig: { quotaPerUnit: number | null; usdExchangeRate: number | null; customCurrencyExchangeRate: number | null } | null = null
  let docodeUnitUnavailable = false
  let isDoCodeOrigin = false
  try {
    const hostname = new URL(origin).hostname.toLowerCase()
    isDoCodeOrigin = hostname === 'docode.cc' || hostname.endsWith('.docode.cc')
  } catch { /* 无效 origin 仍按通用策略处理 */ }
  if (accountSnapshot) {
    const billingUrl = `${origin}/api/status`
    try {
      const t0 = performance.now()
      const { status, json, isJson } = await fetchJson(billingUrl)
      const elapsedMs = Math.round(performance.now() - t0)
      const root = isRecord(json) && isRecord((json as any).data) ? (json as any).data : json
      if (status >= 200 && status < 400 && isJson && isRecord(root)) {
        const quotaPerUnit = toFiniteNonNegative(getPath(root, 'quota_per_unit'))
        if (quotaPerUnit != null && quotaPerUnit > 0) {
          billingConfig = {
            quotaPerUnit,
            usdExchangeRate: toFiniteNonNegative(getPath(root, 'usd_exchange_rate')),
            customCurrencyExchangeRate: toFiniteNonNegative(getPath(root, 'custom_currency_exchange_rate')),
          }
          recordDiag('balance', billingUrl, status, 'application/json', elapsedMs, root, '余额单位配置已取得，将按 quota_per_unit 换算')
        } else {
          if (isDoCodeOrigin) docodeUnitUnavailable = true
          recordDiag('balance', billingUrl, status, 'application/json', elapsedMs, root, '余额单位配置缺少有效 quota_per_unit')
        }
      } else {
        if (isDoCodeOrigin) docodeUnitUnavailable = true
        recordDiag('balance', billingUrl, status || 0, isJson ? 'application/json' : '', elapsedMs, null, '余额单位配置请求失败')
      }
    } catch {
      if (isDoCodeOrigin) docodeUnitUnavailable = true
      recordDiag('balance', billingUrl, 0, '', 0, null, '余额单位配置网络错误')
    }
  }

  // 余额不是整轮采集的前置条件：Hubway 类站点可能没有标准用户接口，
  // 但统计接口仍可独立返回 today_actual_cost / total_tokens 等权威指标。
  // 用空对象承接后续解析，最终在所有 provider 请求完成后统一判断是否真的无数据。
  const balanceData = dataObj ?? {}
  let balance = findNumber(balanceData, ['balance', 'remain', 'remaining', 'available'])
  const used = findNumber(balanceData, USED_PATHS)
  if (balance == null && !(isDoCodeOrigin && accountSnapshot)) {
    const quota = findNumber(balanceData, ['quota', 'totalQuota', 'total_quota'])
    if (quota != null) balance = quota - (used ?? 0)
  }
  // 累计请求数（ikuncode 等「/api/user/self」明确返回；其余站点可能缺失→null，UI 显「—」）
  const totalRequests = findNumber(balanceData, [
    'request_count',
    'total_request_count',
    'totalRequestCount',
    'requestCount',
    'requests',
    'total_requests',
    'totalRequests',
    'consumed_requests',
  ])
  const rawKeys = Object.keys(balanceData)

  // A0：累计 Token（仅 token 命名字段，绝不取 quota/used_quota 额度，GPT P0-2）
  const cumulativeTokens = findNumber(balanceData, [
    'total_tokens', 'cumulative_tokens', 'total_token', 'consumed_tokens',
    'all_time_tokens', 'lifetime_tokens', 'totalTokens', 'cumulativeToken',
  ])
  const cumulativeTokensSource: 'dashboard' | null = cumulativeTokens != null ? 'dashboard' : null

  // A0：站点自报平均 API 响应（仅权威时间字段；秒级 <1000 视为秒→转 ms，GPT P0-5）
  let avgResponseTimeMs: number | null = null
  const rawAvg = findNumber(balanceData, [
    'avg_response', 'avg_response_time', 'average_response_time', 'avg_latency',
    'average_latency', 'avgResponseTime', 'avgResponse', 'averageResponse',
  ])
  if (rawAvg != null) avgResponseTimeMs = rawAvg < 1000 ? Math.round(rawAvg * 1000) : Math.round(rawAvg)

  const totalQuota = balance != null && used != null ? balance + used : null

  // ============= 今日用量（P0-3：唯一来自日志/聚合，禁余额差分）=============
  let todayTokens: number | null = null
  let todayRequests: number | null = null
  let todayCost: number | null = null
  let modelUsages: { model: string; tokens: number; cost: number }[] = []
  let usageSource: string | undefined
  let isPartial = false

  // Task #24：从用量端点也尝试提取累计Token和平均响应（很多 New API fork 把这些放在 /api/data/self）
  let usageCumulativeTokens: number | null = null
  let usageAvgResponseMs: number | null = null

  // ===== 统计接口 + IKunCode provider 采集状态（方案 §7）=====
  let dsTodayCost: number | null = null
  let dsCumulativeTokens: number | null = null
  let dsCumulativeInputTokens: number | null = null
  let dsCumulativeOutputTokens: number | null = null
  let dsAvgResponseTimeMs: number | null = null
  let ikTotalConsumedCost: number | null = null
  let ikTotalRequests: number | null = null
  let ruTodayCost: number | null = null
  let ruTodayTokens: number | null = null
  let ruTodayRequests: number | null = null
  let ruRecent24hCost: number | null = null
  let ruRecent24hTokens: number | null = null
  let unitAssumed = false
  let usageStatsSource: 'dashboard_stats' | 'account_snapshot' | 'range_usage' | null = null
  let todayCostSource: 'dashboard_stats' | 'range_usage' | 'logs' | null = null
  let usageWindowVal: 'calendar_day' | 'rolling_24h' | 'range' | null = null
  /** 从任意 JSON 对象中尝试提取累计 Token 和平均响应（与余额端点的提取逻辑一致）。 */
  function extractExtraMetrics(data: Record<string, unknown>) {
    if (usageCumulativeTokens == null) {
      const ct = findNumber(data, [
        'total_tokens', 'cumulative_tokens', 'total_token', 'consumed_tokens',
        'all_time_tokens', 'lifetime_tokens', 'totalTokens', 'cumulativeToken',
      ])
      if (ct != null) usageCumulativeTokens = ct
    }
    if (usageAvgResponseMs == null) {
      const avg = findNumber(data, [
        'avg_response', 'avg_response_time', 'average_response_time', 'avg_latency',
        'average_latency', 'avgResponseTime', 'avgResponse', 'averageResponse',
      ])
      if (avg != null) usageAvgResponseMs = avg < 1000 ? Math.round(avg * 1000) : Math.round(avg)
    }
  }

  /**
   * 今日使用金额提取（P0-2 红线：仅从金额/消耗字段，绝不编造）。
   * 优先明确货币字段 cost/amount/fee/spend/price；new-api 日志以 quota 记录消耗额度，
   * 其单位为「额度」需 /500000 换算为本币（new-api 标准 QuotaPerUnit）。
   * 无相关字段返回 null（UI 显「—」，不模拟）。
   */
  function extractCost(item: any): number | null {
    const direct = findNumber(item, ['cost', 'amount', 'fee', 'spend', 'price'])
    if (direct != null) return direct
    const quota = findNumber(item, ['quota'])
    if (quota != null) return quota / 500000
    return null
  }

  // ===== 统计接口 + IKunCode provider 解析/请求（方案 §4/§5/§7）=====
  // 全部自包含，不得引用本函数外部符号。

  /** 通用非负有限数字校验（方案 §5.1）：无效（NaN/Infinity/负数/空串/布尔/数组/对象）→ null，0 是合法值。 */
  function toFiniteNonNegative(v: any): number | null {
    if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null
    if (typeof v === 'string') {
      const s = v.trim()
      if (s === '') return null
      const n = Number(s.replace(/,/g, ''))
      return Number.isFinite(n) && n >= 0 ? n : null
    }
    return null
  }

  /** 从 localStorage 读取候选 Bearer token（仅本页面内存使用，绝不回传/落库，P0-2）。 */
  function readLocalToken(): string | null {
    return pageAuthContext.token
  }

  /** IKunCode 前端把会话 sid 持久化在 auth.session.sid；只在请求头内存中使用。 */
  function readAuthSessionSid(): string | null {
    try {
      function findSid(value: any, depth = 0): string | null {
        if (depth > 4 || !isRecord(value)) return null
        const session = (value as any).session
        if (isRecord(session) && typeof session.sid === 'string' && session.sid.length > 0) return session.sid
        for (const key of ['auth', 'state', 'data', 'user', 'store', 'session']) {
          const nested = findSid((value as any)[key], depth + 1)
          if (nested) return nested
        }
        return null
      }
      for (const storage of [localStorage, sessionStorage]) {
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i) || ''
          const raw = storage.getItem(key)
          if (!raw) continue
          try {
            const sid = findSid(JSON.parse(raw))
            if (sid) return sid
          } catch {
            /* ignore non-JSON storage values */
          }
        }
      }
    } catch {
      /* ignore storage access errors */
    }
    return null
  }

  /** 统一端点请求执行器（方案 §4.5）：支持 GET/POST、query 模板（URL API 写入）、JSON body、Cookie 凭证。 */
  async function requestEndpoint(ep: any): Promise<{ status: number; json: any; isJson: boolean; elapsedMs: number }> {
    let url: URL
    try {
      url = new URL(origin + ep.path)
    } catch {
      return { status: 0, json: null, isJson: false, elapsedMs: 0 }
    }
    if (ep.queryTemplate && isRecord(ep.queryTemplate)) {
      for (const k of Object.keys(ep.queryTemplate as Record<string, unknown>)) {
        url.searchParams.set(k, String((ep.queryTemplate as any)[k]))
      }
    }
    if (ep.role === 'range_usage') {
      const now = Date.now()
      const shanghaiNow = new Date(now + 480 * 60 * 1000)
      const startMs = Date.UTC(
        shanghaiNow.getUTCFullYear(),
        shanghaiNow.getUTCMonth(),
        shanghaiNow.getUTCDate(),
      ) - 480 * 60 * 1000
      url.searchParams.set('start_timestamp', String(Math.floor(startMs / 1000)))
      url.searchParams.set('end_timestamp', String(Math.floor(now / 1000)))
      url.searchParams.set('default_time', 'hour')
    }
    const method = ep.method === 'POST' ? 'POST' : 'GET'
    const headers: Record<string, string> = { ...pageAuthContext.headers }
    const lsToken = readLocalToken()
    const bearerToken = sessionAccessToken ?? lsToken
    if (bearerToken) headers['Authorization'] = 'Bearer ' + bearerToken
    const isSessionRefresh = ep.sideEffect === 'session_refresh' || ep.path === '/api/user/auth/refresh'
    const sessionSid = isSessionRefresh ? readAuthSessionSid() : null
    if (sessionSid) headers['X-Auth-Session'] = sessionSid
    let body: string | undefined
    if (method === 'POST' && ep.bodyTemplate && isRecord(ep.bodyTemplate)) {
      try {
        body = JSON.stringify(ep.bodyTemplate)
        headers['Content-Type'] = 'application/json'
      } catch {
        body = undefined
      }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 6000)
    const t0 = performance.now()
    try {
      const fetchOnce = async (requestHeaders: Record<string, string>) => {
        const res = await fetch(url.toString(), { credentials: 'include', method, headers: requestHeaders, body, signal: controller.signal })
        const ct = res.headers.get('content-type') || ''
        const isJson = ct.includes('json')
        let json: any = null
        if (isJson) {
          try {
            json = JSON.parse(await res.text())
          } catch {
            json = null
          }
        }
        return { status: res.status, json, isJson }
      }
      // refresh 优先使用当前页面的 HttpOnly Cookie；这是该端点的正常会话来源。
      // 如果站点版本实际要求 localStorage Bearer，再只补一次 Bearer 请求。
      const cookieHeaders = { ...headers }
      delete cookieHeaders.Authorization
      let result = await fetchOnce(isSessionRefresh ? cookieHeaders : headers)
      const error = isRecord(result.json) && isRecord(result.json.error) ? result.json.error : null
      const businessAuthFailure = isRecord(result.json) && (
        result.json.success === false ||
        result.json.code === 'AUTH_UNAUTHORIZED' ||
        result.json.code === 'UNAUTHORIZED' ||
        error?.code === 'AUTH_UNAUTHORIZED' ||
        error?.code === 'UNAUTHORIZED'
      )
      if ((result.status === 401 || result.status === 403 || businessAuthFailure) &&
        (bearerToken || isSessionRefresh) && pageAuthContext.provider !== 'new_api_user_object') {
        result = await fetchOnce(isSessionRefresh ? headers : cookieHeaders)
      }
      if (isSessionRefresh && result.status >= 200 && result.status < 400 && result.isJson) {
        const refreshedToken = extractAuthAccessToken(result.json)
        if (refreshedToken) sessionAccessToken = refreshedToken
      }
      return { ...result, elapsedMs: Math.round(performance.now() - t0) }
    } catch {
      return { status: 0, json: null, isJson: false, elapsedMs: Math.round(performance.now() - t0) }
    } finally {
      clearTimeout(timer)
    }
  }

  /** 解包统计/账户响应（方案 §4.4）：有限深度，不无限递归；success:false 立即拒绝。 */
  function unwrapStats(raw: any): any {
    if (!isRecord(raw)) return null
    const error = isRecord(raw.error) ? raw.error : null
    if (
      raw.success === false ||
      raw.code === 'AUTH_UNAUTHORIZED' ||
      raw.code === 'UNAUTHORIZED' ||
      error?.code === 'AUTH_UNAUTHORIZED' ||
      error?.code === 'UNAUTHORIZED'
    ) return null
    let obj: any = raw
    for (let depth = 0; depth < 5; depth++) {
      if (!isRecord(obj)) break
      const nestedError = isRecord(obj.error) ? obj.error : null
      if (
        obj.success === false ||
        obj.code === 'AUTH_UNAUTHORIZED' ||
        obj.code === 'UNAUTHORIZED' ||
        nestedError?.code === 'AUTH_UNAUTHORIZED' ||
        nestedError?.code === 'UNAUTHORIZED'
      ) return null
      let advanced = false
      for (const key of ['data', 'payload', 'response', 'result']) {
        if (isRecord(obj[key])) {
          obj = obj[key]
          advanced = true
          break
        }
      }
      if (!advanced) break
    }
    return obj
  }

  /** 在有限深度的常见 wrapper 中定位目标对象，兼容 data.data / data.stats 等站点变体。 */
  function findMetricObject(raw: any, keys: string[], depth = 0): Record<string, unknown> | null {
    if (depth > 5 || !isRecord(raw)) return null
    if (keys.some((key) => Object.prototype.hasOwnProperty.call(raw, key))) return raw
    for (const key of ['data', 'stats', 'summary', 'result', 'usage', 'payload', 'response']) {
      const nested = (raw as any)[key]
      const found = findMetricObject(nested, keys, depth + 1)
      if (found) return found
    }
    return null
  }

  /** 提取 Hubway 统计接口字段（方案 §5.2）：仅精确字段映射，不做额度换算/单位猜测。 */
  function extractDashboardStats(data: any): {
    todayCost: number | null
    cumulativeTokens: number | null
    cumulativeInputTokens: number | null
    cumulativeOutputTokens: number | null
    avgResponseTimeMs: number | null
  } | null {
    const metric = findMetricObject(data, [
      'today_actual_cost',
      'total_tokens',
      'total_input_tokens',
      'total_output_tokens',
      'average_duration_ms',
    ])
    if (!metric) return null
    const todayCost = toFiniteNonNegative(getPath(metric, 'today_actual_cost'))
    const cumulativeTokens = toFiniteNonNegative(getPath(metric, 'total_tokens'))
    const cumulativeInputTokens = toFiniteNonNegative(getPath(metric, 'total_input_tokens'))
    const cumulativeOutputTokens = toFiniteNonNegative(getPath(metric, 'total_output_tokens'))
    // average_duration_ms 已声明毫秒语义：直接存原始毫秒，不 /1000、不按大小猜测单位（方案 §1.2.5/§5.2）
    const avgRaw = toFiniteNonNegative(getPath(metric, 'average_duration_ms'))
    const avgResponseTimeMs = avgRaw != null ? Math.round(avgRaw) : null
    if (
      todayCost == null &&
      cumulativeTokens == null &&
      cumulativeInputTokens == null &&
      cumulativeOutputTokens == null &&
      avgResponseTimeMs == null
    ) {
      return null
    }
    return { todayCost, cumulativeTokens, cumulativeInputTokens, cumulativeOutputTokens, avgResponseTimeMs }
  }

  /** 提取 IKunCode 账户快照 data.user.*（方案 §5.5）：必须用嵌套路径，不依赖顶层模糊搜索。 */
  function extractAccountSnapshot(data: any): {
    balanceQuota: number | null
    consumedQuota: number | null
    lifetimeRequests: number | null
  } | null {
    const root = findMetricObject(data, ['user'])
    const nestedUser = root && isRecord(root.user) ? root.user : null
    // DoCode / New API 的当前响应是 { success, data: { id, quota, used_quota, ... } }，
    // 而不是旧的 { success, data: { user: {...} } }。仅当身份字段与完整账户字段同时存在时接纳直接对象。
    const direct = unwrapStats(data)
    const directUser = isRecord(direct) &&
      ['id', 'user_id', 'username', 'email'].some((key) => direct[key] !== undefined && direct[key] !== null) &&
      ['quota', 'used_quota', 'request_count'].some((key) => direct[key] !== undefined && direct[key] !== null)
      ? direct
      : null
    const user = nestedUser ?? directUser
    if (!isRecord(user)) return null
    const balanceQuota = toFiniteNonNegative(getPath(user, 'quota'))
    const consumedQuota = toFiniteNonNegative(getPath(user, 'used_quota'))
    const lifetimeRequests = toFiniteNonNegative(getPath(user, 'request_count'))
    if (balanceQuota == null && consumedQuota == null && lifetimeRequests == null) return null
    return { balanceQuota, consumedQuota, lifetimeRequests }
  }

  /**
   * IKunCode refresh 返回的是认证 Bundle，不应要求它同时携带额度字段。
   * 认证成功与账户指标完整是两个独立事实：前者用于判断登录态，后者只用于填充可用指标。
   */
  function hasAuthBundle(data: any): boolean {
    return isRecord(data) && data.success === true && findAuthBundleObject(data) != null
  }

  /** IKunCode refresh 的真实认证 Bundle；只接受完整结构，避免普通账户 JSON 被当作 Token 来源。 */
  function findAuthBundleObject(data: any, depth = 0): Record<string, unknown> | null {
    if (depth > 6 || !isRecord(data) || isBusinessAuthFailure(data)) return null
    const hasAccessToken = typeof data.access_token === 'string' && data.access_token.trim().length > 8
    const hasTokenType = typeof data.token_type === 'string' && data.token_type.trim().length > 0
    const hasAccessExpiry = data.access_expires_at !== undefined && data.access_expires_at !== null
    const user = isRecord(data.user) ? data.user : null
    const session = isRecord(data.session) ? data.session : null
    const hasUserIdentity = !!user &&
      user.id !== undefined && user.id !== null &&
      typeof user.username === 'string' && user.username.trim().length > 0 &&
      typeof user.role === 'string' && user.role.trim().length > 0
    const hasSessionIdentity = !!session &&
      typeof session.sid === 'string' && session.sid.trim().length > 0 &&
      session.current !== undefined && session.current !== null &&
      typeof session.login_method === 'string' && session.login_method.trim().length > 0 &&
      typeof session.ip === 'string' && session.ip.trim().length > 0 &&
      typeof session.user_agent === 'string' && session.user_agent.trim().length > 0 &&
      session.created_at !== undefined && session.created_at !== null &&
      session.last_active_at !== undefined && session.last_active_at !== null &&
      session.expires_at !== undefined && session.expires_at !== null
    if (hasAccessToken && hasTokenType && hasAccessExpiry && hasUserIdentity && hasSessionIdentity) return data
    for (const key of ['data', 'payload', 'response', 'result']) {
      const found = findAuthBundleObject((data as any)[key], depth + 1)
      if (found) return found
    }
    return null
  }

  function extractAuthAccessToken(data: any): string | null {
    const bundle = findAuthBundleObject(data)
    if (!bundle || typeof bundle.access_token !== 'string') return null
    const token = bundle.access_token.trim()
    if (token.length <= 8) return null
    return token.startsWith('Bearer ') ? token.slice(7).trim() : token
  }

  function parseTimestampMs(v: any): number | null {
    if (v == null) return null
    if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v
    const text = String(v).trim()
    if (!text) return null
    const numeric = Number(text.replace(/,/g, ''))
    if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric
    const parsed = Date.parse(text)
    return Number.isFinite(parsed) ? parsed : null
  }

  /** 提取 IKunCode 区间用量（方案 §5.5）：按记录白名单取 quota/token_used/count，分别累加。 */
  function extractRangeUsage(data: any, fromMs: number, toMs: number): {
    costSum: number | null
    tokenSum: number | null
    requestSum: number | null
  } | null {
    const root = unwrapStats(data)
    if (!root) return null
    const arr: any[] = findList(root) ?? []
    if (!Array.isArray(arr) || arr.length === 0) return null
    let costSum: number | null = null
    let tokenSum: number | null = null
    let requestSum: number | null = null
    for (const item of arr) {
      if (!isRecord(item)) continue
      // 服务端部分版本会返回近 24 小时或更宽窗口；created_at 存在时必须
      // 在客户端再次按 Asia/Shanghai 自然日边界过滤。
      const createdAt = parseTimestampMs(item.created_at ?? item.timestamp ?? item.time)
      // 方案 029 §5.3：无时间戳无法证明记录属上海自然日，不得计入「今日」（标记未验证）。
      if (createdAt == null) continue
      if (createdAt < fromMs || createdAt > toMs) continue
      const q = toFiniteNonNegative(getPath(item, 'quota'))
      const tk = toFiniteNonNegative(getPath(item, 'token_used') ?? getPath(item, 'total_tokens') ?? getPath(item, 'tokens'))
      const ct = toFiniteNonNegative(getPath(item, 'count'))
      if (q != null) costSum = (costSum ?? 0) + q
      if (tk != null) tokenSum = (tokenSum ?? 0) + tk
      if (ct != null) requestSum = (requestSum ?? 0) + ct
    }
    if (costSum == null && tokenSum == null && requestSum == null) return null
    return { costSum, tokenSum, requestSum }
  }

  /** quota → 本币金额转换（方案 §5.5/§3.4.3）：仅 unit=quota 时执行；缺失 quotaPerUnit 才用默认 500000 并标记 unitAssumed。 */
  function quotaToCurrency(
    quota: number | null,
    billing: { quotaPerUnit: number | null; usdExchangeRate: number | null; customCurrencyExchangeRate: number | null },
    targetCurrency: string,
  ): { value: number | null; unitAssumed: boolean } {
    if (quota == null) return { value: null, unitAssumed: false }
    let quotaPerUnit = billing.quotaPerUnit
    let unitAssumed = false
    if (quotaPerUnit == null || quotaPerUnit <= 0) {
      quotaPerUnit = 500000
      unitAssumed = true
    }
    let rate: number | null = null
    if (targetCurrency === 'USD') rate = 1
    else if (targetCurrency === 'CNY') rate = billing.usdExchangeRate
    else if (targetCurrency === 'CUSTOM') rate = billing.customCurrencyExchangeRate
    if (rate == null || rate < 0) return { value: null, unitAssumed }
    return { value: (quota / quotaPerUnit) * rate, unitAssumed }
  }

  try {
    // IKunCode 的区间接口按 Asia/Shanghai 自然日解释时间戳，不能依赖浏览器本地时区。
    const nowMs = Date.now()
    const shanghaiNow = new Date(nowMs + 480 * 60 * 1000)
    const shanghaiStartMs = Date.UTC(
      shanghaiNow.getUTCFullYear(),
      shanghaiNow.getUTCMonth(),
      shanghaiNow.getUTCDate(),
    ) - 480 * 60 * 1000
    const fromMs = shanghaiStartMs
    const toMs = nowMs
    const fromSec = Math.floor(fromMs / 1000)
    const toSec = Math.floor(toMs / 1000)

    // strategy 驱动：优先走 hourlyUsage，没命中则 raw_logs
    for (const ep of usageEps) {
      const source = ep.source as string | undefined
      if (source === 'hourly_aggregate') {
        // B 类 /api/data/self 小时聚合
        const uUrl = `${origin}${ep.path}?start_timestamp=${fromSec}&end_timestamp=${toSec}&default_time=hour`
        const ut0 = performance.now()
        const { status, json, isJson } = await fetchJson(uUrl)
        const uDt = performance.now() - ut0
        if (status && status < 400 && isJson && json) {
          const udata = unwrap(json)
          if (udata) {
            // Task #24：从用量端点补充指标
            extractExtraMetrics(udata)
            recordDiag('usage', uUrl, status, isJson ? 'application/json' : '', Math.round(uDt), udata, 'hourly_aggregate 响应')
            // 方案 029 §5.3：严格区间解析（仅 token_used/count + 上海自然日过滤），不复用宽松 extractUsage
            const ru = extractRangeUsage(udata, fromMs, toMs)
            if (ru && ru.tokenSum != null) {
              todayTokens = ru.tokenSum
              todayRequests = ru.requestSum
              // 今日使用金额：仅当响应含明确货币字段时展示，否则留 null（§4.4）
              const hc = findNumber(udata, ['total_cost', 'cost', 'amount', 'spend'])
              if (hc != null) todayCost = hc
              modelUsages = [{ model: '*', tokens: todayTokens, cost: todayCost ?? 0 }]
              usageSource = 'hourly_aggregate'
              break
            }
          } else {
            recordDiag('usage', uUrl, status, isJson ? 'application/json' : '', Math.round(uDt), null, '无法 unwrap')
          }
        } else {
          recordDiag('usage', uUrl, status || 0, isJson ? 'application/json' : '', Math.round(uDt), null, `HTTP ${status ?? '?'} 或非 JSON`)
        }
        // 小时聚合失败 → 继续降级链
        continue
      }

      if (source === 'raw_logs') {
        // A 类 /api/log/self 日志分页累加（P0-2 修正：不可仅抓第 1 页）
        const logResult = await (async function fetchUsageLogs() {
          // —— fetchUsageLogs 完全自包含 ——
          const MAX_PAGES = 5
          const MAX_ITEMS = 200
          let totalTokens = 0
          let totalReqs = 0
          let totalCost = 0
          let pageCount = 0
          let itemCount = 0
          const seen = new Set<string>()

          function logTs(item: any): number | null {
            const raw = item?.created_at ?? item?.timestamp ?? item?.created_at_unixtime ?? item?.time
            if (raw == null) return null
            if (typeof raw === 'number') return raw < 1e12 ? raw * 1000 : raw
            const numeric = Number(String(raw).replace(/,/g, '').trim())
            if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric
            const parsed = Date.parse(String(raw))
            return Number.isNaN(parsed) ? null : parsed
          }

          // 去重键：优先用 log.id，否则组合键
          function dedupKey(item: any): string | null {
            if (typeof item.id === 'number' || typeof item.id === 'string') return `id:${item.id}`
            const model = String(item.model_name ?? item.model ?? '')
            const ts = String(item.created_at ?? item.timestamp ?? '')
            const pt = String(item.prompt_tokens ?? item.input_tokens ?? '')
            const ct = String(item.completion_tokens ?? item.output_tokens ?? '')
            if (!model && !ts) return null // 无法去重，仍计入
            const tk = String(item.token_used ?? item.total_tokens ?? item.tokens ?? '')
            return `${model}|${ts}|${pt}|${ct}|${tk}`
          }

          for (let p = 0; p < MAX_PAGES; p++) {
            const lUrl = `${origin}${ep.path}?p=${p}&page_size=50&start_timestamp=${fromSec}&end_timestamp=${toSec}`
            const lt0 = performance.now()
            const { status, json, isJson: isJ } = await fetchJson(lUrl)
            const lDt = performance.now() - lt0
            if (!status || status >= 400 || !isJ || !json) { recordDiag('usage', lUrl, status || 0, '', Math.round(lDt), null, `日志分页 p=${p} 失败`); break }
            const d = unwrap(json)
            if (!d) { recordDiag('usage', lUrl, status, 'application/json', Math.round(lDt), null, `日志分页 p=${p} 无法 unwrap`); break }
            recordDiag('usage', lUrl, status, 'application/json', Math.round(lDt), d, `日志分页 p=${p}`)
            const arr: any[] = findList(d) ?? []
            if (arr.length === 0) break
            pageCount++

            // 检查最早日志是否早于今天零点（如是则停止分页）
            let earliestBeyondToday = false
            for (const item of arr) {
              if (!isRecord(item)) continue
              const ts = logTs(item)
              if (ts != null && ts < fromMs) {
                earliestBeyondToday = true
                break // 此条已越过今天，但同页后续可能还有今天的
              }
            }

            for (const item of arr) {
              if (!isRecord(item)) continue
              // 过滤：只累加模型调用日志（type=2 或 model_name 存在）
              const itemType = (item as any).type ?? (typeof (item as any).model_name === 'string' ? 2 : null)
              if (itemType !== 2 && typeof (item as any).model_name !== 'string') continue

              // 时间过滤：只算今天的
              const itemTs = logTs(item)
              if (itemTs != null && (itemTs < fromMs || itemTs > toMs)) continue

              // 去重
              const key = dedupKey(item)
              if (key && seen.has(key)) continue
              if (key) seen.add(key)

              const pt = toNumber((item as any).prompt_tokens ?? (item as any).input_tokens)
              const ct = toNumber((item as any).completion_tokens ?? (item as any).output_tokens)
              const tk = toNumber((item as any).token_used ?? (item as any).total_tokens ?? (item as any).tokens)
              const splitTokens = (!Number.isNaN(pt) ? pt : 0) + (!Number.isNaN(ct) ? ct : 0)
              totalTokens += splitTokens > 0 || Number.isNaN(tk) ? splitTokens : tk
              const c = extractCost(item)
              if (c != null) totalCost += c
              totalReqs++
              itemCount++
              if (itemCount >= MAX_ITEMS) break
            }
            if (itemCount >= MAX_ITEMS || earliestBeyondToday) break
          }

          return {
            todayTokens: totalTokens,
            todayRequests: totalReqs,
            todayCost: totalCost,
            partial: pageCount >= MAX_PAGES || itemCount >= MAX_ITEMS,
            source: 'raw_logs' as const,
          }
        })()

        if (logResult.todayTokens > 0 || logResult.todayRequests > 0 || logResult.todayCost > 0) {
          todayTokens = logResult.todayTokens
          todayRequests = logResult.todayRequests
          if (logResult.todayCost > 0) todayCost = logResult.todayCost
          isPartial = logResult.partial
          modelUsages = [{ model: '*', tokens: todayTokens, cost: logResult.todayCost }]
          usageSource = logResult.source
          break
        }
        // raw_logs 无数据 → 继续降级
        continue
      }
    }

    // 如果 strategy 的 usageEps 为空（旧调用路径兼容），回退遍历硬编码路径
    if (usageEps.length === 0) {
      const usagePaths = [
        { p: '/api/user/usage', q: `from=${fromMs}&to=${toMs}` },
        { p: '/api/v1/user/usage', q: `from=${fromMs}&to=${toMs}` },
        { p: '/api/usage', q: `from=${fromMs}&to=${toMs}` },
        { p: '/api/v1/usage', q: `from=${fromMs}&to=${toMs}` },
        { p: '/api/data/self', q: `start_timestamp=${fromSec}&end_timestamp=${toSec}&default_time=hour` },
      ]
      for (const { p, q } of usagePaths) {
        const uUrl = `${origin}${p}?${q}`
        const ut0 = performance.now()
        const { status, json, isJson } = await fetchJson(uUrl)
        const uDt = performance.now() - ut0
        if (status && status < 400 && isJson && json) {
          const udata = unwrap(json)
          if (!udata) { recordDiag('usage', uUrl, status, 'application/json', Math.round(uDt), null, '无法 unwrap'); continue }
          // Task #24：从回退用量端点也尝试补充指标
          extractExtraMetrics(udata)
          recordDiag('usage', uUrl, status, 'application/json', Math.round(uDt), udata, '回退用量路径')
          const usedArr = getPath(udata, 'used') ?? getPath(udata, 'data.used')
          const arr: number[] = Array.isArray(usedArr)
            ? (usedArr as unknown[]).map(toNumber).filter((n) => !Number.isNaN(n))
            : typeof usedArr === 'number' && !Number.isNaN(usedArr)
              ? [usedArr as number]
              : []
          if (arr.length > 0) {
            todayTokens = arr.reduce((s, v) => s + v, 0)
            usageSource = 'hourly_aggregate'
            break
          }
          const usage = extractUsage(udata)
          if (usage) {
            todayTokens = usage.tokens
            todayRequests = usage.requests
            usageSource = 'hourly_aggregate'
            break
          }
        } else {
          recordDiag('usage', uUrl, status || 0, isJson ? 'application/json' : '', Math.round(uDt), null, `HTTP ${status ?? '?'} 或非 JSON`)
        }
      }
    }

    // ===== 当日用量明细列表（usage_list）：采集 /api/v1/usage 等，供详情页「当日使用趋势」画图 =====
    // 完全自包含；仅白名单字段落账（P0-2）；按业务日过滤；分页读到终点或上限（P1：完整性）。
    const configuredUsageListEps = endpoints.filter((e: any) => e.role === 'usage_list' && e.path)
    const usageListCandidates = [...configuredUsageListEps]
    const candidatePaths = new Set(usageListCandidates.map((e: any) => e.path))
    for (const fallback of [
      { role: 'usage_list', endpointId: 'usageV1', path: '/api/v1/usage', usageListKind: 'hubway_v1' },
      { role: 'usage_list', endpointId: 'usageList', path: '/api/usage', usageListKind: 'generic' },
    ]) {
      if (!candidatePaths.has(fallback.path)) {
        usageListCandidates.push(fallback)
        candidatePaths.add(fallback.path)
      }
    }

    // 先探测候选接口，避免旧配置把第一个路径写死后直接放弃另一条可用路径。
    // 这里只判断 HTTP/JSON/列表结构，正式请求仍由下方统一分页和字段白名单解析。
    const probeUsageListArray = (raw: any): any[] | null => findList(unwrap(raw))
    const usageProbeDate = (kind: string): { target: string; end: string; offset: number } => {
      const offset = kind === 'hubway_v1' ? 480 : -(new Date().getTimezoneOffset())
      const fmt = (d: Date) => {
        const y = d.getUTCFullYear()
        const m = String(d.getUTCMonth() + 1).padStart(2, '0')
        const day = String(d.getUTCDate()).padStart(2, '0')
        return `${y}-${m}-${day}`
      }
      const target = fmt(new Date(Date.now() + offset * 60000))
      const end = fmt(new Date(Date.now() + 86400000 + offset * 60000))
      return { target, end, offset }
    }
    let usageListEp: any = null
    let firstValidUsageListEp: any = null
    for (const candidate of usageListCandidates) {
      const kind = candidate.usageListKind === 'hubway_v1' ? 'hubway_v1' : 'generic'
      const probeDate = usageProbeDate(kind)
      const q = kind === 'hubway_v1'
        ? `page=1&page_size=20&start_date=${probeDate.target}&end_date=${probeDate.end}&sort_by=created_at&sort_order=desc&timezone=Asia%2FShanghai`
        : 'page=1&page_size=50'
      try {
        const probe = await fetchJson(`${origin}${candidate.path}?${q}`)
        const list = probe.json ? probeUsageListArray(probe.json) : null
        if (probe.status >= 200 && probe.status < 300 && probe.isJson && list !== null) {
          firstValidUsageListEp ??= candidate
          // A reachable empty endpoint is valid, but prefer another candidate that
          // actually contains today's records when one is available.
          if (list.length > 0) {
            usageListEp = candidate
            break
          }
        }
      } catch {
        // 当前候选网络失败，继续尝试下一个路径。
      }
    }
    usageListEp ??= firstValidUsageListEp ?? usageListCandidates[0] ?? null
    if (usageListEp && usageListEp.path) {
      usageCollected = true
      const kind: 'hubway_v1' | 'generic' = usageListEp.usageListKind === 'hubway_v1' ? 'hubway_v1' : 'generic'
      selectedUsageListPath = usageListEp.path
      selectedUsageListKind = kind
      const MAX_PAGES = 5
      const MAX_ITEMS = 200
      // 业务日时区偏移（分钟）：hubway 固定 +8；未知回落浏览器本地
      const tzOffMin = kind === 'hubway_v1' ? 480 : -(new Date().getTimezoneOffset())
      const fmtDate = (d: Date) => {
        const y = d.getUTCFullYear()
        const m = String(d.getUTCMonth() + 1).padStart(2, '0')
        const day = String(d.getUTCDate()).padStart(2, '0')
        return `${y}-${m}-${day}`
      }
      const dayKeyOf = (ts: number) => fmtDate(new Date(ts + tzOffMin * 60000))
      targetDay = dayKeyOf(Date.now())
      const endDay = dayKeyOf(Date.now() + 86400000) // 多取一天，规避 end 独占/排他歧义，再客户端按业务日过滤
      const seenRec = new Set<string>()
      let recTotalTokens = 0
      let recTotalReqs = 0
      const recCostByCurrency: Record<string, number> = {}
      let recPageCount = 0
      let recItemCount = 0
      let recComplete = true
      let recTruncated: string | null = null
      const recList: UsageRecord[] = []

      // 时间字段解析（ms）
      function recTs(it: any): number | null {
        const raw = it?.created_at ?? it?.timestamp ?? it?.created_at_unixtime ?? it?.time
        if (raw == null) return null
        if (typeof raw === 'number') return raw < 1e12 ? raw * 1000 : raw
        const numeric = Number(String(raw).replace(/,/g, '').trim())
        if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric
        const n = Date.parse(String(raw))
        return Number.isNaN(n) ? null : n
      }
      function recModel(it: any): string {
        const m = it?.model_name ?? it?.model ?? it?.name ?? ''
        return String(m).slice(0, 64)
      }
      function recNum(it: any, keys: string[]): number | null {
        for (const k of keys) {
          const v = it?.[k]
          if (v != null && typeof v === 'number' && Number.isFinite(v)) return v
          if (v != null && typeof v === 'string') {
            const n = Number(v.replace(/,/g, ''))
            if (Number.isFinite(n)) return n
          }
        }
        return null
      }
      function recCost(it: any): number | null {
        const direct = recNum(it, ['cost', 'amount', 'fee', 'spend', 'price'])
        if (direct != null) return direct
        const quota = recNum(it, ['quota'])
        if (quota != null) return quota / 500000
        return null
      }
      function recHash(it: any): string {
        const ts = recTs(it)
        const model = recModel(it)
        const pt = recNum(it, ['prompt_tokens', 'input_tokens']) ?? 0
        const ct = recNum(it, ['completion_tokens', 'output_tokens']) ?? 0
        const tk = recNum(it, ['token_used', 'total_tokens', 'tokens']) ?? pt + ct
        const s = `${model}|${ts}|${pt}|${ct}|${tk}`
        let h = 0x811c9dc5
        for (let i = 0; i < s.length; i++) {
          h ^= s.charCodeAt(i)
          h = Math.imul(h, 0x01000193)
        }
        return (h >>> 0).toString(16)
      }

      // —— 假名化（P0-2 / GPT P0-MAIN-WORLD-KEY）：敏感原文绝不回传 SW，页面世界就地无密钥 SHA-256 ——
      // 命名空间只用页面自身 origin（非秘密）：按站点隔离假名，且任何扩展密钥都不进入不可信的 MAIN 世界。
      const pseudoSalt: string = typeof origin === 'string' && origin ? origin : ''

      /** 标准 SHA-256（hex）。无 WebCrypto（http 页面）时返回 null：敏感维度直接省略，而非降级为弱哈希。 */
      async function sha256Hex(s: string): Promise<string | null> {
        const subtle = (globalThis as any).crypto?.subtle
        if (!subtle) return null
        try {
          const buf = await subtle.digest('SHA-256', new TextEncoder().encode(s))
          const bytes = new Uint8Array(buf)
          let out = ''
          for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0')
          return out
        } catch {
          return null
        }
      }

      /**
       * 有限并发 SHA-256：同值只算一次（缓存），12 路并发 Promise.all，保持输入顺序。
       * 解决「每条记录串行 3 次 digest、200 条≈600 次串行 await」的采集卡顿（GPT P1-hash-perf）。
       * helper 全部留在 collectInPage 内（MAIN 世界自包含约束）。
       */
      async function sha256Many(inputs: string[]): Promise<(string | null)[]> {
        const cache = new Map<string, string | null>()
        const out: (string | null)[] = new Array(inputs.length)
        let cursor = 0
        const CONCURRENCY = 12
        async function worker(): Promise<void> {
          while (true) {
            const idx = cursor++
            if (idx >= inputs.length) return
            const input = inputs[idx]
            const cached = cache.get(input)
            if (cached !== undefined) {
              out[idx] = cached
              continue
            }
            const h = await sha256Hex(input)
            cache.set(input, h)
            out[idx] = h
          }
        }
        const workers: Promise<void>[] = []
        const n = Math.min(CONCURRENCY, inputs.length)
        for (let w = 0; w < n; w++) workers.push(worker())
        await Promise.all(workers)
        return out
      }

      /** 只保留 pathname，剔除 query/hash/host（避免密钥挂在 query 上被泄漏）。解析失败或非 http(s) 一律返回 null。 */
      function recEndpoint(it: any): string | null {
        const raw = it?.endpoint ?? it?.api_path ?? it?.path ?? it?.route ?? it?.url
        if (raw == null) return null
        const s = String(raw).trim()
        if (!s) return null
        try {
          const u = s.startsWith('http') ? new URL(s) : new URL(s, origin)
          if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
          const p = u.pathname
          return p && p.length ? p.slice(0, 128) : null
        } catch {
          return null
        }
      }
      function recStr(it: any, keys: string[], max: number): string | null {
        for (const k of keys) {
          const v = it?.[k]
          if (v == null) continue
          if (typeof v === 'string' && v.trim()) return v.trim().slice(0, max)
          if (typeof v === 'number' || typeof v === 'boolean') return String(v).slice(0, max)
        }
        return null
      }
      function recCurrency(it: any, keys: string[]): string | null {
        const c = recStr(it, keys, 8)
        return c ? c.toUpperCase() : null
      }

      for (let p = 1; p <= MAX_PAGES; p++) {
        let q = ''
        if (kind === 'hubway_v1') {
          q = `page=${p}&page_size=20&start_date=${targetDay}&end_date=${endDay}&sort_by=created_at&sort_order=desc&timezone=Asia%2FShanghai`
        } else {
          q = `page=${p}&page_size=50`
        }
        const rUrl = `${origin}${usageListEp.path}?${q}`
        const rt0 = performance.now()
        const { status, json, isJson } = await fetchJson(rUrl)
        const rDt = performance.now() - rt0
        if (!status || status >= 400 || !isJson || !json) {
          usageFailed = true
          recordDiag('usage', rUrl, status || 0, 'application/json', Math.round(rDt), null, `用量明细 p=${p} 失败`)
          break
        }
        if (isRecord(json) && (json as any).success === false) {
          usageFailed = true
          recordDiag('usage', rUrl, status, 'application/json', Math.round(rDt), null, `用量明细 p=${p} 业务失败`)
          break
        }
        const d: any = unwrap(json)
        if (!d) {
          usageFailed = true
          recordDiag('usage', rUrl, status, 'application/json', Math.round(rDt), null, `用量明细 p=${p} 无法 unwrap`)
          break
        }
        recordDiag('usage', rUrl, status, 'application/json', Math.round(rDt), d, `用量明细 p=${p}`)
        // 兼容多种包裹形态：items / data.items / list / data.list
        const arr: any[] | null = findList(d)
        if (arr === null) {
          usageFailed = true
          recordDiag('usage', rUrl, status, 'application/json', Math.round(rDt), d, `用量明细 p=${p} 响应格式不支持`)
          break
        }
        if (arr.length === 0) break
        recPageCount++
        // 仅在 hubway_v1 适配器下采用服务端请求日志主键；通用站点一律用内容指纹，
        // 避免把 user/token/model 等 id 误当请求主键导致去重漏数（GPT P1-record-id）。
        const idKeys: string[] | null = kind === 'hubway_v1' ? ['id', 'request_id', 'log_id', 'trace_id', 'uuid'] : null

        // ── 步骤 1：同步提取候选 + 待哈希原文（不触网、不串行 await） ──
        interface Cand {
          raw: any
          ts: number
          recHashVal: string
          rawId: string | null
          rawKey: string | null
          rawIp: string | null
          apiKeyLabel: string | null
          pt: number
          ct: number
          tk: number
          cost: number | null
          costCurrency: string
          endpoint: string | null
          group: string | null
          type: string | null
          norm: string
          hubway: {
            cacheReadTokens: number | null
            cacheCreationTokens: number | null
            actualCost: number | null
            actualCostCurrency: string | null
            standardCost: number | null
            standardCostCurrency: string | null
            reasoningEffort: string | null
            billingMode: string | null
          } | null
        }
        const cands: Cand[] = []
        for (const item of arr) {
          if (!isRecord(item)) continue
          const ts = recTs(item)
          if (ts == null) continue
          // 业务日过滤：仅保留命中目标业务日的记录
          if (dayKeyOf(ts) !== targetDay) continue
          const pt = recNum(item, ['prompt_tokens', 'input_tokens']) ?? 0
          const ct = recNum(item, ['completion_tokens', 'output_tokens']) ?? 0
          // token 口径固定为 输入+输出（GPT P1-tokens）：服务端 total_tokens 可能含缓存/推理等计费 token，
          // 与看板指标单列 cache token 的口径冲突；统一以 prompt+completion 为准。
          const tk = recNum(item, ['token_used', 'total_tokens', 'tokens']) ?? pt + ct
          if (tk <= 0 && item.model_name == null && item.model == null) continue
          const cost = recCost(item)
          // 跨币种防护（GPT P0-cost-currency）：普通 cost 也要按记录自身币种归属，绝不统一标策略币种后相加。
          const costCurrency = cost != null ? recCurrency(item, ['cost_currency', 'currency']) ?? stratCurrency : stratCurrency
          // 规范化内容串：用于强内容指纹（SHA-256）作主键，避免 32 位弱指纹碰撞漏数（GPT P1-weak-hash）
          // 规范化内容串：结构化 JSON 编码所有影响行语义/筛选/聚合的字段（含 group/type/缓存 token/计费模式/密钥哈希输入），
          // 杜绝分隔符拼接导致的歧义与维度缺失（GPT P1-weak-norm）。仅作 SHA-256 内容指纹输入，绝不以原文落库。
          const norm = JSON.stringify({
            m: recModel(item),
            ts,
            pt,
            ct,
            tk,
            c: cost ?? null,
            cur: costCurrency,
            ep: recEndpoint(item) ?? null,
            key: recStr(item, ['api_key', 'key', 'token'], 128),
            grp: recStr(item, ['group', 'group_name', 'user_group'], 64),
            typ: recStr(item, ['type', 'log_type', 'request_type'], 32),
            cR: recNum(item, ['cache_read_input_tokens', 'cache_read_tokens', 'cached_tokens']),
            cW: recNum(item, ['cache_creation_input_tokens', 'cache_creation_tokens', 'cache_write_tokens']),
            bm: recStr(item, ['billing_mode', 'billingMode'], 32),
            re: recStr(item, ['reasoning_effort', 'reasoning'], 16),
          })
          cands.push({
            raw: item,
            ts,
            recHashVal: recHash(item),
            rawId: idKeys ? recStr(item, idKeys, 128) : null,
            // 仅对明确的密钥字段做假名化；token_name 等可读标签单独保留（见 apiKeyLabel，GPT P1-token-name）
            rawKey: recStr(item, ['api_key', 'key', 'token'], 128),
            rawIp: recStr(item, ['ip', 'client_ip', 'remote_ip'], 64),
            // GPT P0-I1：绝不回传 token_name/apiKeyName/key_name 等「疑似可读标签」——通用分类器面对不受信的
            // 接口响应，这些字段名不能证明值一定非敏感（服务端完全可能把真实 Token/Key 放在其中）。
            // 只保留页面内派生的不可逆假标识 apiKeyId（哈希），标签一律置 null；如需标签展示，
            // 只能为契约确认的专用适配器单独增加字段并做严格白名单。
            apiKeyLabel: null,
            pt,
            ct,
            tk,
            cost,
            costCurrency,
            endpoint: recEndpoint(item),
            group: recStr(item, ['group', 'group_name', 'user_group'], 64),
            type: recStr(item, ['type', 'log_type', 'request_type'], 32),
            norm,
            hubway:
              kind === 'hubway_v1'
                ? {
                    cacheReadTokens: recNum(item, ['cache_read_input_tokens', 'cache_read_tokens', 'cached_tokens']),
                    cacheCreationTokens: recNum(item, ['cache_creation_input_tokens', 'cache_creation_tokens', 'cache_write_tokens']),
                    actualCost: recNum(item, ['actual_cost', 'real_cost', 'charged_cost']),
                    actualCostCurrency:
                      recNum(item, ['actual_cost', 'real_cost', 'charged_cost']) != null
                        ? recCurrency(item, ['actual_cost_currency', 'currency']) ?? stratCurrency
                        : null,
                    standardCost: recNum(item, ['standard_cost', 'origin_cost', 'list_cost']),
                    standardCostCurrency:
                      recNum(item, ['standard_cost', 'origin_cost', 'list_cost']) != null
                        ? recCurrency(item, ['standard_cost_currency', 'currency']) ?? stratCurrency
                        : null,
                    reasoningEffort: recStr(item, ['reasoning_effort', 'reasoning'], 16),
                    billingMode: recStr(item, ['billing_mode', 'billing_type', 'charge_mode'], 32),
                  }
                : null,
          })
        }

        // ── 步骤 2：有限并发哈希（同值缓存；无 WebCrypto 时敏感维度返回 null → 降级省略） ──
        const jobIndex = new Map<string, number>()
        const jobInputs: string[] = []
        const need = (input: string): number => {
          let idx = jobIndex.get(input)
          if (idx === undefined) {
            idx = jobInputs.length
            jobInputs.push(input)
            jobIndex.set(input, idx)
          }
          return idx
        }
        const cRid: (number | null)[] = cands.map((c) => (c.rawId ? need(pseudoSalt + '|rid|' + c.rawId) : null))
        const cKey: (number | null)[] = cands.map((c) => (c.rawKey ? need(pseudoSalt + '|k|' + c.rawKey) : null))
        const cIp: (number | null)[] = cands.map((c) => (c.rawIp ? need(pseudoSalt + '|ip|' + c.rawIp) : null))
        // 强内容指纹：规范化字段 SHA-256（无 WebCrypto 时返回 null，fallback 到 FNV 32 位）
        const cHash: (number | null)[] = cands.map((c) => need(pseudoSalt + '|h|' + c.norm))
        const jobResults = await sha256Many(jobInputs)

        // ── 步骤 3：组装落库（保持顺序；按 (siteId, 业务日) 去重；累计） ──
        for (let ci = 0; ci < cands.length; ci++) {
          const c = cands[ci]
          const ridH = cRid[ci] != null ? jobResults[cRid[ci] as number] : null
          const keyH = cKey[ci] != null ? jobResults[cKey[ci] as number] : null
          const ipH = cIp[ci] != null ? jobResults[cIp[ci] as number] : null
          const hashH = cHash[ci] != null ? jobResults[cHash[ci] as number] : null
          // 主键：hubway 用服务端主键（再哈希防明文）；通用站点用强内容指纹 SHA-256。
          // 任一哈希在无 WebCrypto 时回退 FNV 32 位（弱，仅 http 页面降级，可接受的隐私权衡）。
          const key =
            c.rawId
              ? 'r_' + (ridH ? ridH.slice(0, 24) : hashH ? hashH.slice(0, 32) : c.recHashVal)
              : 'h_' + (hashH ? hashH.slice(0, 32) : c.recHashVal)
          if (seenRec.has(key)) continue
          seenRec.add(key)
          const apiKeyId = keyH ? 'k_' + keyH.slice(0, 16) : null
          const ipHash = ipH ? 'ip_' + ipH.slice(0, 16) : null

          const rec: UsageRecord = {
            id: key,
            ts: c.ts,
            model: recModel(c.raw),
            promptTokens: c.pt,
            completionTokens: c.ct,
            tokens: c.tk,
            cacheReadTokens: c.hubway?.cacheReadTokens ?? null,
            cacheCreationTokens: c.hubway?.cacheCreationTokens ?? null,
            cost: c.cost,
            actualCost: c.hubway?.actualCost ?? null,
            actualCostCurrency: c.hubway?.actualCostCurrency ?? null,
            standardCost: c.hubway?.standardCost ?? null,
            standardCostCurrency: c.hubway?.standardCostCurrency ?? null,
            costCurrency: c.costCurrency,
            endpoint: c.endpoint,
            apiKeyId,
            apiKeyLabel: c.apiKeyLabel,
            ipHash,
            reasoningEffort: c.hubway?.reasoningEffort ?? null,
            group: c.group,
            type: c.type,
            billingMode: c.hubway?.billingMode ?? null,
          }
          recList.push(rec)
          recTotalTokens += c.tk
          recTotalReqs++
          // 跨币种防护（GPT P1-cross-currency）：按记录自身币种累加，绝不归入策略币种
          if (c.cost != null) recCostByCurrency[c.costCurrency] = (recCostByCurrency[c.costCurrency] || 0) + c.cost
          recItemCount++
          if (recItemCount >= MAX_ITEMS) break
        }
        if (recItemCount >= MAX_ITEMS) {
          recComplete = false
          recTruncated = `明细超 ${MAX_ITEMS} 条上限，已截断`
          break
        }

        // 分页完整性：hubway 读 has_more/total；其余以「本页满页」判断可能还有下一页
        let more = true
        if (kind === 'hubway_v1') {
          const total = recNum(d, ['total', 'data.total', 'data.data.total'])
          const hasMore = d.has_more ?? d.data?.has_more ?? d.data?.data?.has_more
          more = hasMore === true || (total != null && recList.length < total)
        } else {
          more = arr.length >= 50
        }
        if (!more) break
      }
      recList.sort((a, b) => a.ts - b.ts) // 升序，便于画图
      usageRecords = recList
      usageRecordsComplete = recComplete
      usageRecordsTruncatedReason = recTruncated
      // 透出聚合值：未从其它用量端点获得今日用量时，用明细汇总回填（丰富概览）
      if (recList.length > 0) {
        todayTokens = todayTokens ?? recTotalTokens
        todayRequests = todayRequests ?? recTotalReqs
        if (recCostByCurrency[stratCurrency] != null) todayCost = todayCost ?? recCostByCurrency[stratCurrency]
        usageSource = usageSource ?? 'usage_list'
      }
    }

    // ===== 统计接口 + IKunCode provider 采集（方案 §4/§7）=====
    // 独立于余额/明细；任一端点失败都不阻断其它，也不覆盖已取得的指标。
    const statsEps = endpoints.filter((e: any) => {
      const isSessionRefresh = e.sideEffect === 'session_refresh' || e.path === '/api/user/auth/refresh'
      const isProvider = e.role === 'usage_stats' || e.role === 'account_snapshot' || e.role === 'range_usage' || e.role === 'billing_config'
      // 余额主链路已读取到单位时，不重复请求 /api/status；这也避免后置 provider 覆盖已验证结果。
      if (e.role === 'billing_config' && billingConfig?.quotaPerUnit != null) return false
      // refresh 会轮换会话并可能改变服务端状态，只能由用户主动同步触发。
      return isProvider && (manualCollect || !isSessionRefresh)
    })
    // billing 配置必须先于账户/区间 provider，确保 quota 使用站点实际单位和汇率转换。
    const orderedStatsEps = [...statsEps].sort((a: any, b: any) => {
      const rank = (role: string) => role === 'billing_config' ? 0 : role === 'account_snapshot' ? 1 : role === 'range_usage' ? 2 : 3
      return rank(a.role) - rank(b.role)
    })
    for (const ep of orderedStatsEps) {
      try {
        const { status, json, isJson, elapsedMs } = await requestEndpoint(ep)
        if (ep.role === 'usage_stats') {
          if (status >= 200 && status < 400 && isJson && json) {
            const data = unwrapStats(json)
            if (data) {
              recordDiag('usage', `${origin}${ep.path}`, status, 'application/json', elapsedMs, data, 'usage_stats 响应')
              const r = extractDashboardStats(data)
              if (r) {
                dsTodayCost = r.todayCost
                dsCumulativeTokens = r.cumulativeTokens
                dsCumulativeInputTokens = r.cumulativeInputTokens
                dsCumulativeOutputTokens = r.cumulativeOutputTokens
                dsAvgResponseTimeMs = r.avgResponseTimeMs
                usageStatsSource = 'dashboard_stats'
                if (r.todayCost != null) usageWindowVal = 'calendar_day'
              } else {
                isPartial = true
              }
            } else {
              recordDiag('usage', `${origin}${ep.path}`, status, 'application/json', elapsedMs, null, 'usage_stats 无法 unwrap')
              isPartial = true
            }
          } else {
            recordDiag('usage', `${origin}${ep.path}`, status || 0, isJson ? 'application/json' : '', elapsedMs, null, `usage_stats HTTP ${status ?? '?'} 或非 JSON`)
            isPartial = true
          }
        } else if (ep.role === 'account_snapshot') {
          let parsed: any = null
          if (status >= 200 && status < 400 && isJson && json) {
            parsed = json
          }
          if ((!parsed || !extractAccountSnapshot(parsed)) && refreshSnapshotRaw) parsed = refreshSnapshotRaw
          // 账户快照优先用 GET 用户接口；缺失必要字段且为受控手动流程时，再尝试 POST refresh（有副作用，方案 §4.6）
          if ((!parsed || !extractAccountSnapshot(parsed)) && manualCollect && !refreshAttempted) {
            refreshAttempted = true
            try {
              const ref = await requestEndpoint({ ...ep, path: '/api/user/auth/refresh', method: 'POST', bodyTemplate: null })
              if (ref.status >= 200 && ref.status < 400 && ref.isJson && (hasAuthBundle(ref.json) || extractAccountSnapshot(ref.json))) {
                parsed = ref.json
                refreshSnapshotRaw = ref.json
              }
            } catch { /* refresh 失败不阻断 */ }
          }
          if (parsed) {
            const snap = extractAccountSnapshot(parsed)
            if (snap) {
              if (snap.consumedQuota != null) {
                const conv = quotaToCurrency(snap.consumedQuota, billingConfig ?? { quotaPerUnit: null, usdExchangeRate: null, customCurrencyExchangeRate: null }, stratCurrency)
                ikTotalConsumedCost = conv.value
                if (conv.unitAssumed) unitAssumed = true
              }
              ikTotalRequests = snap.lifetimeRequests
              noteAccountSuccess(ep.path, status)
              usageStatsSource = usageStatsSource ?? 'account_snapshot'
            }
          }
        } else if (ep.role === 'range_usage') {
          if (status >= 200 && status < 400 && isJson && json) {
            const ru = extractRangeUsage(json, fromMs, toMs)
            if (ru) {
              ruTodayCost = ru.costSum
              ruTodayTokens = ru.tokenSum
              ruTodayRequests = ru.requestSum
              // 自然日口径：页面已按 Asia/Shanghai 自然日过滤；rolling 24h 由同一接口另一窗口产生，此处不覆盖
              usageWindowVal = usageWindowVal ?? 'calendar_day'
            }
          }
        } else if (ep.role === 'billing_config') {
          if (status >= 200 && status < 400 && isJson && json) {
            const root = isRecord(json) && isRecord((json as any).data) ? (json as any).data : json
            if (isRecord(root)) {
              billingConfig = {
                quotaPerUnit: toFiniteNonNegative(getPath(root, 'quota_per_unit')),
                usdExchangeRate: toFiniteNonNegative(getPath(root, 'usd_exchange_rate')),
                customCurrencyExchangeRate: toFiniteNonNegative(getPath(root, 'custom_currency_exchange_rate')),
              }
            }
          }
        }
      } catch {
        isPartial = true
      }
    }
  } catch {
    // 用量接口可选，不影响余额采集；但须标记采集失败，避免把「空结果」误当「成功空日」覆盖历史批次（GPT P0-I2）
    usageFailed = true
  }

  // 所有独立 provider 都完成后再判定整轮失败。
  // 余额接口未命中不应吞掉 Hubway 统计接口已取得的指标。
  const resolvedAuthEvidence = resolveAuthEvidence()
  const resolvedAuthState: AuthState = resolvedAuthEvidence?.state ?? 'indeterminate'
  authExpired = resolvedAuthState === 'unauthorized'
  const hasAnyMetric =
    balance != null ||
    used != null ||
    totalRequests != null ||
    accountSnapshot != null ||
    todayTokens != null ||
    todayRequests != null ||
    todayCost != null ||
    usageCumulativeTokens != null ||
    dsTodayCost != null ||
    dsCumulativeTokens != null ||
    dsCumulativeInputTokens != null ||
    dsCumulativeOutputTokens != null ||
    dsAvgResponseTimeMs != null ||
    ikTotalConsumedCost != null ||
    ikTotalRequests != null ||
    ruTodayCost != null ||
    ruTodayTokens != null ||
    ruTodayRequests != null ||
    usageRecords.length > 0
  if (!hasAnyMetric) {
    return {
      ok: false,
      reason: authExpired
        ? '登录态失效（权威账户端点明确未授权）'
        : resolvedAuthEvidence?.reason === 'AUTH_CONTEXT_INCOMPLETE'
          ? '未取得 DoCode 请求上下文，请保持控制台登录后重新检测'
          : '未取得任何可用站点指标',
      authExpired,
      authState: resolvedAuthState,
      authEvidence: resolvedAuthEvidence,
      authContext: pageAuthContext.authContext,
      cookiePresent,
      cookieNames,
      localStorageKeys,
      sessionStorageKeys,
      balance: null,
      used: null,
      totalQuota: null,
      totalRequests: null,
      currency: null,
      todayTokens: null,
      todayRequests: null,
      modelUsages: [],
      path: matchedPath,
      rawKeys,
      cumulativeTokens: null,
      cumulativeTokensSource: null,
      apiRoundTripMs,
      avgResponseTimeMs,
      todayCost: null,
      diags,
      usageRecords,
      usageRecordsComplete,
      usageRecordsTruncatedReason,
      usageCollected,
      usageFailed,
      cumulativeInputTokens: null,
      cumulativeOutputTokens: null,
      totalConsumedCost: null,
      recent24hCost: null,
      recent24hTokens: null,
      usageWindow: null,
      todayCostSource: null,
      usageStatsSource: null,
    }
  }

  // Task #24：若余额端点未拿到累计Token/平均响应，但用量端点拿到了 → 回填
  // 统计接口（dashboard_stats）优先：其 total_tokens 是权威累计值，不得被输入+输出相加或今日 Token 覆盖。
  const finalCumulativeTokens = dsCumulativeTokens ?? cumulativeTokens ?? usageCumulativeTokens
  const finalCumulativeTokensSource = dsCumulativeTokens != null ? ('dashboard' as const)
    : cumulativeTokens != null ? cumulativeTokensSource
    : usageCumulativeTokens != null ? ('dashboard' as const) : null
  const finalAvgResponseMs = dsAvgResponseTimeMs ?? avgResponseTimeMs ?? usageAvgResponseMs

  // 今日金额：统计接口 today_actual_cost 优先（dashboard_stats 权威），否则沿用日志口径（方案 §7.3）
  const rangeTodayCost = ruTodayCost != null
    ? quotaToCurrency(
        ruTodayCost,
        billingConfig ?? { quotaPerUnit: null, usdExchangeRate: null, customCurrencyExchangeRate: null },
        stratCurrency,
      ).value
    : null
  const finalTodayCost = dsTodayCost ?? rangeTodayCost ?? todayCost
  const finalTodayCostSource: 'dashboard_stats' | 'range_usage' | 'logs' | null = dsTodayCost != null
    ? 'dashboard_stats'
    : rangeTodayCost != null
      ? 'range_usage'
      : todayCost != null
        ? 'logs'
        : null
  // 区间用量（IKunCode 自然日）作为今日兜底；累计请求数取账户快照 lifetime
  const finalTodayTokens = todayTokens ?? ruTodayTokens
  const finalTodayRequests = todayRequests ?? ruTodayRequests
  const finalTotalRequests = ikTotalRequests ?? totalRequests
  // DoCode 等站点的 data.user.quota 与 used_quota 是整数额度，不是美元金额。
  // 当同轮同时取得嵌套账户快照与 /api/status.quota_per_unit 时，结构化证据已足够，
  // 不再依赖 family（旧发现结果可能把 DoCode 标成 one-api-compatible 或 unknown）。
  const inferredAccountSemantics: AccountSemantics | null =
    accountSnapshot?.balanceQuota != null &&
    billingConfig?.quotaPerUnit != null &&
    billingConfig.quotaPerUnit > 0
      ? 'current_balance_and_historical_consumed'
      : null
  // 本轮取得的 quota_per_unit 是比历史发现标签更强的新证据；优先使用它以修正旧版本持久化的分类。
  const resolvedAccountSemantics = inferredAccountSemantics ?? strategyAccountSemantics
  const applyContract =
    resolvedAccountSemantics === 'current_balance_and_historical_consumed' &&
    accountSnapshot != null &&
    billingConfig != null
  const accountBalance = applyContract
    ? quotaToCurrency(accountSnapshot.balanceQuota, billingConfig!, stratCurrency).value
    : null
  const accountConsumed = applyContract
    ? quotaToCurrency(accountSnapshot.consumedQuota, billingConfig!, stratCurrency).value
    : null
  const accountTotalQuota = applyContract && accountSnapshot.balanceQuota != null && accountSnapshot.consumedQuota != null
    ? quotaToCurrency(accountSnapshot.balanceQuota + accountSnapshot.consumedQuota, billingConfig!, stratCurrency).value
    : null
  const accountRequests = applyContract ? accountSnapshot.lifetimeRequests : null

  return {
    ok: true,
    reason: '',
    authExpired: false,
    authState: resolvedAuthState,
    authEvidence: resolvedAuthEvidence,
    authContext: pageAuthContext.authContext,
    cookiePresent,
    cookieNames,
    localStorageKeys,
    sessionStorageKeys,
    // 只有已验证的账户语义契约才允许把 quota 按货币单位换算；其余站点仍走原有余额字段，
    // 防止某个同名 quota 字段在缺少 quota_per_unit 时被猜测性换算。
    // 对 DoCode，若同轮没取得 quota_per_unit，宁可留空也绝不回退为 quota - used_quota。
    balance: docodeUnitUnavailable ? null : accountBalance ?? balance,
    used: docodeUnitUnavailable ? null : accountConsumed ?? used,
    totalQuota: accountTotalQuota != null
      ? accountTotalQuota
      : totalQuota,
    totalRequests: accountRequests != null ? accountRequests : finalTotalRequests,
    currency: stratCurrency,
    todayTokens: finalTodayTokens,
    todayRequests: finalTodayRequests,
    modelUsages,
    path: matchedPath,
    rawKeys,
    usageSource: usageSource ?? (finalTodayTokens == null ? 'unavailable' : undefined),
    usageCollected,
    usageFailed,
    usageListDay: targetDay,
    usageListPath: selectedUsageListPath,
    usageListKind: selectedUsageListKind,
    isPartial: isPartial || undefined,
    collectorVersion: collectorVersion || undefined,
    accountSemantics: resolvedAccountSemantics,
    cumulativeTokens: finalCumulativeTokens,
    cumulativeTokensSource: finalCumulativeTokensSource,
    apiRoundTripMs,
    avgResponseTimeMs: finalAvgResponseMs,
    todayCost: finalTodayCost ?? null,
    metricsPartial: isPartial || undefined,
    // 统计接口 + IKunCode provider 字段（方案 §7）
    cumulativeInputTokens: dsCumulativeInputTokens,
    cumulativeOutputTokens: dsCumulativeOutputTokens,
    totalConsumedCost: accountConsumed != null ? accountConsumed : ikTotalConsumedCost,
    recent24hCost: ruRecent24hCost,
    recent24hTokens: ruRecent24hTokens,
    usageWindow: usageWindowVal,
    todayCostSource: finalTodayCostSource,
    usageStatsSource,
    diags,
    usageRecords,
    usageRecordsComplete,
    usageRecordsTruncatedReason,
  }
}

/**
 * 页面主世界的「会话探测」（供 AUTHORIZE/TEST 使用）。
 * 与 collectInPage 不同，它只确认「是否存在返回用户信息的接口」，不要求余额字段。
 * 完全自包含，且只能通过页面真实 Cookie 鉴权（SW 无法替代）。
 */
export interface SessionProbeResult {
  ok: boolean
  reason: string
  authExpired: boolean
  authState: AuthState
  authEvidence: AuthEvidence | null
  cookiePresent: boolean
  cookieNames: string[]
  localStorageKeys: string[]
  sessionStorageKeys: string[]
  status: number | null
  path: string | null
}

export async function probeSessionInPage(
  origin: string,
  discoveredPath: string | null,
  allowRefresh = false,
): Promise<SessionProbeResult> {
  // —— 以下全部自包含 ——
  const ID_PATHS = ['id', 'user_id', 'userId', 'username', 'email']
  const CANDIDATE_PATHS = [
    '/api/v1/auth/me',
    '/api/user/self',
    '/api/user',
    '/api/user/info',
    '/api/v1/user',
    '/api/user/dashboard',
    '/api/user/profile',
    '/api/self',
    '/api/me',
    '/user/api/self',
    '/api/user/status',
    '/api/v1/user/self',
    '/api/v1/me',
    '/api/profile',
    '/api/account',
    '/api/account/info',
    '/api/auth/me',
    '/api/session',
    '/api/user/session',
    '/api/user/token',
    '/api/token',
    '/api/index/user',
  ]
  const CANDIDATES = (discoveredPath ? [discoveredPath] : []).concat(CANDIDATE_PATHS)

  function getPath(obj: any, path: string): any {
    return path.split('.').reduce((o: any, k: string) => (o && typeof o === 'object' ? o[k] : undefined), obj)
  }
  function isRecord(v: unknown): v is Record<string, unknown> {
    return v != null && typeof v === 'object' && !Array.isArray(v)
  }
  function isBusinessAuthFailure(raw: unknown): boolean {
    if (!isRecord(raw)) return false
    const error = isRecord(raw.error) ? raw.error : null
    return (
      raw.success === false ||
      raw.code === 'AUTH_UNAUTHORIZED' ||
      raw.code === 'UNAUTHORIZED' ||
      error?.code === 'AUTH_UNAUTHORIZED' ||
      error?.code === 'UNAUTHORIZED'
    )
  }
  /**
   * 明确未授权（方案 027 §3.2）：仅识别显式未授权业务码。
   * 普通 success:false（功能关闭 / 参数错误 / 不支持的路径）属业务失败，不得据此判定登录失效。
   * HTTP 401/403 由调用处按状态码单独判定。
   */
  function isExplicitUnauthorized(raw: unknown): boolean {
    if (!isRecord(raw)) return false
    const error = isRecord(raw.error) ? raw.error : null
    return (
      raw.code === 'AUTH_UNAUTHORIZED' ||
      raw.code === 'UNAUTHORIZED' ||
      error?.code === 'AUTH_UNAUTHORIZED' ||
      error?.code === 'UNAUTHORIZED'
    )
  }
  function unwrap(raw: unknown): Record<string, unknown> | null {
    if (!isRecord(raw) || isBusinessAuthFailure(raw)) return null
    let value: any = raw
    for (let depth = 0; depth < 5; depth++) {
      if (!isRecord(value) || isBusinessAuthFailure(value)) return null
      let advanced = false
      for (const key of ['data', 'payload', 'response', 'result']) {
        if (isRecord((value as any)[key])) {
          value = (value as any)[key]
          advanced = true
          break
        }
      }
      if (!advanced) break
    }
    return isRecord(value) ? value : null
  }
  function hasAccountSnapshot(raw: unknown): boolean {
    const root = unwrap(raw)
    if (!root) return false
    function findUser(value: any, depth = 0): Record<string, unknown> | null {
      if (depth > 5 || !isRecord(value)) return null
      if (isRecord((value as any).user)) return (value as any).user
      for (const key of ['data', 'payload', 'response', 'result', 'stats', 'summary']) {
        const found = findUser((value as any)[key], depth + 1)
        if (found) return found
      }
      return null
    }
    const nestedUser = findUser(root)
    const user = nestedUser ?? root
    const hasIdentity = ['id', 'user_id', 'username', 'email'].some((key) => user[key] !== undefined && user[key] !== null)
    return hasIdentity && ['quota', 'used_quota', 'request_count'].some((key) => user[key] !== undefined && user[key] !== null)
  }

  /** IKunCode refresh 的认证成功条件，与账户额度字段解析解耦。 */
  function hasAuthBundle(raw: unknown): boolean {
    if (!isRecord(raw) || raw.success !== true || isBusinessAuthFailure(raw)) return false
    function findBundle(value: any, depth = 0): boolean {
      if (depth > 6 || !isRecord(value) || isBusinessAuthFailure(value)) return false
      const tokenOk = typeof value.access_token === 'string' && value.access_token.trim().length > 8
      const tokenTypeOk = typeof value.token_type === 'string' && value.token_type.trim().length > 0
      const expiryOk = value.access_expires_at !== undefined && value.access_expires_at !== null
      const user = isRecord(value.user) ? value.user : null
      const session = isRecord(value.session) ? value.session : null
      const userOk = !!user &&
        user.id !== undefined && user.id !== null &&
        typeof user.username === 'string' && user.username.trim().length > 0 &&
        typeof user.role === 'string' && user.role.trim().length > 0
      const sessionOk = !!session &&
        typeof session.sid === 'string' && session.sid.trim().length > 0 &&
        session.current !== undefined && session.current !== null &&
        typeof session.login_method === 'string' && session.login_method.trim().length > 0 &&
        typeof session.ip === 'string' && session.ip.trim().length > 0 &&
        typeof session.user_agent === 'string' && session.user_agent.trim().length > 0 &&
        session.created_at !== undefined && session.created_at !== null &&
        session.last_active_at !== undefined && session.last_active_at !== null &&
        session.expires_at !== undefined && session.expires_at !== null
      if (tokenOk && tokenTypeOk && expiryOk && userOk && sessionOk) return true
      for (const nestedKey of ['data', 'payload', 'response', 'result']) {
        if (findBundle((value as any)[nestedKey], depth + 1)) return true
      }
      return false
    }
    return findBundle(raw)
  }

  function buildPageAuthContext() {
    const headers: Record<string, string> = { Accept: 'application/json', 'Cache-Control': 'no-store' }
    let user: Record<string, unknown> | null = null
    try {
      const raw = localStorage.getItem('user')
      const parsed = raw ? JSON.parse(raw) : null
      if (isRecord(parsed)) user = parsed
    } catch {}
    const idRaw = user?.id
    const userId = (typeof idRaw === 'number' && Number.isFinite(idRaw)) ||
      (typeof idRaw === 'string' && idRaw.trim().length > 0) ? String(idRaw) : null
    const nestedToken = user?.token
    let token: string | null = typeof nestedToken === 'string' && nestedToken.trim().length > 8 ? nestedToken.trim() : null
    if (!token) {
      try {
        for (const key of ['token', 'access_token', 'auth_token', 'userToken', 'Authorization', 'auth', 'accessToken', 'id_token']) {
          const value = localStorage.getItem(key)
          if (value && value.length > 8) { token = value.trim(); break }
        }
      } catch {}
    }
    if (token?.startsWith('Bearer ')) token = token.slice(7).trim()
    let browserId: string | null = null
    try {
      const value = localStorage.getItem('docode_browser_id')
      if (value && value.length >= 16 && value.length <= 128) browserId = value
      if (!browserId) {
        const generated = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
        localStorage.setItem('docode_browser_id', generated)
        browserId = generated
      }
    } catch {}
    if (userId) headers['New-API-User'] = userId
    if (token) headers.Authorization = 'Bearer ' + token
    if (browserId) headers['X-Docode-Browser-Id'] = browserId
    return {
      headers,
      token,
      provider: userId ? ('new_api_user_object' as const) : ('generic_cookie_or_token' as const),
      contextComplete: !!userId && !!browserId,
    }
  }

  /** IKunCode 前端把会话 sid 持久化在 auth.session.sid；只在请求头内存中使用。 */
  function readAuthSessionSid(): string | null {
    try {
      function findSid(value: any, depth = 0): string | null {
        if (depth > 4 || !isRecord(value)) return null
        const session = (value as any).session
        if (isRecord(session) && typeof session.sid === 'string' && session.sid.length > 0) return session.sid
        for (const key of ['auth', 'state', 'data', 'user', 'store', 'session']) {
          const nested = findSid((value as any)[key], depth + 1)
          if (nested) return nested
        }
        return null
      }
      for (const storage of [localStorage, sessionStorage]) {
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i) || ''
          const raw = storage.getItem(key)
          if (!raw) continue
          try {
            const sid = findSid(JSON.parse(raw))
            if (sid) return sid
          } catch {
            /* ignore non-JSON storage values */
          }
        }
      }
    } catch {
      /* ignore storage access errors */
    }
    return null
  }

  const cookiePresent = document.cookie.length > 0
  const cookieNames = document.cookie
    .split(';')
    .map((c) => c.split('=')[0].trim())
    .filter(Boolean)
  const localStorageKeys = Object.keys(localStorage)
  const sessionStorageKeys = Object.keys(sessionStorage)

  const pageAuthContext = buildPageAuthContext()
  const authorityPath = discoveredPath || '/api/user/self'
  let authEvidence: AuthEvidence | null = null
  const recordAuth = (
    state: AuthState,
    reason: AuthEvidence['reason'],
    endpointRole: AuthEvidence['endpointRole'],
    path: string | null,
    status: number | null,
  ) => {
    const next: AuthEvidence = {
      state,
      reason,
      endpointRole,
      path,
      httpStatus: status,
      provider: pageAuthContext.provider,
      contextComplete: pageAuthContext.contextComplete,
      observedAt: Date.now(),
    }
    // 成功的权威账户证据不允许被后续候选失败覆盖。
    if (authEvidence?.reason === 'ACCOUNT_AUTHENTICATED' && authEvidence.endpointRole === 'account_authority') return
    authEvidence = next
  }
  let matchedPath: string | null = null
  let lastStatus: number | null = null

  for (const path of CANDIDATES) {
    const url = origin + path
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 6000)
      const headers: Record<string, string> = { ...pageAuthContext.headers }
      const fetchOnce = async (requestHeaders: Record<string, string>) => {
        const res = await fetch(url, { credentials: 'include', headers: requestHeaders, signal: controller.signal })
        const ct = res.headers.get('content-type') || ''
        let json: any = null
        if (ct.includes('json')) {
          try {
            json = JSON.parse(await res.text())
          } catch {
            json = null
          }
        }
        return { res, ct, json }
      }
      let { res, ct, json } = await fetchOnce(headers)
      if (pageAuthContext.token && pageAuthContext.provider !== 'new_api_user_object' &&
        (res.status === 401 || res.status === 403 || isBusinessAuthFailure(json))) {
        ;({ res, ct, json } = await fetchOnce({ Accept: 'application/json' }))
      }
      clearTimeout(timer)
      lastStatus = res.status
      if (res.status === 401 || res.status === 403 || isExplicitUnauthorized(json)) {
        if (path === authorityPath || path === '/api/user/self') {
          if (pageAuthContext.contextComplete) recordAuth('unauthorized', 'ACCOUNT_UNAUTHORIZED', 'account_authority', path, res.status)
          else recordAuth('indeterminate', 'AUTH_CONTEXT_INCOMPLETE', 'account_authority', path, res.status)
        } else {
          recordAuth('indeterminate', 'CANDIDATE_REJECTED', 'candidate', path, res.status)
        }
        continue
      }
      if (!res.ok || !ct.includes('json') || !json) continue
      const data = unwrap(json)
      if (data && (ID_PATHS.some((p) => getPath(data, p) != null) || hasAccountSnapshot(json) || hasAuthBundle(json))) {
        matchedPath = path
        if (path === authorityPath || path === '/api/user/self') {
          recordAuth('authenticated', 'ACCOUNT_AUTHENTICATED', 'account_authority', path, res.status)
        } else {
          recordAuth('authenticated', 'ACCOUNT_AUTHENTICATED', 'candidate', path, res.status)
        }
        break
      }
    } catch {
      continue
    }
  }

  // IKunCode 的 refresh 是唯一稳定返回 data.user 账户快照的接口；只在
  // 用户显式点击测试/授权时调用，不能纳入普通定时采集。
  if (!matchedPath && allowRefresh) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 6000)
      // 与 IKunCode 前端一致：refresh 是无 body 的 POST，不发送 JSON Content-Type。
      const headers: Record<string, string> = { ...pageAuthContext.headers }
      const sessionSid = readAuthSessionSid()
      if (sessionSid) headers['X-Auth-Session'] = sessionSid
      const tokenHeaders = { ...headers }
      const fetchRefresh = async (requestHeaders: Record<string, string>) => {
        const response = await fetch(origin + '/api/user/auth/refresh', {
          credentials: 'include',
          method: 'POST',
          headers: requestHeaders,
          signal: controller.signal,
        })
        const contentType = response.headers.get('content-type') || ''
        let json: any = null
        if (contentType.includes('json')) {
          try {
            json = JSON.parse(await response.text())
          } catch {
            json = null
          }
        }
        return { response, contentType, json }
      }
      let refreshed = await fetchRefresh(headers)
      if (
        (refreshed.response.status === 401 || refreshed.response.status === 403 || isBusinessAuthFailure(refreshed.json)) &&
        tokenHeaders.Authorization && pageAuthContext.provider !== 'new_api_user_object'
      ) {
        refreshed = await fetchRefresh(tokenHeaders)
      }
      clearTimeout(timer)
      lastStatus = refreshed.response.status
      if (refreshed.response.status >= 200 && refreshed.response.status < 400 && refreshed.contentType.includes('json')) {
        if (hasAuthBundle(refreshed.json) || hasAccountSnapshot(refreshed.json)) {
          matchedPath = '/api/user/auth/refresh'
          recordAuth('authenticated', 'ACCOUNT_AUTHENTICATED', 'refresh', '/api/user/auth/refresh', refreshed.response.status)
        }
      } else if (refreshed.response.status === 401 || refreshed.response.status === 403) {
        recordAuth('indeterminate', 'CANDIDATE_REJECTED', 'refresh', '/api/user/auth/refresh', refreshed.response.status)
      }
    } catch {
      // 保持原始探测结果，网络失败不是明确的授权失败。
    }
  }

  if (matchedPath) {
    const stableAuthEvidence = authEvidence as AuthEvidence | null
    return {
      ok: true,
      reason: 'ok',
      authExpired: false,
      authState: stableAuthEvidence?.state ?? 'authenticated',
      authEvidence: stableAuthEvidence,
      cookiePresent,
      cookieNames,
      localStorageKeys,
      sessionStorageKeys,
      status: lastStatus,
      path: matchedPath,
    }
  }
  const stableAuthEvidence = authEvidence as AuthEvidence | null
  const finalAuthState: AuthState = stableAuthEvidence?.state ?? 'indeterminate'
  const authExpired = finalAuthState === 'unauthorized'
  return {
    ok: false,
    reason: authExpired
      ? '登录态失效（接口返回 401/403）'
      : cookiePresent
        ? '未找到用户信息接口（标准路径均 404，可能部署了自定义 API 前缀，请用「网络发现」）'
        : '页面无 Cookie，请确认已在浏览器中登录该站点',
    authExpired,
    authState: finalAuthState,
    authEvidence: stableAuthEvidence,
    cookiePresent,
    cookieNames,
    localStorageKeys,
    sessionStorageKeys,
    status: lastStatus,
    path: null,
  }
}

/* 网络发现已改为 Service Worker 侧 chrome.webRequest，见 src/background/netDiscovery.ts */

/**
 * 页面主世界「自定义请求采集」。
 * 用户在 Options 输入以英文分号分隔的地址（相对路径或本站完整 URL），
 * 此函数在「已登录的本站页面」MAIN 世界逐个发起 GET，捕获 JSON 响应供后续分析。
 *
 * 约束（全部在函数内部实现，函数必须自包含——executeScript 只序列化函数体）：
 * - 仅同源：跨域 URL 直接拒绝；含用户凭据或敏感查询参数（token/secret/key…）的 URL 拒绝保存（红线 P0-2）。
 * - GET only：本轮不做 POST/带 body 请求。
 * - 禁止重定向跟随（redirect:'error'）：避免同源请求被 30x 跳转到跨域而绕过同源约束。
 * - 仅依赖浏览器 Cookie 自动携带（credentials:'include'）；不读取、不构造任何 token / Authorization 头（红线 P0-2）。
 * - 响应 JSON 经敏感字段递归脱敏（JWT/Bearer/敏感键）后再保存；非 JSON / 超大响应仅记录状态元数据。
 */
export interface CustomCaptureItem {
  url: string
  status: number | null
  contentType: string
  capturedAt: number
  ok: boolean
  json: unknown | null
  error?: string
}

export async function captureCustomInPage(origin: string, urls: string[]): Promise<CustomCaptureItem[]> {
  // —— 以下全部自包含，不得引用本文件顶层符号 ——

  // 敏感键名（命中则其值脱敏）；敏感查询参数（命中则整个 URL 拒绝保存）
  const SENSITIVE_KEY_RE = /(token|secret|password|passwd|authorization|auth|credential|cookie|session|api[_-]?key|access[_-]?key|private[_-]?key|凭证)/i
  const SECRET_QUERY_RE = /^(token|access[_-]?token|refresh[_-]?token|authorization|auth|secret|api[_-]?key|apikey|password|passwd|key|sig|signature)$/i

  function isJwt(s: string): boolean {
    return /^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(s.trim())
  }
  // 递归脱敏：敏感键的值、JWT / Bearer 字符串值 → 占位；业务字段保留（P0-2，优先于“原始 JSON”）
  function redact(v: unknown): unknown {
    if (typeof v === 'string') {
      if (isJwt(v)) return '[REDACTED:JWT]'
      if (/^Bearer\s+\S+/i.test(v.trim())) return '[REDACTED:Bearer]'
      return v
    }
    if (Array.isArray(v)) return v.map(redact)
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {}
      const src = v as Record<string, unknown>
      for (const k of Object.keys(src)) {
        o[k] = SENSITIVE_KEY_RE.test(k) ? '[REDACTED]' : redact(src[k])
      }
      return o
    }
    return v
  }

  // 解析 URL；标记跨域与含凭据（后续分别拒绝）。相对路径以 origin 为基准。
  function absolutize(raw: string): { url: string; crossOrigin: boolean; secret: boolean } {
    try {
      let u: URL
      if (/^https?:\/\//i.test(raw)) u = new URL(raw)
      else u = new URL(raw, origin + '/')
      const crossOrigin = u.origin !== origin
      const secret = !!(u.username || u.password) || [...u.searchParams.keys()].some((k) => SECRET_QUERY_RE.test(k))
      return { url: u.href, crossOrigin, secret }
    } catch {
      return { url: raw, crossOrigin: false, secret: false }
    }
  }

  // 标签页若已发生导航/重定向，基准 origin 可能失效 → 拒绝，避免以错误的旧 origin 拼接相对路径
  if (location.origin !== origin) {
    return [
      {
        url: origin,
        status: null,
        contentType: '',
        capturedAt: Date.now(),
        ok: false,
        json: null,
        error: `页面 origin(${location.origin}) 与站点(${origin}) 不一致，可能已被重定向，请刷新标签页后重试`,
      },
    ]
  }

  const MAX = 2 * 1024 * 1024 // 2MB 上限，避免超大响应撑爆 IndexedDB
  const out: CustomCaptureItem[] = []

  for (const raw of urls) {
    const r = (raw || '').trim()
    if (!r) continue
    const { url, crossOrigin, secret } = absolutize(r)
    if (crossOrigin) {
      out.push({ url, status: null, contentType: '', capturedAt: Date.now(), ok: false, json: null, error: '跨域已拒绝（仅允许本站同源请求）' })
      continue
    }
    if (secret) {
      out.push({ url, status: null, contentType: '', capturedAt: Date.now(), ok: false, json: null, error: 'URL 含凭据/敏感参数，已拒绝保存（P0-2）' })
      continue
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    // 仅依赖浏览器 Cookie 自动携带；不读取/构造任何 token 头（红线 P0-2）
    const headers: Record<string, string> = { Accept: 'application/json' }

    try {
      const res = await fetch(url, { credentials: 'include', headers, signal: controller.signal, redirect: 'error' })
      const ct = res.headers.get('content-type') || ''
      const text = await res.text()
      clearTimeout(timer)

      let json: unknown | null = null
      let err: string | undefined
      if (text.length > MAX) {
        err = '响应体积过大（>2MB）已跳过保存'
      } else if (ct.includes('json')) {
        try {
          json = redact(JSON.parse(text))
        } catch {
          err = 'JSON 解析失败'
        }
      }
      if (!res.ok) {
        err = `HTTP ${res.status}${ct.includes('json') ? '（JSON）' : '（非 JSON）'}`
      } else if (json == null) {
        err = '非 JSON 响应，仅记录状态'
      }
      out.push({ url, status: res.status, contentType: ct, capturedAt: Date.now(), ok: res.ok && json != null, json, error: err })
    } catch (e) {
      clearTimeout(timer)
      const msg = e instanceof Error ? e.message : String(e)
      const errMsg = /redirect/i.test(msg) ? '请求触发了重定向（已按同源策略拒绝跟随）' : msg
      out.push({ url, status: null, contentType: '', capturedAt: Date.now(), ok: false, json: null, error: errMsg })
    }
  }

  return out
}
