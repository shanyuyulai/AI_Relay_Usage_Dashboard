/**
 * 页面主世界注入函数。
 *
 * ⚠️ 关键约束：通过 chrome.scripting.executeScript({ world: 'MAIN', func }) 注入时，
 * Chrome 只序列化「函数本身」的源码，不会把本文件顶层的 const / 函数一起带进页面。
 * 因此每个导出函数都必须「完全自包含」——所有用到的常量与 helper 必须写在函数体内部，
 * 不能引用函数外部的任何符号，否则页面里会 ReferenceError、函数无返回 → 「探测脚本未返回结果」。
 */

import type { UsageRecord } from '../shared/types'

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
  function unwrap(raw: unknown): Record<string, unknown> | null {
    if (!isRecord(raw)) return null
    if ('data' in raw && isRecord((raw as any).data)) return (raw as any).data as Record<string, unknown>
    return raw as Record<string, unknown>
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

  // 同一标签页/页面内共享的探测逻辑（自包含）：fetch + 脱敏指纹。
  // 不回传任何 JSON 原文/Token/Cookie（P0-4 安全边界）。
  async function probeOne(url: string): Promise<ProbeAttempt> {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5000)
      const headers: Record<string, string> = { Accept: 'application/json' }
      try {
        const lsToken = (function () {
          try {
            const ks = ['token', 'access_token', 'auth_token', 'userToken', 'Authorization', 'auth', 'accessToken', 'id_token']
            for (const k of ks) {
              const v = localStorage.getItem(k)
              if (v && v.length > 8) return v.startsWith('Bearer ') ? v.slice(7) : v
            }
            for (let i = 0; i < localStorage.length; i++) {
              const k = localStorage.key(i)
              const v = k ? localStorage.getItem(k) : null
              if (v && v.startsWith('eyJ')) return v
            }
          } catch {}
          return null
        })()
        if (lsToken) headers['Authorization'] = 'Bearer ' + lsToken
      } catch {}
      const res = await fetch(url, { credentials: 'include', headers, signal: controller.signal })
      clearTimeout(timer)

      const contentType = res.headers.get('content-type') || ''
      let topKeys: string[] = []
      let hasWrapper = false
      let sample: unknown = undefined

      if (contentType.includes('json')) {
        const text = await res.text()
        try {
          const json = text ? JSON.parse(text) : null
          if (isRecord(json)) {
            topKeys = Object.keys(json)
            hasWrapper = 'success' in json || 'data' in json
            sample = json
          }
        } catch {
          /* ignore */
        }
      }

      let dataFieldTypes: Record<string, string> | undefined
      let dataFieldNames: string[] | undefined
      let hasDataArray = false
      let hasHourlyStructure = false
      let hasUserId = false
      if (sample != null) {
        const data = unwrap(sample)
        if (data) {
          dataFieldNames = Object.keys(data)
          const types: Record<string, string> = {}
          for (const k of dataFieldNames) types[k] = typeof (data as any)[k]
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
          hasUserId = ID_PATHS.some((p) => getPath(data, p) != null)
        }
      }

      return {
        url, status: res.status, contentType, topKeys, hasWrapper,
        dataFieldTypes, dataFieldNames, hasDataArray, hasHourlyStructure, hasUserId,
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
      if (hasIdType && hasBalanceType) {
        match = {
          url,
          path,
          topKeys: attempt.topKeys,
          idValue: null,
          idPath: ID_PATHS.find((p) => Object.prototype.hasOwnProperty.call(dt, p)) || 'id',
          balancePath: dt['quota'] !== undefined ? 'quota' : dt['balance'] !== undefined ? 'balance' : 'used_quota',
          usedPath: dt['used_quota'] !== undefined ? 'used_quota' : dt['used'] !== undefined ? 'used' : null,
          wrapped: attempt.hasWrapper,
        }
        break
      }
    }
  }

  // 第二遍：用量候选（GPT P0-1 自动主动探测，不 break，记录全部指纹供分类）
  const USAGE_CANDIDATE_PATHS = [
    '/api/data/self',
    '/api/v1/data/self',
    '/api/user/usage',
    '/api/v1/user/usage',
    '/api/log/self',
    '/api/v1/log/self',
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
  function unwrap(raw: unknown): Record<string, unknown> | null {
    if (!isRecord(raw)) return null
    if ('data' in raw && isRecord((raw as any).data)) return (raw as any).data as Record<string, unknown>
    return raw as Record<string, unknown>
  }
  async function fetchJson(url: string): Promise<{ status: number; json: any; isJson: boolean }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 6000)
    // 携带 localStorage 中的 token 作为 Bearer 头（不读取/回传 token 值，红线 P0-2）
    const headers: Record<string, string> = { Accept: 'application/json' }
    try {
      const lsToken = (function () {
        try {
          const ks = ['token', 'access_token', 'auth_token', 'userToken', 'Authorization', 'auth', 'accessToken', 'id_token']
          for (const k of ks) {
            const v = localStorage.getItem(k)
            if (v && v.length > 8) return v.startsWith('Bearer ') ? v.slice(7) : v
          }
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i)
            const v = k ? localStorage.getItem(k) : null
            if (v && v.startsWith('eyJ')) return v
          }
        } catch {}
        return null
      })()
      if (lsToken) headers['Authorization'] = 'Bearer ' + lsToken
    } catch {}
    try {
      const res = await fetch(url, {
        credentials: 'include',
        headers,
        signal: controller.signal,
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
    } finally {
      clearTimeout(timer)
    }
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
        const t = findNumber(item, ['tokens', 'token', 'consumption', 'cost', 'usage', 'used', 'total_tokens', 'totalTokens'])
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
    const tokens = findNumber(data, ['total_tokens', 'tokens', 'consumption', 'total_consumption', 'total_cost', 'used', 'total', 'usage'])
    const requests = findNumber(data, ['total_requests', 'requests', 'total_request', 'request_count', 'total_request_count', 'count', 'total_count'])
    const list =
      getPath(data, 'items') ??
      getPath(data, 'list') ??
      getPath(data, 'data.items') ??
      getPath(data, 'data.list')
    if (Array.isArray(list)) {
      const sub = extractUsage(list)
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

  // 若 strategy 为空或无余额端点，回退旧逻辑（向后兼容）
  let matchedPath: string | null = null
  let dataObj: Record<string, unknown> | null = null
  let authExpired = false
  // A0：本次采集对余额接口的实测往返耗时（GPT P0-5：非纯延迟、非站点平均响应）
  let apiRoundTripMs: number | null = null
  const needsToken = !!(balanceEp?.needsToken)

  // 当日用量明细（usage_list）采集结果容器：提前声明，供 early-return 与最终返回共用
  let usageRecords: UsageRecord[] = []
  let usageRecordsComplete = false
  let usageRecordsTruncatedReason: string | null = null

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
        authExpired = true
        recordDiag('balance', url, status, '', Math.round(dt), null, '401/403 未授权')
      } else if (status && status < 400 && isJson && json) {
        const data = unwrap(json)
        if (data && ID_PATHS.some((p) => getPath(data, p) != null)) {
          matchedPath = balanceEp.path
          dataObj = data
          apiRoundTripMs = Math.round(dt)
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
        if (status === 401 || status === 403) { authExpired = true; recordDiag('balance', url, status, '', Math.round(dt), null, '401/403 未授权'); continue }
        if (!status || status >= 400 || !isJson || !json) { recordDiag('balance', url, status || 0, isJson ? 'application/json' : '', Math.round(dt), null, `HTTP ${status ?? '?'} 或非 JSON`); continue }
        const wrapped = isRecord(json) && ('success' in json || 'data' in json)
        if (wrapped && (json as any).success === false) { authExpired = true; recordDiag('balance', url, status, 'application/json', Math.round(dt), null, 'success:false'); continue }
        const data = unwrap(json)
        if (!data) { recordDiag('balance', url, status, 'application/json', Math.round(dt), null, '无法 unwrap 响应'); continue }
        const hasId = ID_PATHS.some((p) => getPath(data, p) != null)
        if (!hasId) { recordDiag('balance', url, status, 'application/json', Math.round(dt), data, '缺少用户标识字段'); continue }
        matchedPath = path
        dataObj = data
        apiRoundTripMs = Math.round(dt)
        recordDiag('balance', url, status, 'application/json', Math.round(dt), data, '回退命中')
        break
      } catch (e) {
        recordDiag('balance', url, 0, '', 0, null, `网络错误: ${(e as Error).message}`)
        continue
      }
    }
  }

  if (!dataObj || !matchedPath) {
    return {
      ok: false,
      reason: authExpired ? '登录态失效（接口返回 401 / 未登录）' : '未探测到用户信息接口',
      authExpired,
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
      path: null,
      rawKeys: [],
      cumulativeTokens: null,
      cumulativeTokensSource: null,
      apiRoundTripMs: null,
      avgResponseTimeMs: null,
      todayCost: null,
      diags,
      usageRecords: [],
      usageRecordsComplete: false,
      usageRecordsTruncatedReason: null,
    }
  }

  let balance = findNumber(dataObj, ['balance', 'remain', 'remaining', 'available'])
  const used = findNumber(dataObj, USED_PATHS)
  if (balance == null) {
    const quota = findNumber(dataObj, ['quota', 'totalQuota', 'total_quota'])
    if (quota != null) balance = quota - (used ?? 0)
  }
  // 累计请求数（ikuncode 等「/api/user/self」明确返回；其余站点可能缺失→null，UI 显「—」）
  const totalRequests = findNumber(dataObj, [
    'request_count',
    'total_request_count',
    'totalRequestCount',
    'requestCount',
    'requests',
    'total_requests',
    'totalRequests',
    'consumed_requests',
  ])
  const rawKeys = Object.keys(dataObj)

  // A0：累计 Token（仅 token 命名字段，绝不取 quota/used_quota 额度，GPT P0-2）
  const cumulativeTokens = findNumber(dataObj, [
    'total_tokens', 'cumulative_tokens', 'total_token', 'consumed_tokens',
    'all_time_tokens', 'lifetime_tokens', 'totalTokens', 'cumulativeToken',
  ])
  const cumulativeTokensSource: 'dashboard' | null = cumulativeTokens != null ? 'dashboard' : null

  // A0：站点自报平均 API 响应（仅权威时间字段；秒级 <1000 视为秒→转 ms，GPT P0-5）
  let avgResponseTimeMs: number | null = null
  const rawAvg = findNumber(dataObj, [
    'avg_response', 'avg_response_time', 'average_response_time', 'avg_latency',
    'average_latency', 'avgResponseTime', 'avgResponse', 'averageResponse',
  ])
  if (rawAvg != null) avgResponseTimeMs = rawAvg < 1000 ? Math.round(rawAvg * 1000) : Math.round(rawAvg)

  if (balance == null && used == null) {
    return {
      ok: false,
      reason: `响应缺少余额/已用字段（尝试了 ${BALANCE_PATHS.join('/')} 和 ${USED_PATHS.join('/')}）`,
      authExpired: false,
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
      apiRoundTripMs: null,
      avgResponseTimeMs: null,
      todayCost: null,
      diags,
      usageRecords: [],
      usageRecordsComplete: false,
      usageRecordsTruncatedReason: null,
    }
  }

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

  try {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    const fromMs = start.getTime()
    const toMs = Date.now()
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
            const usage = extractUsage(udata)
            if (usage && usage.tokens != null) {
              todayTokens = usage.tokens
              todayRequests = usage.requests
              // 今日使用金额：优先顶层货币字段（total_cost/cost/amount…），否则留 null
              const hc = findNumber(udata, ['total_cost', 'cost', 'total_cost_usd', 'amount', 'spend'])
              if (hc != null) todayCost = hc
              modelUsages = [
                { model: '*', tokens: todayTokens, cost: todayCost ?? 0 },
                ...(usage.byModel.length
                  ? usage.byModel.map((m) => ({ model: m.model, tokens: m.tokens, cost: 0 }))
                  : []),
              ]
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

          // 去重键：优先用 log.id，否则组合键
          function dedupKey(item: any): string | null {
            if (typeof item.id === 'number' || typeof item.id === 'string') return `id:${item.id}`
            const model = String(item.model_name ?? item.model ?? '')
            const ts = String(item.created_at ?? item.timestamp ?? '')
            const pt = String(item.prompt_tokens ?? item.input_tokens ?? '')
            const ct = String(item.completion_tokens ?? item.output_tokens ?? '')
            if (!model && !ts) return null // 无法去重，仍计入
            return `${model}|${ts}|${pt}|${ct}`
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
            const arr: any[] = (Array.isArray(d) ? d : (Array.isArray((d as any).data) ? (d as any).data : (Array.isArray((d as any).items) ? (d as any).items : (Array.isArray((d as any).list) ? (d as any).list : []))))
            if (arr.length === 0) break
            pageCount++

            // 检查最早日志是否早于今天零点（如是则停止分页）
            let earliestBeyondToday = false
            for (const item of arr) {
              if (!isRecord(item)) continue
              const ts = typeof item.created_at === 'number'
                ? item.created_at * 1000
                : typeof item.created_at === 'string'
                  ? new Date(item.created_at).getTime()
                  : null
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
              const itemTs = typeof item.created_at === 'number'
                ? item.created_at * 1000
                : typeof item.created_at === 'string'
                  ? new Date(item.created_at).getTime()
                  : null
              if (itemTs != null && (itemTs < fromMs || itemTs > toMs)) continue

              // 去重
              const key = dedupKey(item)
              if (key && seen.has(key)) continue
              if (key) seen.add(key)

              const pt = toNumber((item as any).prompt_tokens ?? (item as any).input_tokens)
              const ct = toNumber((item as any).completion_tokens ?? (item as any).output_tokens)
              if (!Number.isNaN(pt)) totalTokens += pt
              if (!Number.isNaN(ct)) totalTokens += ct
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
    const usageListEp = endpoints.find((e: any) => e.role === 'usage_list')
    if (usageListEp && usageListEp.path) {
      const kind: string = usageListEp.usageListKind === 'hubway_v1' ? 'hubway_v1' : 'generic'
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
      const targetDay = dayKeyOf(Date.now())
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
        const tk = recNum(it, ['total_tokens', 'tokens']) ?? pt + ct
        const s = `${model}|${ts}|${pt}|${ct}|${tk}`
        let h = 0x811c9dc5
        for (let i = 0; i < s.length; i++) {
          h ^= s.charCodeAt(i)
          h = Math.imul(h, 0x01000193)
        }
        return (h >>> 0).toString(16)
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
          recordDiag('usage', rUrl, status || 0, 'application/json', Math.round(rDt), null, `用量明细 p=${p} 失败`)
          break
        }
        const d: any = unwrap(json)
        if (!d) {
          recordDiag('usage', rUrl, status, 'application/json', Math.round(rDt), null, `用量明细 p=${p} 无法 unwrap`)
          break
        }
        recordDiag('usage', rUrl, status, 'application/json', Math.round(rDt), d, `用量明细 p=${p}`)
        // 兼容多种包裹形态：items / data.items / list / data.list
        const arr: any[] = Array.isArray(d)
          ? d
          : Array.isArray(d.items)
            ? d.items
            : Array.isArray(d.data?.items)
              ? d.data.items
              : Array.isArray(d.list)
                ? d.list
                : Array.isArray(d.data?.list)
                  ? d.data.list
                  : []
        if (arr.length === 0) break
        recPageCount++
        for (const item of arr) {
          if (!isRecord(item)) continue
          const ts = recTs(item)
          if (ts == null) continue
          // 业务日过滤：仅保留命中目标业务日的记录
          if (dayKeyOf(ts) !== targetDay) continue
          const key = recHash(item)
          if (seenRec.has(key)) continue
          seenRec.add(key)
          const pt = recNum(item, ['prompt_tokens', 'input_tokens']) ?? 0
          const ct = recNum(item, ['completion_tokens', 'output_tokens']) ?? 0
          const tk = recNum(item, ['total_tokens', 'tokens']) ?? pt + ct
          if (tk <= 0 && item.model_name == null && item.model == null) continue
          const cost = recCost(item)
          const rec: UsageRecord = {
            id: key,
            ts,
            model: recModel(item),
            promptTokens: pt,
            completionTokens: ct,
            tokens: tk,
            cost,
            costCurrency: stratCurrency,
          }
          recList.push(rec)
          recTotalTokens += tk
          recTotalReqs++
          if (cost != null) recCostByCurrency[stratCurrency] = (recCostByCurrency[stratCurrency] || 0) + cost
          recItemCount++
          if (recItemCount >= MAX_ITEMS) break
        }
        // 分页完整性：hubway 读 has_more/total；其余以「本页满页」判断可能还有下一页
        let more = true
        if (kind === 'hubway_v1') {
          const total = recNum(d, ['total']) ?? recNum(d.data, ['total'])
          const hasMore = d.has_more ?? d.data?.has_more
          more = hasMore === true || (total != null && recList.length < total)
        } else {
          more = arr.length >= 50
        }
        if (!more || recItemCount >= MAX_ITEMS) {
          if (recItemCount >= MAX_ITEMS) {
            recComplete = false
            recTruncated = `明细超 ${MAX_ITEMS} 条上限，已截断`
          }
          break
        }
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
  } catch {
    /* 用量接口可选，不影响余额采集 */
  }

  // Task #24：若余额端点未拿到累计Token/平均响应，但用量端点拿到了 → 回填（来源标注为 dashboard，因为来自站点权威接口）
  const finalCumulativeTokens = cumulativeTokens ?? usageCumulativeTokens
  const finalCumulativeTokensSource = cumulativeTokens != null ? cumulativeTokensSource
    : usageCumulativeTokens != null ? 'dashboard' as const : null
  const finalAvgResponseMs = avgResponseTimeMs ?? usageAvgResponseMs

  return {
    ok: true,
    reason: '',
    authExpired: false,
    cookiePresent,
    cookieNames,
    localStorageKeys,
    sessionStorageKeys,
    balance: balance ?? 0,
    used: used ?? 0,
    totalQuota,
    totalRequests,
    currency: stratCurrency,
    todayTokens,
    todayRequests,
    modelUsages,
    path: matchedPath,
    rawKeys,
    usageSource: usageSource ?? (todayTokens == null ? 'unavailable' : undefined),
    isPartial: isPartial || undefined,
    collectorVersion: collectorVersion || undefined,
    cumulativeTokens: finalCumulativeTokens,
    cumulativeTokensSource: finalCumulativeTokensSource,
    apiRoundTripMs,
    avgResponseTimeMs: finalAvgResponseMs,
    todayCost: todayCost ?? null,
    metricsPartial: isPartial || undefined,
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
  function unwrap(raw: unknown): Record<string, unknown> | null {
    if (!isRecord(raw)) return null
    if ('data' in raw && isRecord((raw as any).data)) return (raw as any).data as Record<string, unknown>
    return raw as Record<string, unknown>
  }

  const cookiePresent = document.cookie.length > 0
  const cookieNames = document.cookie
    .split(';')
    .map((c) => c.split('=')[0].trim())
    .filter(Boolean)
  const localStorageKeys = Object.keys(localStorage)
  const sessionStorageKeys = Object.keys(sessionStorage)

  let authExpired = false
  let matchedPath: string | null = null
  let lastStatus: number | null = null

  for (const path of CANDIDATES) {
    const url = origin + path
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 6000)
      // 携带 localStorage 中的 token 作为 Bearer 头（不读取/回传 token 值，红线 P0-2）
      const headers: Record<string, string> = { Accept: 'application/json' }
      try {
        const lsToken = (function () {
          try {
            const ks = ['token', 'access_token', 'auth_token', 'userToken', 'Authorization', 'auth', 'accessToken', 'id_token']
            for (const k of ks) {
              const v = localStorage.getItem(k)
              if (v && v.length > 8) return v.startsWith('Bearer ') ? v.slice(7) : v
            }
            for (let i = 0; i < localStorage.length; i++) {
              const k = localStorage.key(i)
              const v = k ? localStorage.getItem(k) : null
              if (v && v.startsWith('eyJ')) return v
            }
          } catch {}
          return null
        })()
        if (lsToken) headers['Authorization'] = 'Bearer ' + lsToken
      } catch {}
      const res = await fetch(url, {
        credentials: 'include',
        headers,
        signal: controller.signal,
      })
      clearTimeout(timer)
      lastStatus = res.status
      if (res.status === 401 || res.status === 403) {
        authExpired = true
        continue
      }
      const ct = res.headers.get('content-type') || ''
      if (!res.ok || !ct.includes('json')) continue
      const json = JSON.parse(await res.text())
      const data = unwrap(json)
      if (data && ID_PATHS.some((p) => getPath(data, p) != null)) {
        matchedPath = path
        break
      }
    } catch {
      continue
    }
  }

  if (matchedPath) {
    return { ok: true, reason: 'ok', authExpired: false, cookiePresent, cookieNames, localStorageKeys, sessionStorageKeys, status: lastStatus, path: matchedPath }
  }
  return {
    ok: false,
    reason: authExpired
      ? '登录态失效（接口返回 401/403）'
      : cookiePresent
        ? '未找到用户信息接口（标准路径均 404，可能部署了自定义 API 前缀，请用「网络发现」）'
        : '页面无 Cookie，请确认已在浏览器中登录该站点',
    authExpired,
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
