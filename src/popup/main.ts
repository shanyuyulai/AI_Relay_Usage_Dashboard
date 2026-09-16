import { createApp, markRaw } from 'vue'
import PluginShell from '../shared/PluginShell.vue'
import Popup from './Popup.vue'
import '../styles/theme.css'
import { initTheme } from '../shared/theme'
import { installScrollbarStyles } from '../shared/scrollbars'

installScrollbarStyles(true)

initTheme().finally(() => {
  createApp(PluginShell, { content: markRaw(Popup), allowExport: false }).mount('#app')
})
