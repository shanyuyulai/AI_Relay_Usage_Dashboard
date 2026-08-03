import { defineManifest } from '@crxjs/vite-plugin'

// MV3 最小权限；站点域走 optional_host_permissions，添加时动态 request（P0-5）
export default defineManifest({
  manifest_version: 3,
  name: 'AI 中转站用量趋势',
  version: '0.1.0',
  description: '在一个侧边栏里统一查看多个 AI API 中转站的余额与真实用量',
  permissions: [
    'storage',
    'alarms',
    'cookies',
    'tabs',
    'scripting',
    'sidePanel',
    'activeTab',
    'webRequest',
    'notifications', // 定时后台采集时告知用户（临时开窗口 / 会话过期）
    'declarativeNetRequest', // 实验室 CORS 放行：动态给站点响应加 Access-Control-Allow-Origin: *
    'unlimitedStorage', // 解除扩展自身 IndexedDB 配额顾虑，采集数据可长期保存
  ],
  icons: {
    '128': 'icon-128.png',
  },
  // 站点域不在此静态声明，由 ADD_SITE 时动态 chrome.permissions.request(origin + '/*')（P0-5 逐站授权）
  host_permissions: [],
  // 运行时可申请的域白名单：<all_urls> 仅作为「可申请范围」，实际只申请用户填入的具体 origin
  optional_host_permissions: ['<all_urls>'],
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  action: {
    default_title: 'AI 中转站用量趋势',
  },
  side_panel: {
    default_path: 'src/sidepanel/index.html',
  },
  options_page: 'src/options/index.html',
})
