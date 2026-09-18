<template>
  <div class="toast-host">
    <div v-for="t in store.toasts" :key="t.id" class="toast" :class="t.type">{{ t.text }}</div>
  </div>
</template>

<script setup>
import { store } from '../store.js';
</script>
