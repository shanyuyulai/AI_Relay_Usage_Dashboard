<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { send, MessagingError } from '../core/messaging/client'
import type { ExportConfig, ImportResult, ReorderSitesResponse } from '../core/messaging/protocol'
import type { SiteConfig, SiteStatus, CustomCaptureRecord, DiagnosticEntry, SiteCollectionProfile } from '../shared/types'
import type { ProbeResult } from '../content/probe'
import type { NetDiscoveryRequest } from '../background/netDiscovery'
import { normalizeOrigin, isValidSiteUrl } from '../shared/util'
import { ensureOriginPermission } from '../shared/permissions'
import { getThemeMode, setThemeMode, type ThemeMode } from '../shared/theme'
import { getLabShowDashboard, LAB_SHOWDASHBOARD_CHANGED } from '../storage'
import { registry } from '../adapters'
import { statusBadge } from '../shared/format'
import { shouldShowReauthorize } from '../core/authState'
import SiteForm from './components/SiteForm.vue'
import DataExplorer from './components/DataExplorer.vue'
import UsageDashboard from './components/UsageDashboard.vue'
import CollectionProfileCard from './components/CollectionProfileCard.vue'

// GPT P0：跨层错误白名单——绝不透传任何 Error.message 原文
// 异常消息可能包含 URL/响应片段/认证细节/内部实现，统一映射为固定中文文案。
// 即使是本地 Error（如 JSON 解析失败抛的 Error）也走白名单，避免引入未来字段携带敏感信息。
function safeUiError(_e: unknown): string {
  if (_e instanceof MessagingError) {
    if (_e.kind === 'TIMEOUT') return '请求超时，请稍后重试'
    if (_e.kind === 'NO_HANDLER') return '当前操作不可用'
    if (_e.kind === 'BAD_REQUEST') return '请求参数无效'
  }
  // 本地或跨层错误一律回退到通用文案；导入/解析错误的固定文案由调用方在 catch 旁显式传入
  return '操作失败，请检查站点状态后重试'
}

// 固定的本地错误文案（仅用于明确的本地场景，避免 catch 块写异常原文）
const ERR_INVALID_CONFIG = '配置文件格式无效'

// 仅配置界面通知：SW 经 runtime 消息推送页内提示（配置界面未打开则无接收端、自动丢弃）
function onOptionsNotify(msg: { type?: string; title?: string; message?: string; enabled?: boolean }, _sender: unknown, _sendResponse: unknown) {
  if (msg && msg.type === 'AIHUB_OPTIONS_NOTIFY') {
    showToast(`${msg.title ?? '提示'}：${msg.message ?? ''}`)
  } else if (msg && msg.type === LAB_SHOWDASHBOARD_CHANGED) {
    // 设置页内切换实验性「用量看板」开关：顶部 Tab 实时显隐（与侧边栏同源）
    labShowDashboard.value = msg.enabled === true
  }
}

// GPT P0：网络 URL 仅展示 pathname，不含 query/fragment（可能含 token、签名、会话标识）
function safeRequestPath(raw: string): string {
  try {
    const u = new URL(raw)
    return u.pathname
  } catch {
    return '受保护路径'
  }
}

const sites = ref<SiteConfig[]>([])
const loading = ref(false)
const toast = ref('')
const toastTimer = ref<number | null>(null)

// 用量看板 Tab 切换（Phase C）：'settings' = 站点管理 + 数据浏览器；'dashboard' = 用量看板
type OptsTab = 'settings' | 'dashboard'
const activeTab = ref<OptsTab>('settings')
const dashboardSiteId = ref<string | null>(null)
// 实验室「用量看板」开关：关闭时隐藏顶部「📊 用量看板」Tab（含完整用量看板页）
const labShowDashboard = ref(false)
// 实验室「用量看板」关闭时，若当前正停留在完整用量看板页，则回退到站点设置，避免无 Tab 可进的空白页
watch(labShowDashboard, (on) => {
  if (!on && activeTab.value === 'dashboard') activeTab.value = 'settings'
})

// 顶部 Tab 仅在有「用量看板」时才存在：单一切换按钮（站点设置/用量看板互切）。
// 去掉常驻且永远高亮的「⚙ 站点设置」按钮（默认即设置页，点击无副作用）。
function toggleDashboardTab() {
  activeTab.value = activeTab.value === 'settings' ? 'dashboard' : 'settings'
}
const dashboardTabLabel = computed(() =>
  activeTab.value === 'settings' ? '📊 用量看板' : '⚙ 站点设置',
)

// 弹窗状态
const formVisible = ref(false)
const editingSite = ref<SiteConfig | null>(null)
const helpVisible = ref(false)
const helpUrl = chrome.runtime.getURL('README.html')
const groupQrVisible = ref(false)
const groupQrUrl = chrome.runtime.getURL('qrcode_1102575547.png')

// 排序开关：临时编辑态，默认关闭、不持久化（GPT R1：排序结果已落库，无需持久化开关）
const sortMode = ref(false)
// 二级菜单唯一真值（hover/点击/键盘 都只走它；GPT P0-1）
const moreOpen = ref<string | null>(null)
function toggleMore(id: string) {
  moreOpen.value = moreOpen.value === id ? null : id
}
function onMoreItem(_site: SiteConfig, fn: () => void) {
  fn()
  moreOpen.value = null // 点完收起（含展开面板项，GPT R3/P1-4）
}
function closeMore() {
  moreOpen.value = null
}
// 首/末行边界：上移/下移按钮原生 disabled（GPT P1-2）
function canMoveUp(site: SiteConfig): boolean {
  return !reorderInFlight.value && sites.value.findIndex((s) => s.id === site.id) > 0
}
function canMoveDown(site: SiteConfig): boolean {
  const i = sites.value.findIndex((s) => s.id === site.id)
  return !reorderInFlight.value && i >= 0 && i < sites.value.length - 1
}
// 关闭排序开关时清理拖拽临时态（GPT P1-1）
watch(sortMode, (on) => {
  if (!on) resetDrag()
})
// 文档级外部点击收起菜单：单一监听，按 .more-wrap 判定（GPT P2-3）
function onDocClick(e: MouseEvent) {
  if (moreOpen.value && !(e.target as HTMLElement)?.closest?.('.more-wrap')) {
    moreOpen.value = null
  }
}

// 文件导入
const fileInput = ref<HTMLInputElement | null>(null)

const adapterMap = computed<Record<string, string>>(() => {
  const m: Record<string, string> = {}
  for (const a of registry.list()) m[a.id] = a.name
  return m
})

function showToast(msg: string) {
  toast.value = msg
  if (toastTimer.value) clearTimeout(toastTimer.value)
  toastTimer.value = window.setTimeout(() => (toast.value = ''), 3500)
}

async function loadSites() {
  loading.value = true
  try {
    sites.value = await send<SiteConfig[]>('GET_SITES')
    moreOpen.value = null // 刷新后旧 id 可能不存在，防悬空（GPT P2-2）
  } catch (e) {
    showToast(safeUiError(e))
  } finally {
    loading.value = false
  }
  // 并行加载采集方案模型（方案 028）；失败不阻断站点管理，降级显示「方案暂不可用」。
  void loadProfiles()
}

// ── 站点类型与采集方案可视化（方案 028）──
const profiles = ref<Record<string, SiteCollectionProfile>>({})
const profilesAvailable = ref(true) // profile 接口失败时降级
async function loadProfiles() {
  try {
    const res = await send<{ profiles: Record<string, SiteCollectionProfile> }>('GET_SITE_COLLECTION_PROFILES', {})
    profiles.value = res.profiles ?? {}
    profilesAvailable.value = true
  } catch {
    profilesAvailable.value = false
  }
}
function profileFor(site: SiteConfig): SiteCollectionProfile | null {
  return profiles.value[site.id] ?? null
}
// 独立于「自定义采集面板」的展开态，避免互相干扰（方案 028 §6 B5）。
const profileSiteId = ref<string | null>(null)
function toggleProfile(site: SiteConfig) {
  profileSiteId.value = profileSiteId.value === site.id ? null : site.id
}

// ── 采集方案展示用标签/摘要（方案 028 §3/§7）──
function typeLabel(p: SiteCollectionProfile): string {
  switch (p.classification.family) {
    case 'independent': return '独立接口'
    case 'new-api-capable': return 'New API 兼容'
    case 'one-api-compatible': return 'One API 兼容'
    default: return '待识别'
  }
}
function routeLabel(p: SiteCollectionProfile): string {
  switch (p.classification.routeProfile) {
    case 'standard': return '标准路径'
    case 'fork-path': return '变体路径'
    case 'discovered': return '网络发现'
    default: return ''
  }
}
function confLabel(p: SiteCollectionProfile): string {
  switch (p.classification.confidence) {
    case 'high': return '置信度：高'
    case 'medium': return '置信度：中'
    case 'low': return '置信度：低'
    default: return ''
  }
}
function engineLabel(p: SiteCollectionProfile): string {
  return p.execution.engine === 'sw_lab' ? '零标签实验室' : '页面会话'
}
function collectionSummaryText(p: SiteCollectionProfile): string {
  const verified = p.steps.filter((s) => s.state === 'verified').length
  if (!p.classification.probedAt) return '待探测'
  if (p.health.latestFailure?.reason === 'ACCOUNT_UNAUTHORIZED') return `${engineLabel(p)} · 需登录`
  if (p.health.lastStatus === 'error') return `${engineLabel(p)} · 采集异常`
  return `${engineLabel(p)} · 已验证 ${verified} 项`
}
function stepStateLabel(s: SiteCollectionProfile['steps'][number]['state']): string {
  switch (s) {
    case 'verified': return '已验证'
    case 'planned': return '计划尝试'
    case 'partial': return '部分可用'
    case 'unsupported': return '不支持'
    case 'unauthorized': return '需要登录'
    case 'failed': return '异常'
  }
}

function openAdd() {
  editingSite.value = null
  formVisible.value = true
}

function openEdit(site: SiteConfig) {
  editingSite.value = site
  formVisible.value = true
}

function openHelp() {
  helpVisible.value = true
}

function onFormSubmitted() {
  formVisible.value = false
  loadSites()
}

async function deleteSite(site: SiteConfig) {
  if (!confirm(`确定删除站点「${site.name}」？\n将同时清除其历史数据与域名权限。`)) return
  try {
    const res = await send<{ permissionsRevoked: boolean }>('DELETE_SITE', { id: site.id })
    // SW 做引用计数：仅当无其他站点使用该 origin 时才撤销权限（以 IndexedDB 为权威，防 UI 快照过时）
    if (res.permissionsRevoked) {
      try {
        await chrome.permissions.remove({ origins: [`${site.origin}/*`] })
      } catch {
        /* 权限清理失败不阻断 */
      }
    }
    await loadSites()
    showToast('站点已删除')
  } catch (e) {
    showToast(safeUiError(e))
  }
}

async function authorizeSite(site: SiteConfig) {
  const granted = await ensureOriginPermission(site.origin)
  if (!granted) {
    showToast('未获得该站点权限，请在 Chrome 权限弹窗中允许访问')
    return
  }

  // 「去授权 / 重新授权」始终先打开原站，方便用户直接查看或恢复登录态。
  if (isValidSiteUrl(site.baseUrl)) {
    try {
      await chrome.tabs.create({ url: site.baseUrl, active: true })
    } catch {
      // 打开失败不阻断后续授权检查，也不向 UI 暴露浏览器原始错误。
    }
  }

  try {
    const res = await send<{ status: 'ok' | 'expired' | 'indeterminate' }>('AUTHORIZE_SITE', { id: site.id })
    if (res.status === 'expired') {
      showToast('登录态已过期，正在打开原站，请登录后回到插件重新授权')
    } else if (res.status === 'indeterminate') {
      showToast('暂时无法确认授权状态，请保持控制台已登录后重新检测')
      await loadSites()
    } else {
      showToast('授权成功，登录态有效')
      await loadSites()
    }
  } catch (e) {
    showToast(safeUiError(e))
  }
}

// ── 手动排序（拖拽手柄 / ▲▼ 按钮；完整集合重排，GPT P0-1 修正）──
const dragId = ref<string | null>(null) // 当前被拖拽的站点 id
const dragOverId = ref<string | null>(null) // 当前悬停的站点 id（用于插入指示线）
const dragOverPos = ref<'before' | 'after'>('before') // 插入到目标之前还是之后
const reorderInFlight = ref(false) // 是否有保存请求在途
const reorderDirty = ref(false) // 在途期间顺序又变了 → 落库后再提交一次

/** 把本地 sites 的当前顺序提交到后台（完整集合）。连续拖拽时串行化，保证最终序落库。 */
async function commitOrder() {
  if (reorderInFlight.value) {
    reorderDirty.value = true
    return
  }
  reorderInFlight.value = true
  try {
    while (true) {
      reorderDirty.value = false
      const orderedIds = sites.value.map((s) => s.id)
      const res = await send<ReorderSitesResponse>('REORDER_SITES', { orderedIds })
      if (!res.ok) {
        showToast('排序保存失败，已恢复为服务器顺序')
        await loadSites() // 以服务端为准，不在本地回滚旧数组（GPT P1-4）
        break
      }
      if (!reorderDirty.value) break // 期间未再变化 → 结束
    }
  } catch (e) {
    showToast(safeUiError(e))
    await loadSites() // 异常同样以服务端为准
  } finally {
    reorderInFlight.value = false
  }
}

/** ▲ 上移 */
function moveUp(site: SiteConfig) {
  const idx = sites.value.findIndex((s) => s.id === site.id)
  if (idx <= 0) return
  swapOrder(idx, idx - 1)
}
/** ▼ 下移 */
function moveDown(site: SiteConfig) {
  const idx = sites.value.findIndex((s) => s.id === site.id)
  if (idx < 0 || idx >= sites.value.length - 1) return
  swapOrder(idx, idx + 1)
}
function swapOrder(a: number, b: number) {
  if (a < 0 || b < 0 || a >= sites.value.length || b >= sites.value.length) return
  const arr = sites.value.slice()
  const t = arr[a]
  arr[a] = arr[b]
  arr[b] = t
  sites.value = arr
  void commitOrder()
}

// ── 原生 HTML5 拖放（仅拖拽手柄可拖，整行不拖，避免干扰文本选择与按钮点击：GPT P1-3）──
function onDragStart(e: DragEvent, site: SiteConfig) {
  dragId.value = site.id
  if (e.dataTransfer) {
    e.dataTransfer.setData('text/plain', site.id)
    e.dataTransfer.effectAllowed = 'move'
  }
}
function onDragOver(e: DragEvent, site: SiteConfig) {
  if (!dragId.value || dragId.value === site.id) return
  e.preventDefault() // 允许作为放置目标
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  dragOverId.value = site.id
  dragOverPos.value = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}
function onDrop(e: DragEvent, site: SiteConfig) {
  e.preventDefault()
  const fromId = dragId.value
  if (!fromId || fromId === site.id) return
  const from = sites.value.findIndex((s) => s.id === fromId)
  const to = sites.value.findIndex((s) => s.id === site.id)
  if (from < 0 || to < 0) return
  const arr = sites.value.slice()
  const [moved] = arr.splice(from, 1)
  const to2 = to > from ? to - 1 : to // 移除后目标在压缩数组中的新下标
  const insertAt = dragOverPos.value === 'after' ? to2 + 1 : to2
  arr.splice(insertAt, 0, moved)
  sites.value = arr
  resetDrag()
  void commitOrder()
}
function onDragEnd() {
  resetDrag()
}
function resetDrag() {
  dragId.value = null
  dragOverId.value = null
  dragOverPos.value = 'before'
}

// 采集方案卡「立即同步」：单站触发一次采集（方案 028 §6 B5，与侧边栏刷新同源）。
async function collectNow(site: SiteConfig) {
  const granted = await ensureOriginPermission(site.origin)
  if (!granted) {
    showToast('未获得该站点权限，请在 Chrome 权限弹窗中允许访问')
    return
  }
  showToast('正在采集该站点…')
  try {
    await send('COLLECT_NOW', { siteIds: [site.id] }, 60_000)
    showToast('采集完成，已刷新方案状态')
    await loadSites()
    void loadProfiles()
  } catch (e) {
    showToast(safeUiError(e))
  }
}

async function discoverEndpoints(site: SiteConfig) {
  const granted = await ensureOriginPermission(site.origin)
  if (!granted) {
    showToast('未获得该站点权限，请在 Chrome 权限弹窗中允许访问')
    return
  }
  showToast('正在页面中探测真实接口，请稍候…')
  try {
    const res = await send<ProbeResult>('DISCOVER_ENDPOINTS', { id: site.id })
    if (res.match) {
      showToast(`探测成功：${res.match.path}（余额字段 ${res.match.balancePath ?? '-'}，已用字段 ${res.match.usedPath ?? '-'}）`)
      await loadSites()
    } else {
      const cookieHint = res.cookiePresent
        ? `页面有 Cookie（${res.cookieNames.slice(0, 3).join(', ')}${res.cookieNames.length > 3 ? '...' : ''}）`
        : '页面未检测到可见 Cookie'
      const storageKeys = [...res.localStorageKeys, ...res.sessionStorageKeys]
      const storageHint = storageKeys.length
        ? `；存储键：${storageKeys.slice(0, 5).join(', ')}${storageKeys.length > 5 ? '...' : ''}`
        : '；无 localStorage/sessionStorage 键'
      const tried = res.attempts.map((a) => `${safeRequestPath(a.url)}(${a.status})`).join(', ')
      showToast(`未探测到用户信息接口。${cookieHint}${storageHint}。已尝试：${tried.slice(0, 100)}…`)
    }
  } catch (e) {
    showToast(safeUiError(e))
  }
}

async function discoverViaNetwork(site: SiteConfig) {
  const granted = await ensureOriginPermission(site.origin)
  if (!granted) {
    showToast('未获得该站点权限，请在 Chrome 权限弹窗中允许访问')
    return
  }
  showToast('正在用 webRequest 捕获页面 API 请求（将刷新该站点标签页），请稍候…')
  try {
    const res = await send<{ captured: NetDiscoveryRequest[] }>('DISCOVER_VIA_NETWORK', { id: site.id })
    if (res.captured.length === 0) {
      showToast('未捕获到 API 请求。请登录后在站点页内点击「账户/用量/控制台」等按钮触发请求再试')
    } else {
      const pick = res.captured
        .slice(0, 6)
        .map((c) => {
          const isJson = (c.contentType ?? '').includes('json')
          return `${c.method} ${safeRequestPath(c.url)} (${c.statusCode ?? '?'}${isJson ? ',json' : ''})`
        })
        .join(' ｜ ')
      showToast(`捕获到 ${res.captured.length} 个请求，疑似接口：${pick}`)
    }
  } catch (e) {
    showToast(safeUiError(e))
  }
}

async function exportConfig() {
  try {
    const config = await send<ExportConfig>('EXPORT_CONFIG')
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `ai-hub-backup-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    showToast(`全量备份已导出（v${config.version}，${config.sites.length} 个站点，不含任何凭证）`)
  } catch (e) {
    showToast(safeUiError(e))
  }
}

function triggerImport() {
  fileInput.value?.click()
}

// 导入流程拆两步：选文件→解析暂存→用户点"授权并导入"→request 权限→IMPORT_CONFIG
// （MV3：chrome.permissions.request 须在用户手势同步路径中，不能在 await file.text() 之后）
const pendingImport = ref<ExportConfig | null>(null)
const pendingOrigins = computed(() => {
  if (!pendingImport.value) return []
  return pendingImport.value.sites
    .map((s) => normalizeOrigin(s.baseUrl))
    .filter((v, i, a) => a.indexOf(v) === i)
})

async function handleFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    const text = await file.text()
    const config = JSON.parse(text) as ExportConfig
    if (!config.sites || !Array.isArray(config.sites)) {
      throw new Error('无效的配置文件格式')
    }
    // 只暂存，不在此处请求权限（异步 file.text() 后用户手势已丢失）
    pendingImport.value = config
    console.info('[AI Relay] 导入：文件解析成功', { siteN: config.sites.length })
  } catch {
    showToast(ERR_INVALID_CONFIG)
  } finally {
    input.value = ''
  }
}

// 发送 IMPORT_CONFIG（超时放宽到 60s，应对全量还原的大事务）。
// 不自动重试：导入为单事务原子且幂等，超时后用户可手动重导；自动重试会触发重复事务（虽幂等但浪费）。
async function sendImport(cfg: ExportConfig): Promise<ImportResult> {
  console.info('[AI Relay] 导入：发送 IMPORT_CONFIG（超时 60s）')
  return send<ImportResult>('IMPORT_CONFIG', { config: cfg }, 60_000)
}

async function confirmImport() {
  if (!pendingImport.value) return
  const cfg = pendingImport.value
  const siteN = cfg.sites?.length ?? 0
  const origins = pendingOrigins.value
  console.info('[AI Relay] 导入：开始', { siteN, origins })
  try {
    if (origins.length > 0) {
      const perms = origins.map((o) => `${o}/*`)
      console.info('[AI Relay] 导入：请求权限', perms)
      const granted = await chrome.permissions.request({ origins: perms })
      console.info('[AI Relay] 导入：权限结果', { granted })
      if (!granted) {
        showToast('未授权站点权限，导入已取消')
        return
      }
    }
    const res = await sendImport(cfg)
    console.info('[AI Relay] 导入：SW 返回', res)
    if (res.fatalError) {
      showToast(`导入失败：${res.fatalError}`)
      pendingImport.value = null
      return
    }
    const parts: string[] = []
    if (res.imported > 0) parts.push(`新增 ${res.imported} 个`)
    if (res.updated > 0) parts.push(`更新 ${res.updated} 个`)
    let msg = parts.length ? `成功${parts.join('、')}站点` : '未导入任何站点'
    if (res.skipped.length) {
      const reasons = res.skipped.map((s) => `${s.name}（${s.reason}）`).join('、')
      msg += `；跳过 ${res.skipped.length} 个：${reasons}`
    }
    // v2 全量：补充各表写入统计
    if (res.data && Object.keys(res.data).length) {
      const dataParts = Object.entries(res.data)
        .filter(([, v]) => v.written > 0 || v.orphanSkipped > 0)
        .map(([k, v]) => `${k}:${v.written} 条写入${v.orphanSkipped ? `、${v.orphanSkipped} 条跳过` : ''}`)
      if (dataParts.length) msg += `；数据 ${dataParts.join('，')}`
    }
    msg += '。导入后请重新登录各站点以恢复采集。'
    showToast(msg)
    pendingImport.value = null
    await loadSites()
  } catch (e) {
    // 仅记录固定 kind（不记录 message，避免泄露内部细节）；完整堆栈见控制台
    console.error('[AI Relay] 导入：异常', e)
    const kind = e instanceof MessagingError ? e.kind : 'UNKNOWN'
    showToast(`导入失败（${kind}），请重新加载扩展或查看控制台日志`)
  }
}

function cancelImport() {
  pendingImport.value = null
}

function statusText(site: SiteConfig): string {
  const status = site.lastStatus === 'auth_expired' && !shouldShowReauthorize(site) ? 'error' : site.lastStatus
  const info = statusBadge(status)
  return info.text
}

function openOrigin(url: string) {
  if (!isValidSiteUrl(url)) return
  chrome.tabs.create({ url })
}

// —— 自定义采集请求面板 ——
const expandedSiteId = ref<string | null>(null)
const drafts = ref<Record<string, string>>({})
const capturingIds = ref<Record<string, boolean>>({})

// —— 站点启用/禁用切换 ——
async function toggleEnabled(site: SiteConfig) {
  try {
    await send('UPDATE_SITE', { id: site.id, patch: { enabled: !site.enabled } })
    await loadSites()
  } catch (e) {
    showToast(safeUiError(e))
  }
}

// —— 诊断日志面板 ——
const diagSiteId = ref<string | null>(null)
const diags = ref<DiagnosticEntry[]>([])
const diagsLoading = ref(false)

async function toggleDiag(site: SiteConfig) {
  if (diagSiteId.value === site.id) {
    diagSiteId.value = null
    diags.value = []
    return
  }
  diagSiteId.value = site.id
  diagsLoading.value = true
  try {
    diags.value = await send<DiagnosticEntry[]>('GET_DIAGNOSTICS', { id: site.id })
  } catch (e) {
    showToast(safeUiError(e))
    diags.value = []
  } finally {
    diagsLoading.value = false
  }
}

async function clearDiags(site: SiteConfig) {
  if (!confirm(`确定清空站点「${site.name}」的全部诊断日志？`)) return
  try {
    await send<{ ok: boolean }>('CLEAR_DIAGNOSTICS', { id: site.id })
    diags.value = []
    showToast('诊断日志已清空')
  } catch (e) {
    showToast(safeUiError(e))
  }
}

function exportDiags(site: SiteConfig) {
  if (diags.value.length === 0) {
    showToast('该站点暂无诊断日志')
    return
  }
  const blob = new Blob([JSON.stringify(diags.value, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `diagnostics-${site.id}-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(url)
  showToast(`已导出 ${diags.value.length} 条诊断日志`)
}

function fmtDiagTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

function diagPhaseLabel(phase: string): string {
  return phase === 'balance' ? '余额' : phase === 'usage' ? '用量' : phase === 'overall' ? '汇总' : phase
}

function diagExtractedIcon(v: boolean): string {
  return v ? '✅' : '❌'
}

function toggleCustom(site: SiteConfig) {
  if (expandedSiteId.value === site.id) {
    expandedSiteId.value = null
  } else {
    drafts.value[site.id] = site.customRequests ?? ''
    expandedSiteId.value = site.id
  }
}

async function saveCustom(site: SiteConfig) {
  try {
    await send('UPDATE_SITE', { id: site.id, patch: { customRequests: drafts.value[site.id] ?? '' } })
    await loadSites()
    showToast('自定义采集请求已保存')
  } catch (e) {
    showToast(safeUiError(e))
  }
}

async function captureCustom(site: SiteConfig) {
  const granted = await ensureOriginPermission(site.origin)
  if (!granted) {
    showToast('未获得该站点权限，请在 Chrome 权限弹窗中允许访问')
    return
  }
  capturingIds.value[site.id] = true
  try {
    const res = await send<{ recorded: number; failed: number; errors: string[] }>('CAPTURE_CUSTOM', { id: site.id })
    if (res.failed > 0) {
      showToast(`已记录 ${res.recorded} 条响应，${res.failed} 条请求未成功`)
    } else {
      showToast(`已采集并记录 ${res.recorded} 条请求响应`)
    }
  } catch (e) {
    showToast(safeUiError(e))
  } finally {
    capturingIds.value[site.id] = false
  }
}

async function exportCaptures(site: SiteConfig) {
  try {
    const records = await send<CustomCaptureRecord[]>('GET_CAPTURES', { id: site.id })
    if (records.length === 0) {
      showToast('该站点暂无采集记录，请先「采集」')
      return
    }
    const blob = new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `captures-${site.id}-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    showToast(`已导出 ${records.length} 条采集记录（仅本人会话返回的 JSON）`)
  } catch (e) {
    showToast(safeUiError(e))
  }
}

async function clearCaptures(site: SiteConfig) {
  if (!confirm(`确定清空站点「${site.name}」的全部自定义采集记录？`)) return
  try {
    await send<{ ok: boolean }>('CLEAR_CAPTURES', { id: site.id })
    showToast('已清空该站点采集记录')
  } catch (e) {
    showToast(safeUiError(e))
  }
}

const theme = ref<ThemeMode>('light')
// 主题切换与侧边栏一致：点击循环 light → dark → auto → light
const themeIcon = computed(() => (theme.value === 'dark' ? '🌙' : theme.value === 'auto' ? '🔄' : '☀️'))
function cycleTheme() {
  const next: ThemeMode = theme.value === 'light' ? 'dark' : theme.value === 'dark' ? 'auto' : 'light'
  theme.value = next
  setThemeMode(next)
}

onMounted(async () => {
  await loadSites()
  theme.value = await getThemeMode()
  labShowDashboard.value = await getLabShowDashboard()
  chrome.runtime.onMessage.addListener(onOptionsNotify)
  document.addEventListener('click', onDocClick)
  // Phase C：尊重 sidebar「📊 用量看板」按钮写入的 session storage 提示
  try {
    const sess = await chrome.storage.session?.get?.('aihub.optsTab')
    // 仅当实验性「用量看板」开关开启时，才尊重侧边栏写入的「打开 dashboard Tab」请求；
    // 否则（开关已关）落到已隐藏的 Tab，回退到默认设置页。
    if (sess && (sess as Record<string, string>)['aihub.optsTab'] === 'dashboard' && labShowDashboard.value) {
      activeTab.value = 'dashboard'
      await chrome.storage.session?.remove?.('aihub.optsTab')
    }
  } catch {
    /* session storage 不可用 → 静默回退到默认 settings Tab */
  }
})

onUnmounted(() => {
  chrome.runtime.onMessage.removeListener(onOptionsNotify)
  document.removeEventListener('click', onDocClick)
})
</script>

<template>
  <div class="opts-shell">
    <header class="topbar">
      <div class="logo">AI</div>
      <span class="title">AI 中转站用量看板 · 设置</span>
      <nav class="tabs" v-if="labShowDashboard">
        <button
          class="tab-toggle"
          :class="{ on: activeTab === 'dashboard' }"
          :title="activeTab === 'settings' ? '打开用量看板' : '返回站点设置'"
          @click="toggleDashboardTab"
        >{{ dashboardTabLabel }}</button>
      </nav>
      <div class="topbar-actions">
        <a
          class="btn feedback-btn"
          href="https://docs.qq.com/sheet/DZG1GaENEc2pFYVJy?tab=BB08J2"
          target="_blank"
          rel="noopener noreferrer"
          title="打开问题反馈表"
        >📝 问题反馈</a>
        <div class="group-wrap" @mouseenter="groupQrVisible = true" @mouseleave="groupQrVisible = false">
          <button class="btn group-btn" title="加入 QQ 交流群（鼠标悬停显示二维码）">👥 交流群：1102575547</button>
          <div v-if="groupQrVisible" class="group-pop" @mouseenter="groupQrVisible = true" @mouseleave="groupQrVisible = false">
            <img :src="groupQrUrl" alt="AI Hub 插件交流群二维码" class="group-qr-img" />
          </div>
        </div>
        <button class="btn help-btn" title="查看使用说明" @click="openHelp">❔ 使用说明</button>
      </div>
    </header>

    <main class="opt-main">
      <template v-if="activeTab === 'settings'">
        <h2>站点管理</h2>
      <div class="desc">
        每个站点独立授权、独立凭证，删除站点时同步撤销其域名权限。导出的全量备份（站点 + 采集数据 + 设置）默认不含任何凭证。
      </div>

      <div class="toolbar">
        <button class="btn primary" @click="openAdd">＋ 添加站点</button>
        <button class="btn" @click="exportConfig">⇪ 全量备份</button>
        <button class="btn" @click="triggerImport">⇩ 导入备份</button>
        <!-- 排序开关：开启后才显示拖拽手柄与 ▲▼（GPT R1：不持久化） -->
        <label class="sort-switch" :class="{ on: sortMode }">
          <span class="sort-switch-label">手动排序</span>
          <button
            type="button"
            class="switch"
            role="switch"
            :aria-checked="sortMode"
            aria-label="启用手动排序（开启后可拖拽或上下移动站点顺序）"
            @click="sortMode = !sortMode"
          ><span class="knob"></span></button>
        </label>
        <button
          class="cycle-theme"
          :title="themeIcon + ' 主题（点击切换）'"
          @click="cycleTheme"
        >{{ themeIcon }}</button>
        <input
          ref="fileInput"
          type="file"
          accept=".json"
          style="display: none"
          @change="handleFile"
        />
      </div>
      <div v-if="sortMode" class="sort-hint">🔃 排序模式已开启：拖动 ⠿ 或点 ▲▼ 调整顺序，保存自动生效。</div>

      <div v-if="loading" class="state-msg">加载中…</div>

      <div v-else-if="sites.length === 0" class="empty">
        <div class="empty-icon">🛰️</div>
        <div class="empty-title">还没有添加站点</div>
        <div class="empty-desc">点击「添加站点」接入你的第一个 AI 中转站</div>
      </div>

      <template v-else>
        <div
          v-for="(site, idx) in sites"
          :key="site.id"
          class="site-row"
          :class="{
            'site-disabled': !site.enabled,
            dragging: dragId === site.id,
            'drop-before': dragOverId === site.id && dragOverPos === 'before',
            'drop-after': dragOverId === site.id && dragOverPos === 'after',
            'last-rows': idx >= sites.length - 2,
          }"
          @dragover="sortMode && onDragOver($event, site)"
          @drop="sortMode && onDrop($event, site)"
        >
          <!-- 拖拽手柄（仅排序模式显示；仅此元素可拖，整行不拖以免干扰文本选择与按钮点击：GPT P1-3） -->
          <div
            v-if="sortMode"
            class="drag-handle"
            draggable="true"
            role="button"
            :aria-label="'拖拽排序 ' + site.name"
            title="拖拽排序"
            @dragstart="onDragStart($event, site)"
            @dragend="onDragEnd"
          >⠿</div>
          <div class="avatar" :style="{ background: site.color }">
            {{ site.name.charAt(0).toUpperCase() }}
          </div>
          <div class="info">
            <div class="nm">
              {{ site.name }}
              <span class="chip">{{ adapterMap[site.adapter] || site.adapter }}</span>
              <span v-if="!site.enabled" class="chip chip-off">已禁用</span>
            </div>
            <div class="meta">
              {{ site.origin.replace('https://', '') }} · 凭证：Cookie 会话 ·
              <span :class="site.lastStatus === 'ok' ? 'perm' : 'perm no'">
                {{ statusText(site) }}
              </span>
            </div>
            <!-- 站点类型与采集方案常驻摘要（方案 028）：始终可见，不放进更多菜单 -->
            <div class="collect-summary" v-if="profileFor(site)">
              <span class="chip chip-type" title="自动识别的站点类型（与配置适配器区分）">{{ typeLabel(profileFor(site)!) }}</span>
              <span class="chip" v-if="routeLabel(profileFor(site)!)">{{ routeLabel(profileFor(site)!) }}</span>
              <span class="chip" v-if="confLabel(profileFor(site)!)" :title="'探测置信度'">{{ confLabel(profileFor(site)!) }}</span>
              <span class="chip chip-engine" :title="'采集引擎与运行态'">{{ collectionSummaryText(profileFor(site)!) }}</span>
              <button
                class="mini link"
                :class="profileSiteId === site.id ? 'accent' : ''"
                :aria-expanded="profileSiteId === site.id"
                :aria-controls="`profile-panel-${site.id}`"
                @click="toggleProfile(site)"
              >查看方案</button>
            </div>
            <div class="collect-summary muted" v-else-if="!profilesAvailable">采集方案暂不可用</div>
            <div class="collect-summary muted" v-else>待探测</div>
          </div>
          <div class="ops">
            <!-- 手动排序：▲▼ 键盘可操作入口（仅排序模式显示；首/末行原生 disabled，GPT P1-2） -->
            <template v-if="sortMode">
              <button
                class="mini move-btn"
                :title="'上移 ' + site.name"
                aria-label="上移"
                @click="moveUp(site)"
                :disabled="!canMoveUp(site)"
              >▲</button>
              <button
                class="mini move-btn"
                :title="'下移 ' + site.name"
                aria-label="下移"
                @click="moveDown(site)"
                :disabled="!canMoveDown(site)"
              >▼</button>
            </template>
            <!-- 启用/禁用：动作动词文案，明确可点击（GPT 需求③） -->
            <button
              class="mini"
              :class="site.enabled ? '' : 'accent'"
              :title="site.enabled ? '点击禁用该站点（不采集、不在侧边栏展示）' : '点击启用该站点'"
              @click="toggleEnabled(site)"
            >
              {{ site.enabled ? '禁用' : '启用' }}
            </button>
            <button class="mini" @click="openEdit(site)">编辑</button>
            <button
              class="mini"
              :class="site.lastStatus !== 'ok' ? 'accent' : ''"
              @click="authorizeSite(site)"
            >{{ site.lastStatus !== 'ok' ? '去授权' : '重新授权' }}</button>
            <!-- 二级菜单：高级操作 hover/点击 展开（moreOpen 唯一真值，GPT P0-1） -->
            <div
              class="more-wrap"
              :class="{ open: moreOpen === site.id }"
              @mouseenter="moreOpen = site.id"
              @mouseleave="moreOpen = null"
              @keydown.esc="moreOpen = null"
            >
              <button
                class="mini more-trigger"
                :aria-label="'更多操作 ' + site.name"
                :aria-expanded="moreOpen === site.id"
                :aria-controls="`site-more-menu-${site.id}`"
                @click="toggleMore(site.id)"
              >⋯ 更多</button>
              <div
                class="submenu"
                :id="`site-more-menu-${site.id}`"
                v-show="moreOpen === site.id"
              >
                <button class="mini" @click="onMoreItem(site, () => discoverEndpoints(site))">探测接口</button>
                <button class="mini" @click="onMoreItem(site, () => discoverViaNetwork(site))">网络发现</button>
                <div class="submenu-sep"></div>
                <button
                  class="mini"
                  :class="expandedSiteId === site.id ? 'accent' : ''"
                  :aria-expanded="expandedSiteId === site.id"
                  @click="onMoreItem(site, () => toggleCustom(site))"
                >自定义采集</button>
                <button
                  class="mini"
                  :class="diagSiteId === site.id ? 'accent' : ''"
                  :aria-expanded="diagSiteId === site.id"
                  @click="onMoreItem(site, () => toggleDiag(site))"
                >诊断日志</button>
                <div class="submenu-sep"></div>
                <button class="mini danger" @click="onMoreItem(site, () => deleteSite(site))">删除</button>
              </div>
            </div>
          </div>

          <!-- 采集方案卡（方案 028）：独立于自定义采集面板展开 -->
          <div v-if="profileSiteId === site.id && profileFor(site)" :id="`profile-panel-${site.id}`" class="profile-panel">
            <CollectionProfileCard
              :profile="profileFor(site)!"
              @reprobe="discoverEndpoints(site)"
              @diagnose="toggleDiag(site)"
              @edit="openEdit(site)"
              @reauth="authorizeSite(site)"
              @sync="collectNow(site)"
            />
          </div>

          <!-- 自定义采集面板 -->
          <div v-if="expandedSiteId === site.id" class="custom-panel">
            <div class="cp-title">
              自定义采集请求（英文分号分隔，仅本站同源 GET，用于扩展采集任意可读接口供后续分析）
            </div>
            <textarea
              v-model="drafts[site.id]"
              class="cp-input"
              rows="3"
              placeholder="/api/v1/auth/me;/api/user/usage;/api/v1/user/log"
            ></textarea>
            <div class="cp-ops">
              <button class="mini" @click="saveCustom(site)">保存</button>
              <button
                class="mini accent"
                :disabled="capturingIds[site.id]"
                @click="captureCustom(site)"
              >
                {{ capturingIds[site.id] ? '采集中…' : '采集' }}
              </button>
              <button class="mini" @click="exportCaptures(site)">导出</button>
              <button class="mini danger" @click="clearCaptures(site)">清空</button>
            </div>
          </div>

          <!-- 诊断日志面板 -->
          <div v-if="diagSiteId === site.id" class="diag-panel">
            <div class="cp-title">
              采集诊断日志（脱敏指纹：端点/状态码/字段类型/耗时，不含任何私密值）
              <span class="diag-count">{{ diags.length }} 条</span>
            </div>
            <div v-if="diagsLoading" class="state-msg">加载中…</div>
            <div v-else-if="diags.length === 0" class="diag-empty">暂无诊断日志。执行一次「立即同步」后将自动记录。</div>
            <template v-else>
              <div class="diag-table-wrap">
                <table class="diag-table">
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th>阶段</th>
                      <th>端点</th>
                      <th>状态</th>
                      <th>耗时</th>
                      <th>字段指纹</th>
                      <th>提取</th>
                      <th>备注</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="d in diags" :key="d.id ?? d.at" :class="{ 'diag-err': d.status >= 400 || d.status === 0 }">
                      <td class="diag-ts">{{ fmtDiagTime(d.at) }}</td>
                      <td><span class="phase-badge" :class="'phase-' + d.phase">{{ diagPhaseLabel(d.phase) }}</span></td>
                      <td class="diag-url" :title="d.url">{{ d.url.replace(site.origin, '') }}</td>
                      <td :class="d.status >= 400 ? 'diag-status-bad' : d.status === 0 ? 'diag-status-err' : 'diag-status-ok'">{{ d.status || '?' }}</td>
                      <td>{{ d.elapsedMs }}ms</td>
                      <td class="diag-fp">
                        <span v-for="(v, k) in d.fieldFingerprint" :key="k" class="fp-item">{{ k }}:{{ v }}</span>
                        <span v-if="Object.keys(d.fieldFingerprint).length === 0">—</span>
                      </td>
                      <td class="diag-extracted">
                        {{ diagExtractedIcon(d.extracted.balance) }}
                        {{ diagExtractedIcon(d.extracted.todayTokens) }}
                        {{ diagExtractedIcon(d.extracted.todayRequests) }}
                        {{ diagExtractedIcon(d.extracted.cumulativeTokens) }}
                        {{ diagExtractedIcon(d.extracted.avgResponseTimeMs) }}
                      </td>
                      <td class="diag-note" :title="d.note">{{ d.note.slice(0, 60) }}{{ d.note.length > 60 ? '…' : '' }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div class="cp-ops">
                <button class="mini" @click="toggleDiag(site)">刷新</button>
                <button class="mini" @click="exportDiags(site)">导出 JSON</button>
                <button class="mini danger" @click="clearDiags(site)">清空</button>
              </div>
            </template>
          </div>
        </div>
      </template>

      <DataExplorer :sites="sites" />
      </template>

      <template v-else>
        <h2>用量看板</h2>
        <div class="desc">
          完整复刻 hubway 用量页：4 张指标卡 + 4 张图表（模型/分组/站点分布 + Token 趋势）+ 筛选 + 明细分页。
          数据来自 v4 GET_USAGE_DASHBOARD / GET_USAGE_DETAILS / GET_USAGE_FILTER_OPTIONS。
        </div>
        <UsageDashboard
          :sites="sites"
          :selected-site-id="dashboardSiteId"
          @update:selected-site-id="dashboardSiteId = $event"
        />
      </template>
    </main>

    <SiteForm
      :visible="formVisible"
      :site="editingSite"
      @close="formVisible = false"
      @submitted="onFormSubmitted"
    />

    <!-- 待导入确认（拆两步：选文件→暂存→用户点按钮→request 权限） -->
    <div v-if="pendingImport" class="modal-mask" @click.self="cancelImport">
      <div class="modal">
        <h3>确认导入备份</h3>
        <div class="import-preview">
          检测到 {{ pendingImport.sites.length }} 个站点，涉及
          {{ pendingOrigins.length }} 个域名：
          <ul>
            <li v-for="o in pendingOrigins" :key="o">{{ o }}</li>
          </ul>
          <p v-if="pendingImport.version === 2" class="ver-note">全量备份（v2）：将一并还原各站点的采集数据（余额历史 / 每日用量 / 用量明细 / 诊断）与设置。</p>
        </div>
        <div class="steps">
          点击「授权并导入」后，Chrome 将弹出权限确认对话框。仅授权的站点会被导入，未授权或无效的站点将自动跳过。导入后各站点需重新登录以恢复采集。
        </div>
        <div class="foot">
          <button class="btn" @click="cancelImport">取消</button>
          <button class="btn primary" @click="confirmImport">授权并导入</button>
        </div>
      </div>
    </div>

    <!-- 使用说明弹窗 -->
    <div v-if="helpVisible" class="modal-mask help-mask" @click.self="helpVisible = false">
      <div class="modal help-modal">
        <div class="help-head">
          <h3>使用说明</h3>
          <button class="btn" @click="helpVisible = false">关闭</button>
        </div>
        <iframe :src="helpUrl" class="help-iframe" title="使用说明"></iframe>
      </div>
    </div>

    <!-- 交流群二维码弹窗已改为按钮 hover 弹层（见 topbar-actions 内 group-wrap） -->

    <Transition name="toast">
      <div v-if="toast" class="toast">{{ toast }}</div>
    </Transition>
  </div>
</template>

<style>
/* 主题变量统一由 src/styles/theme.css 提供（:root 亮色 / html.theme-dark 暗色） */
* {
  box-sizing: border-box;
}
html,
body {
  margin: 0;
  min-height: 100%;
}
body {
  font-family: system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
}
.settings-card {
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 12px 16px;
  margin-bottom: 18px;
  background: var(--panel);
}
.settings-card > summary {
  list-style: none;
  cursor: pointer;
  font-size: 14px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text);
}
.settings-card > summary::-webkit-details-marker {
  display: none;
}
.settings-card > summary::before {
  content: '▸';
  font-size: 11px;
  color: var(--sub);
}
.settings-card[open] > summary::before {
  content: '▾';
}
.settings-card[open] {
  padding-bottom: 14px;
}
.settings-summary-hint {
  font-size: 11px;
  font-weight: 400;
  color: var(--sub);
}
.settings-desc {
  margin: 10px 0;
  color: var(--sub);
  font-size: 12px;
}
.radio-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.radio-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  cursor: pointer;
}
.radio-item input {
  margin-top: 3px;
}
.radio-item b {
  font-weight: 600;
}
.radio-item small {
  color: var(--sub);
}
.opts-shell {
  max-width: 880px;
  margin: 0 auto;
  padding: 24px;
}
.topbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--line);
  margin-bottom: 24px;
}
.logo {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: linear-gradient(135deg, var(--brand), var(--brand2));
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 13px;
}
.title {
  font-weight: 700;
  font-size: 18px;
}
.opt-main h2 {
  font-size: 17px;
  margin-bottom: 4px;
}
.desc {
  font-size: 12px;
  color: var(--sub);
  margin-bottom: 18px;
  line-height: 1.6;
}
.toolbar {
  display: flex;
  gap: 10px;
  margin-bottom: 20px;
}
/* 排序开关（GPT R1：临时编辑态，不持久化） */
.sort-switch {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-left: 4px;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
}
.sort-switch-label {
  font-size: 12px;
  color: var(--sub);
}
.sort-switch.on .sort-switch-label {
  color: var(--brand-text);
  font-weight: 600;
}
.switch {
  position: relative;
  width: 38px;
  height: 20px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--panel-soft);
  padding: 0;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
  flex-shrink: 0;
}
.sort-switch.on .switch {
  background: var(--brand);
  border-color: var(--brand);
}
.knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  transition: transform 0.15s;
}
.sort-switch.on .knob {
  transform: translateX(18px);
}
.switch:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 2px;
}
.sort-hint {
  font-size: 12px;
  color: var(--brand-text);
  background: var(--brand-soft);
  border-radius: 8px;
  padding: 8px 12px;
  margin-bottom: 14px;
  line-height: 1.6;
}
/* 主题切换：单按钮点击循环（与侧边栏一致） */
.cycle-theme {
  margin-left: auto;
  width: 34px;
  height: 34px;
  border-radius: 9px;
  border: 1px solid var(--line);
  background: var(--panel);
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
  color: var(--sub);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}
.cycle-theme:hover {
  background: var(--panel-soft);
  color: var(--text);
  border-color: var(--line);
}
.btn {
  padding: 8px 16px;
  border-radius: 9px;
  font-size: 12px;
  border: 1px solid var(--line);
  background: var(--panel);
  cursor: pointer;
  color: var(--text);
  transition: all 0.15s;
}
.btn:hover {
  background: var(--panel-soft);
  border-color: var(--line);
}
.btn.primary {
  background: var(--brand);
  border-color: var(--brand);
  color: #fff;
  font-weight: 600;
}
.btn.primary:hover {
  opacity: 0.9;
  background: var(--brand);
}

.state-msg {
  text-align: center;
  color: var(--sub);
  padding: 60px 0;
}

.empty {
  text-align: center;
  padding: 60px 20px;
  color: var(--sub);
}
.empty-icon {
  font-size: 36px;
  margin-bottom: 12px;
}
.empty-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 6px;
}
.empty-desc {
  font-size: 12px;
}

.site-row {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 14px 18px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 14px;
  margin-bottom: 10px;
  transition: background 0.15s;
}
.site-row:hover {
  background: var(--panel-soft);
}
.site-row.site-disabled {
  opacity: 0.55;
}
.site-row.site-disabled:hover {
  opacity: 0.75;
}
/* 拖拽排序视觉 */
.drag-handle {
  cursor: grab;
  color: var(--sub);
  font-size: 16px;
  line-height: 1;
  padding: 4px 6px;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
  flex-shrink: 0;
  border-radius: 6px;
  transition: background 0.12s, color 0.12s;
}
.drag-handle:hover {
  background: var(--panel-soft);
  color: var(--text);
}
.drag-handle:active {
  cursor: grabbing;
}
.site-row.dragging {
  opacity: 0.4;
}
/* 插入指示线：拖到目标上半部=上方插入，下半部=下方插入（box-shadow 内描边，避免布局抖动） */
.site-row.drop-before {
  box-shadow: inset 0 2px 0 0 var(--brand);
}
.site-row.drop-after {
  box-shadow: inset 0 -2px 0 0 var(--brand);
}
.move-btn {
  font-weight: 700;
}
/* 二级菜单（moreOpen 唯一真值，v-show 控制；GPT P0-1） */
.more-wrap {
  position: relative;
}
.more-trigger {
  white-space: nowrap;
}
.submenu {
  display: flex;
  flex-direction: column;
  gap: 2px;
  position: absolute;
  right: 0;
  /* 消除触发按钮与菜单之间的空隙，hover 可连续进入菜单。 */
  top: calc(100% - 1px);
  z-index: 30;
  min-width: 128px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 9px;
  box-shadow: 0 8px 24px var(--shadow-lg);
  padding: 4px;
}
/* 末两行向上展开，避免视口底部溢出（GPT P2-4） */
.last-rows .submenu {
  top: auto;
  bottom: calc(100% - 1px);
}
.submenu .mini {
  width: 100%;
  text-align: left;
  justify-content: flex-start;
  margin: 0;
}
.submenu-sep {
  height: 1px;
  background: var(--line);
  margin: 3px 2px;
}
/* 焦点可见轮廓（GPT P2-5） */
.more-trigger:focus-visible,
.submenu .mini:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 2px;
}
.avatar {
  width: 36px;
  height: 36px;
  border-radius: 9px;
  color: #fff;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  flex-shrink: 0;
}
.info {
  flex: 1;
  min-width: 0;
  line-height: 1.6;
}
.nm {
  font-weight: 700;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.chip {
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--chip-bg);
  color: var(--chip-text);
  font-weight: 600;
}
.chip-off {
  background: var(--err-soft);
  color: var(--err);
}
.meta {
  font-size: 11px;
  color: var(--sub);
}
.perm {
  color: var(--ok);
}
.perm.no {
  color: var(--warn);
}
.ops {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
.mini {
  padding: 5px 12px;
  font-size: 11px;
  border-radius: 7px;
  border: 1px solid var(--line);
  background: transparent;
  cursor: pointer;
  color: var(--sub);
  transition: all 0.15s;
}
.mini:hover {
  background: var(--panel-soft);
  border-color: var(--line);
}
.mini.accent {
  color: var(--brand-text);
  background: var(--brand-soft);
  border-color: transparent;
}
.mini.accent:hover {
  background: var(--brand-soft);
  opacity: 0.85;
}
.mini.danger {
  color: var(--err);
  border-color: var(--line);
}
.mini.danger:hover {
  background: var(--err-soft);
}
.mini:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
/* 采集方案常驻摘要（方案 028） */
.mini.link {
  border: none;
  background: transparent;
  color: var(--brand-text);
  padding: 2px 4px;
  font-weight: 600;
}
.mini.link:hover {
  text-decoration: underline;
}
.collect-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 7px;
}
.collect-summary.muted {
  color: var(--sub);
  font-size: 11px;
}
.chip-type {
  border-color: var(--brand);
  color: var(--brand-text);
}
.chip-engine {
  background: var(--panel-soft);
}
/* 采集方案展开卡（方案 028） */
.profile-panel {
  flex-basis: 100%;
  border-top: 1px dashed var(--line);
  padding-top: 12px;
  margin-top: 2px;
}

/* 自定义采集面板 */
.custom-panel {
  flex-basis: 100%;
  border-top: 1px dashed var(--line);
  padding-top: 12px;
  margin-top: 2px;
}
.cp-title {
  font-size: 11px;
  color: var(--sub);
  margin-bottom: 8px;
  line-height: 1.6;
}
.cp-input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 8px 10px;
  font-size: 12px;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  color: var(--text);
  background: var(--panel-soft);
  resize: vertical;
  line-height: 1.5;
}
.cp-input:focus {
  outline: none;
  border-color: var(--brand);
}
.cp-ops {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

/* 诊断日志面板 */
.diag-panel {
  flex-basis: 100%;
  border-top: 1px dashed var(--line);
  padding-top: 12px;
  margin-top: 2px;
}
.diag-count {
  font-size: 10px;
  background: var(--brand-soft);
  color: var(--brand-text);
  border-radius: 4px;
  padding: 1px 6px;
  margin-left: 6px;
}
.diag-empty {
  font-size: 11px;
  color: var(--sub);
  text-align: center;
  padding: 16px 0;
}
.diag-table-wrap {
  overflow-x: auto;
  margin-top: 8px;
}
.diag-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 10px;
}
.diag-table th {
  background: var(--panel-soft);
  color: var(--sub);
  font-weight: 600;
  text-align: left;
  padding: 5px 8px;
  white-space: nowrap;
  border-bottom: 1px solid var(--line);
}
.diag-table td {
  padding: 4px 8px;
  border-bottom: 1px solid var(--panel-active);
  vertical-align: top;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.diag-table tr.diag-err {
  background: rgba(255, 0, 0, 0.03);
}
.diag-ts {
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  color: var(--sub);
}
.phase-badge {
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 4px;
  font-weight: 600;
}
.phase-balance { background: #e8f5e9; color: #2e7d32; }
.phase-usage { background: #e3f2fd; color: #1565c0; }
.phase-overall { background: #fff3e0; color: #e65100; }
.diag-url {
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 9px;
  max-width: 120px;
}
.diag-status-ok { color: var(--ok); font-weight: 700; }
.diag-status-bad { color: var(--err); font-weight: 700; }
.diag-status-err { color: var(--warn); font-weight: 700; }
.diag-fp {
  max-width: 140px;
}
.fp-item {
  display: inline-block;
  font-size: 9px;
  background: var(--panel-soft);
  border-radius: 3px;
  padding: 0 4px;
  margin: 1px 2px;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  color: var(--text);
}
.diag-extracted {
  font-size: 11px;
  letter-spacing: 1px;
}
.diag-note {
  color: var(--sub);
  font-size: 9px;
  max-width: 180px;
}

/* 弹窗（待导入确认） */
.modal-mask {
  position: fixed;
  inset: 0;
  background: var(--mask);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  z-index: 100;
  padding-top: 60px;
}
.modal {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: 0 18px 50px var(--shadow-lg);
  width: 440px;
  max-width: 90vw;
  padding: 22px;
}
.modal h3 {
  font-size: 14px;
  margin-bottom: 16px;
}
.import-preview {
  font-size: 12px;
  color: var(--text);
  margin-bottom: 14px;
}
.import-preview ul {
  margin: 8px 0 0 18px;
  color: var(--sub);
  font-size: 11px;
  line-height: 1.8;
}
.steps {
  background: var(--panel-soft);
  border-radius: 10px;
  padding: 12px 14px;
  font-size: 11px;
  color: var(--sub);
  line-height: 1.7;
  margin-bottom: 14px;
}
.foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

/* 使用说明入口与弹窗 */
.topbar-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}
.group-btn {
  white-space: nowrap;
}
.feedback-btn {
  white-space: nowrap;
  text-decoration: none;
}
.tabs {
  display: inline-flex;
  margin-left: 16px;
  border: 1px solid var(--line);
  border-radius: 9px;
  overflow: hidden;
}
.tabs button {
  border: none;
  background: var(--panel);
  padding: 8px 14px;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  color: var(--sub);
}
.tabs button.on {
  background: var(--brand);
  color: #fff;
  font-weight: 600;
}
.tabs button + button {
  border-left: 1px solid var(--line);
}
.help-mask {
  padding: 40px 0;
}
.help-modal {
  width: 90vw;
  max-width: 1000px;
  height: 90vh;
  display: flex;
  flex-direction: column;
  padding: 0;
  overflow: hidden;
}
.help-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--line);
  flex-shrink: 0;
}
.help-head h3 {
  margin: 0;
  font-size: 14px;
}
.help-iframe {
  flex: 1;
  border: none;
  width: 100%;
  min-height: 0;
  background: #fff;
}
/* 交流群按钮 hover 弹层 */
.group-wrap {
  position: relative;
  display: inline-flex;
}
.group-pop {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 120;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: 0 12px 32px var(--shadow-lg);
  padding: 10px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 300px;
}
.group-qr-img {
  display: block;
  width: 280px;
  height: auto;
  border-radius: 8px;
  background: #fff;
}
.toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--panel-soft);
  color: var(--text);
  border: 1px solid var(--line);
  padding: 10px 20px;
  border-radius: 9px;
  font-size: 12px;
  box-shadow: 0 8px 24px var(--shadow-lg);
  z-index: 200;
  max-width: 80vw;
}
.toast-enter-active,
.toast-leave-active {
  transition: all 0.25s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(10px);
}
</style>
