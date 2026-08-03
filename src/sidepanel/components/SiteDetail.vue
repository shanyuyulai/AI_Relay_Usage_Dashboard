<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import Chart from 'chart.js/auto'
import { send, MessagingError } from '../../core/messaging/client'
import type { SiteDetailData } from '../../core/messaging/protocol'
import type { DailyStat, Snapshot, SiteConfig } from '../../shared/types'
import { fmtBalance, fmtTokens, fmtNum, fmtTime, fmtMs, fmtMsClass, statusBadge } from '../../shared/format'
import { ensureOriginPermission } from '../../shared/permissions'

const props = defineProps<{ siteId: string }>()
const emit = defineEmits<{ back: [] }>()

const loading = ref(false)
const errorMsg = ref('')
const refreshing = ref(false)
const data = ref<SiteDetailData | null>(null)
const range = ref<7 | 30 | 90>(7)

const site = computed<SiteConfig | null>(() => data.value?.site ?? null)
const snapshots = computed<Snapshot[]>(() => data.value?.snapshots ?? [])
const daily = computed<DailyStat[]>(() => (data.value?.dailyStats ?? []) as DailyStat[])
const latest = computed<Snapshot | null>(() => snapshots.value[0] ?? null)

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
const dailyTail = computed(() => daily.value.slice(-range.value))

const modelUsages = computed(() => latest.value?.modelUsages ?? [])
const totalModelTokens = computed(() => modelUsages.value.reduce((s, m) => s + m.tokens, 0) || 1)

// —— 多图表管理：每张独立 canvas + 销毁，防止 Canvas/事件泄漏（GPT P1-4）——
const charts: Record<string, Chart> = {}
const balanceCanvas = ref<HTMLCanvasElement | null>(null)
const tokenCanvas = ref<HTMLCanvasElement | null>(null)
const reqCanvas = ref<HTMLCanvasElement | null>(null)
const comboCanvas = ref<HTMLCanvasElement | null>(null)

function themeColors() {
  const cs = getComputedStyle(document.documentElement)
  return {
    sub: cs.getPropertyValue('--sub').trim() || '#7a7f90',
    line: cs.getPropertyValue('--line').trim() || '#eef0f6',
    brand: cs.getPropertyValue('--brand').trim() || '#5b6cff',
    brand2: cs.getPropertyValue('--brand2').trim() || '#8b5cf6',
  }
}

function baseScales(c: ReturnType<typeof themeColors>, yCallback: (v: number) => string) {
  return {
    x: { grid: { display: false }, ticks: { color: c.sub, font: { size: 10 } } },
    y: {
      grid: { color: c.line },
      ticks: { color: c.sub, font: { size: 10 }, callback: (v: number) => yCallback(v) },
    },
  }
}

function makeChart(key: string, canvas: HTMLCanvasElement | null, config: any) {
  if (!canvas) return
  if (charts[key]) {
    charts[key].destroy()
    delete charts[key]
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  charts[key] = new Chart(ctx, config)
}

function renderBalance() {
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

function renderToken() {
  if (chartTokens.value.length === 0) return
  const c = themeColors()
  const colors = chartTokens.value.map((_, i) => (i === chartTokens.value.length - 1 ? c.brand2 : c.brand))
  makeChart('token', tokenCanvas.value, {
    type: 'bar',
    data: {
      labels: chartLabels.value,
      datasets: [{ label: 'Token 消耗', data: chartTokens.value, backgroundColor: colors, borderRadius: 4, maxBarThickness: 40 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx: any) => fmtTokens(Number(ctx.raw)) + ' tokens' } } },
      scales: baseScales(c, (v) => fmtTokens(v)),
    },
  })
}

function renderRequests() {
  if (chartRequests.value.length === 0) return
  const c = themeColors()
  const colors = chartRequests.value.map((_, i) => (i === chartRequests.value.length - 1 ? c.brand2 : c.brand))
  makeChart('req', reqCanvas.value, {
    type: 'bar',
    data: {
      labels: chartLabels.value,
      datasets: [{ label: '请求数', data: chartRequests.value, backgroundColor: colors, borderRadius: 4, maxBarThickness: 40 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx: any) => fmtNum(Number(ctx.raw)) + ' 次' } } },
      scales: baseScales(c, (v) => fmtNum(v)),
    },
  })
}

function renderCombo() {
  if (chartTokens.value.length === 0) return
  const c = themeColors()
  makeChart('combo', comboCanvas.value, {
    type: 'bar',
    data: {
      labels: chartLabels.value,
      datasets: [
        { label: 'Token', data: chartTokens.value, backgroundColor: c.brand, borderRadius: 4, maxBarThickness: 26, yAxisID: 'y' },
        { label: '请求数', data: chartRequests.value, type: 'line', borderColor: c.brand2, backgroundColor: c.brand2, tension: 0.3, pointRadius: 2, yAxisID: 'y1' },
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
        x: { grid: { display: false }, ticks: { color: c.sub, font: { size: 10 } } },
        y: { position: 'left', grid: { color: c.line }, ticks: { color: c.sub, font: { size: 10 }, callback: (v: number) => fmtTokens(v) } },
        y1: { position: 'right', grid: { drawOnChartArea: false }, ticks: { color: c.sub, font: { size: 10 }, callback: (v: number) => fmtNum(v) } },
      },
    },
  })
}

function renderAll() {
  renderBalance()
  renderToken()
  renderRequests()
  renderCombo()
}

function destroyAll() {
  Object.values(charts).forEach((ch) => ch.destroy())
  for (const k of Object.keys(charts)) delete charts[k]
}

async function loadDetail() {
  loading.value = true
  errorMsg.value = ''
  try {
    data.value = await send<SiteDetailData>('GET_SITE_DETAIL', { id: props.siteId })
    await nextTick()
    renderAll()
  } catch (e) {
    errorMsg.value = e instanceof MessagingError ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function refresh() {
  refreshing.value = true
  errorMsg.value = ''
  try {
    if (site.value) {
      const granted = await ensureOriginPermission(site.value.origin)
      if (!granted) {
        errorMsg.value = '未获得该站点权限，请在 Chrome 权限弹窗中允许访问'
        return
      }
    }
    await send('COLLECT_NOW', { siteIds: [props.siteId] }, 60_000)
    await loadDetail()
  } catch (e) {
    errorMsg.value = e instanceof MessagingError ? e.message : String(e)
  } finally {
    refreshing.value = false
  }
}

watch(range, async () => {
  await nextTick()
  renderAll()
})

onMounted(loadDetail)
onBeforeUnmount(destroyAll)

function openOrigin(url: string) {
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
          <span class="badge" :class="statusBadge(site.lastStatus).cls">
            {{ statusBadge(site.lastStatus).text }}
          </span>
        </div>
        <div class="sc-metrics">
          <div class="m">
            <div class="k">余额</div>
            <div class="v">{{ fmtBalance(latest?.balance ?? null, latest?.currency ?? null) }}</div>
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
            <div class="v">{{ fmtTokens(latest?.cumulativeTokens ?? null) }}</div>
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
      </div>

      <!-- 时段切换 -->
      <div class="seg">
        <span :class="{ on: range === 7 }" @click="range = 7">近 7 天</span>
        <span :class="{ on: range === 30 }" @click="range = 30">近 30 天</span>
        <span :class="{ on: range === 90 }" @click="range = 90">近 90 天</span>
      </div>

      <!-- 余额趋势（折线） -->
      <div v-if="balanceTrend.length >= 2" class="chart-box">
        <h4>余额变化趋势</h4>
        <div class="chart-canvas-wrap">
          <canvas ref="balanceCanvas"></canvas>
        </div>
      </div>

      <!-- Token 消耗（柱状） -->
      <div v-if="daily.length > 0" class="chart-box">
        <h4>
          Token 消耗趋势
          <span v-if="latest?.quality" class="quality-tag">{{ latest.quality }}</span>
        </h4>
        <div class="chart-canvas-wrap">
          <canvas ref="tokenCanvas"></canvas>
        </div>
      </div>

      <!-- 请求数（柱状） -->
      <div v-if="daily.length > 0" class="chart-box">
        <h4>请求数趋势</h4>
        <div class="chart-canvas-wrap">
          <canvas ref="reqCanvas"></canvas>
        </div>
      </div>

      <!-- 多指标概览（双轴） -->
      <div v-if="daily.length > 0" class="chart-box">
        <h4>多指标概览（Token / 请求）</h4>
        <div class="chart-canvas-wrap">
          <canvas ref="comboCanvas"></canvas>
        </div>
      </div>

      <!-- 模型分布 -->
      <div v-if="modelUsages.length > 0" class="chart-box">
        <h4>最新采集 · 按模型分布</h4>
        <div class="model-row" v-for="m in modelUsages" :key="m.model">
          <span class="model-name">{{ m.model }}</span>
          <div class="bar">
            <i :style="{ width: (m.tokens / totalModelTokens) * 100 + '%' }"></i>
          </div>
          <span class="pct">{{ fmtTokens(m.tokens) }} · {{ ((m.tokens / totalModelTokens) * 100).toFixed(0) }}%</span>
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
  display: flex;
  flex-wrap: wrap;
  gap: 0;
  margin-top: 11px;
  border-top: 1px dashed var(--line);
  padding-top: 10px;
}
.m {
  flex: 0 0 33.333%;
  margin-bottom: 10px;
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
.model-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  margin-top: 8px;
}
.model-name {
  width: 110px;
  flex-shrink: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.model-row .bar {
  flex: 1;
  height: 8px;
  background: var(--panel-active);
  border-radius: 4px;
  overflow: hidden;
}
.model-row .bar i {
  display: block;
  height: 100%;
  border-radius: 4px;
  background: linear-gradient(90deg, var(--brand), var(--brand2));
}
.model-row .pct {
  width: 80px;
  text-align: right;
  color: var(--sub);
  flex-shrink: 0;
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
