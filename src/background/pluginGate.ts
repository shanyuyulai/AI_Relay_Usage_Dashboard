import { readPluginConfig, writePluginEnabled, validatePluginEnabled } from '../storage/enableConfig'
import { PLUGIN_ENABLED_CHANGED, type PluginState } from '../shared/pluginState'
import { acquireKeepAlive } from '../shared/keepAlive'

let state: PluginState = { desiredEnabled: null, effectiveState: 'initializing', revision: 0 }
let queue: Promise<unknown> = Promise.resolve()
let stopRequests = 0
let initialization: Promise<PluginState> | undefined
let reconcileResources: ((enabled: boolean) => Promise<void>) | undefined
const active = new Set<Promise<unknown>>()

export function configurePluginResources(fn: (enabled: boolean) => Promise<void>): void {
  reconcileResources = fn
}
export function getPluginState(): PluginState { return { ...state } }
function broadcast(): void {
  void chrome.runtime.sendMessage({ type: PLUGIN_ENABLED_CHANGED, state: getPluginState() }).catch(() => {})
}
function publish(patch: Partial<PluginState>): void {
  state = { ...state, ...patch }
  broadcast()
}
function serial<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(async () => {
    const release = acquireKeepAlive()
    try { return await work() } finally { release() }
  })
  queue = result.catch(() => {})
  return result
}
async function resources(enabled: boolean): Promise<void> {
  if (!reconcileResources) throw new Error('插件控制器尚未装配')
  await reconcileResources(enabled)
}
async function recoverError(error: unknown): Promise<PluginState> {
  // Fail closed, also attempt to remove persisted browser resources on startup failure.
  publish({ effectiveState: 'error', error: error instanceof Error ? error.message : '插件状态读取失败' })
  try { await resources(false) } catch { /* keep original error; next control request retries */ }
  return getPluginState()
}
export function initializePlugin(): Promise<PluginState> {
  if (!initialization) initialization = serial(async () => {
    try {
      const config = await readPluginConfig()
      publish({ desiredEnabled: config.enabled, revision: config.revision, error: undefined })
      await resources(config.enabled)
      publish({ effectiveState: config.enabled ? 'enabled' : 'disabled' })
      return getPluginState()
    } catch (e) { return recoverError(e) }
  })
  return initialization
}
export async function assertPluginEnabled(): Promise<void> {
  await initializePlugin()
  if (state.effectiveState !== 'enabled' || stopRequests > 0) {
    const disabled = state.desiredEnabled === false
    throw Object.assign(new Error(disabled ? '插件已停用或正在停用' : '插件运行状态不可用，请重试'), {
      kind: disabled ? 'PLUGIN_DISABLED' : 'PLUGIN_STATE_UNAVAILABLE',
    })
  }
}
/** All new message/alarm business jobs enter here. Control/export must never enter. */
export async function runPluginTask<T>(work: () => Promise<T>): Promise<T> {
  await assertPluginEnabled()
  // No await between the final state check and registering the task.
  if (state.effectiveState !== 'enabled' || stopRequests > 0) throw Object.assign(new Error('插件正在停用'), { kind: 'PLUGIN_DISABLED' })
  const task = Promise.resolve().then(work)
  active.add(task)
  const release = acquireKeepAlive()
  try { return await task } finally { active.delete(task); release() }
}
export async function setPluginEnabled(raw: unknown): Promise<PluginState> {
  const enabled = validatePluginEnabled(raw)
  await initializePlugin()
  if (!enabled) stopRequests++
  return serial(async () => {
    publish({ effectiveState: enabled ? 'initializing' : 'disabling', error: undefined })
    try {
      const config = await writePluginEnabled(enabled)
      publish({ desiredEnabled: enabled, revision: config.revision })
      if (!enabled) {
        await resources(false)
        // Phase 1 safety: do not report disabled while pre-existing jobs still run.
        // Phase 2 replaces draining with cooperative cancellation and stale-epoch rejection.
        await Promise.allSettled([...active])
        await resources(false)
      } else {
        await resources(true)
      }
      publish({ effectiveState: enabled ? 'enabled' : 'disabled' })
      return getPluginState()
    } catch (e) { return recoverError(e) }
  }).finally(() => { if (!enabled) stopRequests-- })
}
/** Setting changes and import completion must use the same serialized resource writer. */
export async function reconcilePluginRuntime(): Promise<PluginState> {
  await initializePlugin()
  // A running job may call this while stop is draining that job. Never enqueue behind stop.
  if (state.effectiveState !== 'enabled' || stopRequests > 0) return getPluginState()
  return serial(async () => {
    try {
      const config = await readPluginConfig()
      if (state.effectiveState !== 'enabled' || !config.enabled) return getPluginState()
      await resources(true)
      return getPluginState()
    } catch (e) { return recoverError(e) }
  })
}
