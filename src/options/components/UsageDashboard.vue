<!--
  UsageDashboard.vue — 用量看板（完整复刻 hubway 用量页，Phase C）。

  视觉参考：doc/assets/hubway_usage_page_reference.png（hubway.cc「用量」页 2026-08-04 截图）。

  数据契约（v4）：
    GET_USAGE_DASHBOARD  → 顶 4 卡 + 3 个 doughnut + 1 个多线趋势
    GET_USAGE_DETAILS    → 明细表分页
    GET_USAGE_FILTER_OPTIONS → 6 个筛选下拉项

  关键不变量（GPT P0/P1 + 项目红线）：
    - P0-2 数据最小化：CSV 导出与列表展示绝不泄露服务端原始 id / 嵌套对象 / 任何凭证；
      ipHash 与 apiKeyId 仅以已哈希的伪标识展示，绝不含原始 key/ip。
    - P0 安全错误：catch 内显式 `safeError()` 白名单映射，不回显 MessagingError.message 原文。
    - P1 竞态：`reqSeq + dead` 守卫：覆盖刷新 / siteId 切换 / 卸载 / 强制同步。
    - P1 图表生命周期：key 维度销毁，杜绝 Canvas 泄漏与「残留旧实例」。
    - P1 数据完整性：明细表 isComplete=false 时显「明细不完整」徽标。
    - P1 跨币种：成本永远按币种独立展示，绝不跨币种求和。
-->
<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import Chart from 'chart.js/auto'
import { send, MessagingError } from '../../core/messaging/client'
import type {
  GetUsageDashboardResponse,
  GetUsageDetailsResponse,
  GetUsageFilterOptionsResponse,
  UsageDistributionBucketDto,
  UsageTrendPointDto,
  UsageRefreshMode,
} from '../../core/messaging/protocol'
import type { SiteConfig, UsageRecord } from '../../shared/types'
import { fmtBalance, fmtTokens, fmtNum, fmtTime, fmtMs } from '../../shared/format'

// —— Props & Emits ——
const props = defineProps<{
  /** 站点配置列表（由父组件 App.vue 提供） */
  sites: SiteConfig[]
  /** 当前选中的站点 id（undefined 表示自动选第一个 enabled 站点） */
  selectedSiteId?: string | null
}>()

const emit = defineEmits<{
  /** 站点切换：通知父组件更新选中态 */
  'update:selectedSiteId': [id: string | null]
}>()

// —— Refs：状态 ——
const loading = ref(false)
const errorMsg = ref('') // 安全错误文案（白名单映射）
const refreshing = ref(false)
const rangeHours = ref<24 | 168 | 720>(24) // 24h / 7d / 30d
const preferredCurrency = ref<string>('USD') // 顶卡选币（默认 USD）
const dashboardData = ref<GetUsageDashboardResponse | null>(null)
const detailsData = ref<GetUsageDetailsResponse | null>(null)
const filterOptions = ref<GetUsageFilterOptionsResponse | null>(null)
const filters = ref<{
  apiKeyId?: string
  model?: string
  group?: string
  type?: string
  billingMode?: string
  endpoint?: string
}>({})
const detailPage = ref(1)
const detailPageSize = ref(20) // 与截图一致
// 分页 size 白名单（GPT P1-页大小）：避免外部传入 NaN/Infinity/超大值污染缓存键
const PAGE_SIZES = [20, 50, 100] as const

// —— 竞态守卫：拆 dashboard / details / filterOptions / sync 四套独立序号 + 卸载死锁 ——
const dashboardReqSeq = ref(0)
const detailsReqSeq = ref(0)
const filterOptionsReqSeq = ref(0)
const syncReqSeq = ref(0) // 同步页：dashboard+details 必须各走自己的序号，否则会被互相丢弃
let dead = false

function safeTotal(value: unknown): number {
  return Number.isFinite(value) && Number(value) > 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(Number(value)))
    : 0
}
// 严格白名单 + 空值剔除：避免空字符串/null 进入协议字段污染缓存键
function normalizeFilters(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(filters.value)) {
    if (typeof v === 'string' && v.trim() !== '') out[k] = v.trim()
  }
  return out
}

// —— 派生：当前选中站点 ——
const selectedSite = computed<SiteConfig | null>(
  () => props.sites.find((s) => s.id === props.selectedSiteId) ?? props.sites.find((s) => s.enabled) ?? null,
)

// —— Chart.js 实例池 ——
const charts: Record<string, Chart> = {}
const distModelCanvas = ref<HTMLCanvasElement | null>(null)
const distGroupCanvas = ref<HTMLCanvasElement | null>(null)
const distEndpointCanvas = ref<HTMLCanvasElement | null>(null)
const trendCanvas = ref<HTMLCanvasElement | null>(null)

function destroyChart(key: string) {
  const c = charts[key]
  if (c) {
    c.destroy()
    delete charts[key]
  }
}

// —— 安全错误白名单（P0：绝不透传内部 message） ——
function safeError(e: unknown): string {
  if (e instanceof MessagingError) {
    const k = e.kind
    if (k === 'TIMEOUT') return '请求超时（已自动退避重试，可稍后手动刷新）'
    if (k === 'NO_HANDLER') return '当前未配置站点或采集未启用'
    if (k === 'EXCEPTION' || k === 'RUNTIME') return '采集失败，请稍后再试或检查站点状态'
    if (k === 'BAD_REQUEST') return '请求参数无效'
    return '看板数据加载失败'
  }
  return '看板数据加载失败'
}

// —— 时间窗 → 业务日（hubway=Asia/Shanghai 已在 handler 处理；其他站用 UTC 当天）——
//   handler.resolveUsageScope 已按站点时区取 date；rangeHours 仅作卡片「窗口大小」标注。
const windowLabel = computed(() => {
  const h = rangeHours.value
  if (h === 24) return '近 24 小时'
  if (h === 168) return '近 7 天'
  return '近 30 天'
})

// —— 4 张顶卡的派生数据（成本按币种分组，绝不跨币种相加） ——
const topMetrics = computed(() => dashboardData.value?.topMetrics ?? null)
const cardTokens = computed(() => {
  const m = topMetrics.value
  if (!m) return null
  const total = m.totalTokens
  const input = m.inputTokens
  const cacheRead = m.cacheReadTokens
  const cacheCreation = m.cacheCreationTokens
  const output = m.outputTokens
  // 仅在全部字段都给出时拼细分；否则只显总
  if (
    Number.isFinite(total) &&
    Number.isFinite(input) &&
    Number.isFinite(output) &&
    Number.isFinite(cacheRead) &&
    Number.isFinite(cacheCreation)
  ) {
    return { total, input, output, cacheRead, cacheCreation }
  }
  return { total, input: null, output: null, cacheRead: null, cacheCreation: null }
})
const cardCost = computed(() => {
  const m = topMetrics.value
  if (!m) return null
  const map = m.totalCostByCurrency
  const keys = Object.keys(map ?? {})
  if (keys.length === 0) return null
  // 首选用户选择的币种；不存在则用站点 currency；最后回退到第一项
  const cur = preferredCurrency.value
  const siteCur = selectedSite.value?.currency ?? ''
  const curToShow = keys.includes(cur) ? cur : keys.includes(siteCur) ? siteCur : keys[0]
  return { primary: curToShow, value: map[curToShow] ?? 0, all: map }
})

// —— Doughnut legend 表派生（模型/分组/站点 三份共用同一渲染函数）——
interface DistRow {
  key: string
  label: string
  requests: number
  tokens: number
  costByCurrency: Record<string, number>
  ratio: number
  primaryCost: number | null
}
function buildDistRows(buckets: UsageDistributionBucketDto[] | undefined): DistRow[] {
  if (!buckets) return []
  return buckets.map((b) => {
    const costKeys = Object.keys(b.costByCurrency ?? {})
    const cur = preferredCurrency.value
    const siteCur = selectedSite.value?.currency ?? ''
    const showCur = costKeys.includes(cur) ? cur : costKeys.includes(siteCur) ? siteCur : costKeys[0]
    return {
      key: b.key,
      label: b.label,
      requests: b.requests,
      tokens: b.tokens,
      costByCurrency: b.costByCurrency,
      ratio: b.ratio,
      primaryCost: showCur != null ? (b.costByCurrency[showCur] ?? null) : null,
    }
  })
}
const distModel = computed(() => buildDistRows(dashboardData.value?.distributions?.model))
const distGroup = computed(() => buildDistRows(dashboardData.value?.distributions?.group))
const distEndpoint = computed(() => buildDistRows(dashboardData.value?.distributions?.endpoint))

// —— Token 使用趋势 4 线 ——
//   入参：UsageTrendPointDto[]（ts/输入/输出/缓存读/缓存写/缓存命中率/请求数）。
//   当且仅当至少有一个桶有数据时才返回，否则让模板走「暂无趋势数据」占位。
const trendData = computed(() => {
  const pts = dashboardData.value?.tokenTrend ?? []
  if (pts.length === 0) return null
  const hasAny = pts.some(
    (p) =>
      p.inputTokens > 0 ||
      p.outputTokens > 0 ||
      p.cacheCreationTokens > 0 ||
      p.cacheReadTokens > 0 ||
      p.requests > 0,
  )
  if (!hasAny) return null
  const labels = pts.map((p) => fmtTime(p.ts))
  return {
    labels,
    input: pts.map((p) => p.inputTokens),
    output: pts.map((p) => p.outputTokens),
    cacheCreation: pts.map((p) => p.cacheCreationTokens),
    cacheRead: pts.map((p) => p.cacheReadTokens),
    hitRate: pts.map((p) => p.cacheHitRate),
    requests: pts.map((p) => p.requests),
  }
})

// —— 主题色（重渲染图表时重读 CSS 变量） ——
function themeColors() {
  const cs = getComputedStyle(document.documentElement)
  return {
    sub: cs.getPropertyValue('--sub').trim() || '#7a7f90',
    line: cs.getPropertyValue('--line').trim() || '#eef0f6',
    brand: cs.getPropertyValue('--brand').trim() || '#5b6cff',
    text: cs.getPropertyValue('--text').trim() || '#1f2330',
    panel: cs.getPropertyValue('--panel').trim() || '#ffffff',
  }
}
// —— 模型名哈希配色（与 SiteDetail 同步） ——
const MODEL_PALETTE = ['#5b6cff', '#8b5cf6', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899', '#f97316']
function hashIdx(s: string, n: number): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0
  return h % n
}
function colorForLabel(label: string): string {
  if (label === '其他') return '#9ca3af'
  return MODEL_PALETTE[hashIdx(label, MODEL_PALETTE.length)]
}

// —— 多图表渲染（按 key 销毁再重建，杜绝 Canvas 泄漏） ——
function renderDistCanvas(key: string, canvas: HTMLCanvasElement | null, rows: DistRow[]) {
  if (!canvas) return
  destroyChart(key)
  if (rows.length === 0) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const c = themeColors()
  const data = rows.map((r) => r.tokens)
  const labels = rows.map((r) => r.label)
  const colors = labels.map(colorForLabel)
  charts[key] = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [
        {
          data,
          backgroundColor: colors,
          borderColor: c.panel,
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '60%',
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx: any) => {
              const row = rows[ctx.dataIndex]
              if (!row) return ctx.label ?? ''
              const costStr =
                row.primaryCost != null ? `费用 ${fmtBalance(row.primaryCost, preferredCurrency.value)}` : ''
              return `${row.label}  ${fmtTokens(row.tokens)}  ${row.requests}次  ${costStr}`
            },
          },
        },
      },
    },
  })
}

function renderTrend() {
  destroyChart('trend')
  const t = trendData.value
  if (!t) return
  const canvas = trendCanvas.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const c = themeColors()
  // 实际有数据的桶数（任一四项 > 0 视为有效）；24 小时空桶也算点 → 单/全空都正确
  const nonEmptyPoints = t.input.map((v, i) =>
    v > 0 || t.output[i] > 0 || t.cacheCreation[i] > 0 || t.cacheRead[i] > 0 ? 1 : 0,
  )
  const effectiveCount = nonEmptyPoints.reduce<number>((s, v) => s + v, 0)
  // 单点：实际只有 1 个有效数据点 → 点半径给大一点；多点/全空：常规 0
  const pointRadius = effectiveCount === 1 ? 4 : 0
  charts['trend'] = new Chart(ctx, {
    type: 'line',
    data: {
      labels: t.labels,
      datasets: [
        {
          label: 'Input',
          data: t.input,
          borderColor: '#8b5cf6',
          backgroundColor: 'rgba(139,92,246,0.10)',
          tension: 0.25,
          fill: true,
          pointRadius,
          yAxisID: 'yTokens',
        },
        {
          label: 'Output',
          data: t.output,
          borderColor: '#06b6d4',
          backgroundColor: 'rgba(6,182,212,0.10)',
          tension: 0.25,
          fill: true,
          pointRadius,
          yAxisID: 'yTokens',
        },
        {
          label: 'Cache Creation',
          data: t.cacheCreation,
          borderColor: '#22c55e',
          backgroundColor: 'rgba(34,197,94,0.10)',
          tension: 0.25,
          fill: false,
          pointRadius,
          yAxisID: 'yTokens',
        },
        {
          label: 'Cache Read',
          data: t.cacheRead,
          borderColor: '#f59e0b',
          backgroundColor: 'rgba(245,158,11,0.10)',
          tension: 0.25,
          fill: false,
          pointRadius,
          yAxisID: 'yTokens',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top',
          labels: { color: c.sub, font: { size: 10 }, boxWidth: 12, boxHeight: 4 },
        },
        tooltip: {
          callbacks: {
            label: (ctx: any) => `${ctx.dataset.label}: ${fmtTokens(ctx.parsed.y)}`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: c.sub, font: { size: 10 }, maxTicksLimit: 8 },
        },
        yTokens: {
          position: 'left',
          grid: { color: c.line },
          ticks: {
            color: c.sub,
            font: { size: 10 },
            callback: (v: string | number) => fmtTokens(typeof v === 'number' ? v : Number(v)),
          },
          beginAtZero: true,
        },
      },
    },
  })
}

function renderAll() {
  renderDistCanvas('distModel', distModelCanvas.value, distModel.value)
  renderDistCanvas('distGroup', distGroupCanvas.value, distGroup.value)
  renderDistCanvas('distEndpoint', distEndpointCanvas.value, distEndpoint.value)
  renderTrend()
}

// —— MutationObserver 监听 <html> class 变化（主题切换） ——
let themeObserver: MutationObserver | null = null
function attachThemeObserver() {
  if (themeObserver || typeof MutationObserver === 'undefined') return
  themeObserver = new MutationObserver(() => {
    // 仅当 theme-dark 切换触发
    nextTick(() => renderAll())
  })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
}
function detachThemeObserver() {
  themeObserver?.disconnect()
  themeObserver = null
}

// —— 加载主面板（顶 4 卡 + 3 doughnut + 趋势） ——
async function loadDashboard(mode: UsageRefreshMode = 'auto') {
  const site = selectedSite.value
  if (!site) {
    dashboardData.value = null
    filterOptions.value = null
    loading.value = false
    return
  }
  const my = ++dashboardReqSeq.value
  loading.value = true
  errorMsg.value = ''
  try {
    const dash = await send<GetUsageDashboardResponse>('GET_USAGE_DASHBOARD', {
      id: site.id,
      mode,
    })
    if (dead || my !== dashboardReqSeq.value || dash.siteId !== site.id) return
    dashboardData.value = dash
    loading.value = false
    await nextTick()
    renderAll()
    // 主面板完成 API/本地回退后再读取筛选项，保证三处使用同一批记录。
    await refreshFilterOptions()
  } catch (e) {
    if (dead || my !== dashboardReqSeq.value) return
    errorMsg.value = safeError(e)
    loading.value = false
  }
}

// —— 加载明细表分页 ——
async function loadDetails() {
  const site = selectedSite.value
  if (!site) {
    detailsData.value = null
    refreshing.value = false
    return
  }
  const my = ++detailsReqSeq.value
  refreshing.value = true
  try {
    const res = await send<GetUsageDetailsResponse>('GET_USAGE_DETAILS', {
      id: site.id,
      mode: 'cache-only', // 筛选切换只走缓存，避免抖动
      filters: normalizeFilters(),
      page: detailPage.value,
      pageSize: detailPageSize.value,
    })
    if (dead || my !== detailsReqSeq.value || res.siteId !== site.id) return
    detailsData.value = res
  } catch (e) {
    if (dead || my !== detailsReqSeq.value) return
    errorMsg.value = safeError(e)
  } finally {
    if (!dead && my === detailsReqSeq.value) refreshing.value = false
  }
}

// —— 操作：刷新（强制采集） ——
async function onForceRefresh() {
  const site = selectedSite.value
  if (!site) return
  const my = ++dashboardReqSeq.value
  refreshing.value = true
  try {
    const dash = await send<GetUsageDashboardResponse>('GET_USAGE_DASHBOARD', {
      id: site.id,
      mode: 'force',
    })
    if (dead || my !== dashboardReqSeq.value || dash.siteId !== site.id) return
    dashboardData.value = dash
    await nextTick()
    renderAll()
    // 强制刷新后重拉明细与筛选项，确保一致
    await Promise.all([loadDetails(), refreshFilterOptions()])
  } catch (e) {
    if (dead || my !== dashboardReqSeq.value) return
    errorMsg.value = safeError(e)
  } finally {
    if (!dead && my === dashboardReqSeq.value) refreshing.value = false
  }
}

async function refreshFilterOptions() {
  const site = selectedSite.value
  if (!site) return
  const my = ++filterOptionsReqSeq.value
  try {
    const opts = await send<GetUsageFilterOptionsResponse>('GET_USAGE_FILTER_OPTIONS', {
      id: site.id,
      mode: 'cache-only',
    })
    if (!dead && my === filterOptionsReqSeq.value && opts.siteId === site.id) {
      filterOptions.value = opts
    }
  } catch {
    /* 筛选项刷新失败不影响主面板 */
  }
}

// —— 操作：重置筛选 ——
function onResetFilters() {
  filters.value = {}
  detailPage.value = 1
  loadDetails()
}

// —— 操作：同步页（强制采集并刷新当前分页，dashboard 与 details 各自走独立序号） ——
async function onSyncPage() {
  const site = selectedSite.value
  if (!site) return
  const syncMy = ++syncReqSeq.value
  const dashMy = ++dashboardReqSeq.value
  const detailsMy = ++detailsReqSeq.value
  refreshing.value = true
  try {
    const dash = await send<GetUsageDashboardResponse>('GET_USAGE_DASHBOARD', {
      id: site.id,
      mode: 'force',
    })
    if (dead || syncMy !== syncReqSeq.value) return
    if (dashMy === dashboardReqSeq.value && dash.siteId === site.id) {
      dashboardData.value = dash
      await nextTick()
      renderAll()
    }
    const res = await send<GetUsageDetailsResponse>('GET_USAGE_DETAILS', {
      id: site.id,
      mode: 'force',
      filters: normalizeFilters(),
      page: detailPage.value,
      pageSize: detailPageSize.value,
    })
    if (dead || syncMy !== syncReqSeq.value) return
    if (detailsMy === detailsReqSeq.value && res.siteId === site.id) {
      detailsData.value = res
    }
    void refreshFilterOptions()
  } catch (e) {
    if (dead || syncMy !== syncReqSeq.value) return
    errorMsg.value = safeError(e)
  } finally {
    if (!dead && syncMy === syncReqSeq.value) refreshing.value = false
  }
}

// —— 操作：导出 CSV（P0-2 数据最小化：仅导出已显示列，无凭证/嵌套体/原始 id；GPT P0-CSV 进一步剥离伪标识 ipHash/apiKeyId，并防 Excel 公式注入） ——
function csvEscape(v: unknown): string {
  if (v == null) return ''
  let s = String(v)
  // 防止 Excel/Sheets 将服务端文本解释为公式（以 = + - @ 开头的单元格会被当成公式执行）
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}
function onExportCsv() {
  const rows = detailsData.value?.rows ?? []
  if (rows.length === 0) {
    errorMsg.value = '当前无可导出的明细'
    return
  }
  // 列严格白名单（GPT P0-CSV）：仅业务可读维度；不含 apiKeyId / ipHash（伪标识可被跨记录关联）、不含服务端 raw id / 嵌套体 / 凭证。
  const headers = [
    'model',
    'reasoningEffort',
    'endpoint',
    'group',
    'type',
    'billingMode',
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheCreationTokens',
    'cost',
    'costCurrency',
    'standardCost',
    'standardCostCurrency',
    'ts',
  ]
  const lines = [headers.join(',')]
  for (const r of rows) {
    lines.push(
      [
        r.model ?? '',
        r.reasoningEffort ?? '',
        r.endpoint ?? '',
        r.group ?? '',
        r.type ?? '',
        r.billingMode ?? '',
        r.promptTokens ?? 0,
        r.completionTokens ?? 0,
        r.cacheReadTokens ?? 0,
        r.cacheCreationTokens ?? 0,
        r.cost ?? '',
        r.costCurrency ?? '',
        r.standardCost ?? '',
        r.standardCostCurrency ?? '',
        r.ts ?? '',
      ]
        .map(csvEscape)
        .join(','),
    )
  }
  // 加 UTF-8 BOM，让 Excel 直接识别中文
  const blob = new Blob(['\ufeff', lines.join('\n')], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const site = selectedSite.value
  const today = new Date().toISOString().slice(0, 10)
  a.href = url
  a.download = `usage-${site?.id ?? 'unknown'}-${today}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// —— 操作：分页（GPT P1-分页边界：拒绝 NaN/Infinity/越界） ——
function onPageChange(p: number) {
  const total = safeTotal(detailsData.value?.total)
  const totalPages = Math.max(1, Math.ceil(total / detailPageSize.value))
  if (!Number.isSafeInteger(p) || p < 1 || p > totalPages) return
  detailPage.value = p
  void loadDetails()
}
function onPageSizeChange(s: number) {
  if (!(PAGE_SIZES as readonly number[]).includes(s)) return
  detailPageSize.value = s
  detailPage.value = 1
  void loadDetails()
}

// —— 监听：站点切换 / 筛选切换 → 重拉（GPT P1-race：监听解析后实际站点，覆盖删除/禁用） ——
watch(
  () => selectedSite.value?.id ?? null,
  () => {
    detailPage.value = 1
    filters.value = {}
    void loadDashboard('auto').then(() => loadDetails())
  },
)

watch(
  () => ({ ...filters.value }),
  () => {
    detailPage.value = 1
    void loadDetails()
  },
  { deep: true },
)

// GPT P1-协议能力：v4 仅支持单日，移除窗口切换触发 force，避免把展示控件伪装成采集参数
// rangeHours 仍保留以便顶卡显示「近 N 小时」，但不改 v4 协议参数

watch(preferredCurrency, () => {
  // 切币种不需要重拉数据，仅重渲染图表即可（成本色块变化）
  nextTick(() => renderAll())
})

// —— 缓存徽标文案（meta.isStale + dataAsOf） ——
const cacheBadge = computed<{ label: string; tooltip: string } | null>(() => {
  const meta = dashboardData.value?.meta
  if (!meta) return null
  if (meta.isStale) {
    const m = Number.isFinite(meta.staleAgeMinutes) ? Math.max(0, Math.floor(meta.staleAgeMinutes)) : 0
    const prefix = meta.source === 'local_fallback' ? 'API 获取失败，已使用本地数据' : '缓存数据已过期'
    return {
      label: `${prefix}（${m}m 前）`,
      tooltip: `数据已陈旧 ${m} 分钟，点击「刷新」重新采集`,
    }
  }
  if (meta.source === 'cache') {
    return {
      label: '缓存数据',
      tooltip: '当前数据来自查询缓存（30 分钟内）',
    }
  }
  if (meta.source === 'api') {
    return {
      label: 'API 数据',
      tooltip: '当前数据由中转站用量 API 获取，并已保存到本地',
    }
  }
  if (meta.source === 'local_fallback') {
    return {
      label: '本地回退',
      tooltip: '用量 API 获取失败，当前显示已保存的本地记录',
    }
  }
  return null
})

// —— 行级：时延列未实现 → 显「—」 ——
function rowLatencyMs(_r: UsageRecord): number | null {
  return null
}

function fullTsLabel(ts: number): string {
  const d = new Date(ts)
  const Y = d.getFullYear()
  const M = String(d.getMonth() + 1).padStart(2, '0')
  const D = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${Y}-${M}-${D} ${h}:${m}`
}

function shortKey(k: string | null): string {
  if (!k) return '—'
  // 已哈希过的伪标识，截前 12 字符保持可读
  return k.length > 16 ? k.slice(0, 16) + '…' : k
}

// 行内 Token 条形比例：本段相对 (本段+对段) 的宽度
function tokenBarPct(self: number, other: number): number {
  const total = (Number(self) || 0) + (Number(other) || 0)
  if (total <= 0) return 0
  return Math.max(0, Math.min(100, ((Number(self) || 0) / total) * 100))
}

const distTotals = computed(() => {
  return {
    model: distModel.value.reduce((s, r) => s + r.tokens, 0),
    group: distGroup.value.reduce((s, r) => s + r.tokens, 0),
    endpoint: distEndpoint.value.reduce((s, r) => s + r.tokens, 0),
  }
})

onMounted(() => {
  attachThemeObserver()
  if (selectedSite.value) {
    void loadDashboard('auto').then(() => loadDetails())
  }
})

onBeforeUnmount(() => {
  dead = true
  detachThemeObserver()
  for (const k of Object.keys(charts)) destroyChart(k)
})

// —— 顶部分页控件 ——
const detailTotalPages = computed(() => {
  const t = safeTotal(detailsData.value?.total)
  return Math.max(1, Math.ceil(t / detailPageSize.value))
})
</script>

<template>
  <div class="ud-shell">
    <!-- 顶部：站点 + 窗口 + 货币 -->
    <div class="ud-top">
      <div class="ud-site">
        <label class="ud-lab">站点</label>
        <select
          class="ud-sel"
          :value="props.selectedSiteId ?? selectedSite?.id ?? ''"
          @change="emit('update:selectedSiteId', ($event.target as HTMLSelectElement).value || null)"
        >
          <option value="" disabled>请选择站点</option>
          <option v-for="s in sites" :key="s.id" :value="s.id" :disabled="!s.enabled">
            {{ s.name }}{{ !s.enabled ? '（已停用）' : '' }}
          </option>
        </select>
        <span v-if="!selectedSite" class="ud-warn">尚未选择站点</span>
      </div>
      <div class="ud-range">
        <label class="ud-lab">时间范围</label>
        <select v-model="rangeHours" class="ud-sel">
          <option :value="24">近 24 小时</option>
          <option :value="168" disabled>近 7 天（暂不可用）</option>
          <option :value="720" disabled>近 30 天（暂不可用）</option>
        </select>
        <span class="ud-sub">{{ windowLabel }}</span>
      </div>
      <div class="ud-cur">
        <label class="ud-lab">配额</label>
        <select v-model="preferredCurrency" class="ud-sel">
          <option v-if="topMetrics" v-for="cur in Object.keys(topMetrics.totalCostByCurrency)" :key="cur" :value="cur">
            {{ cur }}
          </option>
          <option v-if="!topMetrics" value="USD">USD</option>
        </select>
      </div>
      <div v-if="cacheBadge" class="ud-cache" :title="cacheBadge.tooltip">
        {{ cacheBadge.label }}
        <button class="ud-cache-refresh" title="刷新" @click="onForceRefresh">⟳</button>
      </div>
    </div>

    <!-- 4 张顶卡 -->
    <div class="ud-cards">
      <div class="ud-card ud-card-req">
        <div class="ud-card-h">总请求数</div>
        <div class="ud-card-v">{{ fmtNum(topMetrics?.totalRequests ?? null) }}</div>
        <div class="ud-card-sub">{{ selectedSite?.name ?? '' }}</div>
      </div>
      <div class="ud-card ud-card-token">
        <div class="ud-card-h">总 Token</div>
        <div class="ud-card-v">{{ fmtTokens(topMetrics?.totalTokens ?? null) }}</div>
        <div v-if="cardTokens && cardTokens.input != null" class="ud-card-sub">
          输入 {{ fmtTokens(cardTokens.input) }} · 缓存读 {{ fmtTokens(cardTokens.cacheRead) }} · 缓存写
          {{ fmtTokens(cardTokens.cacheCreation) }}
        </div>
        <div v-else class="ud-card-sub">—</div>
      </div>
      <div class="ud-card ud-card-cost">
        <div class="ud-card-h">总花费</div>
        <div class="ud-card-v">
          <template v-if="cardCost">{{ fmtBalance(cardCost.value, cardCost.primary) }}</template>
          <template v-else>—</template>
        </div>
        <div v-if="topMetrics" class="ud-card-sub">
          <template v-for="(v, c) in topMetrics.totalCostByCurrency" :key="c">
            <span :class="{ on: c === preferredCurrency }">{{ fmtBalance(v, c) }}</span>
            <span v-if="c !== preferredCurrency" class="ud-cur-note">（{{ c }}）</span>
          </template>
        </div>
      </div>
      <div class="ud-card ud-card-lat">
        <div class="ud-card-h">总时延</div>
        <div class="ud-card-v">{{ fmtMs(topMetrics?.avgResponseMs ?? null) }}</div>
        <div class="ud-card-sub">平均响应（{{ topMetrics?.windowHours ?? rangeHours }}h 窗口）</div>
      </div>
    </div>

    <!-- 2x2 图表区 -->
    <div class="ud-grid">
      <section class="ud-chart-card">
        <header class="ud-chart-h">
          <span>模型分布</span>
          <span class="ud-chart-hint">按 Token</span>
        </header>
        <div class="ud-chart-body">
          <div class="ud-chart-canvas">
            <canvas ref="distModelCanvas"></canvas>
          </div>
          <table class="ud-legend">
            <thead>
              <tr>
                <th>模型</th>
                <th>请求</th>
                <th>Token</th>
                <th>费用</th>
                <th>比例</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in distModel" :key="r.key">
                <td>
                  <span class="ud-dot" :style="{ background: colorForLabel(r.label) }"></span>
                  {{ r.label }}
                </td>
                <td>{{ fmtNum(r.requests) }}</td>
                <td>{{ fmtTokens(r.tokens) }}</td>
                <td>{{ r.primaryCost != null ? fmtBalance(r.primaryCost, preferredCurrency) : '—' }}</td>
                <td>{{ (r.ratio * 100).toFixed(2) }}%</td>
              </tr>
              <tr v-if="distModel.length === 0">
                <td colspan="5" class="ud-empty">暂无数据</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="ud-chart-card">
        <header class="ud-chart-h">
          <span>分组使用分布</span>
          <span class="ud-chart-hint">按 Token</span>
        </header>
        <div class="ud-chart-body">
          <div class="ud-chart-canvas">
            <canvas ref="distGroupCanvas"></canvas>
          </div>
          <table class="ud-legend">
            <thead>
              <tr>
                <th>分组</th>
                <th>请求</th>
                <th>Token</th>
                <th>费用</th>
                <th>比例</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in distGroup" :key="r.key">
                <td>
                  <span class="ud-dot" :style="{ background: colorForLabel(r.label) }"></span>
                  {{ r.label }}
                </td>
                <td>{{ fmtNum(r.requests) }}</td>
                <td>{{ fmtTokens(r.tokens) }}</td>
                <td>{{ r.primaryCost != null ? fmtBalance(r.primaryCost, preferredCurrency) : '—' }}</td>
                <td>{{ (r.ratio * 100).toFixed(2) }}%</td>
              </tr>
              <tr v-if="distGroup.length === 0">
                <td colspan="5" class="ud-empty">暂无数据</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="ud-chart-card">
        <header class="ud-chart-h">
          <span>站点分布</span>
          <span class="ud-chart-hint">按 Token</span>
        </header>
        <div class="ud-chart-body">
          <div class="ud-chart-canvas">
            <canvas ref="distEndpointCanvas"></canvas>
          </div>
          <table class="ud-legend">
            <thead>
              <tr>
                <th>站点</th>
                <th>请求</th>
                <th>Token</th>
                <th>费用</th>
                <th>比例</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in distEndpoint" :key="r.key">
                <td>
                  <span class="ud-dot" :style="{ background: colorForLabel(r.label) }"></span>
                  {{ r.label }}
                </td>
                <td>{{ fmtNum(r.requests) }}</td>
                <td>{{ fmtTokens(r.tokens) }}</td>
                <td>{{ r.primaryCost != null ? fmtBalance(r.primaryCost, preferredCurrency) : '—' }}</td>
                <td>{{ (r.ratio * 100).toFixed(2) }}%</td>
              </tr>
              <tr v-if="distEndpoint.length === 0">
                <td colspan="5" class="ud-empty">暂无数据</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="ud-chart-card">
        <header class="ud-chart-h">
          <span>Token 使用趋势</span>
          <span class="ud-chart-hint">{{ trendData ? `${trendData.labels.length} 个点` : '—' }}</span>
        </header>
        <div class="ud-chart-body ud-chart-body-full">
          <div v-if="trendData" class="ud-chart-canvas-trend">
            <canvas ref="trendCanvas"></canvas>
          </div>
          <div v-else class="ud-empty">暂无趋势数据</div>
        </div>
      </section>
    </div>

    <!-- 筛选条 + 操作按钮 -->
    <div class="ud-filters">
      <div class="ud-filter">
        <label>API 密钥</label>
        <select v-model="filters.apiKeyId">
          <option :value="undefined">请选择</option>
          <option v-for="k in filterOptions?.apiKeyIds ?? []" :key="k" :value="k">{{ shortKey(k) }}</option>
        </select>
      </div>
      <div class="ud-filter">
        <label>模型</label>
        <select v-model="filters.model">
          <option :value="undefined">请选择</option>
          <option v-for="m in filterOptions?.models ?? []" :key="m" :value="m">{{ m }}</option>
        </select>
      </div>
      <div class="ud-filter">
        <label>分组</label>
        <select v-model="filters.group">
          <option :value="undefined">请选择</option>
          <option v-for="g in filterOptions?.groups ?? []" :key="g" :value="g">{{ g }}</option>
        </select>
      </div>
      <div class="ud-filter">
        <label>类型</label>
        <select v-model="filters.type">
          <option :value="undefined">请选择</option>
          <option v-for="t in filterOptions?.types ?? []" :key="t" :value="t">{{ t }}</option>
        </select>
      </div>
      <div class="ud-filter">
        <label>计费模式</label>
        <select v-model="filters.billingMode">
          <option :value="undefined">请选择</option>
          <option v-for="b in filterOptions?.billingModes ?? []" :key="b" :value="b">{{ b }}</option>
        </select>
      </div>
      <div class="ud-filter">
        <label>端点</label>
        <select v-model="filters.endpoint">
          <option :value="undefined">请选择</option>
          <option v-for="e in filterOptions?.endpoints ?? []" :key="e" :value="e">{{ e }}</option>
        </select>
      </div>
      <div class="ud-ops">
        <button class="ud-btn" :disabled="refreshing" @click="onForceRefresh">刷新</button>
        <button class="ud-btn" :disabled="refreshing" @click="onResetFilters">重置</button>
        <button class="ud-btn" :disabled="refreshing" @click="onSyncPage">同步页</button>
        <button class="ud-btn ud-btn-pri" :disabled="refreshing || (detailsData?.rows.length ?? 0) === 0" @click="onExportCsv">导出 CSV</button>
      </div>
    </div>

    <!-- 错误条（白名单文案） -->
    <div v-if="errorMsg" class="ud-err">
      {{ errorMsg }}
      <button class="ud-err-close" title="关闭" @click="errorMsg = ''">×</button>
    </div>

    <!-- 明细表 -->
    <div class="ud-table-wrap">
      <div v-if="detailsData && !detailsData.isComplete" class="ud-partial">
        明细不完整{{ detailsData.truncatedReason ? `：${detailsData.truncatedReason}` : '（命中采集上限被截断，建议调整筛选缩小范围）' }}
      </div>
      <table class="ud-table">
        <colgroup>
          <col class="c-key" />
          <col class="c-model" />
          <col class="c-eff" />
          <col class="c-endpoint" />
          <col class="c-ip" />
          <col class="c-group" />
          <col class="c-type" />
          <col class="c-bm" />
          <col class="c-token" />
          <col class="c-cost" />
          <col class="c-lat" />
          <col class="c-time" />
        </colgroup>
        <thead>
          <tr>
            <th>API 密钥</th>
            <th>模型</th>
            <th>推理强度</th>
            <th>端点</th>
            <th>IP</th>
            <th>分组</th>
            <th>类型</th>
            <th>计费模式</th>
            <th class="ud-th-token">TOKEN</th>
            <th class="ud-th-cost">费用</th>
            <th class="ud-th-lat">时延</th>
            <th>时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in detailsData?.rows ?? []" :key="r.id">
            <td :title="r.apiKeyId ?? undefined">{{ shortKey(r.apiKeyId) }}</td>
            <td :title="r.model">{{ r.model }}</td>
            <td>{{ r.reasoningEffort ?? '—' }}</td>
            <td :title="r.endpoint ?? undefined">{{ r.endpoint ?? '—' }}</td>
            <td :title="r.ipHash ?? undefined">{{ r.ipHash ? r.ipHash.slice(0, 12) + '…' : '—' }}</td>
            <td>{{ r.group ?? '—' }}</td>
            <td>{{ r.type ?? '—' }}</td>
            <td>{{ r.billingMode ?? '—' }}</td>
            <td class="ud-td-token">
              <div class="ud-bar">
                <span class="ud-bar-in" :style="{ width: tokenBarPct(r.promptTokens, r.completionTokens) + '%' }">
                  {{ fmtTokens(r.promptTokens) }}
                </span>
                <span class="ud-bar-out" :style="{ width: tokenBarPct(r.completionTokens, r.promptTokens) + '%' }">
                  {{ fmtTokens(r.completionTokens) }}
                </span>
              </div>
              <div v-if="r.cacheReadTokens" class="ud-cache-bar" :title="'缓存读 ' + fmtTokens(r.cacheReadTokens)">
                <span :style="{ width: Math.min(100, (r.cacheReadTokens / Math.max(1, r.tokens)) * 100) + '%' }"></span>
              </div>
            </td>
            <td class="ud-td-cost">
              <div class="ud-cost-line">
                {{ r.cost != null ? fmtBalance(r.cost, r.costCurrency) : '—' }}
              </div>
              <div v-if="r.standardCost != null" class="ud-cost-sub">
                {{ fmtBalance(r.standardCost, r.standardCostCurrency ?? r.costCurrency) }}
              </div>
            </td>
            <td>{{ fmtMs(rowLatencyMs(r)) }}</td>
            <td>{{ fullTsLabel(r.ts) }}</td>
          </tr>
          <tr v-if="(detailsData?.rows.length ?? 0) === 0 && !refreshing">
            <td colspan="12" class="ud-empty">暂无明细数据（请先在站点页内产生一次调用，或点击「同步页」强制采集）</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 分页 -->
    <div class="ud-pager">
      <span class="ud-pager-info">
        共 {{ fmtNum(detailsData?.total ?? 0) }} 条 ·
        每页
        <select :value="detailPageSize" @change="onPageSizeChange(Number(($event.target as HTMLSelectElement).value))">
          <option :value="20">20</option>
          <option :value="50">50</option>
          <option :value="100">100</option>
        </select>
      </span>
      <div class="ud-pager-btns">
        <button :disabled="detailPage <= 1 || refreshing" @click="onPageChange(1)">«</button>
        <button :disabled="detailPage <= 1 || refreshing" @click="onPageChange(detailPage - 1)">‹</button>
        <span class="ud-pager-cur">{{ detailPage }} / {{ detailTotalPages }}</span>
        <button :disabled="detailPage >= detailTotalPages || refreshing" @click="onPageChange(detailPage + 1)">›</button>
        <button :disabled="detailPage >= detailTotalPages || refreshing" @click="onPageChange(detailTotalPages)">»</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ud-shell {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.ud-top {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  padding: 12px 14px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
}
.ud-site,
.ud-range,
.ud-cur {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ud-lab {
  font-size: 11px;
  color: var(--sub);
  white-space: nowrap;
}
.ud-sel {
  font-size: 12px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--panel-soft);
  color: var(--text);
  padding: 5px 8px;
  min-width: 100px;
}
.ud-sub {
  font-size: 11px;
  color: var(--sub);
}
.ud-warn {
  font-size: 11px;
  color: var(--warn);
}
.ud-cache {
  margin-left: auto;
  font-size: 11px;
  background: var(--brand-soft);
  color: var(--brand-text);
  border-radius: 6px;
  padding: 4px 10px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.ud-cache-refresh {
  border: none;
  background: transparent;
  color: var(--brand-text);
  cursor: pointer;
  font-size: 12px;
  padding: 0;
}

.ud-cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}
.ud-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 14px 16px;
}
.ud-card-h {
  font-size: 11px;
  color: var(--sub);
  margin-bottom: 6px;
}
.ud-card-v {
  font-size: 22px;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 4px;
}
.ud-card-sub {
  font-size: 10px;
  color: var(--sub);
  line-height: 1.5;
}
.ud-card-req {
  border-top: 2px solid #5b6cff;
}
.ud-card-token {
  border-top: 2px solid #8b5cf6;
}
.ud-card-cost {
  border-top: 2px solid #22c55e;
}
.ud-card-lat {
  border-top: 2px solid #f59e0b;
}
.ud-cur-note {
  margin-left: 2px;
  color: var(--sub);
}

.ud-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}
.ud-chart-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 12px 14px;
}
.ud-chart-h {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.ud-chart-h > span:first-child {
  font-size: 13px;
  font-weight: 700;
  color: var(--text);
}
.ud-chart-hint {
  font-size: 10px;
  color: var(--sub);
}
.ud-chart-body {
  display: grid;
  grid-template-columns: 160px 1fr;
  gap: 12px;
  min-height: 180px;
}
.ud-chart-body-full {
  grid-template-columns: 1fr;
}
.ud-chart-canvas,
.ud-chart-canvas-trend {
  position: relative;
  height: 180px;
}
.ud-chart-canvas-trend {
  height: 240px;
}
.ud-legend {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}
.ud-legend th {
  text-align: left;
  font-weight: 600;
  color: var(--sub);
  padding: 4px 6px;
  border-bottom: 1px solid var(--line);
  white-space: nowrap;
}
.ud-legend td {
  padding: 4px 6px;
  border-bottom: 1px solid var(--panel-active);
  color: var(--text);
  white-space: nowrap;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ud-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 6px;
  vertical-align: middle;
}
.ud-empty {
  text-align: center;
  color: var(--sub);
  padding: 18px;
}

.ud-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding: 12px 14px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  align-items: center;
}
.ud-filter {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.ud-filter label {
  font-size: 10px;
  color: var(--sub);
}
.ud-filter select {
  font-size: 11px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel-soft);
  color: var(--text);
  padding: 4px 6px;
  min-width: 110px;
}
.ud-ops {
  display: flex;
  gap: 8px;
  margin-left: auto;
  align-self: flex-end;
}
.ud-btn {
  font-size: 11px;
  padding: 5px 12px;
  border-radius: 6px;
  border: 1px solid var(--line);
  background: var(--panel-soft);
  color: var(--text);
  cursor: pointer;
}
.ud-btn:hover:not(:disabled) {
  background: var(--panel-active);
}
.ud-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.ud-btn-pri {
  background: var(--brand);
  color: #fff;
  border-color: var(--brand);
}
.ud-btn-pri:hover:not(:disabled) {
  opacity: 0.9;
}

.ud-err {
  background: var(--err-soft);
  color: var(--err);
  border-radius: var(--radius);
  padding: 8px 12px;
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.ud-err-close {
  border: none;
  background: transparent;
  color: var(--err);
  font-size: 16px;
  cursor: pointer;
  padding: 0 4px;
}

.ud-table-wrap {
  overflow-x: auto;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  min-width: 0;
  max-width: 100%;
}
.ud-table {
  width: 100%;
  /* 12 列展开需要；外层 overflow-x:auto 让窄视口容器内滚动而非页面级横向滚动 */
  min-width: 1180px;
  table-layout: fixed;
  border-collapse: collapse;
  font-size: 11px;
}
.ud-partial {
  background: var(--warn-soft, rgba(245, 158, 11, 0.12));
  color: var(--warn, #b45309);
  font-size: 11px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
}
.ud-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}
.ud-table th {
  background: var(--panel-soft);
  color: var(--sub);
  text-align: left;
  padding: 6px 8px;
  font-weight: 600;
  border-bottom: 1px solid var(--line);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ud-table td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--panel-active);
  color: var(--text);
  vertical-align: middle;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 列宽策略（GPT P1-列宽）：关键列固定宽度，避免内容抖动 */
/* 严格列宽：API密钥/模型/端点等长字段设固定宽度避免横向溢出 */
.ud-table col.c-key { width: 100px; }
.ud-table col.c-model { width: 130px; }
.ud-table col.c-eff { width: 70px; }
.ud-table col.c-endpoint { width: 110px; }
.ud-table col.c-ip { width: 100px; }
.ud-table col.c-group { width: 90px; }
.ud-table col.c-type { width: 80px; }
.ud-table col.c-bm { width: 100px; }
.ud-table col.c-token { width: 200px; }
.ud-table col.c-cost { width: 110px; }
.ud-table col.c-lat { width: 70px; }
.ud-table col.c-time { width: 140px; }
.ud-th-token,
.ud-td-token {
  min-width: 180px;
}
.ud-bar {
  display: flex;
  height: 14px;
  border-radius: 3px;
  overflow: hidden;
  background: var(--panel-soft);
  font-size: 9px;
  font-weight: 600;
  line-height: 14px;
  color: #fff;
}
.ud-bar-in {
  background: #8b5cf6;
  text-align: center;
  white-space: nowrap;
}
.ud-bar-out {
  background: #06b6d4;
  text-align: center;
  white-space: nowrap;
}
.ud-cache-bar {
  margin-top: 2px;
  height: 3px;
  background: var(--panel-soft);
  border-radius: 2px;
  overflow: hidden;
}
.ud-cache-bar > span {
  display: block;
  height: 100%;
  background: #f59e0b;
}
.ud-th-cost {
  min-width: 90px;
}
.ud-cost-line {
  font-weight: 600;
  color: var(--text);
}
.ud-cost-sub {
  font-size: 10px;
  color: var(--sub);
}
.ud-th-lat {
  min-width: 60px;
}

.ud-pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
}
.ud-pager-info {
  font-size: 11px;
  color: var(--sub);
}
.ud-pager-info select {
  font-size: 11px;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: var(--panel-soft);
  color: var(--text);
  padding: 2px 6px;
  margin: 0 4px;
}
.ud-pager-btns {
  display: inline-flex;
  gap: 4px;
}
.ud-pager-btns button {
  font-size: 11px;
  border: 1px solid var(--line);
  background: var(--panel-soft);
  color: var(--text);
  padding: 3px 8px;
  border-radius: 5px;
  cursor: pointer;
}
.ud-pager-btns button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.ud-pager-cur {
  font-size: 11px;
  color: var(--sub);
  align-self: center;
  padding: 0 6px;
}
</style>
