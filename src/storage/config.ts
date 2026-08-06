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
    await db.transaction('rw', db.usageRecords, db.usageCache, async () => {
      await db.usageRecords.where('siteId').equals(id).delete()
      await db.usageCache.where('siteId').equals(id).delete()
    })
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

/**
 * 假名化模型（信任边界，GPT P0-MAIN-WORLD-KEY）：
 *
 * 页面 MAIN 世界是**不可信**的执行上下文——站点脚本可在注入前劫持 `crypto.subtle`、
 * `TextEncoder` 等页面全局。因此**任何扩展持久化秘密都不得作为 `executeScript` 入参
 * 传入 MAIN 世界**，否则会被同值哈希链截获、进而对本地数据做离线字典攻击。
 *
 * 故本扩展的假名化在 MAIN 世界内以**无密钥标准 SHA-256** 完成，命名空间仅用页面自身
 * `origin`（非秘密、页面本就可知），既按站点隔离、又绝不把扩展密钥暴露给页面。
 * 代价：低熵字段（短 token id / IP）在本地库可被枚举——这是已接受的隐私权衡
 * （原始明文始终不落库、不回传 SW）。若未来需要本地不可枚举，应在 SW 侧对「已哈希值」
 * 二次加秘密盐，而非把盐下发到页面。
 */
