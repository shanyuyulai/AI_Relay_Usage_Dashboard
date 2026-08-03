/** 嵌套字段安全取值，如 getPath(obj, 'data.quota')。 */
export function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc == null || typeof acc !== 'object') return undefined
    return (acc as Record<string, unknown>)[key]
  }, obj)
}

/**
 * 数值强转：null/undefined/NaN → 0。
 * 仅用于「已知必为数值」的字段；未知字段不应走此函数（缺失即保留 null，红线：禁编造）。
 */
export function toNumber(v: unknown): number {
  if (v == null) return 0
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * 响应体脱敏哈希（FNV-1a 32-bit，稳定、不可逆）。
 * 用于跨次结构比对（P1-1 诊断 / P1-4 审计），绝不依赖响应体原文。
 */
export function hashResponse(r: unknown): string {
  const s = JSON.stringify(r ?? null)
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return 'fnv1a:' + (h >>> 0).toString(16)
}
