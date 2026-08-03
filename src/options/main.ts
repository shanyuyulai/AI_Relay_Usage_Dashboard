import { createApp } from 'vue'
import App from './App.vue'
import '../styles/theme.css'
import { initTheme } from '../shared/theme'

initTheme().finally(() => {
  createApp(App).mount('#app')
})
