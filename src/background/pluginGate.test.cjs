// Run: node --test src/background/pluginGate.test.cjs
// Execute actual TS modules using the project's installed TypeScript; no new dependency.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
function load(file, dependencies, globals = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../..', file), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const module = { exports: {} }
  const sandbox = { module, exports: module.exports, console, ...globals, require: (name) => {
    if (!(name in dependencies)) throw Error(`Unexpected dependency: ${name}`)
    return dependencies[name]
  } }
  vm.runInNewContext(js, sandbox, { filename: file })
  return module.exports
}
const parsers = load('src/storage/enableConfig.ts', { './db': { db: {} } })
function makeGate(initial = true) {
  let config = { enabled: initial, revision: 0 }
  let readError = false
  let refs = 0
  const calls = []
  const broadcasts = []
  const gate = load('src/background/pluginGate.ts', {
    '../storage/enableConfig': {
      readPluginConfig: async () => { if (readError) throw Error('db unavailable'); return { ...config } },
      writePluginEnabled: async (raw) => { config = { enabled: parsers.validatePluginEnabled(raw), revision: config.revision + 1 }; return { ...config } },
      validatePluginEnabled: parsers.validatePluginEnabled,
    },
    '../shared/pluginState': { PLUGIN_ENABLED_CHANGED: 'PLUGIN_ENABLED_CHANGED' },
    '../shared/keepAlive': { acquireKeepAlive: () => { refs++; let released = false; return () => { if (!released) { refs--; released = true } } } },
  }, { chrome: { runtime: { sendMessage: async (message) => { broadcasts.push(message) } } } })
  gate.configurePluginResources(async (enabled) => { calls.push(enabled) })
  return { gate, calls, broadcasts, setReadError: (v) => { readError = v }, refs: () => refs }
}
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }

test('missing default is enabled, invalid persisted values fail closed', () => {
  assert.equal(parsers.parsePluginEnabled(undefined), true)
  assert.equal(parsers.parsePluginEnabled(false), false)
  for (const value of [null, '', 'false', 0, {}, []]) assert.throws(() => parsers.parsePluginEnabled(value))
})
test('SET requires an explicit boolean', () => {
  for (const value of [undefined, null, 'true', 1]) assert.throws(() => parsers.validatePluginEnabled(value), (e) => e.kind === 'VALIDATION_ERROR')
})
test('initialized disabled installation does not restore resources', async () => {
  const { gate, calls } = makeGate(false)
  assert.equal((await gate.initializePlugin()).effectiveState, 'disabled')
  assert.deepEqual(calls, [false])
  await assert.rejects(gate.runPluginTask(async () => 1), (e) => e.kind === 'PLUGIN_DISABLED')
})
test('database failure denies business and attempts resource cleanup', async () => {
  const x = makeGate()
  x.setReadError(true)
  assert.equal((await x.gate.initializePlugin()).effectiveState, 'error')
  assert.deepEqual(x.calls, [false])
  await assert.rejects(x.gate.runPluginTask(async () => 1), (e) => e.kind === 'PLUGIN_STATE_UNAVAILABLE')
})
test('stop drains active work and denies new jobs, then restores on enable', async () => {
  const x = makeGate(); await x.gate.initializePlugin()
  const entered = deferred(), finish = deferred()
  const work = x.gate.runPluginTask(async () => { entered.resolve(); await finish.promise; return 42 })
  await entered.promise
  const stopping = x.gate.setPluginEnabled(false)
  // A registered business task may finish via preference reconciliation during stop.
  // This must not queue behind a coordinator waiting for that same task.
  await new Promise((r) => setImmediate(r))
  assert.equal(x.gate.getPluginState().effectiveState, 'disabling')
  await assert.rejects(x.gate.runPluginTask(async () => 9))
  await x.gate.reconcilePluginRuntime()
  finish.resolve()
  assert.equal(await work, 42)
  assert.equal((await stopping).effectiveState, 'disabled')
  assert.equal((await x.gate.setPluginEnabled(true)).effectiveState, 'enabled')
  assert.equal(x.refs(), 0)
})
test('concurrent close and preference reconcile cannot deadlock', { timeout: 2000 }, async () => {
  const x = makeGate(); await x.gate.initializePlugin()
  const entered = deferred(), resume = deferred()
  const work = x.gate.runPluginTask(async () => { entered.resolve(); await resume.promise; await x.gate.reconcilePluginRuntime() })
  await entered.promise
  const stop = x.gate.setPluginEnabled(false)
  resume.resolve()
  await Promise.all([work, stop])
  assert.equal(x.gate.getPluginState().effectiveState, 'disabled')
})
test('rapid toggles end at last accepted target and release keepalive', async () => {
  const x = makeGate(); await x.gate.initializePlugin()
  await Promise.all([false, true, false, true, false].map((v) => x.gate.setPluginEnabled(v)))
  assert.equal(x.gate.getPluginState().desiredEnabled, false)
  assert.equal(x.gate.getPluginState().effectiveState, 'disabled')
  assert.equal(x.gate.getPluginState().revision, 5)
  assert.equal(x.refs(), 0)
})
test('cleanup failure remains closed and explicit retry can recover', async () => {
  const x = makeGate(); await x.gate.initializePlugin()
  x.gate.configurePluginResources(async () => { throw Error('Chrome API failed') })
  assert.equal((await x.gate.setPluginEnabled(false)).effectiveState, 'error')
  await assert.rejects(x.gate.runPluginTask(async () => 1))
  x.gate.configurePluginResources(async () => {})
  assert.equal((await x.gate.setPluginEnabled(false)).effectiveState, 'disabled')
})
test('keepalive release is reference-counted and idempotent', () => {
  let intervals = 0, cleared = 0
  const mod = load('src/shared/keepAlive.ts', {}, {
    setInterval: () => { intervals++; return 17 }, clearInterval: () => { cleared++ },
    chrome: { runtime: { getPlatformInfo: async () => ({}) } },
  })
  const a = mod.acquireKeepAlive(), b = mod.acquireKeepAlive()
  assert.equal(intervals, 1); a(); a(); assert.equal(cleared, 0); b(); assert.equal(cleared, 1)
})
