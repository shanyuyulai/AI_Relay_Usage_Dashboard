/**
 * 页面主世界采集编排（MV3 可靠路径）。
 *
 * 背景：Service Worker 既读不到 Cookie（chrome.cookies.getAll 全局返回 0），
 * 其 fetch 也带不上鉴权（/api/user/self 直接 401）。
 * 唯一可靠路径是在页面 MAIN 世界采集——那里 document.cookie 真实存在、同源 fetch 自动带 Cookie。
 *
 * 本模块负责：找/开站点标签页 → 注入 collectInPage → 把解析结果落库（不存任何 Cookie/Token 原文，P0-2）。
 */
import { siteRepo, snapshotRepo, dailyStatRepo, captureRepo, purgeOlderThan, getRetentionDays, getLabZeroTab, diagnosticsRepo, usageRecordsRepo } from '../storage'
import { notify } from '../shared/notify'
import { collectViaSw } from './swCollect'
import {
  collectInPage,
  probeSessionInPage,
  captureCustomInPage,
  type PageCollectResult,
  type CustomCaptureItem,
} from '../content/probe'
import { buildStrategy, type CollectStrategy } from '../core/classifySite'
import type { SiteConfig, Snapshot, CustomCaptureRecord, UsageRecordBatch } from '../shared/types'
import type { CollectResult } from './collector'
import { dateKeyInTz, HUBWAY_TZ, todayKey } from '../shared/util'

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
 * 单站采集（标签已解析）：在页面主世界注入 collectInPage 并落库（不存凭证，P0-2）。
 * 仅负责「注入 + 落库」；标签的查找/创建/关闭由编排函数 collectOrchestrate 统一处理。
 */
export async function collectSiteInTab(site: SiteConfig, tabId: number): Promise<CollectResult> {
  // 仅做 contains 检查（不主动 request，避免 SW 中弹授权窗）；缺权限则报错
  const hasPerm = await chrome.permissions.contains({ origins: [`${site.origin}/*`] })
  if (!hasPerm) {
    const msg = '缺少站点 host 权限，请在设置页重新授权'
    await siteRepo.update(site.id, { lastStatus: 'error', lastCollectAt: Date.now(), lastError: msg })
    return { siteId: site.id, ok: false, errorKind: 'NETWORK', message: msg }
  }

  let res: PageCollectResult | undefined
  try {
    // 从 discovered 构建采集策略（若有分类信息则按 capabilities 激活端点）
    const discovered = site.discovered
    let strategyArg: any = null
    if (discovered && discovered.family && discovered.capabilities && discovered.userSelfPath) {
      const strategy = buildStrategy(
        {
          family: discovered.family as any,
          routeProfile: (discovered.routeProfile as any) || 'standard',
          capabilities: discovered.capabilities as any[],
          confidence: (discovered.confidence as any) || 'medium',
          userSelfPath: discovered.userSelfPath,
        },
        discovered.userSelfPath,
        site.currency ?? undefined,
      )
      // 序列化为普通对象给 executeScript（args 会 JSON 序列化）
      strategyArg = {
        endpoints: strategy.endpoints,
        family: strategy.family,
        confidence: strategy.confidence,
        currency: strategy.currency,
        collectorVersion: strategy.collectorVersion,
      }
    }
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: collectInPage,
      args: [site.origin, strategyArg],
    })
    res = frame?.result as PageCollectResult | undefined
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const full = `注入采集脚本失败: ${msg}`
    await siteRepo.update(site.id, { lastStatus: 'error', lastCollectAt: Date.now(), lastError: full })
    return { siteId: site.id, ok: false, errorKind: 'NETWORK', message: full }
  }

  if (!res || typeof res !== 'object') {
    await siteRepo.update(site.id, {
      lastStatus: 'error',
      lastCollectAt: Date.now(),
      lastError: '采集脚本未返回结果（页面主世界注入失败）',
    })
    return { siteId: site.id, ok: false, errorKind: 'NETWORK', message: '采集脚本未返回结果' }
  }

  if (!res.ok) {
    const expired = res.authExpired || !res.cookiePresent
    const status = expired ? 'auth_expired' : 'error'
    const kind = expired ? ('AUTH_EXPIRED' as const) : ('NOT_FOUND' as const)
    await siteRepo.update(site.id, { lastStatus: status, lastCollectAt: Date.now(), lastError: res.reason })
    return { siteId: site.id, ok: false, errorKind: kind, message: res.reason }
  }

  const now = Date.now()
  const snap: Snapshot = {
    siteId: site.id,
    takenAt: now,
    balance: res.balance,
    todayTokens: res.todayTokens,
    todayRequests: res.todayRequests,
    todayCost: res.todayCost,
    totalRequests: res.totalRequests ?? null,
    totalQuota: res.totalQuota,
    currency: res.currency,
    modelUsages: res.modelUsages,
    status: 'ok',
    channel: 'content_script', // 真实来源：页面主世界
    quality: res.todayTokens != null && !res.isPartial ? 'verified' : res.todayTokens != null ? 'partial' : 'unknown',
    family: site.discovered?.family,
    routeProfile: site.discovered?.routeProfile,
    confidence: site.discovered?.confidence,
    balanceSource: 'userSelf',
    usageSource: res.usageSource,
    isPartial: res.isPartial,
    collectorVersion: res.collectorVersion,
    // A0：指标与来源可信度（GPT P0-2/P0-5）
    cumulativeTokens: res.cumulativeTokens,
    cumulativeTokensSource: res.cumulativeTokensSource,
    apiRoundTripMs: res.apiRoundTripMs,
    avgResponseTimeMs: res.avgResponseTimeMs,
    metricsPartial: res.metricsPartial,
  }
  await snapshotRepo.append(snap)
  if (snap.todayTokens != null) await dailyStatRepo.upsertForDay(snap)
  await siteRepo.update(site.id, { lastCollectAt: now, lastStatus: 'ok' })

  // 写入诊断日志（脱敏指纹，P0-1/P0-4 安全边界）
  if (res.diags && res.diags.length > 0) {
    try {
      for (const d of res.diags) {
        await diagnosticsRepo.put({
          siteId: site.id,
          at: now,
          phase: d.phase,
          url: d.url,
          status: d.status,
          contentType: d.contentType,
          elapsedMs: d.elapsedMs,
          fieldFingerprint: d.fieldFingerprint,
          extracted: {
            balance: snap.balance != null,
            todayTokens: snap.todayTokens != null,
            todayRequests: snap.todayRequests != null,
            cumulativeTokens: snap.cumulativeTokens != null,
            totalRequests: snap.totalRequests != null,
            avgResponseTimeMs: snap.avgResponseTimeMs != null,
            todayCost: snap.todayCost != null,
          },
          note: d.note,
        })
      }
      // 汇总诊断
      await diagnosticsRepo.put({
        siteId: site.id,
        at: now,
        phase: 'overall',
        url: res.path ?? '(none)',
        status: 200,
        contentType: '',
        elapsedMs: snap.apiRoundTripMs ?? 0,
        fieldFingerprint: {},
        extracted: {
          balance: snap.balance != null,
          todayTokens: snap.todayTokens != null,
          todayRequests: snap.todayRequests != null,
          cumulativeTokens: snap.cumulativeTokens != null,
          totalRequests: snap.totalRequests != null,
          avgResponseTimeMs: snap.avgResponseTimeMs != null,
          todayCost: snap.todayCost != null,
        },
        note: `采集完成: ok=${res.ok}, usageSource=${res.usageSource ?? 'N/A'}, path=${res.path ?? 'N/A'}, diags=${res.diags.length}条`,
      })
    } catch (e) {
      console.warn('[AI Relay] 诊断日志写入失败（不阻断采集）', e)
    }
  }

  // 写入当日用量明细批次（来自 usage_list 端点，如 hubway /api/v1/usage）
  if (res.usageRecords && res.usageRecords.length > 0) {
    const isHubway = site.discovered?.usageListKind === 'hubway_v1'
    const bizDate = isHubway ? dateKeyInTz(now, HUBWAY_TZ) : todayKey()
    const costByCurrency: Record<string, number> = {}
    let totalTokens = 0
    for (const r of res.usageRecords) {
      totalTokens += r.tokens
      if (r.cost != null) costByCurrency[r.costCurrency] = (costByCurrency[r.costCurrency] || 0) + r.cost
    }
    const batch: UsageRecordBatch = {
      id: `${site.id}:${bizDate}`,
      siteId: site.id,
      date: bizDate,
      takenAt: now,
      records: res.usageRecords,
      totalTokens,
      costByCurrency,
      totalRequests: res.usageRecords.length,
      isComplete: res.usageRecordsComplete,
      truncatedReason: res.usageRecordsTruncatedReason,
      pageCount: 0,
      schemaVersion: 1,
      source: site.discovered?.usageListKind ?? 'generic',
    }
    try {
      await usageRecordsRepo.putBatch(batch)
    } catch (e) {
      console.warn('[AI Relay] 当日用量明细批次写入失败（不阻断采集）', e)
    }
  }

  return { siteId: site.id, ok: true, snapshot: snap }
}

/** 采集全部启用站点。定时 alarm 传 autoOpen=true + notify=true；手动传 notify=false。 */
export async function collectAllInTabs(autoOpen: boolean, notify = false): Promise<CollectResult[]> {
  const sites = (await siteRepo.list()).filter((s) => s.enabled)
  return collectOrchestrate(sites, autoOpen, notify)
}

/** 采集指定站点（侧边栏选择性同步）。 */
export async function collectSpecificInTabs(siteIds: string[], autoOpen: boolean, notify = false): Promise<CollectResult[]> {
  const sites = (await siteRepo.list()).filter((s) => siteIds.includes(s.id) && s.enabled)
  return collectOrchestrate(sites, autoOpen, notify)
}

/**
 * 采集编排：
 * - 已有标签（任意窗口）的站点直接复用，不另行开窗口。
 * - 没有标签的站点分流：实验室开关开启 → 走 SW 零标签采集（collectViaSw，无任何可见窗口）；
 *   否则 autoOpen=true 时在一个「最小化后台窗口（不聚焦、处于底层）」里统一开标签采集、采完关闭（主窗口不留标签）；
 *   autoOpen=false 时跳过并标错。
 * - notify=true 且本轮确实要开临时窗口时，先发一条「醒目 + 需手动关闭」的系统通知与侧边栏横幅（提前提醒），再开窗口；
 *   会话过期、实验室失败也分别通知。
 */
async function collectOrchestrate(sites: SiteConfig[], autoOpen: boolean, notifyFlag: boolean): Promise<CollectResult[]> {
  const labEnabled = await getLabZeroTab()

  // 1) 查已有标签
  const existingBySite = new Map<string, number>()
  const missing: SiteConfig[] = []
  for (const site of sites) {
    const existing = await chrome.tabs.query({ url: `${site.origin}/*` })
    const tabId = existing[0]?.id
    if (tabId != null) existingBySite.set(site.id, tabId)
    else missing.push(site)
  }

  // 2) 缺失站点分流 + 任务装配
  const missingByWindow: SiteConfig[] = []
  const tasks: Promise<CollectResult>[] = []
  for (const site of sites) {
    const tabId = existingBySite.get(site.id)
    if (tabId != null) {
      tasks.push(collectSiteInTab(site, tabId)) // 复用已有标签
      continue
    }
    if (labEnabled) {
      tasks.push(collectViaSw(site)) // 实验室：SW 内零标签采集，无可见窗口
    } else {
      missingByWindow.push(site)
    }
  }

  // 3) 为缺失且非实验室的站点开一个临时「最小化后台窗口」（不聚焦、处于底层，采完关闭）
  let tempWinId: number | null = null
  const tempBySite = new Map<string, number>()
  if (missingByWindow.length && autoOpen) {
    // 提前醒目提醒：在开窗口之前发出（仅自动采集 notifyFlag=true 时），让用户有心理准备且不被打断
    if (notifyFlag) {
      await notify(
        'AI 中转站用量看板 即将后台采集',
        `将在「最小化后台窗口」中静默采集 ${missingByWindow.length} 个未打开的站点，不抢焦点、不打断你的操作，采完自动关闭。`,
        { requireInteraction: true, priority: 2 },
      )
      try {
        chrome.runtime.sendMessage({
          type: 'COLLECT_NOTICE',
          detail: `后台采集即将在最小化窗口静默进行（不抢焦点、不打断你的操作），采完自动关闭`,
        })
      } catch {
        /* 侧边栏未打开时忽略（无接收端） */
      }
    }
    // 记录用户当前聚焦的窗口，开完临时窗口后把焦点还回去，确保绝不打断
    const prevWin = await chrome.windows.getLastFocused().catch(() => null)
    try {
      const win = await chrome.windows.create({
        url: missingByWindow[0].baseUrl,
        focused: false,
        state: 'minimized', // 真正处于底层（最小化到任务栏），不弹到前台、不打断用户
      })
      // 重新聚焦用户原本的窗口（双重保险，防止个别平台新建窗口瞬间抢焦点）
      if (prevWin?.id != null && win?.id != null && prevWin.id !== win.id) {
        await chrome.windows.update(prevWin.id, { focused: true }).catch(() => {})
      }
      if (win?.id != null) {
        tempWinId = win.id
        const firstTab = win.tabs?.[0]?.id
        if (firstTab != null) tempBySite.set(missingByWindow[0].id, firstTab)
        for (let i = 1; i < missingByWindow.length; i++) {
          const t = await chrome.tabs.create({ windowId: win.id, url: missingByWindow[i].baseUrl, active: false })
          if (t.id != null) tempBySite.set(missingByWindow[i].id, t.id)
        }
        await Promise.all([...tempBySite.values()].map((id) => waitForTabLoad(id)))
      }
    } catch {
      tempWinId = null
    }
    for (const site of missingByWindow) {
      const tabId = tempBySite.get(site.id)
      if (tabId != null) tasks.push(collectSiteInTab(site, tabId))
      else {
        const msg = '站点标签页未打开，且未开启自动开窗口采集'
        tasks.push(
          (async () => {
            await siteRepo.update(site.id, { lastStatus: 'error', lastCollectAt: Date.now(), lastError: msg })
            return { siteId: site.id, ok: false, errorKind: 'NETWORK' as const, message: msg }
          })(),
        )
      }
    }
  } else if (missingByWindow.length) {
    // 不开窗口、也不走实验室 → 全部标错
    for (const site of missingByWindow) {
      const msg = '站点标签页未打开，且未开启自动开窗口/实验室采集'
      tasks.push(
        (async () => {
          await siteRepo.update(site.id, { lastStatus: 'error', lastCollectAt: Date.now(), lastError: msg })
          return { siteId: site.id, ok: false, errorKind: 'NETWORK' as const, message: msg }
        })(),
      )
    }
  }

  const results = await Promise.all(tasks)

  // 4) 关闭临时窗口（其中采集已完成）
  if (tempWinId != null) {
    try {
      await chrome.windows.remove(tempWinId)
    } catch {
      /* ignore */
    }
  }

  // 5) 通知（提前提醒已在开窗口前发出；此处仅补充异常类提醒）
  if (notifyFlag) {
    const expired = results.filter((r) => r.errorKind === 'AUTH_EXPIRED')
    if (expired.length) {
      const names = expired.map((r) => sites.find((s) => s.id === r.siteId)?.name ?? r.siteId)
      await notify('AI 中转站用量看板 · 会话过期', `以下站点登录态已失效，请在浏览器打开并登录后继续：${names.join('、')}`)
    }
    if (labEnabled) {
      const labFailed = results.filter((r) => !r.ok && (r.message ?? '').includes('实验室'))
      if (labFailed.length) {
        const names = labFailed.map((r) => sites.find((s) => s.id === r.siteId)?.name ?? r.siteId)
        await notify(
          'AI 中转站用量看板 · 实验室采集提示',
          `以下站点零标签采集失败（多为 CORS / 需 Token）：${names.join('、')}；可在设置关闭实验室选项或保持标签登录`,
        )
      }
    }
  }

  await pruneAfterCollect()
  return results
}

/** 采集完成后按保留策略清理过期数据（best-effort；每日 alarm 也会兜底）。 */
async function pruneAfterCollect(): Promise<void> {
  try {
    await purgeOlderThan(await getRetentionDays())
  } catch (e) {
    console.warn('[AI Relay] 采集后清理失败', e)
  }
}

/**
 * 页面主世界「会话探测」（供 AUTHORIZE/TEST 使用）。
 * 必须在已打开且已登录的站点标签页中执行——SW 读不到 Cookie，无法替代。
 * 仅确认是否存在返回用户信息的接口，不要求余额字段。
 */
export async function probeSessionInTab(site: SiteConfig): Promise<{
  ok: boolean
  reason: string
  status: number | null
  cookiePresent: boolean
  localStorageKeys: string[]
  sessionStorageKeys: string[]
}> {
  const existing = await chrome.tabs.query({ url: `${site.origin}/*` })
  const tabId = existing[0]?.id
  if (tabId == null) {
    return { ok: false, reason: '站点标签页未打开，请在浏览器中打开并登录该站点后再试', status: null, cookiePresent: false, localStorageKeys: [], sessionStorageKeys: [] }
  }
  try {
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: probeSessionInPage,
      args: [site.origin, site.discovered?.userSelfPath ?? null],
    })
    const res = frame?.result as any
    if (!res || typeof res !== 'object') {
      return { ok: false, reason: '会话探测脚本未返回结果', status: null, cookiePresent: false, localStorageKeys: [], sessionStorageKeys: [] }
    }
    return {
      ok: res.ok,
      reason: res.reason,
      status: res.status ?? null,
      cookiePresent: res.cookiePresent,
      localStorageKeys: res.localStorageKeys ?? [],
      sessionStorageKeys: res.sessionStorageKeys ?? [],
    }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e), status: null, cookiePresent: false, localStorageKeys: [], sessionStorageKeys: [] }
  }
}

/**
 * 页面主世界「自定义请求采集」编排（按需按钮触发，与余额同步解耦）。
 * 解析用户配置的分号串 → 找/开站点标签页 → 注入 captureCustomInPage → 逐条落 captureRepo。
 * 仅同源、GET only、不触碰任何凭证（P0-2）。
 */
export async function captureCustomInTab(site: SiteConfig): Promise<{
  recorded: number
  failed: number
  errors: string[]
}> {
  const raw = site.customRequests?.trim()
  if (!raw) {
    return { recorded: 0, failed: 0, errors: ['未配置自定义请求'] }
  }
  const urls = raw
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)

  const existing = await chrome.tabs.query({ url: `${site.origin}/*` })
  let tabId = existing[0]?.id
  if (tabId == null) {
    const tab = await chrome.tabs.create({ url: site.baseUrl, active: false })
    if (tab.id == null) {
      return { recorded: 0, failed: urls.length, errors: ['无法创建标签页'] }
    }
    tabId = tab.id
    await waitForTabLoad(tabId)
  }

  let items: CustomCaptureItem[] | undefined
  try {
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: captureCustomInPage,
      args: [site.origin, urls],
    })
    items = frame?.result as CustomCaptureItem[] | undefined
  } catch (e) {
    return { recorded: 0, failed: urls.length, errors: [e instanceof Error ? e.message : String(e)] }
  }

  if (!items || !Array.isArray(items)) {
    return { recorded: 0, failed: urls.length, errors: ['采集脚本未返回结果'] }
  }

  const now = Date.now()
  let recorded = 0
  const errors: string[] = []
  for (const it of items) {
    const rec: CustomCaptureRecord = {
      id: crypto.randomUUID(),
      siteId: site.id,
      url: it.url,
      status: it.status,
      contentType: it.contentType,
      capturedAt: it.capturedAt || now,
      ok: it.ok,
      json: it.json,
      error: it.error,
    }
    await captureRepo.put(rec)
    recorded += 1
    // 以「请求是否成功(ok)」为失败判定；HTTP 错误给出明确标识（评审项 4）
    if (!it.ok) errors.push(`${it.url}: ${it.error ?? ('HTTP ' + (it.status ?? '?'))}`)
  }
  return { recorded, failed: errors.length, errors }
}
