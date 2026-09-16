const { test, beforeEach, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const fake = require('fake-indexeddb')
global.indexedDB = fake.indexedDB
global.IDBKeyRange = fake.IDBKeyRange
if (!global.crypto) global.crypto = require('node:crypto').webcrypto
if (!global.CustomEvent) global.CustomEvent = class extends Event { constructor(name, init) { super(name); this.detail = init?.detail } }
const ROOT = path.resolve(__dirname, '../..')
const cache = new Map()
let state = { effectiveState: 'enabled', revision: 0 }
let permission = 'granted', failCreate = false, flipDuringCreate = false
let notices = {}, sent = [], alarms = {}, onClick
let createBarrier = null
function resolveTS(file) {
  if (fs.existsSync(file + '.ts')) return file + '.ts'
  if (fs.existsSync(path.join(file, 'index.ts'))) return path.join(file, 'index.ts')
  return file
}
const stubs = new Map([
  [path.join(ROOT, 'src/background/pluginGate.ts'), {
    getPluginState: () => state,
    runPluginTask: async (fn) => { if (state.effectiveState !== 'enabled') throw Error('disabled'); return fn() },
    reconcilePluginRuntime: async () => state,
  }],
  [path.join(ROOT, 'src/adapters/index.ts'), { registry: { has: (name) => name === 'new-api' } }],
])
function load(file) {
  file = resolveTS(path.resolve(ROOT, file))
  if (stubs.has(file)) return stubs.get(file)
  if (cache.has(file)) return cache.get(file).exports
  const mod = { exports: {} }; cache.set(file, mod)
  const text = fs.readFileSync(file, 'utf8')
  const js = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  new Function('require', 'module', 'exports', js)((name) => name.startsWith('.') ? load(path.resolve(path.dirname(file), name)) : require(name), mod, mod.exports)
  return mod.exports
}
function browser() {
  global.chrome = {
    runtime: { lastError: undefined, getURL: (v) => 'chrome-extension://test/' + v, getManifest: () => ({ version: '0.3.17' }),
      sendMessage: async () => {}, getPlatformInfo: async () => ({}) },
    permissions: { contains: async () => true },
    notifications: {
      getPermissionLevel: (cb) => cb(permission), getAll: (cb) => cb({ ...notices }),
      create: async (id, opts) => {
        if (createBarrier) await createBarrier
        if (failCreate) throw Error('simulated OS failure')
        sent.push({ id, opts }); notices[id] = true
        if (flipDuringCreate) state.effectiveState = 'disabling'
        return id
      },
      clear: async (id) => { delete notices[id]; return true },
      onClicked: { addListener: (fn) => { onClick = fn } },
    },
    alarms: { create: async (name, value) => { alarms[name] = value }, clear: async (name) => { delete alarms[name]; return true }, onAlarm: { addListener: () => {} } },
    tabs: { create: async () => { throw Error('Unexpected tab open') } },
    storage: { local: { get: async () => ({}), set: async () => {} } },
  }
}
browser()
const { db } = load('src/storage/db.ts')
const rules = load('src/shared/alertRules.ts')
const store = load('src/storage/alerts.ts')
const engine = load('src/background/alerts.ts')
const backup = load('src/storage/backup.ts')
const { siteRepo } = load('src/storage/config.ts')
const notify = load('src/shared/notify.ts')
const { acquireSiteLock } = load('src/background/limits.ts')
const { handlers } = load('src/background/handlers.ts')
function rule(id = 'r1', threshold = 5, more = {}) {
  return { id, label: id, threshold, currency: 'USD', enabled: true, requireInteraction: true, ...more }
}
function site(alerts = [rule()]) {
  return { id: 'site1', name: 'Test Relay', origin: 'https://example.com', baseUrl: 'https://example.com', adapter: 'new-api', enabled: true,
    currency: 'USD', color: '#123456', order: 0, createdAt: 1, lastStatus: 'unknown', lastCollectAt: null,
    alerts: rules.normalizeAlertRules(alerts, 'USD') }
}
let current
let serial = 0
async function observe(balance, opts = {}) {
  const snapshot = { siteId: current.id, recordId: opts.recordId ?? 'obs-' + (++serial), balance, currency: opts.currency ?? 'USD',
    takenAt: opts.takenAt ?? 100, todayTokens: null, todayRequests: null, todayCost: null, modelUsages: [], status: 'ok', channel: 'content_script' }
  return store.commitAlertObservation(opts.site ?? current, snapshot, opts.context ?? 'stable-unit', opts.revision ?? 0)
}
async function events() { return db.alertDeliveries.toArray() }
beforeEach(async () => {
  browser(); state = { effectiveState: 'enabled', revision: 0 }; permission = 'granted'; failCreate = false; flipDuringCreate = false
  notices = {}; sent = []; alarms = {}; createBarrier = null; serial = 0
  await db.open()
  for (const table of db.tables) await table.clear()
  current = site(); await db.sites.put(current)
})
after(async () => { await db.delete() })

test('strict rule validation rejects coercions, duplicate ids, excessive rules', () => {
  for (const x of [null, '', '5', true, NaN, Infinity, -1]) assert.throws(() => rules.normalizeAlertRules([rule('r', x)], 'USD'))
  assert.throws(() => rules.normalizeAlertRules(null, 'USD'))
  assert.throws(() => rules.normalizeAlertRules([rule('same'), rule('same')], 'USD'))
  assert.throws(() => rules.normalizeAlertRules(Array.from({ length: 11 }, (_, i) => rule('r' + i)), 'USD'))
  assert.throws(() => rules.normalizeAlertRules([rule('r', 1, { currency: 'CNY' })], 'USD'))
  assert.equal(rules.parseAlertThreshold(' 0.00 '), 0)
  assert.throws(() => rules.parseAlertThreshold(''))
  assert.throws(() => rules.parseAlertThreshold('1e3'))
})
test('semantic changes advance revision, label changes do not', () => {
  const old = current.alerts
  const renamed = rules.normalizeAlertRules([{ ...old[0], label: 'renamed' }], 'USD', old)
  assert.equal(renamed[0].revision, old[0].revision)
  assert.equal(rules.normalizeAlertRules([{ ...old[0], threshold: 3 }], 'USD', old)[0].revision, old[0].revision + 1)
})
test('first observation below threshold establishes baseline only', async () => {
  await observe(3); await observe(2)
  assert.equal((await events()).length, 0)
  assert.equal(await db.alertBaselines.count(), 1)
})
test('10→5→3 triggers exactly once, including equality', async () => {
  await observe(10); await observe(5); await observe(3)
  assert.equal((await events()).length, 1)
})
test('10→3→8→4 triggers twice, even when timestamps are identical', async () => {
  for (const n of [10, 3, 8, 4]) await observe(n)
  const rows = await events()
  assert.equal(rows.length, 2); assert.notEqual(rows[0].eventId, rows[1].eventId)
  assert.equal((await db.alertObservations.get(current.id)).sequence, 4)
})
test('multiple thresholds produce one event with all matching rules', async () => {
  current = site([rule('warning', 50), rule('critical', 10)])
  await db.sites.put(current); await observe(60); await observe(8)
  const rows = await events(); assert.equal(rows.length, 1); assert.equal(rows[0].hits.length, 2)
})
test('null and invalid balances do not erase valid baseline', async () => {
  await observe(10)
  for (const n of [null, NaN, Infinity, '3']) await observe(n)
  await observe(3); assert.equal((await events()).length, 1)
})
test('currency mismatch and unit changes reset rather than cross', async () => {
  await observe(10); await observe(3, { currency: 'CNY' }); await observe(3)
  assert.equal((await events()).length, 0)
  await observe(10); await observe(3, { context: 'new-unit' })
  assert.equal((await events()).length, 0)
})
test('replaying same observation is idempotent', async () => {
  await observe(10); await observe(3, { recordId: 'fixed' }); await observe(3, { recordId: 'fixed' })
  assert.equal((await events()).length, 1); assert.equal(await db.snapshots.count(), 2)
})
test('concurrent observations serialize transaction commits', async () => {
  await observe(10)
  await Promise.all([observe(3), observe(2)])
  assert.equal((await events()).length, 1)
})
test('station collection lock serializes work and recovers after failure', async () => {
  const order = []
  await Promise.allSettled([
    acquireSiteLock('s', async () => { order.push(1); await new Promise((r) => setTimeout(r, 5)); order.push(2); throw Error('failed') }),
    acquireSiteLock('s', async () => { order.push(3) }),
  ])
  assert.deepEqual(order, [1, 2, 3])
})
test('switch off and stale revision prohibit snapshot and alert commits', async () => {
  await observe(10)
  await db.settings.put({ key: 'aihub.pluginEnabled', value: false })
  await observe(3); assert.equal(await db.snapshots.count(), 1)
  await db.settings.bulkPut([{ key: 'aihub.pluginEnabled', value: true }, { key: 'aihub.pluginRevision', value: 2 }])
  await observe(3, { revision: 0 }); assert.equal(await db.snapshots.count(), 1)
})
test('updating a rule resets baseline and cancels pending event', async () => {
  await observe(10); await observe(3)
  const alerts = rules.normalizeAlertRules([rule('r1', 4)], 'USD', current.alerts)
  await siteRepo.update(current.id, { alerts })
  current = await db.sites.get(current.id)
  await observe(2)
  assert.equal((await events()).filter((e) => e.status === 'pending').length, 0)
})
test('settings edited during collection cannot reinterpret older observation', async () => {
  await observe(10)
  const old = current
  current = { ...current, alerts: rules.normalizeAlertRules([rule('r1', 8)], 'USD', current.alerts) }
  await siteRepo.update(current.id, { alerts: current.alerts })
  await observe(3, { site: old })
  assert.equal((await events()).length, 0); assert.equal(await db.alertBaselines.count(), 0)
})
test('station delete removes baseline, events and sequence metadata', async () => {
  await observe(10); await observe(3); await siteRepo.remove(current.id)
  assert.equal(await db.alertBaselines.count(), 0); assert.equal(await db.alertDeliveries.count(), 0); assert.equal(await db.alertObservations.count(), 0)
})
test('backup exports only rule config, never runtime tables; repeated imports do not duplicate', async () => {
  await observe(10); await observe(3)
  const exported = await backup.exportAll()
  assert.equal(exported.sites[0].alerts[0].threshold, 5)
  assert.ok(!('alertDeliveries' in exported.tables)); assert.ok(!('alertBaselines' in exported.tables))
  await backup.importAll(exported); await backup.importAll(exported)
  assert.equal(await db.sites.count(), 1)
  assert.equal((await db.sites.get(current.id)).alerts.length, 1)
  assert.equal((await events()).length, 1)
})
test('old backup missing alerts preserves rules; explicit [] clears rules', async () => {
  const exported = await backup.exportAll(); delete exported.sites[0].alerts
  await backup.importAll(exported); assert.equal((await db.sites.get(current.id)).alerts.length, 1)
  exported.sites[0].alerts = []
  await backup.importAll(exported); assert.equal((await db.sites.get(current.id)).alerts.length, 0)
})
test('invalid imported rules skip the station instead of partially replacing it', async () => {
  const exported = await backup.exportAll(); exported.sites[0].alerts[0].threshold = ''
  const result = await backup.importAll(exported)
  assert.equal(result.updated, 0); assert.equal(result.skipped.length, 1)
  assert.equal((await db.sites.get(current.id)).alerts[0].threshold, 5)
})
test('cross-install import keeps rules and maps site ids, never creates alert events', async () => {
  await observe(10); await observe(3)
  const exported = await backup.exportAll()
  await siteRepo.remove(current.id)
  await backup.importAll(exported)
  const restored = (await db.sites.toArray())[0]
  assert.notEqual(restored.id, current.id); assert.equal(restored.alerts[0].threshold, 5)
  assert.equal((await events()).length, 0)
})
test('system notification independent of ordinary notify off setting', async () => {
  await db.settings.put({ key: 'aihub.notifyMode', value: 'off' })
  await observe(10); await observe(3); await engine.flushBalanceAlerts()
  assert.equal(sent.length, 1); assert.match(sent[0].opts.title, /余额警报/)
  assert.equal((await events())[0].status, 'delivered')
  await engine.flushBalanceAlerts(); assert.equal(sent.length, 1)
})
test('no notification permission records failed without retry storm', async () => {
  permission = 'denied'; await observe(10); await observe(3); await engine.flushBalanceAlerts()
  assert.equal(sent.length, 0); assert.equal((await events())[0].lastError, 'no_permission')
  assert.equal(alarms['aihub-alert-retry'], undefined)
})
test('temporary notification failure retries at most three attempts', async () => {
  failCreate = true; await observe(10); await observe(3)
  for (let i = 0; i < 4; i++) {
    await db.alertDeliveries.toCollection().modify({ nextAttemptAt: Date.now() - 1 })
    await engine.flushBalanceAlerts()
  }
  const e = (await events())[0]; assert.equal(e.attempts, 3); assert.equal(e.status, 'failed')
})
test('same notification id recovers acceptance-before-marking crash window', async () => {
  await observe(10); await observe(3)
  const e = (await events())[0]; notices[store.ALERT_NOTICE_PREFIX + e.eventId] = true
  await engine.flushBalanceAlerts(); assert.equal(sent.length, 0); assert.equal((await events())[0].status, 'delivered')
})
test('stop cancels pending, resets baseline and clears only our notifications', async () => {
  await observe(10); await observe(3)
  notices['other-feature'] = true; notices[store.ALERT_NOTICE_PREFIX + 'old'] = true
  state.effectiveState = 'disabling'; await engine.stopBalanceAlerts()
  assert.equal((await events())[0].status, 'cancelled'); assert.equal(await db.alertBaselines.count(), 0)
  assert.deepEqual(Object.keys(notices), ['other-feature'])
  state.effectiveState = 'enabled'; await observe(2); assert.equal((await events()).filter((e) => e.status === 'pending').length, 0)
})
test('stop during browser create clears just-created notice', async () => {
  flipDuringCreate = true; await observe(10); await observe(3); await engine.flushBalanceAlerts()
  assert.equal(Object.keys(notices).length, 0); assert.equal((await events())[0].status, 'cancelled')
})
test('delivery rechecks rule enabled and does not send stale event', async () => {
  await observe(10); await observe(3)
  await db.sites.update(current.id, { enabled: false })
  await engine.flushBalanceAlerts(); assert.equal(sent.length, 0); assert.equal((await events())[0].status, 'cancelled')
})
test('expired events cancel and historical snapshot pruning preserves baseline', async () => {
  await observe(10); await db.snapshots.clear(); await observe(3)
  assert.equal((await events()).length, 1)
  await db.alertDeliveries.toCollection().modify({ createdAt: Date.now() - store.ALERT_TTL_MS - 1 })
  await engine.flushBalanceAlerts(); assert.equal(sent.length, 0); assert.equal((await events())[0].status, 'cancelled')
})
test('normal worker restart preserves pending; recovery schedules one retry alarm', async () => {
  await observe(10); await observe(3)
  await engine.restoreBalanceAlertSchedule(); assert.ok(alarms['aihub-alert-retry'])
  await engine.flushBalanceAlerts(); assert.equal(sent.length, 1)
})
test('DB v5→v6 preserves existing site and snapshots', async () => {
  await db.delete()
  const Dexie = require('dexie').default || require('dexie')
  const old = new Dexie('aihub')
  old.version(5).stores({ sites: 'id, enabled, order', snapshots: '++id, siteId, takenAt, &recordId',
    dailyStats: 'id, &[siteId+date], siteId, date', credentials: 'siteId', settings: 'key', captures: 'id, siteId, capturedAt',
    diagnostics: '++id, siteId, at, &recordId', usageRecords: 'id, siteId, date, takenAt', usageCache: 'cacheKey, siteId, kind, [siteId+kind], accessedAt, fromDate, toDate' })
  await old.open(); await old.table('sites').put(current); await old.table('snapshots').add({ siteId: current.id, recordId: 'legacy', takenAt: 1, balance: 99 }); old.close()
  await db.open()
  assert.equal(db.verno, 6); assert.equal((await db.sites.get(current.id)).name, current.name)
  assert.equal((await db.snapshots.where('recordId').equals('legacy').first()).balance, 99)
  assert.equal(await db.alertDeliveries.count(), 0)
})

test('ADD_SITE saves rules and UPDATE_SITE preserves strict validation at message boundary', async () => {
  const result = await handlers.ADD_SITE({ type: 'new-api', name: 'Other relay', baseUrl: 'https://other.example', currency: 'USD', alerts: [rule('new-rule', 7)] })
  const saved = await db.sites.get(result.siteId)
  assert.equal(saved.alerts[0].threshold, 7)
  assert.equal(saved.alerts[0].revision, 1)
  await assert.rejects(handlers.UPDATE_SITE({ id: result.siteId, patch: { alerts: [rule('new-rule', '')] } }))
  assert.equal((await db.sites.get(result.siteId)).alerts[0].threshold, 7)
  await handlers.UPDATE_SITE({ id: result.siteId, patch: { alerts: [rule('new-rule', 4)] } })
  assert.equal((await db.sites.get(result.siteId)).alerts[0].revision, 2)
  const status = await handlers.GET_BALANCE_ALERT_STATUS({ id: result.siteId })
  assert.equal(status.notificationPermission, 'granted')
})

test('editing one rule preserves other pending hits in a grouped event', async () => {
  current = site([rule('r1', 50), rule('r2', 10)])
  await db.sites.put(current); await observe(60); await observe(8)
  const changed = rules.normalizeAlertRules([rule('r1', 50, { enabled: false }), rule('r2', 10)], 'USD', current.alerts)
  await siteRepo.update(current.id, { alerts: changed })
  await engine.flushBalanceAlerts()
  assert.equal(sent.length, 1); assert.match(sent[0].opts.message, /r2/); assert.doesNotMatch(sent[0].opts.message, /r1/)
})
test('station disable then enable rejects a pre-pause observation', async () => {
  await observe(10)
  await siteRepo.update(current.id, { enabled: false })
  await siteRepo.update(current.id, { enabled: true })
  await observe(3)
  assert.equal(await db.snapshots.count(), 1)
  assert.equal(await db.alertBaselines.count(), 0)
  current = await db.sites.get(current.id)
  await observe(3)
  assert.equal(await db.alertBaselines.count(), 1)
  assert.equal((await events()).length, 0)
})
