<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { send, MessagingError } from '../core/messaging/client'
import type { GetDashboardSummaryResponse, DashboardSummaryItem } from '../core/messaging/protocol'
import { fmtBalance } from '../shared/format'
import { isValidSiteUrl } from '../shared/util'

const items = ref<DashboardSummaryItem[]>([])
const loading = ref(true)
const error = ref('')

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
  } catch (e) {
    error.value = e instanceof MessagingError ? e.message : '加载失败'
  } finally {
    loading.value = false
  }
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
})
</script>

<template>
  <div class="pop">
    <header class="pop-head">
      <span class="pop-title">极简面板</span>
      <button class="pop-refresh" title="刷新" @click="load">↻</button>
    </header>

    <div v-if="loading" class="pop-state">加载中…</div>
    <div v-else-if="error" class="pop-state pop-err">{{ error }}</div>
    <div v-else-if="items.length === 0" class="pop-state">还没有站点，先去设置页添加</div>

    <ul v-else class="pop-list">
      <li v-for="it in items" :key="it.siteId" class="pop-row">
        <div class="pop-name">
          <span class="dot" :class="'st-' + it.status"></span>
          <a class="pop-link" :href="safeHref(it)" target="_blank" rel="noopener noreferrer" :title="`打开 ${it.name}`">{{ it.name }}</a>
        </div>
        <div class="pop-bal" :class="balClass(it)">
          {{ it.balance == null ? '—' : fmtBalance(it.balance, it.currency) }}
        </div>
        <div v-if="it.updatedAt" class="pop-sub">{{ relTime(it.updatedAt) }}</div>
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
  margin-bottom: 8px;
}
.pop-title {
  font-weight: 600;
  font-size: 13px;
}
.pop-refresh {
  border: none;
  background: transparent;
  color: var(--sub);
  font-size: 15px;
  cursor: pointer;
  line-height: 1;
  padding: 2px 4px;
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
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-areas: 'name bal' 'sub bal';
  column-gap: 8px;
  padding: 7px 0;
  border-top: 1px solid var(--line);
}
.pop-row:first-child {
  border-top: none;
}
.pop-name {
  grid-area: name;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
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
  grid-area: bal;
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  text-align: right;
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
  grid-area: sub;
  font-size: 11px;
  color: var(--sub);
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
