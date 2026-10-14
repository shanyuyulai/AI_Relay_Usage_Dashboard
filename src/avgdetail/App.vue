<script setup lang="ts">
/**
 * 模型价格详情 · 独立窗口（方案 049r1，050r1 更名：均价→价格）。
 * - 入口：极简面板 / 完整看板中双击任一价格数字（chrome.windows.create 弹出，不受 popup 尺寸限制）。
 * - 内容：全部站点的模型价格详情**一次性全部展开**（无折叠），每站含：时间范围小字、
 *   提示（未填充值比例 / 无逐条明细 / partial）、完整模型表（模型 / 用量 / ¥每M，按用量倒序，不截断行数；
 *   价格来自历史档案的模型以「档」标注）。
 * - URL 参数 ?site=<siteId>：高亮并滚动到双击来源站点。
 * 红线：P0-3 无数据显「—」绝不编造；P0-2 不触碰任何凭证。
 */
import { nextTick, computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { send, MessagingError } from '../core/messaging/client'
import type {
  DashboardSummaryItem,
  GetDashboardSummaryResponse,
  GetSiteModelPricesResponse,
  ModelAvgSummary,
  GetModelAvgSourceResponse,
  GetSiteModelAvgHistoryResponse,
} from '../core/messaging/protocol'
import type { ModelAvgRawRecord, ModelAvgHistory } from '../shared/types'
import { fmtAvgText, fmtTokens, fmtRowPrice, fmtRange, fmtRangeShort, fmtExact } from '../shared/modelAvgFormat'
const items = ref<DashboardSummaryItem[]>([])
const maxRecords = ref<number | null>(null)
const loading = ref(true)
const error = ref('')
/** 各站明细：值 = 接口结果；'ERR' = 拉取失败（errs 给出文案）。 */
const details = ref<Map<string, GetSiteModelPricesResponse | 'ERR'>>(new Map())
const errs = ref<Map<string, string>>(new Map())

/** 双击来源站点（URL 参数），高亮 + 滚动定位。 */
const activeSite = new URL(window.location.href).searchParams.get('site') ?? ''

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const res = await send<GetDashboardSummaryResponse>('GET_DASHBOARD_SUMMARY', {})
    items.value = res.items
    maxRecords.value = res.settings.modelAvgMaxRecords
    // 各站明细并发拉取；单站失败不拖垮整页（该站显示失败原因）
    const results = await Promise.allSettled(
      res.items.map((it) => send<GetSiteModelPricesResponse>('GET_SITE_MODEL_PRICES', { siteId: it.siteId })),
    )
    const m = new Map<string, GetSiteModelPricesResponse | 'ERR'>()
    const em = new Map<string, string>()
    results.forEach((r, i) => {
      const id = res.items[i].siteId
      if (r.status === 'fulfilled') m.set(id, r.value)
      else {
        m.set(id, 'ERR')
        em.set(id, r.reason instanceof MessagingError ? r.reason.message : '加载失败')
      }
    })
    details.value = m
    errs.value = em
  } catch (e) {
    error.value = e instanceof MessagingError ? e.message : '加载失败'
  } finally {
    loading.value = false
    void scrollToActive()
  }
}

async function scrollToActive(): Promise<void> {
  if (!activeSite) return
  await nextTick()
  document.getElementById(`site-${CSS.escape(activeSite)}`)?.scrollIntoView({ block: 'center' })
}

/** 渲染视图行：脚本侧收窄 'ERR' 联合类型，模板免跨插值收窄失败的问题。 */
interface DetailRow {
  id: string
  name: string
  avg: ModelAvgSummary | null
  active: boolean
  err: string
  detail: GetSiteModelPricesResponse | null
}
const rows = computed<DetailRow[]>(() =>
  items.value.map((it) => {
    const v = details.value.get(it.siteId)
    return {
      id: it.siteId,
      name: it.name,
      avg: it.modelAvg ?? null,
      active: it.siteId === activeSite,
      err: v === 'ERR' ? errs.value.get(it.siteId) || '加载失败' : '',
      detail: v && v !== 'ERR' ? v : null,
    }
  }),
)

// ── 原始记录查看器（049r2/050）：整站口径（点时间范围行）与单模型口径（点数据范围列）共用 ──
const viewer = ref<null | { title: string; algo: string[]; loading: boolean; records: ModelAvgRawRecord[] }>(null)
let srcLoading = false

/** 整站口径：当前批次现算（口径=最近 N 条），数据已在手。 */
function openSiteViewer(r: DetailRow): void {
  const d = r.detail
  if (!d) return
  viewer.value = {
    title: `${r.name} · 原始数据与计算方式`,
    algo: [
      `数据口径：该站点逐条用量明细，取${maxRecordsText.value}（按时间倒序）；本次实际参与 ${d.usedCount} 条${d.skippedCount ? `，跳过 ${d.skippedCount} 条（缺金额或币种与站点计价币种不符）` : ''}；价格来自历史档案的模型以「档」标注。`,
      `逐条金额：优先取「实扣」，缺失时回退「标价」（行内标「标」）；人民币折算 = 金额 × 充值比例 ${d.rechargeRate ?? '未填充'}${d.siteCurrency ? `（站点按 ${d.siteCurrency} 计价）` : ''}。`,
      '模型价格（¥/百万 tokens）= Σ 人民币折算 ÷ Σ（输入 + 输出 tokens）× 1,000,000。',
      `看板默认展示的价格 = 用量最大模型的价格；模型列表按用量倒序${d.partial ? '；明细超上限（≈），按已采集部分计算' : ''}。`,
    ],
    loading: false,
    records: d.records,
  }
}

/** 单模型口径（方案 050）：懒加载该模型档案（含来源原始记录投影）。 */
async function openModelViewer(r: DetailRow, row: GetSiteModelPricesResponse['rows'][number]): Promise<void> {
  if (srcLoading) return
  srcLoading = true
  viewer.value = { title: `${r.name} · ${row.model} · 数据来源`, algo: [], loading: true, records: [] }
  try {
    const res = await send<GetModelAvgSourceResponse>('GET_MODEL_AVG_SOURCE', { siteId: r.id, model: row.model })
    const p = res.price
    if (!p) {
      viewer.value = { ...viewer.value!, loading: false, algo: ['该模型暂无价格档案（当前批次无该模型的有效数据）'], records: [] }
    } else {
      viewer.value = {
        title: viewer.value!.title,
        algo: [
          `数据口径：该模型参与计算的原始记录 ${p.usedCount} 条（时间范围 ${fmtRange(p.rangeStart, p.rangeEnd, p.usedCount) || '—'}）；采集批次${p.partial ? '超上限（≈），按已采集部分计算' : '完整'}。`,
          `逐条金额：优先取「实扣」，缺失时回退「标价」（行内标「标」）；人民币折算 = 金额 × 充值比例 ${p.rechargeRate ?? '未填充'}${p.missingRate ? '（未填充，无法折算人民币）' : ''}。`,
          `该模型价格（¥/百万 tokens）= Σ 人民币折算 ÷ Σ（输入 + 输出 tokens）× 1,000,000 = ${fmtRowPrice(p.pricePerM)}${p.pricePerM != null ? `（精确值 ¥${fmtExact(p.pricePerM)}）` : ''}；档案计算于 ${fmtTs(p.computedAt)}${row.fromHistory ? '（价格来自历史档案）' : ''}。`,
        ],
        loading: false,
        records: p.records,
      }
    }
  } catch (e) {
    viewer.value = { ...viewer.value!, loading: false, algo: [e instanceof MessagingError ? e.message : '加载失败'], records: [] }
  } finally {
    srcLoading = false
  }
}

// ── 历史价格弹窗（方案 050）──
const hist = ref<null | { name: string; siteId: string; loading: boolean; err: string; rows: ModelAvgHistory[] }>(null)

async function openHistory(r: DetailRow): Promise<void> {
  hist.value = { name: r.name, siteId: r.id, loading: true, err: '', rows: [] }
  try {
    const res = await send<GetSiteModelAvgHistoryResponse>('GET_SITE_MODEL_AVG_HISTORY', { siteId: r.id })
    hist.value = { name: r.name, siteId: r.id, loading: false, err: '', rows: res.rows }
  } catch (e) {
    hist.value = { name: r.name, siteId: r.id, loading: false, err: e instanceof MessagingError ? e.message : '加载失败', rows: [] }
  }
}

/**
 * 历史条目「数据范围」点击（050r1/050r2）：弹出该次计算的数据来源。
 * - 新条目（050r1 起）：records 随历史条目留存，直接展示；
 * - 旧条目（无 records）：回退拉取该模型当前档案的来源明细展示（明确标注供参考，
 *   数据可能晚于该次计算）；档案也缺失时仅显示计算口径。
 */
async function openHistoryViewer(h: ModelAvgHistory): Promise<void> {
  if (srcLoading) return
  srcLoading = true
  const siteId = hist.value?.siteId ?? ''
  const title = `${hist.value?.name ?? ''} · ${h.model} · 历史价格数据来源`
  const algoBase = [
    `数据口径：该模型参与本次计算的原始记录 ${h.usedCount} 条（时间范围 ${fmtRange(h.rangeStart, h.rangeEnd, h.usedCount) || '—'}）；采集批次${h.partial ? '超上限（≈），按已采集部分计算' : '完整'}。`,
    `逐条金额：优先取「实扣」，缺失时回退「标价」（行内标「标」）；人民币折算 = 金额 × 充值比例 ${h.rechargeRate ?? '未填充'}${h.missingRate ? '（未填充，无法折算人民币）' : ''}。`,
    `该模型价格（¥/百万 tokens）= Σ 人民币折算 ÷ Σ（输入 + 输出 tokens）× 1,000,000 = ${fmtRowPrice(h.pricePerM)}${h.pricePerM != null ? `（精确值 ¥${fmtExact(h.pricePerM)}）` : ''}；计算于 ${fmtTs(h.computedAt)}。`,
  ]
  const own = Array.isArray(h.records) ? h.records : []
  if (own.length) {
    viewer.value = { title, algo: algoBase, loading: false, records: own }
    srcLoading = false
    return
  }
  viewer.value = {
    title,
    algo: [...algoBase, '该历史条目未留存原始明细（旧版本产生）；正在尝试用该模型当前档案的来源明细代替展示，数据可能晚于该次计算，仅供参考。'],
    loading: true,
    records: [],
  }
  try {
    const res = await send<GetModelAvgSourceResponse>('GET_MODEL_AVG_SOURCE', { siteId, model: h.model })
    const p = res.price
    if (p && p.records.length) {
      viewer.value = { title, algo: viewer.value!.algo, loading: false, records: p.records }
    } else {
      viewer.value = { title, algo: [...viewer.value!.algo, '该模型当前也没有档案明细（当前批次无该模型的有效数据）。'], loading: false, records: [] }
    }
  } catch (e) {
    viewer.value = { title, algo: [...viewer.value!.algo, `当前档案明细加载失败：${e instanceof MessagingError ? e.message : '加载失败'}`], loading: false, records: [] }
  } finally {
    srcLoading = false
  }
}

function closeModals(): void {
  viewer.value = null
  hist.value = null
}
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeModals()
}
window.addEventListener('keydown', onKeydown)
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

/** 记录时间：MM-DD HH:mm:ss。 */
function fmtTs(ts: number): string {
  const t = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`
}

/** 本币金额展示：按量级取小数位（四舍五入显示，精确值在 title 中，050r3）。 */
function fmtAmount(v: number): string {
  return v >= 100 ? v.toFixed(2) : v >= 1 ? v.toFixed(2) : v.toFixed(4)
}

/** 站点均价 title：正文为四舍五入展示，title 补精确值与历史档案来源说明（050r3）。 */
function avgTitle(s: ModelAvgSummary | null): string {
  if (!s || fmtAvgText(s) === '—') return ''
  const exact = s.pricePerM != null ? `精确值 ¥${fmtExact(s.pricePerM)}/百万 tokens` : ''
  return s.fromHistory
    ? `当日无数据，取历史档案中用量最大模型（${s.topModel ?? '—'}）的价格；${exact}`
    : exact
}

/** 计算条目上限（页面头部口径与弹窗说明共用）。 */
const maxRecordsText = computed(() => (maxRecords.value ? `最近 ${maxRecords.value} 条` : '最近 N 条'))

onMounted(() => {
  void load()
})
</script>

<template>
  <div class="page">
    <header class="head">
      <span class="title">模型价格详情</span>
      <span class="win">{{
        maxRecords ? `逐条用量明细 · 最近 ${maxRecords} 条` : '逐条用量明细'
      }}</span>
      <button class="refresh" title="重新计算" @click="load">↻ 刷新</button>
    </header>

    <div v-if="loading" class="state">计算中…</div>
    <div v-else-if="error" class="state err">{{ error }}</div>
    <div v-else-if="items.length === 0" class="state">还没有站点，先去设置页添加</div>

    <main v-else class="list">
      <section
        v-for="r in rows"
        :id="`site-${r.id}`"
        :key="r.id"
        class="site"
        :class="{ active: r.active }"
      >
        <div class="s-head">
          <span class="s-name" :title="r.name">{{ r.name }}</span>
          <span class="hist-btn" title="查看该站历史价格" @click="openHistory(r)">🕘 历史</span>
          <span class="s-avg" :class="{ 'is-null': fmtAvgText(r.avg) === '—' }" :title="avgTitle(r.avg)">
            {{ fmtAvgText(r.avg) }}<i class="s-unit">/M</i>
            <i v-if="r.avg?.fromHistory" class="lp his" title="当日无数据，价格来自历史档案（历史用量最大模型）">档</i>
          </span>
        </div>

        <div class="s-detail">
          <template v-if="r.err">
            <div class="note">{{ r.err }}</div>
          </template>
          <template v-else-if="r.detail">
            <div
              v-if="fmtRange(r.detail.rangeStart, r.detail.rangeEnd, r.detail.usedCount)"
              class="range link"
              title="点击查看原始数据与计算方式（当前批次口径）"
              @click="openSiteViewer(r)"
            >
              {{ fmtRange(r.detail.rangeStart, r.detail.rangeEnd, r.detail.usedCount) }} ▸
            </div>
            <div v-if="r.detail.missingRate" class="note">
              未填充值比例，无法换算人民币（去设置页填写充值比例）
            </div>
            <div v-else-if="!r.detail.hasDetail" class="note">
              该站点无逐条用量明细，暂不支持模型价格
            </div>
            <div v-if="r.detail.partial" class="note">明细超上限，按已采集部分计算</div>
            <table v-if="r.detail.rows.length" class="tbl">
              <thead>
                <tr><th class="h-model">模型</th><th class="h-range">数据范围</th><th class="h-num">用量</th><th class="h-num">次数</th><th class="h-num">¥/M</th></tr>
              </thead>
              <tbody>
                <tr v-for="row in r.detail.rows" :key="row.model">
                  <td class="c-model" :title="row.model">
                    {{ row.model }}
                    <i v-if="row.listPriceBased" class="lp" title="该模型部分记录缺实扣价，按标价口径计算">标</i>
                    <i v-if="row.fromHistory" class="lp his" title="价格来自历史档案（当前批次无该模型新数据）">档</i>
                  </td>
                  <td class="c-range" title="点击查看该模型价格的数据来源" @click="openModelViewer(r, row)">
                    {{ fmtRangeShort(row.rangeStart, row.rangeEnd) || '—' }}<span v-if="row.usedCount" class="rc"> · {{ row.usedCount }}条</span>
                  </td>
                  <td class="c-num">{{ fmtTokens(row.tokens) }}</td>
                  <td class="c-num">{{ row.requests }}</td>
                  <td class="c-num" :title="row.pricePerM != null ? `¥${fmtExact(row.pricePerM)}/百万 tokens` : ''">{{ fmtRowPrice(row.pricePerM) }}</td>
                </tr>
              </tbody>
            </table>
            <div v-else class="note">暂无可计算的数据</div>
          </template>
          <div v-else class="note">计算中…</div>
        </div>
      </section>
    </main>

    <!-- 原始记录查看器（049r2/050）：整站口径与单模型口径共用；×/ESC/遮罩关闭 -->
    <Teleport to="body">
      <div v-if="viewer" class="rm-mask rm-top" @click.self="viewer = null">
        <div class="rm-panel" role="dialog" aria-modal="true" :aria-label="viewer.title">
          <header class="rm-head">
            <span class="rm-title">{{ viewer.title }}</span>
            <button class="rm-x" title="关闭" @click="viewer = null">×</button>
          </header>

          <div class="rm-body">
            <div v-if="viewer.algo.length" class="rm-sec">
              <div class="rm-sub">计算方式</div>
              <ol class="rm-steps">
                <li v-for="(s, i) in viewer.algo" :key="i">{{ s }}</li>
              </ol>
            </div>

            <div class="rm-sec">
              <div class="rm-sub">原始记录（{{ viewer.records.length }} 条）</div>
              <div v-if="viewer.loading" class="note">加载中…</div>
              <table v-else-if="viewer.records.length" class="tbl rm-tbl">
                <thead>
                  <tr>
                    <th class="h-time">时间</th>
                    <th class="h-model">模型</th>
                    <th class="h-num">输入</th>
                    <th class="h-num">输出</th>
                    <th class="h-num">金额</th>
                    <th class="h-num">¥折算</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(rec, i) in viewer.records" :key="i">
                    <td class="c-time">{{ fmtTs(rec.ts) }}</td>
                    <td class="c-model" :title="rec.model">
                      {{ rec.model }}
                      <i v-if="rec.listPrice" class="lp" title="缺实扣价，按标价口径参与计算">标</i>
                    </td>
                    <td class="c-num">{{ fmtTokens(rec.promptTokens) }}</td>
                    <td class="c-num">{{ fmtTokens(rec.completionTokens) }}</td>
                    <td class="c-num" :title="rec.amount != null ? fmtExact(rec.amount) : ''">{{ fmtAmount(rec.amount ?? 0) }}<span class="cur">{{ rec.currency ?? '' }}</span></td>
                    <td class="c-num" :class="{ 'is-null': rec.rmb == null }" :title="rec.rmb != null ? `¥${fmtExact(rec.rmb)}` : ''">{{ rec.rmb == null ? '—' : fmtRowPrice(rec.rmb) }}</td>
                  </tr>
                </tbody>
              </table>
              <div v-else class="note">没有参与计算的记录</div>
            </div>
          </div>
        </div>
      </div>

      <!-- 历史价格弹窗（方案 050） -->
      <div v-if="hist" class="rm-mask" @click.self="hist = null">
        <div class="rm-panel" role="dialog" aria-modal="true" :aria-label="`${hist.name} 历史价格`">
          <header class="rm-head">
            <span class="rm-title">{{ hist.name }} · 历史价格</span>
            <button class="rm-x" title="关闭" @click="hist = null">×</button>
          </header>
          <div class="rm-body">
            <div v-if="hist.loading" class="note">加载中…</div>
            <div v-else-if="hist.err" class="note">{{ hist.err }}</div>
            <table v-else-if="hist.rows.length" class="tbl rm-tbl">
              <thead>
                <tr>
                  <th class="h-time">计算时间</th>
                  <th class="h-model">模型</th>
                  <th class="h-num">¥/M</th>
                  <th class="h-range">数据范围</th>
                  <th class="h-num">条数</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="h in hist.rows" :key="h.id ?? `${h.model}-${h.computedAt}`">
                  <td class="c-time">{{ fmtTs(h.computedAt) }}</td>
                  <td class="c-model" :title="h.model">
                    {{ h.model }}
                    <i v-if="h.listPriceBased" class="lp" title="部分记录缺实扣价，按标价口径计算">标</i>
                  </td>
                  <td class="c-num" :class="{ 'is-null': h.pricePerM == null }" :title="h.pricePerM != null ? `¥${fmtExact(h.pricePerM)}/百万 tokens` : ''">{{ fmtRowPrice(h.pricePerM) }}</td>
                  <td class="c-range linkable" title="点击查看该次计算的数据来源" @click="openHistoryViewer(h)">{{ fmtRangeShort(h.rangeStart, h.rangeEnd) || '—' }}</td>
                  <td class="c-num">{{ h.usedCount }}</td>
                </tr>
              </tbody>
            </table>
            <div v-else class="note">暂无历史价格（价格首次变动后开始留痕）</div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  padding: 14px 16px 18px;
  box-sizing: border-box;
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.title {
  font-size: 14px;
  font-weight: 700;
}
.win {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 10.5px;
  color: var(--sub);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.refresh {
  flex: 0 0 auto;
  border: 1px solid var(--line);
  background: var(--panel-soft);
  color: var(--text);
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 6px;
  cursor: pointer;
}
.refresh:hover {
  border-color: var(--brand);
  color: var(--brand);
}
.state {
  padding: 40px 0;
  text-align: center;
  font-size: 12px;
  color: var(--sub);
}
.state.err {
  color: #e5484d;
}
.list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.site {
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 10px 12px;
  background: var(--panel-soft);
}
.site.active {
  border-color: var(--brand);
  box-shadow: 0 0 0 1px var(--brand);
}
.s-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.s-name {
  font-size: 13px;
  font-weight: 600;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.s-avg {
  flex: 0 0 auto;
  font-size: 15px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.s-avg.is-null {
  opacity: 0.45;
  font-weight: 400;
}
.s-unit {
  font-style: normal;
  font-size: 10px;
  font-weight: 400;
  color: var(--sub);
  margin-left: 2px;
}
.s-detail {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.5;
}
.range {
  font-size: 10.5px;
  color: var(--sub);
  margin-bottom: 4px;
}
/* 数据时间范围行可点击（049r2）：查看原始数据与计算方式 */
.range.link {
  cursor: pointer;
  display: inline-block;
}
.range.link:hover {
  color: var(--brand);
  text-decoration: underline;
}
.note {
  font-size: 11px;
  color: var(--sub);
  margin-bottom: 4px;
}
.tbl {
  width: 100%;
  border-collapse: collapse;
  margin-top: 2px;
}
.tbl th {
  font-weight: 600;
  color: var(--sub);
  border-bottom: 1px solid var(--line);
  padding: 3px 6px 4px 0;
  text-align: left;
}
.tbl td {
  padding: 3px 6px 3px 0;
  border-bottom: 1px solid color-mix(in srgb, var(--line) 55%, transparent);
  vertical-align: top;
  white-space: nowrap;
}
.tbl tbody tr:last-child td {
  border-bottom: none;
}
/* 对齐规则（050r2）：所有列标题与列内容一律左对齐 */
.h-model,
.c-model,
.h-num,
.c-num {
  text-align: left;
}
.h-num,
.c-num {
  font-variant-numeric: tabular-nums;
}
.c-model {
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
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

/* ── 原始数据 + 计算方式弹窗（049r2）── */
.rm-mask {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 14px;
  background: rgba(0, 0, 0, 0.42);
}
/* 从历史弹窗内再打开数据来源弹窗时，来源弹窗需盖在历史弹窗之上（050r1） */
.rm-mask.rm-top {
  z-index: 10000;
}
.rm-panel {
  display: flex;
  flex-direction: column;
  width: min(660px, 100%);
  max-height: 88vh;
  font-size: 12px;
  color: var(--text);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: 0 10px 36px rgba(0, 0, 0, 0.28);
  overflow: hidden;
}
.rm-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex: 0 0 auto;
  padding: 10px 14px 8px;
  border-bottom: 1px solid var(--line);
}
.rm-title {
  font-size: 13px;
  font-weight: 700;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rm-x {
  border: none;
  background: transparent;
  color: var(--sub);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  padding: 2px 4px;
  flex: 0 0 auto;
}
.rm-x:hover {
  color: var(--brand);
}
.rm-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 14px 14px;
}
.rm-sec {
  margin-bottom: 12px;
}
.rm-sec:last-child {
  margin-bottom: 0;
}
.rm-sub {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 6px;
}
.rm-steps {
  margin: 0;
  padding-left: 18px;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--text);
}
.rm-steps b {
  color: var(--brand);
}
.rm-tbl {
  margin-top: 2px;
}
.rm-tbl th {
  padding: 3px 8px 4px 0;
}
.rm-tbl td {
  padding: 2.5px 8px 2.5px 0;
}
.c-time {
  white-space: nowrap;
  color: var(--sub);
  font-variant-numeric: tabular-nums;
}
/* 时间列左对齐（050r2：所有列一律左对齐） */
.h-time,
.c-time {
  text-align: left;
}
.cur {
  margin-left: 2px;
  font-size: 10px;
  color: var(--sub);
}
.c-num.is-null {
  opacity: 0.45;
}
/* 数据范围列（050）：可点击查看该模型数据来源；050r2 起左对齐 */
.h-range {
  text-align: left;
}
.c-range {
  white-space: nowrap;
  text-align: left;
  color: var(--sub);
  font-size: 10.5px;
  cursor: pointer;
}
.c-range:hover {
  color: var(--brand);
  text-decoration: underline;
}
.rc {
  font-size: 10px;
  opacity: 0.85;
}
.lp.his {
  border-style: dashed;
}
.hist-btn {
  flex: 0 0 auto;
  font-size: 10.5px;
  color: var(--sub);
  cursor: pointer;
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 1px 6px;
  user-select: none;
}
.hist-btn:hover {
  color: var(--brand);
  border-color: var(--brand);
}
</style>
