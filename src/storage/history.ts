import { db } from './db'
import type { Snapshot, DailyStat } from '../shared/types'
import { dateKey } from '../shared/util'

// 原始快照仓储
export const snapshotRepo = {
  async append(snap: Snapshot): Promise<number> {
    return db.snapshots.add(snap)
  },

  /** 取某站最近 limit 条（新→旧） */
  async latest(siteId: string, limit = 1): Promise<Snapshot[]> {
    const rows = await db.snapshots.where('siteId').equals(siteId).sortBy('takenAt')
    return rows.slice(-limit).reverse()
  },

  async range(siteId: string, fromTs: number, toTs: number): Promise<Snapshot[]> {
    return db.snapshots
      .where('siteId')
      .equals(siteId)
      .filter((s) => s.takenAt >= fromTs && s.takenAt <= toTs)
      .toArray()
  },

  /** 取某站全部原始快照（新→旧），供数据查看器浏览。过期清理交给 retention.purgeOlderThan。 */
  async allBySite(siteId: string): Promise<Snapshot[]> {
    const rows = await db.snapshots.where('siteId').equals(siteId).sortBy('takenAt')
    return rows.reverse()
  },

  /** 取全部快照（新→旧），供「全部站点」聚合查看。 */
  async all(): Promise<Snapshot[]> {
    const rows = await db.snapshots.orderBy('takenAt').toArray()
    return rows.reverse()
  },
}

// 按日聚合仓储：仅来自精确 usage 日志（P0-3，禁余额差分）；保留策略见 retention.purgeOlderThan
export const dailyStatRepo = {
  /**
   * 由快照「当日累计用量」写入/更新某日聚合。
   * 仅当快照含精确来源（todayTokens != null）才落表；否则不落（UI 显 unknown）。
   */
  async upsertForDay(snap: Snapshot): Promise<void> {
    if (snap.todayTokens == null) return

    const date = dateKey(snap.takenAt)
    const id = `${snap.siteId}@${date}`
    const existing = await db.dailyStats.get(id)

    const byModel: Record<string, { tokens: number; cost: number }> = {}
    for (const m of snap.modelUsages) {
      byModel[m.model] = { tokens: (byModel[m.model]?.tokens ?? 0) + m.tokens, cost: (byModel[m.model]?.cost ?? 0) + m.cost }
    }

    // 同一站点并发写入由上层 perSiteLock 串行保证；此处取当日累计最大值（单调）
    const next: DailyStat = {
      id,
      siteId: snap.siteId,
      date,
      tokens: Math.max(existing?.tokens ?? 0, snap.todayTokens),
      requests: Math.max(existing?.requests ?? 0, snap.todayRequests ?? 0),
      cost: Math.max(existing?.cost ?? 0, snap.todayCost != null ? snap.todayCost : sumCost(snap.modelUsages)),
      currency: snap.currency ?? existing?.currency ?? null,
      byModel, // 最新快照的当日累计分解，直接覆盖（避免重复累加）
      source: 'logs',
      // A0：往返耗时采样（不以 null 覆盖已有有效值，P0-4 合并语义）
      apiRoundTripMs: snap.apiRoundTripMs != null ? snap.apiRoundTripMs : existing?.apiRoundTripMs,
      // 当日数据是否不完整（分页超限/部分字段缺失）；仅当本次明确 partial 才置 true
      partial: snap.isPartial === true ? true : existing?.partial,
      updatedAt: Date.now(),
    }
    await db.dailyStats.put(next)
  },

  async range(siteId: string, fromDate: string, toDate: string): Promise<DailyStat[]> {
    return db.dailyStats
      .where('siteId')
      .equals(siteId)
      .filter((d) => d.date >= fromDate && d.date <= toDate)
      .sortBy('date')
  },

  /** 取某站全部每日聚合（旧→新），供数据查看器浏览。 */
  async allBySite(siteId: string): Promise<DailyStat[]> {
    return db.dailyStats.where('siteId').equals(siteId).sortBy('date')
  },

  /** 取全部每日聚合（旧→新），供「全部站点」聚合查看。 */
  async all(): Promise<DailyStat[]> {
    return db.dailyStats.orderBy('date').toArray()
  },
}

function sumCost(usages: { cost: number }[]): number {
  return usages.reduce((s, u) => s + (u.cost || 0), 0)
}
