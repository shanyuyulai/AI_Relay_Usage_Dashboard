// AI Relay Service Worker — 唤醒入口
// 职责：图标点击行为（实验室「用量看板」开关 + 配置界面的「单击行为」单选共同决定单击弹极简面板还是开侧栏）、
// 确保采集 alarm、注册消息路由。无长驻状态（MV3）。
import { ensureSchedulers, setupScheduler } from './scheduler'
import { registerMessageRouter } from './router'
import { getLabCorsUnblock, db, runAuthStateMigration } from '../storage'
import { applyCorsRules } from './corsRules'
import { applyIconBehavior } from './popupBehavior'

console.log('[AI Relay] Service Worker started')

// 预打开 IndexedDB（含一次性迁移）：避免在首条消息的异步 handler 内才懒打开，
// 降低 MV3 SW 在「打开+迁移」期间被休眠、导致 handler 挂死/客户端超时的概率。
void db.open()
  .then(() => runAuthStateMigration())
  .catch((e) => console.warn('[AI Relay] DB 预打开/授权状态迁移失败', e))

chrome.runtime.onInstalled.addListener(() => {
  // 确保采集 + 清理 alarm 存在且周期与设置一致
  void ensureSchedulers()
  // 若实验室 CORS 放行开启，重建规则
  void getLabCorsUnblock().then((enabled) => applyCorsRules(enabled))
  // 同步图标点击行为：实验室「用量看板」开关 + 配置界面「单击行为」单选共同决定
  // 单击是弹极简面板还是开侧边栏（详见 popupBehavior.ts）。
  void applyIconBehavior()
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
void applyIconBehavior()

// 启动采集调度 + 消息路由（SW 唤醒即装配，休眠即释放，不依赖内存单例）
setupScheduler()
registerMessageRouter()

console.log('[AI Relay] scheduler & message router registered')
