import { setupBalanceAlerts, stopBalanceAlerts, restoreBalanceAlertSchedule, flushBalanceAlerts } from './alerts'
// AI Relay Service Worker — 唤醒入口
// 职责：图标点击行为（实验室「用量看板」开关 + 配置界面的「单击行为」单选共同决定单击弹极简面板还是开侧栏）、
// 确保采集 alarm、注册消息路由。无长驻状态（MV3）。
import { reconcileSchedulerResources, setupScheduler } from './scheduler'
import { configurePluginResources, initializePlugin, reconcilePluginRuntime, runPluginTask } from './pluginGate'
import { registerMessageRouter } from './router'
import { getLabCorsUnblock, runAuthStateMigration } from '../storage'
import { reconcileCorsResources } from './corsRules'
import { applyIconBehavior } from './popupBehavior'

console.log('[AI Relay] Service Worker started')

// Register one resource writer before any business handler or alarm can run.
configurePluginResources(async (enabled) => {
  if (enabled) {
    await reconcileSchedulerResources(true)
    await reconcileCorsResources(await getLabCorsUnblock())
    await restoreBalanceAlertSchedule()
  } else {
    // Attempt both cleanup paths even if one Chrome API fails.
    const results = await Promise.allSettled([
      reconcileSchedulerResources(false), reconcileCorsResources(false), stopBalanceAlerts(),
    ])
    const failure = results.find((r) => r.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }
  await applyIconBehavior()
})

chrome.runtime.onInstalled.addListener(() => {
  void initializePlugin().then(() => reconcilePluginRuntime())
})

// 配置侧栏路径（不靠 manifest default_path，避免「点击必弹侧栏」抢走 popup 点击）。
// setOptions 只设定路径，不会自动打开；真正的打开由 onClicked 触发。
void chrome.sidePanel.setOptions({ path: 'src/sidepanel/index.html' }).catch((e) =>
  console.warn('[AI Relay] sidePanel.setOptions 失败', e),
)

// 单击图标需要「打开侧栏」时（实验室关 / 配置选侧栏），由本监听程序化打开侧栏。
// 注意：仅在 popup 未注册时才派发 onClicked（极简面板模式下 setPopup 已注册，本监听不触发）。
chrome.action.onClicked.addListener((tab) => {
  if (tab?.id == null) return
  void chrome.sidePanel.open({ tabId: tab.id }).catch((e) =>
    console.warn('[AI Relay] 打开侧边栏失败', e),
  )
})

// 每次 SW 唤醒都确保图标点击行为正确（setPopup 为持久化状态，重复执行幂等）。
void applyIconBehavior().catch(() => {
  // Keep a recovery page accessible even when preferences cannot be read.
  void chrome.action.setPopup({ popup: 'src/popup/index.html' })
})

// 启动采集调度 + 消息路由（SW 唤醒即装配，休眠即释放，不依赖内存单例）
setupScheduler()
setupBalanceAlerts()
registerMessageRouter()
void initializePlugin().then(async (state) => {
  if (state.effectiveState === 'enabled') await runPluginTask(async () => { await runAuthStateMigration(); await flushBalanceAlerts() })
}).catch((e) => console.warn('[AI Relay] 初始化失败', e))

console.log('[AI Relay] scheduler & message router registered')
