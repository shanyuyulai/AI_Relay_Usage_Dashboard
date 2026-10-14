/**
 * 模型均价格式化助手（方案 049）：ModelAvgPrice.vue 与 avgdetail/App.vue 共用，
 * 消除 048 中悬浮窗组件内的私有实现重复。
 * 红线 P0-3：无数据一律返回「—」，绝不编造数字。
 */
import type { ModelAvgSummary } from '../core/messaging/protocol'

/**
 * 精确数值文本（050r3）：不做四舍五入，直接展示真实存储值。
 * 仅用 12 位有效数字归一化去除二进制浮点运算噪声（如 0.1+0.2=0.30000000000000004 → 0.3）；
 * 接口原始金额（≤8 位小数）与真实计算结果在此精度下完全无损。
 * 用途：悬停 title 中展示精确值（050r3：正文四舍五入、title 显精确值）。
 */
export function fmtExact(v: number): string {
  if (!Number.isFinite(v)) return '—'
  return String(parseFloat(v.toPrecision(12)))
}

/** 均价文本：partial 批次加「≈」前缀；无数据显示「—」（P0-3）。展示层按量级取小数位，精确值走 fmtExact 供 title。 */
export function fmtAvgText(s?: ModelAvgSummary | null): string {
  if (!s || !s.hasDetail || s.pricePerM == null || !Number.isFinite(s.pricePerM)) return '—'
  const v = s.pricePerM
  const body = v >= 100 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v.toFixed(3)
  return (s.partial ? '≈' : '') + '¥' + body
}

/** tokens 紧凑格式：≥1M 显 M，≥1K 显 K。 */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

/** 行价格式：null/非法显「—」，其余 ¥ 前缀按量级取小数位（精确值走 fmtExact 供 title，050r3）。 */
export function fmtRowPrice(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return '¥' + (v >= 100 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v.toFixed(3))
}

/**
 * 参与计算记录的时间范围小字（048 可配置项③）：
 * `MM-DD HH:mm – MM-DD HH:mm · N 条`（同日省略末端日期）；缺失返回空串。
 */
export function fmtRange(rangeStart: number | null, rangeEnd: number | null, usedCount: number): string {
  if (rangeStart == null || rangeEnd == null) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  const f = (ts: number, withDate: boolean) => {
    const t = new Date(ts)
    const hm = `${p(t.getHours())}:${p(t.getMinutes())}`
    return withDate ? `${p(t.getMonth() + 1)}-${p(t.getDate())} ${hm}` : hm
  }
  const a = new Date(rangeStart)
  const b = new Date(rangeEnd)
  const sameDay =
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  return `${f(rangeStart, true)} – ${f(rangeEnd, !sameDay)} · ${usedCount} 条`
}

/** 来源数据范围缩写（050）：`MM-DD HH:mm–HH:mm`（跨日含末端日期），不含条数；缺失返回空串。 */
export function fmtRangeShort(rangeStart: number | null | undefined, rangeEnd: number | null | undefined): string {
  if (rangeStart == null || rangeEnd == null) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  const f = (ts: number, withDate: boolean) => {
    const t = new Date(ts)
    const hm = `${p(t.getHours())}:${p(t.getMinutes())}`
    return withDate ? `${p(t.getMonth() + 1)}-${p(t.getDate())} ${hm}` : hm
  }
  const a = new Date(rangeStart)
  const b = new Date(rangeEnd)
  const sameDay =
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  return `${f(rangeStart, true)}–${f(rangeEnd, !sameDay)}`
}
