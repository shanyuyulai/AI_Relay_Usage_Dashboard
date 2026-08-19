/**
 * 真实花费 / 极简面板今日花费 的全局开关 —— 单一响应式源（方案 032，P0-3）。
 *
 * 设计：
 * - 设置页 DataExplorer.vue 与站点表单 SiteForm.vue 同处 options 页面上下文，共享本 reactive store，
 *   切换「计算真实花费」时 SiteForm 输入自动显隐，无需 prop 透传。
 * - popup / sidepanel 各自在加载时从 GET_DASHBOARD_SUMMARY / GET_DASHBOARD 响应的 settings 读取，
 *   并监听 AIHUB_SETTINGS_CHANGED 广播实时刷新（跨页联动）。
 * - 两个开关默认均 false；仅当 db 中值为严格 true 才启用，缺失/非法值回退 false（不覆盖既有用户配置）。
 */
import { reactive } from 'vue'
import { settingsRepo } from '../storage/config'
import type { DashboardSettings } from '../core/messaging/protocol'

const CALC_REAL_COST_KEY = 'aihub.calcRealCost'
const SHOW_TODAY_COST_KEY = 'aihub.showTodayCostInPopup'

/** 广播消息类型（popup / sidepanel 监听后重载）。 */
export const AIHUB_SETTINGS_CHANGED = 'AIHUB_SETTINGS_CHANGED'

/** 从 db.settings 读取两个开关（缺失/非法 → false）。 */
export async function readDashboardSettings(): Promise<DashboardSettings> {
  const [a, b] = await Promise.all([
    settingsRepo.get<boolean>(CALC_REAL_COST_KEY),
    settingsRepo.get<boolean>(SHOW_TODAY_COST_KEY),
  ])
  return {
    calcRealCost: a === true,
    showTodayCostInPopup: b === true,
  }
}

/** options 页面内共享的响应式状态（DataExplorer / SiteForm 直接读写）。 */
export const dashboardSettings = reactive<DashboardSettings>({
  calcRealCost: false,
  showTodayCostInPopup: false,
})

/** options 页面挂载时载入一次，同步响应式 store。 */
export async function loadDashboardSettings(): Promise<DashboardSettings> {
  const s = await readDashboardSettings()
  dashboardSettings.calcRealCost = s.calcRealCost
  dashboardSettings.showTodayCostInPopup = s.showTodayCostInPopup
  return s
}

export async function setCalcRealCost(v: boolean): Promise<void> {
  await settingsRepo.set(CALC_REAL_COST_KEY, v)
  dashboardSettings.calcRealCost = v
}

export async function setShowTodayCostInPopup(v: boolean): Promise<void> {
  await settingsRepo.set(SHOW_TODAY_COST_KEY, v)
  dashboardSettings.showTodayCostInPopup = v
  // 广播给已打开的 popup / sidepanel，触发其实时刷新
  try {
    await chrome.runtime.sendMessage({ type: AIHUB_SETTINGS_CHANGED })
  } catch {
    /* 跨页广播失败静默忽略（目标页面可能未打开） */
  }
}
