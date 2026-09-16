/** 038 v1.2: shared DTO only; importing this module never starts background work. */
export const PLUGIN_ENABLED_CHANGED = 'PLUGIN_ENABLED_CHANGED'
export type PluginEffectiveState = 'initializing' | 'enabled' | 'disabling' | 'disabled' | 'error'
export interface PluginState {
  desiredEnabled: boolean | null
  effectiveState: PluginEffectiveState
  revision: number
  error?: string
}
export interface SetPluginEnabledPayload { enabled: boolean }
