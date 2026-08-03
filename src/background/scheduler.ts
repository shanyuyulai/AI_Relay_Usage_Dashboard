import { collectAllInTabs } from './pageCollect'
import { purgeOlderThan, getRetentionDays, getCollectInterval } from '../storage'

const ALARM_NAME = 'aihub-collect'
const PRUNE_ALARM = 'aihub-prune'
const PRUNE_PERIOD_MIN = 1440 // 每日兜底清理一次过期采集数据

async function runCollectAndNotify(): Promise<void> {
  try {
    await collectAllInTabs(true, true)
  } catch (e) {
    console.warn('[AI Relay] 定时采集失败', e)
  } finally {
    // 采集完成（无论成功与否）广播，触发侧边栏/设置页自动刷新最新数据（无盲轮询）
    try {
      await chrome.runtime.sendMessage({ type: 'COLLECT_DONE' })
    } catch {
      /* 无接收方时忽略 */
    }
  }
}

async function runPrune(): Promise<void> {
  try {
    await purgeOlderThan(await getRetentionDays())
  } catch (e) {
    console.warn('[AI Relay] 定时清理失败', e)
  }
}

/**
 * 注册 alarm 监听：定时唤醒 SW 跑全量启用站点采集，结束后自然休眠（MV3 无长驻）。
 * 走页面主世界采集；autoOpen=false：仅当站点标签页已打开时才采集，避免定时任务擅自弹标签页。
 * 另监听每日 prune alarm，作为采集后清理的兜底（即便长期不采集也会按时清理过期数据）。
 */
export function setupScheduler(): void {
  if (!chrome.alarms?.onAlarm) return
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) {
      void runCollectAndNotify()
    } else if (alarm.name === PRUNE_ALARM) {
      void runPrune()
    }
  })
}

/** 使采集 alarm 周期与当前设置一致：'off' 则清除；周期变了则重建（幂等 + 设置变更时即时生效）。 */
async function reconcileCollectAlarm(): Promise<void> {
  const interval = await getCollectInterval()
  const existing = await chrome.alarms.get(ALARM_NAME)
  if (interval === 'off') {
    if (existing) await chrome.alarms.clear(ALARM_NAME)
    return
  }
  if (!existing || existing.periodInMinutes !== interval) {
    if (existing) await chrome.alarms.clear(ALARM_NAME)
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: interval })
  }
}

/** 确保采集 + 清理 alarm 存在且周期正确（SW 启动时调用）。 */
export async function ensureSchedulers(): Promise<void> {
  await reconcileCollectAlarm()
  const existingPrune = await chrome.alarms.get(PRUNE_ALARM)
  if (!existingPrune) {
    chrome.alarms.create(PRUNE_ALARM, { periodInMinutes: PRUNE_PERIOD_MIN })
  }
}

/** 用户改设置后即时重建采集 alarm（免重启扩展）。 */
export async function applyInterval(): Promise<void> {
  await reconcileCollectAlarm()
}
