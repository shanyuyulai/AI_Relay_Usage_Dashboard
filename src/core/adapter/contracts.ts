import type { Snapshot, CollectErrorKind } from '../../shared/types'
import { getPath } from '../../shared/parse'

/** 鉴权探测上下文：仅用于「测试授权」，非每次采集前置（见 P0-1）。 */
export interface SessionContext {
  siteId: string
  baseUrl: string // 归一化后的具体 origin
  cookies: chrome.cookies.Cookie[] // SW 实时读取，不落库
  cookieString: string // 预构造的 Cookie 请求头值
  /** 页面主世界探测到的真实用户信息接口路径（若有）。 */
  discoveredPath?: string
}

/** 采集上下文：必须绑定 siteId（红线：无全局采集）。cookies 由 SW 实时读取。 */
export interface CollectContext {
  siteId: string
  baseUrl: string
  cookies: chrome.cookies.Cookie[]
  /** 预构造的 Cookie 请求头值（`name=value; name2=value2`），用于 MV3 SW 中 fetch 可能不自动附带 cookie 时的兜底注入。 */
  cookieString: string
  /** 页面主世界探测到的真实用户信息接口路径（若有）。 */
  discoveredPath?: string
}

/** DOM 兜底采集上下文：content script 在已登录页内同源 fetch 后回传的可克隆 JSON（不传 Document，见 P0-1）。 */
export interface DomContext {
  siteId: string
  payload: unknown
}

export type SessionStatus = 'ok' | 'expired' | 'unknown'

/** 今日用量查询区间（epoch ms）。 */
export interface UsageRange {
  from: number
  to: number
}

/** 站点精确用量日志的一条记录（来自 fetchUsageLogs，P0-3 禁余额差分）。 */
export interface UsageLog {
  ts: number
  tokens: number
  requests: number | null // 部分接口仅有额度无请求数，未知则 null
  model: string
}

/** PARSE 错误脱敏诊断（绝不含响应体原文 / cookie / token / 用户数据，P1-1）。 */
export interface ParseDiagnostics {
  endpoint: string // 出错接口路径
  statusCode: number // HTTP 状态码
  missingFields?: string[] // 缺失的字段路径
  responseHash: string // 响应体脱敏后哈希，跨次比对「是否同一结构」
  apiVersion: string | null // 探测到的接口版本
}

/** 采集失败统一错误，便于 UI 分类呈现与重试。 */
export class CollectError extends Error {
  constructor(
    public readonly kind: CollectErrorKind,
    message: string,
    public readonly siteId: string,
    public readonly diagnostics?: ParseDiagnostics,
  ) {
    super(message)
    this.name = 'CollectError'
  }
}

/** 适配器契约（P1-1）：脱敏样本 + 必填字段 + 版本探测，用于契约测试与 PARSE 诊断。 */
export interface AdapterContract {
  /** 一次真实采集响应的脱敏样本（仅字段结构 + 匿名化数值，不含私密）。 */
  sample: unknown
  /** 期望必有的字段路径，如 ['quota']；collect 解析前做存在性校验。 */
  requiredFields: string[]
  /** 由响应特征推断接口版本，用于「版本变更」告警。 */
  detectVersion?: (sample: unknown) => string | null
}

/** 站点适配器接口——全插件唯一需为不同中转站写代码之处；加一个新站点类型 = 新增一个 adapter 文件。 */
export interface SiteAdapter {
  readonly id: string
  readonly name: string
  readonly description: string
  /** 该类型所需的 host 权限。不写 *.com；运行时按 baseUrl 归一化为具体 origin 后合并申请（P0-5）。 */
  readonly requiredScopes: string[]
  /** 被动采集 content script 的 URL 匹配（由具体 origin 派生，禁止 *.com 通配）。 */
  readonly collectPageMatches: string[]
  /** 轻量鉴权探测（可选，仅「测试授权」用，见 P0-1）。 */
  detectSession?(ctx: SessionContext): Promise<SessionStatus>
  /** 采集：返回一个真实快照（失败抛 CollectError，绝不返回假数据）。 */
  collect(ctx: CollectContext): Promise<Snapshot>
  /** 可选 DOM 兜底采集（二期）。不实现则跳过降级路径。 */
  collectViaDom?(ctx: DomContext): Promise<Partial<Snapshot>>
  /** 可选：今日用量唯一可信来源（P0-3）。Collector 在 collect 后调用，回填 todayTokens/byModel。返回 null 表示「无精确用量来源」（形态不符），区别于空数组（有来源但为 0）。 */
  fetchUsageLogs?(ctx: CollectContext, range: UsageRange): Promise<UsageLog[] | null>
  /** 可选：适配器契约（P1-1）。 */
  contract?: AdapterContract
}

/** 校验必填字段，返回缺失的路径列表（空数组表示全部存在）。 */
export function missingRequiredFields(obj: unknown, fields: string[]): string[] {
  return fields.filter((f) => getPath(obj, f) === undefined)
}
