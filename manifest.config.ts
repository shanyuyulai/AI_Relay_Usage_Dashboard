import { defineManifest } from '@crxjs/vite-plugin'

// MV3 最小权限；站点域走 optional_host_permissions，添加时动态 request（P0-5）
export default defineManifest({
  manifest_version: 3,
  name: 'AI 中转站用量看板',
  version: '0.3.2',
  // 固定扩展公钥，使开发模式下扩展 ID 在 reload 后保持不变，避免 options 页面与 SW 的 runtime.id 漂移。
  // 该 key 仅在本地开发/侧载使用；发布到 Chrome Web Store 时会被商店签名覆盖，不影响线上分发。
  key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0UdikbhtN+wZW6Hh1uD7NfE9Oq5Q1PRDNcsxjoz/czRREWl1FCB4Uhl1TynEVATioiWBi7GSQbGQnKoRNPzHE0ACI8az1mLH4J1OaRl0/lRcPmgyweBrJB9vaGp5JJ8Ka/NtB/HyfcuQpsAwue+mkvm4Gl3Y05AGVX7kRUodmk+B7nfbA246MqheZaHvCOozQYysziJjDzQQg8JZkBW1v08UDtGIROsOQX8ZfJEVdbJb0sRXbD2HQA1TJrSASfGUiC49ScZPT10cUyRCIud9Ftq3v2afiZxr7+RaUwtRNA7lJ3Wvx3xLRc7Vnc21jybZxqOt7F3MvoKmO1DMmJjO3QIDAQAB',
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
    '16': 'icon-16.png',
    '48': 'icon-48.png',
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
    default_title: 'AI 中转站用量看板',
    // 仅为了让 @crxjs 把该 HTML 编译进 dist（单击/双击逻辑改用 onClicked 在 SW 内接管）。
    // 运行时 SW 启动即把 default_popup 清空（setPopup('')），否则 default_popup 存在时
    // 点击图标不会派发 onClicked，也就无法区分单击/双击。
    default_popup: 'src/popup/index.html',
  },
  // 不声明 side_panel 键：现代 Chrome 里一旦写 side_panel 就必须带 default_path，
  // 而 default_path 会让「点击图标必定弹侧边栏」且无法用 setPanelBehavior 关掉，抢占极简 popup。
  // 侧栏路径改由 SW 启动时 chrome.sidePanel.setOptions({path}) 程序化配置，点击由 onClicked → sidePanel.open 触发。
  options_page: 'src/options/index.html',
})
