import { initializePlugin, getPluginState, setPluginEnabled, runPluginTask } from './pluginGate'
import { acquireKeepAlive } from '../shared/keepAlive'
import type { Req, Res } from '../core/messaging/protocol'
import { handlers } from './handlers'

/**
 * 发送方校验（GPT P1-9）：只接受本扩展自身页面（sidepanel / options / popup / SW）的消息。
 * - sender.tab 存在 = 来自内容脚本 / 页面世界，一律拒绝（采集结果走 executeScript 返回值，不走消息）。
 * - 本扩展页面（chrome-extension:// 协议且无 sender.tab）直接信任；开发模式/HMR 下 options 页面与 SW 的
 *   runtime.id 可能漂移，因此不再把 sender.id 是否严格等于 selfId 作为唯一依据。
 * - SW 自发广播（url 为空）fallback 校验 sender.id 必须属于本扩展。
 */
function isTrustedSender(sender: chrome.runtime.MessageSender): boolean {
  // Own extension pages are checked before sender.tab because Chrome may set tab for them.
  const selfId = chrome.runtime.id
  const url = sender.url ?? ''

  // Extension pages are trusted by their own extension URL/ID before checking sender.tab.
  // Chrome may populate sender.tab for an extension page opened in a tab.
  const ownExtensionUrl = selfId && url.startsWith(`chrome-extension://${selfId}/`)
  if (ownExtensionUrl) {
    if (sender.id && sender.id !== selfId) {
      console.warn('[AI Relay] 拒：扩展页面 sender.id 不匹配', {
        got: sender.id,
        expect: selfId,
        url,
      })
      return false
    }
    return true
  }

  // CRXJS dev mode may load extension pages through a localhost dev server.
  if (
    url.startsWith('http://localhost') ||
    url.startsWith('http://127.0.0.1') ||
    url.startsWith('https://localhost') ||
    url.startsWith('https://127.0.0.1')
  ) {
    if (selfId && sender.id && sender.id !== selfId) {
      console.warn('[AI Relay] 拒：开发页面 sender.id 不匹配', {
        got: sender.id,
        expect: selfId,
        url,
      })
      return false
    }
    return true
  }

  // Other extension pages must never be trusted.
  if (url.startsWith('chrome-extension://')) {
    console.warn('[AI Relay] 拒：来自其他扩展', { url, id: sender.id })
    return false
  }

  // Reject content scripts/page worlds after handling extension pages.
  if (sender.tab) {
    console.warn('[AI Relay] 拒：来自 content script 或 page world（带 sender.tab）', {
      url: sender.url,
      tabId: sender.tab.id,
      origin: sender.origin,
    })
    return false
  }

  // Service Worker self-broadcasts have no sender URL.
  if (!url) {
    if (selfId && sender.id && sender.id !== selfId) {
      console.warn('[AI Relay] 拒：SW 广播 sender.id 不匹配', { got: sender.id, expect: selfId })
      return false
    }
    return true
  }

  // Unknown web origins are rejected.
  console.warn('[AI Relay] 拒：未知来源', { url })
  return false
}

/** 注册后台消息路由：type → handler，统一回包结构并异步透传 requestId。 */
export function registerMessageRouter(): void {
  if (!chrome.runtime?.onMessage) return
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const type = (msg as { type?: string })?.type
    // 原始收包日志（含完整 sender 指纹），确认消息是否到达 SW 及被拒原因
    console.info(
      '[AI Relay] 原始消息',
      type,
      'from',
      sender.url ?? sender.id ?? 'unknown',
      'sender=',
      JSON.stringify({ url: sender.url, id: sender.id, tab: !!sender.tab, origin: sender.origin }),
    )
    if (!msg || typeof type !== 'string') return false
    const req = msg as Req
    if (!isTrustedSender(sender)) {
      sendResponse({ requestId: req.requestId, ok: false, error: { kind: 'FORBIDDEN', message: '拒绝非扩展页面来源的消息' } } as Res)
      return false
    }
    const handler = req.type === 'GET_PLUGIN_ENABLED'
      ? () => initializePlugin().then(() => getPluginState())
      : req.type === 'SET_PLUGIN_ENABLED'
        ? (payload: any) => setPluginEnabled(payload?.enabled)
        : handlers[req.type]
    if (!handler) {
      console.warn('[AI Relay] 路由：未知消息类型', req.type)
      sendResponse({ requestId: req.requestId, ok: false, error: { kind: 'UNKNOWN_TYPE', message: req.type } } as Res)
      return false
    }
    console.info('[AI Relay] 路由：调用 handler', req.type, 'requestId=', req.requestId)
    const release = acquireKeepAlive()
    Promise.resolve()
      .then(() => {
        const control = ['GET_PLUGIN_ENABLED', 'SET_PLUGIN_ENABLED', 'EXPORT_CONFIG'].includes(req.type)
        return control ? handler(req.payload, req) : runPluginTask(() => handler(req.payload, req))
      })
      .then((data) => {
        console.info('[AI Relay] 路由：handler 成功', req.type, 'requestId=', req.requestId)
        sendResponse({ requestId: req.requestId, ok: true, data } as Res)
      })
      .catch((e) => {
        console.error('[AI Relay] 路由：handler 抛错', req.type, e)
        sendResponse({
          requestId: req.requestId,
          ok: false,
          error: { kind: (e as { kind?: string })?.kind ?? 'ERROR', message: e instanceof Error ? e.message : String(e) },
        } as Res)
      })
      .finally(release)
    return true // 异步 sendResponse：保持消息通道开放
  })
}
