<template>
  <div v-if="!store.online" class="offline-banner offline">
    <span class="dot-static"></span>
    <span>当前离线：页面为缓存数据（可能已过期），启运/到达等操作将暂存本机，恢复网络后自动同步。</span>
    <span v-if="store.queue.length" class="queue-count">待同步 {{ store.queue.length }} 条</span>
  </div>
  <div v-else-if="store.queue.length" class="offline-banner syncing">
    <span>🔄 网络已恢复，正在同步 {{ store.queue.length }} 条离线变更…</span>
  </div>
  <div v-else-if="store.failedSync.length" class="offline-banner failed" @click="showFailed">
    <span>⚠️ {{ store.failedSync.length }} 条离线变更同步失败（点击查看原因）</span>
  </div>
</template>

<script setup>
import { store, toast } from '../store.js';
import { clearFailed } from '../offline.js';

function showFailed() {
  const lines = store.failedSync.map((f) => `${f.waybillNo}「${f.label}」：${f.error}`);
  toast(lines.join('；'), 'error', 8000);
  clearFailed();
}
</script>
