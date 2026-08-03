/**
 * 系统通知（带权限保护）。
 *
 * 仅在用户已授予 `notifications` 权限时发送；未授权或发送失败一律静默忽略，
 * 不影响采集主流程。
 */

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
