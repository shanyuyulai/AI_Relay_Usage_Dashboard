import { getClickBehavior } from '../storage'

// 图标点击行为统一由本函数收敛，避免多处状态不一致：
//  - 配置「单击打开极简面板」 → 注册原生 popup，单击弹极简面板。
//  - 配置「单击打开侧边栏」    → 清空 popup，点击交给 onClicked → 打开侧边栏。
// 注意：本行为【独立于】实验室「用量看板」开关——实验室开关只控制设置页顶部「📊 用量看板」Tab 的显隐，
// 不干预图标单击行为。两者是互不相关的两个设置项。
// 现代 Chrome（126+）已废弃 setPanelBehavior(openPanelOnActionClick)，且 manifest 也不再声明
// side_panel.default_path（否则点击必弹侧栏、popup 永远抢不到）。故侧栏改为在 onClicked 里 sidePanel.open，
// 极简面板则注册原生 popup——两者互斥由 setPopup 的注册/清空控制。setPopup 为浏览器持久化，幂等。
export async function applyIconBehavior(): Promise<void> {
  const behavior = await getClickBehavior()
  const usePanel = behavior === 'panel'
  // 注册（极简面板）或清空（侧栏）原生 popup。
  await new Promise<void>((resolve) => {
    chrome.action.setPopup({ popup: usePanel ? 'src/popup/index.html' : '' }, () => {
      if (chrome.runtime.lastError) {
        console.warn('[AI Relay] setPopup 失败', chrome.runtime.lastError.message)
      }
      resolve()
    })
  })
}
