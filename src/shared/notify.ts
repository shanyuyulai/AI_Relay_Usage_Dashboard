/**
 * 系统通知（带权限保护）。
 *
 * 仅在用户已授予 `notifications` 权限时发送；未授权或发送失败一律静默忽略，
 * 不影响采集主流程。
 */

import { settingsRepo } from '../storage/config'

/** 采集通知档位（用户在设置页选择）。 */
export type NotifyMode = 'system' | 'optionsOnly' | 'dailyFirst' | 'off'

const NOTIFY_MODE_KEY = 'aihub.notifyMode'
const NOTIFY_LAST_DATE_KEY = 'aihub.notifyLastDate'

/** 读取当前通知档位，缺省回退到 'system'（保持现有行为）。 */
export async function resolveNotifyMode(): Promise<NotifyMode> {
  const v = await settingsRepo.get<NotifyMode>(NOTIFY_MODE_KEY)
  return v === 'system' || v === 'optionsOnly' || v === 'dailyFirst' || v === 'off' ? v : 'system'
}

function todayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/**
 * 按用户档位决策是否/如何发送采集通知：
 * - off：完全不发。
 * - system：系统弹窗（默认）。
 * - dailyFirst：当天首次才发系统弹窗，其余静默。
 * - optionsOnly：仅向「配置界面（Options 页）」发送页内提示，绝不发系统弹窗；
 *   配置界面未打开时该消息无接收端、自动丢弃（即「配置界面打开时才有效」）。
 * 返回是否实际发出了系统弹窗（便于调用方判断）。
 */
export async function maybeNotify(
  title: string,
  message: string,
  opts: NotifyOptions = {},
): Promise<boolean> {
  let mode: NotifyMode
  try {
    mode = await resolveNotifyMode()
  } catch {
    mode = 'system'
  }

  if (mode === 'off') return false

  if (mode === 'optionsOnly') {
    try {
      chrome.runtime.sendMessage({ type: 'AIHUB_OPTIONS_NOTIFY', title, message })
    } catch {
      /* Options 页未打开时无接收端，静默忽略 */
    }
    return false
  }

  if (mode === 'dailyFirst') {
    try {
      const last = await settingsRepo.get<string>(NOTIFY_LAST_DATE_KEY)
      if (last === todayKey()) return false
      await settingsRepo.set(NOTIFY_LAST_DATE_KEY, todayKey())
    } catch {
      /* 存储异常不阻断：照常弹窗 */
    }
  }

  return notify(title, message, opts)
}

let iconUrlCache: string | null = null
function getIconUrl(): string {
  if (iconUrlCache == null) {
    try {
      iconUrlCache = chrome.runtime.getURL('icon-128.png')
    } catch {
      iconUrlCache = ''
    }
  }
  return iconUrlCache
}

export interface NotifyOptions {
  /** 是否要求用户手动关闭（更醒目，适合关键提醒）。 */
  requireInteraction?: boolean
  /** 优先级：-2~2，默认 1。 */
  priority?: number
}

/** 发送一条基础通知；返回是否成功（用于调用方决定是否计数）。 */
export async function notify(
  title: string,
  message: string,
  opts: NotifyOptions = {},
): Promise<boolean> {
  try {
    if (!chrome.notifications) return false
    const granted = await chrome.permissions.contains({ permissions: ['notifications'] })
    if (!granted) return false
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: getIconUrl(),
      title,
      message,
      priority: opts.priority ?? 1,
      ...(opts.requireInteraction ? { requireInteraction: true } : {}),
    })
    return true
  } catch {
    return false
  }
}
