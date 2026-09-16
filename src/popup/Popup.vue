<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { send, MessagingError } from '../core/messaging/client'
import type {
  GetDashboardSummaryResponse,
  DashboardSummaryItem,
  DashboardSettings,
  SetCostWindowResponse,
  SetBalanceRmbModeResponse,
} from '../core/messaging/protocol'
import { isValidSiteUrl } from '../shared/util'
import { fmtTodayCost, fmtBalanceRmb } from '../shared/recharge'
import { AIHUB_SETTINGS_CHANGED } from '../shared/dashboardSettings'
import {
  normalizeCostWindow,
  costWindowShortLabel,
  pickCost,
  sumCostTotal,
  fmtCostTotal,
  fmtAsOf,
  type CostWindow,
} from '../shared/costWindow'

const items = ref<DashboardSummaryItem[]>([])
const settings = ref<DashboardSettings>({
  calcRealCost: false,
  showTodayCostInPopup: false,
  costWindow: 'today',
  balanceRmbMode: false,
})
const loading = ref(true)
const error = ref('')
/** 轻提示（如设置写入失败）：不弹窗、不打断操作，顶部一行小字（方案 035 R4）。 */
const notice = ref('')

// 花费统计周期（今日 / 24 小时）+ 真实总花费（跨币种不直接相加，先换算人民币再求和）
const costWindow = computed<CostWindow>(() => normalizeCostWindow(settings.value.costWindow))
const calcRealCost = computed(() => settings.value.calcRealCost === true)
const costTotal = computed(() => sumCostTotal(items.value, costWindow.value, calcRealCost.value))
const costText = computed(() => fmtCostTotal(costTotal.value, calcRealCost.value, costWindow.value))

/** 切换花费统计周期：本地立即生效（两个周期字段已随摘要下发），再持久化 + 广播给侧边栏。
 *  写入失败**不静默回退**（方案 035 R4）：保留用户本次选择并给出提示，避免出现「点了没反应」。 */
async function toggleCostWindow() {
  const next: CostWindow = costWindow.value === 'h24' ? 'today' : 'h24'
  settings.value = { ...settings.value, costWindow: next }
  notice.value = ''
  try {
    await send<SetCostWindowResponse>('SET_COST_WINDOW', { window: next })
  } catch {
    notice.value = '周期切换未保存，请重试'
  }
}

// ── 余额显示真实人民币（全局开关，方案 036）────────────────
const balanceRmbMode = computed(() => settings.value.balanceRmbMode === true)

/** 最新快照时间（用于「数据截至」提示，明确切换周期不会重新采集）。 */
const latestUpdatedAt = computed<number | null>(() => {
  let max: number | null = null
  for (const it of items.value) {
    if (it.updatedAt && (max == null || it.updatedAt > max)) max = it.updatedAt
  }
  return max
})
const costTitleWithAsOf = computed(() => `${costText.value.title}${fmtAsOf(latestUpdatedAt.value)}`)

/** 站点余额文本：人民币模式下按充值比例换算，比例无效则显示原币种。 */
function balText(it: DashboardSummaryItem): string {
  return fmtBalanceRmb(it.balance ?? null, it.currency, it.rechargeRate ?? null, balanceRmbMode.value).text
}
function balTitle(it: DashboardSummaryItem): string {
  return fmtBalanceRmb(it.balance ?? null, it.currency, it.rechargeRate ?? null, balanceRmbMode.value).title
}
function balIsRmb(it: DashboardSummaryItem): boolean {
  return fmtBalanceRmb(it.balance ?? null, it.currency, it.rechargeRate ?? null, balanceRmbMode.value).isRmb
}

/** 点击任一站点余额 → 全局切换（所有站点一起变），持久化 + 广播。 */
async function toggleBalanceRmbMode() {
  const next = !balanceRmbMode.value
  settings.value = { ...settings.value, balanceRmbMode: next }
  notice.value = ''
  try {
    await send<SetBalanceRmbModeResponse>('SET_BALANCE_RMB_MODE', { enabled: next })
  } catch {
    notice.value = '余额显示切换未保存，请重试'
  }
}

/** 站点行花费：按当前周期取 todayCost / recent24hCost，无数据显示「—」。 */
function rowCost(it: DashboardSummaryItem): string {
  return fmtTodayCost(pickCost(it, costWindow.value), it.currency, it.rechargeRate ?? null, calcRealCost.value)
}

/** 站点行花费 title：无 24h 数据时说明原因与处置（方案 035 R2/R4）。 */
function rowCostTitle(it: DashboardSummaryItem): string {
  const base = costWindowShortLabel(costWindow.value) + '花费'
  if (costWindow.value === 'h24' && it.recent24hCost == null) {
    return base + '｜该站点暂无 24 小时口径数据：请在设置页执行「探测」后重新同步'
  }
  return base
}

function balClass(it: DashboardSummaryItem): string {
  if (it.balance == null) return 'is-null'
  if (it.balance <= 1) return 'bal-critical'
  return it.balance >= 5 ? 'bal-high' : 'bal-low'
}

function relTime(ts: number | null): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  return `${d} 天前`
}

function safeHref(it: DashboardSummaryItem): string | undefined {
  // P0 修复（评审驳回项）：href sink 最终协议校验，杜绝脏数据/绕过进入 <a :href>
  if (isValidSiteUrl(it.baseUrl)) return it.baseUrl
  if (isValidSiteUrl(it.origin)) return it.origin
  return undefined
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const res = await send<GetDashboardSummaryResponse>('GET_DASHBOARD_SUMMARY', {})
    items.value = res.items
    settings.value = res.settings
  } catch (e) {
    error.value = e instanceof MessagingError ? e.message : '加载失败'
  } finally {
    loading.value = false
  }
}

function onRuntimeMessage(msg: { type?: string }) {
  // 设置页切换「计算真实花费 / 极简面板显示今日花费」后，实时刷新极简面板
  if (msg?.type === AIHUB_SETTINGS_CHANGED) void load()
}

async function openFull() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab?.id != null) {
      await chrome.sidePanel.open({ tabId: tab.id })
      // 关掉浮动看板，露出侧边栏
      window.close()
      return
    }
  } catch {
    /* 忽略，回退到选项页 */
  }
  chrome.runtime.openOptionsPage()
}

onMounted(() => {
  load()
  chrome.runtime.onMessage.addListener(onRuntimeMessage)
})

onUnmounted(() => {
  chrome.runtime.onMessage.removeListener(onRuntimeMessage)
})
</script>

<template>
  <div class="pop">
    <header class="pop-head">
      <span class="pop-title">极简面板</span>
      <button class="pop-total" :title="costTitleWithAsOf" @click="toggleCostWindow">
        <span class="pt-label">真实总花费</span>
        <span class="pt-val">{{ costText.text }}</span>
        <span class="pt-win">{{ costWindowShortLabel(costWindow) }}</span>
      </button>
      <button class="pop-refresh" title="刷新" @click="load">↻</button>
    </header>

    <div v-if="notice" class="pop-notice">{{ notice }}</div>

    <div v-if="loading" class="pop-state">加载中…</div>
    <div v-else-if="error" class="pop-state pop-err">{{ error }}</div>
    <div v-else-if="items.length === 0" class="pop-state">还没有站点，先去设置页添加</div>

    <ul v-else class="pop-list">
      <li v-for="it in items" :key="it.siteId" class="pop-row">
        <!-- 第一行：左侧状态圆点 + 站点名称，右侧余额 -->
        <div class="pop-row-main">
          <div class="pop-name">
            <span class="dot" :class="'st-' + it.status"></span>
            <a class="pop-link" :href="safeHref(it)" target="_blank" rel="noopener noreferrer" :title="`打开 ${it.name}`">{{ it.name }}</a>
          </div>
          <div
            class="pop-bal"
            :class="[balClass(it), { 'is-rmb': balIsRmb(it) }]"
            :title="balTitle(it)"
            @click="toggleBalanceRmbMode"
          >{{ balText(it) }}</div>
        </div>
        <!-- 第二行：左侧更新时间，右侧今日花费（设置开启才显示） -->
        <div v-if="it.updatedAt || settings.showTodayCostInPopup" class="pop-row-sub">
          <div class="pop-sub">{{ relTime(it.updatedAt) }}</div>
          <div v-if="settings.showTodayCostInPopup" class="pop-today" :title="rowCostTitle(it)">
            {{ rowCost(it) }}
          </div>
        </div>
      </li>
    </ul>

    <footer class="pop-foot">
      <button class="pop-full" @click="openFull">打开完整看板</button>
    </footer>
  </div>
</template>

<style scoped>
.pop {
  width: 260px;
  min-width: 260px;
  min-height: 120px;
  padding: 10px 12px 8px;
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif;
  color: var(--text);
  background: color-mix(in srgb, var(--panel) 92%, transparent);
  border-radius: var(--radius);
  box-sizing: border-box;
}
.pop-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin-bottom: 8px;
}
.pop-title {
  font-weight: 600;
  font-size: 13px;
  flex: 0 0 auto;
}
/* 顶栏中部「真实总花费」：点击切换 今日 / 24 小时 */
.pop-total {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 2px 6px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--panel-soft);
  color: inherit;
  font-family: inherit;
  cursor: pointer;
  overflow: hidden;
}
.pop-total:hover {
  border-color: var(--brand);
  color: var(--brand);
}
.pt-label {
  font-size: 10px;
  color: var(--sub);
  white-space: nowrap;
}
.pt-val {
  font-size: 11px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.pt-win {
  font-size: 9px;
  color: var(--sub);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 0 3px;
  white-space: nowrap;
  flex: 0 0 auto;
}
.pop-refresh {
  border: none;
  background: transparent;
  color: var(--sub);
  font-size: 15px;
  cursor: pointer;
  line-height: 1;
  padding: 2px 4px;
  flex: 0 0 auto;
}
.pop-refresh:hover {
  color: var(--brand);
}
.pop-state {
  font-size: 12px;
  color: var(--sub);
  padding: 14px 4px;
  text-align: center;
}
.pop-err {
  color: #e5484d;
}
.pop-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.pop-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 7px 0;
  border-top: 1px solid var(--line);
}
.pop-row:first-child {
  border-top: none;
}
/* 第一行 / 第二行：左右两端对齐（站点名+余额；更新时间+今日花费） */
.pop-row-main,
.pop-row-sub {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}
.pop-row-sub {
  font-size: 11px;
  color: var(--sub);
}
.pop-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pop-link {
  color: inherit;
  text-decoration: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  cursor: pointer;
}
.pop-link:hover {
  color: var(--brand);
  text-decoration: underline;
}
.pop-bal {
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  text-align: right;
  flex-shrink: 0;
  /* 可点击：切换「站点货币 ⇄ 真实人民币」（全局，方案 036） */
  cursor: pointer;
  user-select: none;
  border-radius: 5px;
  padding: 0 3px;
}
.pop-bal.bal-high {
  color: var(--ok);
}
.pop-bal.bal-low {
  color: var(--warn);
}
.pop-bal.bal-critical {
  color: var(--err);
}
.pop-bal.is-null {
  color: var(--sub);
  font-weight: 400;
}
.pop-bal:hover {
  outline: 1px solid var(--brand);
}
.pop-bal.is-rmb {
  background: var(--panel-soft);
  outline: 1px dashed var(--line);
}
.pop-notice {
  font-size: 10px;
  color: var(--warn);
  margin-bottom: 6px;
}
.pop-sub {
  font-size: 11px;
  color: var(--sub);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.pop-today {
  font-size: 11px;
  color: var(--text);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
  white-space: nowrap;
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: 0 0 auto;
  background: var(--sub);
}
.dot.st-ok {
  background: #2ea043;
}
.dot.st-auth_expired,
.dot.st-error {
  background: #e5484d;
}
.pop-foot {
  margin-top: 8px;
  border-top: 1px solid var(--line);
  padding-top: 8px;
}
.pop-full {
  width: 100%;
  border: 1px solid var(--line);
  background: var(--panel-soft);
  color: var(--text);
  font-size: 12px;
  padding: 6px;
  border-radius: 7px;
  cursor: pointer;
}
.pop-full:hover {
  border-color: var(--brand);
  color: var(--brand);
}
</style>
