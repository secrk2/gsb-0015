<template>
  <ol class="timeline">
    <li v-for="ev in events" :key="ev.id" class="timeline-item">
      <div class="timeline-dot" :class="`st-${ev.to_status}`"></div>
      <div class="timeline-body">
        <div class="timeline-head">
          <span class="timeline-action">{{ ACTION_LABELS[ev.action] || ev.action }}</span>
          <StateBadge :status="ev.to_status" />
        </div>
        <div class="timeline-meta">
          {{ ev.actor_name || '系统' }} · {{ fmtDT(ev.created_at) }}
          <span v-if="ev.client_occurred_at" class="tag tag-offline" title="离线端补录的真实发生时间">
            离线补录 {{ fmtDT(ev.client_occurred_at) }}
          </span>
        </div>
        <div v-if="ev.reason" class="timeline-reason">原因：{{ ev.reason }}</div>
      </div>
    </li>
  </ol>
</template>

<script setup>
import StateBadge from './StateBadge.vue';
import { fmtDT, ACTION_LABELS } from '../utils.js';

defineProps({ events: { type: Array, default: () => [] } });
</script>
