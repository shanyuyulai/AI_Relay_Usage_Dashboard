import { settingsRepo } from '../storage/config'

/**
 * 自动检测更新（方案 051）。
 *
 * - 数据源：GitHub Tags API（公开只读，不带凭证、不上传本地数据）。仓库以 tags 标记版本，
 *   不使用 GitHub Releases，因此取标签列表中语义化版本号最大的一个作为「最新版本」。
 * - 判定：远端最新版本与本地版本**不一致**即视为需要更新（用户指定的口径）。
 * - 节奏：12h 周期 alarm 唤醒 SW 检查；SW 启动也检查，但两次真实网络请求最小间隔 6h。
 * - 提示：系统通知（每版本仅一次，点击打开版本页）+ 极简面板/侧边栏页内横幅（可忽略）。
 * - 不自动下载/安装：点击只打开版本页（tags）由用户手动下载更新。
 * - 开关 `aihub.updateCheckEnabled` 默认开启；插件整体停用时不建 alarm、不检查。
 */

export const REPO = 'shanyuyulai/AI_Relay_Usage_Dashboard'
/** 版本页（tags，列出所有版本）：横幅 / 通知 / 「打开版本页」统一跳这里。 */
export const TAGS_URL = `https://github.com/${REPO}/tags`
const API_TAGS = `https://api.github.com/repos/${REPO}/tags?per_page=100`
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
  return compareVersions(parseVersion(a), parseVersion(b)) > 0
}

/** 逐段数值比较：a>b → 1，a<b → -1，相等 → 0（null 视为不可比，返回 -2）。 */
export function compareVersions(a: number[] | null, b: number[] | null): number {
  if (!a || !b) return -2
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

/** 归一化版本串用于「一致性」比较：'v0.5.1' / '0.5.1' → '0.5.1'；无法解析返回 null。 */
export function normalizeVersion(tag: string): string | null {
  const p = parseVersion(tag)
  return p ? p.join('.') : null
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
  /** 版本页地址（tags，列出所有版本）。 */
  tagsUrl: string
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
  // 口径：远端最新版本与本地**不一致**即视为需要更新（用户指定，'v' 前缀差异归一化后忽略）
  const curNorm = normalizeVersion(cur)
  const latNorm = latest ? normalizeVersion(latest) : null
  const hasUpdate = !!latNorm && !!curNorm && latNorm !== curNorm
  return {
    enabled,
    currentVersion: cur,
    latestVersion: latest ?? null,
    latestUrl: url ?? null,
    latestPublishedAt: typeof published === 'number' ? published : null,
    hasUpdate,
    dismissed: hasUpdate && dismissed === latest,
    lastCheckedAt: typeof last === 'number' ? last : null,
    tagsUrl: TAGS_URL,
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
      message: `最新版本 ${latest}（当前 ${cur}），点击前往版本页下载更新。`,
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
    const res = await fetch(API_TAGS, { headers: { Accept: 'application/vnd.github+json' } })
    if (res.ok) {
      // Tags API 返回数组（不含日期/发布说明），取语义化版本号最大的标签为「最新版本」
      const arr = (await res.json()) as unknown
      if (Array.isArray(arr)) {
        let bestVer: number[] | null = null
        for (const item of arr) {
          const name = (item as { name?: unknown })?.name
          if (typeof name !== 'string' || !name.trim()) continue
          const v = parseVersion(name)
          if (!v) continue
          if (!bestVer || compareVersions(v, bestVer) > 0) {
            bestVer = v
            latest = name.trim()
          }
        }
      }
      if (latest) url = TAGS_URL // tags 无单独页面地址，统一跳版本页
    }
  } catch {
    /* GitHub 不可达：静默，下轮再试 */
  }

  await settingsRepo.set(LAST_CHECK_KEY, Date.now())
  if (latest) {
    await settingsRepo.set(LATEST_KEY, latest)
    await settingsRepo.set(LATEST_URL_KEY, url) // 允许 null：回退到 TAGS_URL
    await settingsRepo.set(LATEST_PUBLISHED_KEY, published)
    const cur = currentVersion()
    const hasUpdate = !!normalizeVersion(latest) && normalizeVersion(latest) !== normalizeVersion(cur)
    if (hasUpdate && (await isUpdateCheckEnabled())) {
      const notified = await settingsRepo.get<string>(NOTIFIED_KEY).catch(() => null)
      if (notified !== latest) {
        await settingsRepo.set(NOTIFIED_KEY, latest)
        await notifyUpdate(latest, cur)
      }
    }
  }
  return readStatus()
}

/** 系统通知点击 → 打开版本页（tags，用户下载更新）。 */
export function setupUpdateCheck(): void {
  if (!chrome.notifications?.onClicked) return
  chrome.notifications.onClicked.addListener((id) => {
    if (id !== NOTIFY_ID) return
    void chrome.tabs.create({ url: TAGS_URL }).catch(() => {})
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
