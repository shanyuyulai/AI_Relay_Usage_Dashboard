import { CollectError } from './contracts'
import { hashResponse } from '../../shared/parse'

/**
 * 同域 fetch：credentials:'include' 自动带该 origin 的 cookie（P0-1），不再手设 Cookie 受限头。
 * 额外接受 cookieString 作为 MV3 SW 的兜底：平台可能不自动附带 cookie，此时尝试手动注入。
 * 统一错误分类：
 *   401/403 → AUTH_EXPIRED（登录态失效）
 *   404     → NOT_FOUND（接口路径变更）
 *   其他非 2xx → NETWORK
 *   超时/网络异常 → NETWORK
 *   响应非 JSON → PARSE（带脱敏诊断，P1-1）
 */
export async function fetchJson(
  url: string,
  siteId: string,
  cookieString?: string,
  timeoutMs = 10000,
): Promise<unknown> {
  const startTime = Date.now()
  console.log(`[AI Relay][http] → GET ${url}`)
  if (cookieString) {
    console.log(`[AI Relay][http]   cookieString 长度=${cookieString.length} (前50字符: ${cookieString.slice(0, 50)}…)`)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  // 构造请求头：如果提供了 cookieString，尝试手动注入 Cookie 头
  // 注意：浏览器 fetch 的 Cookie 头为禁止头（forbidden header），Chrome 可能静默剥离。
  // 我们仍然设置它作为兜底——如果被剥离，则依赖 credentials:'include' 的自动行为。
  const headers: Record<string, string> = { Accept: 'application/json' }
  const cookieHeaderSet = !!cookieString
  if (cookieString) {
    headers['Cookie'] = cookieString
  }

  let res: Response
  try {
    res = await fetch(url, {
      credentials: 'include',
      headers,
      signal: controller.signal,
    })
  } catch (e) {
    clearTimeout(timer)
    const ms = Date.now() - startTime
    if ((e as { name?: string })?.name === 'AbortError') {
      console.error(`[AI Relay][http] ✗ ${url} TIMEOUT (${ms}ms)`)
      throw new CollectError('NETWORK', `请求超时(${timeoutMs}ms): ${url}`, siteId)
    }
    console.error(`[AI Relay][http] ✗ ${url} NETWORK_ERROR (${ms}ms): ${(e as Error).message}`)
    throw new CollectError('NETWORK', `网络错误: ${url} (${(e as Error).message})`, siteId)
  }
  clearTimeout(timer)
  const ms = Date.now() - startTime

  console.log(`[AI Relay][http] ← ${url} HTTP ${res.status} (${ms}ms) content-type=${res.headers.get('content-type') || '?'}`)

  // 401/403 时，如果提供了 cookieString 但未被使用，给出提示
  if ((res.status === 401 || res.status === 403) && cookieHeaderSet) {
    console.warn(`[AI Relay][http] ⚠ 收到 ${res.status}，已尝试手动注入 Cookie（${cookieString!.length} 字符）。如 Cookie 头被 Chrome 剥离，请确认已登录该站点。`)
    throw new CollectError('AUTH_EXPIRED', `鉴权失效 ${res.status}: ${url}`, siteId)
  }

  if (res.status === 401 || res.status === 403) {
    throw new CollectError('AUTH_EXPIRED', `鉴权失效 ${res.status}: ${url}`, siteId)
  }
  if (res.status === 404) {
    throw new CollectError('NOT_FOUND', `接口不存在 404: ${url}`, siteId)
  }
  if (!res.ok) {
    throw new CollectError('NETWORK', `HTTP ${res.status}: ${url}`, siteId)
  }

  const text = await res.text()
  try {
    const json = text ? JSON.parse(text) : null
    // 诊断：打印响应顶层 key 列表（不含值，避免泄露）
    if (json && typeof json === 'object' && !Array.isArray(json)) {
      const keys = Object.keys(json as Record<string, unknown>)
      console.log(`[AI Relay][http]  响应顶层字段: [${keys.join(', ')}]`)
    }
    return json
  } catch {
    // 打印响应前 300 字符辅助诊断
    const preview = text.length > 300 ? text.slice(0, 300) + '…' : text
    console.error(`[AI Relay][http] ✗ ${url} 响应非 JSON，前300字符: ${preview}`)
    throw new CollectError(
      'PARSE',
      `响应非 JSON: ${url}`,
      siteId,
      {
        endpoint: url,
        statusCode: res.status,
        responseHash: hashResponse(text),
        apiVersion: null,
      },
    )
  }
}
