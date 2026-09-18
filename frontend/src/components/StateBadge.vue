<template>
  <span class="state-badge" :class="`st-${status}`">{{ label }}</span>
</template>

<script setup>
import { computed } from 'vue';
import { store } from '../store.js';

const props = defineProps({ status: { type: String, required: true } });

const FALLBACK = {
  DRAFT: '填报',
  ENTERPRISE_REVIEW: '企业自审',
  REGULATOR_VERIFY: '监管核验',
  DISPATCHED: '已派车',
  IN_TRANSIT: '运输中',
  COMPLETED: '已完成',
  ABORTED: '异常中止',
};

const label = computed(() => {
  const fromEnums = store.enums?.states?.find((s) => s.value === props.status)?.label;
  return fromEnums || FALLBACK[props.status] || props.status;
});
</script>
