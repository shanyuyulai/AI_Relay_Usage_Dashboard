<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { send, MessagingError } from '../core/messaging/client'
import type { ExportConfig } from '../core/messaging/protocol'
import type { SiteConfig, SiteStatus, CustomCaptureRecord, DiagnosticEntry } from '../shared/types'
import type { ProbeResult } from '../content/probe'
import type { NetDiscoveryRequest } from '../background/netDiscovery'
import { normalizeOrigin } from '../shared/util'
import { ensureOriginPermission } from '../shared/permissions'
import { getThemeMode, setThemeMode, type ThemeMode } from '../shared/theme'
import { registry } from '../adapters'
import { statusBadge } from '../shared/format'
import SiteForm from './components/SiteForm.vue'
import DataExplorer from './components/DataExplorer.vue'

const sites = ref<SiteConfig[]>([])
const loading = ref(false)
const toast = ref('')
const toastTimer = ref<number | null>(null)

// 弹窗状态
const formVisible = ref(false)
const editingSite = ref<SiteConfig | null>(null)

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
  } catch (e) {
    showToast(e instanceof MessagingError ? e.message : String(e))
  } finally {
    loading.value = false
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
    showToast(e instanceof MessagingError ? e.message : String(e))
  }
}

async function authorizeSite(site: SiteConfig) {
  const granted = await ensureOriginPermission(site.origin)
  if (!granted) {
    showToast('未获得该站点权限，请在 Chrome 权限弹窗中允许访问')
    return
  }
  try {
    const res = await send<{ status: 'ok' | 'expired' }>('AUTHORIZE_SITE', { id: site.id })
    if (res.status === 'expired') {
      showToast('登录态已过期，正在打开原站，请登录后回到插件重新授权')
      chrome.tabs.create({ url: site.baseUrl })
    } else {
      showToast('授权成功，登录态有效')
      await loadSites()
    }
  } catch (e) {
    showToast(e instanceof MessagingError ? e.message : String(e))
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
      const tried = res.attempts.map((a) => `${a.url}(${a.status})`).join(', ')
      showToast(`未探测到用户信息接口。${cookieHint}${storageHint}。已尝试：${tried.slice(0, 100)}…`)
    }
  } catch (e) {
    showToast(e instanceof MessagingError ? e.message : String(e))
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
          return `${c.method} ${c.url} (${c.statusCode ?? '?'}${isJson ? ',json' : ''})`
        })
        .join(' ｜ ')
      showToast(`捕获到 ${res.captured.length} 个请求，疑似接口：${pick}`)
    }
  } catch (e) {
    showToast(e instanceof MessagingError ? e.message : String(e))
  }
}

async function exportConfig() {
  try {
    const config = await send<ExportConfig>('EXPORT_CONFIG')
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `ai-hub-config-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    showToast('配置已导出（不含任何凭证）')
  } catch (e) {
    showToast(e instanceof MessagingError ? e.message : String(e))
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
  } catch (e) {
    showToast(e instanceof Error ? e.message : String(e))
  } finally {
    input.value = ''
  }
}

async function confirmImport() {
  if (!pendingImport.value) return
  try {
    // 在用户点击按钮的同步路径中请求权限（MV3 用户手势要求）
    if (pendingOrigins.value.length > 0) {
      const origins = pendingOrigins.value.map((o) => `${o}/*`)
      const granted = await chrome.permissions.request({ origins })
      if (!granted) {
        showToast('未授权站点权限，导入已取消')
        return
      }
    }
    const res = await send<{ imported: number }>('IMPORT_CONFIG', { config: pendingImport.value })
    showToast(`成功导入 ${res.imported} 个站点（未授权或无效的站点已跳过）`)
    pendingImport.value = null
    await loadSites()
  } catch (e) {
    showToast(e instanceof Error ? e.message : String(e))
  }
}

function cancelImport() {
  pendingImport.value = null
}

function statusText(status: SiteStatus): string {
  const info = statusBadge(status)
  return info.text
}

function openOrigin(url: string) {
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
    showToast(e instanceof MessagingError ? e.message : String(e))
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
    showToast(e instanceof MessagingError ? e.message : String(e))
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
    showToast(e instanceof MessagingError ? e.message : String(e))
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
    showToast(e instanceof MessagingError ? e.message : String(e))
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
      showToast(`已记录 ${res.recorded} 条响应，${res.failed} 条请求未成功；首条：${res.errors[0] ?? ''}`)
    } else {
      showToast(`已采集并记录 ${res.recorded} 条请求响应`)
    }
  } catch (e) {
    showToast(e instanceof MessagingError ? e.message : String(e))
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
    showToast(e instanceof MessagingError ? e.message : String(e))
  }
}

async function clearCaptures(site: SiteConfig) {
  if (!confirm(`确定清空站点「${site.name}」的全部自定义采集记录？`)) return
  try {
    await send<{ ok: boolean }>('CLEAR_CAPTURES', { id: site.id })
    showToast('已清空该站点采集记录')
  } catch (e) {
    showToast(e instanceof MessagingError ? e.message : String(e))
  }
}

const theme = ref<ThemeMode>('light')
async function setTheme(mode: ThemeMode) {
  theme.value = mode
  await setThemeMode(mode)
}

onMounted(async () => {
  await loadSites()
  theme.value = await getThemeMode()
})
</script>

<template>
  <div class="opts-shell">
    <header class="topbar">
      <div class="logo">AI</div>
      <span class="title">AI 中转站用量趋势 · 设置</span>
    </header>

    <main class="opt-main">
      <h2>站点管理</h2>
      <div class="desc">
        每个站点独立授权、独立凭证，删除站点时同步撤销其域名权限。导出的配置默认不含任何凭证。
      </div>

      <div class="toolbar">
        <button class="btn primary" @click="openAdd">＋ 添加站点</button>
        <button class="btn" @click="exportConfig">⇪ 导出配置</button>
        <button class="btn" @click="triggerImport">⇩ 导入配置</button>
        <div class="theme-switch">
          <button :class="{ on: theme === 'light' }" title="白天" @click="setTheme('light')">☀️</button>
          <button :class="{ on: theme === 'dark' }" title="黑夜" @click="setTheme('dark')">🌙</button>
          <button :class="{ on: theme === 'auto' }" title="跟随系统" @click="setTheme('auto')">🔄</button>
        </div>
        <input
          ref="fileInput"
          type="file"
          accept=".json"
          style="display: none"
          @change="handleFile"
        />
      </div>

      <div v-if="loading" class="state-msg">加载中…</div>

      <div v-else-if="sites.length === 0" class="empty">
        <div class="empty-icon">🛰️</div>
        <div class="empty-title">还没有添加站点</div>
        <div class="empty-desc">点击「添加站点」接入你的第一个 AI 中转站</div>
      </div>

      <template v-else>
        <div v-for="site in sites" :key="site.id" class="site-row" :class="{ 'site-disabled': !site.enabled }">
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
                {{ statusText(site.lastStatus) }}
              </span>
            </div>
          </div>
          <div class="ops">
            <!-- 启用/禁用开关 -->
            <button
              class="mini"
              :class="site.enabled ? '' : 'accent'"
              :title="site.enabled ? '点击禁用（不采集、不在侧边栏展示）' : '点击启用'"
              @click="toggleEnabled(site)"
            >
              {{ site.enabled ? '● 运行中' : '○ 已停用' }}
            </button>
            <button
              v-if="site.lastStatus !== 'ok'"
              class="mini accent"
              @click="authorizeSite(site)"
            >
              去授权
            </button>
            <button v-else class="mini" @click="authorizeSite(site)">重新授权</button>
            <button class="mini" @click="discoverEndpoints(site)">探测接口</button>
            <button class="mini" @click="discoverViaNetwork(site)">网络发现</button>
            <button class="mini" @click="openEdit(site)">编辑</button>
            <button class="mini danger" @click="deleteSite(site)">删除</button>
            <button
              class="mini"
              :class="expandedSiteId === site.id ? 'accent' : ''"
              @click="toggleCustom(site)"
            >
              自定义采集
            </button>
            <button
              class="mini"
              :class="diagSiteId === site.id ? 'accent' : ''"
              @click="toggleDiag(site)"
            >
              诊断日志
            </button>
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
        <h3>确认导入配置</h3>
        <div class="import-preview">
          检测到 {{ pendingImport.sites.length }} 个站点，涉及
          {{ pendingOrigins.length }} 个域名：
          <ul>
            <li v-for="o in pendingOrigins" :key="o">{{ o }}</li>
          </ul>
        </div>
        <div class="steps">
          点击「授权并导入」后，Chrome 将弹出权限确认对话框。仅授权的站点会被导入，未授权或无效的站点将自动跳过。
        </div>
        <div class="foot">
          <button class="btn" @click="cancelImport">取消</button>
          <button class="btn primary" @click="confirmImport">授权并导入</button>
        </div>
      </div>
    </div>

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
.theme-switch {
  display: inline-flex;
  margin-left: auto;
  border: 1px solid var(--line);
  border-radius: 9px;
  overflow: hidden;
}
.theme-switch button {
  border: none;
  background: var(--panel);
  padding: 8px 12px;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  color: var(--sub);
}
.theme-switch button.on {
  background: var(--brand);
  color: #fff;
}
.theme-switch button + button {
  border-left: 1px solid var(--line);
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
