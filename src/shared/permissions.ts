/**
 * Host 权限工具。
 *
 * MV3 下 chrome.scripting.executeScript 必须持有目标页的 host 权限。
 * 权限在「添加站点」时申请，但可能被用户后续撤销，因此每次需要注入页面主世界的
 * 操作前都应先 ensure。
 *
 * 注意：chrome.permissions.request 必须在用户手势的同步调用链中使用；
 * 本 helper 应在 UI 层按钮点击 handler 中同步调用（不要深层 await 后再 request）。
 */

/** 确保单个 origin 的 host 权限。 */
export async function ensureOriginPermission(origin: string): Promise<boolean> {
  const originPattern = `${origin}/*`
  const has = await chrome.permissions.contains({ origins: [originPattern] })
  if (has) return true
  return chrome.permissions.request({ origins: [originPattern] })
}

/** 批量确保多个 origin 的 host 权限（用于「全部刷新」）。 */
export async function ensureOriginPermissions(origins: string[]): Promise<boolean> {
  const unique = [...new Set(origins)]
  if (unique.length === 0) return true

  const patterns: string[] = []
  for (const origin of unique) {
    const p = `${origin}/*`
    const has = await chrome.permissions.contains({ origins: [p] })
    if (!has) patterns.push(p)
  }
  if (patterns.length === 0) return true

  return chrome.permissions.request({ origins: patterns })
}
