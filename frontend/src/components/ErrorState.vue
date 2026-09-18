<template>
  <div class="error-state">
    <div class="error-icon">{{ icon }}</div>
    <div class="error-title">{{ title }}</div>
    <div class="error-msg">{{ message || defaultMessage }}</div>
    <slot>
      <RouterLink to="/" class="btn btn-ghost">返回首页</RouterLink>
    </slot>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  type: { type: String, default: 'error' }, // forbidden | notfound | offline | error
  message: { type: String, default: '' },
});

const MAP = {
  forbidden: { icon: '🔒', title: '无权访问', defaultMessage: '该资源不属于本企业/本人，企业间数据已隔离。' },
  notfound: { icon: '🔍', title: '资源不存在', defaultMessage: '您访问的内容不存在或已被移除。' },
  offline: { icon: '📡', title: '当前离线', defaultMessage: '网络不可用，且本机没有该数据的缓存。' },
  error: { icon: '⚠️', title: '加载失败', defaultMessage: '服务暂时不可用，请稍后重试。' },
};

const icon = computed(() => MAP[props.type]?.icon || MAP.error.icon);
const title = computed(() => MAP[props.type]?.title || MAP.error.title);
const defaultMessage = computed(() => MAP[props.type]?.defaultMessage || MAP.error.defaultMessage);
</script>
