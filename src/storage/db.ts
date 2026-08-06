import Dexie, { type Table } from 'dexie'
import type {
  SiteConfig,
  Snapshot,
  DailyStat,
  CredentialRow,
  SettingsRow,
  CustomCaptureRecord,
  DiagnosticEntry,
  UsageRecordBatch,
  UsageCacheEntry,
} from '../shared/types'

export class AIHubDB extends Dexie {
  sites!: Table<SiteConfig, string>
  snapshots!: Table<Snapshot, number>
  dailyStats!: Table<DailyStat, string>
  credentials!: Table<CredentialRow, string>
  settings!: Table<SettingsRow, string>
  captures!: Table<CustomCaptureRecord, string>
  diagnostics!: Table<DiagnosticEntry, number>
  usageRecords!: Table<UsageRecordBatch, string>
  /** v4 新增：用量聚合/分页/过滤项的本地缓存（仅缓存昂贵结果，不缓存原始记录） */
  usageCache!: Table<UsageCacheEntry, string>

  constructor() {
    super('aihub')
    // dailyStats 复合唯一键 &[siteId+date]：同站多日互不覆盖（P0-4）
    // captures 按 id 主键、siteId 建索引，便于按站列举/清空
    // diagnostics 按 siteId+at 建索引，便于按站查询 + 按时间清理
    // usageRecords 按 id 主键(siteId:date)、siteId/date/takenAt 建索引
    this.version(2).stores({
      sites: 'id, enabled, order',
      snapshots: '++id, siteId, takenAt',
      dailyStats: 'id, &[siteId+date], siteId, date',
      credentials: 'siteId',
      settings: 'key',
      captures: 'id, siteId, capturedAt',
      diagnostics: '++id, siteId, at',
    })
    // v3：新增 usageRecords 表（当日用量明细批次）。保留 v2 全部 schema。
    this.version(3).stores({
      sites: 'id, enabled, order',
      snapshots: '++id, siteId, takenAt',
      dailyStats: 'id, &[siteId+date], siteId, date',
      credentials: 'siteId',
      settings: 'key',
      captures: 'id, siteId, capturedAt',
      diagnostics: '++id, siteId, at',
      usageRecords: 'id, siteId, date, takenAt',
    })
    // v4：新增 usageCache 表（仅缓存昂贵聚合/分页/过滤项；不含原始记录）。
    //   索引：siteId+kind 复合、accessedAt 倒序（LRU 清理）、fromDate+toDate（按日期范围失效）。
    this.version(4)
      .stores({
        sites: 'id, enabled, order',
        snapshots: '++id, siteId, takenAt',
        dailyStats: 'id, &[siteId+date], siteId, date',
        credentials: 'siteId',
        settings: 'key',
        captures: 'id, siteId, capturedAt',
        diagnostics: '++id, siteId, at',
        usageRecords: 'id, siteId, date, takenAt',
        usageCache: 'cacheKey, siteId, kind, [siteId+kind], accessedAt, fromDate, toDate',
      })
      // 一次性迁移 v3 usageRecords：按白名单「投影」每条历史记录与批次顶层字段（GPT P0-S2）。
      // 仅原地补字段会保留历史 IndexedDB 中可能存在的 rawKey/serverId/原始 IP/嵌套响应体，
      // 再被标为 schemaVersion=2 后 backfill 零拷贝返回、永不再清理 → 违反存储信任边界。
      // 故改为：逐字段投影 + 数值有限非负校验 + 假名化字段格式校验（非 SHA-256 hex 即视为未假名化→置 null）。
      .upgrade(async (tx) => {
        const RECORD_KEYS = [
          'id', 'ts', 'model', 'promptTokens', 'completionTokens', 'tokens',
          'cacheReadTokens', 'cacheCreationTokens', 'cost', 'actualCost', 'actualCostCurrency',
          'standardCost', 'standardCostCurrency', 'costCurrency', 'endpoint', 'apiKeyId',
          'apiKeyLabel', 'ipHash', 'reasoningEffort', 'group', 'type', 'billingMode',
        ]
        const BATCH_KEYS = [
          'id', 'siteId', 'date', 'collectedAt', 'takenAt', 'records', 'totalTokens',
          'recordCount', 'costByCurrency', 'totalActualCostByCurrency',
          'totalStandardCostByCurrency', 'totalRequests', 'isComplete', 'truncatedReason',
          'pageCount', 'schemaVersion', 'source',
        ]
        const HEX_RE = /^[0-9a-f]{8,}$/i
        const NUM_KEYS = ['promptTokens', 'completionTokens', 'tokens', 'cacheReadTokens', 'cacheCreationTokens', 'cost', 'actualCost', 'standardCost']
        await tx
          .table('usageRecords')
          .toCollection()
          .modify((b: Record<string, unknown>) => {
            const recordsIn = Array.isArray(b.records) ? (b.records as Record<string, unknown>[]) : []
            const recordsOut: Record<string, unknown>[] = []
            for (const r of recordsIn) {
              const out: Record<string, unknown> = {}
              for (const k of RECORD_KEYS) out[k] = r[k]
              // 数值字段缺失/非有限/负 → null（cacheRead/Creation 可为 null；cost 类可为 null）
              for (const nk of NUM_KEYS) {
                const v = out[nk]
                if (v != null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) out[nk] = null
              }
              // 币种缺失（防御性；Phase A 前数据本就带币种）→ 兜底 USD
              if (typeof out.costCurrency !== 'string' || !out.costCurrency) out.costCurrency = 'USD'
              // 假名化字段格式校验：非 SHA-256 hex → 视为疑似原文，置 null（绝不保留原文）
              if (typeof out.apiKeyId === 'string' && !HEX_RE.test(out.apiKeyId)) out.apiKeyId = null
              if (typeof out.ipHash === 'string' && !HEX_RE.test(out.ipHash)) out.ipHash = null
              if (out.apiKeyLabel != null && typeof out.apiKeyLabel !== 'string') out.apiKeyLabel = null
              recordsOut.push(out)
            }
            // 批次顶层只保留已知字段（剔除任何历史残留的未知键）
            const outBatch: Record<string, unknown> = {}
            for (const k of BATCH_KEYS) outBatch[k] = b[k]
            outBatch.records = recordsOut
            // 时间语义：缺失时用 0 表示「未知」，禁止写当前时间（会让历史采集时间随读取漂移）
            if (!Number.isFinite(outBatch.collectedAt as number)) outBatch.collectedAt = Number.isFinite(outBatch.takenAt as number) ? outBatch.takenAt : 0
            if (!Number.isFinite(outBatch.takenAt as number)) outBatch.takenAt = Number.isFinite(outBatch.collectedAt as number) ? outBatch.collectedAt : 0
            if (!Number.isFinite(outBatch.recordCount as number)) outBatch.recordCount = recordsOut.length
            if (typeof outBatch.costByCurrency !== 'object' || outBatch.costByCurrency === null) outBatch.costByCurrency = {}
            if (typeof outBatch.totalActualCostByCurrency !== 'object' || outBatch.totalActualCostByCurrency === null) outBatch.totalActualCostByCurrency = {}
            if (typeof outBatch.totalStandardCostByCurrency !== 'object' || outBatch.totalStandardCostByCurrency === null) outBatch.totalStandardCostByCurrency = {}
            if (outBatch.truncatedReason === undefined) outBatch.truncatedReason = null
            outBatch.schemaVersion = 2
            // 用投影后的对象整体替换原批次（清除未知键）
            for (const k of Object.keys(b)) delete b[k]
            Object.assign(b, outBatch)
          })
      })

    // v5：新增 snapshots/diagnostics 的 recordId 不可变幂等键（唯一索引），用于跨安装备份还原。
    //   存量数据在 upgrade 中补齐 recordId（缺失则生成 crypto.randomUUID）。
    this.version(5)
      .stores({
        sites: 'id, enabled, order',
        snapshots: '++id, siteId, takenAt, &recordId',
        dailyStats: 'id, &[siteId+date], siteId, date',
        credentials: 'siteId',
        settings: 'key',
        captures: 'id, siteId, capturedAt',
        diagnostics: '++id, siteId, at, &recordId',
        usageRecords: 'id, siteId, date, takenAt',
        usageCache: 'cacheKey, siteId, kind, [siteId+kind], accessedAt, fromDate, toDate',
      })
      .upgrade(async (tx) => {
        await tx
          .table('snapshots')
          .toCollection()
          .modify((s: Record<string, unknown>) => {
            if (!s.recordId) s.recordId = crypto.randomUUID()
          })
        await tx
          .table('diagnostics')
          .toCollection()
          .modify((d: Record<string, unknown>) => {
            if (!d.recordId) d.recordId = crypto.randomUUID()
          })
      })
  }
}

export const db = new AIHubDB()
