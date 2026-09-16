import { db } from './db'
import { parsePluginEnabled, PLUGIN_ENABLED_KEY, PLUGIN_REVISION_KEY } from './enableConfig'
import { isDownwardCrossing, ruleSignature } from '../shared/alertRules'
import type { SiteConfig, Snapshot, AlertDelivery, AlertBaseline } from '../shared/types'

export const ALERT_RETRY_ALARM = 'aihub-alert-retry'
export const ALERT_NOTICE_PREFIX = 'balance-alert:'
export const ALERT_TTL_MS = 24 * 60 * 60 * 1000

/** Must run inside a transaction containing settings. Invalid state fails closed. */
export async function alertEpochAllowed(revision: number): Promise<boolean> {
  try {
    const on = parsePluginEnabled((await db.settings.get(PLUGIN_ENABLED_KEY))?.value)
    const stored = (await db.settings.get(PLUGIN_REVISION_KEY))?.value ?? 0
    return on && stored === revision
  } catch { return false }
}

/** Atomically stores the observation, advances baselines, and enqueues ONE event. */
export async function commitAlertObservation(initialSite: SiteConfig, snap: Snapshot, context: string, pluginRevision: number): Promise<string | null> {
  if (!snap.recordId) snap.recordId = crypto.randomUUID()
  return db.transaction('rw', [db.sites, db.settings, db.snapshots, db.alertBaselines, db.alertDeliveries, db.alertObservations], async () => {
    if (!(await alertEpochAllowed(pluginRevision))) return null
    const site = await db.sites.get(snap.siteId)
    if (!site?.enabled || site.origin !== initialSite.origin || (site.alertGeneration ?? 0) !== (initialSite.alertGeneration ?? 0)) return null
    // Immutable snapshot recordId is the observation id. Same milliseconds are not identity.
    if (await db.snapshots.where('recordId').equals(snap.recordId!).first()) return null
    await db.snapshots.add(snap)
    if (typeof snap.balance !== 'number' || !Number.isFinite(snap.balance) || !snap.currency) return null
    const meta = await db.alertObservations.get(site.id)
    const sequence = (meta?.sequence ?? 0) + 1
    await db.alertObservations.put({ siteId: site.id, sequence, lastRecordId: snap.recordId! })
    const hits: AlertDelivery['hits'] = []
    for (const rule of site.alerts ?? []) {
      const key = `${site.id}:${rule.id}`
      const original = initialSite.alerts?.find((r) => r.id === rule.id)
      // Config edited while collection was running: do not evaluate an old observation against new rules.
      if (!rule.enabled || !original || ruleSignature(original) !== ruleSignature(rule)) continue
      if (rule.currency !== snap.currency || rule.currency !== (site.currency ?? 'USD')) {
        await db.alertBaselines.delete(key)
        continue
      }
      const previous = await db.alertBaselines.get(key)
      if (isDownwardCrossing(previous, snap.balance, rule, context)) {
        hits.push({ ruleId: rule.id, signature: ruleSignature(rule), label: rule.label,
          threshold: rule.threshold, currency: rule.currency, requireInteraction: rule.requireInteraction })
      }
      const baseline: AlertBaseline = { key, siteId: site.id, ruleSignature: ruleSignature(rule),
        ruleId: rule.id, context, balance: snap.balance, sequence, observationId: snap.recordId! }
      await db.alertBaselines.put(baseline)
    }
    if (!hits.length) return null
    const eventId = `${site.id}:${snap.recordId}`
    await db.alertDeliveries.add({ eventId, siteId: site.id, observationId: snap.recordId!, sequence,
      pluginRevision, createdAt: Date.now(), balance: snap.balance, currency: snap.currency,
      hits, status: 'pending', attempts: 0, nextAttemptAt: Date.now() })
    return eventId
  })
}

/** Caller provides the surrounding sites/baselines/deliveries transaction. */
export async function invalidateSiteAlertState(before: SiteConfig | undefined, after: SiteConfig): Promise<void> {
  if (!before) return
  const all = before.origin !== after.origin || before.currency !== after.currency || before.enabled !== after.enabled
  const signatures = new Set((after.alerts ?? []).filter((r) => r.enabled).map(ruleSignature))
  await db.alertBaselines.where('siteId').equals(after.id).filter((b) => all || !signatures.has(b.ruleSignature)).delete()
  if (all) after.alertGeneration = (before.alertGeneration ?? 0) + 1
  // Preserve unaffected rules from a pending aggregate; rule changes must not swallow other alerts.
  await db.alertDeliveries.where('siteId').equals(after.id).filter((e) => e.status === 'pending')
    .modify((e) => {
      if (all) { e.status = 'cancelled'; e.lastError = 'rules_changed'; return }
      e.hits = e.hits.filter((h) => signatures.has(h.signature))
      if (!e.hits.length) { e.status = 'cancelled'; e.lastError = 'rules_changed' }
    })
}
export async function resetAllAlertRuntime(): Promise<void> {
  await db.transaction('rw', db.alertBaselines, db.alertDeliveries, async () => {
    await db.alertBaselines.clear()
    await db.alertDeliveries.where('status').equals('pending').modify({ status: 'cancelled', lastError: 'plugin_disabled' })
  })
}
export async function pruneAlertRuntime(now = Date.now()): Promise<void> {
  await db.transaction('rw', db.alertDeliveries, async () => {
    await db.alertDeliveries.where('status').equals('pending').filter((e) => e.createdAt <= now - ALERT_TTL_MS)
      .modify({ status: 'cancelled', lastError: 'expired' })
    await db.alertDeliveries.where('createdAt').below(now - 7 * 86400000).filter((e) => e.status !== 'pending').delete()
    const terminal = await db.alertDeliveries.filter((e) => e.status !== 'pending').sortBy('createdAt')
    if (terminal.length > 1000) await db.alertDeliveries.bulkDelete(terminal.slice(0, terminal.length - 1000).map((e) => e.eventId))
  })
}
