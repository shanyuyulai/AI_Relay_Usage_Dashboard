/**
 * 模型均价纯函数（方案 047/048）。
 *
 * 输入站点当日用量明细（UsageRecord[]），按模型聚合出「真实人民币 ¥/百万 tokens」均价。
 * - 数据源：usageRecords 今日批次（采集端单日上限 MAX_ITEMS=200，与方案 048「前 200 条」天然一致）。
 * - 计算条目可配置（modelAvgMaxRecords，默认 200）：取**最近 N 条**（ts 降序截取）。
 * - 真实价口径：actualCost（实扣）优先，缺失回退 cost（标价口径，行内标注）。
 * - 人民币换算：逐条 realRmb(amount, rechargeRate)，与「真实花费」同一套比例口径。
 *
 * 红线（与项目既有约定一致）：
 * - P0-3：无数据一律 null → UI 显「—」，绝不编造。
 * - P1-3：绝不跨币种相加——记录币种与站点计价币种不一致时跳过该记录并计数；
 *         人民币合计只在逐条按比例换算成 CNY 之后进行。
 * - P0-2：本模块只做数值运算，不接触任何凭证。
 */
import type { UsageRecord, ModelAvgRawRecord } from '../shared/types'
import { parseRechargeRate, realRmb } from '../shared/recharge'

// 类型权威定义在 shared/types.ts（050 移入，消除 core↔shared 循环）；此处 re-export 保持既有导入路径可用。
export type { ModelAvgRawRecord } from '../shared/types'

/** 计算条目默认值（与采集端单日明细上限一致）。 */
export const MODEL_AVG_MAX_RECORDS_DEFAULT = 200
/** 计算条目下限（过小会导致均价剧烈抖动）。 */
export const MODEL_AVG_MAX_RECORDS_MIN = 20
/** 计算条目上限（防御畸形输入；采集端上限 200，超过部分实际以已采集条数为准）。 */
export const MODEL_AVG_MAX_RECORDS_MAX = 500

/** 归一化「计算条目」设置：非法/越界回退边界值，绝不透传 NaN。 */
export function normalizeModelAvgMaxRecords(v: unknown): number {
  const n = typeof v === 'number' ? Math.floor(v) : Number.NaN
  if (!Number.isFinite(n)) return MODEL_AVG_MAX_RECORDS_DEFAULT
  return Math.min(MODEL_AVG_MAX_RECORDS_MAX, Math.max(MODEL_AVG_MAX_RECORDS_MIN, n))
}

/** 单模型均价行（hover 浮窗列表；已按用量倒序排好）。 */
export interface ModelPriceRow {
  model: string
  /** 输入+输出 tokens 合计（与看板既有口径一致，不含 cache）。 */
  tokens: number
  requests: number
  /** ¥/百万 tokens；null → UI 显「—」（缺比例或无有效金额）。 */
  pricePerM: number | null
  /** 该行含回退「标价口径」的记录（actualCost 缺失用了 cost）。 */
  listPriceBased: boolean
  /** 方案 050：该模型均价的来源数据范围（可能来自历史档案）。 */
  rangeStart?: number | null
  rangeEnd?: number | null
  usedCount?: number
  /** 档案计算时间（ms）。 */
  computedAt?: number
  /** true = 价格来自历史档案（当前批次无该模型新数据）。 */
  fromHistory?: boolean
}

/** 单模型完整计算结果（050）：行数据 + 来源范围 + 原始记录投影，供档案合并。 */
export interface ModelComputation extends ModelPriceRow {
  rangeStart: number | null
  rangeEnd: number | null
  usedCount: number
  rawRecords: ModelAvgRawRecord[]
}

/** summary 下发的最小摘要（只发数字，不下发全量行）。 */
export interface ModelAvgSummary {
  /** 用量最大模型的 ¥/M 均价；null → 显「—」。 */
  pricePerM: number | null
  topModel: string | null
  /** 批次采集截断（isComplete=false）→ UI 加「≈」角标。 */
  partial: boolean
  /** 站点是否有当日明细批次。 */
  hasDetail: boolean
  /** true = 当日无有效数据，价格回退为历史档案中用量最大模型的历史价（UI 带「档」标记，050r3）。 */
  fromHistory?: boolean
}

/**
 * 参与计算的原始记录投影（方案 049r2 原始数据弹窗）。
 * 仅含展示/核算字段，绝不含凭证与 IP 哈希（P0-2 / P1-1）。
 */
export interface ModelPriceResult {
  rows: ModelPriceRow[]
  /** per-model 完整计算结果（050；rows 为其投影），供档案合并。 */
  models: ModelComputation[]
  summary: ModelAvgSummary
  /** 实际参与计算的记录条数（= min(maxRecords, 明细条数)）。 */
  usedCount: number
  /** 参与计算记录的时间范围（浮窗顶部小字展示用），毫秒 ts。 */
  rangeStart: number | null
  rangeEnd: number | null
  /** 站点未填有效充值比例（rows 仍返回，pricePerM 全 null）。 */
  missingRate: boolean
  /** 因缺金额/币种不匹配被跳过的记录数。 */
  skippedCount: number
}

interface Acc {
  tokens: number
  requests: number
  rmb: number
  rmbKnown: boolean
  listPriceBased: boolean
  rangeStart: number | null
  rangeEnd: number | null
  rawRecords: ModelAvgRawRecord[]
}

/**
 * 聚合模型均价。
 * @param records 当日明细记录（任意顺序；内部按 ts 降序截取最近 N 条）
 * @param rechargeRate 站点充值比例原始写法（doc 032）
 * @param maxRecords 计算条目（已归一化）
 * @param opts.siteCurrency 站点计价币种（币种不匹配的记录跳过，P1-3）
 * @param opts.batchComplete 批次完整性（isComplete=false → partial）
 */
export function computeModelPrices(
  records: readonly UsageRecord[],
  rechargeRate: string | null | undefined,
  maxRecords: number,
  opts?: { siteCurrency?: string | null; batchComplete?: boolean },
): ModelPriceResult {
  const rate = parseRechargeRate(rechargeRate ?? null)
  const missingRate = rate == null
  const siteCur = (opts?.siteCurrency ?? '').toUpperCase()

  // 无明细：合法的「无数据」分支（P0-3），非错误
  if (!records.length) {
    return {
      rows: [],
      models: [],
      summary: { pricePerM: null, topModel: null, partial: false, hasDetail: false },
      usedCount: 0,
      rangeStart: null,
      rangeEnd: null,
      missingRate,
      skippedCount: 0,
    }
  }

  // 取最近 N 条（ts 降序）；ts 非法的记录防御性剔除
  const sorted = [...records]
    .filter((r) => typeof r.ts === 'number' && Number.isFinite(r.ts) && r.ts > 0)
    .sort((a, b) => b.ts - a.ts)
  const used = maxRecords >= sorted.length ? sorted : sorted.slice(0, Math.max(0, maxRecords))

  const accs = new Map<string, Acc>()
  let skipped = 0
  let rangeStart: number | null = null
  let rangeEnd: number | null = null

  for (const r of used) {
    // 金额与币种解析：实扣优先，缺失回退标价口径
    let amount: number | null
    let cur: string | null
    let listPrice = false
    if (r.actualCost != null && Number.isFinite(r.actualCost) && r.actualCost >= 0) {
      amount = r.actualCost
      cur = r.actualCostCurrency ?? null
    } else if (r.cost != null && Number.isFinite(r.cost) && r.cost >= 0) {
      amount = r.cost
      cur = r.costCurrency ?? null
      listPrice = true
    } else {
      skipped += 1
      continue
    }
    // P1-3：记录自身币种明确且与站点计价币种不一致 → 跳过（绝不臆造汇率）
    if (cur && siteCur && cur.toUpperCase() !== siteCur) {
      skipped += 1
      continue
    }
    // P1-3：逐条换算成 RMB 后才允许相加；比例缺失时 rmb 不累计（rows 仍统计 tokens）
    const rmb = missingRate ? null : realRmb(amount, rate)

    const model = (r.model ?? '').trim() || '(unknown)'
    let acc = accs.get(model)
    if (!acc) {
      acc = { tokens: 0, requests: 0, rmb: 0, rmbKnown: false, listPriceBased: false, rangeStart: null, rangeEnd: null, rawRecords: [] }
      accs.set(model, acc)
    }
    const tk = (r.promptTokens ?? 0) + (r.completionTokens ?? 0)
    acc.tokens += Number.isFinite(tk) && tk > 0 ? tk : 0
    acc.requests += 1
    if (rmb != null) {
      acc.rmb += rmb
      acc.rmbKnown = true
    }
    if (listPrice) acc.listPriceBased = true
    // per-model 来源范围与原始投影（050）
    if (acc.rangeStart == null || r.ts < acc.rangeStart) acc.rangeStart = r.ts
    if (acc.rangeEnd == null || r.ts > acc.rangeEnd) acc.rangeEnd = r.ts
    acc.rawRecords.push({
      ts: r.ts,
      model,
      promptTokens: r.promptTokens ?? 0,
      completionTokens: r.completionTokens ?? 0,
      amount,
      listPrice,
      currency: cur,
      rmb,
    })

    if (rangeStart == null || r.ts < rangeStart) rangeStart = r.ts
    if (rangeEnd == null || r.ts > rangeEnd) rangeEnd = r.ts
  }

  const models: ModelComputation[] = []
  for (const [model, acc] of accs) {
    // tokens>0 才有意义；tokens=0（如纯图片/异常记录）保留行但价格置 null
    const pricePerM =
      !missingRate && acc.rmbKnown && acc.tokens > 0 ? (acc.rmb / acc.tokens) * 1_000_000 : null
    models.push({
      model,
      tokens: acc.tokens,
      requests: acc.requests,
      pricePerM,
      listPriceBased: acc.listPriceBased,
      rangeStart: acc.rangeStart,
      rangeEnd: acc.rangeEnd,
      usedCount: acc.rawRecords.length,
      rawRecords: acc.rawRecords,
    })
  }
  // 用量倒序（tokens 优先，其次请求数，最后模型名稳定排序）
  models.sort((a, b) => b.tokens - a.tokens || b.requests - a.requests || a.model.localeCompare(b.model))
  const rows: ModelPriceRow[] = models.map((m) => ({
    model: m.model,
    tokens: m.tokens,
    requests: m.requests,
    pricePerM: m.pricePerM,
    listPriceBased: m.listPriceBased,
  }))

  const top = models[0] ?? null
  const partial = opts?.batchComplete === false
  return {
    rows,
    models,
    summary: {
      pricePerM: top ? top.pricePerM : null,
      topModel: top ? top.model : null,
      partial,
      hasDetail: true,
    },
    usedCount: used.length,
    rangeStart,
    rangeEnd,
    missingRate,
    skippedCount: skipped,
  }
}
