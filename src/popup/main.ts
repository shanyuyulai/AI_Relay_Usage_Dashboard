import { createApp, markRaw } from 'vue'
import PluginShell from '../shared/PluginShell.vue'
import Popup from './Popup.vue'
import '../styles/theme.css'
import { initTheme } from '../shared/theme'
import { installScrollbarStyles } from '../shared/scrollbars'

installScrollbarStyles(true)

// 方案 041：弹窗定宽与首帧骨架由 index.html 的内联样式静态给定；这里仍等主题类就绪后再挂载，避免明暗闪烁。
// compact：popup 在确认插件状态期间只显示一行占位，而不是整块「插件运行控制」卡片。
initTheme().finally(() => {
  createApp(PluginShell, { content: markRaw(Popup), allowExport: false, compact: true }).mount('#app')
})
