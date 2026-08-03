import type { Req, Res } from './protocol'

/**
 * 消息客户端：Promise 化的 chrome.runtime.sendMessage 封装。
 * Side Panel 与 Options 共用，统一生成 requestId、超时与错误分类。
 */

/** 带错误分类的业务异常（UI 可按 kind 做差异化提示）。 */
export class MessagingError extends Error {
  readonly kind: string
  constructor(kind: string, message: string) {
    super(message)
    this.name = 'MessagingError'
    this.kind = kind
  }
}

let seq = 0
function genRequestId(): string {
  // crypto.randomUUID 在 extension page 与 SW 均可用；加 seq 防同一毫秒碰撞
  return `${Date.now().toString(36)}-${(++seq).toString(36)}`
}

/**
 * 向后台发送消息并返回 data。
 * @param type   消息类型（见 protocol.ts / handlers.ts）
 * @param payload 载荷（可空）
 * @param timeoutMs 超时（默认 30s；COLLECT_NOW 等耗时操作 UI 可传更大值）
 */
export function send<T = unknown>(type: string, payload?: unknown, timeoutMs = 30_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const requestId = genRequestId()
    const req: Req = { type, requestId, payload: payload ?? {} }
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new MessagingError('TIMEOUT', `请求 ${type} 超时（${timeoutMs}ms）`))
    }, timeoutMs)

    try {
      chrome.runtime.sendMessage(req, (res: Res<T> | undefined) => {
        if (settled) return
        settled = true
        clearTimeout(timer)

        // chrome.runtime.lastError 在通道异常时设置（如 SW 未注册）
        const lastErr = chrome.runtime.lastError
        if (lastErr) {
          reject(new MessagingError('RUNTIME', lastErr.message ?? '未知运行时错误'))
          return
        }
        if (!res) {
          reject(new MessagingError('EMPTY', `请求 ${type} 无响应`))
          return
        }
        if (res.ok) {
          resolve(res.data as T)
        } else {
          reject(
            new MessagingError(
              res.error?.kind ?? 'ERROR',
              res.error?.message ?? '未知错误',
            ),
          )
        }
      })
    } catch (e) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new MessagingError('EXCEPTION', e instanceof Error ? e.message : String(e)))
    }
  })
}
