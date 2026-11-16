import { settingsRepo } from './config'

/**
 * 实验室：新版 New API（Bearer access_token + HttpOnly refresh Cookie）站点的
 * 「后台自动刷新会话」开关 —— 方案 052 v2，默认关闭。
 *
 * 背景：这类站点的余额/用量接口只认 Bearer，而令牌只在页面 Zustand 内存 store 中，
 * 插件只能通过 POST /api/user/auth/refresh 换取 auth bundle。手动「立即同步」始终允许；
 * 但定时 alarm 采集若也主动 refresh，可能与页面自身 refresh 竞争、轮换 session.sid，
 * 甚至在无凭证时触发服务端清空会话 Cookie → 把已登录页面踢下线。
 *
 * 因此定时采集必须同时满足三重条件才放行（见 probe.ts 的 refreshGate）：
 *   ① 本开关显式开启（用户知情同意）；
 *   ② 只读协议确认通过（new_api_has_session Cookie + /api/status 版本头与版本字段）；
 *   ③ 浏览器支持 Web Locks（与页面共用 new-api:auth-refresh 独占锁）。
 * 任一不满足即 fail closed：定时采集返回 null，绝不盲目 refresh。
 *
 * 安全：本开关只控制「是否允许后台发起有副作用的 refresh」，不存储任何凭证；
 * access_token 始终只在 collectInPage 本次采集的内存闭包内使用（P0-2）。
 */
export const LAB_BEARER_AUTO_REFRESH_KEY = 'aihub.lab.bearerAutoRefresh'
export const DEFAULT_LAB_BEARER_AUTO_REFRESH = false

export async function getLabBearerAutoRefresh(): Promise<boolean> {
  const raw = await settingsRepo.get<boolean>(LAB_BEARER_AUTO_REFRESH_KEY)
  return raw === true
}

export async function setLabBearerAutoRefresh(enabled: boolean): Promise<boolean> {
  const safe = enabled === true
  await settingsRepo.set(LAB_BEARER_AUTO_REFRESH_KEY, safe)
  return safe
}
