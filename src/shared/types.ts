// 核心领域类型（跨 background / sidepanel / options 共享）

export type AdapterId = string

export type SiteStatus =
  | 'unknown' // 尚未采集过
  | 'ok'
  | 'auth_expired' // 登录态失效，需重登
  | 'error' // 采集异常
  | 'no_source' // 站点无精确用量接口，今日用量不可得（P0-3）

export interface SiteConfig {
  id: string
  name: string
  baseUrl: string // 用户填写
  origin: string // 归一化后的 origin（P0-5），用于 host 权限与采集
  adapter: AdapterId
  color: string
  enabled: boolean
  order: number
  createdAt: number
  lastCollectAt: number | null
  lastStatus: SiteStatus
  lastError?: string // 最近一次采集失败的错误描述
  /** 计价货币（默认 USD；ikuncode 等以 ¥/CNY 计价的站点显式设置为 CNY）。仅影响展示符号，不参与跨币种相加（P1-3）。 */
  currency?: string
  /**
   * 页面主世界探测到的真实接口路径与站点分类（MV3 SW 无法直接读取 SPA 内部 API）。
   * 分类由 SW 侧 classifySite() 纯函数根据脱敏指纹判定，写入此字段。
   */
  discovered?: {
    userSelfPath?: string
    userSelfUrl?: string
    probedAt?: number
    /** 家族归属：one-api-compatible | new-api-capable | independent | unknown */
    family?: string
    /** 路径特征：standard(标准路径) | fork-path(路���被修改) | discovered(网络发现) */
    routeProfile?: string
    /** 可采集的数据维度：balance | usageLogs | hourlyUsage | requestCount | tokenSource | usageList */
    capabilities?: string[]
    /** 分类置信度：high(多端点交叉验证) | medium(单一端点命中) | low(仅部分字段匹配) */
    confidence?: string
    /** 当日用量明细列表适配器种类（P0：适配器隔离，禁把 hubway 约定泛化）：hubway_v1 | generic | null */
    usageListKind?: 'hubway_v1' | 'generic' | null
  }
  /**
   * 用户自定义的采集请求（原样保存，不改写）。
   * 以英文分号分隔，每项可为相对路径或本站完整 URL（如 `/api/v1/auth/me;/api/user/usage`）。
   * 仅同源、GET only，用于扩展采集本站任意可读接口供后续分析（与余额同步解耦）。
   */
  customRequests?: string
}

export type CollectErrorKind =
  | 'AUTH_EXPIRED'
  | 'NETWORK'
  | 'PARSE'
  | 'FORBIDDEN'
  | 'NOT_FOUND'

export type Channel = 'sw' | 'content_script' | 'alarm' | 'sw_lab'

export interface ModelUsage {
  model: string
  tokens: number
  cost: number
}

export type DataQuality = 'verified' | 'partial' | 'unknown'

/**
 * 一次采集得到的归一化快照。
 * 缺失字段一律为 null（UI 显「—」），绝不编造（红线：禁模拟数据）。
 */
export interface Snapshot {
  id?: number
  siteId: string
  takenAt: number
  balance: number | null
  todayTokens: number | null // 当日累计 Token，来自 usage 日志；无精确接口则 null
  todayRequests: number | null
  /** 今日使用金额（本币，与 currency 同币种）。来自用量日志的 cost/quota 字段；无则 null（UI 显「—」）。 */
  todayCost?: number | null
  totalRequests: number | null // 账户累计请求数（如 ikuncode「/api/user/self」返回；其余站点可能缺失）
  totalQuota: number | null
  currency: string | null
  modelUsages: ModelUsage[]
  status: 'ok' | 'auth_expired' | 'error'
  errorKind?: CollectErrorKind
  // P1-4 审计字段
  channel: Channel
  apiVersion?: string
  responseHash?: string
  quality: DataQuality
  /** 站点分类家族（采集时的分类快照，便于后续规则升级后追溯历史数据差异） */
  family?: string
  routeProfile?: string
  confidence?: string
  /** 余额数据来源端点标识 */
  balanceSource?: string
  /** 用量数据来源：hourly_aggregate | raw_logs | unavailable */
  usageSource?: string
  /** 用量数据是否不完整（如分页超限） */
  isPartial?: boolean
  /** 采集器版本号（规则升级后用于区分新旧数据） */
  collectorVersion?: number
  // ===== A0 新增：指标与来源可信度（GPT P0-2/P0-5）=====
  /** 累计 Token（仅来自权威源，绝不来自额度/金额字段）。无权威源则 null（UI 显「—」）。 */
  cumulativeTokens?: number | null
  /** 累计 Token 来源：dashboard(站点权威接口) | logs(可证口径日志) | local_history(本插件历史累加) | null */
  cumulativeTokensSource?: 'dashboard' | 'logs' | 'local_history' | null
  /** 本次采集对余额接口实测往返耗时（ms）。非纯网络延迟、非站点平均响应（GPT P0-5）。 */
  apiRoundTripMs?: number | null
  /** 站点自报平均 API 响应时间（ms）。仅当权威接口明确返回时填入，否则 null（不得伪造）。 */
  avgResponseTimeMs?: number | null
  /** 指标是否不完整（如部分字段缺失/分页超限） */
  metricsPartial?: boolean
}

/**
 * 按自然日的用量聚合。仅来自站点精确 usage 日志（P0-3，禁余额差分）。
 * 无精确接口的站点不落此表。
 */
export interface DailyStat {
  id?: string // `${siteId}@${date}`
  siteId: string
  date: string // YYYY-MM-DD
  tokens: number
  requests: number
  cost: number
  currency: string | null
  byModel: Record<string, { tokens: number; cost: number }>
  source: 'logs'
  /** 当日采集往返耗时采样（ms，可选；多采样取中位/EMA 由写入层处理） */
  apiRoundTripMs?: number
  /** 当日数据是否不完整（如分页超限/部分字段缺失） */
  partial?: boolean
  updatedAt?: number
}

/**
 * 凭证：MVP 仅 Cookie 会话（P0-2）。
 * 不存储 Token、不存储 Cookie 原文——Cookie 在采集时由 chrome.cookies 实时读取。
 * authorized 仅作 UI 态标记：采集成功置 true、AUTH_EXPIRED 置 false。
 */
export interface CredentialRow {
  siteId: string // pk
  method: 'cookie'
  authorized: boolean
  updatedAt: number
}

export interface SettingsRow {
  key: string
  value: unknown
}

/**
 * 自定义采集请求捕获记录。
 * 仅保存用户主动采集、本人登录会话返回的 JSON 响应；与余额快照（snapshotRepo）完全分离。
 * 绝不保存任何 Cookie / Authorization 头 / 凭证原文（红线 P0-2）。
 */
export interface CustomCaptureRecord {
  id: string // pk
  siteId: string
  url: string
  status: number | null
  contentType: string
  capturedAt: number
  ok: boolean
  json: unknown | null // 仅解析成功的 JSON 响应体；非 JSON / 超大响应为 null
  error?: string
}

/**
 * 采集诊断日志条目（P0-1/P0-4 安全边界：仅存脱敏指纹，绝不存 Cookie/Token/响应体原文）。
 * 每次采集自动写入，用于排查「某字段为何为 null」。
 */
export interface DiagnosticEntry {
  id?: number // 自增主键
  siteId: string
  /** 采集时间戳 */
  at: number
  /** 阶段：balance(余额端点) / usage(用量端点) / overall(汇总) */
  phase: 'balance' | 'usage' | 'overall'
  /** 请求的完整 URL（仅路径+查询参数，不含敏感参数） */
  url: string
  /** HTTP 状态码（0=网络错误/超时） */
  status: number
  /** 响应 Content-Type（仅类型，不含值） */
  contentType: string
  /** 耗时（ms） */
  elapsedMs: number
  /**
   * 响应 JSON 的顶层字段名 + 类型指纹（如 {id:'number', quota:'number', balance:'number'}）。
   * 绝不存字段值原文。若非 JSON 响应为空对象。
   */
  fieldFingerprint: Record<string, string>
  /** 本次阶段提取到的指标摘要（仅路径+是否成功，不含值） */
  extracted: {
    balance: boolean
    todayTokens: boolean
    todayRequests: boolean
    cumulativeTokens: boolean
    totalRequests: boolean
    avgResponseTimeMs: boolean
    todayCost: boolean
  }
  /** 备注/失败原因（人类可读，不含私密信息） */
  note: string
}

/**
 * 当日用量明细记录（来自中转站「用量明细列表」接口，如 hubway 的 /api/v1/usage）。
 * ⚠️ P0-2 数据最小化：仅白名单字段，绝不保存服务端原始 id / 嵌套对象 / 响应原文 / 任何凭证。
 * `id` 为本地确定性摘要，非服务端 id；`cost` 必带 `costCurrency`（P1-3，禁跨币种求和）。
 */
export interface UsageRecord {
  /** 本地确定性摘要（model+ts+tokens 哈希），非服务端 id */
  id: string
  /** 调用时间（ms） */
  ts: number
  /** 模型名（长度受限，最多 64 字符） */
  model: string
  promptTokens: number
  completionTokens: number
  tokens: number
  /** 本笔消耗金额（本币）；无明确字段则 null（UI 显「—」） */
  cost: number | null
  /** 金额币种（与站点 currency 一致；P1-3 维度） */
  costCurrency: string
}

/**
 * 单站单日的用量明细批次（一整日的所有调用记录）。
 * 主键 `siteId:date` —— 同一天多次采集，完整批次优先于不完整批次（P1：防覆盖）。
 */
export interface UsageRecordBatch {
  id: string // pk: `${siteId}:${date}`
  siteId: string
  /** 业务日 YYYY-MM-DD（按站点业务时区，如 hubway=Asia/Shanghai；与接口/主键/查询口径一致） */
  date: string
  takenAt: number
  records: UsageRecord[]
  totalTokens: number
  /** 按币种分组的金额（P1-3，禁单一 totalCost） */
  costByCurrency: Record<string, number>
  totalRequests: number
  /** 是否完整采集（false=命中上限被截断，UI 须标「明细不完整」） */
  isComplete: boolean
  truncatedReason?: string | null
  pageCount: number
  schemaVersion: number
  /** 来源适配器：hubway_v1 | generic */
  source: string
}
