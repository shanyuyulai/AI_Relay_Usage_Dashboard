import { createApp } from 'vue'
import App from './App.vue'
import '../styles/theme.css'
import { initTheme } from '../shared/theme'
import { installScrollbarStyles } from '../shared/scrollbars'

installScrollbarStyles(true)

// 等主题类就绪后再挂载，避免明暗闪烁（与 popup / sidepanel 同套路）。
initTheme().finally(() => {
  createApp(App).mount('#app')
})
