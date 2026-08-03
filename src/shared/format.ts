import type { SiteStatus } from './types'

/** 币种符号映射（无映射则原样 + 空格）。 */
const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  CNY: '¥',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
}

export function currencySymbol(currency: string | null | undefined): string {
  if (!currency) return ''
  return CURRENCY_SYMBOLS[currency] ?? currency + ' '
}

/** 余额格式化：null → 「—」；否则带币种符号 + 两位小数。 */
export function fmtBalance(val: number | null, currency: string | null): string {
  if (val == null) return '—'
  return currencySymbol(currency) + val.toFixed(2)
}

/** Token 数量格式化：null → 「—」；K / M 缩写。 */
export function fmtTokens(val: number | null): string {
  if (val == null) return '—'
  if (val < 1000) return String(val)
  if (val < 1_000_000) return (val / 1000).toFixed(1) + 'K'
  return (val / 1_000_000).toFixed(2) + 'M'
}

/** 整数千分位格式化：null → 「—」。 */
export function fmtNum(val: number | null): string {
  if (val == null) return '—'
  return val.toLocaleString('en-US')
}

/** HH:MM 格式化。 */
export function fmtTime(ts: number | null | undefined): string {
  if (!ts) return '—'
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 毫秒格式化（API 往返 / 站点平均响应）：null → 「—」；<1s 显 ms，否则显 s。 */
export function fmtMs(val: number | null): string {
  if (val == null) return '—'
  return val < 1000 ? `${Math.round(val)}ms` : `${(val / 1000).toFixed(2)}s`
}

/** 延迟着色类（仅对 API 往返耗时）：<500ms 绿 / <2s 黄 / 否则红。 */
export function fmtMsClass(val: number | null): string {
  if (val == null) return ''
  return val < 500 ? 'lat-good' : val < 2000 ? 'lat-warn' : 'lat-bad'
}

/** MM-DD HH:MM 格式化。 */
export function fmtDateTime(ts: number | null | undefined): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${m}-${day} ${fmtTime(ts)}`
}

export interface StatusBadgeInfo {
  text: string
  cls: string
}

/** 站点状态 → badge 文案 + CSS 类。 */
export function statusBadge(status: SiteStatus): StatusBadgeInfo {
  switch (status) {
    case 'ok':
      return { text: '● 正常', cls: 'b-ok' }
    case 'auth_expired':
      return { text: '⚠ 需重新授权', cls: 'b-auth' }
    case 'error':
      return { text: '● 采集异常', cls: 'b-err' }
    case 'no_source':
      return { text: 'ⓘ 数据源不可用', cls: 'b-info' }
    default:
      return { text: '○ 待采集', cls: 'b-unknown' }
  }
}
