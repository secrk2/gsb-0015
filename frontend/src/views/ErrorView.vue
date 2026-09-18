<template>
  <ErrorState :type="type" :message="message">
    <RouterLink to="/" class="btn btn-primary">返回首页</RouterLink>
  </ErrorState>
</template>

<script setup>
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import ErrorState from '../components/ErrorState.vue';

const route = useRoute();
const type = computed(() => (route.name === 'forbidden' ? 'forbidden' : 'notfound'));
const message = computed(() => (route.name === 'forbidden'
  ? '当前角色无权访问该页面，或资源属于其他企业（企业间数据已隔离）。'
  : ''));
</script>
