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

  /**
   * 手动排序：把整列站点按给定 id 顺序归一化为 order=0..n-1。
   * GPT P0-1 修正：必须传入**当前全部站点的完整排列**，仅做 `update(id,{order})`，
   * 绝不整体 `put`（避免覆盖 discovered/lastStatus/凭证等内部字段）。
   * 事务内做最后一道防御校验：大小一致 / 无重复 / 无未知 id；不通过则整体回滚并返回错误码。
   * 与 ADD_SITE.nextOrder 收进同一 Dexie 事务边界，避免并发产生重复 order（GPT P1-2）。
   */
  async reorder(orderedIds: string[]): Promise<{ ok: boolean; code?: string }> {
    return db.transaction('rw', db.sites, async () => {
      const all = await db.sites.toArray()
      const dbIds = new Set(all.map((s) => s.id))
      const input = Array.isArray(orderedIds) ? orderedIds : []
      const seen = new Set<string>()
      for (const id of input) {
        if (typeof id !== 'string' || id.length === 0) return { ok: false, code: 'INVALID_SITE_ORDER' }
        if (seen.has(id)) return { ok: false, code: 'INVALID_SITE_ORDER' }
        seen.add(id)
        if (!dbIds.has(id)) return { ok: false, code: 'INVALID_SITE_ORDER' }
      }
      if (dbIds.size !== input.length) return { ok: false, code: 'INVALID_SITE_ORDER' }
      let i = 0
      for (const id of input) {
        await db.sites.update(id, { order: i })
        i++
      }
      return { ok: true }
    })
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
