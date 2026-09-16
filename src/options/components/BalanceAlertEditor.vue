<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { send } from '../../core/messaging/client'
import { MAX_BALANCE_ALERTS } from '../../shared/alertRules'
import type { AlertRuleDraft } from '../../shared/types'
const props = defineProps<{ modelValue: AlertRuleDraft[]; currency: string; siteId?: string }>()
const emit = defineEmits<{ 'update:modelValue': [AlertRuleDraft[]] }>()
const statusText = ref('')
const loading = ref(false)
function update(id: string, patch: Partial<AlertRuleDraft>) {
  emit('update:modelValue', props.modelValue.map((r) => r.id === id ? { ...r, ...patch } : r))
}
function add() {
  if (props.modelValue.length >= MAX_BALANCE_ALERTS) return
  emit('update:modelValue', [...props.modelValue, { id: crypto.randomUUID(), label: '', threshold: '',
    currency: props.currency, enabled: true, requireInteraction: true }])
}
function remove(id: string) { emit('update:modelValue', props.modelValue.filter((r) => r.id !== id)) }
async function refreshStatus() {
  if (!props.siteId) return
  loading.value = true
  try {
    const data = await send<{ notificationPermission: string; pending: number; latest?: { status: string; lastError?: string } }>('GET_BALANCE_ALERT_STATUS', { id: props.siteId })
    const labels: Record<string, string> = { pending: '待投递', delivered: '已交给系统通知', failed: '发送失败', cancelled: '已取消' }
    const reasons: Record<string, string> = { no_permission: '系统通知未获允许，请检查浏览器及系统设置', unavailable: '当前环境不支持系统通知', failed: '通知调用失败', disabled_or_changed: '插件、站点或规则已变更', expired: '超过投递有效期', rules_changed: '规则已变更', plugin_disabled: '插件已停用' }
    statusText.value = data.notificationPermission !== 'granted' ? '系统通知未获允许或不可用，请检查浏览器及操作系统通知设置。'
      : data.latest ? `最近警报：${labels[data.latest.status] ?? data.latest.status}${data.latest.lastError ? '；' + (reasons[data.latest.lastError] ?? '请稍后重试') : ''}。待投递 ${data.pending} 条。`
      : '系统通知可用，尚无警报事件。首次有效余额仅建立基准。'
  } catch (e) { statusText.value = e instanceof Error ? e.message : '通知状态暂不可用' }
  finally { loading.value = false }
}
onMounted(() => { void refreshStatus() })
</script>
<template>
  <section class="alerts-editor" aria-labelledby="balance-alert-title">
    <div class="alerts-heading"><h4 id="balance-alert-title">🔔 余额警报</h4><span>{{ modelValue.length }} / {{ MAX_BALANCE_ALERTS }}</span></div>
    <details class="alerts-guide">
      <summary>余额下降穿越临界值时通知 · 查看规则说明</summary>
    <p class="alerts-help">每次采集后检查：余额由<strong>高于临界值</strong>下降到<strong>临界值及以下</strong>时，发出系统通知。连续低余额不重复提醒，充值回升后可再次触发。</p>
    <p class="alerts-help">警报独立于“采集通知”档位；插件或本站停用后不提醒。阈值按站点原币判定，不跟随人民币显示换算。</p>
    <p class="alerts-help">首次采集、修改阈值或重新启用后，下一次有效余额仅建立基准，不补报历史下降。同站同轮多个命中项合并通知。实际弹出及显示时长受系统设置与免打扰模式影响。</p>
    </details>
    <div v-if="!modelValue.length" class="alerts-empty">尚未设置警报。添加一条临界值开始观察余额。</div>
    <div v-for="(rule, i) in modelValue" :key="rule.id" class="alert-rule">
      <div class="alert-rule-head">
        <label><input type="checkbox" :checked="rule.enabled" @change="update(rule.id, { enabled: ($event.target as HTMLInputElement).checked })" /> 启用警报 {{ i + 1 }}</label>
        <button type="button" class="alert-delete" :aria-label="'删除警报' + (i + 1)" @click="remove(rule.id)">删除</button>
      </div>
      <div class="alert-fields">
      <label class="alert-field">名称（可选）<input :value="rule.label" maxlength="32" placeholder="如：告急线"
        @input="update(rule.id, { label: ($event.target as HTMLInputElement).value })" /></label>
      <label class="alert-field">余额临界值 · {{ rule.currency }}<input :value="rule.threshold" inputmode="decimal" placeholder="如 5.00"
        @input="update(rule.id, { threshold: ($event.target as HTMLInputElement).value })" /></label>
      </div>
      <label class="alert-sticky"><input type="checkbox" :checked="rule.requireInteraction"
        @change="update(rule.id, { requireInteraction: ($event.target as HTMLInputElement).checked })" /> 请求通知保持显示，等待手动关闭</label>
      <div v-if="rule.currency !== currency" class="alert-currency-warning">
        站点币种已改为 {{ currency }}，原阈值仍是 {{ rule.currency }}，请确认后修改数值。
        <button type="button" @click="update(rule.id, { currency, enabled: false })">改为 {{ currency }} 并暂停此规则</button>
      </div>
    </div>
    <button type="button" class="btn alert-add" :disabled="modelValue.length >= MAX_BALANCE_ALERTS" @click="add">＋ 添加余额警报</button>

    <div v-if="siteId" class="alert-status" role="status">
      <span>{{ statusText }}</span><button type="button" :disabled="loading" @click="refreshStatus">{{ loading ? '查询中…' : '刷新通知状态' }}</button>
    </div>
  </section>
</template>
<style scoped>
.alerts-editor{min-width:0;margin:0;padding:14px;border:1px solid var(--line);border-radius:12px;background:var(--panel-soft)}
.alerts-heading{display:flex;align-items:center;justify-content:space-between}.alerts-heading h4{font-size:14px;margin:0}.alerts-heading>span{font-size:11px;color:var(--sub)}
.alerts-help{font-size:11px;color:var(--sub);line-height:1.7;margin:10px 0}.alerts-empty{padding:14px 0;color:var(--sub);font-size:12px}
.alert-rule{background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:12px;margin:10px 0}.alert-rule-head{display:flex;align-items:center;justify-content:space-between;font-size:12px;margin-bottom:8px}
.alert-field{display:block;font-size:11px;color:var(--sub);margin:8px 0}.alert-field>input{display:block;box-sizing:border-box;width:100%;margin-top:4px;padding:8px 10px;background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:7px}
.alert-sticky{font-size:11px;display:flex;align-items:center;gap:5px}.alert-delete{color:var(--err);border:0;background:transparent;cursor:pointer}.alert-add{width:100%;padding:9px 12px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--brand);font-size:12px;cursor:pointer}.alert-add:disabled{opacity:.5}
.alert-currency-warning{font-size:11px;color:var(--err);line-height:1.6;margin-top:9px}.alert-status{font-size:11px;line-height:1.7;color:var(--sub)}
.alert-status button,.alert-currency-warning button{font-size:11px;color:var(--brand);background:none;border:0;cursor:pointer;text-decoration:underline}
.alerts-guide{margin:10px 0;font-size:11px;color:var(--sub);line-height:1.7}
.alerts-guide summary{cursor:pointer}
.alert-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.alert-field{min-width:0}
.alert-field>input{min-width:0}
.alert-status{margin-top:10px;overflow-wrap:anywhere}
.alert-sticky{align-items:flex-start;line-height:1.6}
.alert-sticky input{flex-shrink:0;margin-top:3px}
@media(max-width:420px){.alert-fields{grid-template-columns:minmax(0,1fr)}}
</style>
