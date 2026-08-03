import { db } from './db'
import { settingsRepo } from './config'
import { dateKey } from '../shared/util'

/**
 * 采集数据保留策略。
 *
 * 设计：存期内「全量保留」（不降采样，每次采集都留原始快照）；超过保留天数则自动清理。
 * 默认 30 天（"默认保存最多 1 个月"）。days<=0 表示「永久保存」（unlimitedStorage 已放开配额）。
 *
 * 注意 Dexie/IndexedDB 不受 chrome.storage.local 10MB 限制；unlimitedStorage 权限下基本等于磁盘有多大存多大。
 */

export const RETENTION_KEY = 'aihub.retentionDays'
export const DEFAULT_RETENTION_DAYS = 30

/** 读取保留天数（默认 30，0 或负数表示永久）。 */
export async function getRetentionDays(): Promise<number> {
  const raw = await settingsRepo.get<number>(RETENTION_KEY)
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_RETENTION_DAYS
  return raw
}

/** 写入保留天数（裁剪到合理范围：0~365）。 */
export async function setRetentionDays(days: number): Promise<void> {
  const safe = Math.max(0, Math.min(365, Math.floor(days)))
  await settingsRepo.set(RETENTION_KEY, safe)
}

export interface PurgeCounts {
  snapshots: number
  dailyStats: number
  captures: number
  diagnostics: number
  usageRecords: number
}

/**
 * 清理超过保留天数的数据（五表统一 cutoff）。
 * - days<=0：永久保存，跳过清理（返回全 0）。
 * - snapshots/captures/diagnostics/usageRecords：按时间戳 ms（takenAt/capturedAt/at）below cutoff。
 * - dailyStats：按 date 字符串（YYYY-MM-DD，字典序即时间序）below cutoffDate。
 * 仅删采集数据，不动站点配置 / 凭证 / 设置（红线：配置隔离）。
 */
export async function purgeOlderThan(days: number): Promise<PurgeCounts> {
  if (days <= 0) return { snapshots: 0, dailyStats: 0, captures: 0, diagnostics: 0, usageRecords: 0 }

  const cutoffTs = Date.now() - days * 86_400_000
  const cutoffDate = dateKey(cutoffTs)

  try {
    const [snapshots, dailyStats, captures, diagnostics, usageRecords] = await Promise.all([
      db.snapshots.where('takenAt').below(cutoffTs).delete(),
      db.dailyStats.where('date').below(cutoffDate).delete(),
      db.captures.where('capturedAt').below(cutoffTs).delete(),
      db.diagnostics.where('at').below(cutoffTs).delete(),
      db.usageRecords.where('takenAt').below(cutoffTs).delete(),
    ])
    return { snapshots, dailyStats, captures, diagnostics, usageRecords }
  } catch (e) {
    console.warn('[AI Relay] purge failed', e)
    return { snapshots: 0, dailyStats: 0, captures: 0, diagnostics: 0, usageRecords: 0 }
  }
}
