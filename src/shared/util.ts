/** 归一化用户输入的 baseUrl 为 origin（P0-5：按站点动态申请具体 origin）。 */
export function normalizeOrigin(input: string): string {
  const u = new URL(input.trim())
  return u.origin
}

/** 本地时区的日期键 YYYY-MM-DD（P0-4：明确日界语义）。 */
export function dateKey(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function todayKey(): string {
  return dateKey(Date.now())
}

/**
 * 指定时区的日期键 YYYY-MM-DD（业务日一致性，P0）。
 * 用于 hubway 等固定 Asia/Shanghai 业务日的站点，避免与浏览器 local 日界错位。
 * 通过把目标时区偏移量换算到 UTC 后取日期分量实现（不依赖 Intl 时区支持）。
 */
export function dateKeyInTz(ts: number, timeZone: string): string {
  const tzMatch = /([+-])(\d{2}):?(\d{2})$/.exec(timeZone)
  let offsetMin = 0
  if (tzMatch) {
    const sign = tzMatch[1] === '-' ? -1 : 1
    offsetMin = sign * (Number(tzMatch[2]) * 60 + Number(tzMatch[3]))
  } else if (timeZone === 'Asia/Shanghai' || timeZone === 'CST' || timeZone === 'UTC+8' || timeZone === '+08:00') {
    offsetMin = 8 * 60
  } else if (timeZone === 'UTC' || timeZone === 'GMT') {
    offsetMin = 0
  }
  // 把 ts 调整到目标时区的本地时刻
  const local = new Date(ts + offsetMin * 60_000)
  const y = local.getUTCFullYear()
  const m = String(local.getUTCMonth() + 1).padStart(2, '0')
  const day = String(local.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** hubway 业务时区常量（集中定义，避免散落硬编码）。 */
export const HUBWAY_TZ = 'Asia/Shanghai'
