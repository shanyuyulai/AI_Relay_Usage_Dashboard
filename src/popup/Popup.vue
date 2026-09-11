<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { send, MessagingError } from '../core/messaging/client'
import type {
  GetDashboardSummaryResponse,
  DashboardSummaryItem,
  DashboardSettings,
  SetCostWindowResponse,
} from '../core/messaging/protocol'
import { fmtBalance } from '../shared/format'
import { isValidSiteUrl } from '../shared/util'
import { fmtTodayCost } from '../shared/recharge'
import { AIHUB_SETTINGS_CHANGED } from '../shared/dashboardSettings'
import {
  normalizeCostWindow,
  costWindowShortLabel,
  pickCost,
  sumCostTotal,
  fmtCostTotal,
  type CostWindow,
} from '../shared/costWindow'

const items = ref<DashboardSummaryItem[]>([])
const settings = ref<DashboardSettings>({
  calcRealCost: false,
  showTodayCostInPopup: false,
  costWindow: 'today',
})
const loading = ref(true)
const error = ref('')

// 花费统计周期（今日 / 24 小时）+ 真实总花费（跨币种不直接相加，先换算人民币再求和）
const costWindow = computed<CostWindow>(() => normalizeCostWindow(settings.value.costWindow))
const calcRealCost = computed(() => settings.value.calcRealCost === true)
const costTotal = computed(() => sumCostTotal(items.value, costWindow.value, calcRealCost.value))
const costText = computed(() => fmtCostTotal(costTotal.value, calcRealCost.value, costWindow.value))

/** 切换花费统计周期：本地乐观更新（两个周期字段已随摘要下发），并持久化 + 广播给侧边栏。 */
async function toggleCostWindow() {
  const next: CostWindow = costWindow.value === 'h24' ? 'today' : 'h24'
  settings.value = { ...settings.value, costWindow: next }
  try {
    await send<SetCostWindowResponse>('SET_COST_WINDOW', { window: next })
  } catch {
    void load() // 写入失败：回退为服务端实际值
  }
}

/** 站点行花费：按当前周期取 todayCost / recent24hCost，无数据显示「—」。 */
function rowCost(it: DashboardSummaryItem): string {
  return fmtTodayCost(pickCost(it, costWindow.value), it.currency, it.rechargeRate ?? null, calcRealCost.value)
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
      <button class="pop-total" :title="costText.title" @click="toggleCostWindow">
        <span class="pt-label">真实总花费</span>
        <span class="pt-val">{{ costText.text }}</span>
        <span class="pt-win">{{ costWindowShortLabel(costWindow) }}</span>
      </button>
      <button class="pop-refresh" title="刷新" @click="load">↻</button>
    </header>

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
          <div class="pop-bal" :class="balClass(it)">
            {{ it.balance == null ? '—' : fmtBalance(it.balance, it.currency) }}
          </div>
        </div>
        <!-- 第二行：左侧更新时间，右侧今日花费（设置开启才显示） -->
        <div v-if="it.updatedAt || settings.showTodayCostInPopup" class="pop-row-sub">
          <div class="pop-sub">{{ relTime(it.updatedAt) }}</div>
          <div v-if="settings.showTodayCostInPopup" class="pop-today" :title="`${costWindowShortLabel(costWindow)}花费`">
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
