import type { Snapshot, SiteConfig, SiteStatus, DailyStat, CustomCaptureRecord, DiagnosticEntry, UsageRecordBatch, SettingsRow, SiteCollectionProfile } from '../../shared/types'

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

/**
 * 导出配置（备份文件格式）。
 * - version=1：仅站点配置（旧格式，零凭证）。
 * - version=2：全量备份（站点 + 采集数据 + 设置），见 `tables`。
 * 红线：绝不导出 credentials（无 secret）/ usageCache（派生）。
 */
export interface ExportConfig {
  version: number
  exportedAt: number
  appVersion?: string
  schemaVersion?: number
  sites: SiteConfig[]
  /** v2 全量数据；缺失时为 v1（仅站点）。 */
  tables?: ExportTables
}

/** v2 全量备份的 7 类业务表（credentials/usageCache 故意缺失）。 */
export interface ExportTables {
  snapshots: Snapshot[]
  dailyStats: DailyStat[]
  captures: CustomCaptureRecord[]
  diagnostics: DiagnosticEntry[]
  usageRecords: UsageRecordBatch[]
  settings: SettingsRow[]
}

/** 导入结果：按原因拆分的摘要（GPT P0-导入摘要）。 */
export interface ImportResult {
  imported: number
  updated: number
  skipped: { name: string; reason: string }[]
  /** 按原因归类的跳过计数。 */
  skippedByReason: Record<string, number>
  /** 各表写入统计：written=实际写入/幂等覆盖数，orphanSkipped=因站点未导入而跳过的关联行，idRecomputed=重算主键数。 */
  data: Record<string, { written: number; orphanSkipped: number; idRecomputed: number }>
  /** 本次导入操作标识（用于进度查询/审计）。 */
  operationId: string
  fatalError?: string
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

// ── 站点手动排序（设置页拖拽手柄 / ▲▼ 按钮，完整集合重排） ──
/**
 * 完整集合重排载荷（GPT P0-1 修正：禁止"部分重排"）。
 * `orderedIds` 必须是**当前全部站点 id 的一个完整排列**——
 * 与 DB 现有集合大小一致、无重复、无未知 id。handler 运行时校验，不通过则整体拒绝。
 */
export interface ReorderSitesPayload {
  orderedIds: string[]
}
export interface ReorderSitesResponse {
  ok: boolean
  /** 失败错误码：'INVALID_SITE_ORDER'（数组非法/含空串/重复 id/未知 id/与 DB 集合不一致） */
  code?: string
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
/** @deprecated Phase A 已被 GET_USAGE_DASHBOARD/DETAILS/FILTER_OPTIONS 取代；保留仅为向后兼容，新 UI 请勿调用。 */
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

// ── 用量看板（v4 新增；GET_USAGE_RECORDS 保留但标记 deprecated） ──
/**
 * 刷新模式：
 * - 'auto'（默认）：缓存新鲜则直接返回；否则触发一次采集（同站点 60s 内节流）。
 * - 'force'：忽略缓存，强制触发采集（对应 UI 的「刷新」按钮）。
 * - 'cache-only'：绝不触发采集（离线 / 只想看已有数据）。
 */
export type UsageRefreshMode = 'auto' | 'force' | 'cache-only'

/**
 * 时间范围（Phase A 仅支持单日聚合）。
 * date 缺省时由 handler 按站点业务时区取「今天」（hubway_v1 固定 Asia/Shanghai）。
 * 多日区间（fromDate/toDate）待真实多日聚合、分页语义与缓存键落地后再引入，
 * 避免对外承诺未实现的能力（GPT P1-protocol）。
 */
export interface UsageRangePayload {
  /** 单日 YYYY-MM-DD */
  date?: string
}

export interface UsageDataMetaDto {
  source: 'api' | 'local_fallback' | 'cache'
  fetchedAt: number
  dataAsOf: number | null
  isStale: boolean
  staleAgeMinutes: number
}

export interface GetUsageDashboardPayload extends UsageRangePayload {
  /** 站点 id（必填，且须为已配置站点） */
  id: string
  mode?: UsageRefreshMode
}
export interface UsageTopMetricsDto {
  totalRequests: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  /** 按币种分组（P1-3：绝不跨币种求和） */
  totalCostByCurrency: Record<string, number>
  /** 无精确来源时为 null，UI 显「—」 */
  avgResponseMs: number | null
  windowHours: number
}
export interface UsageDistributionBucketDto {
  key: string
  label: string
  requests: number
  tokens: number
  costByCurrency: Record<string, number>
  ratio: number
}
export interface UsageTrendPointDto {
  ts: number
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  cacheHitRate: number
  requests: number
}
export interface GetUsageDashboardResponse {
  siteId: string
  date: string
  topMetrics: UsageTopMetricsDto | null
  distributions: {
    model: UsageDistributionBucketDto[]
    group: UsageDistributionBucketDto[]
    endpoint: UsageDistributionBucketDto[]
  } | null
  tokenTrend: UsageTrendPointDto[]
  records: number
  meta: UsageDataMetaDto
}

export interface UsageDetailFilters {
  apiKeyId?: string
  model?: string
  endpoint?: string
  group?: string
  type?: string
  billingMode?: string
}
export interface GetUsageDetailsPayload extends UsageRangePayload {
  id: string
  mode?: UsageRefreshMode
  filters?: UsageDetailFilters
  /** 1-based；默认 1 */
  page?: number
  /** 默认 50，服务端硬上限 100（P1-3 分页有界） */
  pageSize?: number
}
export interface GetUsageDetailsResponse {
  siteId: string
  date: string
  rows: UsageRecordBatch['records']
  total: number
  page: number
  pageSize: number
  /** 当日明细是否完整（false=命中 200 条硬上限被截断，UI 须标「明细不完整」） */
  isComplete: boolean
  truncatedReason?: string | null
  meta: UsageDataMetaDto
}

export interface GetUsageFilterOptionsPayload extends UsageRangePayload {
  id: string
  mode?: UsageRefreshMode
}
export interface GetUsageFilterOptionsResponse {
  siteId: string
  date: string
  apiKeyIds: string[]
  models: string[]
  endpoints: string[]
  groups: string[]
  types: string[]
  billingModes: string[]
  meta: UsageDataMetaDto
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

// ── 实验室：图标点击弹极简用量看板（实验性，默认关闭） ──────
export interface LabShowDashboardPayload {
  enabled: boolean
}
export interface LabShowDashboardResponse {
  enabled: boolean
}

// ── 单击图标行为（配置界面，非实验室） ─────────────────────
export interface ClickBehaviorPayload {
  behavior: 'panel' | 'sidebar'
}
export interface ClickBehaviorResponse {
  behavior: 'panel' | 'sidebar'
}

// ── 极简用量看板（popup）：各站名称 + 最新余额 ──────────────
export interface DashboardSummaryItem {
  siteId: string
  name: string
  origin: string
  // 用户配置时填写的完整链接（含路径）；极简面板名称跳转优先用此，缺失时回退 origin。
  baseUrl: string
  balance: number | null
  currency: string | null
  updatedAt: number | null // 最新快照时间
  status: 'ok' | 'auth_expired' | 'error' | 'no_data'
}
export interface GetDashboardSummaryPayload {
  // 留空，便于未来扩展（如仅某站）
}
export interface GetDashboardSummaryResponse {
  items: DashboardSummaryItem[]
}

// ── 站点类型与采集方案可视化（方案 028）──
/** 请求体留空：一次性返回所有站点的只读展示模型（按 siteId 索引）。 */
export interface GetSiteCollectionProfilesPayload {
  // 无载荷
}
export interface GetSiteCollectionProfilesResponse {
  profiles: Record<string, SiteCollectionProfile>
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

// ── 余额历史：删除单条 / 批量删除 ─────────────────────────
export interface DeleteSnapshotPayload {
  id: number
}
export interface DeleteSnapshotsPayload {
  ids: number[]
}
export interface DeleteSnapshotsResponse {
  deleted: number
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
