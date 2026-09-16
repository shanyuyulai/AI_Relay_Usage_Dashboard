const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const source = fs.readFileSync(path.resolve(__dirname, '../options/App.vue'), 'utf8')
function setup(send) {
  const section = source.slice(source.indexOf('const togglingSiteIds ='), source.indexOf('// —— 诊断日志面板'))
  let loads = 0
  const errors = []
  const context = { ref: (value) => ({ value }), send, loadSites: async () => { loads++ }, showToast: (e) => errors.push(e), safeUiError: (e) => e.message }
  vm.createContext(context)
  vm.runInContext(ts.transpileModule(section + '\nglobalThis.api = { toggleEnabled, togglingSiteIds }', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
  return { ...context.api, errors, loads: () => loads }
}
test('site switch binds current state, accessible name and pending disabled state', () => {
  const markup = source.slice(source.indexOf('<div class="site-switch"'), source.indexOf('<button class="mini" @click="openEdit(site)">编辑'))
  for (const binding of ['role="switch"', 'type="button"', ':aria-checked="site.enabled"', ':aria-label="\'启用站点 \' + site.name"', ':disabled="!!togglingSiteIds[site.id]"', '@click="toggleEnabled(site)"']) assert.ok(markup.includes(binding), binding)
  assert.ok(markup.includes('已启用') && markup.includes('已禁用'))
})
test('same site cannot submit twice while other sites remain independent', async () => {
  const pending = [], calls = []
  const api = setup((type, data) => { calls.push({ type, data }); return new Promise((resolve) => pending.push(resolve)) })
  const a = { id: 'a', enabled: true }, b = { id: 'b', enabled: false }
  const first = api.toggleEnabled(a)
  await api.toggleEnabled(a)
  const second = api.toggleEnabled(b)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].type, 'UPDATE_SITE')
  assert.equal(calls[0].data.patch.enabled, false)
  assert.equal(calls[1].data.patch.enabled, true)
  assert.equal(a.enabled, true) // Do not pretend a pending save has succeeded.
  assert.ok(api.togglingSiteIds.value.a && api.togglingSiteIds.value.b)
  pending.forEach((resolve) => resolve()); await Promise.all([first, second])
  assert.equal(api.loads(), 2)
  assert.equal(Object.keys(api.togglingSiteIds.value).length, 0)
})
test('failed update leaves state intact, reports error and unlocks retry', async () => {
  let calls = 0
  const api = setup(async () => { calls++; if (calls === 1) throw Error('save failed') })
  const site = { id: 'a', enabled: true }
  await api.toggleEnabled(site)
  assert.equal(site.enabled, true); assert.equal(api.errors[0], 'save failed')
  assert.equal(api.loads(), 0); assert.ok(!api.togglingSiteIds.value.a)
  await api.toggleEnabled(site)
  assert.equal(calls, 2); assert.equal(api.loads(), 1)
})
