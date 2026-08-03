// AI Relay Service Worker — 唤醒入口
// 职责：图标点击开侧栏、确保采集 alarm、注册消息路由。无长驻状态（MV3）。
import { ensureSchedulers, setupScheduler } from './scheduler'
import { registerMessageRouter } from './router'
import { getLabCorsUnblock } from '../storage'
import { applyCorsRules } from './corsRules'

console.log('[AI Relay] Service Worker started')

chrome.runtime.onInstalled.addListener(() => {
  // 点击工具栏图标时自动打开侧边栏
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.warn('[AI Relay] setPanelBehavior failed', e))
  // 确保采集 + 清理 alarm 存在且周期与设置一致
  void ensureSchedulers()
  // 若实验室 CORS 放行开启，重建规则
  void getLabCorsUnblock().then((enabled) => applyCorsRules(enabled))
})

// 启动采集调度 + 消息路由（SW 唤醒即装配，休眠即释放，不依赖内存单例）
setupScheduler()
registerMessageRouter()

console.log('[AI Relay] scheduler & message router registered')
