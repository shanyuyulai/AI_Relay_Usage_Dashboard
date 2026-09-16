<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { subscribeSiteIcon } from './siteIcons'
const props = withDefaults(defineProps<{ name: string; origin: string; color?: string; size?: number }>(), { size: 34 })
const icon = ref<string | null>(null)
const initial = computed(() => Array.from(props.name.trim())[0]?.toUpperCase() || '?')
let version = 0
let release: (() => void) | undefined
watch(() => props.origin, (origin) => {
  const current = ++version
  release?.()
  icon.value = null
  const subscription = subscribeSiteIcon(origin)
  release = subscription.release
  void subscription.result.then((value) => { if (current === version) icon.value = value })
}, { immediate: true })
onBeforeUnmount(() => { version++; release?.() })
</script>
<template>
  <span class="site-avatar" aria-hidden="true" :style="{
    width: size + 'px', height: size + 'px', fontSize: Math.max(10, Math.round(size * .4)) + 'px',
    background: icon ? 'var(--panel-soft)' : color || 'var(--brand)',
  }">
    <img v-if="icon" :src="icon" alt="" decoding="async" @error="icon = null" />
    <span v-else>{{ initial }}</span>
  </span>
</template>
<style scoped>
.site-avatar{display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;border-radius:25%;overflow:hidden;color:#fff;font-weight:700;line-height:1;vertical-align:middle}
.site-avatar img{display:block;width:80%;height:80%;object-fit:contain}
</style>
