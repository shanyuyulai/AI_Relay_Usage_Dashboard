/** 站点级互斥锁：同一站点在主动/定时/被动三类采集中不并发重入（P1-2）。 */
const siteLocks = new Map<string, Promise<unknown>>()

export function acquireSiteLock<T>(siteId: string, fn: () => Promise<T>): Promise<T> {
  const prev = siteLocks.get(siteId) ?? Promise.resolve()
  const next: Promise<T> = prev.then(fn, fn) // 不论上一次成败，都排队执行本次
  const marker = next.then(
    () => undefined,
    () => undefined,
  )
  siteLocks.set(siteId, marker)
  void marker.then(() => {
    if (siteLocks.get(siteId) === marker) siteLocks.delete(siteId)
  })
  return next
}

/**
 * 全局并发闸：限制对中转站 API 的并发与最小请求间隔，避免请求风暴（P1-2）。
 * max=2：单 origin 并发上限；minIntervalMs=500：相邻请求最小间隔。
 */
class RequestGate {
  private active = 0
  private lastStart = 0
  constructor(
    private readonly max: number,
    private readonly minIntervalMs: number,
  ) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const tryAcquire = () => {
        const now = Date.now()
        if (this.active < this.max && now - this.lastStart >= this.minIntervalMs) {
          this.active++
          this.lastStart = now
          fn().then(resolve, reject).finally(() => {
            this.active--
          })
        } else {
          setTimeout(tryAcquire, 50)
        }
      }
      tryAcquire()
    })
  }
}

export const requestGate = new RequestGate(2, 500)

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
