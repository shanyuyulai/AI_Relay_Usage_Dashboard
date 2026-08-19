<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { send, MessagingError } from '../core/messaging/client'
import type { DashboardData, CollectResultMsg, CurrencyTotal } from '../core/messaging/protocol'
import type { SiteConfig, Snapshot } from '../shared/types'
import { getThemeMode, setThemeMode, type ThemeMode } from '../shared/theme'
import { fmtBalance, fmtTokens, fmtCompactTokens, fmtNum, fmtTime, fmtMs, fmtMsClass, statusBadge } from '../shared/format'
import { registry } from '../adapters'
import { ensureOriginPermission, ensureOriginPermissions } from '../shared/permissions'
import { isValidSiteUrl } from '../shared/util'
import { shouldShowReauthorize } from '../core/authState'
import { getLabShowDashboard, LAB_SHOWDASHBOARD_CHANGED } from '../storage/labConfig'
import { fmtTodayCost, fmtTodayCostParts } from '../shared/recharge'
import { AIHUB_SETTINGS_CHANGED } from '../shared/dashboardSettings'
import SiteDetail from './components/SiteDetail.vue'

const loading = ref(false)
const syncing = ref(false)
const errorMsg = ref('')
const lastRefreshed = ref('')
const dashboard = ref<DashboardData | null>(null)
const view = ref<'dashboard' | 'detail'>('dashboard')
const detailSiteId = ref('')

function displayStatus(site: SiteConfig) {
  return site.lastStatus === 'auth_expired' && !shouldShowReauthorize(site) ? 'error' : site.lastStatus
}

function balanceClass(balance: number | null | undefined): string {
  if (balance == null) return 'is-null'
  if (balance <= 1) return 'bal-critical'
  return balance >= 5 ? 'bal-high' : 'bal-low'
}

function collectionErrorHint(site: SiteConfig): string {
  if (site.lastFailureReason === 'AUTH_CONTEXT_INCOMPLETE') return '未取得站点请求上下文，请保持控制台登录后重新检测'
  if (site.lastFailureReason === 'NETWORK_OR_TIMEOUT') return '站点请求超时，请稍后重试'
  if (site.lastFailureReason === 'CANDIDATE_REJECTED') return '未找到可用账户接口，请重新探测'
  return '采集异常，请检查站点状态后重试'
}

const adapterMap = computed<Record<string, string>>(() => {
  const m: Record<string, string> = {}
  for (const a of registry.list()) m[a.id] = a.name
  return m
})

const sites = computed(() => (dashboard.value?.sites ?? []).filter((s) => s.site.enabled))
const totalList = computed<CurrencyTotal[]>(() =>
  dashboard.value ? Object.values(dashboard.value.totals) : [],
)
const siteCount = computed(() => sites.value.length)
const okCount = computed(() => sites.value.filter((s) => s.lastStatus === 'ok').length)

const totalTodayTokens = computed(() => {
  let sum = 0
  let has = false
  for (const s of sites.value) {
    if (s.latest?.todayTokens != null) {
      sum += s.latest.todayTokens
      has = true
    }
  }
  return has ? sum : null
})

const totalTodayRequests = computed(() => {
  let sum = 0
  let has = false
  for (const s of sites.value) {
    if (s.latest?.todayRequests != null) {
      sum += s.latest.todayRequests
      has = true
    }
  }
  return has ? sum : null
})

const primaryTotal = computed<CurrencyTotal | null>(() => totalList.value[0] ?? null)
const otherTotals = computed<CurrencyTotal[]>(() => totalList.value.slice(1))

// 真实花费开关（来自 GET_DASHBOARD 响应 settings；缺省 false）
const calcRealCost = computed(() => dashboard.value?.settings?.calcRealCost === true)

async function loadDashboard() {
  loading.value = true
  errorMsg.value = ''
  try {
    dashboard.value = await send<DashboardData>('GET_DASHBOARD')
    lastRefreshed.value = fmtTime(Date.now())
  } catch (e) {
    errorMsg.value = safeUiError(e)
  } finally {
    loading.value = false
  }
}

async function syncAll() {
  syncing.value = true
  errorMsg.value = ''
  try {
    const sites = await send<SiteConfig[]>('GET_SITES')
    const granted = await ensureOriginPermissions(sites.filter((s) => s.enabled).map((s) => s.origin))
    if (!granted) {
      errorMsg.value = '未获得部分站点权限，请在 Chrome 权限弹窗中允许访问'
      return
    }
    await send<{ results: CollectResultMsg[] }>('COLLECT_NOW', undefined, 60_000)
    await loadDashboard()
  } catch (e) {
    errorMsg.value = safeUiError(e)
  } finally {
    syncing.value = false
  }
}

async function syncSite(siteId: string, ev: Event) {
  ev.stopPropagation()
  try {
    const site = dashboard.value?.sites.find((s) => s.site.id === siteId)?.site
    if (site) {
      const granted = await ensureOriginPermission(site.origin)
      if (!granted) {
        errorMsg.value = '未获得该站点权限，请在 Chrome 权限弹窗中允许访问'
        return
      }
    }
    await send<{ results: CollectResultMsg[] }>('COLLECT_NOW', { siteIds: [siteId] }, 60_000)
    await loadDashboard()
  } catch (e) {
    errorMsg.value = safeUiError(e)
  }
}

function openDetail(siteId: string) {
  detailSiteId.value = siteId
  view.value = 'detail'
}

function backToDashboard() {
  view.value = 'dashboard'
  detailSiteId.value = ''
}

// GPT P0：跨层错误白名单——绝不透传 MessagingError.message 原文
function safeUiError(e: unknown): string {
  if (e instanceof MessagingError) {
    if (e.kind === 'TIMEOUT') return '请求超时，请稍后重试'
    if (e.kind === 'NO_HANDLER') return '当前操作不可用'
    if (e.kind === 'BAD_REQUEST') return '请求参数无效'
    return '操作失败，请检查站点状态后重试'
  }
  return '操作失败，请稍后重试'
}

function openOptions() {
  chrome.runtime.openOptionsPage()
}

// Phase C：把目标 Tab 写入 session storage，Options 挂载时读取并切到 dashboard。
// 不必关心跨上下文时序：Options 挂载后只需读一次然后清空。
async function openUsageDashboard() {
  try {
    await chrome.storage.session?.set?.({ 'aihub.optsTab': 'dashboard' })
  } catch {
    /* session storage 不可用时仍打开设置页 */
  } finally {
    chrome.runtime.openOptionsPage()
  }
}

// 累计 Token 来源标注（GPT P0-2：绝不冒充；local_history 为插件历史累加）
function cumSrcLabel(src: string | null | undefined): string {
  if (src === 'dashboard') return '站'
  if (src === 'local_history') return '历'
  return ''
}
function cumSrcTitle(src: string | null | undefined): string {
  if (src === 'dashboard') return '来源：站点仪表盘权威接口返回的累计 Token'
  if (src === 'local_history') return '来源：本插件按日用量历史累加（非站点官方值）'
  return ''
}

// 今日使用金额来源标注（方案 §7.3）：dashboard_stats(统计接口权威) / logs(用量日志降级)
function todayCostSrcLabel(src: string | null | undefined): string {
  if (src === 'dashboard_stats') return '站'
  if (src === 'range_usage') return '区间'
  if (src === 'logs') return '日'
  return ''
}
function todayCostSrcTitle(src: string | null | undefined): string {
  if (src === 'dashboard_stats') return '今日使用金额来源：站点统计接口（权威）'
  if (src === 'range_usage') return '今日使用金额来源：站点自然日区间用量接口'
  if (src === 'logs') return '今日使用金额来源：当日用量明细日志（降级）'
  return ''
}
// 今日花费「分段」包装（侧栏 sc-metrics 用）：把 RMB 部分单独缩小字号渲染
function todayCostParts(site: SiteConfig, latest: Snapshot | undefined) {
  return fmtTodayCostParts(
    latest?.todayCost ?? null,
    latest?.currency ?? null,
    site.rechargeRate ?? null,
    calcRealCost.value,
  )
}

// 指标时间窗口标注（方案 §1.2）：calendar_day=自然日 / rolling_24h=近24h
function usageWindowLabel(w: string | null | undefined): string {
  if (w === 'calendar_day') return '日'
  if (w === 'rolling_24h') return '24h'
  if (w === 'range') return '区间'
  return ''
}

const theme = ref<ThemeMode>('light')
const themeIcon = computed(() => (theme.value === 'dark' ? '🌙' : theme.value === 'auto' ? '🔄' : '☀️'))

// 实验性「📊 用量看板」开关：控制侧边栏「📊」按钮显隐（与设置页 Tab 同源、实时联动）
const labShowDashboard = ref(false)
function cycleTheme() {
  const next: ThemeMode = theme.value === 'light' ? 'dark' : theme.value === 'dark' ? 'auto' : 'light'
  theme.value = next
  setThemeMode(next)
}

const notice = ref('')
let noticeTimer: number | null = null
function onRuntimeMessage(msg: { type?: string; detail?: string; enabled?: boolean }) {
  if (msg?.type === 'COLLECT_DONE' || msg?.type === 'SITES_CHANGED') {
    // 采集完成 / 设置页增删改站点后：实时刷新仪表盘
    void loadDashboard().then(() => {
      // 站点被删除后，若侧边栏正停留在其详情页，自动退回列表，避免显示已失效站点
      if (
        msg?.type === 'SITES_CHANGED' &&
        view.value === 'detail' &&
        detailSiteId.value &&
        !dashboard.value?.sites.some((s) => s.site.id === detailSiteId.value)
      ) {
        backToDashboard()
      }
    })
  } else if (msg?.type === LAB_SHOWDASHBOARD_CHANGED) {
    // 设置页切换实验性「用量看板」开关：侧边栏「📊」按钮实时显隐
    labShowDashboard.value = msg.enabled === true
  } else if (msg?.type === 'COLLECT_NOTICE') {
    // 自动后台采集即将开窗口：在侧边栏给出醒目横幅提醒（不打断用户）
    notice.value = msg.detail ?? '后台采集即将在最小化窗口进行（不打断你的操作），采完自动关闭'
    if (noticeTimer != null) clearTimeout(noticeTimer)
    noticeTimer = window.setTimeout(() => (notice.value = ''), 9000)
  } else if (msg?.type === AIHUB_SETTINGS_CHANGED) {
    // 设置页切换「计算真实花费 / 极简面板显示今日花费」：实时刷新今日花费展示
    void loadDashboard()
  }
}

onMounted(async () => {
  await loadDashboard()
  theme.value = await getThemeMode()
  labShowDashboard.value = await getLabShowDashboard()
  chrome.runtime.onMessage.addListener(onRuntimeMessage)
})

onUnmounted(() => {
  chrome.runtime.onMessage.removeListener(onRuntimeMessage)
  if (noticeTimer != null) clearTimeout(noticeTimer)
})
</script>

<template>
  <div class="shell">
    <header class="sp-head">
      <div class="logo">AI</div>
      <div class="head-info">
        <div class="sp-title">AI 中转站用量看板</div>
        <div class="sp-sub">
          {{ siteCount }} 个站点 · {{ lastRefreshed || '—' }}{{ lastRefreshed ? ' 已刷新' : '' }}
        </div>
      </div>
      <div class="acts">
        <button class="ibtn primary" :disabled="syncing" title="全部刷新" @click="syncAll">
          {{ syncing ? '⋯' : '⟳' }}
        </button>
        <button class="ibtn" :title="themeIcon + ' 主题（点击切换）'" @click="cycleTheme">{{ themeIcon }}</button>
        <button v-if="labShowDashboard" class="ibtn" aria-label="用量看板" title="用量看板（完整复刻 hubway 用量页）" @click="openUsageDashboard">📊</button>
        <button class="ibtn" title="设置" @click="openOptions">⚙</button>
      </div>
    </header>

    <main class="sp-body">
      <!-- 醒目横幅：自动后台采集即将开窗口（提前提醒，不打断操作） -->
      <div v-if="notice" class="sp-notice">
        <span class="n-ico">🔔</span>
        <span class="n-txt">{{ notice }}</span>
      </div>

      <!-- 详情视图 -->
      <SiteDetail
        v-if="view === 'detail' && detailSiteId"
        :site-id="detailSiteId"
        @back="backToDashboard"
      />

      <!-- 仪表盘视图 -->
      <template v-else>
        <div v-if="loading && !dashboard" class="state-msg">加载中…</div>
        <div v-else-if="errorMsg && !dashboard" class="state-msg err">{{ errorMsg }}</div>

        <!-- 空状态 -->
        <div v-else-if="siteCount === 0" class="empty">
          <div class="empty-icon">🛰️</div>
          <div class="empty-title">还没有添加站点</div>
          <div class="empty-desc">前往设置页添加你的第一个 AI 中转站</div>
          <button class="btn primary" @click="openOptions">前往设置</button>
        </div>

        <!-- 仪表盘内容 -->
        <template v-else>
          <div v-if="errorMsg" class="toast-err">{{ errorMsg }}</div>

          <!-- 总览 4 卡 -->
          <div class="ov-grid">
            <div class="ov-card">
              <div class="ov-label">总余额（按币种）</div>
              <div class="ov-value">
                {{ primaryTotal ? fmtBalance(primaryTotal.totalBalance, primaryTotal.currency) : '—' }}
              </div>
              <div class="ov-extra">
                <template v-if="otherTotals.length > 0">
                  {{ otherTotals.map((t) => fmtBalance(t.totalBalance, t.currency)).join(' · ') }} · 不跨币种相加
                </template>
                <template v-else-if="primaryTotal">不跨币种相加</template>
                <template v-else>暂无余额数据</template>
              </div>
            </div>
            <div class="ov-card">
              <div class="ov-label">今日 Token</div>
              <div class="ov-value">{{ fmtTokens(totalTodayTokens) }}</div>
              <div class="ov-extra">{{ siteCount }} 站点合计</div>
            </div>
            <div class="ov-card">
              <div class="ov-label">今日请求</div>
              <div class="ov-value">{{ fmtNum(totalTodayRequests) }}</div>
              <div class="ov-extra">{{ siteCount }} 站点合计</div>
            </div>
            <div class="ov-card">
              <div class="ov-label">站点状态</div>
              <div
                class="ov-value"
                :style="{
                  color: okCount === siteCount ? 'var(--ok)' : okCount > 0 ? 'var(--warn)' : 'var(--err)',
                }"
              >
                {{ okCount }}<small style="color: var(--sub)"> / {{ siteCount }} 正常</small>
              </div>
              <div v-if="okCount < siteCount" class="ov-extra">{{ siteCount - okCount }} 个需关注</div>
            </div>
          </div>

          <!-- 站点列表 -->
          <div class="sec-title">
            <span>站点列表</span>
            <a @click="openOptions">管理站点 ›</a>
          </div>

          <div
            v-for="s in sites"
            :key="s.site.id"
            class="site-card"
            :class="{ 'card-issue': s.lastStatus !== 'ok' }"
            @click="openDetail(s.site.id)"
          >
            <div class="sc-top">
              <div class="avatar" :style="{ background: s.site.color }">
                {{ s.site.name.charAt(0).toUpperCase() }}
              </div>
              <div class="sc-info">
                <div class="sc-name">
                  <a class="sc-link" :href="isValidSiteUrl(s.site.baseUrl) ? s.site.baseUrl : undefined" target="_blank" rel="noopener noreferrer" @click.stop>{{ s.site.name }}</a>
                </div>
                <div class="sc-url">
                  {{ s.site.origin.replace('https://', '') }} · {{ adapterMap[s.site.adapter] || s.site.adapter }}
                </div>
              </div>
              <span class="badge" :class="statusBadge(displayStatus(s.site)).cls">
                {{ statusBadge(displayStatus(s.site)).text }}
              </span>
            </div>

            <div class="sc-metrics" :class="{ dimmed: !s.latest }">
              <div class="m">
                <div class="k">余额</div>
                <div class="v" :class="balanceClass(s.latest?.balance)">{{ fmtBalance(s.latest?.balance ?? null, s.latest?.currency ?? null) }}</div>
              </div>
              <div class="m">
                <div class="k" title="今日使用金额（来自用量日志的消耗字段；站点未返回则显 —）">
                  今日使用
                  <span v-if="s.latest?.todayCostSource" class="src" :title="todayCostSrcTitle(s.latest.todayCostSource)">{{ todayCostSrcLabel(s.latest.todayCostSource) }}</span>
                </div>
                <div class="v">
                  <span>{{ todayCostParts(s.site, s.latest).main }}</span>
                  <span v-if="todayCostParts(s.site, s.latest).realRmb" class="cost-real"> / ¥{{ todayCostParts(s.site, s.latest).realRmb }}</span>
                </div>
              </div>
              <div class="m">
                <div class="k">
                  累计 Token
                  <span v-if="s.latest?.cumulativeTokensSource" class="src" :title="cumSrcTitle(s.latest.cumulativeTokensSource)">{{ cumSrcLabel(s.latest.cumulativeTokensSource) }}</span>
                </div>
                <div class="v">{{ fmtCompactTokens(s.latest?.cumulativeTokens ?? null) }}</div>
              </div>
            </div>

            <div class="sc-foot">
              <span>更新于 {{ fmtTime(s.latest?.takenAt) }}</span>
              <span v-if="s.latest?.quality" class="q-tag">{{ s.latest.quality }}</span>
              <span class="re" @click="syncSite(s.site.id, $event)">刷新 ⟳</span>
            </div>

            <div v-if="shouldShowReauthorize(s.site)" class="authbar">
              登录态已过期，请前往原站重新登录后点击「刷新」
            </div>
            <div v-if="s.lastStatus === 'no_source'" class="authbar info">
              该站点无精确用量接口，今日用量不展示（禁止模拟数据）
            </div>
            <div v-if="displayStatus(s.site) === 'error'" class="authbar err">
              {{ collectionErrorHint(s.site) }}
            </div>
          </div>
        </template>
      </template>
    </main>
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
  height: 100%;
}
body {
  font-family: system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
}
.shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

/* 顶部栏 */
.sp-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  background: var(--panel);
  border-bottom: 1px solid var(--line);
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
  flex-shrink: 0;
}
.head-info {
  flex: 1;
  min-width: 0;
}
.sp-title {
  font-weight: 700;
  font-size: 14px;
}
.sp-sub {
  font-size: 11px;
  color: var(--sub);
}
.acts {
  display: flex;
  gap: 6px;
}
.ibtn {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--panel);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 13px;
  color: var(--sub);
  transition: all 0.15s;
}
.ibtn:hover {
  border-color: var(--line);
  color: var(--text);
  background: var(--panel-soft);
}
.ibtn.primary {
  background: var(--brand);
  border-color: var(--brand);
  color: #fff;
}
.ibtn.primary:disabled {
  opacity: 0.6;
  cursor: default;
}

/* 主体 */
.sp-body {
  flex: 1;
  overflow-y: auto;
  padding: 14px;
}
.sp-notice {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--brand-soft);
  border: 1px solid var(--brand);
  color: var(--brand-text);
  border-radius: 10px;
  padding: 9px 12px;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 12px;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--brand) 12%, transparent);
  animation: noticeIn 0.18s ease-out;
}
.sp-notice .n-ico {
  font-size: 15px;
}
.sp-notice .n-txt {
  line-height: 1.4;
}
@keyframes noticeIn {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
.state-msg {
  text-align: center;
  color: var(--sub);
  padding: 40px 0;
}
.state-msg.err {
  color: var(--err);
}
.toast-err {
  background: var(--err-soft);
  color: var(--err);
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 11px;
  margin-bottom: 12px;
}

/* 空状态 */
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
  margin-bottom: 18px;
}

/* 总览卡 */
.ov-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-bottom: 14px;
}
.ov-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 12px 14px;
}
.ov-label {
  font-size: 11px;
  color: var(--sub);
}
.ov-value {
  font-size: 20px;
  font-weight: 800;
  margin-top: 4px;
  line-height: 1.2;
}
.ov-value small {
  font-size: 11px;
  font-weight: 600;
  color: var(--sub);
}
.ov-extra {
  font-size: 10px;
  margin-top: 3px;
  color: var(--sub);
}

/* 区段标题 */
.sec-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 6px 2px 10px;
  font-size: 12px;
  color: var(--sub);
  font-weight: 600;
}
.sec-title a {
  color: var(--brand);
  font-size: 11px;
  cursor: pointer;
}

/* 站点卡 */
.site-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 12px 14px;
  margin-bottom: 10px;
  cursor: pointer;
  transition: all 0.15s;
}
.site-card:hover {
  background: var(--panel-soft);
  border-color: var(--line);
}
.site-card.card-issue {
  opacity: 0.96;
}
.sc-top {
  display: flex;
  align-items: center;
  gap: 10px;
}
.avatar {
  width: 34px;
  height: 34px;
  border-radius: 9px;
  color: #fff;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  flex-shrink: 0;
}
.sc-info {
  flex: 1;
  min-width: 0;
}
.sc-name {
  font-weight: 700;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.sc-name .sc-link {
  color: var(--text);
  text-decoration: none;
  cursor: pointer;
}
.sc-name .sc-link:hover {
  color: var(--brand);
  text-decoration: underline;
}
.sc-url {
  font-size: 11px;
  color: var(--sub);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.badge {
  font-size: 10px;
  font-weight: 700;
  padding: 3px 9px;
  border-radius: 12px;
  flex-shrink: 0;
  white-space: nowrap;
}
.b-ok {
  background: var(--ok-soft);
  color: var(--ok);
}
.b-auth {
  background: var(--warn-soft);
  color: var(--warn);
}
.b-err {
  background: var(--err-soft);
  color: var(--err);
}
.b-info {
  background: var(--brand-soft);
  color: var(--brand-text);
}
.b-unknown {
  background: var(--panel-hover);
  color: var(--sub);
}
.sc-metrics {
  display: grid;
  /* 余额 / 今日使用（加宽以容纳 "站点币 / ¥真实RMB" 两段）/ 累计 Token */
  grid-template-columns: 1fr 1.35fr 1fr;
  margin-top: 11px;
  border-top: 1px dashed var(--line);
  padding-top: 10px;
  gap: 10px 0;
}
.sc-metrics.dimmed {
  opacity: 0.5;
}
.m {
  box-sizing: border-box;
  min-width: 0;
}
.m .k {
  font-size: 10px;
  color: var(--sub);
  display: flex;
  align-items: center;
  gap: 3px;
}
.m .k .src {
  font-size: 9px;
  line-height: 1;
  background: var(--brand-soft);
  color: var(--brand-text);
  border-radius: 4px;
  padding: 1px 3px;
}
.lat-good {
  color: var(--ok) !important;
}
.lat-warn {
  color: var(--warn) !important;
}
.lat-bad {
  color: var(--err) !important;
}
.m .v {
  font-size: 14px;
  font-weight: 700;
  margin-top: 2px;
}
.m .v.bal-high {
  color: var(--ok);
}
.m .v.bal-low {
  color: var(--warn);
}
.m .v.bal-critical {
  color: var(--err);
}
.m .v.is-null {
  color: var(--sub);
  font-weight: 400;
}
/* 「/ ¥10.340」真实消费部分：单独小字号，避免挤压今日使用主数字 */
.m .v .cost-real {
  font-size: 10px;
  color: var(--sub);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  margin-left: 2px;
}
.sc-foot {
  display: flex;
  align-items: center;
  margin-top: 9px;
  font-size: 10px;
  color: var(--sub);
  gap: 8px;
}
.q-tag {
  background: var(--brand-soft);
  color: var(--brand-text);
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 9px;
  font-weight: 600;
}
.sc-foot .re {
  margin-left: auto;
  color: var(--brand);
  cursor: pointer;
  font-size: 11px;
}
.authbar {
  margin-top: 10px;
  background: var(--warn-soft);
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 11px;
  color: var(--warn);
}
.authbar.info {
  background: var(--brand-soft);
  color: var(--brand-text);
}
.authbar.err {
  background: var(--err-soft);
  color: var(--err);
}

/* 按钮 */
.btn {
  padding: 8px 16px;
  border-radius: 9px;
  font-size: 12px;
  border: 1px solid var(--line);
  background: var(--panel);
  cursor: pointer;
  color: var(--text);
}
.btn.primary {
  background: var(--brand);
  border-color: var(--brand);
  color: #fff;
  font-weight: 600;
}
</style>
