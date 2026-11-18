/**
 * 全量备份分块传输会话表（方案 060）。
 *
 * 设计（GPT 评审定稿）：
 * - 会话仅存 SW 内存 Map，绝不落 IndexedDB（避免全量业务数据以临时形态落盘）。
 * - acquireKeepAlive() 引用计数覆盖整个传输周期，降低 SW 休眠概率；但**不保证**不休眠。
 *   MV3 强杀 SW 后内存会话必然丢失 → 返回 SESSION_INVALID，用户显式重试，不承诺续传。
 * - 5 分钟 TTL + 滑动续期，页面崩溃时释放会话与保活引用；超限拒绝（P1 内存硬上限）。
 * - 日志只记 sessionId / 块号 / 长度，绝不写块内容或完整 DTO（P0-1）。
 */
import { acquireKeepAlive } from '../shared/keepAlive'
import { BACKUP_MAX_BYTES, BACKUP_MAX_CHUNKS } from '../shared/backupTransfer'

export type BackupSessionKind = 'export' | 'import'

interface SessionEntry {
  sessionId: string
  kind: BackupSessionKind
  parts: string[]
  expect: number
  createdAt: number
  totalBytes: number
  releaseKeepAlive: () => void
  timer: ReturnType<typeof setTimeout>
}

/** 模块级会话表：SW 生命周期内有效，休眠即失效（设计如此）。 */
const sessions = new Map<string, SessionEntry>()
const TTL_MS = 5 * 60 * 1000

/** 带业务 kind 的错误：router 会把 kind 透传到 Res.error.kind，UI 可按 kind 给固定文案。 */
export class BackupSessionError extends Error {
  readonly kind: string
  constructor(kind: string, message: string) {
    super(message)
    this.name = 'BackupSessionError'
    this.kind = kind
  }
}

function touch(entry: SessionEntry): void {
  clearTimeout(entry.timer)
  entry.timer = setTimeout(() => {
    abort(entry.sessionId)
  }, TTL_MS)
}

/** 校验体积/块数上限（P1：防异常/恶意文件打爆 SW 内存）。 */
function assertCapacity(totalBytes: number, totalChunks: number): void {
  if (!Number.isFinite(totalBytes) || totalBytes < 0 || totalBytes > BACKUP_MAX_BYTES) {
    throw new BackupSessionError('BACKUP_TOO_LARGE', `备份体积超出 ${Math.round(BACKUP_MAX_BYTES / 1024 / 1024)}MiB 上限`)
  }
  if (!Number.isFinite(totalChunks) || totalChunks < 1 || totalChunks > BACKUP_MAX_CHUNKS) {
    throw new BackupSessionError('BACKUP_TOO_LARGE', '备份块数超出上限')
  }
}

/** 创建会话；expect = 预计块数（导出为实际切片数，导入为页面声明的 totalChunks）。 */
export function createSession(kind: BackupSessionKind, totalBytes: number, totalChunks: number): string {
  assertCapacity(totalBytes, totalChunks)
  const sessionId = crypto.randomUUID()
  const releaseKeepAlive = acquireKeepAlive()
  const entry: SessionEntry = {
    sessionId,
    kind,
    parts: new Array(totalChunks),
    expect: totalChunks,
    createdAt: Date.now(),
    totalBytes,
    releaseKeepAlive,
    timer: undefined as unknown as ReturnType<typeof setTimeout>,
  }
  sessions.set(sessionId, entry)
  touch(entry)
  console.info('[AI Relay] 备份会话创建', { sessionId, kind, totalChunks, totalBytes })
  return sessionId
}

function requireSession(sessionId: string, kind?: BackupSessionKind): SessionEntry {
  const entry = sessions.get(sessionId)
  if (!entry || (kind && entry.kind !== kind)) {
    throw new BackupSessionError('SESSION_INVALID', '备份传输上下文已失效，请重新发起')
  }
  return entry
}

/** 导出端：写入整块切片（一次性）。 */
export function setExportParts(sessionId: string, parts: string[]): void {
  const entry = requireSession(sessionId, 'export')
  if (parts.length !== entry.expect) {
    throw new BackupSessionError('SESSION_INVALID', '导出块数与会话声明不一致')
  }
  entry.parts = parts
  touch(entry)
}

/** 导出端：取第 index 块；done 表示最后一块。 */
export function getChunk(sessionId: string, index: number): { data: string; done: boolean } {
  const entry = requireSession(sessionId, 'export')
  if (!Number.isInteger(index) || index < 0 || index >= entry.expect) {
    throw new BackupSessionError('BAD_REQUEST', '块索引越界')
  }
  const data = entry.parts[index]
  if (typeof data !== 'string') {
    throw new BackupSessionError('SESSION_INVALID', '块数据缺失')
  }
  touch(entry)
  return { data, done: index === entry.expect - 1 }
}

/** 导入端：写第 index 块；重复 index 幂等覆盖。返回已收块数。 */
export function putChunk(sessionId: string, index: number, data: string): number {
  const entry = requireSession(sessionId, 'import')
  if (!Number.isInteger(index) || index < 0 || index >= entry.expect) {
    throw new BackupSessionError('BAD_REQUEST', '块索引越界')
  }
  if (typeof data !== 'string') {
    throw new BackupSessionError('BAD_REQUEST', '块数据无效')
  }
  const wasEmpty = entry.parts[index] === undefined
  entry.parts[index] = data
  touch(entry)
  const received = entry.parts.reduce((n, p) => n + (typeof p === 'string' ? 1 : 0), 0)
  if (wasEmpty) console.info('[AI Relay] 备份块接收', { sessionId, index, len: data.length, received, expect: entry.expect })
  return received
}

/** 导入端：拼接全部块为 JSON 字符串；块不齐时拒绝（不进 importAll）。 */
export function joinImport(sessionId: string): string {
  const entry = requireSession(sessionId, 'import')
  const received = entry.parts.reduce((n, p) => n + (typeof p === 'string' ? 1 : 0), 0)
  if (received !== entry.expect) {
    throw new BackupSessionError('SESSION_INVALID', '备份块尚未收齐，请重新上传')
  }
  touch(entry)
  return entry.parts.join('')
}

/** 释放会话（幂等）：清 TTL、释放 keepAlive、从 Map 删除。 */
export function abort(sessionId: string): void {
  const entry = sessions.get(sessionId)
  if (!entry) return
  clearTimeout(entry.timer)
  entry.releaseKeepAlive()
  sessions.delete(sessionId)
  console.info('[AI Relay] 备份会话释放', { sessionId })
}

/** 仅供测试：当前会话数（不写日志内容）。 */
export function sessionCount(): number {
  return sessions.size
}
