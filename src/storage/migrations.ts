import { db } from './db'

const AUTH_STATE_MIGRATION_KEY = 'aihub.authStateMigrationVersion'
const AUTH_STATE_MIGRATION_VERSION = 1

/**
 * 将没有权威账户证据的历史 auth_expired 降级为可重新检测的 error。
 * 这是逻辑迁移，不改变 IndexedDB schema，也不删除快照、统计和用量记录。
 */
export async function runAuthStateMigration(): Promise<void> {
  const completed = await db.settings.get(AUTH_STATE_MIGRATION_KEY)
  if (completed?.value === AUTH_STATE_MIGRATION_VERSION) return

  await db.transaction('rw', db.sites, db.credentials, db.settings, async () => {
    const done = await db.settings.get(AUTH_STATE_MIGRATION_KEY)
    if (done?.value === AUTH_STATE_MIGRATION_VERSION) return
    const sites = await db.sites.toArray()
    for (const site of sites) {
      if (site.lastStatus !== 'auth_expired') continue
      const evidence = site.lastAuthEvidence
      const verifiedUnauthorized =
        site.lastFailureReason === 'ACCOUNT_UNAUTHORIZED' &&
        evidence?.state === 'unauthorized' &&
        evidence.reason === 'ACCOUNT_UNAUTHORIZED' &&
        evidence.endpointRole === 'account_authority' &&
        evidence.contextComplete === true &&
        (evidence.httpStatus === 401 || evidence.httpStatus === 403)
      if (verifiedUnauthorized) continue

      await db.sites.update(site.id, {
        lastStatus: 'error',
        lastFailureReason: 'AUTH_CONTEXT_INCOMPLETE',
        lastError: '升级后需重新检测站点授权状态',
        lastAuthEvidence: undefined,
      })
      const credential = await db.credentials.get(site.id)
      if (credential) {
        await db.credentials.put({
          ...credential,
          authState: 'unknown',
          updatedAt: Date.now(),
        })
      }
    }
    await db.settings.put({ key: AUTH_STATE_MIGRATION_KEY, value: AUTH_STATE_MIGRATION_VERSION })
  })
}
