<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, type Component } from 'vue'
import { send } from '../core/messaging/client'
import type { ExportConfig } from '../core/messaging/protocol'
import { PLUGIN_ENABLED_CHANGED, type PluginState } from './pluginState'

defineProps<{ content: Component; allowExport?: boolean }>()
const state = ref<PluginState>({ desiredEnabled: null, effectiveState: 'initializing', revision: -1 })
const busy = ref(false)
const error = ref('')
const enabled = computed(() => state.value.effectiveState === 'enabled')
const transitioning = computed(() => ['initializing', 'disabling'].includes(state.value.effectiveState))
let alive = true
function accept(next: PluginState): void {
  if (!alive || !next || typeof next.revision !== 'number' || next.revision < state.value.revision) return
  state.value = next
}
async function refresh(): Promise<void> {
  error.value = ''
  try { accept(await send<PluginState>('GET_PLUGIN_ENABLED')) }
  catch (e) { error.value = e instanceof Error ? e.message : '无法读取插件状态' }
}
async function toggle(value: boolean): Promise<void> {
  busy.value = true
  error.value = ''
  try { accept(await send<PluginState>('SET_PLUGIN_ENABLED', { enabled: value }, 120_000)) }
  catch (e) {
    const message = e instanceof Error ? e.message : '切换失败'
    await refresh()
    error.value = message
  }
  finally { busy.value = false }
}
async function openSettings(): Promise<void> {
  try { await chrome.runtime.openOptionsPage() }
  catch (e) { error.value = e instanceof Error ? e.message : '无法打开设置' }
}
async function exportBackup(): Promise<void> {
  busy.value = true
  try {
    const data = await send<ExportConfig>('EXPORT_CONFIG', {}, 120_000)
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `aihub-backup-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch (e) { error.value = e instanceof Error ? e.message : '备份导出失败' }
  finally { busy.value = false }
}
function listener(message: { type?: string; state?: PluginState }): void {
  if (message?.type === PLUGIN_ENABLED_CHANGED && message.state) accept(message.state)
}
onMounted(() => { chrome.runtime.onMessage.addListener(listener); void refresh() })
onUnmounted(() => { alive = false; chrome.runtime.onMessage.removeListener(listener) })
</script>

<template>
  <div class="plugin-shell">
    <!-- Only settings owns the switch. Normal popup/sidepanel render no extra toolbar. -->
    <component :is="content" v-if="enabled">
      <template v-if="allowExport" #plugin-control>
        <button type="button" role="switch" aria-label="启用插件" title="启用插件"
          :aria-checked="enabled" :disabled="busy || transitioning" class="plugin-switch"
          :class="{ on: enabled }" @click="toggle(!enabled)">
          <span aria-hidden="true"></span>
        </button>
      </template>
    </component>
    <template v-else>
      <header v-if="allowExport" class="plugin-settings-heading">
        <span class="plugin-logo">AI</span>
        <span class="plugin-title">AI 中转站用量看板 · 设置</span>
        <button type="button" role="switch" aria-label="启用插件" title="启用插件"
          :aria-checked="enabled" :disabled="busy || transitioning" class="plugin-switch"
          :class="{ on: enabled }" @click="toggle(!enabled)">
          <span aria-hidden="true"></span>
        </button>
      </header>
      <section class="plugin-disabled">
        <h2>{{ state.effectiveState === 'disabled' ? '插件已停用' : '插件运行控制' }}</h2>
        <p v-if="state.effectiveState === 'disabled'">已停止插件采集与提醒，配置和历史数据完好保留。</p>
        <p v-else-if="state.effectiveState === 'disabling'">正在停止，请等待已开始的任务结束。</p>
        <p v-else>运行状态确认前不会加载业务界面。</p>
        <p class="plugin-note">已发送的请求无法撤回。停用不会删除数据或撤销站点权限。</p>
        <div class="plugin-actions">
          <button v-if="!allowExport" @click="openSettings">打开设置</button>
          <button v-if="allowExport && state.effectiveState === 'error'" :disabled="busy" @click="toggle(false)">保持停用并重试清理</button>
          <button v-if="error" :disabled="busy" @click="refresh">重新读取状态</button>
          <button v-if="allowExport && state.effectiveState === 'disabled'" :disabled="busy" @click="exportBackup">导出全量备份</button>
        </div>
      </section>
    </template>
    <p v-if="error || state.error" class="plugin-error" role="alert">{{ error || state.error }}</p>
  </div>
</template>

<style scoped>
.plugin-shell{color:var(--text-primary,inherit)}
.plugin-settings-heading{display:flex;align-items:center;gap:10px;margin:32px auto 0;padding:0 0 16px;max-width:1160px;border-bottom:1px solid var(--line,#8b97a533)}
.plugin-title{font-weight:700;font-size:18px}
.plugin-logo{width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,var(--brand,#31846f),var(--brand2,#46a090));color:white;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px}
.plugin-switch{flex-shrink:0;width:42px;height:24px;padding:3px;border:0;border-radius:20px;background:#7d8793;cursor:pointer}
.plugin-switch span{display:block;width:18px;height:18px;background:white;border-radius:50%;transition:transform .15s}
.plugin-switch.on{background:#31846f}.plugin-switch.on span{transform:translateX(18px)}
.plugin-switch:disabled{cursor:wait;opacity:.6}.plugin-switch:focus-visible{outline:2px solid #31846f;outline-offset:3px}
.plugin-disabled{padding:28px 20px;max-width:680px;margin:auto}.plugin-disabled h2{font-size:20px;margin-bottom:12px}
.plugin-disabled p{line-height:1.7}.plugin-note{opacity:.65;font-size:12px}.plugin-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:20px}
.plugin-actions button{padding:9px 14px;border:1px solid #82928f70;border-radius:8px;background:transparent;color:inherit;cursor:pointer}
.plugin-error{color:#c34848;padding:10px 18px;font-size:13px}
</style>
