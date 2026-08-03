import type { Req, Res } from '../core/messaging/protocol'
import { handlers } from './handlers'

/** 注册后台消息路由：type → handler，统一回包结构并异步透传 requestId。 */
export function registerMessageRouter(): void {
  if (!chrome.runtime?.onMessage) return
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return false
    const req = msg as Req
    const handler = handlers[req.type]
    if (!handler) {
      sendResponse({ requestId: req.requestId, ok: false, error: { kind: 'UNKNOWN_TYPE', message: req.type } } as Res)
      return false
    }
    Promise.resolve()
      .then(() => handler(req.payload, req))
      .then((data) => sendResponse({ requestId: req.requestId, ok: true, data } as Res))
      .catch((e) =>
        sendResponse({
          requestId: req.requestId,
          ok: false,
          error: { kind: (e as { kind?: string })?.kind ?? 'ERROR', message: e instanceof Error ? e.message : String(e) },
        } as Res),
      )
    return true // 异步 sendResponse：保持消息通道开放
  })
}
