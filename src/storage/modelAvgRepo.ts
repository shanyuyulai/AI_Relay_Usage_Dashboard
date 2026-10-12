/**
 * 模型均价档案 / 历史仓储（方案 050）。
 * - 档案：每站每模型一行（merge 语义，主键 `${siteId}|${model}`）。
 * - 历史：价格变动追加写；按站裁剪最近 MODEL_AVG_HISTORY_KEEP 条，防无限膨胀。
 * - 内容为聚合值 + 脱敏原始记录投影，绝不落凭证（P0-2/P1-1）。
 */
import { db } from './db'
import type { ModelAvgPrice, ModelAvgHistory } from '../shared/types'

/** 每站历史保留上限（超过裁掉最旧的）。 */
export const MODEL_AVG_HISTORY_KEEP = 500

export const modelAvgRepo = {
  /** 某站全量档案。 */
  async listBySite(siteId: string): Promise<ModelAvgPrice[]> {
    return db.modelAvgPrices.where('siteId').equals(siteId).toArray()
  },

  /** 批量写档案（仅内容有变化的行）。 */
  async putMany(rows: ModelAvgPrice[]): Promise<void> {
    if (!rows.length) return
    await db.modelAvgPrices.bulkPut(rows)
  },

  /** 追加历史并按站裁剪（单写事务，原子）。 */
  async addHistory(rows: ModelAvgHistory[]): Promise<void> {
    if (!rows.length) return
    await db.transaction('rw', db.modelAvgHistory, async () => {
      await db.modelAvgHistory.bulkAdd(rows)
      for (const siteId of new Set(rows.map((r) => r.siteId))) {
        const all = await db.modelAvgHistory.where('siteId').equals(siteId).toArray()
        if (all.length <= MODEL_AVG_HISTORY_KEEP) continue
        all.sort((a, b) => b.computedAt - a.computedAt)
        const stale = all.slice(MODEL_AVG_HISTORY_KEEP).map((r) => r.id!).filter((id) => id != null)
        await db.modelAvgHistory.bulkDelete(stale)
      }
    })
  },

  /** 某站历史（computedAt 倒序；model 缺省=全站，limit 默认 300）。 */
  async listHistory(siteId: string, model?: string, limit = 300): Promise<ModelAvgHistory[]> {
    const base = model
      ? db.modelAvgHistory.where('[siteId+model]').equals([siteId, model])
      : db.modelAvgHistory.where('siteId').equals(siteId)
    const rows = await base.toArray()
    rows.sort((a, b) => b.computedAt - a.computedAt)
    return rows.slice(0, limit)
  },

  /** 某站某模型档案（「数据来源」弹窗懒加载）。 */
  async get(siteId: string, model: string): Promise<ModelAvgPrice | undefined> {
    return db.modelAvgPrices.get(`${siteId}|${model}`)
  },

  /** 删除站点时级联清理（DELETE_SITE 调用）。 */
  async clearSite(siteId: string): Promise<void> {
    await db.transaction('rw', [db.modelAvgPrices, db.modelAvgHistory], async () => {
      await db.modelAvgPrices.where('siteId').equals(siteId).delete()
      await db.modelAvgHistory.where('siteId').equals(siteId).delete()
    })
  },
}
