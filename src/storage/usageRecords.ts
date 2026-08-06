import type { Table } from 'dexie'
import { db } from './db'
import type { SettingsRow, UsageRecord, UsageRecordBatch } from '../shared/types'
import { USAGE_RECORD_SCHEMA_VERSION } from '../shared/types'
import { isValidDateKey } from '../shared/util'

/**
 * 写入层白名单（GPT P1-whitelist）：putBatch 只持久化已知字段，
 * 杜绝调用方对象上意外携带的额外字段（如 rawKey / serverId / 嵌套对象）落入 IndexedDB。
 */
const USAGE_RECORD_KEYS: (keyof UsageRecord)[] = [
  'id',
  'ts',
  'model',
  'promptTokens',
  'completionTokens',
  'tokens',
  'cacheReadTokens',
  'cacheCreationTokens',
  'cost',
  'actualCost',
  'actualCostCurrency',
  'standardCost',
  'standardCostCurrency',
  'costCurrency',
  'endpoint',
  'apiKeyId',
  'apiKeyLabel',
  'ipHash',
  'reasoningEffort',
  'group',
  'type',
  'billingMode',
]
function sanitizeRecord(r: UsageRecord): UsageRecord {
  const out = {} as UsageRecord
  for (const k of USAGE_RECORD_KEYS) {
    ;(out as unknown as Record<string, unknown>)[k] = (r as unknown as Record<string, unknown>)[k]
  }
  return out
}

/** 批次顶层字段白名单（与 UsageRecordBatch 接口一致），迁移/回填时只保留已知字段。 */
const BATCH_KEYS: (keyof UsageRecordBatch)[] = [
  'id',
  'siteId',
  'date',
  'collectedAt',
  'takenAt',
  'records',
  'totalTokens',
  'recordCount',
  'costByCurrency',
  'totalActualCostByCurrency',
  'totalStandardCostByCurrency',
  'totalRequests',
  'isComplete',
  'truncatedReason',
  'pageCount',
  'schemaVersion',
  'source',
]
function sanitizeBatch(b: UsageRecordBatch): UsageRecordBatch {
  const out = {} as UsageRecordBatch
  for (const k of BATCH_KEYS) {
    ;(out as unknown as Record<string, unknown>)[k] = (b as unknown as Record<string, unknown>)[k]
  }
  out.records = (b.records ?? []).map(sanitizeRecord)
  return out
}

/** 写入前强校验：主键一致、时间为有限正毫秒、数值有限非负、每条记录带币种（GPT P1-boundary）。 */
function validateBatch(batch: UsageRecordBatch): void {
  if (!batch || typeof batch !== 'object') throw new Error('批次为空')
  if (!batch.siteId || typeof batch.siteId !== 'string') throw new Error('批次缺少 siteId')
  if (!isValidDateKey(batch.date)) throw new Error('批次日期非法: ' + batch.date)
  if (batch.id !== `${batch.siteId}:${batch.date}`) throw new Error('批次主键与 siteId:date 不一致')
  if (!Number.isFinite(batch.collectedAt) || batch.collectedAt <= 0) throw new Error('collectedAt 非法')
  if (!Number.isFinite(batch.takenAt) || batch.takenAt <= 0) throw new Error('takenAt 非法')
  for (const r of batch.records ?? []) {
    if (typeof r.id !== 'string' || !r.id) throw new Error('记录缺少 id')
    if (!Number.isFinite(r.ts) || r.ts <= 0) throw new Error('记录 ts 非法')
    if (!Number.isFinite(r.promptTokens) || r.promptTokens < 0) throw new Error('promptTokens 非法')
    if (!Number.isFinite(r.completionTokens) || r.completionTokens < 0) throw new Error('completionTokens 非法')
    if (!Number.isFinite(r.tokens) || r.tokens < 0) throw new Error('tokens 非法')
    if (r.cost != null && (!Number.isFinite(r.cost) || r.cost < 0)) throw new Error('cost 非法')
    if (!r.costCurrency || typeof r.costCurrency !== 'string') throw new Error('记录缺少 costCurrency')
  }
}

/** 枚举闭区间 [from,to] 内每一个合法业务日（含端点），用于区间 revision 指纹（GPT P1-empty-days）。 */
function enumerateDays(from: string, to: string): string[] {
  const out: string[] = []
  const [fy, fm, fd] = from.split('-').map(Number)
  const [ty, tm, td] = to.split('-').map(Number)
  let cur = new Date(Date.UTC(fy, fm - 1, fd))
  const end = new Date(Date.UTC(ty, tm - 1, td))
  while (cur <= end) {
    const y = cur.getUTCFullYear()
    const m = String(cur.getUTCMonth() + 1).padStart(2, '0')
    const d = String(cur.getUTCDate()).padStart(2, '0')
    out.push(`${y}-${m}-${d}`)
    cur = new Date(cur.getTime() + 86400000)
  }
  return out
}

/**
 * v3 → v4 兼容兜底。
 * 主迁移已放在 db.ts 的 version(4).upgrade()（一次性 modify，schemaVersion 置 2）。
 * 本函数只是安全网：schemaVersion >= 2 直接原样返回（零拷贝、零分配），
 * 仅当遇到迁移遗漏的旧记录时才补 null（GPT P1-7：避免每次读取的全量 map 放大）。
 * 缺失时间一律用 0 表示「未知」，禁止用 Date.now()（否则历史采集时间会随读取漂移）。
 */
function backfillBatch(b: UsageRecordBatch | null | undefined): UsageRecordBatch | null {
  if (!b) return null
  if ((b.schemaVersion ?? 1) >= USAGE_RECORD_SCHEMA_VERSION) return b
  const records: UsageRecord[] = (b.records ?? []).map((r) => ({
    id: r.id,
    ts: r.ts,
    model: r.model,
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
    tokens: r.tokens,
    cacheReadTokens: r.cacheReadTokens ?? null,
    cacheCreationTokens: r.cacheCreationTokens ?? null,
    cost: r.cost ?? null,
    actualCost: r.actualCost ?? null,
    actualCostCurrency: r.actualCostCurrency ?? null,
    standardCost: r.standardCost ?? null,
    standardCostCurrency: r.standardCostCurrency ?? null,
    costCurrency: r.costCurrency,
    endpoint: r.endpoint ?? null,
    apiKeyId: r.apiKeyId ?? null,
    apiKeyLabel: r.apiKeyLabel ?? null,
    ipHash: r.ipHash ?? null,
    reasoningEffort: r.reasoningEffort ?? null,
    group: r.group ?? null,
    type: r.type ?? null,
    billingMode: r.billingMode ?? null,
  }))
  return {
    id: b.id,
    siteId: b.siteId,
    date: b.date,
    collectedAt: b.collectedAt ?? b.takenAt ?? 0,
    takenAt: b.takenAt ?? b.collectedAt ?? 0,
    records,
    totalTokens: b.totalTokens,
    recordCount: b.recordCount ?? records.length,
    costByCurrency: b.costByCurrency ?? {},
    totalActualCostByCurrency: b.totalActualCostByCurrency ?? {},
    totalStandardCostByCurrency: b.totalStandardCostByCurrency ?? {},
    totalRequests: b.totalRequests,
    isComplete: b.isComplete,
    truncatedReason: b.truncatedReason ?? null,
    pageCount: b.pageCount,
    schemaVersion: USAGE_RECORD_SCHEMA_VERSION,
    source: b.source,
  }
}

/**
 * (siteId, date) 级 revision：任何会改变该日数据的写/删都必须在同一事务内推进它。
 * 严格单调递增（GPT P0-1）：Date.now() 在同一毫秒内会重复，故取 max(now, prev+1)。
 */
const REVISION_KEY_PREFIX = 'aihub.usage.rev.'
export function revKey(siteId: string, date: string): string {
  return REVISION_KEY_PREFIX + siteId + ':' + date
}

/** 必须在 rw 事务内调用，且事务须包含 settings 表。 */
async function bumpRevision(settings: Table<SettingsRow, string>, siteId: string, date: string): Promise<string> {
  const key = revKey(siteId, date)
  const cur = await settings.get(key)
  const prev = Number((cur?.value as string) ?? '0')
  const next = String(Math.max(Date.now(), (Number.isFinite(prev) ? prev : 0) + 1))
  await settings.put({ key, value: next } as SettingsRow)
  return next
}

/** 删除一批 (siteId,date) 的数据时：推进 revision + 清掉相交的聚合缓存（GPT P0-2）。 */
async function invalidateAfterDelete(
  settings: Table<SettingsRow, string>,
  usageCacheTable: Table<{ cacheKey: string; siteId: string; fromDate: string; toDate: string }, string>,
  pairs: { siteId: string; date: string }[],
): Promise<void> {
  if (!pairs.length) return
  const bySite = new Map<string, string[]>()
  for (const p of pairs) {
    await bumpRevision(settings, p.siteId, p.date)
    const arr = bySite.get(p.siteId) ?? []
    arr.push(p.date)
    bySite.set(p.siteId, arr)
  }
  for (const [siteId, dates] of bySite) {
    const sorted = [...dates].sort()
    const minD = sorted[0]
    const maxD = sorted[sorted.length - 1]
    const entries = await usageCacheTable.where('siteId').equals(siteId).toArray()
    const victims = entries.filter((e) => e.fromDate <= maxD && e.toDate >= minD).map((e) => e.cacheKey)
    if (victims.length) await usageCacheTable.bulkDelete(victims)
  }
}

/**
 * 当日用量明细批次的读写层。
 * - putBatch：写入单站单日批次。完整批次优先于不完整批次（P1：防覆盖丢失完整数据）。
 *   putBatch + revision 自增在同一 Dexie 事务内原子完成。
 * - getSnapshot：在同一只读事务内同时读「批次 + revision」，保证缓存记录的 revision 与数据是同一快照
 *   （GPT P0-1：否则并发采集会把旧数据标成新 revision，导致缓存误命中）。
 * - clearBySite / clearOlderThan：删除同时推进 revision 并清空相关聚合缓存，
 *   防止 TTL 内的 stale 兜底把已删除数据重新显示出来（GPT P0-2）。
 */
export const usageRecordsRepo = {
  async putBatch(batch: UsageRecordBatch): Promise<void> {
    // 存储边界强校验：非法业务日 / 主键 / 时间 / 数值直接拒绝（GPT P1-boundary）。
    validateBatch(batch)
    const next: UsageRecordBatch = {
      ...batch,
      // 顶层 + 记录双层白名单投影，杜绝调用方对象携带 rawKey/serverId/嵌套体等流出（GPT P1-whitelist）。
      // sanitizeBatch 已将 schemaVersion 归一为当前版本（USAGE_RECORD_SCHEMA_VERSION）；旧版本由 backfillBatch 在读时升级。
      ...sanitizeBatch(batch),
    }
    await db.transaction('rw', db.usageRecords, db.settings, async () => {
      const prev = await db.usageRecords.get(next.id)
      if (prev) {
        const prevComplete = !!prev.isComplete
        const nextComplete = !!next.isComplete
        // 完整优先：旧完整且新不完整 → 不覆盖、不推进 revision
        if (prevComplete && !nextComplete) return
        // 同完整性级别：仅接受「严格更新」的采集版本（collectedAt 严格更大），
        // 杜绝同毫秒 last-writer-wins 与旧数据覆写新数据（GPT P1-collectedAt）
        if (prevComplete === nextComplete && prev.collectedAt >= next.collectedAt) return
      }
      await db.usageRecords.put(next)
      await bumpRevision(db.settings, next.siteId, next.date)
    })
  },

  async getBySiteDate(siteId: string, date: string): Promise<UsageRecordBatch | null> {
    return backfillBatch((await db.usageRecords.get(`${siteId}:${date}`)) ?? null)
  },

  async getLatest(siteId: string): Promise<UsageRecordBatch | null> {
    const list = await db.usageRecords.where('siteId').equals(siteId).toArray()
    if (!list.length) return null
    // 按采集时间降序，返回最新批次（sorted[0]）；此前误用 length-1 会返回最早批次（GPT P1-getLatest）
    const sorted = [...list].sort((a, b) => (b.collectedAt ?? b.takenAt) - (a.collectedAt ?? a.takenAt))
    return backfillBatch(sorted[0])
  },

  async getBySiteRange(siteId: string, fromDate: string, toDate: string): Promise<UsageRecordBatch[]> {
    const raw = await db.usageRecords
      .where('siteId')
      .equals(siteId)
      .filter((b) => b.date >= fromDate && b.date <= toDate)
      .toArray()
    return raw.map((b) => backfillBatch(b)).filter((b): b is UsageRecordBatch => b !== null)
  },

  /**
   * 一致性快照：批次与 revision 在同一只读事务内读取。
   * revision 为区间内各日 revision 的拼接，任一日变化都会导致整体 revision 变化。
   */
  async getSnapshot(
    siteId: string,
    fromDate: string,
    toDate: string,
  ): Promise<{ batches: UsageRecordBatch[]; revision: string }> {
    return db.transaction('r', db.usageRecords, db.settings, async () => {
      const raw = await db.usageRecords
        .where('siteId')
        .equals(siteId)
        .filter((b) => b.date >= fromDate && b.date <= toDate)
        .toArray()
      const batches = raw.map((b) => backfillBatch(b)).filter((x): x is UsageRecordBatch => x !== null)
      // 区间 revision 必须覆盖闭区间内「每一个」业务日（含空日），否则新增/删除/空日变更无法被检测（GPT P1-empty-days）。
      const dates = new Set<string>([...enumerateDays(fromDate, toDate), ...batches.map((b) => b.date)])
      const parts: string[] = []
      for (const d of [...dates].sort()) {
        const row = await db.settings.get(revKey(siteId, d))
        parts.push(d + '=' + ((row?.value as string) ?? '0'))
      }
      return { batches, revision: parts.join(',') }
    })
  },

  async clearBySite(siteId: string): Promise<void> {
    return db.transaction('rw', db.usageRecords, db.settings, db.usageCache, async () => {
      const rows = await db.usageRecords.where('siteId').equals(siteId).toArray()
      await db.usageRecords.where('siteId').equals(siteId).delete()
      await invalidateAfterDelete(
        db.settings,
        db.usageCache as unknown as Table<{ cacheKey: string; siteId: string; fromDate: string; toDate: string }, string>,
        rows.map((b) => ({ siteId: b.siteId, date: b.date })),
      )
      // 站点级清空：该站所有缓存条目一并删除，禁止任何 stale 兜底复活已删数据
      await db.usageCache.where('siteId').equals(siteId).delete()
    })
  },

  async clearOlderThan(ms: number): Promise<number> {
    return db.transaction('rw', db.usageRecords, db.settings, db.usageCache, async () => {
      const rows = await db.usageRecords.where('takenAt').below(ms).toArray()
      if (!rows.length) return 0
      await db.usageRecords.bulkDelete(rows.map((b) => b.id))
      await invalidateAfterDelete(
        db.settings,
        db.usageCache as unknown as Table<{ cacheKey: string; siteId: string; fromDate: string; toDate: string }, string>,
        rows.map((b) => ({ siteId: b.siteId, date: b.date })),
      )
      return rows.length
    })
  },

  /** 单日 revision（仅用于诊断/展示；缓存判定请用 getSnapshot 的一致性快照）。 */
  async getRevision(siteId: string, date: string): Promise<string> {
    const row = await db.settings.get(revKey(siteId, date))
    return (row?.value as string) ?? '0'
  },
}
