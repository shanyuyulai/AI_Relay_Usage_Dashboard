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
  }
}

export const db = new AIHubDB()
