const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

// Chrome API stub：backupSession 经 keepAlive 调 getPlatformInfo
global.chrome = {
  runtime: { getPlatformInfo: async () => ({}) },
}
if (!global.crypto) global.crypto = require('node:crypto').webcrypto

const ROOT = path.resolve(__dirname, '../..')
const cache = new Map()
function resolveTS(file) {
  if (fs.existsSync(file + '.ts')) return file + '.ts'
  if (fs.existsSync(path.join(file, 'index.ts'))) return path.join(file, 'index.ts')
  return file
}
function load(file) {
  file = resolveTS(path.resolve(ROOT, file))
  if (cache.has(file)) return cache.get(file).exports
  const mod = { exports: {} }; cache.set(file, mod)
  const text = fs.readFileSync(file, 'utf8')
  const js = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  new Function('require', 'module', 'exports', js)(
    (name) => name.startsWith('.') ? load(path.resolve(path.dirname(file), name)) : require(name),
    mod, mod.exports,
  )
  return mod.exports
}

const transfer = load('src/shared/backupTransfer.ts')
const session = load('src/background/backupSession.ts')

// ── backupTransfer 纯函数 ────────────────────────────────
test('切片→拼接 roundtrip：普通 ASCII 大数据完整还原', () => {
  const chunk = 1_000_000
  const text = 'A'.repeat(chunk * 2 + 12345)
  const parts = transfer.sliceBackupText(text, chunk)
  assert.equal(parts.length, 3)
  assert.equal(parts.join(''), text)
})

test('切片避开孤立代理对：emoji 不被切开且完整还原', () => {
  const emoji = '😀' // 高位 0xD83D + 低位 0xDE00
  // 让切点正好落在代理对中间：前 chunk-1 个普通字符 + emoji
  const chunk = 4
  const text = 'abcd' + emoji + 'XYZ' // 索引 4 是高代理，5 是低代理
  const parts = transfer.sliceBackupText(text, chunk)
  assert.equal(parts.join(''), text)
  // 没有任何一块以孤立高代理结尾
  for (const p of parts) {
    const last = p.charCodeAt(p.length - 1)
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), '块尾不应是高位代理')
  }
  // emoji 完整出现在某一块
  assert.ok(parts.some((p) => p.includes(emoji)), 'emoji 应完整保留在同一块')
})

test('shouldChunk 确定性阈值：<=8MiB 单发，>8MiB 分块', () => {
  assert.equal(transfer.shouldChunk(transfer.BACKUP_INLINE_LIMIT_BYTES), false)
  assert.equal(transfer.shouldChunk(transfer.BACKUP_INLINE_LIMIT_BYTES + 1), true)
})

test('BACKUP_MAX_CHUNKS 由 128MiB 上限派生且为正整数', () => {
  assert.ok(transfer.BACKUP_MAX_CHUNKS > 0 && Number.isInteger(transfer.BACKUP_MAX_CHUNKS))
  assert.equal(transfer.BACKUP_MAX_BYTES, 128 * 1024 * 1024)
})

test('ASCII 128MiB 合法备份不被块数上限误拒（GPT 终审回归）', () => {
  // 128MiB = 134,217,728 字节；ASCII 每字符 1 字节 ⇒ 满额文本 134,217,728 字符；
  // 按 1,000,000 字符/块切 ⇒ ceil(134217728/1000000)=135 块；上限应 >=135（当前实现 136）。
  // 早前错误实现用「最坏 6 字节/字符」推导上限(≈23 块)，会在 ~23MiB 处误拒，此处锁定正确行为。
  const MiB = 1024 * 1024
  assert.equal(transfer.BACKUP_MAX_BYTES, 128 * MiB)
  const fullAsciiChars = 128 * MiB // ASCII: 字符数 = 字节数
  const fullChunks = Math.ceil(fullAsciiChars / transfer.BACKUP_CHUNK_CHARS)
  assert.equal(fullChunks, 135)
  assert.equal(transfer.BACKUP_MAX_CHUNKS, 136)
  assert.ok(fullChunks <= transfer.BACKUP_MAX_CHUNKS, `满额块数 ${fullChunks} 应 <= 上限 ${transfer.BACKUP_MAX_CHUNKS}`)
  assert.doesNotThrow(() => {
    const id = session.createSession('export', transfer.BACKUP_MAX_BYTES, fullChunks)
    session.abort(id)
  })
})

// ── backupSession 会话语义 ────────────────────────────────
test('导出会话：setParts → getChunk 逐块取回，末块 done=true', () => {
  const id = session.createSession('export', 100, 3)
  session.setExportParts(id, ['aa', 'bb', 'cc'])
  const c0 = session.getChunk(id, 0)
  assert.deepEqual({ data: c0.data, done: c0.done }, { data: 'aa', done: false })
  const c2 = session.getChunk(id, 2)
  assert.deepEqual({ data: c2.data, done: c2.done }, { data: 'cc', done: true })
  session.abort(id)
  assert.equal(session.sessionCount(), 0)
})

test('导入会话：putChunk 幂等覆盖 + joinImport 拼接', () => {
  const id = session.createSession('import', 30, 3)
  assert.equal(session.putChunk(id, 0, 'aa'), 1)
  assert.equal(session.putChunk(id, 1, 'bb'), 2)
  assert.equal(session.putChunk(id, 2, 'cc'), 3)
  assert.equal(session.putChunk(id, 1, 'BB'), 3) // 重复 index 覆盖，计数不变
  assert.equal(session.joinImport(id), 'aaBBcc')
  session.abort(id)
})

test('块未收齐时 joinImport 拒绝（SESSION_INVALID）', () => {
  const id = session.createSession('import', 20, 2)
  session.putChunk(id, 0, 'xx')
  assert.throws(() => session.joinImport(id), (e) => e.kind === 'SESSION_INVALID')
  session.abort(id)
})

test('越界块索引抛 BAD_REQUEST', () => {
  const id = session.createSession('export', 10, 2)
  session.setExportParts(id, ['a', 'b'])
  assert.throws(() => session.getChunk(id, -1), (e) => e.kind === 'BAD_REQUEST')
  assert.throws(() => session.getChunk(id, 2), (e) => e.kind === 'BAD_REQUEST')
  session.abort(id)
})

test('会话不存在抛 SESSION_INVALID（模拟 SW 休眠丢失）', () => {
  assert.throws(() => session.getChunk('missing-id', 0), (e) => e.kind === 'SESSION_INVALID')
})

test('createSession 超体积上限抛 BACKUP_TOO_LARGE', () => {
  assert.throws(
    () => session.createSession('export', transfer.BACKUP_MAX_BYTES + 1, 1),
    (e) => e.kind === 'BACKUP_TOO_LARGE',
  )
})

test('createSession 超块数上限抛 BACKUP_TOO_LARGE', () => {
  assert.throws(
    () => session.createSession('import', 100, transfer.BACKUP_MAX_CHUNKS + 1),
    (e) => e.kind === 'BACKUP_TOO_LARGE',
  )
})
