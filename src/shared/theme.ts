/**
 * 主题模式（白天 / 黑夜 / 跟随系统）。
 *
 * 持久化到 chrome.storage.local，使 Options 与 Sidebar 两个独立页面共享同一设置；
 * 通过 chrome.storage.onChanged 实现跨页面实时同步（一处切换，另一处自动跟随）。
 *
 * 实际明暗通过给 <html> 切换 `theme-dark` 类实现（CSS 见 src/styles/theme.css）。
 */

export type ThemeMode = 'light' | 'dark' | 'auto'

const STORAGE_KEY = 'aihub.theme'
const DARK_CLASS = 'theme-dark'

let currentMode: ThemeMode = 'light'
let media: MediaQueryList | null = null

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

function effectiveDark(mode: ThemeMode): boolean {
  if (mode === 'auto') return systemPrefersDark()
  return mode === 'dark'
}

function applyClass(dark: boolean) {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle(DARK_CLASS, dark)
}

export async function getThemeMode(): Promise<ThemeMode> {
  try {
    const res = await chrome.storage.local.get(STORAGE_KEY)
    const m = res[STORAGE_KEY] as ThemeMode | undefined
    return m === 'dark' || m === 'auto' ? m : 'light'
  } catch {
    return 'light'
  }
}

/** 写存储 + 立即应用（并触发跨页面同步）。 */
export async function setThemeMode(mode: ThemeMode): Promise<void> {
  currentMode = mode
  applyClass(effectiveDark(mode))
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: mode })
  } catch {
    /* 存储失败时仍保证本页已应用 */
  }
}

/** 页面挂载时调用：读取设置、应用、注册系统监听与跨页同步。 */
export async function initTheme(): Promise<void> {
  currentMode = await getThemeMode()
  applyClass(effectiveDark(currentMode))

  // 注册系统配色变化监听（仅 auto 模式实际生效）
  if (!media && typeof window !== 'undefined' && window.matchMedia) {
    media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => {
      if (currentMode === 'auto') applyClass(systemPrefersDark())
    }
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onChange)
    } else if (typeof (media as any).addListener === 'function') {
      // 旧版 Safari
      ;(media as any).addListener(onChange)
    }
  }

  // 跨页面同步：Options/Sidebar 任一改主题，另一处自动跟随
  if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[STORAGE_KEY]) return
      const m = changes[STORAGE_KEY].newValue as ThemeMode | undefined
      if (m && m !== currentMode) {
        currentMode = m
        applyClass(effectiveDark(m))
      }
    })
  }
}
