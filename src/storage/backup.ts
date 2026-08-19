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
import { parseRechargeRate } from '../shared/recharge'

const COLORS = ['#5B8FF9', '#61DDAA', '#F6BD16', '#7262FD', '#78D3F8', '#F6903D', '#FF9D4D']

// —— 每表 DTO 投影 allowlist（P0-敏感：导出仅含已知字段，杜绝意外字段外泄）——
const SNAPSHOT_KEYS: (keyof Snapshot)[] = [
  'recordId', 'siteId', 'takenAt', 'balance', 'todayTokens', 'todayRequests', 'todayCost',
  'totalRequests', 'totalQuota', 'currency', 'modelUsages', 'status', 'errorKind', 'channel',
  'apiVersion', 'responseHash', 'quality', 'family', 'routeProfile', 'confidence',
  'balanceSource', 'usageSource', 'isPartial', 'collectorVersion', 'cumulativeTokens',
  'cumulativeTokensSource', 'apiRoundTripMs', 'avgResponseTimeMs', 'metricsPartial',
  // 统计接口 + IKunCode provider 采集字段（方案 §2/§7）
  'cumulativeInputTokens', 'cumulativeOutputTokens', 'totalConsumedCost', 'recent24hCost',
  'recent24hTokens', 'usageWindow', 'todayCostSource', 'usageStatsSource',
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

// —— 站点导出字段白名单（P0-1/P0-2：绝不整条 SiteConfig 原样导出，只导出用户配置 + 必要展示字段）——
// 评审终审收紧：剔除纯运行时/诊断字段（lastCollectAt/lastStatus/lastError/lastFailureReason/
// lastAuthEvidence/lastCollectRunId），这些字段在导入后会被重置（lastCollectAt=null, lastStatus='unknown'），
// 且 lastError/lastAuthEvidence 可能携带诊断信息，不应随备份外泄。
const SITE_KEYS: (keyof SiteConfig)[] = [
  'id', 'name', 'baseUrl', 'origin', 'adapter', 'color', 'enabled', 'order',
  'createdAt', 'currency', 'discovered', 'customRequests',
  'rechargeRate',
]
// 递归扫描禁止的敏感字段名（仅查字段名，不查值，避免 URL 等正常内容误报）
const FORBIDDEN_KEY = /^(cookie|token|authorization|session|password|secret|apikey|api_key|accesstoken|refreshtoken)$/i
// 例外：这些字段名允许在备份里出现，扫描器跳过它们（值仍可能为 PII，但已超出本扫描器职责）。
// - json：CustomCaptureRecord.json 是用户主动采集的 API 响应 JSON，可能含合法字段名（session/token），
//   反复扫描会误报导致导出失败；用户对自己采集的数据负责。
// - fieldFingerprint：DiagnosticEntry 脱敏指纹，按设计只存字段路径+类型，绝不存值（P0-1/P0-4），
//   其 key 是用户站点的 JSON 顶层字段名，本身可能是 session/token 等；扫描器看到 key 即抛错是误报。
const SKIP_SUBTREE_KEYS = new Set(['json', 'fieldFingerprint'])
function assertNoForbiddenKeys(value: unknown, path = ''): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoForbiddenKeys(v, `${path}[${i}]`))
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SKIP_SUBTREE_KEYS.has(k)) continue
      if (FORBIDDEN_KEY.test(k)) {
        throw new Error(`备份导出拒绝：含可疑敏感字段名 "${k}" @ ${path || 'root'}`)
      }
      assertNoForbiddenKeys(v, path ? `${path}.${k}` : k)
    }
  }
}

// 站点排序键（P0-3）：缺失/NaN 置末尾，保证稳定
function orderKey(s: { order?: number }): number {
  return typeof s.order === 'number' && Number.isFinite(s.order) ? s.order : Number.MAX_SAFE_INTEGER
}
// 导入前对备份站点做稳定排序（不改原对象 order 字段值，仅重排数组）；同值以原数组索引作次关键字
export function sortSitesByOrder(sites: SiteConfig[]): SiteConfig[] {
  return sites
    .map((s, i) => ({ s, i }))
    .sort((a, b) => orderKey(a.s) - orderKey(b.s) || a.i - b.i)
    .map((x) => x.s)
}

// settings 可移植键：严格固定白名单（P0-3 终审修正：杜绝前缀通配，未来新增键必须显式加入）。
// 仅导入用户偏好；排除运行时键（aihub.notifyLastDate / aihub.usage.rev.* 不在集合内，自然被拒）。
const PORTABLE_SETTING_KEYS = new Set<string>([
  'aihub.notifyMode',
  'aihub.clickBehavior',
  'aihub.theme',
  'aihub.retentionDays',
  'aihub.collectInterval',
  'aihub.calcRealCost',
  'aihub.showTodayCostInPopup',
  // 实验室开关（均为用户偏好布尔，无敏感值）
  'aihub.lab.zeroTab',
  'aihub.lab.corsUnblock',
  'aihub.lab.showDashboard',
])
function isPortableSetting(key: string): boolean {
  return PORTABLE_SETTING_KEYS.has(key)
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
    settings: (data.settings as SettingsRow[])
      .filter((s) => isPortableSetting(s.key))
      .map((s) => ({ key: s.key, value: s.value })),
  }

  const manifest = chrome.runtime.getManifest()
  const config: ExportConfig = {
    version: 2,
    exportedAt: Date.now(),
    appVersion: manifest?.version,
    schemaVersion: db.verno,
    sites: [...(data.sites as SiteConfig[])]
      .sort((a, b) => orderKey(a) - orderKey(b))
      .map((s) => {
        const picked = pick(s, SITE_KEYS) as SiteConfig
        assertNoForbiddenKeys(picked)
        return picked
      }),
    tables,
  }
  // 主题（明暗）存于 chrome.storage.local，独立于 db.settings，单独读入顶层字段
  try {
    const themeRes = await chrome.storage.local.get('aihub.theme')
    const t = themeRes['aihub.theme']
    if (t === 'light' || t === 'dark' || t === 'auto') config.theme = t
  } catch {
    /* 主题读取失败不影响其余备份 */
  }
  // P0-1 终检：整包不得含禁止字段名
  assertNoForbiddenKeys(config)
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

  const sites = sortSitesByOrder(config.sites ?? [])
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
      // P0-1 导入侧：拒绝含可疑敏感字段名的恶意站点对象（与导出终检同一扫描器）
      assertNoForbiddenKeys(s)
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
      // 导入侧：仅按 SITE_KEYS 投影（P0-1 双向白名单），非白名单字段一律丢弃；rechargeRate 复用严格校验
      const pickSite = pick(s, SITE_KEYS) as Partial<SiteConfig>
      if (pickSite.rechargeRate != null && parseRechargeRate(pickSite.rechargeRate) == null) {
        pickSite.rechargeRate = undefined
      }
      if (found) {
        const site: SiteConfig = {
          ...found,
          ...pickSite,
          id: found.id,
          order: found.order,
          createdAt: found.createdAt,
          origin,
          baseUrl: s.baseUrl,
          adapter: s.adapter,
          currency: s.currency || found.currency || 'USD',
          color: s.color || found.color,
          enabled: s.enabled ?? found.enabled,
          lastStatus: 'unknown',
          lastCollectAt: null,
        }
        siteWrites.push(site)
        byOrigin.set(origin, site)
        idMap.set(s.id, found.id)
        updated += 1
      } else {
        const site: SiteConfig = {
          ...pickSite,
          // P0-1 终审修正：必须先展开 pickSite（可能含旧备份 id），再用全新 UUID 覆盖，
          // 否则会复用备份中的旧站点 id，破坏跨安装身份隔离（旧 id 可能与本机既有站点主键冲突）。
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

  // —— order 归一化（GPT P0-3 修正）——
  // 导入语义为「合并」：已有站点保留各自本地相对序（found.order），新站点按导入顺序追加（nextOrder++）。
  // 导出的 order 视为不可信、一律不采用，避免跨安装 id 漂移 + 重复 order 造成排序错乱。
  // 写库后统一归一化为 0..n-1 连续序列：消除空隙/重复，保证 siteRepo.list() 稳定有序。
  // 按 order 升序后重排，自然得到"本地站点相对序在前、新站点按导入序在后"的结果。
  await db.transaction('rw', db.sites, async () => {
    const all = await db.sites.toArray()
    all.sort((a, b) => a.order - b.order)
    let i = 0
    for (const s of all) {
      if (s.order !== i) await db.sites.update(s.id, { order: i })
      i++
    }
  })

  // —— 主题恢复（独立于 db.settings，存 chrome.storage.local）——
  // 仅当备份含合法主题值时写回；缺失/非法跳过且不写；失败显式记录（不伪装成功）
  let themeRestored: boolean | undefined
  const theme = config.theme
  if (theme === 'light' || theme === 'dark' || theme === 'auto') {
    try {
      await chrome.storage.local.set({ 'aihub.theme': theme })
      themeRestored = true
    } catch {
      themeRestored = false
    }
  }

  return {
    imported,
    updated,
    skipped,
    skippedByReason,
    data: stats,
    operationId: crypto.randomUUID(),
    themeRestored,
  }
}
