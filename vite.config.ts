import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.config'

export default defineConfig({
  plugins: [vue(), crx({ manifest })],
  build: {
    // MV3 不支持代码分割到多个 chunk（SW/侧边栏需独立）
    chunkSizeWarningLimit: 1500,
  },
})
