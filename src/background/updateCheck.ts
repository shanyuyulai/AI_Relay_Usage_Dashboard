import { settingsRepo } from '../storage/config'

/**
 * 自动检测更新（方案 051）。
 *
 * - 数据源：GitHub Releases API `releases/latest`（公开只读，不带凭证、不上传本地数据）。
 * - 节奏：12h 周期 alarm 唤醒 SW 检查；SW 启动也检查，但两次真实网络请求最小间隔 6h。
 * - 提示：系统通知（每版本仅一次，点击打开发布页）+ 极简面板/侧边栏页内横幅（可忽略）。
 * - 不自动下载/安装：点击只打开 releases 页由用户手动下载更新。
 * - 开关 `aihub.updateCheckEnabled` 默认开启；插件整体停用时不建 alarm、不检查。
 */

export const REPO = 'shanyuyulai/AI_Relay_Usage_Dashboard'
export const RELEASES_URL = `https://github.com/${REPO}/releases`
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`
export const UPDATE_CHECK_ALARM = 'aihub-update-check'
const CHECK_PERIOD_MIN = 720 // 12 小时
const MIN_CHECK_GAP_MS = 6 * 3600 * 1000 // 两次真实网络检查最小间隔（节流）

const ENABLED_KEY = 'aihub.updateCheckEnabled'
const LAST_CHECK_KEY = 'aihub.updateLastCheckAt'
const LATEST_KEY = 'aihub.updateLatestVersion'
const LATEST_URL_KEY = 'aihub.updateLatestUrl'
const LATEST_PUBLISHED_KEY = 'aihub.updateLatestPublishedAt'
const NOTIFIED_KEY = 'aihub.updateNotifiedVersion'
const DISMISSED_KEY = 'aihub.updateDismissedVersion'

const NOTIFY_ID = 'aihub-update'

export async function isUpdateCheckEnabled(): Promise<boolean> {
  const v = await settingsRepo.get<boolean>(ENABLED_KEY)
  return v !== false // 缺省开启
}

export async function setUpdateCheckEnabled(v: boolean): Promise<void> {
  await settingsRepo.set(ENABLED_KEY, v === true)
}

export function currentVersion(): string {
  try {
    return chrome.runtime.getManifest().version
  } catch {
    return '0'
  }
}

/** 'v0.6.0-beta.1' → [0,6,0]（忽略预发布后缀）；无法解析返回 null。 */
export function parseVersion(tag: string): number[] | null {
  const m = /^v?(\d+(?:\.\d+){0,3})/.exec((tag ?? '').trim())
  if (!m) return null
  return m[1].split('.').map((x) => parseInt(x, 10) || 0)
}

/** a 是否比 b 新（逐段数值比较，缺段按 0）。 */
export function isNewerVersion(a: string, b: string): boolean {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return false
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

export interface UpdateCheckStatus {
  enabled: boolean
  currentVersion: string
  latestVersion: string | null
  latestUrl: string | null
  latestPublishedAt: number | null
  hasUpdate: boolean
  /** 用户已忽略当前最新版本（横幅不显示，状态仍如实返回）。 */
  dismissed: boolean
  lastCheckedAt: number | null
  releasesUrl: string
}

async function readStatus(): Promise<UpdateCheckStatus> {
  const [enabled, last, latest, url, published, dismissed] = await Promise.all([
    isUpdateCheckEnabled().catch(() => false),
    settingsRepo.get<number>(LAST_CHECK_KEY).catch(() => null),
    settingsRepo.get<string>(LATEST_KEY).catch(() => null),
    settingsRepo.get<string>(LATEST_URL_KEY).catch(() => null),
    settingsRepo.get<number>(LATEST_PUBLISHED_KEY).catch(() => null),
    settingsRepo.get<string>(DISMISSED_KEY).catch(() => null),
  ])
  const cur = currentVersion()
  const hasUpdate = !!latest && isNewerVersion(latest, cur)
  return {
    enabled,
    currentVersion: cur,
    latestVersion: latest ?? null,
    latestUrl: url ?? null,
    latestPublishedAt: typeof published === 'number' ? published : null,
    hasUpdate,
    dismissed: hasUpdate && dismissed === latest,
    lastCheckedAt: typeof last === 'number' ? last : null,
    releasesUrl: RELEASES_URL,
  }
}

/** 组装状态（不发起网络请求）。 */
export async function getUpdateStatus(): Promise<UpdateCheckStatus> {
  return readStatus()
}

/** 忽略当前最新版本（横幅不再显示；同版本不再弹通知）。 */
export async function dismissUpdate(): Promise<void> {
  const latest = await settingsRepo.get<string>(LATEST_KEY).catch(() => null)
  if (latest) await settingsRepo.set(DISMISSED_KEY, latest)
}

async function notifyUpdate(latest: string, cur: string): Promise<void> {
  try {
    if (!chrome.notifications) return
    const granted = await chrome.permissions.contains({ permissions: ['notifications'] })
    if (!granted) return
    await chrome.notifications.create(NOTIFY_ID, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icon-128.png'),
      title: 'AI 中转站用量看板 · 有新版本',
      message: `最新版本 ${latest}（当前 ${cur}），点击前往发布页下载更新。`,
      priority: 2,
      requireInteraction: false,
    })
  } catch {
    /* 通知失败不阻断主流程 */
  }
}

/**
 * 执行一次版本检查。force=true 绕过开关与节流（设置页「立即检查」）。
 * 网络失败静默（仅更新 lastCheckedAt，不覆盖已知的 latest 状态）。
 */
export async function checkForUpdate(force = false): Promise<UpdateCheckStatus> {
  if (!force && !(await isUpdateCheckEnabled())) return readStatus()
  if (!force) {
    const last = await settingsRepo.get<number>(LAST_CHECK_KEY).catch(() => null)
    if (typeof last === 'number' && Date.now() - last < MIN_CHECK_GAP_MS) return readStatus()
  }

  let latest: string | null = null
  let url: string | null = null
  let published: number | null = null
  try {
    const res = await fetch(API_LATEST, { headers: { Accept: 'application/vnd.github+json' } })
    if (res.ok) {
      const j = (await res.json()) as { tag_name?: unknown; html_url?: unknown; published_at?: unknown }
      if (typeof j.tag_name === 'string' && j.tag_name.trim()) latest = j.tag_name.trim()
      if (typeof j.html_url === 'string' && /^https:\/\/github\.com\//.test(j.html_url)) url = j.html_url
      if (typeof j.published_at === 'string') {
        const t = Date.parse(j.published_at)
        if (!Number.isNaN(t)) published = t
      }
    }
  } catch {
    /* GitHub 不可达：静默，下轮再试 */
  }

  await settingsRepo.set(LAST_CHECK_KEY, Date.now())
  if (latest) {
    await settingsRepo.set(LATEST_KEY, latest)
    await settingsRepo.set(LATEST_URL_KEY, url) // 允许 null：回退到 RELEASES_URL
    await settingsRepo.set(LATEST_PUBLISHED_KEY, published)
    const cur = currentVersion()
    if (isNewerVersion(latest, cur) && (await isUpdateCheckEnabled())) {
      const notified = await settingsRepo.get<string>(NOTIFIED_KEY).catch(() => null)
      if (notified !== latest) {
        await settingsRepo.set(NOTIFIED_KEY, latest)
        await notifyUpdate(latest, cur)
      }
    }
  }
  return readStatus()
}

/** 系统通知点击 → 打开 releases 页（用户下载更新）。 */
export function setupUpdateCheck(): void {
  if (!chrome.notifications?.onClicked) return
  chrome.notifications.onClicked.addListener((id) => {
    if (id !== NOTIFY_ID) return
    void chrome.tabs.create({ url: RELEASES_URL }).catch(() => {})
  })
}

/** 使更新检查 alarm 与开关/插件启用态一致（幂等，SW 启动与开关切换时调用）。 */
export async function reconcileUpdateCheckAlarm(enabled: boolean): Promise<void> {
  if (!chrome.alarms) return
  if (!enabled) {
    await chrome.alarms.clear(UPDATE_CHECK_ALARM)
    return
  }
  const existing = await chrome.alarms.get(UPDATE_CHECK_ALARM)
  if (!existing || existing.periodInMinutes !== CHECK_PERIOD_MIN) {
    if (existing) await chrome.alarms.clear(UPDATE_CHECK_ALARM)
    await chrome.alarms.create(UPDATE_CHECK_ALARM, { periodInMinutes: CHECK_PERIOD_MIN })
  }
}
