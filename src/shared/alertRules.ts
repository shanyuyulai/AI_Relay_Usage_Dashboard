import type { BalanceAlertRule, SiteConfig, Snapshot, AlertBaseline } from './types'

export const MAX_BALANCE_ALERTS = 10
export const ALERT_CURRENCIES = ['USD', 'CNY', 'JPY', 'EUR'] as const
function invalid(message: string): never {
  throw Object.assign(new Error(message), { kind: 'VALIDATION_ERROR' })
}
export function parseAlertThreshold(text: string): number {
  const value = text.trim()
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) invalid('警报临界值不能为空，且必须是0或正十进制数')
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0 || n > 1e12) invalid('警报临界值必须在0到1万亿之间')
  return n
}
/** Shared strict write boundary. Never coerce null / empty text / booleans to money. */
export function normalizeAlertRules(raw: unknown, currency: string, previous: BalanceAlertRule[] = [], now = Date.now()): BalanceAlertRule[] {
  if (!Array.isArray(raw)) invalid('余额警报必须是数组；清空请传空数组')
  if (raw.length > MAX_BALANCE_ALERTS) invalid('每站最多10条余额警报')
  const ids = new Set<string>()
  return raw.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) invalid('警报项格式不正确')
    const r = item as Record<string, unknown>
    if (typeof r.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(r.id) || ids.has(r.id)) invalid('警报ID无效或重复')
    ids.add(r.id)
    if (typeof r.label !== 'string') invalid('警报名称必须是文本')
    const label = r.label.trim().replace(/[\u0000-\u001f\u007f]/g, '')
    if (label.length > 32) invalid('警报名称最多32字')
    if (typeof r.threshold !== 'number' || !Number.isFinite(r.threshold) || r.threshold < 0 || r.threshold > 1e12) invalid('警报临界值必须是0或正数，且不大于1万亿')
    if (typeof r.currency !== 'string' || !(ALERT_CURRENCIES as readonly string[]).includes(r.currency)) invalid('警报币种不受支持')
    if (r.enabled !== undefined && typeof r.enabled !== 'boolean') invalid('警报启用值必须是布尔值')
    if (r.requireInteraction !== undefined && typeof r.requireInteraction !== 'boolean') invalid('通知保持显示必须是布尔值')
    const enabled = r.enabled === undefined ? true : r.enabled
    if (enabled && r.currency !== currency) invalid('启用的余额警报币种必须与站点计价货币一致')
    const old = previous.find((p) => p.id === r.id)
    const changed = !old || old.threshold !== r.threshold || old.currency !== r.currency || old.enabled !== enabled
    return {
      id: r.id, label, threshold: r.threshold, currency: r.currency, enabled,
      requireInteraction: r.requireInteraction === undefined ? true : r.requireInteraction,
      revision: old ? (old.revision || 1) + (changed ? 1 : 0) : 1,
      createdAt: old?.createdAt ?? now,
      updatedAt: changed || label !== old?.label || r.requireInteraction !== old?.requireInteraction ? now : old?.updatedAt ?? now,
    }
  })
}
/** Only configuration fields cross the backup boundary. Runtime revisions are regenerated. */
export function exportAlertRules(site: SiteConfig): BalanceAlertRule[] | undefined {
  if (site.alerts === undefined) return undefined
  return normalizeAlertRules(site.alerts, site.currency ?? 'USD', site.alerts).map((r) => ({
    id: r.id, label: r.label, threshold: r.threshold, currency: r.currency,
    enabled: r.enabled, requireInteraction: r.requireInteraction,
    revision: 1, createdAt: r.createdAt, updatedAt: r.updatedAt,
  }))
}
export function ruleSignature(rule: BalanceAlertRule): string {
  return JSON.stringify([rule.id, rule.revision, rule.threshold, rule.currency, rule.enabled])
}
export function isDownwardCrossing(previous: AlertBaseline | undefined, current: number, rule: BalanceAlertRule, context: string): boolean {
  return !!previous && rule.enabled && Number.isFinite(current) && Number.isFinite(previous.balance)
    && previous.ruleSignature === ruleSignature(rule) && previous.context === context
    && previous.balance > rule.threshold && current <= rule.threshold
}
/** Never compare balances from incompatible currencies, endpoints, or conversion units. */
export function balanceContext(site: SiteConfig, snap: Snapshot, units?: unknown): string {
  const raw = units && typeof units === 'object' ? units as Record<string, unknown> : {}
  const numeric = ['quotaPerUnit', 'usdExchangeRate', 'customCurrencyExchangeRate'].map((k) => {
    const n = raw[k]
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null
  })
  return JSON.stringify([site.origin, site.adapter, snap.currency, snap.channel,
    site.discovered?.userSelfPath ?? null, site.discovered?.accountSemantics ?? null,
    site.discovered?.accountContractVersion ?? null, snap.balanceSource ?? null, ...numeric])
}
