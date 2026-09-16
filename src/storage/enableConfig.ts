import { db } from './db'

// Installation-local runtime state: deliberately excluded from PORTABLE_SETTING_KEYS.
export const PLUGIN_ENABLED_KEY = 'aihub.pluginEnabled'
export const PLUGIN_REVISION_KEY = 'aihub.pluginRevision'

export function parsePluginEnabled(raw: unknown): boolean {
  if (raw === undefined) return true
  if (typeof raw !== 'boolean') throw new Error('插件开关状态损坏，请显式选择启用或停用以恢复')
  return raw
}
export function validatePluginEnabled(raw: unknown): boolean {
  if (typeof raw !== 'boolean') {
    throw Object.assign(new Error('enabled 必须是布尔值'), { kind: 'VALIDATION_ERROR' })
  }
  return raw
}
export async function readPluginConfig(): Promise<{ enabled: boolean; revision: number }> {
  return db.transaction('r', db.settings, async () => {
    const enabled = parsePluginEnabled((await db.settings.get(PLUGIN_ENABLED_KEY))?.value)
    const revision = (await db.settings.get(PLUGIN_REVISION_KEY))?.value
    return { enabled, revision: typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0 ? revision : 0 }
  })
}
export async function writePluginEnabled(raw: unknown): Promise<{ enabled: boolean; revision: number }> {
  const enabled = validatePluginEnabled(raw)
  return db.transaction('rw', db.settings, async () => {
    const previous = (await db.settings.get(PLUGIN_REVISION_KEY))?.value
    const revision = typeof previous === 'number' && Number.isSafeInteger(previous) && previous >= 0 ? previous + 1 : 1
    await db.settings.bulkPut([
      { key: PLUGIN_ENABLED_KEY, value: enabled },
      { key: PLUGIN_REVISION_KEY, value: revision },
    ])
    return { enabled, revision }
  })
}
/** For shared notification code in any extension context. Unknown always denies. */
export async function isPluginConfiguredEnabled(): Promise<boolean> {
  try { return (await readPluginConfig()).enabled } catch { return false }
}
