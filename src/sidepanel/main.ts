import { createApp, markRaw } from 'vue'
import PluginShell from '../shared/PluginShell.vue'
import App from './App.vue'
import '../styles/theme.css'
import { initTheme } from '../shared/theme'
import { installScrollbarStyles } from '../shared/scrollbars'

installScrollbarStyles(false)

initTheme().finally(() => {
  createApp(PluginShell, { content: markRaw(App), allowExport: false }).mount('#app')
})
