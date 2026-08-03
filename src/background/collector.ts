import { registry } from '../adapters'
import { siteRepo, snapshotRepo, dailyStatRepo } from '../storage'
import { CollectError, type CollectContext, type SiteAdapter, type UsageRange } from '../core/adapter/contracts'
import { acquireSiteLock, requestGate, sleep } from './limits'
import type {
  SiteConfig,
  Snapshot,
  Channel,
  CollectErrorKind,
  ModelUsage,
} from '../shared/types'
import { dateKey } from '../shared/util'

export interface CollectResult {
  siteId: string
  ok: boolean
  errorKind?: CollectErrorKind
  message?: string
  snapshot?: Snapshot
}

const MAX_RETRIES = 2 // NETWORK/超时指数退避重试上限（P1-2）
const DAY = 86_400_000

/** 近 7 日窗口（New API /api/user/usage 多为 7 日序列），采集时按「今日 00:00」过滤出当日。 */
function weekRange(): UsageRange {
  const now = Date.now()
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const todayStart = start.getTime()
  return { from: todayStart - 6 * DAY, to: now }
}

interface CookieDiag {
  strategy: string
  err: string
}

/**
 * 多策略获取指定 origin 的 Cookie。
 * MV3 SW 中 chrome.cookies.getAll 可能因 URL 格式、域名匹配、分区键（Chrome 119+）
 * 而遗漏 Cookie。依次尝试：带路径 URL → 精确域名 → 父域名 → 全局扫描过滤。
 */
async function getCookiesForOrigin(origin: string): Promise<{
  cookies: chrome.cookies.Cookie[]
  cookieString: string
  cookieDiag: CookieDiag
}> {
  let cookies: chrome.cookies.Cookie[] = []
  let strategy = ''
  let err = ''
  const hostname = new URL(origin).hostname
  const parts = hostname.split('.')

  // 策略 1：URL + 路径（Chrome 文档推荐格式）
  try {
    cookies = await chrome.cookies.getAll({ url: `${origin}/` })
    strategy = `url(${origin}/)→${cookies.length}`
  } catch (e) {
    err = `url:${String(e)}`
  }

  // 策略 2：精确域名
  if (cookies.length === 0) {
    try {
      cookies = await chrome.cookies.getAll({ domain: hostname })
      strategy = `domain(${hostname})→${cookies.length}`
    } catch (e) {
      err += `; domain:${String(e)}`
    }
  }

  // 策略 3：父域名（如 .rayinai.com ← code.rayinai.com）
  if (cookies.length === 0 && parts.length > 2) {
    const parentDomain = '.' + parts.slice(-2).join('.')
    try {
      cookies = await chrome.cookies.getAll({ domain: parentDomain })
      strategy = `parentDomain(${parentDomain})→${cookies.length}`
    } catch (e) {
      err += `; parentDomain:${String(e)}`
    }
  }

  // 策略 4：全局扫描 + 域名匹配（兜底，同时发现分区键问题）
  if (cookies.length === 0) {
    try {
      const all = await chrome.cookies.getAll({})
      // 匹配规则：cookie.domain 去掉前导点后，hostname 以它结尾（子域名可见父域 cookie）
      const matching = all.filter(c => {
        const cd = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain
        return hostname === cd || hostname.endsWith('.' + cd)
      })
      if (matching.length > 0) {
        cookies = matching
        strategy = `globalScan→${matching.length}/${all.length}`
      } else {
        // 诊断：列出所有可用域名（前15个）
        const domains = [...new Set(all.map(c => c.domain))].slice(0, 15)
        strategy = `globalScan→0/${all.length} | 可用域名: [${domains.join(', ')}]`
      }
    } catch (e) {
      err += `; global:${String(e)}`
    }
  }

  // 构造 Cookie 字符串（用于手动注入请求头，MV3 SW 的 fetch 可能不自动附带 cookie）
  const cookieString = cookies
    .map(c => `${c.name}=${c.value}`)
    .join('; ')

  return { cookies, cookieString, cookieDiag: { strategy, err } }
}

/** 单站采集（已在 perSiteLock 内）。含指数退避重试（P1-2）。 */
async function doCollect(site: SiteConfig, channel: Channel): Promise<CollectResult> {
  let adapter: SiteAdapter
  try {
    adapter = registry.get(site.adapter)
  } catch {
    await siteRepo.update(site.id, { lastStatus: 'error', lastCollectAt: Date.now() })
    return { siteId: site.id, ok: false, errorKind: 'NOT_FOUND', message: `未知适配器: ${site.adapter}` }
  }

  // M1 仅 Cookie 会话：采集时由 SW 实时读取该 origin cookie，不落库、不存 token（P0-2）
  // MV3 SW 中 cookie 匹配可能因域名/URL格式/分区键而遗漏，故多策略探测
  const { cookies, cookieString, cookieDiag } = await getCookiesForOrigin(site.origin)
  const hasPerm = await chrome.permissions.contains({ origins: [`${site.origin}/*`] }).then(Boolean).catch(() => false)
  console.log(
    `[AI Relay][collect] 开始采集 site=${site.id} name="${site.name}" adapter=${site.adapter}`,
  )
  console.log(
    `[AI Relay][collect]   origin=${site.origin} cookies=${cookies.length} host-perm=${hasPerm} strategy=${cookieDiag.strategy} err="${cookieDiag.err}"`,
  )
  if (cookies.length > 0) {
    console.log(
      `[AI Relay][collect]   Cookie 名称: [${cookies.slice(0, 5).map(c => `${c.name}(domain=${c.domain})`).join(', ')}]${cookies.length > 5 ? ` ...共${cookies.length}个` : ''}`,
    )
  } else {
    console.log(
      `[AI Relay][collect]   ⚠ 未检测到 Cookie —— 请确认在 Chrome 中已登录 ${site.origin}`,
    )
  }
  const ctx: CollectContext = {
    siteId: site.id,
    baseUrl: site.origin,
    cookies,
    cookieString,
    discoveredPath: site.discovered?.userSelfPath,
  }

  let lastErr: unknown = null
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoff = Math.min(1000 * 2 ** (attempt - 1), 30_000)
      await sleep(backoff)
    }
    try {
      const snapshot = await requestGate.run(() => adapter.collect(ctx))
      const enriched = await enrichUsage(adapter, ctx, snapshot)
      enriched.channel = channel // collector 按真实来源覆盖适配器占位
      await snapshotRepo.append(enriched)
      // 仅当有精确用量（todayTokens != null）才落日聚合；否则不落（P0-3 禁余额差分/不造 0）
      if (enriched.todayTokens != null) {
        await dailyStatRepo.upsertForDay(enriched)
      }
      await siteRepo.update(site.id, { lastCollectAt: Date.now(), lastStatus: 'ok' })
      return { siteId: site.id, ok: true, snapshot: enriched }
    } catch (e) {
      lastErr = e
      // 语义失败不重试，直接收敛；仅 NETWORK/超时进入退避重试
      if (e instanceof CollectError && e.kind !== 'NETWORK') break
    }
  }

  const kind: CollectErrorKind = lastErr instanceof CollectError ? lastErr.kind : 'NETWORK'
  const status = kind === 'AUTH_EXPIRED' ? 'auth_expired' : 'error'
  const message = lastErr instanceof Error ? lastErr.message : String(lastErr)
  // P1-1 诊断日志：只输出 endpoint/statusCode/字段路径/哈希，不含响应原文或私密
  const diag = lastErr instanceof CollectError ? lastErr.diagnostics : undefined
  console.error(
    `[AI Relay][collect] ✗ 采集失败 site=${site.id} name="${site.name}"`,
  )
  console.error(
    `[AI Relay][collect]   kind=${kind} message="${message}"`,
  )
  if (diag) {
    console.error(`[AI Relay][collect]   diag: endpoint=${diag.endpoint} statusCode=${diag.statusCode} hash=${diag.responseHash} missingFields=[${(diag.missingFields || []).join(',')}]`)
  }
  if (lastErr instanceof Error && lastErr.stack) {
    console.error(`[AI Relay][collect]   stack: ${lastErr.stack.split('\n').slice(0, 4).join(' | ')}`)
  }
  await siteRepo.update(site.id, { lastStatus: status, lastCollectAt: Date.now(), lastError: message })
  return {
    siteId: site.id,
    ok: false,
    errorKind: kind,
    message,
  }
}

/** 调用 fetchUsageLogs 回填今日用量（P0-3：唯一来源）；null 表示无精确来源。 */
async function enrichUsage(
  adapter: SiteAdapter,
  ctx: CollectContext,
  snapshot: Snapshot,
): Promise<Snapshot> {
  const fetchUsage = adapter.fetchUsageLogs
  if (!fetchUsage) {
    snapshot.todayTokens = null
    snapshot.todayRequests = null
    snapshot.modelUsages = []
    snapshot.quality = 'partial'
    return snapshot
  }
  const logs = await requestGate.run(() => fetchUsage(ctx, weekRange()))
  if (logs == null) {
    // 无精确用量来源：不落 dailyStats，UI 显 unknown
    snapshot.todayTokens = null
    snapshot.todayRequests = null
    snapshot.modelUsages = []
    snapshot.quality = 'partial'
    return snapshot
  }
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const todayStart = start.getTime()
  const todays = logs.filter((l) => l.ts >= todayStart)
  const todayTokens = todays.reduce((s, l) => s + (l.tokens || 0), 0)
  const todayRequests = todays.reduce((s, l) => s + (l.requests ?? 0), 0)
  const byModel: Record<string, { tokens: number; cost: number }> = {}
  for (const l of todays) {
    const m = (byModel[l.model] ??= { tokens: 0, cost: 0 })
    m.tokens += l.tokens || 0
  }
  snapshot.todayTokens = todayTokens
  snapshot.todayRequests = todayRequests
  snapshot.modelUsages = (Object.entries(byModel) as [string, { tokens: number; cost: number }][]).map(
    ([model, v]) => ({ model, tokens: v.tokens, cost: v.cost }) satisfies ModelUsage,
  )
  snapshot.quality = 'verified' // 已有精确用量来源
  return snapshot
}

/** 对单站采集，外层套 perSiteLock 互斥（P1-2）。 */
export function collectSite(site: SiteConfig, channel: Channel): Promise<CollectResult> {
  return acquireSiteLock(site.id, () => doCollect(site, channel))
}

/** 采集全部启用站点（手动「立即同步」/ 定时 alarm 共用）。 */
export async function collectAllEnabled(channel: Channel): Promise<CollectResult[]> {
  const sites = (await siteRepo.list()).filter((s) => s.enabled)
  return Promise.all(sites.map((s) => collectSite(s, channel)))
}

/** 采集指定站点（侧边栏选择性同步）。 */
export async function collectSpecific(siteIds: string[], channel: Channel): Promise<CollectResult[]> {
  const sites = (await siteRepo.list()).filter((s) => siteIds.includes(s.id) && s.enabled)
  return Promise.all(sites.map((s) => collectSite(s, channel)))
}
