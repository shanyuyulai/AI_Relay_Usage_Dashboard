/**
 * 基于 chrome.webRequest 的网络请求发现（MV3）。
 *
 * 背景：页面主世界 hook fetch/XHR 的方案在 tab reload 后会丢失 hook，
 * 且 SPA 初始化请求常在 reinstall hook 之前完成，导致捕获为空。
 * webRequest 在 Service Worker 中监听，不依赖页面脚本注入时机，更可靠。
 *
 * 仅记录元数据（URL/方法/状态码/Content-Type），不记录 Cookie、Authorization、请求体、响应体（P0-2）。
 */

export interface NetDiscoveryRequest {
  url: string
  method: string
  statusCode: number
  contentType: string | null
  type: string
  timestamp: number
}

interface ActiveSession {
  origin: string
  requests: NetDiscoveryRequest[]
  resolve: (value: NetDiscoveryRequest[]) => void
  timer: ReturnType<typeof setTimeout>
  keepAliveAlarm: string
}

const sessions = new Map<string, ActiveSession>()
let listenerRegistered = false

function normalizeContentType(headers: chrome.webRequest.HttpHeader[] | undefined): string | null {
  if (!headers) return null
  const h = headers.find((h) => h.name.toLowerCase() === 'content-type')
  return h?.value ?? null
}

function onCompleted(details: chrome.webRequest.WebResponseCacheDetails) {
  for (const session of sessions.values()) {
    const reqUrl = new URL(details.url)
    const sessionUrl = new URL(session.origin)
    if (reqUrl.origin !== sessionUrl.origin) continue

    session.requests.push({
      url: details.url,
      method: details.method,
      statusCode: details.statusCode,
      contentType: normalizeContentType(details.responseHeaders),
      type: details.type,
      timestamp: details.timeStamp,
    })
  }
}

function ensureListener() {
  if (listenerRegistered) return
  // 监听所有请求，按 session.origin 在回调里过滤；filter 不能动态变，所以用 <all_urls> 但只在有 host 权限的域生效
  chrome.webRequest.onCompleted.addListener(
    onCompleted,
    { urls: ['<all_urls>'] },
    ['responseHeaders'],
  )
  listenerRegistered = true
}

/**
 * 在指定时长内监听目标 origin 的网络请求，返回按 JSON/API 可能性排序的元数据列表。
 * @param origin 目标站点 origin，如 https://api.example.com
 * @param durationMs 监听时长（毫秒）
 * @param reloadTabId 可选：开始监听前刷新该标签页，以触发 SPA 初始化请求
 */
export async function discoverNetworkRequests(
  origin: string,
  durationMs: number,
  reloadTabId?: number,
): Promise<NetDiscoveryRequest[]> {
  ensureListener()

  // 避免同一 origin 并发发现导致结果混淆
  if (sessions.has(origin)) {
    throw new Error('该站点正在进行网络发现，请等待上一轮结束')
  }

  if (reloadTabId != null) {
    await chrome.tabs.reload(reloadTabId)
  }

  const keepAliveAlarm = `net-discovery-keepalive-${origin.replace(/[^a-z0-9]/gi, '-')}`
  // 用 alarms 周期唤醒 Service Worker，防止长监听期间 SW 因空闲被终止（setTimeout 不能保活）
  try {
    await chrome.alarms.create(keepAliveAlarm, { periodInMinutes: 0.05 })
  } catch {
    /* 失败也不阻断发现 */
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const session = sessions.get(origin)
      if (!session) return
      sessions.delete(origin)
      cleanupAlarm(session.keepAliveAlarm)
      resolve(rankRequests(session.requests))
    }, durationMs)

    sessions.set(origin, {
      origin,
      requests: [],
      resolve: (requests) => {
        clearTimeout(timer)
        sessions.delete(origin)
        cleanupAlarm(keepAliveAlarm)
        resolve(rankRequests(requests))
      },
      timer,
      keepAliveAlarm,
    })
  })
}

function cleanupAlarm(name: string) {
  try {
    chrome.alarms.clear(name)
  } catch {
    /* ignore */
  }
}

/**
 * 提前结束某 origin 的发现会话（如用户手动触发足够请求后）。
 */
export function finishDiscoveryEarly(origin: string): NetDiscoveryRequest[] | null {
  const session = sessions.get(origin)
  if (!session) return null
  clearTimeout(session.timer)
  sessions.delete(origin)
  cleanupAlarm(session.keepAliveAlarm)
  const ranked = rankRequests(session.requests)
  session.resolve(ranked)
  return ranked
}

function rankRequests(requests: NetDiscoveryRequest[]): NetDiscoveryRequest[] {
  return requests
    .slice()
    .sort((a, b) => {
      // JSON / API 候选优先
      const aJson = (a.contentType?.includes('json') ?? false) ? 1 : 0
      const bJson = (b.contentType?.includes('json') ?? false) ? 1 : 0
      if (aJson !== bJson) return bJson - aJson
      // 200 / 401 / 403 优先于 404 / 0
      const aGood = a.statusCode === 200 || a.statusCode === 401 || a.statusCode === 403 ? 1 : 0
      const bGood = b.statusCode === 200 || b.statusCode === 401 || b.statusCode === 403 ? 1 : 0
      if (aGood !== bGood) return bGood - aGood
      // 最新优先
      return b.timestamp - a.timestamp
    })
    .filter((r) => {
      // 过滤掉静态资源，保留 API 嫌疑请求
      const ct = r.contentType ?? ''
      const isStatic =
        ct.startsWith('text/html') ||
        ct.startsWith('text/css') ||
        ct.startsWith('application/javascript') ||
        ct.startsWith('image/') ||
        ct.startsWith('font/') ||
        r.url.match(/\.(js|css|png|jpg|jpeg|gif|svg|woff|woff2|ttf|ico)(\?.*)?$/i) != null
      return !isStatic
    })
}
