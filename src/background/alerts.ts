import { db } from '../storage/db'
import { alertEpochAllowed, ALERT_NOTICE_PREFIX, ALERT_RETRY_ALARM, ALERT_TTL_MS, pruneAlertRuntime, resetAllAlertRuntime } from '../storage/alerts'
import { ruleSignature } from '../shared/alertRules'
import { acquireKeepAlive } from '../shared/keepAlive'
import { sendSystemNotification, getSystemNotifications } from '../shared/notify'
import { getPluginState, runPluginTask } from './pluginGate'
import { isValidSiteUrl } from '../shared/util'
import type { AlertDelivery, SiteConfig } from '../shared/types'

let queue: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const result = queue.then(fn, fn)
  queue = result.catch(() => {})
  return result
}
function running(): boolean { return getPluginState().effectiveState === 'enabled' }
async function validEvent(event: AlertDelivery): Promise<SiteConfig | null> {
  if (!running() || !(await alertEpochAllowed(event.pluginRevision))) return null
  const site = await db.sites.get(event.siteId)
  if (!site?.enabled || (site.currency ?? 'USD') !== event.currency) return null
  const signatures = new Set((site.alerts ?? []).filter((r) => r.enabled).map(ruleSignature))
  if (event.hits.some((h) => !signatures.has(h.signature))) return null
  return site
}
async function schedule(): Promise<void> {
  if (!running()) { await chrome.alarms.clear(ALERT_RETRY_ALARM); return }
  const pending = await db.alertDeliveries.where('status').equals('pending').sortBy('nextAttemptAt')
  if (!running() || !pending.length) { await chrome.alarms.clear(ALERT_RETRY_ALARM); return }
  await chrome.alarms.create(ALERT_RETRY_ALARM, { when: Math.max(Date.now() + 1000, pending[0].nextAttemptAt) })
  // Closing while create() awaited must not leave a resurrected alarm.
  if (!running()) await chrome.alarms.clear(ALERT_RETRY_ALARM)
}
async function deliver(event: AlertDelivery): Promise<void> {
  const latest = await db.alertDeliveries.get(event.eventId)
  if (!latest || latest.status !== 'pending') return
  event = latest
  if (event.createdAt <= Date.now() - ALERT_TTL_MS) {
    await db.alertDeliveries.update(event.eventId, { status: 'cancelled', lastError: 'expired' }); return
  }
  const site = await validEvent(event)
  if (!site) {
    await db.alertDeliveries.update(event.eventId, { status: 'cancelled', lastError: 'disabled_or_changed' }); return
  }
  const id = ALERT_NOTICE_PREFIX + event.eventId
  // Recover the crash window between browser acceptance and marking delivered.
  const existing = await getSystemNotifications().catch(() => ({}))
  if (existing && id in existing) {
    await db.alertDeliveries.update(event.eventId, { status: 'delivered', lastError: undefined }); return
  }
  if (event.attempts >= 3) {
    await db.alertDeliveries.update(event.eventId, { status: 'failed', lastError: 'failed' }); return
  }
  const attempts = event.attempts + 1
  // Persist attempt before external side-effect. If the worker dies, retry with the same id.
  await db.alertDeliveries.update(event.eventId, { attempts, nextAttemptAt: Date.now() + 60000 })
  const text = event.hits.slice(0, 3).map((h) => `${h.label || '临界值'} ≤ ${h.threshold} ${h.currency}`).join('、')
  const result = await sendSystemNotification(
    `⚠️ ${site.name.slice(0, 60)} 余额警报`,
    `当前余额 ${event.balance} ${event.currency}；触发：${text}${event.hits.length > 3 ? ` 等${event.hits.length}项` : ''}`,
    { id, requireInteraction: event.hits.some((h) => h.requireInteraction), priority: 2 },
    async () => !!(await validEvent(event)),
  )
  if (result === 'accepted') {
    await db.alertDeliveries.update(event.eventId, { status: 'delivered', lastError: undefined })
    // Do not keep more than 3 visible notifications for one station.
    const visible = await getSystemNotifications()
    const delivered = await db.alertDeliveries.where('siteId').equals(site.id).filter((e) => e.status === 'delivered').sortBy('createdAt')
    const old = delivered.filter((e) => ALERT_NOTICE_PREFIX + e.eventId in visible).slice(0, -3)
    await Promise.all(old.map((e) => chrome.notifications.clear(ALERT_NOTICE_PREFIX + e.eventId)))
  } else if (result === 'disabled') {
    await db.alertDeliveries.update(event.eventId, { status: 'cancelled', lastError: result })
  } else if (result !== 'failed' || attempts >= 3) {
    await db.alertDeliveries.update(event.eventId, { status: 'failed', lastError: result })
  } else {
    await db.alertDeliveries.update(event.eventId, { nextAttemptAt: Date.now() + (attempts === 1 ? 60000 : 300000), lastError: result })
  }
}
/** One bounded drain; both post-collection and alarms call this. No additional balance fetch. */
export function flushBalanceAlerts(): Promise<void> {
  return serial(async () => {
    if (!running()) return
    const release = acquireKeepAlive()
    try {
      await pruneAlertRuntime()
      const pending = await db.alertDeliveries.where('status').equals('pending')
        .filter((e) => e.nextAttemptAt <= Date.now()).limit(20).toArray()
      for (const e of pending) {
        if (!running()) break
        try { await deliver(e) }
        catch {
          // A browser/DB failure must never turn a successful collection into an auth error.
          await db.alertDeliveries.update(e.eventId, { lastError: 'failed', nextAttemptAt: Date.now() + 60000 }).catch(() => {})
        }
      }
      await schedule()
    } finally { release() }
  })
}
/** Serialized with delivery to ensure OFF finishes after the final browser notification call. */
export function stopBalanceAlerts(): Promise<void> {
  return serial(async () => {
    await chrome.alarms.clear(ALERT_RETRY_ALARM)
    await resetAllAlertRuntime()
    const current = await getSystemNotifications()
    if (current) await Promise.all(Object.keys(current).filter((id) => id.startsWith(ALERT_NOTICE_PREFIX)).map((id) => chrome.notifications.clear(id)))
  })
}
let registered = false
export function setupBalanceAlerts(): void {
  if (registered) return
  registered = true
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALERT_RETRY_ALARM) void runPluginTask(flushBalanceAlerts).catch(() => {})
  })
  chrome.notifications?.onClicked.addListener((id) => {
    if (!id.startsWith(ALERT_NOTICE_PREFIX)) return
    void runPluginTask(async () => {
      const event = await db.alertDeliveries.get(id.slice(ALERT_NOTICE_PREFIX.length))
      if (!event || event.status !== 'delivered') return
      const site = await validEvent(event)
      if (!site || !isValidSiteUrl(site.baseUrl) || !running()) return
      await chrome.tabs.create({ url: site.baseUrl.trim() })
    }).catch(() => {})
  })
}

/** Called ONLY by the serialized resource coordinator; valid during initialization. */
export async function restoreBalanceAlertSchedule(): Promise<void> {
  const pending = await db.alertDeliveries.where('status').equals('pending').sortBy('nextAttemptAt')
  if (!pending.length) { await chrome.alarms.clear(ALERT_RETRY_ALARM); return }
  await chrome.alarms.create(ALERT_RETRY_ALARM, { when: Math.max(Date.now() + 1000, pending[0].nextAttemptAt) })
}
