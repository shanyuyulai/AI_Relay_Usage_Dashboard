<script setup lang="ts">
import type { SiteCollectionProfile } from '../../shared/types'

const props = defineProps<{ profile: SiteCollectionProfile }>()
const emit = defineEmits<{
  reprobe: []
  diagnose: []
  edit: []
  reauth: []
  sync: []
}>()

function engineText(p: SiteCollectionProfile): string {
  return p.execution.engine === 'sw_lab' ? '零标签实验室（SW 内静默）' : '页面主世界同源会话'
}
function autoText(a: SiteCollectionProfile['execution']['automaticCollection']): string {
  switch (a) {
    case 'enabled': return '允许自动采集'
    case 'manual_only': return '仅手动（含副作用端点）'
    case 'unavailable': return '已禁用，不参与自动采集'
  }
}
function familyText(f: SiteCollectionProfile['classification']['family']): string {
  switch (f) {
    case 'independent': return '独立接口'
    case 'new-api-capable': return 'New API 兼容'
    case 'one-api-compatible': return 'One API 兼容'
    default: return '待识别'
  }
}
function routeText(r: SiteCollectionProfile['classification']['routeProfile']): string {
  switch (r) {
    case 'standard': return '标准路径'
    case 'fork-path': return '变体路径'
    case 'discovered': return '网络发现'
    default: return '—'
  }
}
function confText(c: SiteCollectionProfile['classification']['confidence']): string {
  switch (c) {
    case 'high': return '高'
    case 'medium': return '中'
    case 'low': return '低'
    default: return '—'
  }
}
function semanticsText(s: SiteCollectionProfile['classification']['accountSemantics']): string {
  switch (s) {
    case 'current_balance_and_historical_consumed': return '当前余额 / 历史消耗'
    case 'quota_limit_and_used': return '总额度 / 已用'
    case 'direct_balance': return '直接余额'
    default: return '—'
  }
}
function stateText(s: SiteCollectionProfile['steps'][number]['state']): string {
  switch (s) {
    case 'verified': return '已验证'
    case 'planned': return '计划尝试'
    case 'partial': return '部分可用'
    case 'unsupported': return '不支持'
    case 'unauthorized': return '需要登录'
    case 'failed': return '异常'
  }
}
function stateCls(s: SiteCollectionProfile['steps'][number]['state']): string {
  return 'st-' + s
}
function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function failText(p: SiteCollectionProfile): string {
  const f = p.health.latestFailure!
  const when = f.at ? `（${fmtTime(f.at)}）` : ''
  const path = f.pathname ? ` ${f.pathname}` : ''
  return `${reasonText(f.reason)}${path}：建议${f.suggestedAction ?? '查看诊断'}${when}`
}
function reasonText(r: SiteCollectionProfile['health']['latestFailure'] extends null ? never : NonNullable<SiteCollectionProfile['health']['latestFailure']>['reason']): string {
  switch (r) {
    case 'HOST_PERMISSION_MISSING': return '缺少站点权限'
    case 'NO_MATCHING_OPEN_TAB': return '无同源登录页'
    case 'ACCOUNT_UNAUTHORIZED': return '账户接口明确未授权'
    case 'AUTH_CONTEXT_INCOMPLETE': return '请求上下文不完整'
    case 'CANDIDATE_REJECTED': return '候选接口被拒绝'
    case 'NETWORK_OR_TIMEOUT': return '网络或超时'
    case 'NON_JSON_RESPONSE': return '非 JSON 响应'
    case 'ACCOUNT_CONTRACT_MISMATCH': return '账户契约不匹配'
    case 'ENDPOINT_UNAVAILABLE': return '接口不可用'
    case 'SCRIPT_INJECTION_FAILED': return '脚本注入失败'
    case 'PANEL_ORIGIN_SESSION_MISMATCH': return '面板域与控制台不一致'
    case 'SW_SESSION_UNAVAILABLE': return '实验室无会话'
    default: return '采集异常'
  }
}
</script>

<template>
  <div class="cp-card">
    <div class="cp-grid">
      <section>
        <h4>运行方式</h4>
        <ul>
          <li>采集引擎：<b>{{ engineText(profile) }}</b></li>
          <li>自动采集：{{ autoText(profile.execution.automaticCollection) }}</li>
          <li>采集器版本：v{{ profile.execution.collectorVersion }}</li>
          <li>需要同源已登录会话：是</li>
        </ul>
      </section>
      <section>
        <h4>类型识别</h4>
        <ul>
          <li>配置适配器：{{ profile.configuredAdapter.label }}</li>
          <li>自动识别家族：<b>{{ familyText(profile.classification.family) }}</b></li>
          <li>路径特征：{{ routeText(profile.classification.routeProfile) }}</li>
          <li>置信度：{{ confText(profile.classification.confidence) }}</li>
          <li>账户契约：{{ semanticsText(profile.classification.accountSemantics) }}</li>
          <li>最近探测：{{ profile.classification.probedAt ? fmtTime(profile.classification.probedAt) : '未探测' }}</li>
        </ul>
      </section>
    </div>

    <section class="steps-sec">
      <h4>指标方案（仅 pathname，不含查询参数与凭证）</h4>
      <table class="steps-table">
        <thead>
          <tr><th>指标</th><th>端点</th><th>预期产出</th><th>状态</th></tr>
        </thead>
        <tbody>
          <tr v-for="s in profile.steps" :key="s.id">
            <td>{{ s.label }}</td>
            <td class="mono">{{ s.method }} {{ s.path }}</td>
            <td class="metrics">{{ s.expectedMetrics.join('、') }}</td>
            <td><span class="st" :class="stateCls(s.state)">{{ stateText(s.state) }}</span></td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="health-sec">
      <h4>诊断与操作</h4>
      <div v-if="profile.health.latestFailure" class="fail">⚠ {{ failText(profile) }}</div>
      <div v-else-if="profile.health.lastStatus === 'ok'" class="ok-note">✅ 最近一次采集正常</div>
      <div v-else-if="profile.health.lastStatus === 'unknown'" class="ok-note">尚未采集</div>
      <div v-else class="ok-note">最近状态：{{ profile.health.lastStatus }}</div>
      <div class="ops">
        <button class="mini" @click="emit('reprobe')">重新探测</button>
        <button class="mini" @click="emit('diagnose')">查看诊断</button>
        <button class="mini" @click="emit('edit')">编辑地址</button>
        <button class="mini" @click="emit('reauth')">重新授权</button>
        <button class="mini accent" @click="emit('sync')">立即同步</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.cp-card {
  display: flex;
  flex-direction: column;
  gap: 14px;
  font-size: 11px;
  color: var(--text);
}
.cp-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
.cp-card section h4 {
  margin: 0 0 7px;
  font-size: 11px;
  color: var(--sub);
  font-weight: 600;
}
.cp-card ul {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.cp-card li {
  line-height: 1.5;
}
.steps-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}
.steps-table th,
.steps-table td {
  text-align: left;
  padding: 6px 8px;
  border-bottom: 1px solid var(--line);
  vertical-align: top;
}
.steps-table th {
  color: var(--sub);
  font-weight: 600;
}
.steps-table .mono {
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  color: var(--brand-text);
  word-break: break-all;
}
.steps-table .metrics {
  color: var(--sub);
}
.st {
  display: inline-block;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 10px;
  white-space: nowrap;
  border: 1px solid transparent;
}
.st-verified { background: var(--ok-soft); color: var(--ok); border-color: var(--ok); }
.st-planned { background: var(--panel-soft); color: var(--sub); }
.st-partial { background: #fff7e6; color: #b8860b; border-color: #e0a800; }
.st-unsupported { background: var(--panel-soft); color: var(--sub); }
.st-unauthorized { background: #fff7e6; color: #b8860b; border-color: #e0a800; }
.st-failed { background: var(--err-soft); color: var(--err); border-color: var(--err); }
.fail {
  background: var(--err-soft);
  color: var(--err);
  border-radius: 8px;
  padding: 8px 10px;
  line-height: 1.6;
}
.ok-note {
  color: var(--sub);
  margin-bottom: 8px;
}
.health-sec .ops {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
</style>
