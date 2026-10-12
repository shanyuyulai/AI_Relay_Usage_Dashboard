/**
 * 打开「模型价格详情」独立窗口（方案 049r1，050r1 更名：均价→价格）。
 * - 双击极简面板 / 完整看板的价格数字触发；独立窗口不受 popup 尺寸限制，
 *   全部站点一次性展开展示，无需折叠。
 * - siteId：双击来源站点，详情页高亮并滚动定位（URL 参数 ?site=）。
 * - type: 'popup' 无地址栏/标签页的独立小窗；触发后原 popup 失焦自动收起属预期行为。
 */
export function openAvgDetailWindow(siteId?: string): void {
  try {
    const url = new URL(chrome.runtime.getURL('src/avgdetail/index.html'))
    if (siteId) url.searchParams.set('site', siteId)
    void chrome.windows.create({ url: url.href, type: 'popup', width: 620, height: 720 })
  } catch {
    /* 扩展上下文失效等极端情况：静默忽略 */
  }
}
