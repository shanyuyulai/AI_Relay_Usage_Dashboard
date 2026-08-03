import { db } from './db'
import type { SiteConfig, SettingsRow } from '../shared/types'

// 站点配置仓储（唯一读写入口，UI/采集层不直接碰 Dexie）
export const siteRepo = {
  async list(): Promise<SiteConfig[]> {
    const all = await db.sites.toArray()
    return all.sort((a, b) => a.order - b.order)
  },

  async get(id: string): Promise<SiteConfig | undefined> {
    return db.sites.get(id)
  },

  async add(site: SiteConfig): Promise<void> {
    await db.sites.add(site)
  },

  async update(id: string, patch: Partial<SiteConfig>): Promise<void> {
    await db.sites.update(id, patch)
  },

  /** 删除站点时级联清理其凭证与历史（P0-2 凭证隔离：整站移除即无残留） */
  async remove(id: string): Promise<void> {
    await db.transaction(
      'rw',
      db.sites,
      db.credentials,
      db.snapshots,
      db.dailyStats,
      async () => {
        await db.sites.delete(id)
        await db.credentials.delete(id)
        await db.snapshots.where('siteId').equals(id).delete()
        await db.dailyStats.where('siteId').equals(id).delete()
      },
    )
  },

  async nextOrder(): Promise<number> {
    const all = await db.sites.toArray()
    return all.reduce((m, s) => Math.max(m, s.order), -1) + 1
  },
}

// 设置仓储（轻量 kv）
export const settingsRepo = {
  async get<T>(key: string): Promise<T | undefined> {
    const row = await db.settings.get(key)
    return row?.value as T | undefined
  },
  async set(key: string, value: unknown): Promise<void> {
    await db.settings.put({ key, value } as SettingsRow)
  },
}
