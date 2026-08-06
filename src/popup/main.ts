import { createApp } from 'vue'
import Popup from './Popup.vue'
import '../styles/theme.css'
import { initTheme } from '../shared/theme'

initTheme().finally(() => {
  createApp(Popup).mount('#app')
})
