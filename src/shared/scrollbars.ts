/**
 * 039: install one local CSS resource per document, including the recovery shell.
 * No scroll/wheel listener, DOM wrapper, permission request, or theme subscription.
 */
export function installScrollbarStyles(compact = false): void {
  if (typeof document === 'undefined' || typeof chrome === 'undefined' || !chrome.runtime?.getURL) return
  const root = document.documentElement
  try {
    const href = chrome.runtime.getURL('scrollbars.css')
    root.classList.add('app-scrollbars')
    root.classList.toggle('app-scrollbars-compact', compact)
    if (document.getElementById('aihub-scrollbar-styles')) return
    const link = document.createElement('link')
    link.id = 'aihub-scrollbar-styles'
    link.rel = 'stylesheet'
    link.href = href
    link.addEventListener('error', () => {
      root.classList.remove('app-scrollbars', 'app-scrollbars-compact')
      link.remove() // A later installation attempt can retry; never block app startup.
      console.warn('[AI Relay] 滚动条样式未加载，已回退为原生滚动条')
    }, { once: true })
    document.head.appendChild(link)
  } catch {
    root.classList.remove('app-scrollbars', 'app-scrollbars-compact')
    // Cosmetic failure must not prevent the user from opening settings or re-enabling.
  }
}
