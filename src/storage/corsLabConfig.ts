import { settingsRepo } from './config'

const LAB_CORS_KEY = 'aihub.lab.corsUnblock'

/**
 * 实验室：动态 CORS 放行开关（默认关闭）。
 * 开启后扩展会通过 chrome.declarativeNetRequest 给已启用站点的响应
 * 添加 Access-Control-Allow-Origin: *，从而让 Service Worker 内的跨域 fetch
 * 能读取响应体。这是 CORS Unblock 插件的核心原理，但受 MV3 规则数量与策略限制。
 */
export async function getLabCorsUnblock(): Promise<boolean> {
  const raw = await settingsRepo.get(LAB_CORS_KEY)
  return raw === true
}

export async function setLabCorsUnblock(enabled: boolean): Promise<boolean> {
  await settingsRepo.set(LAB_CORS_KEY, enabled)
  return enabled
}
