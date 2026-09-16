let refs = 0
let timer: ReturnType<typeof setInterval> | undefined
/** Reference counted, idempotent release; not a substitute for persistent recovery. */
export function acquireKeepAlive(): () => void {
  refs++
  if (!timer) timer = setInterval(() => {
    void chrome.runtime.getPlatformInfo().catch(() => {})
  }, 5000)
  let released = false
  return () => {
    if (released) return
    released = true
    refs--
    if (refs === 0 && timer) {
      clearInterval(timer)
      timer = undefined
    }
  }
}
