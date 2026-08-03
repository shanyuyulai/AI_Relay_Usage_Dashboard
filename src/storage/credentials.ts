import { db } from './db'
import type { CredentialRow } from '../shared/types'

// 凭证仓储：MVP 仅 Cookie 会话（P0-2）。
// 不存储 Token、不存储 Cookie 原文；Cookie 在采集时由 chrome.cookies 实时读取。
export const credentialRepo = {
  /** 记录授权态（不存任何私密材料），供 UI 显示与采集前判断 */
  async setAuthorized(siteId: string, authorized: boolean): Promise<void> {
    const row: CredentialRow = {
      siteId,
      method: 'cookie',
      authorized,
      updatedAt: Date.now(),
    }
    await db.credentials.put(row)
  },

  async get(siteId: string): Promise<CredentialRow | undefined> {
    return db.credentials.get(siteId)
  },

  async clear(siteId: string): Promise<void> {
    await db.credentials.delete(siteId)
  },
}
