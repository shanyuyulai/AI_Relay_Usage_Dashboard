import { settingsRepo } from './config'

// 单击图标行为（配置界面设置，非实验室）：'panel' = 极简面板，'sidebar' = 侧边栏。
// 注意：仅在实验室「用量看板」开关开启时，「极简面板」才生效；否则一律打开侧边栏。
export const CLICK_BEHAVIOR_KEY = 'aihub.clickBehavior'
export type ClickBehavior = 'panel' | 'sidebar'
export const DEFAULT_CLICK_BEHAVIOR: ClickBehavior = 'panel'

export async function getClickBehavior(): Promise<ClickBehavior> {
  const raw = await settingsRepo.get<ClickBehavior>(CLICK_BEHAVIOR_KEY)
  return raw === 'sidebar' ? 'sidebar' : DEFAULT_CLICK_BEHAVIOR
}

export async function setClickBehavior(v: ClickBehavior): Promise<ClickBehavior> {
  const safe: ClickBehavior = v === 'sidebar' ? 'sidebar' : 'panel'
  await settingsRepo.set(CLICK_BEHAVIOR_KEY, safe)
  return safe
}
