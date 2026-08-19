// 核心领域类型（跨 background / sidepanel / options 共享）

export type AdapterId = string

export type SiteStatus =
  | 'unknown' // 尚未采集过
  | 'ok'
  | 'auth_expired' // 登录态失效，需重登
  | 'error' // 采集异常
  | 'no_source' // 站点无精确用量接口，今日用量不可得（P0-3）

/** 页面采集得到的授权结论。indeterminate 表示证据不足，不代表用户已退出。 */
export type AuthState = 'authenticated' | 'unauthorized' | 'indeterminate'

/** 授权证据的固定原因枚举；不得承载 Token、Cookie 或响应正文。 */
export type AuthEvidenceReason =
  | 'ACCOUNT_AUTHENTICATED'
  | 'ACCOUNT_UNAUTHORIZED'
  | 'AUTH_CONTEXT_INCOMPLETE'
  | 'CANDIDATE_REJECTED'
  | 'NETWORK_OR_TIMEOUT'
  | 'NON_JSON_RESPONSE'
  | 'ACCOUNT_CONTRACT_MISMATCH'
  | 'ENDPOINT_UNAVAILABLE'

export type AuthEndpointRole = 'account_authority' | 'candidate' | 'usage' | 'refresh'

/** 最近一次授权结论的脱敏证据。仅保存状态、角色、pathname、状态码和时间。 */
export interface AuthEvidence {
  state: AuthState
  reason: AuthEvidenceReason
  endpointRole: AuthEndpointRole
  path: string | null
  httpStatus: number | null
  provider: 'new_api_user_object' | 'generic_cookie_or_token' | 'unknown'
  contextComplete: boolean
  collectRunId?: string
  observedAt: number
}

/**
 * 账户快照语义（方案 027 §3.1）：以「响应结构契约」识别，绝不按域名硬编码。
 * - current_balance_and_historical_consumed：data.user.quota=当前余额、used_quota=历史累计消耗、request_count=累计请求（如 DoCode）。
 * - quota_limit_and_used：quota=总额度、used_quota=已用额度（通用额度站）。
 * - direct_balance：仅直接余额字段。
 * - unknown：结构不足以判定。
 */
export type AccountSemantics =
  | 'current_balance_and_historical_consumed'
  | 'quota_limit_and_used'
  | 'direct_balance'
  | 'unknown'

/**
 * 脱敏账户指标候选（方案 029 §5.5）：页面主世界只回传经过数值校验的原值，
 * 绝不携带 Cookie / Token / 响应原文。后台经 normalizeAccount() 归一化后再落库。
 */
export interface AccountMetricCandidate {
  /** data.user.quota 等：当前可用余额（DoCode 语义下即当前余额）。 */
  quota: number | null
  /** data.user.used_quota 等：历史累计消耗。 */
  usedQuota: number | null
  /** data.user.request_count 等：累计请求数。 */
  requestCount: number | null
  /** 直接余额字段（如 balance/remain）。 */
  directBalance: number | null
  /** 站点明确给出的总额度（充值/赠送可破坏 quota+used 假设，无则 null）。 */
  explicitTotalQuota: number | null
  /** 币种（来自响应或站点配置兜底）。 */
  currency: string | null
}

/**
 * 采集失败原因（方案 027 §3.2）：脱敏、枚举化的固定分类。
 * 仅记录枚举错误码、HTTP 状态、pathname 与建议动作；绝不写入 Cookie/Token/响应正文。
 */
export type CollectFailureReason =
  | 'HOST_PERMISSION_MISSING'
  | 'NO_MATCHING_OPEN_TAB'
  | 'PANEL_ORIGIN_SESSION_MISMATCH'
  | 'ACCOUNT_UNAUTHORIZED'
  | 'AUTH_CONTEXT_INCOMPLETE'
  | 'CANDIDATE_REJECTED'
  | 'NETWORK_OR_TIMEOUT'
  | 'NON_JSON_RESPONSE'
  | 'ACCOUNT_CONTRACT_MISMATCH'
  | 'ENDPOINT_UNAVAILABLE'
  | 'SCRIPT_INJECTION_FAILED'
  | 'SW_SESSION_UNAVAILABLE'

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
  /** 结构化失败原因枚举（方案 029 §6）：优先于 status 推导，便于精确呈现（如实验室无会话 vs 接口不可用）。绝不承载私密值。 */
  lastFailureReason?: CollectFailureReason
  /** 最近一次授权结论；无证据的历史 auth_expired 不得直接驱动 UI。 */
  lastAuthEvidence?: AuthEvidence
  /** 最近一次采集轮次，用于阻止旧轮次覆盖新状态。 */
  lastCollectRunId?: string
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
    usageListPath?: string | null
    /** 统计接口（usage/dashboard/stats）已发现 pathname（不含 query）。 */
    usageStatsPath?: string | null
    usageStatsKind?: 'hubway_dashboard_stats' | null
    /** IKunCode 类组合 provider 的已发现 pathname（不含 query）。 */
    accountSnapshotPath?: string | null
    rangeUsagePath?: string | null
    billingConfigPath?: string | null
    /** 账户快照语义契约（方案 027 §3.1）：由脱敏指纹识别，用于区分 quota=余额 还是 quota=总额度。 */
    accountSemantics?: AccountSemantics
    /** 账户契约识别规则版本；便于今后调整识别规则时区分历史发现结果。 */
    accountContractVersion?: number
  }
  /**
   * 用户自定义的采集请求（原样保存，不改写）。
   * 以英文分号分隔，每项可为相对路径或本站完整 URL（如 `/api/v1/auth/me;/api/user/usage`）。
   * 仅同源、GET only，用于扩展采集本站任意可读接口供后续分析（与余额同步解耦）。
   */
  customRequests?: string
  /**
   * 充值比例（站点货币 / 1 人民币）。如 "10" 或 "1:1.1"。
   * 含义：充值 1 人民币到账多少站点计价货币。仅用于真实花费换算展示，非凭证。
   * 解析与校验统一走 `parseRechargeRate`（shared/recharge.ts），保存原始写法（trim 后）。
   */
  rechargeRate?: string
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
  /** 不可变幂等键（P0：跨安装还原去重用）。缺失时由写入层/导出层补齐 crypto.randomUUID()。 */
  recordId?: string
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
  // ===== 统计接口（Hubway 类 usage/dashboard/stats 等）采集字段 =====
  /** 账户累计输入 Token（仅权威字段 total_input_tokens；否则 null）。 */
  cumulativeInputTokens?: number | null
  /** 账户累计输出 Token（仅权威字段 total_output_tokens；否则 null）。 */
  cumulativeOutputTokens?: number | null
  /** 账户累计消费额度/费用（如 IKunCode used_quota 经 quotaToCurrency 转换；否则 null）。 */
  totalConsumedCost?: number | null
  /** 滚动 24 小时使用金额（range_usage rolling_24h 口径；否则 null）。 */
  recent24hCost?: number | null
  /** 滚动 24 小时 Token（range_usage rolling_24h 口径；否则 null）。 */
  recent24hTokens?: number | null
  /** 当前指标的时间窗口口径：calendar_day=自然日 / rolling_24h=近24h / range=自定义。用于 UI 标签区分。 */
  usageWindow?: 'calendar_day' | 'rolling_24h' | 'range' | null
  /** 今日使用金额来源：dashboard_stats(仪表盘统计接口)=权威 / logs(用量日志)=降级。 */
  todayCostSource?: 'dashboard_stats' | 'range_usage' | 'logs' | null
  /** 统计/账户指标来源：dashboard_stats / account_snapshot / range_usage / null。 */
  usageStatsSource?: 'dashboard_stats' | 'account_snapshot' | 'range_usage' | null
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
 * authorized 为兼容字段；授权判定应优先读取 authState。
 */
export interface CredentialRow {
  siteId: string // pk
  method: 'cookie'
  authorized: boolean
  /** 三态授权结论；unknown 表示本轮无法确认，不应覆盖最近明确结论。 */
  authState?: 'authenticated' | 'unauthorized' | 'unknown'
  lastEvidenceAt?: number
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
  /** 不可变幂等键（P0：跨安装还原去重用）。缺失时由写入层/导出层补齐 crypto.randomUUID()。 */
  recordId?: string
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
    cumulativeInputTokens: boolean
    cumulativeOutputTokens: boolean
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
 * `id` 优先用服务端原始 id + 页面 origin 命名空间派生的 SHA-256（稳定可去重）；缺服务端 id 时用内容指纹 SHA-256。
 * `apiKeyId` 字段存的是 MAIN 世界就地派生的伪标识：`k_<sha256(origin + "|k|" + rawKey).slice(0, 16)>`，
 *  原值绝不出页面；命名空间仅用页面自身 `origin`（非秘密，仅用于站点间隔离，不含任何扩展密钥）。
 *  `ip` 同样 hash 化（`ip_<sha256(rawIp).slice(0, 16)>`），原始 IP 永不落库。
 *  ⚠️ `apiKeyLabel` 在 Phase A 已被强制置 null（P0-I1）：通用分类器无法仅凭字段名判断「可读标签是否含密钥」，故只保留不可逆的哈希假标识。
 * `cost` 必带 `costCurrency`（P1-3，禁跨币种求和）；`actualCost/standardCost` 可独立带币种。
 * 限长 / 非负数校验在 MAIN 世界归一化函数里强制执行，不是类型注释。
 */
export interface UsageRecord {
  /** 本地确定性摘要（siteScope + 服务端 raw id → SHA-256 截前 16 位；无 raw id 时用字段哈希） */
  id: string
  /** 调用时间（ms） */
  ts: number
  /** 模型名（限 64 字符） */
  model: string
  /** 提示 token（仅接受有限非负数） */
  promptTokens: number
  /** 生成 token */
  completionTokens: number
  /** 总 token（= prompt + completion，或来自服务端 tokens/total_tokens） */
  tokens: number
  /** 命中缓存的 token（Anthropic prompt caching 读） */
  cacheReadTokens: number | null
  /** 写入缓存的 token（Anthropic prompt caching 写） */
  cacheCreationTokens: number | null
  /** 本笔消耗金额（本币）；无明确字段则 null（UI 显「—」） */
  cost: number | null
  /** 实际消耗金额（如 hubway "实际" 列）；语义未确认时 null */
  actualCost: number | null
  actualCostCurrency: string | null
  /** 标准消耗金额（按官方牌价）；语义未确认时 null */
  standardCost: number | null
  standardCostCurrency: string | null
  /** cost 字段的币种（与站点 currency 一致；P1-3 维度） */
  costCurrency: string
  /** 端点 pathname（仅路径，不含 query/fragment/host；如 /v1/responses） */
  endpoint: string | null
  /** API Key 的伪标识（MAIN 世界无密钥 SHA-256 派生，绝不含原值；仅对明确的密钥字段计算） */
  apiKeyId: string | null
  /** 可读的令牌标签（如 New API 的 token_name），非密钥、不哈希，仅用于筛选/展示区分 */
  apiKeyLabel: string | null
  /** IP 的伪哈希（MAIN 世界 SHA-256 截前 16 位；原 IP 不落库） */
  ipHash: string | null
  /** 推理强度（hubway "推理强度" 列），如 high/medium/low */
  reasoningEffort: string | null
  /** 分组（hubway "分组" 列） */
  group: string | null
  /** 类型（hubway "类型" 列） */
  type: string | null
  /** 计费模式（hubway "计费模式" 列） */
  billingMode: string | null
}

/**
 * 单站单日的用量明细批次（一整日的所有调用记录）。
 * 主键 `siteId:date` —— 同一天多次采集，完整批次优先于不完整批次（P1：防覆盖）。
 * 与同站采集原子提交于 Dexie 事务（putBatch + revision bump）。
 */
/** 用量明细记录 schema 版本（pageCollect 写入批次、usageRecords 回填/校验共用，避免版本漂移）。 */
export const USAGE_RECORD_SCHEMA_VERSION = 2

export interface UsageRecordBatch {
  id: string // pk: `${siteId}:${date}`
  siteId: string
  /** 业务日 YYYY-MM-DD（按站点业务时区，如 hubway=Asia/Shanghai；与接口/主键/查询口径一致） */
  date: string
  /** 批次采集完成时间（ms） */
  collectedAt: number
  /** 兼容字段：等同于 collectedAt（保留旧字段名以减少对历史 UI 引用的大改） */
  takenAt: number
  records: UsageRecord[]
  totalTokens: number
  /** 记录条数。Phase A 始终等于 records.length（截断语义下沉到 isComplete + truncatedReason，不再用 count 表示「实际>已存」）。 */
  recordCount: number
  /** 按币种分组的金额（cost 字段聚合；P1-3，禁单一 totalCost） */
  costByCurrency: Record<string, number>
  /** 按币种分组的实际成本（actual 字段聚合） */
  totalActualCostByCurrency: Record<string, number>
  /** 按币种分组的标准成本（standard 字段聚合） */
  totalStandardCostByCurrency: Record<string, number>
  totalRequests: number
  /** 是否完整采集（false=命中上限被截断，UI 须标「明细不完整」） */
  isComplete: boolean
  truncatedReason?: string | null
  /** 已翻页数（探测/调试用）。Phase A 写入固定为 0（采集上限由 MAX_PAGES/MAX_ITEMS 控制，结果已体现在 isComplete/truncatedReason）。 */
  pageCount: number
  schemaVersion: number
  /** 来源适配器：hubway_v1 | generic */
  source: string
}

/** usageCache 单条缓存（DB v4 新增）。只缓存昂贵聚合/分页结果，不缓存原始记录。 */
export interface UsageCacheEntry {
  /** 主键：sha256(canonical JSON of query params) */
  cacheKey: string
  siteId: string
  /** 缓存类型：dashboard | details | filterOptions */
  kind: 'dashboard' | 'details' | 'filterOptions'
  fromDate: string
  toDate: string
  /** 该 (siteId, date) 当前的 revision（采集时原子自增）；读取时若与最新 revision 不符视为陈旧 */
  revision: string
  /** 缓存生成时间（fetchedAt） */
  fetchedAt: number
  /** 最近访问时间（LRU 维护用） */
  accessedAt: number
  /** 已规范化的载荷（聚合结果 / 分页 / 过滤项；白名单字段） */
  payload: unknown
  schemaVersion: number
  /** payload 的 canonical JSON 字节数（容量控制用） */
  size: number
}

/** 缓存数据来源（用于 UI 标 "实时 / 缓存 X 分钟前 / 记录表聚合"） */
export type UsageDataSource = 'api' | 'local_fallback' | 'cache'

/** 顶部 4 卡聚合指标（单站单日）。 */
export interface UsageTopMetrics {
  totalRequests: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalCostByCurrency: Record<string, number>
  avgResponseMs: number | null
  /** 时间跨度（小时）；单日 = 24h，跨日按实际 hours 计算 */
  windowHours: number
}

/** 单个分布桶（模型/分组/端点 通用结构）。 */
export interface UsageDistributionBucket {
  key: string
  label: string
  requests: number
  tokens: number
  costByCurrency: Record<string, number>
  /** 占总 tokens 的百分比（0-1，UI 自行 *100） */
  ratio: number
}

/** Token 使用趋势多线数据点（按小时或按日聚合）。 */
export interface UsageTrendPoint {
  /** 桶起始时间（ms） */
  ts: number
  /** 桶内 input tokens */
  inputTokens: number
  /** 桶内 output tokens */
  outputTokens: number
  /** 桶内 cache creation tokens */
  cacheCreationTokens: number
  /** 桶内 cache read tokens */
  cacheReadTokens: number
  /** 桶内命中率（0-1，UI 自行 *100 显示为 %） */
  cacheHitRate: number
  requests: number
}

/** 详情表过滤项。 */
export interface UsageFilterValues {
  apiKeyIds: string[]
  models: string[]
  endpoints: string[]
  groups: string[]
  types: string[]
  billingModes: string[]
}

/** 数据源元信息（所有聚合响应都带）。 */
export interface UsageDataMeta {
  source: UsageDataSource
  fetchedAt: number
  /** 底层 usage 记录最后采集时间（ms）；取自 usageRecordsRepo.getLatest 的 collectedAt */
  dataAsOf: number | null
  isStale: boolean
  /** 陈旧分钟数（isStale=true 时有效；新鲜为 0） */
  staleAgeMinutes: number
}

// ─────────────────────────────────────────────────────────────────────────────
// 站点类型与采集方案可视化（方案 028）：只读展示 DTO，绝不持久化第二份策略副本。
// 真实策略的唯一来源是 buildEffectiveStrategy()；本模型仅由其生成并下发展示。
// ─────────────────────────────────────────────────────────────────────────────

/** 脱敏失败摘要（复用诊断的脱敏原则：仅枚举错误码/HTTP 状态/pathname/时间/建议动作）。 */
export interface SafeFailureSummary {
  /** 枚举失败原因；null 表示无失败。 */
  reason: CollectFailureReason | null
  /** HTTP 状态码；0=网络错误/超时。 */
  httpStatus: number | null
  /** 仅 pathname（不含 query 值与 host），如 /api/user/self。 */
  pathname: string | null
  at: number | null
  /** 面向用户的建议动作（固定中文文案）。 */
  suggestedAction: string | null
}

/** 采集方案中的单个指标步骤（方案 028 §5.1）。 */
export interface CollectionPlanStep {
  id: string
  role: 'balance' | 'usage' | 'usage_list' | 'usage_stats' | 'account_snapshot' | 'range_usage' | 'billing_config'
  label: string
  method: 'GET' | 'POST'
  /** 仅 pathname，禁止 query 值。 */
  path: string
  /** 是否允许定时自动采集。 */
  automatic: boolean
  /** 是否会改变会话状态（如 IKunCode refresh）→ 标记「仅手动」。 */
  sideEffect: 'none' | 'session_refresh'
  /** 该步骤预期产出的指标中文标签。 */
  expectedMetrics: string[]
  /** 运行态：已验证/计划尝试/部分可用/不支持/需登录/异常。 */
  state: 'verified' | 'planned' | 'partial' | 'unsupported' | 'unauthorized' | 'failed'
}

/** 单站「类型与采集方案」展示模型（方案 028 §5.1）。 */
export interface SiteCollectionProfile {
  siteId: string
  /** 用户设定的适配器（配置适配器，可编辑）。 */
  configuredAdapter: { id: string; label: string }
  /** 自动识别的站点分类。 */
  classification: {
    family: 'one-api-compatible' | 'new-api-capable' | 'independent' | 'unknown'
    routeProfile: 'standard' | 'fork-path' | 'discovered' | null
    confidence: 'high' | 'medium' | 'low' | null
    probedAt: number | null
    /** 账户快照语义契约（027 §3.1）。 */
    accountSemantics: AccountSemantics | null
    capabilities: string[]
  }
  execution: {
    /** 采集引擎：页面主世界同源会话 / SW 零标签实验室。 */
    engine: 'page_main_world' | 'sw_lab'
    collectorVersion: number
    /** 是否需要同源已登录会话。 */
    requiresSameOriginSession: boolean
    /** 自动采集：enabled=允许 / manual_only=仅手动 / unavailable=不支持。 */
    automaticCollection: 'enabled' | 'manual_only' | 'unavailable'
  }
  steps: CollectionPlanStep[]
  health: {
    lastStatus: SiteStatus
    lastCollectAt: number | null
    latestFailure: SafeFailureSummary | null
  }
}
