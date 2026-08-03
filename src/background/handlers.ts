import {
  siteRepo,
  credentialRepo,
  snapshotRepo,
  dailyStatRepo,
  captureRepo,
  diagnosticsRepo,
  db,
  getRetentionDays,
  setRetentionDays,
  getCollectInterval,
  setCollectInterval,
  getLabZeroTab,
  setLabZeroTab,
  getLabCorsUnblock,
  setLabCorsUnblock,
  usageRecordsRepo,
} from '../storage'
import { applyCorsRules, refreshCorsRules } from './corsRules'
import { collectAllInTabs, collectSpecificInTabs, probeSessionInTab, captureCustomInTab } from './pageCollect'
import { applyInterval } from './scheduler'
import { registry } from '../adapters'
import { normalizeOrigin, todayKey, dateKey, dateKeyInTz, HUBWAY_TZ } from '../shared/util'
import type {
  CollectResultMsg,
  SiteSummary,
  TotalsByCurrency,
  DashboardData,
  SiteDetailData,
  ExportConfig,
  AddSitePayload,
  UpdateSitePayload,
  DeleteSitePayload,
  SiteIdPayload,
  CollectNowPayload,
  CaptureCustomPayload,
  GetCapturesPayload,
  ClearCapturesPayload,
  RetentionPayload,
  RetentionResponse,
  CollectIntervalPayload,
  CollectIntervalResponse,
  LabZeroTabPayload,
  LabZeroTabResponse,
  LabCorsPayload,
  LabCorsResponse,
  GetUsageRecordsPayload,
  GetUsageRecordsResponse,
  GetSiteDataPayload,
  GetSiteDataResponse,
  ResetSiteDataPayload,
  ResetAllDataPayload,
  ResetDataResponse,
} from '../core/messaging/protocol'
import type { Req } from '../core/messaging/protocol'
import type { SiteConfig } from '../shared/types'
import { probeSiteEndpoints, type ProbeResult } from '../content/probe'
import { classifySite, type SiteFingerprint, type EndpointSignal } from '../core/classifySite'
import { discoverNetworkRequests, type NetDiscoveryRequest } from './netDiscovery'

type Handler = (payload: any, req: Req) => Promise<unknown>

const COLORS = ['#5B8FF9', '#61DDAA', '#F6BD16', '#7262FD', '#78D3F8', '#F6903D', '#FF9D4D']

/** 等待标签页加载完成（最多 10s）。 */
function waitForTabLoad(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    let resolved = false
    const listener = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabId && info.status === 'complete') {
        resolved = true
        chrome.tabs.onUpdated.removeListener(listener)
        resolve()
      }
    }
    chrome.tabs.onUpdated.addListener(listener)
    setTimeout(() => {
      if (!resolved) {
        chrome.tabs.onUpdated.removeListener(listener)
        resolve()
      }
    }, 10000)
  })
}

/**
 * 用「页面主世界会话探测」确认登录态并持久化授权标记（M1 仅 Cookie 会话，不存任何私密）。
 * 必须在已登录的站点标签页中执行——SW 读不到 Cookie，detectSession 在 SW 里必失败（带空 Cookie）。
 */
async function authorizeCookie(siteId: string): Promise<'ok' | 'expired'> {
  const site = await siteRepo.get(siteId)
  if (!site) return 'expired'
  try {
    const r = await probeSessionInTab(site)
    const ok = r.ok
    await credentialRepo.setAuthorized(siteId, ok)
    return ok ? 'ok' : 'expired'
  } catch {
    await credentialRepo.setAuthorized(siteId, false)
    return 'expired'
  }
}

// 站点变更（增/改/删）后广播，触发侧边栏实时刷新最新数据（无接收方时吞异常，与 COLLECT_DONE 一致）
function broadcastSitesChanged() {
  try {
    void chrome.runtime.sendMessage({ type: 'SITES_CHANGED' })
  } catch {
    /* 无接收方时忽略 */
  }
}

export const handlers: Record<string, Handler> = {
  // 主动同步（侧边栏「立即同步」）：走页面主世界采集（MV3 可靠路径）
  async COLLECT_NOW(payload: CollectNowPayload) {
    const results: CollectResultMsg[] = (
      payload?.siteIds?.length
        ? await collectSpecificInTabs(payload.siteIds, true, false)
        : await collectAllInTabs(true, false)
    ).map((r) => ({
      siteId: r.siteId,
      ok: r.ok,
      errorKind: r.errorKind,
      message: r.message,
      snapshot: r.snapshot,
    }))
    return { results }
  },

  // 仪表盘总览（P1-3：按币种分组，不跨币种相加）
  async GET_DASHBOARD() {
    const sites = await siteRepo.list()
    const summaries: SiteSummary[] = []
    const totals: TotalsByCurrency = {}
    for (const site of sites) {
      const latest = (await snapshotRepo.latest(site.id, 1))[0]
      summaries.push({ site, latest, lastStatus: site.lastStatus })
      if (latest && latest.balance != null && latest.currency) {
        const cur = latest.currency
        const t =
          totals[cur] ??
          (totals[cur] = {
            currency: cur,
            totalBalance: 0,
            totalTodayTokens: 0,
            totalTodayRequests: 0,
            sites: 0,
          })
        t.totalBalance += latest.balance
        if (latest.todayTokens != null) t.totalTodayTokens += latest.todayTokens
        if (latest.todayRequests != null) t.totalTodayRequests += latest.todayRequests
        t.sites += 1
      }
    }
    const data: DashboardData = { sites: summaries, totals }
    return data
  },

  // 站点详情 / 趋势
  async GET_SITE_DETAIL(payload: SiteIdPayload) {
    const site = await siteRepo.get(payload.id)
    if (!site) throw new Error('站点不存在')
    const snapshots = await snapshotRepo.latest(payload.id, 60)
    const daily = await dailyStatRepo.range(
      payload.id,
      dateKey(Date.now() - 30 * 86_400_000),
      todayKey(),
    )
    const data: SiteDetailData = { site, snapshots, dailyStats: daily }
    return data
  },

  // 站点列表（Options）
  async GET_SITES() {
    return siteRepo.list()
  },

  // 新增站点：权限由 UI 侧（用户手势）申请，SW 仅校验是否已授予（P0-5 逐站授权）
  async ADD_SITE(payload: AddSitePayload) {
    if (!registry.has(payload.type)) throw new Error(`未知站点类型: ${payload.type}`)
    const origin = normalizeOrigin(payload.baseUrl)
    const granted = await chrome.permissions.contains({ origins: [`${origin}/*`] })
    if (!granted) throw new Error('未获得该站点的 host 权限，请在设置页添加并授权')
    const id = crypto.randomUUID()
    const site: SiteConfig = {
      id,
      name: payload.name || origin,
      baseUrl: payload.baseUrl,
      origin,
      adapter: payload.type,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      enabled: true,
      order: await siteRepo.nextOrder(),
      createdAt: Date.now(),
      lastCollectAt: null,
      lastStatus: 'unknown',
      currency: payload.currency || 'USD',
    }
    await siteRepo.add(site)
    await credentialRepo.setAuthorized(id, false) // 尚未授权
    void refreshCorsRules() // 若 CORS 放行开启，同步新增规则
    broadcastSitesChanged() // 通知侧边栏实时刷新
    return { siteId: id }
  },

  async UPDATE_SITE(payload: UpdateSitePayload) {
    const existing = await siteRepo.get(payload.id)
    if (!existing) throw new Error('站点不存在')
    const patch: Partial<SiteConfig> = {}
    if (payload.patch.name != null) patch.name = payload.patch.name
    // baseUrl 变化时：后台单向派生 origin 并校验权限（P0-5，不信任 UI 传来的 origin）
    if (payload.patch.baseUrl != null && payload.patch.baseUrl !== existing.baseUrl) {
      const origin = normalizeOrigin(payload.patch.baseUrl)
      const granted = await chrome.permissions.contains({ origins: [`${origin}/*`] })
      if (!granted) throw new Error('未获得新地址的 host 权限，请在编辑时授权')
      patch.baseUrl = payload.patch.baseUrl
      patch.origin = origin
    }
    if (payload.patch.enabled != null) patch.enabled = payload.patch.enabled
    if (payload.patch.currency != null) patch.currency = payload.patch.currency
    // 用户可编辑字段白名单：UI 可改的站点配置，SW 单向拷贝；
    // 绝不在此暴露 discovered/lastStatus/lastCollectAt 等内部派生字段，防止 UI 误覆盖。
    // 新增可编辑字段只需在此数组追加，避免「忘了加白名单 → 配置丢失」的复发 bug。
    if (payload.patch.customRequests != null) patch.customRequests = payload.patch.customRequests
    await siteRepo.update(payload.id, patch)
    void refreshCorsRules() // 若 CORS 放行开启，同步启用/禁用规则
    broadcastSitesChanged() // 通知侧边栏实时刷新
    return { ok: true }
  },

  // 删除站点（级联清理凭证与历史，见 siteRepo.remove）
  // 返回引用计数结论：仅当无其他站点使用该 origin 时，UI 才应撤销权限
  async DELETE_SITE(payload: DeleteSitePayload) {
    const target = await siteRepo.get(payload.id)
    if (!target) throw new Error('站点不存在')
    await siteRepo.remove(payload.id)
    await credentialRepo.clear(payload.id)
    broadcastSitesChanged() // 通知侧边栏实时刷新
    void refreshCorsRules() // 若 CORS 放行开启，移除该站规则
    // 引用计数：以 IndexedDB 为权威数据源（防 UI 快照过时）
    const remaining = await siteRepo.list()
    const stillUsed = remaining.some((s) => s.origin === target.origin)
    return { permissionsRevoked: !stillUsed }
  },

  // 连通性自检 / 授权（M1 仅 Cookie 会话）
  async TEST_SITE(payload: SiteIdPayload) {
    const status = await authorizeCookie(payload.id)
    return { status }
  },

  async AUTHORIZE_SITE(payload: SiteIdPayload) {
    const status = await authorizeCookie(payload.id)
    return { status }
  },

  /**
   * 页面主世界端点探测。
   * MV3 Service Worker 的 chrome.cookies 常读不到 Cookie，且 SPA 前端路由会伪装成 API 路径。
   * 此 handler 在目标页主世界注入 probeSiteEndpoints，直接利用页面 Cookie/LocalStorage 探测真实 JSON 接口。
   */
  async DISCOVER_ENDPOINTS(payload: SiteIdPayload) {
    const site = await siteRepo.get(payload.id)
    if (!site) throw new Error('站点不存在')

    // 查找已打开的目标页标签；没有则静默打开一个后台标签。
    const existing = await chrome.tabs.query({ url: `${site.origin}/*` })
    let tabId = existing[0]?.id
    if (!tabId) {
      const tab = await chrome.tabs.create({ url: site.baseUrl, active: false })
      if (!tab.id) throw new Error('无法创建标签页')
      tabId = tab.id
      await waitForTabLoad(tabId)
    }

    // 在页面主世界执行探测函数（可访问页面真实 Cookie）。
    const [frameResult] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: probeSiteEndpoints,
      args: [site.origin],
    })

    // executeScript 已 await 注入函数并解析其结果，frameResult.result 即解析后的对象（非 Promise）
    const result = (frameResult?.result as ProbeResult | undefined) ?? null
    if (!result) throw new Error('探测脚本未返回结果')

    // 若命中真实接口，持久化到站点配置供后续采集使用。
    if (result.match) {
      // 从探测尝试中构建脱敏指纹（P0-4：仅类型/结构��息，不含 JSON 原文）
      const signals: EndpointSignal[] = result.attempts.map((a) => {
        const hasDataArray = a.hasDataArray ?? false
        const hasHourlyStructure = a.hasHourlyStructure ?? false
        let pathKey = 'unknown'
        if (a.url.endsWith('/api/v1/auth/me')) pathKey = 'authMe'
        else if (a.url.endsWith('/api/user/self')) pathKey = 'userSelf'
        else if (a.url.endsWith('/api/v1/user/self')) pathKey = 'userSelfV1'
        else if (a.url.includes('/api/user')) pathKey = 'userApi'
        else if (a.url.includes('/api/user/dashboard')) pathKey = 'dashboard'
        else if (a.url.includes('/api/log/self')) pathKey = 'logSelf'
        else if (a.url.includes('/api/data/self')) pathKey = 'dataSelf'
        else if (a.url.includes('/api/v1/usage')) pathKey = 'usageV1'
        else if (a.url.includes('/api/usage')) pathKey = 'usageList'
        else pathKey = new URL(a.url).pathname.replace(/\//g, '_').replace(/^_/, '')
        return {
          pathKey,
          status: a.status,
          contentType: a.contentType,
          isJson: a.contentType.includes('json'),
          hasDataArray,
          hasHourlyStructure,
          hasSuccessWrapper: a.hasWrapper,
          successValue: null,
          hasDataObject: a.topKeys.includes('data') || a.topKeys.some((k) => a.dataFieldTypes?.[k] === 'object'),
          dataFieldTypes: a.dataFieldTypes ?? {},
          dataFieldNames: a.dataFieldNames ?? [],
          hasUserId: a.hasUserId ?? false,
        }
      })

      // 检查 localStorage 中是否有 token（取自主世界探针回传的 localStorageKeys）
      const hasToken = result.localStorageKeys.some(
        (k) => ['token', 'access_token', 'auth_token', 'userToken', 'Authorization', 'auth'].includes(k),
      )

      const fp: SiteFingerprint = {
        signals,
        bestPathKey: result.match.path === '/api/user/self' ? 'userSelf'
          : result.match.path === '/api/v1/auth/me' ? 'authMe'
          : result.match.path.startsWith('/api/v1') ? 'userSelfV1'
          : 'unknown',
        hasLocalStorageToken: hasToken,
      }

      const classification = classifySite(fp)

      await siteRepo.update(site.id, {
        discovered: {
          userSelfPath: result.match.path,
          userSelfUrl: result.match.url,
          probedAt: Date.now(),
          family: classification.family,
          routeProfile: classification.routeProfile,
          capabilities: classification.capabilities,
          confidence: classification.confidence,
          usageListKind: classification.usageListKind ?? null,
        },
      })
    }

    return result
  },

  /**
   * 网络请求捕获式接口发现（Service Worker + chrome.webRequest）。
   * 适用：标准路径全 404、真实 API 前缀未知的站点（如 rayinai/hubway）。
   * 相比页面主世界 hook fetch/XHR，webRequest 不依赖注入时机，reload 后不会丢失监听。
   * 仅记录元数据（URL/方法/状态码/Content-Type），不记录 Cookie/Authorization/请求体/响应体（P0-2）。
   */
  async DISCOVER_VIA_NETWORK(payload: SiteIdPayload) {
    const site = await siteRepo.get(payload.id)
    if (!site) throw new Error('站点不存在')

    const existing = await chrome.tabs.query({ url: `${site.origin}/*` })
    let tabId = existing[0]?.id
    if (!tabId) {
      const tab = await chrome.tabs.create({ url: site.baseUrl, active: false })
      if (!tab.id) throw new Error('无法创建标签页')
      tabId = tab.id
      await waitForTabLoad(tabId)
    }

    // 监听 15 秒并自动重载标签页，触发 SPA 初始化请求；期间捕获的所有非静态请求回传。
    const captured = await discoverNetworkRequests(site.origin, 15000, tabId)
    return { captured }
  },

  /**
   * 自定义采集请求：在页面主世界采集用户配置的分号分隔地址。
   * 按需触发（Options 按钮），与余额同步完全解耦；失败不影响主链路。
   */
  async CAPTURE_CUSTOM(payload: CaptureCustomPayload) {
    const site = await siteRepo.get(payload.id)
    if (!site) throw new Error('站点不存在')
    return captureCustomInTab(site)
  },

  /** 获取某站全部自定义采集捕获（导出用）。 */
  async GET_CAPTURES(payload: GetCapturesPayload) {
    const site = await siteRepo.get(payload.id)
    if (!site) throw new Error('站点不存在')
    return captureRepo.listBySite(payload.id)
  },

  /** 清空某站自定义采集捕获。 */
  async CLEAR_CAPTURES(payload: ClearCapturesPayload) {
    const site = await siteRepo.get(payload.id)
    if (!site) throw new Error('站点不存在')
    await captureRepo.clearBySite(payload.id)
    return { ok: true }
  },

  // ── 诊断日志：查询 / 清空（脱敏指纹，P0-1/P0-4） ──
  async GET_DIAGNOSTICS(payload: { id: string }) {
    const site = await siteRepo.get(payload.id)
    if (!site) throw new Error('站点不存在')
    return diagnosticsRepo.listBySite(payload.id)
  },

  async CLEAR_DIAGNOSTICS(payload: { id: string }) {
    const site = await siteRepo.get(payload.id)
    if (!site) throw new Error('站点不存在')
    await diagnosticsRepo.clearBySite(payload.id)
    return { ok: true }
  },

  // ── 当日用量明细批次：按站点 + 业务日查询（供详情页「当日使用趋势」画图）──
  async GET_USAGE_RECORDS(payload: GetUsageRecordsPayload) {
    const site = await siteRepo.get(payload.id)
    if (!site) throw new Error('站点不存在')
    // 业务日时区：hubway_v1 固定 Asia/Shanghai；未知采集器回落浏览器本地日界（P0：时区一致）。
    const isHubway = site.discovered?.usageListKind === 'hubway_v1'
    const date = payload.date ?? (isHubway ? dateKeyInTz(Date.now(), HUBWAY_TZ) : todayKey())
    const batch = await usageRecordsRepo.getBySiteDate(payload.id, date)
    if (!batch) {
      return {
        siteId: payload.id,
        date,
        isComplete: false,
        takenAt: 0,
        source: '',
        records: [],
        totalTokens: 0,
        totalRequests: 0,
        costByCurrency: {},
      } satisfies GetUsageRecordsResponse
    }
    return {
      siteId: batch.siteId,
      date: batch.date,
      isComplete: batch.isComplete,
      takenAt: batch.takenAt,
      source: batch.source,
      records: batch.records,
      totalTokens: batch.totalTokens,
      totalRequests: batch.totalRequests,
      costByCurrency: batch.costByCurrency,
    } satisfies GetUsageRecordsResponse
  },

  // ── 保留策略：读取 / 设置（默认 30 天，0 表示永久） ──
  async GET_RETENTION(): Promise<RetentionResponse> {
    return { days: await getRetentionDays() }
  },

  async SET_RETENTION(payload: RetentionPayload): Promise<RetentionResponse> {
    await setRetentionDays(payload.days)
    return { days: await getRetentionDays() }
  },

  // ── 自动采集间隔：读取 / 设置（默认 30 分钟，'off' 表示关闭）──
  async GET_COLLECT_INTERVAL(): Promise<CollectIntervalResponse> {
    return { interval: await getCollectInterval() }
  },

  async SET_COLLECT_INTERVAL(payload: CollectIntervalPayload): Promise<CollectIntervalResponse> {
    await setCollectInterval(payload.interval)
    await applyInterval() // 即时重建采集 alarm，免重启扩展
    return { interval: await getCollectInterval() }
  },

  // ── 实验室：SW 零标签后台采集开关（默认关闭，需用户显式知情同意）──
  async GET_LAB_ZEROTAB(): Promise<LabZeroTabResponse> {
    return { enabled: await getLabZeroTab() }
  },

  async SET_LAB_ZEROTAB(payload: LabZeroTabPayload): Promise<LabZeroTabResponse> {
    return { enabled: await setLabZeroTab(payload.enabled === true) }
  },

  // ── 实验室：动态 CORS 放行开关（默认关闭）──
  async GET_LAB_CORS(): Promise<LabCorsResponse> {
    return { enabled: await getLabCorsUnblock() }
  },

  async SET_LAB_CORS(payload: LabCorsPayload): Promise<LabCorsResponse> {
    const enabled = await setLabCorsUnblock(payload.enabled === true)
    await applyCorsRules(enabled) // 即时添加/移除 declarativeNetRequest 规则
    return { enabled }
  },

  /**
   * 数据查看器：取某站全部已采集数据（余额历史 / 每日用量 / 自定义采集）+ 摘要。
   * 仅读取，不删不改；绝不回显凭证（快照/用量本就不存凭证，自定义采集已脱敏）。
   */
  async GET_SITE_DATA(payload: GetSiteDataPayload): Promise<GetSiteDataResponse> {
    const ALL_SITES_ID = '__all__'
    const isAll = payload.siteId === ALL_SITES_ID

    if (!isAll) {
      const site = await siteRepo.get(payload.siteId)
      if (!site) throw new Error('站点不存在')
    }

    const [snapshots, dailyStats, captures] = await Promise.all([
      isAll ? snapshotRepo.all() : snapshotRepo.allBySite(payload.siteId),
      isAll ? dailyStatRepo.all() : dailyStatRepo.allBySite(payload.siteId),
      isAll ? captureRepo.listAll() : captureRepo.listBySite(payload.siteId),
    ])

    let earliestTs: number | null = null
    let latestTs: number | null = null
    for (const s of snapshots) {
      if (earliestTs == null || s.takenAt < earliestTs) earliestTs = s.takenAt
      if (latestTs == null || s.takenAt > latestTs) latestTs = s.takenAt
    }
    const estBytes =
      JSON.stringify(snapshots).length +
      JSON.stringify(dailyStats).length +
      JSON.stringify(captures).length

    const data: GetSiteDataResponse = {
      snapshots,
      dailyStats,
      captures,
      summary: {
        snapshotCount: snapshots.length,
        dailyCount: dailyStats.length,
        captureCount: captures.length,
        earliestTs,
        latestTs,
        estBytes,
      },
    }
    return data
  },

  /**
   * 手动重置：清空某站的全部采集数据（snapshots/dailyStats/captures）。
   * 不影响站点配置、凭证与设置（配置隔离）。
   */
  async RESET_SITE_DATA(payload: ResetSiteDataPayload): Promise<ResetDataResponse> {
    const site = await siteRepo.get(payload.siteId)
    if (!site) throw new Error('站点不存在')
    const deleted = await db.transaction(
      'rw',
      db.snapshots,
      db.dailyStats,
      db.captures,
      async () => {
        const snapshots = await db.snapshots.where('siteId').equals(payload.siteId).delete()
        const dailyStats = await db.dailyStats.where('siteId').equals(payload.siteId).delete()
        const captures = await db.captures.where('siteId').equals(payload.siteId).delete()
        return { snapshots, dailyStats, captures }
      },
    )
    return { deleted }
  },

  /**
   * 手动重置：清空全部站点的采集数据（跨站）。
   * 不影响站点配置、凭证与设置。
   */
  async RESET_ALL_DATA(_payload: ResetAllDataPayload): Promise<ResetDataResponse> {
    // clear() 不返回删除条数，先统计再清空
    const counts = await db.transaction('r', db.snapshots, db.dailyStats, db.captures, async () => ({
      snapshots: await db.snapshots.count(),
      dailyStats: await db.dailyStats.count(),
      captures: await db.captures.count(),
    }))
    await db.snapshots.clear()
    await db.dailyStats.clear()
    await db.captures.clear()
    return { deleted: counts }
  },

  // 导出配置：仅站点配置，零凭证/私密（红线）
  async EXPORT_CONFIG() {
    const sites = await siteRepo.list()
    const config: ExportConfig = {
      version: 1,
      exportedAt: Date.now(),
      sites: sites.map((s) => ({ ...s })),
    }
    return config
  },

  // 导入配置：UI 侧已申请权限，SW 逐站 contains 校验 + 白名单构造（P0-2 不信任导入文件字段）
  async IMPORT_CONFIG(payload: { config: ExportConfig }) {
    const sites = payload.config?.sites ?? []
    let imported = 0
    for (const s of sites) {
      // 校验适配器类型（不信任导入文件的 adapter 字段）
      if (!registry.has(s.adapter)) continue
      const origin = normalizeOrigin(s.baseUrl)
      const granted = await chrome.permissions.contains({ origins: [`${origin}/*`] })
      if (!granted) continue
      // 白名单构造 + 生成新 ID（不信任导入文件的 id，防冲突/伪造）
      const site: SiteConfig = {
        id: crypto.randomUUID(),
        name: s.name || origin,
        baseUrl: s.baseUrl,
        origin,
        adapter: s.adapter,
        color: s.color || COLORS[Math.floor(Math.random() * COLORS.length)],
        enabled: s.enabled ?? true,
        order: await siteRepo.nextOrder(),
        createdAt: Date.now(),
        lastCollectAt: null,
        lastStatus: 'unknown',
      }
      await siteRepo.add(site)
      await credentialRepo.setAuthorized(site.id, false)
      imported += 1
    }
    return { imported }
  },
}
