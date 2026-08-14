<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import Chart from 'chart.js/auto'
import { send, MessagingError } from '../../core/messaging/client'
import type { SiteDetailData, GetUsageDetailsResponse } from '../../core/messaging/protocol'
import type { UsageRecord, SiteConfig, Snapshot, DailyStat, ModelUsage, SiteCollectionProfile } from '../../shared/types'
import { fmtBalance, fmtTokens, fmtCompactTokens, fmtNum, fmtTime, fmtMs, fmtMsClass, statusBadge } from '../../shared/format'
import { ensureOriginPermission } from '../../shared/permissions'
import { isValidSiteUrl } from '../../shared/util'
import { shouldShowReauthorize } from '../../core/authState'
import CollectionProfileCard from '../../options/components/CollectionProfileCard.vue'

const props = defineProps<{ siteId: string }>()
const emit = defineEmits<{ back: [] }>()

const loading = ref(false)
const errorMsg = ref('')
const refreshing = ref(false)
const data = ref<SiteDetailData | null>(null)
const range = ref<7 | 30 | 90>(7)

// 当日真实用量明细（来自 v4 GET_USAGE_DETAILS，驱动环形模型分布与 intraday 趋势）
const usageRows = ref<UsageRecord[]>([])
const usagePartial = ref(false) // 记录数 < total：被分页截断，须提示「部分数据」
// 操作序号 + 站点 + 卸载守卫：仅接受「当前站点 + 最新一次」响应，覆盖加载/刷新/siteId 切换/卸载（GPT P1-race）
const reqSeq = ref(0)
let dead = false

const site = computed<SiteConfig | null>(() => data.value?.site ?? null)
const snapshots = computed<Snapshot[]>(() => data.value?.snapshots ?? [])
const daily = computed<DailyStat[]>(() => (data.value?.dailyStats ?? []) as DailyStat[])
const latest = computed<Snapshot | null>(() => snapshots.value[0] ?? null)

function displayStatus(config: SiteConfig): SiteConfig['lastStatus'] {
  return config.lastStatus === 'auth_expired' && !shouldShowReauthorize(config) ? 'error' : config.lastStatus
}

function balanceClass(balance: number | null | undefined): string {
  if (balance == null) return 'is-null'
  if (balance <= 1) return 'bal-critical'
  return balance >= 5 ? 'bal-high' : 'bal-low'
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

// —— 数据来源（站点类型与采集方案，方案 028 侧边栏复用）：只读展示模型，不持久化 ——
const profile = ref<SiteCollectionProfile | null>(null)
const profileOpen = ref(false)
async function loadProfile(seq: number) {
  try {
    const res = await send<{ profiles: Record<string, SiteCollectionProfile> }>('GET_SITE_COLLECTION_PROFILES', {})
    if (seq !== reqSeq.value || dead) return
    profile.value = res.profiles?.[props.siteId] ?? null
  } catch {
    if (seq !== reqSeq.value || dead) return
    profile.value = null
  }
}
function dsFamily(p: SiteCollectionProfile): string {
  switch (p.classification.family) {
    case 'independent': return '独立接口'
    case 'new-api-capable': return 'New API 兼容'
    case 'one-api-compatible': return 'One API 兼容'
    default: return '待识别'
  }
}
function dsRoute(p: SiteCollectionProfile): string {
  switch (p.classification.routeProfile) {
    case 'standard': return '标准路径'
    case 'fork-path': return '变体路径'
    case 'discovered': return '网络发现'
    default: return ''
  }
}
function dsSemantics(p: SiteCollectionProfile): string {
  switch (p.classification.accountSemantics) {
    case 'current_balance_and_historical_consumed': return '当前余额/历史消耗'
    case 'quota_limit_and_used': return '总额度/已用'
    case 'direct_balance': return '直接余额'
    default: return '账户语义待定'
  }
}
function dsEngine(p: SiteCollectionProfile): string {
  return p.execution.engine === 'sw_lab' ? '零标签实验室' : '页面会话'
}
function dsSummary(p: SiteCollectionProfile): string {
  const verified = p.steps.filter((s) => s.state === 'verified').length
  if (!p.classification.probedAt) return '待探测'
  if (p.health.latestFailure?.reason === 'ACCOUNT_UNAUTHORIZED') return `${dsEngine(p)} · 需登录`
  if (p.health.lastStatus === 'error') return `${dsEngine(p)} · 采集异常`
  return `${dsEngine(p)} · 已验证 ${verified} 项`
}
// 管理类动作（重新探测/诊断/编辑/授权）在设置页完成，侧边栏仅做内联「立即同步」+ 跳转设置。
function openOptionsForManage() {
  try {
    chrome.runtime.openOptionsPage()
  } catch {
    /* 选项页不可用时静默忽略 */
  }
}

const chartLabels = computed(() => dailyTail.value.map((d) => d.date.slice(5)))
const chartTokens = computed(() => dailyTail.value.map((d) => d.tokens))
const chartRequests = computed(() => dailyTail.value.map((d) => d.requests))

// 余额趋势（按时间正序，取末尾 range 条快照）
const balanceTrend = computed(() =>
  [...snapshots.value]
    .sort((a, b) => a.takenAt - b.takenAt)
    .slice(-range.value)
    .map((s) => ({ label: fmtTime(s.takenAt), balance: s.balance })),
)
// 日趋势按 date 正序再截取，避免后台返回顺序变化导致错序（GPT P2）
const dailyTail = computed(() =>
  [...daily.value].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)).slice(-range.value),
)

// —— 模型分布：真实用量记录 与 最近快照 统一归一化（Top8 + 其他，稳定配色）——
const MODEL_PALETTE = ['#5b6cff', '#8b5cf6', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899', '#f97316']
const MAX_MODEL_SLICES = 8
function normalizeModelDist(items: { model: string; tokens: number }[]): { model: string; tokens: number }[] {
  const byModel = new Map<string, number>()
  for (const it of items) {
    const m = (it.model || '').trim() || '(未知模型)'
    const t = Number(it.tokens)
    if (!Number.isFinite(t) || t <= 0) continue
    byModel.set(m, (byModel.get(m) ?? 0) + t)
  }
  const sorted = [...byModel.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const top = sorted.slice(0, MAX_MODEL_SLICES).map(([model, tokens]) => ({ model, tokens }))
  const rest = sorted.slice(MAX_MODEL_SLICES).reduce((s, [, t]) => s + t, 0)
  if (rest > 0) top.push({ model: '其他', tokens: rest })
  return top
}
const modelAgg = computed<{ model: string; tokens: number }[]>(() => {
  if (usageRows.value.length > 0) {
    return normalizeModelDist(usageRows.value.map((r) => ({ model: r.model, tokens: r.tokens })))
  }
  return normalizeModelDist((latest.value?.modelUsages ?? []).map((m: ModelUsage) => ({ model: m.model, tokens: m.tokens })))
})
// 稳定配色：模型名 → 确定性哈希 → 调色板；「其他」固定灰（GPT P1-color）
function hashIdx(s: string, n: number): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0
  return h % n
}
function colorForModel(model: string): string {
  if (model === '其他') return '#9ca3af'
  return MODEL_PALETTE[hashIdx(model, MODEL_PALETTE.length)]
}
const usageSourceLabel = computed(() => (usageRows.value.length > 0 ? '当日用量明细' : '最近快照'))

// —— 当日使用趋势：按 ts 升序的累计 Token（intraday 仅当日有意义，与 range 无关）——
function hhmm(ts: number): string {
  const d = new Date(ts)
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}
const usageTrend = computed<{ labels: string[]; cum: number[] }>(() => {
  const rows = [...usageRows.value]
    .filter((r) => Number.isFinite(r.ts) && Number.isFinite(r.tokens))
    .sort((a, b) => (a.ts as number) - (b.ts as number))
  const labels: string[] = []
  const cum: number[] = []
  let acc = 0
  for (const r of rows) {
    acc += r.tokens as number
    labels.push(hhmm(r.ts as number))
    cum.push(acc)
  }
  return { labels, cum }
})

// —— 多图表管理：按 key 精确销毁，杜绝 Canvas/事件泄漏（GPT P1-lifecycle）——
const charts: Record<string, Chart> = {}
const balanceCanvas = ref<HTMLCanvasElement | null>(null)
const tokenCanvas = ref<HTMLCanvasElement | null>(null)
const reqCanvas = ref<HTMLCanvasElement | null>(null)
const comboCanvas = ref<HTMLCanvasElement | null>(null)
const modelCanvas = ref<HTMLCanvasElement | null>(null)
const usageCanvas = ref<HTMLCanvasElement | null>(null)

function destroyChart(key: string) {
  const c = charts[key]
  if (c) {
    c.destroy()
    delete charts[key]
  }
}
function themeColors() {
  const cs = getComputedStyle(document.documentElement)
  return {
    sub: cs.getPropertyValue('--sub').trim() || '#7a7f90',
    line: cs.getPropertyValue('--line').trim() || '#eef0f6',
    brand: cs.getPropertyValue('--brand').trim() || '#5b6cff',
    brand2: cs.getPropertyValue('--brand2').trim() || '#8b5cf6',
    text: cs.getPropertyValue('--text').trim() || '#1f2330',
  }
}
function baseScales(c: ReturnType<typeof themeColors>, yCallback: (v: number) => string) {
  return {
    x: { grid: { display: false }, ticks: { color: c.sub, font: { size: 10 }, maxTicksLimit: 8 } },
    y: {
      grid: { color: c.line },
      ticks: { color: c.sub, font: { size: 10 }, callback: (v: number) => yCallback(v) },
    },
  }
}
function makeChart(key: string, canvas: HTMLCanvasElement | null, config: any) {
  if (!canvas) return
  destroyChart(key) // 先销毁同 key 旧实例，再建新（含早退前的清理由 render* 负责）
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  charts[key] = new Chart(ctx, config)
}

function renderBalance() {
  destroyChart('balance')
  if (balanceTrend.value.length < 2) return
  const c = themeColors()
  makeChart('balance', balanceCanvas.value, {
    type: 'line',
    data: {
      labels: balanceTrend.value.map((b) => b.label),
      datasets: [
        {
          label: '余额',
          data: balanceTrend.value.map((b) => b.balance),
          borderColor: c.brand,
          backgroundColor: 'rgba(91,108,255,0.12)',
          fill: true,
          tension: 0.3,
          pointRadius: 2,
          spanGaps: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx: any) => fmtBalance(Number(ctx.raw), latest.value?.currency ?? null) } },
      },
      scales: baseScales(c, (v) => fmtBalance(v, latest.value?.currency ?? null)),
    },
  })
}

// Token 消耗趋势 → 折线/面积（对标中转站仪表盘观感）
function renderToken() {
  destroyChart('token')
  if (chartTokens.value.length === 0) return
  const c = themeColors()
  makeChart('token', tokenCanvas.value, {
    type: 'line',
    data: {
      labels: chartLabels.value,
      datasets: [
        {
          label: 'Token 消耗',
          data: chartTokens.value,
          borderColor: c.brand,
          backgroundColor: 'rgba(91,108,255,0.14)',
          fill: true,
          tension: 0.3,
          pointRadius: 2,
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx: any) => fmtTokens(Number(ctx.raw)) + ' tokens' } } },
      scales: baseScales(c, (v) => fmtTokens(v)),
    },
  })
}

// 请求数趋势 → 折线
function renderRequests() {
  destroyChart('req')
  if (chartRequests.value.length === 0) return
  const c = themeColors()
  makeChart('req', reqCanvas.value, {
    type: 'line',
    data: {
      labels: chartLabels.value,
      datasets: [
        {
          label: '请求数',
          data: chartRequests.value,
          borderColor: c.brand2,
          backgroundColor: 'rgba(139,92,246,0.14)',
          fill: true,
          tension: 0.3,
          pointRadius: 2,
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx: any) => fmtNum(Number(ctx.raw)) + ' 次' } } },
      scales: baseScales(c, (v) => fmtNum(v)),
    },
  })
}

// 多指标概览 → 双折线（Token 面积 + 请求 折线，双 Y 轴）
function renderCombo() {
  destroyChart('combo')
  if (chartTokens.value.length === 0) return
  const c = themeColors()
  makeChart('combo', comboCanvas.value, {
    type: 'line',
    data: {
      labels: chartLabels.value,
      datasets: [
        { label: 'Token', data: chartTokens.value, borderColor: c.brand, backgroundColor: 'rgba(91,108,255,0.16)', fill: true, tension: 0.3, pointRadius: 2, borderWidth: 2, yAxisID: 'y' },
        { label: '请求数', data: chartRequests.value, type: 'line', borderColor: c.brand2, backgroundColor: c.brand2, tension: 0.3, pointRadius: 2, borderWidth: 2, yAxisID: 'y1' },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true, labels: { color: c.sub, font: { size: 10 }, boxWidth: 12 } },
        tooltip: {
          callbacks: {
            label: (ctx: any) => (ctx.dataset.label === 'Token' ? fmtTokens(Number(ctx.raw)) + ' tokens' : fmtNum(Number(ctx.raw)) + ' 次'),
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: c.sub, font: { size: 10 }, maxTicksLimit: 8 } },
        y: { position: 'left', grid: { color: c.line }, ticks: { color: c.sub, font: { size: 10 }, callback: (v: number) => fmtTokens(v) } },
        y1: { position: 'right', grid: { drawOnChartArea: false }, ticks: { color: c.sub, font: { size: 10 }, callback: (v: number) => fmtNum(v) } },
      },
    },
  })
}

// 模型分布 → 环形图（doughnut），真实记录 与 最近快照 统一归一化
function renderModel() {
  destroyChart('model')
  if (modelAgg.value.length === 0) return
  const c = themeColors()
  const labels = modelAgg.value.map((m) => m.model)
  const values = modelAgg.value.map((m) => m.tokens)
  const total = values.reduce((s, v) => s + v, 0) || 1
  const colors = modelAgg.value.map((m) => colorForModel(m.model))
  makeChart('model', modelCanvas.value, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: colors, borderWidth: 0, hoverOffset: 4 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '60%',
      plugins: {
        legend: { position: 'right', labels: { color: c.sub, font: { size: 10 }, boxWidth: 10, padding: 8 } },
        tooltip: {
          callbacks: {
            label: (ctx: any) => {
              const v = Number(ctx.raw)
              const pct = ((v / total) * 100).toFixed(0)
              return `${ctx.label}：${fmtTokens(v)} (${pct}%)`
            },
          },
        },
      },
    },
  })
}

// 当日使用趋势 → 折线（累计 Token 随时间增长，intraday）
function renderUsageTrend() {
  destroyChart('usage')
  if (usageTrend.value.cum.length < 2) return
  const c = themeColors()
  makeChart('usage', usageCanvas.value, {
    type: 'line',
    data: {
      labels: usageTrend.value.labels,
      datasets: [
        {
          label: '累计 Token',
          data: usageTrend.value.cum,
          borderColor: c.brand,
          backgroundColor: 'rgba(91,108,255,0.14)',
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx: any) => fmtTokens(Number(ctx.raw)) + ' tokens' } } },
      scales: {
        x: { grid: { display: false }, ticks: { color: c.sub, font: { size: 10 }, maxTicksLimit: 8 } },
        y: { grid: { color: c.line }, ticks: { color: c.sub, font: { size: 10 }, callback: (v: number) => fmtTokens(v) } },
      },
    },
  })
}

function renderAll() {
  renderToken()
  renderRequests()
  renderCombo()
  renderModel()
  renderUsageTrend()
  renderBalance()
}

function destroyAll() {
  Object.values(charts).forEach((ch) => ch.destroy())
  for (const k of Object.keys(charts)) delete charts[k]
}

// 安全错误文案：仅依据 MessagingError.kind 映射到白名单文案，绝不回显 message/原始异常文本（GPT P0-leak）
function safeError(e: unknown): string {
  if (e instanceof MessagingError) {
    switch (e.kind) {
      case 'PERMISSION':
        return '未获得该站点权限，请在 Chrome 权限弹窗中允许访问'
      case 'TIMEOUT':
        return '请求超时，请稍后重试'
      case 'NO_SITE':
        return '站点不存在或已删除'
      default:
        return '加载失败，请稍后重试'
    }
  }
  return '加载失败，请稍后重试'
}

// 分页拉取当日全部用量明细（服务端 pageSize 硬上限 100，须翻页避免静默截断，GPT P1-trunc）
async function fetchAllUsage(sid: string, mode: 'cache-only' | 'force', seq: number): Promise<{ rows: UsageRecord[]; total: number }> {
  const out: UsageRecord[] = []
  let total = 0
  let page = 1
  const PAGE = 100
  for (let i = 0; i < 10; i++) {
    const r = await send<GetUsageDetailsResponse>('GET_USAGE_DETAILS', { id: sid, mode, page, pageSize: PAGE })
    if (seq !== reqSeq.value || dead) break
    const rows = r.rows ?? []
    total = typeof r.total === 'number' ? r.total : rows.length
    out.push(...rows)
    if (rows.length === 0 || out.length >= total) break
    page++
  }
  return { rows: out, total }
}

async function loadDetail(force: boolean) {
  const seq = ++reqSeq.value
  const sid = props.siteId
  loading.value = true
  refreshing.value = force
  errorMsg.value = ''
  try {
    if (force && site.value) {
      const granted = await ensureOriginPermission(site.value.origin)
      if (seq !== reqSeq.value || sid !== props.siteId || dead) return
      if (!granted) {
        errorMsg.value = safeError(new MessagingError('PERMISSION', 'permission denied'))
        return
      }
      await send('COLLECT_NOW', { siteIds: [sid] }, 60_000)
      if (seq !== reqSeq.value || sid !== props.siteId || dead) return
    }
    const detail = await send<SiteDetailData>('GET_SITE_DETAIL', { id: sid })
    if (seq !== reqSeq.value || sid !== props.siteId || dead) return
    data.value = detail
    usagePartial.value = false
    // 并行加载数据来源（站点类型与采集方案，方案 028）
    void loadProfile(seq)
    const usage = await fetchAllUsage(sid, force ? 'force' : 'cache-only', seq)
    if (seq !== reqSeq.value || sid !== props.siteId || dead) return
    usageRows.value = usage.rows
    usagePartial.value = usage.rows.length > 0 && usage.rows.length < usage.total
    // 先结束 loading，让 canvas 在 DOM 中挂载，再绘制；否则 canvas 为 null、图表永不显示（GPT P1-render-order）
    loading.value = false
    refreshing.value = false
    await nextTick()
    if (seq !== reqSeq.value || sid !== props.siteId || dead) return
    renderAll()
  } catch (e) {
    if (seq !== reqSeq.value || sid !== props.siteId || dead) return
    destroyAll() // 加载失败：清理可能绑定到已卸载 canvas 的旧实例
    errorMsg.value = safeError(e)
  } finally {
    if (seq === reqSeq.value && sid === props.siteId && !dead) {
      loading.value = false
      refreshing.value = false
    }
  }
}

function refresh() {
  loadDetail(true)
}

// 主题切换（<html>.theme-dark 经 chrome.storage 跨页同步）→ 重绘全部图表以套用新主题色（P2）
let themeListener: ((changes: any, area: string) => void) | null = null
function onThemeChanged() {
  nextTick(renderAll)
}

watch(range, async () => {
  if (loading.value || errorMsg.value) return
  await nextTick()
  renderAll()
})

// siteId 变化时重载（组件被复用而非重建）
watch(
  () => props.siteId,
  () => loadDetail(false),
)

onMounted(() => {
  loadDetail(false)
  if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
    themeListener = (_changes, area) => {
      if (area === 'local' && _changes['aihub.theme']) onThemeChanged()
    }
    chrome.storage.onChanged.addListener(themeListener)
  }
})
onBeforeUnmount(() => {
  dead = true
  destroyAll()
  if (themeListener && typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
    chrome.storage.onChanged.removeListener(themeListener)
  }
})

function openOrigin(url: string) {
  if (!isValidSiteUrl(url)) return
  chrome.tabs.create({ url })
}
</script>

<template>
  <div class="detail-view">
    <div class="back" @click="emit('back')">‹ 返回总览</div>

    <div v-if="loading" class="state-msg">加载中…</div>
    <div v-else-if="errorMsg" class="state-msg err">{{ errorMsg }}</div>
    <template v-else-if="site">
      <!-- 站点头卡 -->
      <div class="site-card-head">
        <div class="sc-top">
          <div class="avatar" :style="{ background: site.color }">
            {{ site.name.charAt(0).toUpperCase() }}
          </div>
          <div class="sc-info">
            <div class="sc-name">
              {{ site.name }}
              <span class="open" @click="openOrigin(site.baseUrl)">打开原站 ↗</span>
            </div>
            <div class="sc-url">{{ site.origin.replace('https://', '') }}</div>
          </div>
            <span class="badge" :class="statusBadge(displayStatus(site)).cls">
            {{ statusBadge(displayStatus(site)).text }}
          </span>
          </div>
        <!-- 数据来源：站点类型与采集方案常驻摘要（方案 028，侧边栏复用） -->
        <div class="ds-row" v-if="profile">
          <span class="chip chip-type" :title="'自动识别的站点类型（与配置适配器区分）'">{{ dsFamily(profile) }}</span>
          <span class="chip" v-if="dsRoute(profile)">{{ dsRoute(profile) }}</span>
          <span class="chip" :title="'账户字段语义契约（027 §3.1）'">{{ dsSemantics(profile) }}</span>
          <span class="chip chip-engine" :title="'采集引擎与运行态'">{{ dsSummary(profile) }}</span>
          <button class="mini link" :class="profileOpen ? 'accent' : ''" @click="profileOpen = !profileOpen">
            {{ profileOpen ? '收起方案' : '查看方案' }}
          </button>
        </div>
        <div class="ds-row muted" v-else>数据来源：待探测</div>
        <div class="sc-metrics">
          <div class="m">
            <div class="k">余额</div>
            <div class="v" :class="balanceClass(latest?.balance)">{{ fmtBalance(latest?.balance ?? null, latest?.currency ?? null) }}</div>
          </div>
          <div class="m">
            <div class="k">
              今日使用
              <span v-if="latest?.todayCostSource" class="src" :title="todayCostSrcTitle(latest.todayCostSource)">{{ todayCostSrcLabel(latest.todayCostSource) }}</span>
            </div>
            <div class="v">{{ fmtBalance(latest?.todayCost ?? null, latest?.currency ?? null) }}</div>
          </div>
          <div class="m">
            <div class="k">今日 Token</div>
            <div class="v">{{ fmtTokens(latest?.todayTokens ?? null) }}</div>
          </div>
          <div class="m">
            <div class="k">今日请求</div>
            <div class="v">{{ fmtNum(latest?.todayRequests ?? null) }}</div>
          </div>
          <div class="m">
            <div class="k">
              累计 Token
              <span v-if="latest?.cumulativeTokensSource" class="src" :title="cumSrcTitle(latest.cumulativeTokensSource)">{{ cumSrcLabel(latest.cumulativeTokensSource) }}</span>
            </div>
                <div class="v">{{ fmtCompactTokens(latest?.cumulativeTokens ?? null) }}</div>
          </div>
          <div class="m">
            <div class="k" title="账户累计输入 Token（仅权威接口 total_input_tokens；否则 —）">累计输入</div>
            <div class="v">{{ fmtCompactTokens(latest?.cumulativeInputTokens ?? null) }}</div>
          </div>
          <div class="m">
            <div class="k" title="账户累计输出 Token（仅权威接口 total_output_tokens；否则 —）">累计输出</div>
            <div class="v">{{ fmtCompactTokens(latest?.cumulativeOutputTokens ?? null) }}</div>
          </div>
          <div class="m">
            <div class="k" title="本次采集对余额接口实测往返耗时">API 往返</div>
            <div class="v" :class="fmtMsClass(latest?.apiRoundTripMs ?? null)">{{ fmtMs(latest?.apiRoundTripMs ?? null) }}</div>
          </div>
          <div class="m">
            <div class="k" title="站点自报平均 API 响应（仅权威接口返回时展示）">平均响应</div>
            <div class="v">{{ fmtMs(latest?.avgResponseTimeMs ?? null) }}</div>
          </div>
        </div>
        <!-- 展开采集方案卡（方案 028，侧边栏复用 CollectionProfileCard） -->
        <div v-if="profileOpen && profile" class="ds-card">
          <CollectionProfileCard
            :profile="profile"
            @reprobe="openOptionsForManage"
            @diagnose="openOptionsForManage"
            @edit="openOptionsForManage"
            @reauth="openOptionsForManage"
            @sync="refresh"
          />
        </div>
      </div>

      <!-- 时段切换 -->
      <div class="seg">
        <span :class="{ on: range === 7 }" @click="range = 7">近 7 天</span>
        <span :class="{ on: range === 30 }" @click="range = 30">近 30 天</span>
        <span :class="{ on: range === 90 }" @click="range = 90">近 90 天</span>
      </div>

      <!-- 1. Token 消耗趋势（折线/面积） -->
      <div v-if="daily.length > 0" class="chart-box">
        <h4>
          Token 消耗趋势
          <span v-if="latest?.quality" class="quality-tag">{{ latest.quality }}</span>
        </h4>
        <div class="chart-canvas-wrap">
          <canvas ref="tokenCanvas"></canvas>
        </div>
      </div>

      <!-- 2. 请求数趋势（折线） -->
      <div v-if="daily.length > 0" class="chart-box">
        <h4>请求数趋势</h4>
        <div class="chart-canvas-wrap">
          <canvas ref="reqCanvas"></canvas>
        </div>
      </div>

      <!-- 3. 多指标概览（双折线） -->
      <div v-if="daily.length > 0" class="chart-box">
        <h4>多指标概览（Token / 请求）</h4>
        <div class="chart-canvas-wrap">
          <canvas ref="comboCanvas"></canvas>
        </div>
      </div>

      <!-- 4. 模型分布（环形图） -->
      <div v-if="modelAgg.length > 0" class="chart-box">
        <h4>
          按模型分布
          <span class="src-note" :title="'数据来源：' + usageSourceLabel">{{ usageSourceLabel }}</span>
        </h4>
        <div class="doughnut-wrap">
          <canvas ref="modelCanvas"></canvas>
        </div>
      </div>

      <!-- 5. 当日使用趋势（intraday 累计 Token） -->
      <div class="chart-box">
        <h4>
          当日使用趋势
          <span class="src-note">当日用量明细</span>
        </h4>
        <div v-if="usageTrend.cum.length >= 2" class="chart-canvas-wrap">
          <canvas ref="usageCanvas"></canvas>
        </div>
        <div v-else-if="usageTrend.cum.length === 1" class="chart-foot">
          当日 1 笔调用 · {{ fmtTokens(usageTrend.cum[0]) }} tokens
        </div>
        <div v-else class="chart-foot">
          当日暂无用量明细，点「刷新此站点」采集 /api/v1/usage
        </div>
        <div v-if="usagePartial" class="chart-foot warn">仅显示前 {{ usageRows.length }} 条（部分数据，非完整当日用量）</div>
      </div>

      <!-- 6. 余额变化趋势（折线，置于最末） -->
      <div v-if="balanceTrend.length >= 2" class="chart-box">
        <h4>余额变化趋势</h4>
        <div class="chart-canvas-wrap">
          <canvas ref="balanceCanvas"></canvas>
        </div>
      </div>

      <button class="refresh-btn" :disabled="refreshing" @click="refresh">
        {{ refreshing ? '刷新中…' : '⟳ 刷新此站点' }}
      </button>
    </template>
  </div>
</template>

<style scoped>
.detail-view {
  padding: 2px 0 20px;
}
.back {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--brand);
  font-size: 12px;
  cursor: pointer;
  margin-bottom: 12px;
}
.state-msg {
  text-align: center;
  color: var(--sub);
  padding: 40px 0;
  font-size: 13px;
}
.state-msg.err {
  color: var(--err);
}
.site-card-head {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 12px 14px;
  margin-bottom: 14px;
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
.sc-name .open {
  font-size: 10px;
  color: var(--brand);
  cursor: pointer;
}
.sc-url {
  font-size: 11px;
  color: var(--sub);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 数据来源常驻摘要（方案 028，侧边栏复用） */
.ds-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
}
.ds-row.muted {
  color: var(--sub);
  font-size: 11px;
}
.ds-row .chip {
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--chip-bg);
  color: var(--chip-text);
  font-weight: 600;
}
.ds-row .chip-type {
  border-color: var(--brand);
  color: var(--brand-text);
}
.ds-row .chip-engine {
  background: var(--panel-soft);
}
.ds-row .mini.link {
  border: none;
  background: transparent;
  color: var(--brand-text);
  padding: 2px 4px;
  font-weight: 600;
  font-size: 11px;
  cursor: pointer;
}
.ds-row .mini.link:hover {
  text-decoration: underline;
}
.ds-card {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--line);
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
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px 0;
  margin-top: 11px;
  border-top: 1px dashed var(--line);
  padding-top: 10px;
}
.m {
  min-width: 0;
}
.m .k {
  font-size: 10px;
  color: var(--sub);
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
.m .v.sm {
  font-size: 13px;
}
.m .k .src {
  font-size: 9px;
  background: var(--brand-soft);
  color: var(--brand-text);
  border-radius: 4px;
  padding: 1px 3px;
  margin-left: 3px;
  vertical-align: middle;
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
.seg {
  display: flex;
  background: var(--panel-soft);
  border-radius: 9px;
  padding: 3px;
  margin: 0 0 14px;
}
.seg span {
  flex: 1;
  text-align: center;
  padding: 6px 0;
  border-radius: 7px;
  font-size: 11px;
  color: var(--sub);
  cursor: pointer;
  transition: all 0.15s;
}
.seg span.on {
  background: var(--panel);
  color: var(--text);
  font-weight: 700;
  box-shadow: 0 1px 4px var(--shadow);
}
.chart-box {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 14px;
  margin-bottom: 12px;
}
.chart-box h4 {
  font-size: 12px;
  margin-bottom: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.src-note {
  font-size: 9px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--panel-active, var(--panel-soft));
  color: var(--sub);
  white-space: nowrap;
}
.quality-tag {
  font-size: 9px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--brand-soft);
  color: var(--brand-text);
}
.chart-canvas-wrap {
  height: 140px;
}
.doughnut-wrap {
  height: 170px;
}
.chart-foot {
  margin-top: 8px;
  font-size: 10px;
  color: var(--sub);
  text-align: center;
}
.chart-foot.warn {
  color: var(--warn);
}
.empty-trend {
  text-align: center;
  padding: 24px 0;
  color: var(--sub);
  font-size: 12px;
}
.empty-icon {
  font-size: 24px;
  margin-bottom: 8px;
}
.empty-sub {
  font-size: 10px;
  margin-top: 4px;
  color: var(--sub);
}
.refresh-btn {
  width: 100%;
  padding: 10px;
  border: 1px solid var(--brand);
  border-radius: 9px;
  background: var(--brand);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
}
.refresh-btn:disabled {
  opacity: 0.6;
  cursor: default;
}
</style>
