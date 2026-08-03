<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { send, MessagingError } from '../../core/messaging/client'
import { normalizeOrigin } from '../../shared/util'
import { registry } from '../../adapters'
import type { SiteConfig } from '../../shared/types'

const props = defineProps<{
  visible: boolean
  site?: SiteConfig | null
}>()
const emit = defineEmits<{
  close: []
  submitted: []
}>()

const adapters = registry.list()
const isEdit = computed(() => !!props.site)

const CURRENCIES = [
  { id: 'USD', label: 'USD（$）' },
  { id: 'CNY', label: 'CNY（¥）' },
  { id: 'JPY', label: 'JPY（¥）' },
  { id: 'EUR', label: 'EUR（€）' },
]

const form = ref({ name: '', baseUrl: '', adapter: adapters[0]?.id ?? '', currency: 'USD' })
const formError = ref('')
const submitting = ref(false)

watch(
  () => props.visible,
  (v) => {
    if (!v) return
    formError.value = ''
    if (props.site) {
      form.value = {
        name: props.site.name,
        baseUrl: props.site.baseUrl,
        adapter: props.site.adapter,
        currency: props.site.currency || 'USD',
      }
    } else {
      form.value = { name: '', baseUrl: '', adapter: adapters[0]?.id ?? '', currency: 'USD' }
    }
  },
)

// 保存站点（权限已提前在用户手势同步路径中申请）
async function doSave(origin: string) {
  submitting.value = true
  try {
    if (props.site) {
      await send('UPDATE_SITE', {
        id: props.site.id,
        patch: { name: form.value.name, baseUrl: form.value.baseUrl, currency: form.value.currency },
      })
    } else {
      await send<{ siteId: string }>('ADD_SITE', {
        type: form.value.adapter,
        name: form.value.name,
        baseUrl: form.value.baseUrl,
        currency: form.value.currency,
      })
    }
    emit('submitted')
  } catch (e) {
    formError.value = e instanceof MessagingError ? e.message : String(e)
  } finally {
    submitting.value = false
  }
}

function handleSubmit() {
  formError.value = ''
  if (!form.value.name.trim()) {
    formError.value = '请输入站点名称'
    return
  }
  if (!form.value.baseUrl.trim()) {
    formError.value = '请输入面板地址'
    return
  }

  let origin: string
  try {
    origin = normalizeOrigin(form.value.baseUrl)
  } catch {
    formError.value = '面板地址格式无效，请输入完整 URL（如 https://example.com）'
    return
  }

  // MV3：chrome.permissions.request 必须在用户手势的同步处理中调用。
  // 这里 handleSubmit 保持非 async，request 紧跟在验证之后，确保 Chrome 识别为手势内调用。
  const needPerm = !props.site || props.site.origin !== origin
  console.log(`[AI Relay][SiteForm] handleSubmit needPerm=${needPerm} origin=${origin} isEdit=${isEdit.value}`)
  if (needPerm) {
    submitting.value = true
    console.log(`[AI Relay][SiteForm] 发起权限请求: origins=["${origin}/*"]`)
    chrome.permissions
      .request({ origins: [`${origin}/*`] })
      .then((granted) => {
        console.log(`[AI Relay][SiteForm] 权限请求结果: granted=${granted}`)
        if (!granted) {
          formError.value = '未获得该站点的 host 权限，无法保存'
          submitting.value = false
          return
        }
        return doSave(origin)
      })
      .catch((e) => {
        console.error(`[AI Relay][SiteForm] 权限请求异常:`, e)
        formError.value = e instanceof Error ? e.message : String(e)
        submitting.value = false
      })
    return
  }

  doSave(origin)
}
</script>

<template>
  <div v-if="visible" class="modal-mask" @click.self="emit('close')">
    <div class="modal">
      <h3>{{ isEdit ? '编辑站点' : '＋ 添加站点' }}</h3>

      <div class="f">
        <label>站点名称</label>
        <input v-model="form.name" placeholder="如 RayinAI" @keyup.enter="handleSubmit" />
      </div>
      <div class="f">
        <label>面板地址</label>
        <input v-model="form.baseUrl" placeholder="https://example.com" @keyup.enter="handleSubmit" />
      </div>
      <div class="f">
        <label>适配器类型</label>
        <select v-model="form.adapter" :disabled="isEdit">
          <option v-for="a in adapters" :key="a.id" :value="a.id">{{ a.name }}</option>
        </select>
      </div>
      <div class="f">
        <label>计价货币</label>
        <select v-model="form.currency">
          <option v-for="c in CURRENCIES" :key="c.id" :value="c.id">{{ c.label }}</option>
        </select>
      </div>

      <div v-if="!isEdit" class="steps">
        <b>授权流程（无需输入账号密码）：</b><br />
        ① 授权插件访问该站点域名（Chrome 弹出权限确认）<br />
        ② 打开原站并完成登录<br />
        ③ 回到插件点击「去授权」或「立即同步」，自动读取登录态
      </div>

      <div v-if="formError" class="form-err">{{ formError }}</div>

      <div class="foot">
        <button class="btn" @click="emit('close')">取消</button>
        <button class="btn primary" :disabled="submitting" @click="handleSubmit">
          {{ submitting ? '保存中…' : isEdit ? '保存' : '授权并添加' }}
        </button>
      </div>

      <div class="note">🔐 凭证仅使用 Cookie 会话，按站点隔离，永不回退共用，导出时自动剔除。</div>
    </div>
  </div>
</template>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  background: var(--mask);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  z-index: 100;
  padding-top: 60px;
}
.modal {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: 0 18px 50px var(--shadow-lg);
  width: 440px;
  max-width: 90vw;
  padding: 22px;
}
.modal h3 {
  font-size: 14px;
  margin-bottom: 16px;
}
.f {
  margin-bottom: 13px;
}
.f label {
  display: block;
  font-size: 11px;
  color: var(--sub);
  margin-bottom: 5px;
}
.f input,
.f select {
  width: 100%;
  padding: 9px 12px;
  border: 1px solid var(--line);
  border-radius: 9px;
  font-size: 12px;
  color: var(--text);
  background: var(--panel);
}
.f input:focus,
.f select:focus {
  outline: none;
  border-color: var(--brand);
}
.steps {
  background: var(--panel-soft);
  border-radius: 10px;
  padding: 12px 14px;
  font-size: 11px;
  color: var(--sub);
  line-height: 1.9;
  margin: 14px 0;
}
.steps b {
  color: var(--text);
}
.form-err {
  background: var(--err-soft);
  color: var(--err);
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 11px;
  margin-bottom: 12px;
}
.foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
.btn {
  padding: 8px 16px;
  border-radius: 9px;
  font-size: 12px;
  border: 1px solid var(--line);
  background: var(--panel);
  cursor: pointer;
  color: var(--text);
}
.btn.primary {
  background: var(--brand);
  border-color: var(--brand);
  color: #fff;
  font-weight: 600;
}
.btn.primary:disabled {
  opacity: 0.6;
  cursor: default;
}
.note {
  font-size: 10px;
  color: var(--sub);
  margin-top: 10px;
}
</style>
