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
