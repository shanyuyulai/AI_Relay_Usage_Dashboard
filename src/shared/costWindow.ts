/**
 * 花费统计周期（今日 / 近 24 小时）与「真实总花费」聚合。
 *
 * 红线（与项目既有约定一致）：
 * - P0-3：花费只取站点精确接口字段（todayCost / recent24hCost），无数据一律 null → UI 显「—」，绝不编造。
 * - P1-3：绝不跨币种相加。站点本币合计按币种分组；人民币合计只在「已按充值比例换算成人民币」之后才求和。
 * - P0-2：本模块只做数值运算，不接触任何凭证。
 */
import { fmtBalance } from './format'
import { parseRechargeRate, realRmb } from './recharge'
import type { CostWindow } from '../core/messaging/protocol'

// 周期类型的单一权威定义在 core/messaging/protocol（与 DashboardSettings 同源），此处再导出便于 UI 侧引用。
export type { CostWindow }

/** 缺省周期（保持与历史版本一致的「今日」口径）。 */
export const DEFAULT_COST_WINDOW: CostWindow = 'today'

/** 严格校验：仅 'today' / 'h24' 合法，其余（含 null/脏数据）回退默认。 */
export function normalizeCostWindow(v: unknown): CostWindow {
  return v === 'h24' ? 'h24' : DEFAULT_COST_WINDOW
}

/** 周期全名（用于标题/提示）。 */
export function costWindowLabel(w: CostWindow): string {
  return w === 'h24' ? '24 小时' : '今日'
}

/** 周期短名（用于紧凑标签，如「24h 使用」）。 */
export function costWindowShortLabel(w: CostWindow): string {
  return w === 'h24' ? '24h' : '今日'
}

/** 参与花费聚合的最小数据单元（快照 + 站点充值比例即可构造）。 */
export interface CostWindowItem {
  todayCost?: number | null
  recent24hCost?: number | null
  currency?: string | null
  rechargeRate?: string | null
}

/** 非负有限数校验（负数/NaN/Infinity 视为无数据，防脏数据）。 */
function finiteCost(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}

/** 按当前周期取该站花费（站点本币）；无数据 → null。 */
export function pickCost(item: CostWindowItem | null | undefined, w: CostWindow): number | null {
  if (!item) return null
  return w === 'h24' ? finiteCost(item.recent24hCost) : finiteCost(item.todayCost)
}

/** 花费聚合结果。 */
export interface CostTotal {
  /** 人民币真实总花费（仅统计成功换算的站点）；无可换算站点 → null。 */
  rmb: number | null
  /** 站点本币合计，按币种分组（未开启真实花费时的回退展示依据）。 */
  byCurrency: Record<string, number>
  /** 所选周期内有花费数据的站点数。 */
  counted: number
  /** 成功换算为人民币的站点数。 */
  converted: number
  /** 有花费但缺有效充值比例、未计入人民币合计的站点数。 */
  unconverted: number
}

/**
 * 聚合所选周期的花费。
 * - calcRealCost=true：逐个按充值比例换算成人民币后求和（此时是同一币种，可相加）；比例无效者跳过并计入 unconverted。
 * - 同时始终产出按币种分组的本币合计，供未开启真实花费时回退展示。
 */
export function sumCostTotal(
  items: readonly CostWindowItem[],
  w: CostWindow,
  calcRealCost: boolean,
): CostTotal {
  let rmb = 0
  let converted = 0
  let counted = 0
  let unconverted = 0
  const byCurrency: Record<string, number> = {}

  for (const it of items) {
    const cost = pickCost(it, w)
    if (cost == null) continue
    counted += 1

    const cur = it.currency ?? ''
    byCurrency[cur] = (byCurrency[cur] ?? 0) + cost

    if (!calcRealCost) continue
    const rate = parseRechargeRate(it.rechargeRate)
    const v = realRmb(cost, rate)
    if (v == null) {
      unconverted += 1
      continue
    }
    rmb += v
    converted += 1
  }

  return {
    rmb: calcRealCost && converted > 0 ? rmb : null,
    byCurrency,
    counted,
    converted,
    unconverted,
  }
}

/**
 * 数据时效说明（用于 title，方案 035 R3）：切换周期**不会**重新采集，读的是上次快照。
 * 把快照时间显式告诉用户，避免误以为切换后没生效。
 */
export function fmtAsOf(ts: number | null | undefined): string {
  if (!ts || !Number.isFinite(ts)) return ''
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `｜数据截至 ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export interface CostTotalText {
  /** 紧凑展示文本（如 "¥12.345" / "$12.35" / "多币种" / "24h 无数据"）。 */
  text: string
  /** 完整说明（用于 title 提示）。 */
  title: string
}

/**
 * 总花费展示文本：
 * - 开启真实花费且有可换算站点 → 人民币合计 "¥12.345"；
 * - 未开启真实花费 → 按本币合计展示；仅单一币种时显示该币种金额，多币种时显示「多币种」（绝不跨币种相加），无数据显示「—」；
 * - 开启真实花费但全部缺比例 → 「—」并提示需填写充值比例。
 */
export function fmtCostTotal(t: CostTotal, calcRealCost: boolean, w: CostWindow): CostTotalText {
  const win = costWindowLabel(w)
  const suffix = `｜点击切换为${w === 'h24' ? '今日' : '24 小时'}`

  // 「无数据」与「金额为 0 / 金额相同」必须在视觉上可区分，否则会被误读为「切换没生效」（方案 035 R4）
  const noDataText = `${costWindowShortLabel(w)}无数据`
  const noDataHint =
    w === 'h24'
      ? '站点未返回 24 小时口径数据：请在设置页对该站点执行「探测」后重新同步'
      : '站点未返回今日花费数据'

  if (calcRealCost) {
    if (t.rmb == null) {
      const why =
        t.counted === 0
          ? `当前无站点返回${win}花费数据（${noDataHint}）`
          : `${t.counted} 个站点有${win}花费，但均未填写有效充值比例，无法换算人民币`
      return { text: t.counted === 0 ? noDataText : '—', title: `真实总花费（${win}）：${why}。${suffix}` }
    }
    const extra = t.unconverted > 0 ? `；${t.unconverted} 个站点缺充值比例未计入` : ''
    return {
      text: `¥${t.rmb.toFixed(3)}`,
      title: `真实总花费（${win}）：已计入 ${t.converted} 个站点${extra}。${suffix}`,
    }
  }

  const keys = Object.keys(t.byCurrency)
  if (keys.length === 0) {
    return {
      text: noDataText,
      title: `总花费（${win}）：暂无站点花费数据（${noDataHint}）。开启「计算真实花费」后可显示人民币真实总花费。${suffix}`,
    }
  }
  if (keys.length === 1) {
    const cur = keys[0]
    return {
      text: fmtBalance(t.byCurrency[cur], cur),
      title: `总花费（${win}，站点本币）：${t.counted} 个站点合计，不跨币种相加。开启「计算真实花费」后显示人民币真实总花费。${suffix}`,
    }
  }
  const detail = keys.map((c) => fmtBalance(t.byCurrency[c], c)).join(' · ')
  return {
    text: '多币种',
    title: `总花费（${win}，站点本币）：${detail}（不跨币种相加）。开启「计算真实花费」后显示人民币真实总花费。${suffix}`,
  }
}
