/**
 * usageCache.ts — 用量聚合缓存层（DB v4 新增）
 *
 * 定位：
 *   - Service Worker 读不到页面 Cookie，不能"自行调 API"刷新。
 *   - "API 优先"的真实路径：UI → 后台 → 触发已配置站点的页面 MAIN 世界采集
 *     （collectSpecificInTabs，复用 pageCollect 的现有链路）→ 写 usageRecords → 实时聚合。
 *   - 网络/会话失败时回退到 usageRecords 已物化的数据；连数据都没有才回退过期缓存（stale-if-error）。
 *   - 本层仅缓存昂贵的"聚合结果"，不缓存原始记录（避免 IndexedDB 双份长期副本）。
 *
 * 一致性模型：
 *   - 读数据与读 revision 必须来自同一只读事务（usageRecordsRepo.getSnapshot），
 *     否则并发采集会把旧数据配上新 revision，导致缓存长期误命中。
 *   - revision 严格单调递增，由 putBatch / clearBySite / clearOlderThan 在写事务内推进。
 *   - 缓存命中条件：revision 完全相等 且 未过 TTL 且 身份字段（siteId/kind/日期区间）校验通过。
 */
import { db } from './db'
import { siteRepo } from './config'
import { usageRecordsRepo, revKey } from './usageRecords'
import type {
  UsageCacheEntry,
  UsageDataMeta,
  UsageDataSource,
  UsageDistributionBucket,
  UsageFilterValues,
  UsageRecord,
  UsageTopMetrics,
  UsageTrendPoint,
} from '../shared/types'

// ===== TTL / 容量（按 kind 区分） =====
const TTL_MS: Record<UsageCacheEntry['kind'], number> = {
  dashboard: 30 * 60 * 1000,
  details: 10 * 60 * 1000,
  filterOptions: 60 * 60 * 1000,
}
const MAX_ENTRIES: Record<UsageCacheEntry['kind'], number> = {
  dashboard: 20,
  details: 50,
  filterOptions: 30,
}
const MAX_BYTES: Record<UsageCacheEntry['kind'], number> = {
  dashboard: 2 * 1024 * 1024,
  details: 4 * 1024 * 1024,
  filterOptions: 256 * 1024,
}
const DETAIL_PAGE_SIZE_CAP = 100 // 分页硬上限
const MAX_DETAIL_PAGE = 1000 // 页码硬上限（防止缓存键因超大页码膨胀，GPT P1-page-bound）

/** 安全整数化：容忍 number/数字字符串，拒绝 NaN/Infinity/负数越界，归一到 [min,max]。 */
function clampInt(v: unknown, def: number, min: number, max: number): number {
  let n: number
  if (typeof v === 'number' && Number.isFinite(v)) n = Math.floor(v)
  else if (typeof v === 'string' && /^\d+$/.test(v.trim())) n = parseInt(v, 10)
  else n = NaN
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, n))
}

/** 详情缓存行投影：仅保留展示字段，剔除 apiKeyId/ipHash 等标识，避免缓存放大敏感副本（GPT P1-S6）。 */
function projectDetailRow(r: UsageRecord): UsageRecord {
  return {
    id: r.id,
    ts: r.ts,
    model: r.model,
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
    tokens: r.tokens,
    cacheReadTokens: r.cacheReadTokens,
    cacheCreationTokens: r.cacheCreationTokens,
    cost: r.cost,
    costCurrency: r.costCurrency,
    actualCost: r.actualCost,
    actualCostCurrency: r.actualCostCurrency,
    standardCost: r.standardCost,
    standardCostCurrency: r.standardCostCurrency,
    endpoint: r.endpoint,
    apiKeyId: null,
    apiKeyLabel: null,
    ipHash: null,
    reasoningEffort: r.reasoningEffort,
    group: r.group,
    type: r.type,
    billingMode: r.billingMode,
  }
}

// ===== 工具：canonical JSON + SHA-256 键 =====
function canonicalJson(v: unknown): string {
  if (v === null) return 'null'
  if (typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']'
  const keys = Object.keys(v as Record<string, unknown>).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson((v as Record<string, unknown>)[k])).join(',') + '}'
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  const bytes = new Uint8Array(buf)
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0')
  return out
}

/** 缓存键：kind + SHA-256(canonical(params))。碰撞概率可忽略，读取时仍做身份字段二次校验。 */
async function makeKey(kind: UsageCacheEntry['kind'], params: Record<string, unknown>): Promise<string> {
  return kind + ':' + (await sha256Hex(canonicalJson(params)))
}

function makeMeta(source: UsageDataSource, fetchedAt: number, dataAsOf: number | null, isStale: boolean): UsageDataMeta {
  return {
    source,
    fetchedAt,
    dataAsOf,
    isStale,
    staleAgeMinutes: isStale && dataAsOf ? Math.max(0, Math.floor((fetchedAt - dataAsOf) / 60000)) : 0,
  }
}

// ===== 业务日 → UTC 毫秒区间 =====
/** 严格日历校验：拒绝 2024-02-31 这类会被 Date.parse 归一化的假日期。 */
function validateDate(d: unknown): d is string {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false
  const [y, m, day] = d.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, day))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === day
}

/** 业务日 [起, 止) 的 UTC 毫秒边界。tzOffsetMinutes 为业务时区相对 UTC 的偏移（东八区 = +480）。 */
function dayBounds(date: string, tzOffsetMinutes: number): { startMs: number; endMs: number } {
  const startMs = Date.parse(date + 'T00:00:00Z') - tzOffsetMinutes * 60000
  return { startMs, endMs: startMs + 86400000 }
}

// ===== LRU + TTL 清理 =====
async function cleanupKind(kind: UsageCacheEntry['kind']): Promise<void> {
  const all = await db.usageCache.where('kind').equals(kind).toArray()
  const now = Date.now()
  const victims: string[] = []
  let kept = 0
  let totalBytes = 0
  // accessedAt 降序：最近访问的优先保留
  const sorted = [...all].sort((a, b) => b.accessedAt - a.accessedAt)
  for (const e of sorted) {
    const expired = now - e.fetchedAt > TTL_MS[kind]
    if (expired || kept >= MAX_ENTRIES[kind] || totalBytes + e.size > MAX_BYTES[kind]) {
      victims.push(e.cacheKey)
      continue
    }
    kept++
    totalBytes += e.size
  }
  if (victims.length) await db.usageCache.bulkDelete(victims)
}

// ===== 聚合函数 =====
/** Use normalized total tokens when the provider has no input/output split. */
function recordTokenTotal(r: UsageRecord): number {
  if (Number.isFinite(r.tokens) && r.tokens >= 0) return r.tokens
  return Math.max(0, r.promptTokens) + Math.max(0, r.completionTokens)
}

/** Keep the input/output chart useful for token_used-only providers. */
function recordTokenParts(r: UsageRecord): { input: number; output: number } {
  const input = Math.max(0, r.promptTokens)
  const output = Math.max(0, r.completionTokens)
  if (input > 0 || output > 0) return { input, output }
  return { input: 0, output: recordTokenTotal(r) }
}

function aggregateTopMetrics(records: UsageRecord[], hoursWindow: number): UsageTopMetrics {
  const totalCostByCurrency: Record<string, number> = {}
  let totalRequests = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheRead = 0
  let cacheCreation = 0
  // 平均响应：明细里没有精确的单次耗时字段，一律 null（禁模拟数据，UI 显「—」）
  for (const r of records) {
    totalRequests++
    const parts = recordTokenParts(r)
    inputTokens += parts.input
    outputTokens += parts.output
    cacheRead += r.cacheReadTokens ?? 0
    cacheCreation += r.cacheCreationTokens ?? 0
    if (r.cost != null) totalCostByCurrency[r.costCurrency] = (totalCostByCurrency[r.costCurrency] || 0) + r.cost
  }
  return {
    totalRequests,
    totalTokens: records.reduce((sum, r) => sum + recordTokenTotal(r), 0),
    inputTokens,
    outputTokens,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    totalCostByCurrency,
    avgResponseMs: null,
    windowHours: hoursWindow,
  }
}

/**
 * 分布聚合。tokens 口径与顶部卡片对齐：一律用 prompt+completion，
 * 不用服务端可能与之不一致的 r.tokens，保证各分片 ratio 之和恒为 1。
 * 高基数收敛（GPT P1-分布）：单日最多 200 条记录时，唯一值可达 200；保留 Top 15
 * （按 Token 降序）+「其他」合并桶，避免 doughnut 扇区失控、图例过长、Chart.js 重绘
 * 卡顿；ratio 在收敛后重新归一化保证总和恒为 1。
 */
const MAX_DISTRIBUTION_BUCKETS = 15
const OTHERS_LABEL = '其他'
function aggregateDistribution(
  records: UsageRecord[],
  pick: (r: UsageRecord) => string | null,
  totalTokens: number,
): UsageDistributionBucket[] {
  const map = new Map<string, UsageDistributionBucket>()
  for (const r of records) {
    const key = pick(r) ?? '未分类'
    let b = map.get(key)
    if (!b) {
      b = { key, label: key, requests: 0, tokens: 0, costByCurrency: {}, ratio: 0 }
      map.set(key, b)
    }
    b.requests++
    b.tokens += recordTokenTotal(r)
    if (r.cost != null) b.costByCurrency[r.costCurrency] = (b.costByCurrency[r.costCurrency] || 0) + r.cost
  }
  const sorted = [...map.values()].sort((a, b) => b.tokens - a.tokens)
  const top = sorted.slice(0, MAX_DISTRIBUTION_BUCKETS)
  const rest = sorted.slice(MAX_DISTRIBUTION_BUCKETS)
  if (rest.length > 0) {
    // 用合成 key 避免与服务端原始「其他」标签冲突
    const mergedKey = `__merged_other__:${OTHERS_LABEL}`
    const others: UsageDistributionBucket = {
      key: mergedKey,
      label: OTHERS_LABEL,
      requests: 0,
      tokens: 0,
      costByCurrency: {},
      ratio: 0,
    }
    for (const b of rest) {
      others.requests += b.requests
      others.tokens += b.tokens
      for (const cur of Object.keys(b.costByCurrency)) {
        others.costByCurrency[cur] = (others.costByCurrency[cur] || 0) + b.costByCurrency[cur]
      }
    }
    top.push(others)
  }
  for (const b of top) b.ratio = totalTokens > 0 ? b.tokens / totalTokens : 0
  return top
}

/** 按业务日的 24 个整点桶聚合；桶边界由业务时区决定，落在区间外的记录忽略。 */
function aggregateTrend(records: UsageRecord[], startMs: number, endMs: number): UsageTrendPoint[] {
  const HOUR = 3600 * 1000
  const buckets = new Map<number, UsageTrendPoint>()
  for (let t = startMs; t < endMs; t += HOUR) {
    buckets.set(t, {
      ts: t,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      cacheHitRate: 0,
      requests: 0,
    })
  }
  for (const r of records) {
    if (r.ts < startMs || r.ts >= endMs) continue
    const hourTs = startMs + Math.floor((r.ts - startMs) / HOUR) * HOUR
    const b = buckets.get(hourTs)
    if (!b) continue
    const parts = recordTokenParts(r)
    b.inputTokens += parts.input
    b.outputTokens += parts.output
    b.cacheCreationTokens += r.cacheCreationTokens ?? 0
    b.cacheReadTokens += r.cacheReadTokens ?? 0
    b.requests++
  }
  for (const b of buckets.values()) {
    const total = b.inputTokens + b.cacheReadTokens
    b.cacheHitRate = total > 0 ? b.cacheReadTokens / total : 0
  }
  return [...buckets.values()].sort((a, b) => a.ts - b.ts)
}

function aggregateFilterOptions(records: UsageRecord[]): UsageFilterValues {
  const apiKeyIds = new Set<string>()
  const models = new Set<string>()
  const endpoints = new Set<string>()
  const groups = new Set<string>()
  const types = new Set<string>()
  const billingModes = new Set<string>()
  for (const r of records) {
    if (r.apiKeyId) apiKeyIds.add(r.apiKeyId)
    if (r.model) models.add(r.model)
    if (r.endpoint) endpoints.add(r.endpoint)
    if (r.group) groups.add(r.group)
    if (r.type) types.add(r.type)
    if (r.billingMode) billingModes.add(r.billingMode)
  }
  return {
    apiKeyIds: [...apiKeyIds].sort(),
    models: [...models].sort(),
    endpoints: [...endpoints].sort(),
    groups: [...groups].sort(),
    types: [...types].sort(),
    billingModes: [...billingModes].sort(),
  }
}

// ===== 刷新（network-first） =====
/** 成功后的最小刷新间隔：避免多面板同时打开时反复触发采集（可能开临时窗口）。 */
const MIN_REFRESH_INTERVAL_MS = 60 * 1000
/** 失败后的退避更短，便于用户切页/重试时尽快再试一次。 */
const FAILED_REFRESH_BACKOFF_MS = 15 * 1000
const lastRefresh = new Map<string, { at: number; ok: boolean }>()
const inflightRefresh = new Map<string, Promise<RefreshResult>>()

export type RefreshMode = 'auto' | 'force' | 'cache-only'
interface RefreshResult {
  ok: boolean
  skipped?: boolean
  reason?: string
}

async function doRefresh(siteId: string): Promise<RefreshResult> {
  const site = await siteRepo.get(siteId)
  if (!site || !site.enabled) return { ok: false, reason: 'site missing or disabled' }
  try {
    // 动态 import：storage → background 若用静态 import 会与 pageCollect → usageCache 形成循环依赖。
    const { collectSpecificInTabs } = await import('../background/pageCollect')
    // autoOpen=true（无可见标签时开一个不聚焦的后台窗口，采完自动关）；notify=false（不弹通知）
    const results = await collectSpecificInTabs([siteId], true, false)
    const r = results[0]
    if (r?.ok && r.usageApiOk) return { ok: true }
    if (r?.ok) return { ok: false, reason: 'usage API unavailable or not persisted' }
    return { ok: false, reason: r?.message ?? 'collect failed' }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

async function tryRefresh(siteId: string, mode: RefreshMode): Promise<RefreshResult> {
  if (mode === 'cache-only') return { ok: false, skipped: true, reason: 'cache-only' }
  // 在途去重优先于节流：force 正在跑时，后到的 auto 应复用它而不是被节流拒绝
  const running = inflightRefresh.get(siteId)
  if (running) return running
  if (mode === 'auto') {
    const last = lastRefresh.get(siteId)
    if (last) {
      const cooldown = last.ok ? MIN_REFRESH_INTERVAL_MS : FAILED_REFRESH_BACKOFF_MS
      if (Date.now() - last.at < cooldown) return { ok: false, skipped: true, reason: 'throttled' }
    }
  }
  const p = doRefresh(siteId)
    .then((r) => {
      lastRefresh.set(siteId, { at: Date.now(), ok: r.ok })
      return r
    })
    .catch((e) => {
      lastRefresh.set(siteId, { at: Date.now(), ok: false })
      return { ok: false, reason: e instanceof Error ? e.message : String(e) } as RefreshResult
    })
    .finally(() => {
      inflightRefresh.delete(siteId)
    })
  inflightRefresh.set(siteId, p)
  return p
}

function sourceOf(refresh: RefreshResult): { source: UsageDataSource; isStale: boolean } {
  if (refresh.ok) return { source: 'api', isStale: false }
  return { source: 'local_fallback', isStale: true }
}

// ===== 缓存读写 =====
async function storeCache(
  cacheKey: string,
  siteId: string,
  kind: UsageCacheEntry['kind'],
  fromDate: string,
  toDate: string,
  expectedRevision: string,
  payload: unknown,
): Promise<void> {
  const json = JSON.stringify(payload)
  const now = Date.now()
  const entry: UsageCacheEntry = {
    cacheKey,
    siteId,
    kind,
    fromDate,
    toDate,
    revision: expectedRevision,
    fetchedAt: now,
    accessedAt: now,
    payload,
    schemaVersion: 1,
    size: new TextEncoder().encode(json).byteLength,
  }
  // 在包含 usageRecords/settings/usageCache 的 rw 事务内重新读取区间 revision 并比对：
  // 若与计算时不一致（如 clearBySite/clearOlderThan 已推进 revision 并删缓存），放弃写回旧 payload，
  // 杜绝「清理事务与旧聚合计算并发 → 旧 payload 被重新写回」的复活竞态（GPT P0-S1）。
  await db.transaction('rw', db.usageRecords, db.settings, db.usageCache, async () => {
    const raw = await db.usageRecords
      .where('siteId')
      .equals(siteId)
      .filter((b) => b.date >= fromDate && b.date <= toDate)
      .toArray()
    const dates = new Set<string>([fromDate, toDate, ...raw.map((b) => b.date)])
    const parts: string[] = []
    for (const d of [...dates].sort()) {
      const row = await db.settings.get(revKey(siteId, d))
      parts.push(d + '=' + ((row?.value as string) ?? '0'))
    }
    if (parts.join(',') !== expectedRevision) return
    await db.usageCache.put(entry)
  })
  await cleanupKind(kind)
}

/**
 * 读缓存并判定是否新鲜：
 *   revision 完全相等 + 未过 TTL + 身份字段一致（防哈希碰撞读到别站/别日的载荷）。
 */
async function readFreshCache(
  cacheKey: string,
  kind: UsageCacheEntry['kind'],
  siteId: string,
  fromDate: string,
  toDate: string,
  revision: string,
): Promise<UsageCacheEntry | null> {
  const cur = await db.usageCache.get(cacheKey)
  if (!cur) return null
  if (cur.kind !== kind || cur.siteId !== siteId || cur.fromDate !== fromDate || cur.toDate !== toDate) return null
  if (Date.now() - cur.fetchedAt > TTL_MS[kind]) return null
  if (cur.revision !== revision) return null
  // 只更新 accessedAt 字段，不整条 put（避免与 cleanup 的删除竞态把已淘汰条目写回）
  void db.usageCache.update(cacheKey, { accessedAt: Date.now() })
  return cur
}

/** stale-if-error 兜底：忽略 TTL，但仍校验身份字段与 revision（GPT P0-S1：绝不忽略 revision）。 */
async function readStaleCache(
  cacheKey: string,
  kind: UsageCacheEntry['kind'],
  siteId: string,
  fromDate: string,
  toDate: string,
  revision: string,
): Promise<UsageCacheEntry | null> {
  const cur = await db.usageCache.get(cacheKey)
  if (!cur) return null
  if (cur.kind !== kind || cur.siteId !== siteId || cur.fromDate !== fromDate || cur.toDate !== toDate) return null
  if (cur.revision !== revision) return null
  return cur
}

// ===== 对外接口 =====
export interface UsageQueryOptions {
  /** 业务日 YYYY-MM-DD（必填，由 handler 按站点业务时区解析后传入） */
  date: string
  /** 业务时区相对 UTC 的偏移分钟数（东八区 = 480），决定日界与趋势桶边界 */
  tzOffsetMinutes: number
  mode?: RefreshMode
}

export interface GetDashboardResult {
  topMetrics: UsageTopMetrics | null
  distributions: {
    model: UsageDistributionBucket[]
    group: UsageDistributionBucket[]
    endpoint: UsageDistributionBucket[]
  } | null
  tokenTrend: UsageTrendPoint[]
  records: number
  meta: UsageDataMeta
}

export interface GetDetailsResult {
  rows: UsageRecord[]
  total: number
  page: number
  pageSize: number
  /** 当日明细是否完整（false=命中 200 条硬上限被截断） */
  isComplete: boolean
  truncatedReason?: string | null
  meta: UsageDataMeta
}

export interface GetFilterOptionsResult extends UsageFilterValues {
  meta: UsageDataMeta
}

interface DashboardPayload {
  topMetrics: UsageTopMetrics | null
  distributions: GetDashboardResult['distributions']
  tokenTrend: UsageTrendPoint[]
  records: number
  dataAsOf: number | null
}
interface DetailsPayload {
  rows: UsageRecord[]
  total: number
  dataAsOf: number | null
  isComplete: boolean
  truncatedReason: string | null
}
interface FilterOptionsPayload extends UsageFilterValues {
  dataAsOf: number | null
}

function assertOptions(siteId: string, opts: UsageQueryOptions): void {
  if (!siteId) throw new Error('缺少站点 id')
  if (!validateDate(opts.date)) throw new Error('日期非法，应为存在的 YYYY-MM-DD')
  if (!Number.isFinite(opts.tzOffsetMinutes) || Math.abs(opts.tzOffsetMinutes) > 14 * 60) {
    throw new Error('时区偏移非法')
  }
}

export const usageCache = {
  /**
   * Dashboard 聚合（顶部卡片 + 3 个分布 + Token 趋势）。
   * mode: 'auto'（缓存新鲜直接返回，否则节流后触发采集）/ 'force'（手动刷新）/ 'cache-only'（离线）。
   */
  async getDashboard(siteId: string, opts: UsageQueryOptions): Promise<GetDashboardResult> {
    assertOptions(siteId, opts)
    const d = opts.date
    const mode = opts.mode ?? 'auto'
    const cacheKey = await makeKey('dashboard', { siteId, date: d, tz: opts.tzOffsetMinutes })

    // 1) 只有明确要求 cache-only 时才先读缓存；默认 auto/force 必须先尝试页面 API。
    if (mode === 'cache-only') {
      const snap0 = await usageRecordsRepo.getSnapshot(siteId, d, d)
      const hit = await readFreshCache(cacheKey, 'dashboard', siteId, d, d, snap0.revision)
      if (hit) {
        const p = hit.payload as DashboardPayload
        return { ...p, meta: makeMeta('cache', Date.now(), p.dataAsOf, false) }
      }
    }

    // 2) network-first：触发一次采集
    const refresh = await tryRefresh(siteId, mode)

    // 3) 一致性快照：记录与 revision 同一事务读取
    const snap = await usageRecordsRepo.getSnapshot(siteId, d, d)
    const { startMs, endMs } = dayBounds(d, opts.tzOffsetMinutes)
    // P1-S4：业务日语义只定义一次——所有聚合复用同一份按 [startMs,endMs) 过滤后的记录
    const records = snap.batches.flatMap((b) => b.records).filter((r) => r.ts >= startMs && r.ts < endMs)
    const dataAsOf = snap.batches.length ? Math.max(...snap.batches.map((b) => b.collectedAt)) : null

    if (records.length === 0) {
      // P0-S1：仅在刷新失败时才回退 stale；成功刷新得到空集必须返回空集（否则展示已删/旧数据）
      if (!refresh.ok) {
        const stale = await readStaleCache(cacheKey, 'dashboard', siteId, d, d, snap.revision)
        if (stale) {
          const p = stale.payload as DashboardPayload
          return { ...p, meta: makeMeta('cache', Date.now(), p.dataAsOf, true) }
        }
      }
      const { source, isStale } = sourceOf(refresh)
      return {
        topMetrics: null,
        distributions: null,
        tokenTrend: [],
        records: 0,
        meta: makeMeta(source, Date.now(), dataAsOf, isStale),
      }
    }

    const topMetrics = aggregateTopMetrics(records, 24)
    const distributions = {
      model: aggregateDistribution(records, (r) => r.model, topMetrics.totalTokens),
      group: aggregateDistribution(records, (r) => r.group, topMetrics.totalTokens),
      endpoint: aggregateDistribution(records, (r) => r.endpoint, topMetrics.totalTokens),
    }
    const tokenTrend = aggregateTrend(records, startMs, endMs)

    const payload: DashboardPayload = { topMetrics, distributions, tokenTrend, records: records.length, dataAsOf }
    await storeCache(cacheKey, siteId, 'dashboard', d, d, snap.revision, payload)

    const { source, isStale } = sourceOf(refresh)
    return { topMetrics, distributions, tokenTrend, records: records.length, meta: makeMeta(source, Date.now(), dataAsOf, isStale) }
  },

  /** 详细表分页查询（带过滤 + 分页）。 */
  async getDetails(
    siteId: string,
    opts: UsageQueryOptions & {
      filters?: {
        apiKeyId?: string
        model?: string
        endpoint?: string
        group?: string
        type?: string
        billingMode?: string
      }
      page?: number
      pageSize?: number
    },
  ): Promise<GetDetailsResult> {
    assertOptions(siteId, opts)
    const d = opts.date
    const mode = opts.mode ?? 'auto'
    const page = clampInt(opts.page, 1, 1, MAX_DETAIL_PAGE)
    const pageSize = clampInt(opts.pageSize, 50, 1, DETAIL_PAGE_SIZE_CAP)
    // canonical filters：剔除空值 + 键排序，保证同义查询命中同一 key
    const filters: Record<string, string> = {}
    for (const k of Object.keys(opts.filters ?? {}).sort()) {
      const v = (opts.filters as Record<string, string | undefined>)[k]
      if (typeof v === 'string' && v.length > 0) filters[k] = v
    }
    const cacheKey = await makeKey('details', { siteId, date: d, tz: opts.tzOffsetMinutes, filters, page, pageSize })

    if (mode === 'cache-only') {
      const snap0 = await usageRecordsRepo.getSnapshot(siteId, d, d)
      const hit = await readFreshCache(cacheKey, 'details', siteId, d, d, snap0.revision)
      if (hit) {
        const p = hit.payload as DetailsPayload
        return {
          rows: p.rows,
          total: p.total,
          page,
          pageSize,
          isComplete: p.isComplete,
          truncatedReason: p.truncatedReason,
          meta: makeMeta('cache', Date.now(), p.dataAsOf, false),
        }
      }
    }

    const refresh = await tryRefresh(siteId, mode)
    const snap = await usageRecordsRepo.getSnapshot(siteId, d, d)
    const { startMs, endMs } = dayBounds(d, opts.tzOffsetMinutes)
    // P1-S4：业务日语义统一，详情也只统计落在当日的记录
    const allRecords = snap.batches.flatMap((b) => b.records).filter((r) => r.ts >= startMs && r.ts < endMs)
    const dataAsOf = snap.batches.length ? Math.max(...snap.batches.map((b) => b.collectedAt)) : null

    if (allRecords.length === 0) {
      // P0-S1：仅在刷新失败时才回退 stale
      if (!refresh.ok) {
        const stale = await readStaleCache(cacheKey, 'details', siteId, d, d, snap.revision)
        if (stale) {
          const p = stale.payload as DetailsPayload
          return {
            rows: p.rows,
            total: p.total,
            page,
            pageSize,
            isComplete: p.isComplete,
            truncatedReason: p.truncatedReason,
            meta: makeMeta('cache', Date.now(), p.dataAsOf, true),
          }
        }
      }
    }

    const filtered = allRecords.filter((r) => {
      if (filters.apiKeyId && r.apiKeyId !== filters.apiKeyId) return false
      if (filters.model && r.model !== filters.model) return false
      if (filters.endpoint && r.endpoint !== filters.endpoint) return false
      if (filters.group && r.group !== filters.group) return false
      if (filters.type && r.type !== filters.type) return false
      if (filters.billingMode && r.billingMode !== filters.billingMode) return false
      return true
    })

    // 倒序（最新在前）；id 作稳定的二次排序键，避免同毫秒记录分页时抖动
    filtered.sort((a, b) => b.ts - a.ts || a.id.localeCompare(b.id))
    const total = filtered.length
    const start = (page - 1) * pageSize
    const rows = filtered.slice(start, start + pageSize)
    // P1-S6：缓存前对 rows 投影，剔除 apiKeyId/ipHash 等标识，避免缓存放大敏感副本
    const projected = rows.map(projectDetailRow)

    // isComplete：是否截断（用于 UI 标「明细不完整」）。所有命中当日的批次中，任一不完整即视为整体截断。
    const completeBatches = snap.batches.filter((b) => b.isComplete)
    const isComplete = completeBatches.length === snap.batches.length
    const truncatedReason = isComplete
      ? null
      : snap.batches.find((b) => !b.isComplete)?.truncatedReason ?? null
    const payload: DetailsPayload = {
      rows: projected,
      total,
      dataAsOf,
      isComplete,
      truncatedReason,
    }
    await storeCache(cacheKey, siteId, 'details', d, d, snap.revision, payload)

    const { source, isStale } = sourceOf(refresh)
    return {
      rows: projected,
      total,
      page,
      pageSize,
      isComplete,
      truncatedReason,
      meta: makeMeta(source, Date.now(), dataAsOf, isStale),
    }
  },

  /** 过滤项（UI 下拉）。默认 cache-only：下拉项不值得单独触发一次采集。 */
  async getFilterOptions(siteId: string, opts: UsageQueryOptions): Promise<GetFilterOptionsResult> {
    assertOptions(siteId, opts)
    const d = opts.date
    const mode = opts.mode ?? 'cache-only'
    const cacheKey = await makeKey('filterOptions', { siteId, date: d, tz: opts.tzOffsetMinutes })

    if (mode === 'cache-only') {
      const snap0 = await usageRecordsRepo.getSnapshot(siteId, d, d)
      const hit = await readFreshCache(cacheKey, 'filterOptions', siteId, d, d, snap0.revision)
      if (hit) {
        const { dataAsOf, ...values } = hit.payload as FilterOptionsPayload
        return { ...values, meta: makeMeta('cache', Date.now(), dataAsOf, false) }
      }
    }

    const refresh = await tryRefresh(siteId, mode)
    const snap = await usageRecordsRepo.getSnapshot(siteId, d, d)
    const { startMs, endMs } = dayBounds(d, opts.tzOffsetMinutes)
    // P1-S4：与 dashboard/details 一致，仅统计落在当日的记录
    const records = snap.batches.flatMap((b) => b.records).filter((r) => r.ts >= startMs && r.ts < endMs)
    const dataAsOf = snap.batches.length ? Math.max(...snap.batches.map((b) => b.collectedAt)) : null
    const values = aggregateFilterOptions(records)

    const payload: FilterOptionsPayload = { ...values, dataAsOf }
    await storeCache(cacheKey, siteId, 'filterOptions', d, d, snap.revision, payload)

    const { source, isStale } = sourceOf(refresh)
    return { ...values, meta: makeMeta(source, Date.now(), dataAsOf, isStale) }
  },

  /**
   * 采集完成时调用：清除该站点与写入日期区间相交的所有缓存条目。
   * 相交判定：entry.fromDate <= maxWritten && entry.toDate >= minWritten。
   */
  async invalidate(siteId: string, dates: string[]): Promise<void> {
    if (!siteId || !dates.length) return
    const sorted = [...dates].sort()
    const minD = sorted[0]
    const maxD = sorted[sorted.length - 1]
    const all = await db.usageCache.where('siteId').equals(siteId).toArray()
    const victims = all.filter((e) => e.fromDate <= maxD && e.toDate >= minD).map((e) => e.cacheKey)
    if (victims.length) await db.usageCache.bulkDelete(victims)
  },

  /** 站点删除时调用：清空该站点所有缓存。 */
  async clearBySite(siteId: string): Promise<void> {
    await db.usageCache.where('siteId').equals(siteId).delete()
  },
}
