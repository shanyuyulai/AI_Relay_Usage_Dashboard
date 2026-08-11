/**
 * 全量数据备份 / 还原（GPT terra High 评审通过后实现）。
 *
 * 设计要点（对应评审 P0 修复）：
 * - 跨安装身份：导入时源文件 siteId 不可作外键（重装后站点 id 会变）。
 *   先按 origin 匹配/新建站点，建立 sourceSiteId→targetSiteId 映射，
 *   所有关联行（snapshots/diagnostics/dailyStats/usageRecords/captures）一律用映射重写 siteId；
 *   被跳过站点（缺权限/未知适配器）的关联行一并 orphanSkipped。
 * - 幂等键：snapshots/diagnostics 用不可变 recordId（唯一索引）幂等 upsert；
 *   dailyStats/usageRecords 主键含 siteId，按 targetSiteId 重算；
 *   captures 主键为 UUID（跨安装稳定），仅重写 siteId；
 *   usageRecords 内部 records 的 id 基于 origin（跨安装稳定），不重写。
 * - 一致性：导入为单 Dexie 写事务（原子），删除原 10s 看门狗，杜绝超时误判+并发竞态。
 * - 敏感数据：导出仅含 7 类业务表（排除 credentials/usageCache）；每表 DTO allowlist 投影；
 *   settings 仅导入可移植键（排除运行时键 aihub.notifyLastDate / aihub.usage.rev.*）。
 */
import { db } from './db'
import { registry } from '../adapters'
import { normalizeOrigin, isValidSiteUrl } from '../shared/util'
import type {
  SiteConfig,
  Snapshot,
  DailyStat,
  CustomCaptureRecord,
  DiagnosticEntry,
  UsageRecordBatch,
  SettingsRow,
} from '../shared/types'
import type { ExportConfig, ExportTables, ImportResult } from '../core/messaging/protocol'

const COLORS = ['#5B8FF9', '#61DDAA', '#F6BD16', '#7262FD', '#78D3F8', '#F6903D', '#FF9D4D']

// —— 每表 DTO 投影 allowlist（P0-敏感：导出仅含已知字段，杜绝意外字段外泄）——
const SNAPSHOT_KEYS: (keyof Snapshot)[] = [
  'recordId', 'siteId', 'takenAt', 'balance', 'todayTokens', 'todayRequests', 'todayCost',
  'totalRequests', 'totalQuota', 'currency', 'modelUsages', 'status', 'errorKind', 'channel',
  'apiVersion', 'responseHash', 'quality', 'family', 'routeProfile', 'confidence',
  'balanceSource', 'usageSource', 'isPartial', 'collectorVersion', 'cumulativeTokens',
  'cumulativeTokensSource', 'apiRoundTripMs', 'avgResponseTimeMs', 'metricsPartial',
]
const DAILY_KEYS: (keyof DailyStat)[] = [
  'siteId', 'date', 'tokens', 'requests', 'cost', 'currency', 'byModel', 'source',
  'apiRoundTripMs', 'partial', 'updatedAt',
]
const CAPTURE_KEYS: (keyof CustomCaptureRecord)[] = [
  'id', 'siteId', 'url', 'status', 'contentType', 'capturedAt', 'ok', 'json', 'error',
]
const USAGE_BATCH_KEYS: (keyof UsageRecordBatch)[] = [
  'id', 'siteId', 'date', 'collectedAt', 'takenAt', 'records', 'totalTokens', 'recordCount',
  'costByCurrency', 'totalActualCostByCurrency', 'totalStandardCostByCurrency', 'totalRequests',
  'isComplete', 'truncatedReason', 'pageCount', 'schemaVersion', 'source',
]
// diagnostics 为脱敏指纹，无秘密字段；导出保留 recordId、剔除自增 id，其余全留
const DIAGNOSTIC_DROP_KEYS = ['id']

// settings 可移植键：仅导入用户偏好，排除运行时键
function isPortableSetting(key: string): boolean {
  if (key === 'aihub.notifyLastDate') return false
  if (key.startsWith('aihub.usage.rev')) return false
  return (
    key === 'aihub.notifyMode' ||
    key === 'aihub.clickBehavior' ||
    key === 'aihub.theme' ||
    key === 'aihub.retentionDays' ||
    key === 'aihub.collectInterval' ||
    key.startsWith('aihub.lab')
  )
}

function pick<T extends object>(obj: T, keys: (keyof T)[]): Partial<T> {
  const out: Partial<T> = {}
  for (const k of keys) {
    if (k in obj) (out as Record<string, unknown>)[k as string] = (obj as Record<string, unknown>)[k as string]
  }
  return out
}

function pickExcept<T extends object>(obj: T, drop: string[]): T {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(obj)) {
    if (!drop.includes(k)) out[k] = (obj as Record<string, unknown>)[k]
  }
  return out as T
}

function ensureRecordId<T extends { recordId?: string }>(row: T): T {
  if (!row.recordId) row.recordId = crypto.randomUUID()
  return row
}

function emptyDataStats(): Record<string, { written: number; orphanSkipped: number; idRecomputed: number }> {
  return {
    snapshots: { written: 0, orphanSkipped: 0, idRecomputed: 0 },
    diagnostics: { written: 0, orphanSkipped: 0, idRecomputed: 0 },
    dailyStats: { written: 0, orphanSkipped: 0, idRecomputed: 0 },
    usageRecords: { written: 0, orphanSkipped: 0, idRecomputed: 0 },
    captures: { written: 0, orphanSkipped: 0, idRecomputed: 0 },
    settings: { written: 0, orphanSkipped: 0, idRecomputed: 0 },
  }
}

/** 导出全量备份（v2）。单只读事务读取 7 类业务表 + 站点配置，绝不读 credentials/usageCache。 */
export async function exportAll(): Promise<ExportConfig> {
  const data = await db.transaction(
    'r',
    [db.sites, db.snapshots, db.dailyStats, db.captures, db.diagnostics, db.usageRecords, db.settings],
    async () => {
      const [
        sites,
        snapshots,
        dailyStats,
        captures,
        diagnostics,
        usageRecords,
        settings,
      ] = await Promise.all([
        db.sites.toArray(),
        db.snapshots.toArray(),
        db.dailyStats.toArray(),
        db.captures.toArray(),
        db.diagnostics.toArray(),
        db.usageRecords.toArray(),
        db.settings.toArray(),
      ])
      return { sites, snapshots, dailyStats, captures, diagnostics, usageRecords, settings }
    },
  )

  // DTO 投影（剔除自增 id；snapshots/diagnostics 保留并确保 recordId）
  const projSnapshots = (data.snapshots as Snapshot[]).map((s) => {
    const row = pick(s, SNAPSHOT_KEYS) as Snapshot
    ensureRecordId(row)
    return row
  })
  const projDiagnostics = (data.diagnostics as DiagnosticEntry[]).map((d) => {
    const row = pickExcept(d, DIAGNOSTIC_DROP_KEYS) as DiagnosticEntry
    ensureRecordId(row)
    return row
  })
  const projDaily = (data.dailyStats as DailyStat[]).map((d) => pick(d, DAILY_KEYS) as DailyStat)
  const projCaptures = (data.captures as CustomCaptureRecord[]).map((c) => pick(c, CAPTURE_KEYS) as CustomCaptureRecord)
  const projUsage = (data.usageRecords as UsageRecordBatch[]).map((b) => pick(b, USAGE_BATCH_KEYS) as UsageRecordBatch)

  const tables: ExportTables = {
    snapshots: projSnapshots,
    dailyStats: projDaily,
    captures: projCaptures,
    diagnostics: projDiagnostics,
    usageRecords: projUsage,
    settings: (data.settings as SettingsRow[]).map((s) => ({ key: s.key, value: s.value })),
  }

  const manifest = chrome.runtime.getManifest()
  const config: ExportConfig = {
    version: 2,
    exportedAt: Date.now(),
    appVersion: manifest?.version,
    schemaVersion: db.verno,
    sites: data.sites.map((s) => ({ ...s })),
    tables,
  }
  return config
}

/**
 * 导入全量备份。
 * 阶段 A：校验 + 逐站匹配/新建（建立 sourceSiteId→targetSiteId 映射），缺权限/未知适配器的站点跳过。
 * 阶段 B：单写事务按映射重写关联行 siteId，snapshots/diagnostics 按 recordId 幂等，dailyStats/usageRecords 重算主键，
 *         captures/usageRecords 内部记录稳定，settings 仅合并可移植键。
 */
export async function importAll(config: ExportConfig): Promise<ImportResult> {
  const stats = emptyDataStats()
  const skipped: { name: string; reason: string }[] = []
  const skippedByReason: Record<string, number> = {}
  const bumpSkip = (name: string, reason: string) => {
    skipped.push({ name, reason })
    skippedByReason[reason] = (skippedByReason[reason] ?? 0) + 1
  }

  if (config.version !== 1 && config.version !== 2) {
    return {
      imported: 0,
      updated: 0,
      skipped,
      skippedByReason,
      data: stats,
      operationId: crypto.randomUUID(),
      fatalError: `不支持的备份版本 v${config.version}（仅支持 v1/v2）`,
    }
  }

  const sites = config.sites ?? []
  let imported = 0
  let updated = 0
  // sourceSiteId -> targetSiteId
  const idMap = new Map<string, string>()
  const siteWrites: SiteConfig[] = []

  // —— 阶段 A：站点匹配/新建 + 权限校验 ——
  const existing = await db.sites.toArray()
  const byOrigin = new Map(existing.map((s) => [s.origin, s]))
  let nextOrder = existing.reduce((max, site) => Math.max(max, site.order), -1) + 1
  for (const s of sites) {
    const name = s.name || normalizeOrigin(s.baseUrl)
    try {
      if (!s.baseUrl) {
        bumpSkip(name, '站点缺少 baseUrl')
        continue
      }
      // P0 修复（评审驳回项）：导入落库前显式协议白名单，拒绝 javascript:/data:/file: 等危险 scheme
      if (!isValidSiteUrl(s.baseUrl)) {
        bumpSkip(name, '站点地址协议不支持（仅 http/https）')
        continue
      }
      if (!registry.has(s.adapter)) {
        bumpSkip(name, '未知适配器类型')
        continue
      }
      const origin = normalizeOrigin(s.baseUrl)
      const granted = await chrome.permissions.contains({ origins: [`${origin}/*`] })
      if (!granted) {
        bumpSkip(name, '缺少 host 权限（请在导入前允许该域名）')
        continue
      }
      const found = byOrigin.get(origin)
      if (found) {
        const site: SiteConfig = {
          ...found,
          name: s.name || found.name,
          baseUrl: s.baseUrl,
          origin,
          adapter: s.adapter,
          color: s.color || found.color,
          enabled: s.enabled ?? found.enabled,
          currency: s.currency || found.currency || 'USD',
          lastStatus: 'unknown',
          lastCollectAt: null,
        }
        siteWrites.push(site)
        byOrigin.set(origin, site)
        idMap.set(s.id, found.id)
        updated += 1
      } else {
        const site: SiteConfig = {
          id: crypto.randomUUID(),
          name: s.name || origin,
          baseUrl: s.baseUrl,
          origin,
          adapter: s.adapter,
          color: s.color || COLORS[Math.floor(Math.random() * COLORS.length)],
          enabled: s.enabled ?? true,
          order: nextOrder++,
          createdAt: Date.now(),
          lastCollectAt: null,
          lastStatus: 'unknown',
          currency: s.currency || 'USD',
        }
        siteWrites.push(site)
        byOrigin.set(origin, site)
        idMap.set(s.id, site.id)
        imported += 1
      }
    } catch (e) {
      bumpSkip(name, '站点校验失败：' + (e instanceof Error ? e.message : String(e)).slice(0, 60))
    }
  }

  // —— 阶段 B：单写事务写入站点、授权状态与关联数据 ——
  const tables = config.tables
  await db.transaction(
      'rw',
      [db.sites, db.credentials, db.snapshots, db.dailyStats, db.captures, db.diagnostics, db.usageRecords, db.settings],
      async () => {
        const credentialUpdatedAt = Date.now()
        for (const site of siteWrites) {
          await db.sites.put(site)
          await db.credentials.put({
            siteId: site.id,
            method: 'cookie',
            authorized: false,
            updatedAt: credentialUpdatedAt,
          })
        }
        if (!tables || config.version !== 2) return
        // snapshots：按 recordId 幂等；siteId 重写
        for (const raw of tables.snapshots) {
          const target = idMap.get(raw.siteId)
          if (!target) {
            stats.snapshots.orphanSkipped += 1
            continue
          }
          const row = pick(raw, SNAPSHOT_KEYS) as Snapshot
          row.siteId = target
          ensureRecordId(row)
          delete (row as Partial<Snapshot>).id
          const existingRow = await db.snapshots.where('recordId').equals(row.recordId!).first()
          if (existingRow?.id != null) row.id = existingRow.id
          await db.snapshots.put(row)
          stats.snapshots.written += 1
        }
        // diagnostics：按 recordId 幂等；siteId 重写
        for (const raw of tables.diagnostics) {
          const target = idMap.get(raw.siteId)
          if (!target) {
            stats.diagnostics.orphanSkipped += 1
            continue
          }
          const row = pickExcept(raw, DIAGNOSTIC_DROP_KEYS) as DiagnosticEntry
          row.siteId = target
          ensureRecordId(row)
          const existingRow = await db.diagnostics.where('recordId').equals(row.recordId!).first()
          if (existingRow?.id != null) row.id = existingRow.id
          await db.diagnostics.put(row)
          stats.diagnostics.written += 1
        }
        // dailyStats：主键 ${siteId}@${date} 重算
        for (const raw of tables.dailyStats) {
          const target = idMap.get(raw.siteId)
          if (!target) {
            stats.dailyStats.orphanSkipped += 1
            continue
          }
          const row = pick(raw, DAILY_KEYS) as DailyStat
          row.siteId = target
          row.id = `${target}@${row.date}`
          await db.dailyStats.put(row)
          stats.dailyStats.written += 1
          stats.dailyStats.idRecomputed += 1
        }
        // usageRecords：主键 ${siteId}:${date} 重算（内部 records 的 id 基于 origin，稳定不重写）
        for (const raw of tables.usageRecords) {
          const target = idMap.get(raw.siteId)
          if (!target) {
            stats.usageRecords.orphanSkipped += 1
            continue
          }
          const row = pick(raw, USAGE_BATCH_KEYS) as UsageRecordBatch
          row.siteId = target
          row.id = `${target}:${row.date}`
          await db.usageRecords.put(row)
          stats.usageRecords.written += 1
          stats.usageRecords.idRecomputed += 1
        }
        // captures：主键 UUID 稳定，仅重写 siteId
        for (const raw of tables.captures) {
          const target = idMap.get(raw.siteId)
          if (!target) {
            stats.captures.orphanSkipped += 1
            continue
          }
          const row = pick(raw, CAPTURE_KEYS) as CustomCaptureRecord
          row.siteId = target
          await db.captures.put(row)
          stats.captures.written += 1
        }
        // settings：仅合并可移植键（不删除现有非可移植键）
        for (const setting of tables.settings) {
          if (!isPortableSetting(setting.key)) {
            stats.settings.orphanSkipped += 1
            continue
          }
          await db.settings.put({ key: setting.key, value: setting.value })
          stats.settings.written += 1
        }
      },
    )

  return {
    imported,
    updated,
    skipped,
    skippedByReason,
    data: stats,
    operationId: crypto.randomUUID(),
  }
}
