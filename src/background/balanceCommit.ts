import { commitAlertObservation } from '../storage/alerts'
import { balanceContext } from '../shared/alertRules'
import { flushBalanceAlerts } from './alerts'
import { getPluginState } from './pluginGate'
import type { SiteConfig, Snapshot } from '../shared/types'

/** Explicit real-collection boundary. Backup import NEVER invokes this function. */
export async function commitBalanceSnapshot(site: SiteConfig, snap: Snapshot, revision: number, units?: unknown): Promise<void> {
  if (getPluginState().effectiveState !== 'enabled') return
  // Collection observation and outbox are one transaction; notification is outside it.
  const event = await commitAlertObservation(site, snap, balanceContext(site, snap, units), revision)
  if (event) {
    try { await flushBalanceAlerts() }
    catch { console.warn('[AI Relay] 警报暂未投递，等待下次恢复') }
  }
}
