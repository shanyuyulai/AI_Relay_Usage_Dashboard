/**
 * 采集诊断日志仓库。
 *
 * 每次采集自动写入结构化条目（脱敏指纹，P0-1/P0-4 安全边界），
 * 用于排查「某字段为何为 null」。
 *
 * 保留策略：默认保留最近 7 天，超出自动清理（与 snapshots/dailyStats 共用 retention）。
 */
import { db } from './db'
import type { DiagnosticEntry } from '../shared/types'

class DiagnosticsRepo {
  /** 写入一条诊断日志。 */
  async put(entry: Omit<DiagnosticEntry, 'id'>): Promise<void> {
    await db.diagnostics.add(entry as DiagnosticEntry)
  }

  /** 按站点查询（倒序，最新的在前）。 */
  async listBySite(siteId: string, limit = 200): Promise<DiagnosticEntry[]> {
    return db.diagnostics.where('siteId').equals(siteId).reverse().sortBy('at').then((arr) => arr.slice(0, limit))
  }

  /** 查询全部（倒序）。 */
  async listAll(limit = 500): Promise<DiagnosticEntry[]> {
    return db.diagnostics.orderBy('at').reverse().limit(limit).toArray()
  }

  /** 按站点清理。 */
  async clearBySite(siteId: string): Promise<void> {
    await db.diagnostics.where('siteId').equals(siteId).delete()
  }

  /** 清理早于指定时间戳的条目。 */
  async clearOlderThan(ms: number): Promise<void> {
    await db.diagnostics.where('at').below(ms).delete()
  }

  /** 统计某站点的日志条数。 */
  async countBySite(siteId: string): Promise<number> {
    return db.diagnostics.where('siteId').equals(siteId).count()
  }
}

export const diagnosticsRepo = new DiagnosticsRepo()
