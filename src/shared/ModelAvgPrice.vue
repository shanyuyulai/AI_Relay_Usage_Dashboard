<script setup lang="ts">
/**
 * 模型均价展示组件（方案 048）：极简面板 / 侧边栏共用。
 * - 默认仅显示「用量最大模型」的 ¥/百万 tokens 均价数字（无数据显「—」，绝不编造，P0-3）。
 * - hover（200ms 延迟）自绘浮窗：顶部小字显示本次计算的来源数据时间范围（可配置项③），
 *   其下按用量倒序列出全部模型（模型 / 用量 / ¥每M），最多 20 行。
 *   方案 049：极简面板传 disableHover 禁用浮窗（popup 窗口会裁剪 absolute 浮窗），
 *   详情查看统一走双击独立窗口（detail 事件 → avgdetail 页面，049r1）。
 * - 浮窗数据经 GET_SITE_MODEL_PRICES 懒加载，组件内缓存；主题跟随 CSS 变量。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { send, MessagingError } from '../core/messaging/client'
import type { ModelAvgSummary, GetSiteModelPricesResponse } from '../core/messaging/protocol'
import { fmtAvgText, fmtTokens, fmtRowPrice, fmtRange, fmtRangeShort } from './modelAvgFormat'
import { openAvgDetailWindow } from './avgDetailWindow'

const props = defineProps<{
  siteId: string
  summary?: ModelAvgSummary | null
  /** 浮窗对齐方向：right = 浮窗右缘对齐触发点（默认，防右侧溢出）；left = 左缘对齐。 */
  align?: 'left' | 'right'
  /** 方案 049：禁用自绘 hover 浮窗（popup 窗口会裁剪 absolute 浮窗），详情走双击弹窗。 */
  disableHover?: boolean
}>()

const emit = defineEmits<{ (e: 'detail'): void }>()

const hover = ref(false)
const loading = ref(false)
const data = ref<GetSiteModelPricesResponse | null>(null)
const err = ref('')
let enterTimer: number | null = null

/** 均价文本：partial 批次加「≈」前缀；无数据显示「—」（P0-3）。 */
const text = computed(() => fmtAvgText(props.summary))
const isNull = computed(() => text.value === '—')

/** 数字 title：按模式提示查看方式（049r1：popup 禁浮窗后引导双击独立窗口）。 */
const numTitle = computed(() =>
  props.disableHover
    ? '当日用量最大模型的价格（双击打开模型价格详情窗口）'
    : '当日用量最大模型的价格（悬停查看全部模型，双击打开模型价格详情窗口）',
)

/** 浮窗顶部时间范围小字（可配置项③）。 */
const rangeText = computed(() => {
  const d = data.value
  if (!d) return ''
  return fmtRange(d.rangeStart, d.rangeEnd, d.usedCount)
})

async function load(): Promise<void> {
  if (loading.value) return
  loading.value = true
  err.value = ''
  try {
    data.value = await send<GetSiteModelPricesResponse>('GET_SITE_MODEL_PRICES', { siteId: props.siteId })
  } catch (e) {
    err.value = e instanceof MessagingError ? e.message : '加载失败'
  } finally {
    loading.value = false
  }
}

function enter(): void {
  if (props.disableHover) return // 方案 049：popup 禁用浮窗
  if (enterTimer != null) return
  enterTimer = window.setTimeout(async () => {
    enterTimer = null
    hover.value = true
    if (!data.value) await load()
  }, 200)
}

function leave(): void {
  if (enterTimer != null) {
    window.clearTimeout(enterTimer)
    enterTimer = null
  }
  hover.value = false
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') leave()
}

watch(
  () => props.siteId,
  () => {
    // 站点切换（理论上两处调用都不会发生，防御性重置）
    data.value = null
    hover.value = false
  },
)

window.addEventListener('keydown', onKeydown)
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  if (enterTimer != null) window.clearTimeout(enterTimer)
})
</script>

<template>
  <span class="map-wrap" @mouseenter="enter" @mouseleave="leave">
    <span class="map-num" :class="{ 'is-null': isNull }" :title="numTitle" @dblclick="emit('detail')">{{ text }}</span>
    <span v-if="hover" class="map-pop" :class="align === 'left' ? 'al-left' : 'al-right'">
      <span class="map-loading" v-if="loading && !data">计算中…</span>
      <template v-else>
        <div v-if="rangeText" class="map-range">{{ rangeText }}</div>
        <div v-if="data?.missingRate" class="map-note">未填充值比例，无法换算人民币（去设置页填写充值比例）</div>
        <div v-else-if="data && !data.hasDetail" class="map-note">该站点无逐条用量明细，暂不支持模型价格</div>
        <div v-if="data?.partial" class="map-note">当日明细超上限，按已采集部分计算</div>
        <table v-if="data?.rows?.length" class="map-table">
          <thead>
            <tr><th class="h-model">模型</th><th class="h-num">用量</th><th class="h-num">¥/M</th><th class="h-range">数据范围</th></tr>
          </thead>
          <tbody>
            <tr
              v-for="r in data.rows.slice(0, 20)"
              :key="r.model"
              class="map-row"
              title="点击打开模型价格详情窗口（可查看该模型价格数据来源）"
              @click="openAvgDetailWindow(props.siteId)"
            >
              <td class="c-model">
                {{ r.model }}
                <i v-if="r.listPriceBased" class="lp" title="该模型部分记录缺实扣价，按标价口径计算">标</i>
                <i v-if="r.fromHistory" class="lp his" title="价格来自历史档案（当前批次无该模型新数据）">档</i>
              </td>
              <td class="c-num">{{ fmtTokens(r.tokens) }}</td>
              <td class="c-num">{{ fmtRowPrice(r.pricePerM) }}</td>
              <td class="c-range" :title="fmtRange(r.rangeStart ?? null, r.rangeEnd ?? null, r.usedCount ?? 0) || '—'">
                {{ fmtRangeShort(r.rangeStart, r.rangeEnd) || '—' }}
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else-if="data && !err" class="map-note">暂无可计算的数据</div>
        <div v-if="err" class="map-note">{{ err }}</div>
      </template>
    </span>
  </span>
</template>

<style scoped>
.map-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  line-height: 1;
}
.map-num {
  font-variant-numeric: tabular-nums;
  cursor: pointer; /* 049r2：可点击（双击打开均价详情窗口），hover 显手型 */
  white-space: nowrap;
}
.map-num.is-null {
  opacity: 0.45;
}
.map-pop {
  position: absolute;
  bottom: calc(100% + 6px);
  z-index: 9999;
  min-width: 260px;
  max-width: 400px;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.5;
  text-align: left;
  color: var(--text, #1f2328);
  background: var(--panel, #fff);
  border: 1px solid var(--line, rgba(0, 0, 0, 0.14));
  border-radius: 8px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.16);
}
.al-right {
  right: 0;
}
.al-left {
  left: 0;
}
.map-range {
  margin-bottom: 4px;
  font-size: 10.5px;
  color: var(--sub, #6b7280);
  white-space: nowrap;
}
.map-note {
  margin-bottom: 4px;
  font-size: 11px;
  color: var(--sub, #6b7280);
}
.map-loading {
  color: var(--sub, #6b7280);
  font-size: 11px;
}
.map-table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 2px;
}
.map-table th {
  font-weight: 600;
  color: var(--sub, #6b7280);
  border-bottom: 1px solid var(--line, rgba(0, 0, 0, 0.1));
  padding: 2px 6px 3px 0;
  text-align: left;
}
.map-table td {
  padding: 2px 6px 2px 0;
  vertical-align: top;
  white-space: nowrap;
}
.h-num,
.c-num {
  text-align: left; /* 050r1：非定长列一律左对齐 */
  font-variant-numeric: tabular-nums;
}
.c-model {
  max-width: 130px;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 数据范围列（050）：小字缩写，tooltip 全文；行可点击打开详情窗口；050r2 起左对齐 */
.h-range {
  text-align: left;
}
.c-range {
  text-align: left;
  font-size: 10px;
  color: var(--sub, #6b7280);
  white-space: nowrap;
}
.map-row {
  cursor: pointer;
}
.map-row:hover .c-model {
  color: var(--brand, #4f6ef7);
}
.lp.his {
  border-style: dashed;
}
.lp {
  font-style: normal;
  font-size: 9px;
  padding: 0 2px;
  margin-left: 2px;
  border-radius: 3px;
  border: 1px solid currentColor;
  opacity: 0.65;
}
</style>
