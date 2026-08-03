import type { Snapshot, SiteConfig, SiteStatus, DailyStat, CustomCaptureRecord, DiagnosticEntry, UsageRecordBatch } from '../../shared/types'

/** 消息信封：所有跨上下文通信统一结构，requestId 全链路透传。 */
export interface Req<P = unknown> {
  type: string
  requestId: string
  payload: P
}

export interface Res<R = unknown> {
  requestId: string
  ok: boolean
  data?: R
  error?: { kind: string; message: string }
}

/** COLLECT_NOW 单站结果（快照可能较胖，按需取用）。 */
export interface CollectResultMsg {
  siteId: string
  ok: boolean
  errorKind?: string
  message?: string
  snapshot?: Snapshot
}

/** 仪表盘单站摘要。 */
export interface SiteSummary {
  site: SiteConfig
  latest?: Snapshot
  lastStatus: SiteStatus
}

/** 单币种总览（P1-3：总余额/用量按币种分组，绝不跨币种相加）。 */
export interface CurrencyTotal {
  currency: string
  totalBalance: number
  totalTodayTokens: number
  totalTodayRequests: number
  sites: number
}

export type TotalsByCurrency = Record<string, CurrencyTotal>

export interface DashboardData {
  sites: SiteSummary[]
  totals: TotalsByCurrency
}

export interface SiteDetailData {
  site: SiteConfig
  snapshots: Snapshot[]
  dailyStats: unknown[]
}

/** 导出配置：仅站点配置，零凭证/私密（红线：导出剔除 token）。 */
export interface ExportConfig {
  version: number
  exportedAt: number
  sites: SiteConfig[]
}

// 入参载荷类型
export interface AddSitePayload {
  type: string
  name: string
  baseUrl: string
  currency?: string
}
export interface UpdateSitePayload {
  id: string
  patch: Partial<SiteConfig>
}
export interface DeleteSitePayload {
  id: string
}
export interface SiteIdPayload {
  id: string
}
export interface CollectNowPayload {
  siteIds?: string[]
}

/** 自定义采集请求：采集某站用户配置的自定义请求（按需按钮触发）。 */
export interface CaptureCustomPayload {
  id: string
}
export interface CaptureCustomResponse {
  recorded: number
  failed: number
  errors: string[]
}

/** 获取某站全部自定义采集捕获（导出用）。 */
export interface GetCapturesPayload {
  id: string
}
/** 清空某站自定义采集捕获。 */
export interface ClearCapturesPayload {
  id: string
}

// ── 诊断日志：查询 / 清空（脱敏指纹，P0-1/P0-4） ─────────────
export interface GetDiagnosticsPayload {
  id: string
}
export interface ClearDiagnosticsPayload {
  id: string
}

// ── 当日用量明细批次（来自 /api/v1/usage 等用量明细列表端点） ──
export interface GetUsageRecordsPayload {
  /** 站点 id（必填，且须为已配置站点） */
  id: string
  /** 业务日 YYYY-MM-DD；省略则按站点业务时区取「今天」 */
  date?: string
}
export interface GetUsageRecordsResponse {
  siteId: string
  /** 实际查询的业务日 */
  date: string
  /** 批次是否完整（false=截断/不完整，UI 须标「明细不完整」） */
  isComplete: boolean
  takenAt: number
  source: string
  /** 用量明细记录（已按 ts 升序） */
  records: UsageRecordBatch['records']
  totalTokens: number
  totalRequests: number
  costByCurrency: Record<string, number>
}

// ── 保留策略 ──────────────────────────────────────────────
export interface RetentionPayload {
  days: number
}
export interface RetentionResponse {
  days: number
}

// ── 自动采集间隔（分钟数或 'off' 关闭） ──────────────────
export interface CollectIntervalPayload {
  interval: number | 'off'
}
export interface CollectIntervalResponse {
  interval: number | 'off'
}

// ── 实验室：SW 零标签后台采集（实验性，默认关闭） ──────────
export interface LabZeroTabPayload {
  enabled: boolean
}
export interface LabZeroTabResponse {
  enabled: boolean
}

// ── 实验室：动态 CORS 放行（实验性，默认关闭） ───────────────
export interface LabCorsPayload {
  enabled: boolean
}
export interface LabCorsResponse {
  enabled: boolean
}

// ── 数据查看器：取某站全部已采集数据 ──────────────────────
export interface GetSiteDataPayload {
  siteId: string // 单站 id；传 '__all__' 表示聚合全部站点
}
export interface SiteDataSummary {
  snapshotCount: number
  dailyCount: number
  captureCount: number
  earliestTs: number | null
  latestTs: number | null
  estBytes: number // 三表 JSON 序列化合计字节（占用估算）
}
export interface GetSiteDataResponse {
  snapshots: Snapshot[]
  dailyStats: DailyStat[]
  captures: CustomCaptureRecord[]
  summary: SiteDataSummary
}

// ── 手动重置：单站 / 全局 ─────────────────────────────────
export interface ResetSiteDataPayload {
  siteId: string
}
export interface ResetAllDataPayload {
  // 无载荷
}
export interface ResetDataResponse {
  deleted: { snapshots: number; dailyStats: number; captures: number }
}

export type { CustomCaptureRecord, DailyStat, DiagnosticEntry, UsageRecordBatch }
