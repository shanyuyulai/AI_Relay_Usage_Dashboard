import { siteRepo } from '../storage'

const RULE_ID_BASE = 10_000

/**
 * 将站点 id 映射为稳定的 declarativeNetRequest ruleId。
 * 注意：Chrome 规则 id 是 32 位正整数，hash 后取模避免溢出。
 */
function ruleIdFor(siteId: string): number {
  let hash = 0
  for (let i = 0; i < siteId.length; i++) {
    hash = (hash * 31 + siteId.charCodeAt(i)) >>> 0
  }
  return RULE_ID_BASE + (hash % 90_000)
}

/**
 * 为已启用站点生成 declarativeNetRequest 规则：
 * 在响应头里添加 Access-Control-Allow-Origin: *，让扩展 SW 内的跨域 fetch
 * 能读取响应体。仅作用于扩展自身发起的 xmlhttprequest。
 */
async function buildRules(): Promise<chrome.declarativeNetRequest.Rule[]> {
  const sites = (await siteRepo.list()).filter((s) => s.enabled)
  return sites.map((site) => ({
    id: ruleIdFor(site.id),
    priority: 1,
    action: {
      type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
      responseHeaders: [
        {
          header: 'Access-Control-Allow-Origin',
          operation: chrome.declarativeNetRequest.HeaderOperation.SET,
          value: '*',
        } as chrome.declarativeNetRequest.ModifyHeaderInfo,
      ],
    },
    condition: {
      urlFilter: `|${site.origin}|`,
      resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST],
    },
  }))
}

/** 读取当前所有动态规则里属于本扩展管理的 id 集合。 */
async function managedRuleIds(): Promise<number[]> {
  const rules = await chrome.declarativeNetRequest.getDynamicRules()
  return rules.filter((r) => r.id >= RULE_ID_BASE && r.id < RULE_ID_BASE + 100_000).map((r) => r.id)
}

/**
 * 根据「CORS 放行开关」重建动态规则。
 * @param enabled true 时添加/更新规则；false 时删除本扩展管理的所有规则。
 */
export async function applyCorsRules(enabled: boolean): Promise<void> {
  const existingIds = await managedRuleIds()
  if (!enabled) {
    if (existingIds.length) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: existingIds })
    }
    return
  }

  const newRules = await buildRules()
  const addRules = newRules.filter((r) => !existingIds.includes(r.id))
  const updateRuleIds = newRules.filter((r) => existingIds.includes(r.id)).map((r) => r.id)
  const removeRuleIds = existingIds.filter((id) => !newRules.some((r) => r.id === id))

  await chrome.declarativeNetRequest.updateDynamicRules({
    addRules,
    removeRuleIds: [...removeRuleIds, ...updateRuleIds],
  })
  // 对已存在的规则重新 add 以达到「更新」效果（Chrome 不允许直接 update，先删后加）
  if (updateRuleIds.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: newRules.filter((r) => updateRuleIds.includes(r.id)),
    })
  }
}

/** 站点增删改后调用，保持规则与启用站点同步。 */
export async function refreshCorsRules(): Promise<void> {
  const enabled = (await import('../storage')).getLabCorsUnblock().catch(() => false)
  await applyCorsRules(await enabled)
}
