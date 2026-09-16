/** Anonymous same-origin website icons. No permissions are requested here. */
const ICON_LIMIT = 128 * 1024
const HTML_LIMIT = 256 * 1024
const tasks = new Map<string, IconTask>()
interface IconTask { controller: AbortController; result: Promise<string | null>; users: number; settled: boolean; expires: number }
let active = 0
const queue: Array<() => void> = []
function pump() { while (active < 4 && queue.length) queue.shift()!() }
function schedule(work: () => Promise<string | null>): Promise<string | null> {
  return new Promise((resolve) => {
    queue.push(() => {
      active++
      void Promise.resolve().then(work).then(resolve, () => resolve(null)).finally(() => { active--; pump() })
    })
    pump()
  })
}
export function iconOrigin(value: string): string | null {
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.origin : null
  } catch { return null }
}
export function iconCandidate(href: string, origin: string): string | null {
  try {
    const url = new URL(href, origin + '/')
    if (iconOrigin(url.href) !== origin) return null
    url.hash = ''
    return url.href
  } catch { return null }
}
function decodeAttribute(value: string): string {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#x[0-9a-f]+|#[0-9]+);/gi, (entity) => {
    const named: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' }
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()]
    const hex = entity.slice(0, 3).toLowerCase() === '&#x'
    const code = parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10)
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
  })
}
export function declaredIcons(html: string, origin: string): string[] {
  // Scan link tags only. Never parse an entire remote document into browser DOM:
  // even "inert" DOMParser documents can initiate img/iframe resource requests.
  const urls: string[] = []
  const tags = html.match(/<link\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi) ?? []
  for (const tag of tags) {
    const attrs: Record<string, string> = {}
    const attributes = /([a-z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi
    for (const match of tag.matchAll(attributes)) {
      const key = match[1].toLowerCase()
      if (!(key in attrs)) attrs[key] = decodeAttribute(match[2] ?? match[3] ?? match[4] ?? '')
    }
    const rel = (attrs.rel ?? '').toLowerCase().split(/\s+/)
    if (!attrs.href || (!rel.includes('icon') && !rel.includes('apple-touch-icon'))) continue
    const url = iconCandidate(attrs.href, origin)
    if (url && !urls.includes(url) && url !== origin + '/favicon.ico') urls.push(url)
    if (urls.length === 3) break
  }
  return urls
}
export async function readLimited(response: Response, max: number): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length')) > max) {
    await response.body?.cancel()
    throw new Error('icon resource too large')
  }
  if (!response.body) throw new Error('empty resource')
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > max) throw new Error('icon resource too large')
      parts.push(value)
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error }
  finally { reader.releaseLock() }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const part of parts) { bytes.set(part, offset); offset += part.length }
  return bytes
}
function renderIcon(bytes: Uint8Array, type: string, signal: AbortSignal): Promise<string | null> {
  if (signal.aborted) return Promise.resolve(null)
  return new Promise((resolve) => {
    const blob = new Blob([bytes as BlobPart], { type })
    const url = URL.createObjectURL(blob)
    const image = new Image()
    const finish = (value: string | null) => {
      image.onload = image.onerror = null
      signal.removeEventListener('abort', cancel)
      image.src = ''
      URL.revokeObjectURL(url)
      resolve(value)
    }
    const cancel = () => finish(null)
    signal.addEventListener('abort', cancel, { once: true })
    image.onerror = cancel
    image.onload = () => {
      try {
        if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth > 4096 || image.naturalHeight > 4096) return finish(null)
        const scale = Math.min(64 / image.naturalWidth, 64 / image.naturalHeight, 1)
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
        const ctx = canvas.getContext('2d')
        if (!ctx) return finish(null)
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
        finish(canvas.toDataURL('image/png'))
      } catch { finish(null) }
    }
    image.src = url
  })
}
async function resource(url: string, signal: AbortSignal): Promise<Response> {
  const response = await fetch(url, { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal })
  if (!response.ok) { await response.body?.cancel(); throw new Error('icon resource unavailable') }
  return response
}
async function fetchIcon(url: string, signal: AbortSignal): Promise<string | null> {
  if (signal.aborted) return null
  try {
    const response = await resource(url, signal)
    const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/avif', 'application/octet-stream'].includes(type)) {
      await response.body?.cancel(); return null
    }
    return await renderIcon(await readLimited(response, ICON_LIMIT), type, signal)
  } catch { return null }
}
async function resolveIcon(origin: string, controller: AbortController): Promise<string | null> {
  const { signal } = controller
  if (signal.aborted) return null
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    if (typeof chrome === 'undefined' || !await chrome.permissions.contains({ origins: [origin + '/*'] }) || signal.aborted) return null
    const conventional = await fetchIcon(origin + '/favicon.ico', signal)
    if (conventional || signal.aborted) return conventional
    const page = await resource(origin + '/', signal)
    if (!(page.headers.get('content-type') ?? '').toLowerCase().includes('text/html')) { await page.body?.cancel(); return null }
    const html = new TextDecoder().decode(await readLimited(page, HTML_LIMIT))
    for (const url of declaredIcons(html, origin)) {
      if (signal.aborted) return null
      const icon = await fetchIcon(url, signal)
      if (icon) return icon
    }
    return null
  } catch { return null }
  finally { clearTimeout(timer) }
}
function trimCache() {
  const completed = [...tasks].filter(([, value]) => value.settled)
  for (const [key] of completed.slice(0, Math.max(0, completed.length - 64))) tasks.delete(key)
}
/** Caller must release on origin change/unmount. PNG data URLs never contain remote markup. */
export function subscribeSiteIcon(value: string): { result: Promise<string | null>; release: () => void } {
  const origin = iconOrigin(value)
  if (!origin) return { result: Promise.resolve(null), release() {} }
  let task = tasks.get(origin)
  if (task?.settled && task.expires <= Date.now()) { tasks.delete(origin); task = undefined }
  if (!task) {
    const controller = new AbortController()
    task = { controller, users: 0, settled: false, expires: Infinity, result: Promise.resolve(null) }
    const current = task
    tasks.set(origin, current)
    current.result = schedule(() => resolveIcon(origin, controller)).then((icon) => {
      current.settled = true
      current.expires = Date.now() + (icon ? 30 * 60_000 : 5 * 60_000)
      trimCache()
      return icon
    })
  }
  const current = task
  current.users++
  let released = false
  return { result: current.result, release() {
    if (released) return
    released = true
    current.users--
    if (!current.users && !current.settled) {
      current.controller.abort()
      if (tasks.get(origin) === current) tasks.delete(origin)
    }
  } }
}
