import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.config'

export default defineConfig({
  plugins: [vue(), crx({ manifest })],
  build: {
    // MV3 不支持代码分割到多个 chunk（SW/侧边栏需独立）
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      // manifest 未声明 side_panel（由 SW 动态 setOptions），@crxjs 不会自动编译该 HTML，
      // 需显式加入输入，否则 dist/src/sidepanel/index.html 缺失 → ERR_FILE_NOT_FOUND。
      input: {
        sidepanel: 'src/sidepanel/index.html',
      },
    },
  },
})
