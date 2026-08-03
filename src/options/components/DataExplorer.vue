<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { send, MessagingError } from '../../core/messaging/client'
import type {
  GetSiteDataResponse,
  RetentionResponse,
  CollectIntervalResponse,
  LabZeroTabResponse,
  LabCorsResponse,
  ResetDataResponse,
} from '../../core/messaging/protocol'
import type { SiteConfig, Snapshot, DailyStat, CustomCaptureRecord } from '../../shared/types'
import { fmtBalance, fmtTokens, fmtNum, fmtDateTime } from '../../shared/format'

const props = defineProps<{ sites: SiteConfig[] }>()

const RETENTION_OPTIONS = [
  { value: 7, label: '7 天' },
  { value: 30, label: '30 天（默认）' },
  { value: 90, label: '90 天' },
  { value: 0, label: '永久（全存着）' },
]

const INTERVAL_PRESETS = [5, 15, 30, 60]
const INTERVAL_OPTIONS = [
  { value: 'off', label: '关闭（仅手动）' },
  { value: 5, label: '5 分钟' },
  { value: 15, label: '15 分钟' },
  { value: 30, label: '30 分钟（默认）' },
  { value: 60, label: '60 分钟' },
  { value: 'custom', label: '自定义…' },
]

const selectedSiteId = ref<string>('')
const retentionDays = ref<number>(30)
// 自动采集间隔：实际保存值（分钟数或 'off'）
const interval = ref<number | 'off'>(30)
// 下拉视图值：预设/关闭直接显示，非预设显示“自定义”
const intervalSel = ref<number | 'off' | 'custom'>(30)
const customValue = ref<number>(30)
// 实验室：SW 零标签后台采集开关（默认关闭）
const labEnabled = ref<boolean>(false)
// 实验室：动态 CORS 放行开关（默认关闭）
const labCorsEnabled = ref<boolean>(false)
const data = ref<GetSiteDataResponse | null>(null)
const loading = ref(false)
const msg = ref('')
const msgTimer = ref<number | null>(null)

// 分页：每页大小可选，各表独立当前页
const PAGE_SIZE_OPTIONS = [20, 40, 60, 120, 200]
const pageSize = ref<number>(20)
const pageSnapshots = ref(1)
const pageDaily = ref(1)
const pageCaptures = ref(1)
const expanded = ref<Set<string>>(new Set())

const ALL_SITES_ID = '__all__'

const siteOptions = computed(() => [
  { id: ALL_SITES_ID, label: `全部站点（聚合 ${props.sites.length} 个）` },
  ...props.sites.map((s) => ({
    id: s.id,
    label: `${s.name}（${s.origin.replace('https://', '')}）`,
  })),
])

const selectedSite = computed<SiteConfig | undefined>(() =>
  selectedSiteId.value === ALL_SITES_ID
    ? undefined
    : props.sites.find((s) => s.id === selectedSiteId.value),
)

function paginate<T>(list: T[], page: number): T[] {
  const start = (page - 1) * pageSize.value
  return list.slice(start, start + pageSize.value)
}

const snapshotsTotal = computed(() => data.value?.snapshots.length ?? 0)
const dailyTotal = computed(() => data.value?.dailyStats.length ?? 0)
const capturesTotal = computed(() => data.value?.captures.length ?? 0)

const snapshotsTotalPages = computed(() => Math.max(1, Math.ceil(snapshotsTotal.value / pageSize.value)))
const dailyTotalPages = computed(() => Math.max(1, Math.ceil(dailyTotal.value / pageSize.value)))
const capturesTotalPages = computed(() => Math.max(1, Math.ceil(capturesTotal.value / pageSize.value)))

const snapshotsView = computed(() => paginate(data.value?.snapshots ?? [], pageSnapshots.value))
const dailyView = computed(() => paginate(data.value?.dailyStats ?? [], pageDaily.value))
const capturesView = computed(() => paginate(data.value?.captures ?? [], pageCaptures.value))

// 每页大小变化：所有表回到第 1 页
function onPageSizeChange() {
  pageSnapshots.value = 1
  pageDaily.value = 1
  pageCaptures.value = 1
}

// 生成页码数组，-1 表示省略号
function pageBtns(total: number, current: number): number[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const arr: number[] = [1]
  const start = Math.max(2, current - 1)
  const end = Math.min(total - 1, current + 1)
  if (start > 2) arr.push(-1)
  for (let p = start; p <= end; p++) arr.push(p)
  if (end < total - 1) arr.push(-1)
  arr.push(total)
  return arr
}

function showMsg(text: string) {
  msg.value = text
  if (msgTimer.value) clearTimeout(msgTimer.value)
  msgTimer.value = window.setTimeout(() => (msg.value = ''), 4000)
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function toggleExpand(key: string) {
  const next = new Set(expanded.value)
  next.has(key) ? next.delete(key) : next.add(key)
  expanded.value = next
}

async function loadRetention() {
  try {
    const res = await send<RetentionResponse>('GET_RETENTION')
    retentionDays.value = res.days
  } catch {
    /* 忽略，使用默认 30 */
  }
}

async function loadInterval() {
  try {
    const res = await send<CollectIntervalResponse>('GET_COLLECT_INTERVAL')
    syncInterval(res.interval)
  } catch {
    /* 忽略，使用默认 30 */
  }
}

async function loadLab() {
  try {
    const res = await send<LabZeroTabResponse>('GET_LAB_ZEROTAB')
    labEnabled.value = res.enabled
  } catch {
    /* 忽略，默认关闭 */
  }
}

async function loadLabCors() {
  try {
    const res = await send<LabCorsResponse>('GET_LAB_CORS')
    labCorsEnabled.value = res.enabled
  } catch {
    /* 忽略，默认关闭 */
  }
}

async function saveLab() {
  try {
    const res = await send<LabZeroTabResponse>('SET_LAB_ZEROTAB', { enabled: labEnabled.value })
    labEnabled.value = res.enabled
    showMsg(
      res.enabled
        ? '已开启实验室：SW 零标签后台采集（实验性，可能不稳定）'
        : '已关闭实验室零标签采集（回退到临时后台窗口方案）',
    )
  } catch (e) {
    showMsg(e instanceof MessagingError ? e.message : String(e))
  }
}

async function saveLabCors() {
  try {
    const res = await send<LabCorsResponse>('SET_LAB_CORS', { enabled: labCorsEnabled.value })
    labCorsEnabled.value = res.enabled
    showMsg(
      res.enabled
        ? '已开启动态 CORS 放行（实验性）：扩展会尝试给已启用站点的响应添加 Access-Control-Allow-Origin: *'
        : '已关闭动态 CORS 放行',
    )
  } catch (e) {
    showMsg(e instanceof MessagingError ? e.message : String(e))
  }
}

// 把后台返回的间隔值同步到视图（处理预设 / 自定义 / 关闭三种形态）
function syncInterval(v: number | 'off') {
  interval.value = v
  if (v === 'off') intervalSel.value = 'off'
  else if (INTERVAL_PRESETS.includes(v)) intervalSel.value = v
  else {
    intervalSel.value = 'custom'
    customValue.value = v
  }
}

async function refresh() {
  if (!selectedSiteId.value) {
    showMsg('请先选择站点')
    return
  }
  loading.value = true
  msg.value = ''
  try {
    data.value = await send<GetSiteDataResponse>('GET_SITE_DATA', { siteId: selectedSiteId.value })
    pageSnapshots.value = 1
    pageDaily.value = 1
    pageCaptures.value = 1
    expanded.value = new Set()
  } catch (e) {
    showMsg(e instanceof MessagingError ? e.message : String(e))
  } finally {
    loading.value = false
  }
}

async function changeRetention() {
  try {
    const res = await send<RetentionResponse>('SET_RETENTION', { days: retentionDays.value })
    retentionDays.value = res.days
    showMsg(
      res.days <= 0
        ? '已设为永久保存（全部保留，定时清理将跳过）'
        : `保留时长已设为 ${res.days} 天（过期数据将在采集或每日定时清理时删除）`,
    )
  } catch (e) {
    showMsg(e instanceof MessagingError ? e.message : String(e))
  }
}

// 下拉切换：选到预设或“关闭”时立即保存；选到“自定义”时展开输入框等待手动应用
function onIntervalSelChange() {
  if (intervalSel.value !== 'custom') {
    void saveInterval(intervalSel.value as number | 'off')
  }
}

async function saveInterval(v: number | 'off') {
  try {
    const res = await send<CollectIntervalResponse>('SET_COLLECT_INTERVAL', { interval: v })
    syncInterval(res.interval)
    showMsg(
      res.interval === 'off'
        ? '自动采集已关闭（可手动刷新）'
        : `自动采集已设为每 ${res.interval} 分钟（后台按此周期采集已打开的站点标签页）`,
    )
  } catch (e) {
    showMsg(e instanceof MessagingError ? e.message : String(e))
  }
}

async function applyCustom() {
  const v = Math.min(1440, Math.max(1, Math.round(customValue.value || 30)))
  customValue.value = v
  await saveInterval(v)
}

// —— 导出 ——
function download(filename: string, text: string, mime = 'application/json') {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function exportJson() {
  if (!data.value) return
  const isAll = selectedSiteId.value === ALL_SITES_ID
  const payload = {
    exportedAt: Date.now(),
    site: isAll ? { id: ALL_SITES_ID, name: '全部站点聚合' } : selectedSite.value,
    summary: data.value.summary,
    snapshots: data.value.snapshots,
    dailyStats: data.value.dailyStats,
    captures: data.value.captures,
  }
  const filename = isAll
    ? `all-sites-data-${new Date().toISOString().slice(0, 10)}.json`
    : `site-data-${selectedSite.value!.id}-${new Date().toISOString().slice(0, 10)}.json`
  download(filename, JSON.stringify(payload, null, 2))
  showMsg(isAll ? '已导出全部站点聚合数据（JSON，不含凭证）' : '已导出该站全部采集数据（JSON，不含凭证）')
}

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function exportCsv() {
  if (!data.value) return
  const isAll = selectedSiteId.value === ALL_SITES_ID
  const lines: string[] = []
  lines.push('类型,站点,日期/时间,币种,余额,Tokens,当日请求,累计请求,花费,渠道,质量,状态,备注')
  for (const d of data.value.dailyStats) {
    const siteName = props.sites.find((s) => s.id === d.siteId)?.name ?? d.siteId
    lines.push(
      ['每日用量', siteName, d.date, d.currency ?? '', '', fmtNum(d.tokens), fmtNum(d.requests), '', fmtBalance(d.cost, d.currency), '', '', '', ''].map(csvCell).join(','),
    )
  }
  for (const s of data.value.snapshots) {
    const siteName = props.sites.find((st) => st.id === s.siteId)?.name ?? s.siteId
    lines.push(
      ['余额快照', siteName, new Date(s.takenAt).toISOString(), s.currency ?? '', fmtBalance(s.balance, s.currency), fmtTokens(s.todayTokens), fmtNum(s.todayRequests), fmtNum(s.totalRequests), '', s.channel, s.quality, s.status, s.errorKind ?? ''].map(csvCell).join(','),
    )
  }
  const filename = isAll
    ? `all-sites-data-${new Date().toISOString().slice(0, 10)}.csv`
    : `site-data-${selectedSite.value!.id}-${new Date().toISOString().slice(0, 10)}.csv`
  download(filename, '\ufeff' + lines.join('\n'), 'text/csv')
  showMsg(isAll ? '已导出全部站点聚合 CSV' : '已导出快照+每日用量 CSV')
}

// —— 重置 ——
async function resetSite() {
  if (!selectedSiteId.value || !selectedSite.value) return
  if (!confirm(`确定清空站点「${selectedSite.value.name}」的全部采集数据？\n（余额历史 / 每日用量 / 自定义采集，不影响站点配置与凭证）`)) return
  try {
    const res = await send<ResetDataResponse>('RESET_SITE_DATA', { siteId: selectedSiteId.value })
    const { snapshots, dailyStats, captures } = res.deleted
    showMsg(`已清空：快照 ${snapshots} · 每日用量 ${dailyStats} · 自定义采集 ${captures}`)
    await refresh()
  } catch (e) {
    showMsg(e instanceof MessagingError ? e.message : String(e))
  }
}

async function resetAll() {
  if (!confirm('确定清空【全部站点】的采集数据？\n（余额历史 / 每日用量 / 自定义采集，不影响站点配置与凭证，不可恢复）')) return
  try {
    const res = await send<ResetDataResponse>('RESET_ALL_DATA', {})
    const { snapshots, dailyStats, captures } = res.deleted
    showMsg(`已全局清空：快照 ${snapshots} · 每日用量 ${dailyStats} · 自定义采集 ${captures}`)
    await refresh()
  } catch (e) {
    showMsg(e instanceof MessagingError ? e.message : String(e))
  }
}

watch(
  () => props.sites,
  (list) => {
    if (!selectedSiteId.value && list.length > 0) {
      selectedSiteId.value = ALL_SITES_ID
      void refresh()
    }
  },
  { immediate: true },
)

onMounted(() => {
  loadRetention()
  loadInterval()
  loadLab()
  loadLabCors()
})
</script>

<template>
  <section class="dex">
    <h2>数据采集库</h2>
    <div class="desc">
      查看各站点的全部已采集数据（余额历史 / 每日用量 / 自定义采集）。数据存于本地 IndexedDB，默认保留
      <b>30 天</b>，过期自动清理；可手动重置。配置页空间充足，这里完整罗列。
    </div>

    <div class="dex-bar">
      <div class="dex-bar-left">
        <label class="dex-field">
          <span>站点</span>
          <select v-model="selectedSiteId" class="dex-select" @change="refresh">
            <option v-for="s in siteOptions" :key="s.id" :value="s.id">
              {{ s.label }}
            </option>
          </select>
        </label>

        <label class="dex-field">
          <span>保留时长</span>
          <select v-model.number="retentionDays" class="dex-select" @change="changeRetention">
            <option v-for="o in RETENTION_OPTIONS" :key="o.value" :value="o.value">
              {{ o.label }}
            </option>
          </select>
        </label>

        <label class="dex-field">
          <span>自动采集间隔</span>
          <select v-model="intervalSel" class="dex-select" @change="onIntervalSelChange">
            <option v-for="o in INTERVAL_OPTIONS" :key="String(o.value)" :value="o.value">
              {{ o.label }}
            </option>
          </select>
        </label>

        <template v-if="intervalSel === 'custom'">
          <label class="dex-field">
            <span>自定义（分钟，1–1440）</span>
            <input v-model.number="customValue" type="number" min="1" max="1440" class="dex-input" />
          </label>
          <button class="btn" @click="applyCustom">应用</button>
        </template>
      </div>

      <div class="dex-bar-right">
        <button class="btn" :disabled="loading" @click="refresh">↻ 刷新</button>
        <button class="btn" :disabled="!data" @click="exportJson">⇪ 导出 JSON</button>
        <button class="btn" :disabled="!data" @click="exportCsv">⇪ 导出 CSV</button>
        <button class="btn danger" :disabled="!selectedSite" @click="resetSite">🗑 清空该站</button>
        <button class="btn danger ghost" :disabled="!data" @click="resetAll">🗑 清空全部</button>
      </div>
    </div>

    <details class="lab">
      <summary>🧪 实验室功能（实验性 · 默认关闭）</summary>
      <div class="lab-body">
        <label class="lab-toggle">
          <input type="checkbox" v-model="labEnabled" @change="saveLab" />
          <span>SW 零标签后台采集（无需打开任何标签即可后台采集）</span>
        </label>
        <p class="lab-warn">
          <b>这是什么：</b>开启后，对<strong>没有打开标签页</strong>的站点，扩展会在 Service Worker 内直接读取该站点的登录
          Cookie 并手动注入请求头去抓取数据，从而<strong>真正后台静默采集、不弹任何窗口</strong>（比「临时后台窗口」更彻底）。
        </p>
        <p class="lab-warn"><b>优势：</b>彻底无可见标签 / 窗口，最贴近「登录一次、后台默默采」的体验。</p>
        <p class="lab-warn">
          <b>劣势与极不稳定性（请务必知悉）：</b>
          ① 这需要在扩展内读取你的站点登录 Cookie（<strong>仅本次请求内存使用，绝不写入本地数据库或导出</strong>）；
          ② 多数中转站 API <strong>不设 CORS</strong>，跨源请求会被浏览器直接拦截 → 大概率失败；
          ③ 会话常不止一个 Cookie，还绑 <strong>CSRF / SameSite / 内存态 Token</strong>（如 ikuncode 依赖 localStorage 的 Bearer，SW 读不到）→ 很可能只能采到部分字段或完全失败；
          ④ 因此<strong>可能十分不稳定</strong>，失败时在侧边栏显示错误、并可能在通知里提示。
        </p>
        <p class="lab-warn">
          若开启后某站采集失败，可<strong>关闭本选项</strong>（回退到临时后台窗口方案），或保持该站标签登录。本选项不影响已开启的「临时后台窗口」逻辑。
        </p>

        <hr class="lab-hr" />

        <label class="lab-toggle">
          <input type="checkbox" v-model="labCorsEnabled" @change="saveLabCors" />
          <span>动态 CORS 放行（实验性）</span>
        </label>
        <p class="lab-warn">
          <b>这是什么：</b>多数中转站 API 返回的响应没有
          <code>Access-Control-Allow-Origin</code>
          头，导致扩展在 Service Worker 内跨域 fetch 时读不到响应体（报错「Failed to fetch」或 CORS 错误）。开启后，扩展会通过
          <code>chrome.declarativeNetRequest</code>
          给已启用站点的响应<strong>动态添加</strong>
          <code>Access-Control-Allow-Origin: *</code>，作用和「CORS Unblock」插件类似。
        </p>
        <p class="lab-warn">
          <b>局限与提示：</b>① 该功能依赖 Chrome MV3 的声明式网络请求，部分版本/策略可能不生效；② 仍受
          <code>SameSite</code>、CSRF、内存态 Token（如 ikuncode 的 localStorage Bearer）限制；③
          <strong>如仍失败，可尝试安装浏览器插件「CORS Unblock」作为备选</strong>；④ 本功能仅影响扩展自身发起的请求，不会修改你正常浏览该站时的响应。
        </p>
      </div>
    </details>

    <div v-if="msg" class="dex-msg">{{ msg }}</div>

    <div v-if="loading" class="state-msg">加载中…</div>

    <template v-else-if="data">
      <!-- 摘要 -->
      <div class="dex-summary">
        <div class="stat">
          <div class="num">{{ data.summary.snapshotCount }}</div>
          <div class="lbl">余额快照</div>
        </div>
        <div class="stat">
          <div class="num">{{ data.summary.dailyCount }}</div>
          <div class="lbl">每日用量</div>
        </div>
        <div class="stat">
          <div class="num">{{ data.summary.captureCount }}</div>
          <div class="lbl">自定义采集</div>
        </div>
        <div class="stat">
          <div class="num">{{ data.summary.earliestTs ? fmtDateTime(data.summary.earliestTs) : '—' }}</div>
          <div class="lbl">最早采集</div>
        </div>
        <div class="stat">
          <div class="num">{{ data.summary.latestTs ? fmtDateTime(data.summary.latestTs) : '—' }}</div>
          <div class="lbl">最近采集</div>
        </div>
        <div class="stat">
          <div class="num">{{ fmtBytes(data.summary.estBytes) }}</div>
          <div class="lbl">占用估算</div>
        </div>
      </div>

      <!-- 余额历史 -->
      <div class="dex-block">
        <div class="dex-title">余额历史（{{ data.snapshots.length }}）</div>
        <table v-if="data.snapshots.length" class="dex-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>余额</th>
              <th>当日用量</th>
              <th>当日请求</th>
              <th>累计请求</th>
              <th>币种</th>
              <th>渠道</th>
              <th>质量</th>
              <th>状态</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <template v-for="s in snapshotsView" :key="'s' + s.takenAt">
              <tr @click="toggleExpand('s' + s.takenAt)">
                <td>{{ fmtDateTime(s.takenAt) }}</td>
                <td>{{ fmtBalance(s.balance, s.currency) }}</td>
                <td>{{ fmtTokens(s.todayTokens) }}</td>
                <td>{{ fmtNum(s.todayRequests) }}</td>
                <td>{{ fmtNum(s.totalRequests) }}</td>
                <td>{{ s.currency ?? '—' }}</td>
                <td>{{ s.channel }}</td>
                <td>{{ s.quality }}</td>
                <td>{{ s.status }}</td>
                <td class="exp">{{ expanded.has('s' + s.takenAt) ? '▾' : '▸' }}</td>
              </tr>
              <tr v-if="expanded.has('s' + s.takenAt)">
                <td colspan="10" class="json-cell">
                  <pre>{{ JSON.stringify(s, null, 2) }}</pre>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
        <div v-else class="dex-empty">暂无余额快照。先去「站点管理」对该站「立即同步」或手动刷新。</div>
        <div v-if="snapshotsTotal" class="dex-pager">
          <div class="pg-info">共 {{ snapshotsTotal }} 条 · 第 {{ pageSnapshots }} / {{ snapshotsTotalPages }} 页</div>
          <div class="pg-ctrl">
            <button class="pg-btn" :disabled="pageSnapshots <= 1" @click="pageSnapshots--">‹ 上一页</button>
            <button
              v-for="p in pageBtns(snapshotsTotalPages, pageSnapshots)"
              :key="'sp' + p"
              class="pg-btn"
              :class="{ active: p === pageSnapshots }"
              :disabled="p === -1"
              @click="p !== -1 && (pageSnapshots = p)"
            >
              {{ p === -1 ? '…' : p }}
            </button>
            <button class="pg-btn" :disabled="pageSnapshots >= snapshotsTotalPages" @click="pageSnapshots++">下一页 ›</button>
          </div>
          <label class="pg-size">
            每页
            <select v-model.number="pageSize" class="dex-select pg-select" @change="onPageSizeChange">
              <option v-for="o in PAGE_SIZE_OPTIONS" :key="o" :value="o">{{ o }}</option>
            </select>
            条
          </label>
        </div>
      </div>

      <!-- 每日用量 -->
      <div class="dex-block">
        <div class="dex-title">每日用量（{{ data.dailyStats.length }}）</div>
        <table v-if="data.dailyStats.length" class="dex-table">
          <thead>
            <tr>
              <th>日期</th>
              <th>Tokens</th>
              <th>请求数</th>
              <th>花费</th>
              <th>币种</th>
              <th>模型分解</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <template v-for="(d, i) in dailyView" :key="'d' + d.id">
              <tr @click="toggleExpand('d' + d.id)">
                <td>{{ d.date }}</td>
                <td>{{ fmtTokens(d.tokens) }}</td>
                <td>{{ fmtNum(d.requests) }}</td>
                <td>{{ fmtBalance(d.cost, d.currency) }}</td>
                <td>{{ d.currency ?? '—' }}</td>
                <td>{{ Object.keys(d.byModel).length }} 个</td>
                <td class="exp">{{ expanded.has('d' + d.id) ? '▾' : '▸' }}</td>
              </tr>
              <tr v-if="expanded.has('d' + d.id)">
                <td colspan="7" class="json-cell">
                  <pre>{{ JSON.stringify(d.byModel, null, 2) }}</pre>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
        <div v-else class="dex-empty">暂无每日用量（仅来自站点精确用量日志，无接口则不落表）。</div>
        <div v-if="dailyTotal" class="dex-pager">
          <div class="pg-info">共 {{ dailyTotal }} 条 · 第 {{ pageDaily }} / {{ dailyTotalPages }} 页</div>
          <div class="pg-ctrl">
            <button class="pg-btn" :disabled="pageDaily <= 1" @click="pageDaily--">‹ 上一页</button>
            <button
              v-for="p in pageBtns(dailyTotalPages, pageDaily)"
              :key="'dp' + p"
              class="pg-btn"
              :class="{ active: p === pageDaily }"
              :disabled="p === -1"
              @click="p !== -1 && (pageDaily = p)"
            >
              {{ p === -1 ? '…' : p }}
            </button>
            <button class="pg-btn" :disabled="pageDaily >= dailyTotalPages" @click="pageDaily++">下一页 ›</button>
          </div>
          <label class="pg-size">
            每页
            <select v-model.number="pageSize" class="dex-select pg-select" @change="onPageSizeChange">
              <option v-for="o in PAGE_SIZE_OPTIONS" :key="o" :value="o">{{ o }}</option>
            </select>
            条
          </label>
        </div>
      </div>

      <!-- 自定义采集 -->
      <div class="dex-block">
        <div class="dex-title">自定义采集（{{ data.captures.length }}）</div>
        <table v-if="data.captures.length" class="dex-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>URL</th>
              <th>状态</th>
              <th>类型</th>
              <th>成功</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <template v-for="(c, i) in capturesView" :key="'c' + c.id">
              <tr @click="toggleExpand('c' + c.id)">
                <td>{{ fmtDateTime(c.capturedAt) }}</td>
                <td class="url">{{ c.url }}</td>
                <td>{{ c.status ?? '—' }}</td>
                <td>{{ (c.contentType || '').split(';')[0] || '—' }}</td>
                <td>{{ c.ok ? '✓' : '✗' }}</td>
                <td class="exp">{{ expanded.has('c' + c.id) ? '▾' : '▸' }}</td>
              </tr>
              <tr v-if="expanded.has('c' + c.id)">
                <td colspan="6" class="json-cell">
                  <pre>{{ c.error ? '错误：' + c.error : JSON.stringify(c.json, null, 2) }}</pre>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
        <div v-else class="dex-empty">暂无自定义采集。在「站点管理」展开站点的「自定义采集」粘贴接口并采集。</div>
        <div v-if="capturesTotal" class="dex-pager">
          <div class="pg-info">共 {{ capturesTotal }} 条 · 第 {{ pageCaptures }} / {{ capturesTotalPages }} 页</div>
          <div class="pg-ctrl">
            <button class="pg-btn" :disabled="pageCaptures <= 1" @click="pageCaptures--">‹ 上一页</button>
            <button
              v-for="p in pageBtns(capturesTotalPages, pageCaptures)"
              :key="'cp' + p"
              class="pg-btn"
              :class="{ active: p === pageCaptures }"
              :disabled="p === -1"
              @click="p !== -1 && (pageCaptures = p)"
            >
              {{ p === -1 ? '…' : p }}
            </button>
            <button class="pg-btn" :disabled="pageCaptures >= capturesTotalPages" @click="pageCaptures++">下一页 ›</button>
          </div>
          <label class="pg-size">
            每页
            <select v-model.number="pageSize" class="dex-select pg-select" @change="onPageSizeChange">
              <option v-for="o in PAGE_SIZE_OPTIONS" :key="o" :value="o">{{ o }}</option>
            </select>
            条
          </label>
        </div>
      </div>
    </template>

    <div v-else class="state-msg">选择站点并点击「刷新」查看已采集数据</div>
  </section>
</template>

<style>
/* 数据采集库（配置页查看器）。按钮复用全局 .btn/.mini，新样式以 dex- 前缀避免冲突 */
.dex {
  margin-top: 34px;
  border-top: 1px solid var(--line);
  padding-top: 22px;
}
.dex h2 {
  font-size: 17px;
  margin-bottom: 4px;
}
.dex .desc {
  font-size: 12px;
  color: var(--sub);
  margin-bottom: 16px;
  line-height: 1.6;
}
.dex-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  align-items: flex-end;
  justify-content: space-between;
  margin-bottom: 18px;
}
.dex-bar-left,
.dex-bar-right {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px;
  row-gap: 10px;
}
.dex-bar-right {
  justify-content: flex-end;
}
.dex-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 11px;
  color: var(--sub);
}
.dex-select {
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 7px 12px;
  font-size: 12px;
  background: var(--panel);
  color: var(--text);
  min-width: 200px;
}
.dex-select:focus {
  outline: none;
  border-color: var(--brand);
}
.dex-input {
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 7px 10px;
  font-size: 12px;
  background: var(--panel);
  color: var(--text);
  width: 130px;
}
.dex-input:focus {
  outline: none;
  border-color: var(--brand);
}
.dex-msg {
  background: var(--panel-soft);
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--text);
  margin-bottom: 14px;
}
.btn.danger {
  color: var(--err);
  border-color: var(--line);
  background: transparent;
}
.btn.danger:hover {
  background: var(--err-soft);
}
.btn.danger.ghost {
  color: var(--sub);
  border-color: var(--line);
  background: transparent;
}
.btn.danger.ghost:hover {
  background: var(--panel-soft);
}

.dex-summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 12px;
  margin-bottom: 22px;
}
.dex-summary .stat {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 12px 14px;
  transition: background 0.15s;
  min-width: 0;
}
.dex-summary .stat:hover {
  background: var(--panel-soft);
}
.dex-summary .num {
  font-size: 16px;
  font-weight: 700;
  color: var(--text);
  line-height: 1.35;
  word-break: break-word;
}
.dex-summary .lbl {
  font-size: 11px;
  color: var(--sub);
  margin-top: 6px;
}

.dex-block {
  margin-bottom: 22px;
}
.dex-title {
  font-size: 13px;
  font-weight: 700;
  margin-bottom: 8px;
  color: var(--text);
}
.dex-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  overflow: hidden;
}
.dex-table th,
.dex-table td {
  text-align: left;
  padding: 8px 10px;
  border-bottom: 1px solid var(--line);
  color: var(--text);
  white-space: nowrap;
}
.dex-table thead th {
  background: var(--panel-soft);
  color: var(--sub);
  font-weight: 600;
  font-size: 11px;
}
.dex-table tbody tr:hover {
  background: var(--panel-hover);
}
.dex-table tr[class] {
  cursor: pointer;
}
.dex-table .exp {
  text-align: right;
  color: var(--sub);
}
.dex-table .url {
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 11px;
}
.json-cell {
  background: var(--bg);
}
.json-cell pre {
  margin: 0;
  padding: 12px;
  font-size: 11px;
  line-height: 1.55;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 320px;
  overflow: auto;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
}
.dex-empty {
  font-size: 12px;
  color: var(--sub);
  padding: 14px 0;
  line-height: 1.6;
}

/* ── 分页条 ── */
.dex-pager {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px dashed var(--line);
}
.pg-info {
  font-size: 12px;
  color: var(--sub);
}
.pg-ctrl {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.pg-btn {
  min-width: 30px;
  padding: 5px 9px;
  font-size: 12px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--panel);
  color: var(--text);
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.pg-btn:hover:not(:disabled) {
  background: var(--panel-soft);
}
.pg-btn.active {
  background: var(--brand);
  border-color: var(--brand);
  color: #fff;
  font-weight: 700;
}
.pg-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.pg-size {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--sub);
}
.pg-select {
  min-width: 72px;
  padding: 5px 8px;
}

/* ── 实验室功能（实验性）── */
.lab {
  margin-top: 22px;
  margin-bottom: 22px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel-soft);
  overflow: hidden;
}
.lab > summary {
  cursor: pointer;
  padding: 10px 14px;
  font-weight: 600;
  font-size: 13px;
  color: var(--text);
  user-select: none;
  list-style: none;
}
.lab > summary::-webkit-details-marker {
  display: none;
}
.lab > summary::before {
  content: '▸ ';
  color: var(--brand);
}
.lab[open] > summary::before {
  content: '▾ ';
}
.lab-body {
  padding: 4px 14px 14px;
  border-top: 1px solid var(--line);
}
.lab-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text);
  margin: 10px 0;
  cursor: pointer;
}
.lab-toggle input {
  width: 16px;
  height: 16px;
  accent-color: var(--brand);
}
.lab-warn {
  font-size: 12px;
  line-height: 1.7;
  color: var(--sub);
  margin: 8px 0;
}
.lab-warn b {
  color: var(--text);
}
.lab-warn strong {
  color: var(--brand);
}
.lab-warn code {
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 11px;
  background: var(--bg);
  padding: 1px 4px;
  border-radius: 4px;
  color: var(--text);
}
.lab-hr {
  border: none;
  border-top: 1px solid var(--line);
  margin: 14px 0;
}
</style>
