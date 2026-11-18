/**
 * 全量备份分块传输常量与工具（方案 060，GPT 评审定稿）。
 *
 * 背景：chrome.runtime 单条消息（sendMessage / sendResponse）有 64MiB 序列化上限，
 * 全量备份在大容量电脑上会超限。大数据改为「序列化→切块→多消息往返→拼回」。
 *
 * 本模块只定义纯常量与纯函数，供 SW 与 UI 双方共用，不依赖任何运行时 API。
 */

/** 单块目标字符数。UTF-8 最坏 6 字节/字符 ⇒ 约 6MB，远低于 64MiB。 */
export const BACKUP_CHUNK_CHARS = 1_000_000

/** 单发（不分块）阈值：序列化后 <= 8MiB 走原单消息路径，> 8MiB 强制分块（确定性分流，P0）。 */
export const BACKUP_INLINE_LIMIT_BYTES = 8 * 1024 * 1024

/** 备份体积硬上限：序列化后超过则直接拒绝，防止异常/恶意文件打爆 SW 内存（P1）。 */
export const BACKUP_MAX_BYTES = 128 * 1024 * 1024

/**
 * 由硬上限派生的最大块数（P1）。
 * 按「每字符至少 1 字节」（UTF-8 下 ASCII=1 字节）取最宽松下界：MAX_BYTES 字节最多对应 MAX_BYTES 个字符，
 * 故块数上限 = ceil(MAX_BYTES / CHUNK_CHARS) + 1（+1 为代理对切点余量）。
 * 注意：不可用「最坏 6 字节/字符」推导块数——那会把 ASCII 128MiB 合法备份限制到 ~23MiB（GPT 终审阻断项）。
 * 真正的体积硬约束由 totalBytes<=MAX_BYTES 把关，此处只防「块数异常膨胀」打爆内存。
 */
export const BACKUP_MAX_CHUNKS = Math.ceil(BACKUP_MAX_BYTES / BACKUP_CHUNK_CHARS) + 1

/** 估算字符串序列化为 UTF-8 后的字节数（近似：先按字符粗算，UI/SW 均无副作用）。 */
export function estimateUtf8Bytes(text: string): number {
  // 用 TextEncoder 精确计算（浏览器/SW 均可用）；避免重复编码大字符串由调用方控制。
  return new TextEncoder().encode(text).length
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/**
 * 按字符数切分字符串，且切点避开 UTF-16 代理对（P1）。
 * 若切点恰好落在「高位代理 + 低位代理」之间，则把切点前移一个码元，
 * 使代理对完整留在同一块，避免孤立代理元穿越 Chrome 消息序列化层。
 */
export function sliceBackupText(text: string, chunkChars: number = BACKUP_CHUNK_CHARS): string[] {
  if (chunkChars <= 0) throw new Error('INVALID_CHUNK_SIZE')
  const parts: string[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(start + chunkChars, text.length)
    if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) {
      end -= 1
    }
    // 防御：极端情况下 end 未推进（chunkChars=1 且连续代理），至少推进一个码元
    if (end <= start) end = Math.min(start + 1, text.length)
    parts.push(text.slice(start, end))
    start = end
  }
  return parts
}

/** 分块路径判定：序列化字节数是否超过单发阈值（P0：确定性，不用异常探测）。 */
export function shouldChunk(bytes: number): boolean {
  return bytes > BACKUP_INLINE_LIMIT_BYTES
}
