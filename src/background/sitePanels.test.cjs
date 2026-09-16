const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const source = fs.readFileSync(path.resolve(__dirname, '../options/App.vue'), 'utf8')
function load() {
  const requests = [], errors = []
  const section = source.slice(source.indexOf('const diagSiteId ='), source.indexOf('function exportDiags('))
  const custom = source.slice(source.indexOf('function closeCustom('), source.indexOf('async function saveCustom('))
  const ctx = { ref: (value) => ({ value }), confirm: () => true,
    send: (type, args) => new Promise((resolve, reject) => requests.push({ type, args, resolve, reject })),
    showToast: (value) => errors.push(value), safeUiError: (e) => e.message,
    expandedSiteId: { value: null }, drafts: { value: {} },
  }
  vm.createContext(ctx)
  vm.runInContext(ts.transpileModule(section + custom + '\nglobalThis.api = { toggleDiag, closeDiag, clearDiags, diagSiteId, diags, diagsLoading, toggleCustom, closeCustom }', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx)
  return { ...ctx, ...ctx.api, requests, errors }
}
test('both panel headers have explicit close controls, with no delete/save behavior', () => {
  assert.match(source, /@click="closeCustom">× 关闭<\/button>/)
  assert.match(source, /@click="closeDiag">× 关闭<\/button>/)
  assert.match(source, /关闭自定义采集：/); assert.match(source, /关闭诊断日志：/)
})
test('close/reopen custom panel preserves unsaved draft and sends no messages', () => {
  const api = load(), site = { id: 'a', customRequests: '/saved' }
  api.toggleCustom(site); api.drafts.value.a = '/unsaved'; api.closeCustom()
  assert.equal(api.expandedSiteId.value, null)
  api.toggleCustom(site); assert.equal(api.drafts.value.a, '/unsaved')
  assert.equal(api.requests.length, 0)
})
test('closing diagnostics rejects a late response without reopening or clearing stored logs', async () => {
  const api = load(), work = api.toggleDiag({ id: 'a' })
  api.closeDiag(); api.requests[0].resolve([{ id: 1 }]); await work
  assert.equal(api.diagSiteId.value, null); assert.equal(api.diags.value.length, 0)
  assert.equal(api.diagsLoading.value, false)
  assert.deepEqual(api.requests.map((r) => r.type), ['GET_DIAGNOSTICS'])
})
test('switching diagnostics A to B rejects old A result or failure', async () => {
  for (const failure of [false, true]) {
    const api = load(), a = api.toggleDiag({ id: 'a' }), b = api.toggleDiag({ id: 'b' })
    if (failure) api.requests[0].reject(Error('stale')); else api.requests[0].resolve([{ id: 'old' }])
    await a; assert.equal(api.diagsLoading.value, true); assert.equal(api.errors.length, 0)
    api.requests[1].resolve([{ id: 'new' }]); await b
    assert.equal(api.diags.value[0].id, 'new'); assert.equal(api.diagSiteId.value, 'b')
  }
})
test('close/reopen same site creates a new generation', async () => {
  const api = load(), first = api.toggleDiag({ id: 'a' }); api.closeDiag()
  const second = api.toggleDiag({ id: 'a' })
  api.requests[0].resolve([{ id: 'old' }]); await first
  assert.equal(api.diags.value.length, 0); assert.equal(api.diagsLoading.value, true)
  api.requests[1].resolve([{ id: 'new' }]); await second
  assert.equal(api.diags.value[0].id, 'new')
})
test('old clear operation cannot erase a newly opened diagnostic view', async () => {
  const api = load(), read = api.toggleDiag({ id: 'a' })
  api.requests[0].resolve([{ id: 'a' }]); await read
  const clear = api.clearDiags({ id: 'a', name: 'A' }), other = api.toggleDiag({ id: 'b' })
  api.requests[2].resolve([{ id: 'b' }]); await other
  api.requests[1].resolve({ ok: true }); await clear
  assert.equal(api.diags.value[0].id, 'b')
})
