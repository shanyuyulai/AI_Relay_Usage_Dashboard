import { settingsRepo } from './config'

/**
 * 实验室：SW 零标签后台采集。
 *
 * 默认关闭。开启后，对「没有打开标签页」的站点，扩展会在 Service Worker 内直接读取
 * 该站点的登录 Cookie（chrome.cookies.getAll）并手动注入到请求头去 fetch，从而无需
 * 打开任何可见标签即可后台采集（真正的静默）。
 *
 * ⚠️ 这是 P0-2「不碰/不存凭证」红线的知情例外路径，且极不稳定：
 *  - 需在扩展内读取站点 Cookie（仅本次请求内存使用，绝不写入 IndexedDB / 导出）；
 *  - 多数站点 API 不设 CORS（Access-Control-Allow-Origin），跨源 fetch 会被浏览器拦截；
 *  - 会话常不止一个 Cookie，还绑 CSRF / SameSite / 内存态 Token（如 ikuncode 依赖
 *    localStorage 的 Bearer，SW 读不到）→ 很大概率失败或只能采到部分字段。
 * 因此做成默认关闭、需用户显式知情同意的「实验室」特性。
 */
export const LAB_ZEROTAB_KEY = 'aihub.lab.zeroTab'
export const DEFAULT_LAB_ZEROTAB = false

export async function getLabZeroTab(): Promise<boolean> {
  const raw = await settingsRepo.get<boolean>(LAB_ZEROTAB_KEY)
  return raw === true
}

export async function setLabZeroTab(enabled: boolean): Promise<boolean> {
  const safe = enabled === true
  await settingsRepo.set(LAB_ZEROTAB_KEY, safe)
  return safe
}

/**
 * 实验室：图标点击弹极简用量看板（悬浮框）。
 *
 * 默认关闭。开启后，点击扩展图标不再打开侧边栏，而是弹出一个极简 popup，
 * 只列出各中转站的名称与剩余金额（数据来自最新的余额快照）。关闭则回退到侧边栏。
 *
 * ⚠️ 注意（MV3 限制）：工具栏图标没有「悬浮(hover)触发自定义浮层」的 API，
 * 只有原生 tooltip。因此本开关实现的是「点击弹 popup」，无法做到 hover 弹出。
 */
export const LAB_SHOWDASHBOARD_KEY = 'aihub.lab.showDashboard'
export const DEFAULT_LAB_SHOWDASHBOARD = false

/**
 * 开关变更广播类型：在 SET_LAB_SHOWDASHBOARD 改完后由 SW 广播，
 * 让侧边栏/设置页的「📊 用量看板」入口实时联动显隐（开关存于 Dexie，
 * 不走 chrome.storage，故无法用 storage.onChanged；沿用既有
 * chrome.runtime.sendMessage 广播惯例）。
 */
export const LAB_SHOWDASHBOARD_CHANGED = 'LAB_SHOWDASHBOARD_CHANGED'

export async function getLabShowDashboard(): Promise<boolean> {
  const raw = await settingsRepo.get<boolean>(LAB_SHOWDASHBOARD_KEY)
  return raw === true
}

export async function setLabShowDashboard(enabled: boolean): Promise<boolean> {
  const safe = enabled === true
  await settingsRepo.set(LAB_SHOWDASHBOARD_KEY, safe)
  return safe
}
