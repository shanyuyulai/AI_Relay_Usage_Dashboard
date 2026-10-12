/**
 * 模型均价档案合并（方案 050，纯函数可单测）。
 *
 * merge 语义（用户需求①）：
 * - 当前批次算出模型 M 的新均价 → 覆盖更新 M 的档案；
 * - 当前批次无模型 M 的数据 → 原样保留 M 的既有档案（绝不覆盖、绝不删除）；
 * - M 首次出现 → 新建档案。
 *
 * 历史留痕（用户需求②）：价格发生变化（或首次建档）才追加历史；
 * 仅来源范围扩大而价格未变时只更新档案，避免高频采集灌满同价噪音。
 *
 * 写库去重：对档案行做内容签名比对（不含 computedAt 与 records 明细），
 * 内容未变不产生 changed → 读路径重复调用零写入。
 */
import type { ModelAvgPrice, ModelAvgHistory, ModelAvgRawRecord } from '../shared/types'
import type { ModelPriceResult } from './modelPricing'

export interface ModelAvgMergeContext {
  siteId: string
  /** 站点充值比例原文（计算时快照，留档可追溯）。 */
  rechargeRate: string | null
  now: number
}

export interface ModelAvgMergeResult {
  /** 合并后的全量档案（现算模型在前按用量倒序，历史档案在后按用量倒序）。 */
  next: ModelAvgPrice[]
  /** 内容有变化、需要 put 的档案行。 */
  changed: ModelAvgPrice[]
  /** 需追加的历史条目（价格变化或首次建档）。 */
  history: ModelAvgHistory[]
}

/** 内容签名：决定是否需要写库（不含 computedAt 与 records 明细，以条数+首尾 ts 近似）。 */
function signature(p: {
  pricePerM: number | null
  tokens: number
  requests: number
  listPriceBased: boolean
  rangeStart: number | null
  rangeEnd: number | null
  usedCount: number
  partial: boolean
  missingRate: boolean
  rechargeRate: string | null
  records: ModelAvgRawRecord[]
}): string {
  const first = p.records.length ? p.records[0].ts : null
  const last = p.records.length ? p.records[p.records.length - 1].ts : null
  return JSON.stringify([
    p.pricePerM, p.tokens, p.requests, p.listPriceBased,
    p.rangeStart, p.rangeEnd, p.usedCount, p.partial, p.missingRate, p.rechargeRate,
    p.records.length, first, last,
  ])
}

export function mergeModelAvgPrices(
  prev: ModelAvgPrice[],
  res: ModelPriceResult,
  ctx: ModelAvgMergeContext,
): ModelAvgMergeResult {
  const byModel = new Map(prev.map((p) => [p.model, p]))
  const next: ModelAvgPrice[] = []
  const changed: ModelAvgPrice[] = []
  const history: ModelAvgHistory[] = []
  const seen = new Set<string>()

  for (const m of res.models) {
    seen.add(m.model)
    const candidate: ModelAvgPrice = {
      id: `${ctx.siteId}|${m.model}`,
      siteId: ctx.siteId,
      model: m.model,
      pricePerM: m.pricePerM,
      tokens: m.tokens,
      requests: m.requests,
      listPriceBased: m.listPriceBased,
      rangeStart: m.rangeStart,
      rangeEnd: m.rangeEnd,
      usedCount: m.usedCount,
      partial: res.summary.partial,
      rechargeRate: ctx.rechargeRate,
      missingRate: res.missingRate,
      computedAt: ctx.now,
      records: m.rawRecords,
    }
    const old = byModel.get(m.model)
    if (old && signature(old) === signature(candidate)) {
      next.push(old) // 内容未变：保留原行（含原 computedAt/records），零写入
      continue
    }
    next.push(candidate)
    changed.push(candidate)
    // 历史判定：首次建档，或价格/比例口径发生变化
    if (!old || old.pricePerM !== candidate.pricePerM || old.missingRate !== candidate.missingRate) {
      history.push({
        siteId: ctx.siteId,
        model: m.model,
        pricePerM: candidate.pricePerM,
        tokens: candidate.tokens,
        requests: candidate.requests,
        listPriceBased: candidate.listPriceBased,
        rangeStart: candidate.rangeStart,
        rangeEnd: candidate.rangeEnd,
        usedCount: candidate.usedCount,
        partial: candidate.partial,
        rechargeRate: candidate.rechargeRate,
        missingRate: candidate.missingRate,
        computedAt: candidate.computedAt,
        // 050r1：留存本次计算的原始记录投影，供历史列表「数据范围」点击查看数据来源
        records: candidate.records,
      })
    }
  }

  // 现算未出现的模型：原样保留（用户需求①核心——防跨批次覆盖丢失）
  for (const p of prev) {
    if (!seen.has(p.model)) next.push(p)
  }
  // 历史档案按用量倒序排在现算模型之后
  next.sort((a, b) => {
    const aCur = seen.has(a.model) ? 0 : 1
    const bCur = seen.has(b.model) ? 0 : 1
    return aCur - bCur || b.tokens - a.tokens || a.model.localeCompare(b.model)
  })

  return { next, changed, history }
}
