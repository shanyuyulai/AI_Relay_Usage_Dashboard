/**
 * 充值比例：站点货币 / 1 人民币 的换算工具（方案 032）。
 * 仅用于「真实人民币花费」展示换算，不参与任何计费/跨币种求和，绝不含凭证。
 */
import { fmtBalance } from './format'

/** 字符串最大长度（防超长/畸形输入）。 */
const MAX_LEN = 32

/**
 * 解析充值比例。
 * - 简写 "10" → 10（1 人民币到账 10 站点货币）；
 * - 显式 "1:1.1" → 1.1（冒号左 RMB、右站点货币，恰好两段）；
 * - 非法（空/含非数字/"10abc"/"1:1.1:2"/非正数/超长）→ null。
 * 必须用 Number() 而非 parseFloat，否则 "10abc"/"1:1.1abc" 会被误收。
 */
export function parseRechargeRate(raw: string | null | undefined): number | null {
  if (raw == null) return null
  const s = raw.trim()
  if (s.length === 0 || s.length > MAX_LEN) return null

  if (s.includes(':')) {
    const parts = s.split(':')
    if (parts.length !== 2) return null // "1:1.1:2" 等拒绝
    const ra = Number(parts[0].trim())
    const rb = Number(parts[1].trim())
    // 拒绝 "a:b"（NaN）与 "1e1:b" 等部分非数字；同时要求字符串与数值表示一致，排除畸形
    if (!Number.isFinite(ra) || !Number.isFinite(rb) || ra <= 0 || rb <= 0) return null
    if (parts[0].trim() !== String(ra) || parts[1].trim() !== String(rb)) return null
    return rb / ra
  }

  const n = Number(s)
  if (!Number.isFinite(n) || n <= 0) return null
  // 拒绝 "10abc"（Number 解析为 NaN 已拦截）、"1e1" 等可接受但须与原文一致
  if (String(n) !== s) return null
  return n
}

/** 真实人民币花费：站点货币花费 C / 比例 r；任一缺失/非有限/花费为负/比例非正 → null（不在 UI 显示 RMB）。 */
export function realRmb(todayCost: number | null, rate: number | null): number | null {
  if (todayCost == null || rate == null || !Number.isFinite(todayCost) || !Number.isFinite(rate) || todayCost < 0 || rate <= 0) {
    return null
  }
  return todayCost / rate
}

/** 朴素十进制正则：拒科学计数法、前导零(01)、尾随零(0.950)、负号、空串。小数部分必须以非 0 数字结尾。 */
const DEC_RE = /^(0|[1-9]\d*)(\.(?:[0-9]*[1-9]))?$/

/**
 * 解析充值折扣 d（实付 RMB / 标价本站货币）。
 * - d ∈ (0, 1]：0 视为非法（不允许"免费"），>1 视为非法。
 * - 用朴素十进制正则 + 数值校验，拒 "0.95abc" / "1e-1" / "01" / "0.950" / "-0.5" 等畸形。
 * - 合法返回 number，否则 null。与 032 `parseRechargeRate` 的严格串校验风格保持一致。
 */
export function parseRechargeDiscount(raw: string | null | undefined): number | null {
  if (raw == null) return null
  const s = raw.trim()
  if (!s || s.length > MAX_LEN) return null
  if (!DEC_RE.test(s)) return null // 拒科学计数法 / 前导零 / 尾随零 / 负号
  const n = Number(s)
  if (!Number.isFinite(n) || n <= 0 || n > 1) return null
  return n
}

/**
 * 把折扣 d 换算为充值比例 r（站点货币 / 1 RMB），r = 1 / d。**可失败**，返回 string | null。
 * - d==null → null。
 * - 1/d 非有限或 ≤0 → null。
 * - 用 12 位小数 toFixed 降低误差（无金额上限时 12 位误差远小于 3 位 RMB 展示精度，回应评审 P0-3）。
 * - 经 Number().toString() 后若为科学计数法（含 e/E）或长度 > MAX_LEN → null（032 严格解析器拒科学计数法，回应 P0-2）。
 * - 最终必须通过 parseRechargeRate，否则 null。
 * 不通过时调用方应显式报错并阻止保存，绝不可把 Infinity / 科学计数法写入表单。
 */
export function discountToRate(discount: number | null): string | null {
  if (discount == null) return null
  const rate = 1 / discount
  if (!Number.isFinite(rate) || rate <= 0) return null
  const s = Number(rate.toFixed(12)).toString()
  if (/[eE]/.test(s)) return null
  if (s.length > MAX_LEN) return null
  if (parseRechargeRate(s) == null) return null
  return s
}

/**
 * 今日花费展示（popup / 侧栏共用，避免两处不一致）：
 * - todayCost 为 null（未知）→ "—"；
 * - calcRealCost 关 / 比例无效 → 普通站点货币 "$C"（2 位）；
 * - calcRealCost 开且比例有效 → "$C / ¥rmb"（站点货币 2 位、RMB 固定 3 位）。
 * 注意：todayCost === 0 正常显示 "$0.00"（非 truthy 判断）。
 */
export function fmtTodayCost(
  todayCost: number | null,
  currency: string | null,
  rechargeRate: string | null,
  calcRealCost: boolean,
): string {
  // 运行时防护：数据库被篡改/旧版本脏数据可能提供非数字或负值，统一回退为「—」
  if (todayCost == null || !Number.isFinite(todayCost) || todayCost < 0) return '—'
  const c = fmtBalance(todayCost, currency)
  if (!calcRealCost) return c
  const rate = parseRechargeRate(rechargeRate)
  if (rate == null) return c
  const rmb = realRmb(todayCost, rate)
  if (rmb == null) return c
  return `${c} / ¥${rmb.toFixed(3)}`
}

/**
 * 今日花费的「分段」展示（侧栏 sc-metrics 用，便于把 RMB 部分单独缩小字号渲染）：
 * - main：主显示（如 "$1.50" 或 "—"）；
 * - realRmb：仅 calcRealCost 开且比例有效时有值（如 "10.340"），不含前缀和币种符号；其他情况为 undefined。
 */
export interface TodayCostParts {
  main: string
  realRmb?: string
}

export function fmtTodayCostParts(
  todayCost: number | null,
  currency: string | null,
  rechargeRate: string | null,
  calcRealCost: boolean,
): TodayCostParts {
  if (todayCost == null || !Number.isFinite(todayCost) || todayCost < 0) {
    return { main: '—' }
  }
  const main = fmtBalance(todayCost, currency)
  if (!calcRealCost) return { main }
  const rate = parseRechargeRate(rechargeRate)
  if (rate == null) return { main }
  const rmb = realRmb(todayCost, rate)
  if (rmb == null) return { main }
  return { main, realRmb: rmb.toFixed(3) }
}
