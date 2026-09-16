const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const source = fs.readFileSync(path.resolve(__dirname, '../shared/siteIcons.ts'), 'utf8')
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const imageResponse = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
function load(options = {}) {
  let now = 1_000_000, created = 0, revoked = 0
  const calls = []
  class TestURL extends URL {
    static createObjectURL() { return 'blob:test-' + ++created }
    static revokeObjectURL() { revoked++ }
  }
  class FakeImage {
    naturalWidth = 32; naturalHeight = 32
    set src(value) {
      if (!value || options.imageHang) return
      queueMicrotask(() => { if (options.decodeFailure) this.onerror?.(); else this.onload?.() })
    }
  }
  const module = { exports: {} }
  const context = {
    module, exports: module.exports, URL: TestURL, Image: FakeImage,
    Blob, AbortController, Uint8Array, TextDecoder, setTimeout: options.timer ?? setTimeout, clearTimeout,
    Date: class extends Date { static now() { return now } },
    chrome: { permissions: { contains: async () => options.permission !== false } },
    fetch: async (url, init) => { calls.push({ url, init }); return options.fetch ? options.fetch(url, init) : imageResponse() },
    document: { createElement: (tag) => { assert.equal(tag, 'canvas'); return { getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:image/png;base64,dGVzdA==' } } },
  }
  vm.runInNewContext(js, context)
  return { ...module.exports, calls, advance: (ms) => { now += ms }, urls: () => ({ created, revoked }) }
}
const tick = () => new Promise((resolve) => setImmediate(resolve))
test('icon origin rejects credentials, invalid and non-http addresses', () => {
  const api = load()
  for (const value of ['data:image/png,a', 'javascript:alert(1)', 'ftp://x.test', 'https://u:p@x.test', 'bad']) assert.equal(api.iconOrigin(value), null)
  assert.equal(api.iconOrigin('https://EXAMPLE.com/path?token=private#x'), 'https://example.com')
})
test('icon candidates are restricted to exact origin and HTTP(S)', () => {
  const api = load(), origin = 'https://x.test'
  for (const href of ['https://cdn.test/a.png', '//evil.test/x', 'data:image/svg+xml,a', 'https://u:p@x.test/a', 'http://x.test/a']) assert.equal(api.iconCandidate(href, origin), null)
  assert.equal(api.iconCandidate('/assets/icon.png#x', origin), 'https://x.test/assets/icon.png')
})
test('link extraction supports attributes/entities, deduplicates and caps candidates', () => {
  const api = load()
  const html = `<link rel="shortcut icon" href="/a.png?a=1&amp;b=2"><link REL='ICON' HREF=/b.ico>
  <link rel=apple-touch-icon href=/c.png><link rel=icon href=/d.png><img src=https://evil.test/pixel>`
  assert.deepEqual(Array.from(api.declaredIcons(html, 'https://x.test')), ['https://x.test/a.png?a=1&b=2', 'https://x.test/b.ico', 'https://x.test/c.png'])
  assert.deepEqual(Array.from(api.declaredIcons('<link rel=stylesheet href=/css><link rel=icon href=//cdn.test/x><link rel=icon href=/favicon.ico><link rel=icon href=/a><link rel=icon href=/a>', 'https://x.test')), ['https://x.test/a'])
})
test('remote HTML is never inserted/parsed into a resource-loading browser DOM', () => {
  assert.doesNotMatch(source, /new DOMParser|innerHTML|insertAdjacentHTML/)
})
test('byte limit rejects both declared and streaming oversized bodies', async () => {
  const api = load()
  await assert.rejects(api.readLimited(new Response('a', { headers: { 'content-length': '999' } }), 4))
  await assert.rejects(api.readLimited(new Response('12345'), 4))
  assert.equal((await api.readLimited(new Response('1234'), 4)).length, 4)
})
test('no host permission means no network request', async () => {
  const api = load({ permission: false }), sub = api.subscribeSiteIcon('https://x.test')
  assert.equal(await sub.result, null); sub.release(); assert.equal(api.calls.length, 0)
})
test('image request omits credentials and referrer, rejects redirects, releases blob URL', async () => {
  const api = load(), sub = api.subscribeSiteIcon('https://x.test/path?secret=x')
  assert.match(await sub.result, /^data:image\/png;base64,/)
  assert.equal(api.calls[0].url, 'https://x.test/favicon.ico')
  assert.equal(api.calls[0].init.credentials, 'omit')
  assert.equal(api.calls[0].init.redirect, 'error')
  assert.equal(api.calls[0].init.referrerPolicy, 'no-referrer')
  assert.deepEqual(api.urls(), { created: 1, revoked: 1 }); sub.release()
})
test('same origin concurrent subscribers and settled success share one fetch', async () => {
  const api = load(), first = api.subscribeSiteIcon('https://x.test/a'), second = api.subscribeSiteIcon('https://x.test/b')
  assert.equal(first.result, second.result)
  first.release(); await second.result; second.release()
  const cached = api.subscribeSiteIcon('https://x.test'); await cached.result; cached.release()
  assert.equal(api.calls.length, 1)
})
test('404 favicon falls back to same-origin declared icon', async () => {
  const api = load({ fetch: async (url) => {
    if (url.endsWith('/favicon.ico')) return new Response('', { status: 404 })
    if (url.endsWith('/')) return new Response('<link rel=icon href=/assets/logo.svg>', { headers: { 'content-type': 'text/html' } })
    return imageResponse()
  } })
  const sub = api.subscribeSiteIcon('https://x.test'); assert.ok(await sub.result); sub.release()
  assert.deepEqual(api.calls.map((c) => c.url), ['https://x.test/favicon.ico', 'https://x.test/', 'https://x.test/assets/logo.svg'])
})
test('HTML response masquerading as favicon never enters image decoding', async () => {
  const api = load({ fetch: async () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }) })
  const sub = api.subscribeSiteIcon('https://x.test'); assert.equal(await sub.result, null); sub.release()
  assert.deepEqual(api.urls(), { created: 0, revoked: 0 })
})
test('decode failure safely resolves null and releases temporary image URL', async () => {
  const api = load({ decodeFailure: true }), sub = api.subscribeSiteIcon('https://x.test')
  assert.equal(await sub.result, null); sub.release()
  assert.deepEqual(api.urls(), { created: 1, revoked: 1 })
})
test('failure cache expires at five minutes and success cache at thirty', async () => {
  for (const failure of [false, true]) {
    const api = load(failure ? { fetch: async () => new Response('', { status: 404 }) } : {})
    let sub = api.subscribeSiteIcon('https://x.test'); await sub.result; sub.release()
    const initialCalls = api.calls.length
    sub = api.subscribeSiteIcon('https://x.test'); await sub.result; sub.release()
    assert.equal(api.calls.length, initialCalls)
    api.advance((failure ? 5 : 30) * 60_000 + 1)
    sub = api.subscribeSiteIcon('https://x.test'); await sub.result; sub.release()
    assert.equal(api.calls.length, initialCalls * 2)
  }
})
test('last subscriber release cancels fetch, and a later visit may retry', async () => {
  const api = load({ fetch: async (_, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  }) })
  const sub = api.subscribeSiteIcon('https://x.test'); await tick()
  sub.release(); sub.release(); assert.equal(await sub.result, null)
  assert.ok(api.calls[0].init.signal.aborted)
  const retry = api.subscribeSiteIcon('https://x.test'); await tick(); retry.release(); await retry.result
  assert.equal(api.calls.length, 2)
})
test('at most four active jobs; cancelled queued jobs do not fetch', async () => {
  const api = load({ fetch: async (_, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  }) })
  const subs = Array.from({ length: 10 }, (_, i) => api.subscribeSiteIcon(`https://x${i}.test`))
  await tick(); assert.equal(api.calls.length, 4)
  subs.forEach((sub) => sub.release()); await Promise.all(subs.map((sub) => sub.result))
  assert.equal(api.calls.length, 4)
})
test('task deadline aborts stalled decoding and frees its object URL', async () => {
  const api = load({ imageHang: true, timer: (fn) => setTimeout(fn, 15) })
  const sub = api.subscribeSiteIcon('https://x.test'); assert.equal(await sub.result, null); sub.release()
  assert.deepEqual(api.urls(), { created: 1, revoked: 1 })
})
test('completed cache is bounded at 64 entries', async () => {
  const api = load()
  for (let i = 0; i < 65; i++) {
    const sub = api.subscribeSiteIcon(`https://x${i}.test`); await sub.result; sub.release()
  }
  const sub = api.subscribeSiteIcon('https://x0.test'); await sub.result; sub.release()
  assert.equal(api.calls.length, 66)
})
test('three station avatar views use shared avatar and component guards stale async results', () => {
  for (const filename of ['../options/App.vue', '../sidepanel/App.vue', '../sidepanel/components/SiteDetail.vue']) {
    assert.match(fs.readFileSync(path.resolve(__dirname, filename), 'utf8'), /<SiteAvatar /)
  }
  const component = fs.readFileSync(path.resolve(__dirname, '../shared/SiteAvatar.vue'), 'utf8')
  assert.match(component, /current === version/)
  assert.match(component, /onBeforeUnmount/)
  assert.match(component, /@error="icon = null"/)
  assert.match(component, /<span v-else>\{\{ initial \}\}<\/span>/)
})

test('minimal popup keeps the status dot without loading website icons', () => {
  const popup = fs.readFileSync(path.resolve(__dirname, '../popup/Popup.vue'), 'utf8')
  assert.doesNotMatch(popup, /SiteAvatar|subscribeSiteIcon/)
  assert.match(popup, /class="dot"/)
})
