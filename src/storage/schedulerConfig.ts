import { settingsRepo } from './config'

// 自动采集间隔设置（复用 settingsRepo 的 Dexie kv 通道，与保留策略同一套）
export const COLLECT_INTERVAL_KEY = 'aihub.collectInterval'
export const DEFAULT_COLLECT_INTERVAL = 30 // 分钟；'off' 表示关闭自动采集
export const MIN_INTERVAL = 1
export const MAX_INTERVAL = 1440 // 一天

export type CollectInterval = number | 'off' // 分钟数（1–1440）或关闭

export async function getCollectInterval(): Promise<CollectInterval> {
  const raw = await settingsRepo.get<CollectInterval>(COLLECT_INTERVAL_KEY)
  if (raw === 'off') return 'off'
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= MIN_INTERVAL && raw <= MAX_INTERVAL) {
    return raw
  }
  return DEFAULT_COLLECT_INTERVAL
}

export async function setCollectInterval(v: CollectInterval): Promise<void> {
  const safe: CollectInterval =
    v === 'off' ? 'off' : Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Math.round(v)))
  await settingsRepo.set(COLLECT_INTERVAL_KEY, safe)
}
