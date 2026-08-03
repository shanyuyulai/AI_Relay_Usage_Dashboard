import type { SiteAdapter } from './contracts'

export class UnknownAdapterError extends Error {
  constructor(id: string) {
    super(`未知适配器: ${id}`)
    this.name = 'UnknownAdapterError'
  }
}

/** 站点类型注册表：新增站点类型只需 register 一个 adapter，不动框架与其他 adapter。 */
export class AdapterRegistry {
  private readonly adapters = new Map<string, SiteAdapter>()

  register(a: SiteAdapter): void {
    if (this.adapters.has(a.id)) {
      throw new Error(`适配器已存在，无法重复注册: ${a.id}`)
    }
    this.adapters.set(a.id, a)
  }

  /** 取适配器；找不到抛 UnknownAdapterError（由调用方转译为站点配置错误）。 */
  get(id: string): SiteAdapter {
    const a = this.adapters.get(id)
    if (!a) throw new UnknownAdapterError(id)
    return a
  }

  list(): SiteAdapter[] {
    return [...this.adapters.values()]
  }

  has(id: string): boolean {
    return this.adapters.has(id)
  }
}
