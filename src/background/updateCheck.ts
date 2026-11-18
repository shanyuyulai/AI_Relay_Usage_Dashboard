import { settingsRepo } from '../storage/config'

/**
 * 自动检测更新（方案 051；方案 058 增加 Gitee 国内镜像源）。
 *
 * - 数据源：Gitee 镜像仓库 Tags API 优先（国内可达），不可达时回退 GitHub Tags API；
 *   两者均为公开只读，不带凭证、不上传本地数据。仓库以 tags 标记版本，
 *   不使用 Releases，因此取标签列表中语义化版本号最大的一个作为「最新版本」。
 * - 判定：远端最新版本**比本地新**才提醒（逐段数值比较；仅版本号不同但更旧时不提示）。
 * - 节奏：12h 周期 alarm 唤醒 SW 检查；SW 启动也检查，但两次真实网络请求最小间隔 6h。
 * - 提示：系统通知（每版本仅一次，点击打开版本页）+ 极简面板/侧边栏页内横幅（可忽略）。
 * - 不自动下载/安装：点击只打开命中源的版本页（tags）由用户手动下载更新。
 * - 开关 `aihub.updateCheckEnabled` 默认开启；插件整体停用时不建 alarm、不检查。
 */

export const REPO = 'shanyuyulai/AI_Relay_Usage_Dashboard'
/** GitHub 版本页（tags，列出所有版本）：Gitee 不可用时的回退地址。 */
export const TAGS_URL = `https://github.com/${REPO}/tags`
const API_TAGS = `https://api.github.com/repos/${REPO}/tags?per_page=100`
/**
 * Gitee 镜像（方案 058）：与 .github/workflows/mirror-gitee.yml 的 GITEE_REPO 保持一致。
 * Gitee 仓库尚不存在时该源会失败并自动回退 GitHub，不影响主链路。
 */
export const GITEE_REPO = 'shanyuyulai/AI_Relay_Usage_Dashboard'
export const GITEE_TAGS_URL = `https://gitee.com/${GITEE_REPO}/tags`
const API_GITEE_TAGS = `https://gitee.com/api/v5/repos/${GITEE_REPO}/tags?per_page=100`

/** 命中源：gitee=国内镜像，github=原始仓库，null=尚未成功检查。 */
export type UpdateSource = 'gitee' | 'github'
const SOURCES: Array<{ id: UpdateSource; api: string; tagsUrl: string; accept?: string }> = [
  { id: 'gitee', api: API_GITEE_TAGS, tagsUrl: GITEE_TAGS_URL },
  { id: 'github', api: API_TAGS, tagsUrl: TAGS_URL, accept: 'application/vnd.github+json' },
]
const SOURCE_TIMEOUT_MS = 5000
export const UPDATE_CHECK_ALARM = 'aihub-update-check'
const CHECK_PERIOD_MIN = 720 // 12 小时
const MIN_CHECK_GAP_MS = 6 * 3600 * 1000 // 两次真实网络检查最小间隔（节流）

const ENABLED_KEY = 'aihub.updateCheckEnabled'
const LAST_CHECK_KEY = 'aihub.updateLastCheckAt'
const LATEST_KEY = 'aihub.updateLatestVersion'
const LATEST_URL_KEY = 'aihub.updateLatestUrl'
const LATEST_PUBLISHED_KEY = 'aihub.updateLatestPublishedAt'
const SOURCE_KEY = 'aihub.updateSource'
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
  /** 版本页地址（tags，列出所有版本）：随命中源切换。 */
  tagsUrl: string
  /** 命中源：gitee / github / null（方案 058）。 */
  source: UpdateSource | null
}

/** 只接受 github.com / gitee.com 的 tags 页地址，清洗旧版 releases 链接或其他来源。 */
function safeTagsUrl(url: string | null | undefined): string | null {
  if (!url) return null
  return /^https:\/\/(?:github|gitee)\.com\/[^/]+\/[^/]+\/tags(?:[/?#]|$)/.test(url) ? url : null
}

async function readStatus(): Promise<UpdateCheckStatus> {
  const [enabled, last, latest, url, published, srcRaw, dismissed] = await Promise.all([
    isUpdateCheckEnabled().catch(() => false),
    settingsRepo.get<number>(LAST_CHECK_KEY).catch(() => null),
    settingsRepo.get<string>(LATEST_KEY).catch(() => null),
    settingsRepo.get<string>(LATEST_URL_KEY).catch(() => null),
    settingsRepo.get<number>(LATEST_PUBLISHED_KEY).catch(() => null),
    settingsRepo.get<string>(SOURCE_KEY).catch(() => null),
    settingsRepo.get<string>(DISMISSED_KEY).catch(() => null),
  ])
  const cur = currentVersion()
  // 口径：远端最新版本比本地新才提醒（0.5.0 < 0.5.1 这类「远端更旧」不提示）
  const hasUpdate = !!latest && isNewerVersion(latest, cur)
  const source: UpdateSource | null = srcRaw === 'gitee' || srcRaw === 'github' ? srcRaw : null
  const safeUrl = safeTagsUrl(url)
  const tagsUrl = safeUrl ?? (source === 'gitee' ? GITEE_TAGS_URL : TAGS_URL)
  return {
    enabled,
    currentVersion: cur,
    latestVersion: latest ?? null,
    latestUrl: safeUrl,
    latestPublishedAt: typeof published === 'number' ? published : null,
    hasUpdate,
    dismissed: hasUpdate && dismissed === latest,
    lastCheckedAt: typeof last === 'number' ? last : null,
    tagsUrl,
    source,
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
  let source: UpdateSource | null = null
  // Tags API 不含发布日期，published 仅为状态兼容字段
  const published: number | null = null

  // 058：Gitee 优先（国内可达），失败/超时回退 GitHub；两源都失败才静默保留旧状态
  for (const s of SOURCES) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS)
    try {
      const res = await fetch(s.api, {
        signal: controller.signal,
        ...(s.accept ? { headers: { Accept: s.accept } } : {}),
      })
      if (!res.ok) continue
      // Tags API 返回数组（不含日期/发布说明），取语义化版本号最大的标签为「最新版本」
      const arr = (await res.json()) as unknown
      if (!Array.isArray(arr)) continue
      let bestVer: number[] | null = null
      let bestName: string | null = null
      for (const item of arr) {
        const name = (item as { name?: unknown })?.name
        if (typeof name !== 'string' || !name.trim()) continue
        const v = parseVersion(name)
        if (!v) continue
        if (!bestVer || compareVersions(v, bestVer) > 0) {
          bestVer = v
          bestName = name.trim()
        }
      }
      if (bestName) {
        latest = bestName
        url = s.tagsUrl
        source = s.id
        break
      }
    } catch {
      /* 当前源不可达/超时：继续尝试下一源 */
    } finally {
      clearTimeout(timer)
    }
  }

  await settingsRepo.set(LAST_CHECK_KEY, Date.now())
  if (latest && source) {
    await settingsRepo.set(LATEST_KEY, latest)
    await settingsRepo.set(LATEST_URL_KEY, url)
    await settingsRepo.set(LATEST_PUBLISHED_KEY, published)
    await settingsRepo.set(SOURCE_KEY, source)
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

/** 系统通知点击 → 打开版本页（tags，用户下载更新）。 */
export function setupUpdateCheck(): void {
  if (!chrome.notifications?.onClicked) return
  chrome.notifications.onClicked.addListener((id) => {
    if (id !== NOTIFY_ID) return
    void chrome.tabs.create({ url: TAGS_URL }).catch(() => {})
  })
  // 一次性迁移：旧版（Releases API 时代）遗留的缓存（latest=旧版本 + …/releases/tag/… 地址）
  // 会导致节流期内显示错误状态并跳旧地址 → 检测到即清空，下轮检查重新拉取 tags 数据。
  void (async () => {
    try {
      const url = await settingsRepo.get<string>(LATEST_URL_KEY).catch(() => null)
      if (typeof url === 'string' && /github\.com\/.+\/releases/.test(url)) {
        await Promise.all([
          settingsRepo.remove(LATEST_KEY),
          settingsRepo.remove(LATEST_URL_KEY),
          settingsRepo.remove(LATEST_PUBLISHED_KEY),
          settingsRepo.remove(SOURCE_KEY),
          settingsRepo.remove(NOTIFIED_KEY),
          settingsRepo.remove(DISMISSED_KEY),
        ])
      }
    } catch {
      /* 迁移失败不影响主流程 */
    }
  })()
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
