import { AdapterRegistry } from '../core/adapter/registry'
import { newApiAdapter } from './newapi'

/** 全局唯一适配器注册表（单例）。新增站点类型时在此 register 即可。 */
export const registry = new AdapterRegistry()
registry.register(newApiAdapter)

export function getRegistry(): AdapterRegistry {
  return registry
}
