import { db } from './db'
import type { UsageRecordBatch } from '../shared/types'

/**
 * 当日用量明细批次的读写层。
 * - putBatch：写入单站单日批次。完整批次优先于不完整批次（P1：防覆盖丢失完整数据）。
 * - getBySiteDate / getBySiteRange：按站点 + 业务日查询，供详情页画图。
 * - clearBySite / clearOlderThan：配合 retention 统一清理（不删站点配置/凭证）。
 */
export const usageRecordsRepo = {
  async putBatch(batch: UsageRecordBatch): Promise<void> {
    // 完整优先：若已有一份完整批次，本次不完整则跳过覆盖（保留完整数据）。
    const prev = await db.usageRecords.get(batch.id)
    if (prev && prev.isComplete && !batch.isComplete) return
    await db.usageRecords.put(batch)
  },

  async getBySiteDate(siteId: string, date: string): Promise<UsageRecordBatch | null> {
    return (await db.usageRecords.get(`${siteId}:${date}`)) ?? null
  },

  async getLatest(siteId: string): Promise<UsageRecordBatch | null> {
    const list = await db.usageRecords.where('siteId').equals(siteId).sortBy('takenAt')
    return list.length ? list[list.length - 1] : null
  },

  async getBySiteRange(siteId: string, fromDate: string, toDate: string): Promise<UsageRecordBatch[]> {
    return db.usageRecords.where('siteId').equals(siteId).filter((b) => b.date >= fromDate && b.date <= toDate).toArray()
  },

  async clearBySite(siteId: string): Promise<void> {
    await db.usageRecords.where('siteId').equals(siteId).delete()
  },

  async clearOlderThan(ms: number): Promise<void> {
    await db.usageRecords.where('takenAt').below(ms).delete()
  },
}
