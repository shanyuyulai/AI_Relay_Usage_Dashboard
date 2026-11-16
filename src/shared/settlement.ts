/**
 * 方案 054 v2 · 站点结算币种的唯一真源与写入不变量
 * ------------------------------------------------------------------
 * GPT 设计评审（第 3 轮，批准附条件）要求：
 *  - 用纯函数 normalizeSite 集中定义 `cnyOnly=true => currency='CNY'`，
 *    所有站点写入口（siteRepo.add / siteRepo.update / 备份导入）共用，
 *    覆盖并发 UPDATE 与绕过 repo 的批量写入。
 *  - 金额解释一律按「记录自身币种」，站点级配置绝不重解释历史快照。
 *
 * 本模块不依赖任何浏览器 API / Dexie，可在 Node 中直接单测。
 */
import type { SiteConfig } from './types'

/**
 * 站点**有效计价货币**的唯一真源。
 * cnyOnly 是用户在站点表单里显式声明的结算属性，优先级高于 currency；
 * 因此即使旧数据、旧版 UI 或脏写入把 currency 写成 USD，采集仍恒按人民币口径。
 */
/** 真源函数的输入只需这两个字段；摘要 DTO 的 currency/rechargeRate 允许为 null，故用宽松结构类型。 */
type CurrencyBearing = { cnyOnly?: boolean; currency?: string | null }

export function effectiveSiteCurrency(site: CurrencyBearing): string {
  return site.cnyOnly === true ? 'CNY' : (site.currency || 'USD')
}

/**
 * 唯一写入不变量：所有站点写入口必须先过此函数。
 * - `=== true` 严格判断，拒字符串 "true" / 数字 1 等脏值或跨版本退化值；
 * - 固定人民币站点恒为 CNY（并发 read-modify-write 后仍成立）；
 * - 普通站点补全 currency 默认值，与代码各处 `?? 'USD'` 回退保持一致。
 */
export function normalizeSite<T extends Pick<SiteConfig, 'cnyOnly' | 'currency'>>(site: T): T {
  const cnyOnly = site.cnyOnly === true
  return {
    ...site,
    cnyOnly,
    currency: cnyOnly ? 'CNY' : (site.currency || 'USD'),
  }
}

/**
 * 「真实人民币」二次换算的有效充值比例。
 *
 * 只有「站点已固定人民币」且「这条记录本身就是 CNY」时才返回 null（不再换算）。
 * 启用前采集的旧 USD 快照保留原语义（仍按原充值比例折算），
 * 普通站点行为完全不变。切勿只传站点配置而不传记录币种。
 */
export function effectiveRechargeRate(
  site: { cnyOnly?: boolean; rechargeRate?: string | null },
  recordCurrency: string | null | undefined,
): string | null {
  if (site.cnyOnly === true && recordCurrency === 'CNY') return null
  return site.rechargeRate ?? null
}
