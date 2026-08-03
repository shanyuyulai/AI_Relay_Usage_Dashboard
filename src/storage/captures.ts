import { db } from './db'
import type { CustomCaptureRecord } from '../shared/types'

/**
 * 自定义采集请求捕获仓储。
 * 与余额快照快照（snapshotRepo）完全隔离：自定义请求失败不影响主链路采集。
 * 仅持久化用户主动采集、本人会话返回的 JSON 响应，绝不保存凭证（红线 P0-2）。
 */
export const captureRepo = {
  async put(rec: CustomCaptureRecord): Promise<void> {
    await db.captures.put(rec)
  },

  /** 取某站全部捕获（新→旧）。 */
  async listBySite(siteId: string): Promise<CustomCaptureRecord[]> {
    const rows = await db.captures.where('siteId').equals(siteId).sortBy('capturedAt')
    return rows.reverse()
  },

  /** 取全部捕获（新→旧），供「全部站点」聚合查看。 */
  async listAll(): Promise<CustomCaptureRecord[]> {
    const rows = await db.captures.orderBy('capturedAt').toArray()
    return rows.reverse()
  },

  /** 清空某站全部捕获。 */
  async clearBySite(siteId: string): Promise<void> {
    await db.captures.where('siteId').equals(siteId).delete()
  },

  /** 清空全部捕获（含留存风险，仅手动触发）。 */
  async clearAll(): Promise<void> {
    await db.captures.clear()
  },
}
