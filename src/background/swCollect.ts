/**
 * 实验室：Service Worker 零标签后台采集。
 *
 * 这是 P0-2「不碰/不存凭证」红线的知情例外，仅当实验室开关开启、且站点没有已打开标签时启用。
 * 做法：在 SW 内用 chrome.cookies.getAll 读取站点登录 Cookie（含 HttpOnly），手动注入到
 * 请求头去 fetch 已知端点，从而无需打开任何可见标签即可后台采集。
 *
 * 安全约束（硬性）：
 *  - Cookie 仅在本次请求内存中使用，绝不写入 IndexedDB / 导出 / 回传给任何页面。
 *  - 仅作 GET、redirect:'error'、credentials:'omit'（完全手动控制 Cookie）。
 *
 * 不稳定性（已在 UI 告知用户）：
 *  - 多数站点 API 不设 CORS，跨源 fetch 会被浏览器拦截 → 失败；
 *  - 会话常不止一个 Cookie，还绑 CSRF / SameSite / 内存态 Token（如 ikuncode 依赖
 *    localStorage 的 Bearer，SW 读不到）→ 很大概率失败或只能采到部分字段。
 */
import type { SiteConfig, Snapshot } from '../shared/types'
import type { CollectResult } from './collector'
import { siteRepo, snapshotRepo, dailyStatRepo } from '../storage'

/** 读取站点 Cookie 并拼成请求头字符串；读不到返回 null（很可能未登录）。 */
async function readCookieHeader(origin: string): Promise<string | null> {
  let list = await chrome.cookies.getAll({ url: origin })
  if (!list || list.length === 0) {
    list = await chrome.cookies.getAll({ url: origin + '/' })
  }
  if (!list || list.length === 0) return null
  return list.map((c) => `${c.name}=${c.value}`).join('; ')
}

/** 余额解析（兼容 New API 标准 / Fork 各形态），返回余额、总额度、货币。 */
function parseBalance(json: any, fallbackCurrency: string): {
  balance: number | null
  totalQuota: number | null
  currency: string
} {
  const d = json?.data ?? json
  if (!d || typeof d !== 'object') return { balance: null, totalQuota: null, currency: fallbackCurrency }
  let balance: number | null = null
  if (typeof d.balance === 'number') balance = d.balance
  else if (typeof d.remain_quota === 'number') balance = d.remain_quota
  else if (typeof d.remain === 'number') balance = d.remain
  else if (typeof d.available === 'number') balance = d.available
  else if (typeof d.quota === 'number' && typeof d.used_quota === 'number') {
    balance = d.quota - d.used_quota
  }
  const totalQuota = typeof d.quota === 'number' ? d.quota : null
  const currency = typeof d.currency === 'string' && d.currency ? d.currency : fallbackCurrency
  return { balance, totalQuota, currency }
}

/** 用量解析：优先小时数组累加，其次汇总 total_tokens。 */
function parseUsage(json: any): { todayTokens: number | null; todayRequests: number | null } {
  const d = json?.data ?? json
  if (!d) return { todayTokens: null, todayRequests: null }
  const arr = Array.isArray(d) ? d : Array.isArray(d.items) ? d.items : null
  if (arr) {
    let tokens = 0
    let requests = 0
    for (const it of arr) {
      const t = it?.tokens ?? it?.total_tokens ?? it?.count
      if (typeof t === 'number') tokens += t
      if (typeof it?.requests === 'number') requests += it.requests
    }
    return {
      todayTokens: tokens > 0 ? tokens : null,
      todayRequests: requests > 0 ? requests : null,
    }
  }
  if (typeof d.total_tokens === 'number') {
    return {
      todayTokens: d.total_tokens,
      todayRequests: typeof d.total_requests === 'number' ? d.total_requests : null,
    }
  }
  return { todayTokens: null, todayRequests: null }
}

async function fetchJson(url: string, cookie: string): Promise<any | null> {
  try {
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'omit', // 完全手动控制 Cookie，禁止浏览器自动附带
      redirect: 'error', // 禁止重定向跨域绕过
      headers: {
        Cookie: cookie,
        Accept: 'application/json',
      },
    })
    if (!res.ok) return null
    const ct = res.headers.get('content-type') || ''
    if (!ct.includes('json')) return null
    return await res.json()
  } catch {
    // CORS / 网络 / 重定向错误 → 该端点放弃，由上层尝试下一个
    return null
  }
}

/**
 * 实验室零标签采集（SW 内）。返回 CollectResult 并落库快照。
 * 失败明确标注「实验室零标签采集失败」，供 UI / 通知告知用户。
 */
export async function collectViaSw(site: SiteConfig): Promise<CollectResult> {
  const cookie = await readCookieHeader(site.origin)
  if (!cookie) {
    const msg = '实验室零标签采集：读不到站点 Cookie（可能未登录或缺少 host 权限）'
    await siteRepo.update(site.id, { lastStatus: 'auth_expired', lastCollectAt: Date.now(), lastError: msg })
    return { siteId: site.id, ok: false, errorKind: 'AUTH_EXPIRED', message: msg }
  }

  const fallbackCurrency = site.currency ?? 'USD'
  const balancePaths = site.discovered?.userSelfPath
    ? [site.discovered.userSelfPath, '/api/user/self', '/api/v1/auth/me']
    : ['/api/user/self', '/api/v1/auth/me', '/api/user/info', '/api/account']
  const endSec = Math.floor(Date.now() / 1000)
  const startSec = endSec - 24 * 3600
  const usagePaths = [
    `/api/data/self?start_timestamp=${startSec}&end_timestamp=${endSec}&default_time=hour`,
    '/api/user/usage',
    '/api/v1/user/usage',
    '/api/usage',
  ]

  let balance: number | null = null
  let totalQuota: number | null = null
  let currency = fallbackCurrency
  for (const p of balancePaths) {
    const json = await fetchJson(site.origin + p, cookie)
    if (json == null) continue
    const r = parseBalance(json, fallbackCurrency)
    if (r.balance != null) {
      balance = r.balance
      totalQuota = r.totalQuota
      currency = r.currency
      break
    }
  }

  if (balance == null) {
    const msg = '实验室零标签采集失败（多为 CORS 拦截 / 需 Token / 路径不匹配），建议关闭该选项或保持标签登录'
    await siteRepo.update(site.id, { lastStatus: 'error', lastCollectAt: Date.now(), lastError: msg })
    return { siteId: site.id, ok: false, errorKind: 'NOT_FOUND', message: msg }
  }

  let todayTokens: number | null = null
  let todayRequests: number | null = null
  for (const p of usagePaths) {
    const json = await fetchJson(site.origin + p, cookie)
    if (json == null) continue
    const r = parseUsage(json)
    if (r.todayTokens != null || r.todayRequests != null) {
      todayTokens = r.todayTokens
      todayRequests = r.todayRequests
      break
    }
  }

  const now = Date.now()
  const snap: Snapshot = {
    siteId: site.id,
    takenAt: now,
    balance,
    todayTokens,
    todayRequests,
    totalRequests: null, // 实验室 v1 不解析累计请求
    totalQuota,
    currency,
    modelUsages: [],
    status: 'ok',
    channel: 'sw_lab', // 真实来源：SW 零标签实验室采集
    quality: todayTokens != null ? 'partial' : 'unknown',
    family: site.discovered?.family,
    routeProfile: site.discovered?.routeProfile,
    confidence: site.discovered?.confidence,
    balanceSource: 'userSelf',
    usageSource: todayTokens != null ? 'swLab' : 'unavailable',
    isPartial: todayTokens == null,
    collectorVersion: 1, // 实验室 v1
  }
  await snapshotRepo.append(snap)
  if (snap.todayTokens != null) await dailyStatRepo.upsertForDay(snap)
  await siteRepo.update(site.id, { lastCollectAt: now, lastStatus: 'ok' })
  return { siteId: site.id, ok: true, snapshot: snap }
}
