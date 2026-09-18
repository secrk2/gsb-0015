<template>
  <div class="dashboard">
    <div v-if="stale" class="stale-banner">
      ⚠️ 当前展示离线缓存数据（更新于 {{ fmtClock(cachedAt) }}），状态可能已变化，恢复网络后自动刷新。
    </div>

    <ErrorState v-if="error" :type="errorType" :message="error.message">
      <button class="btn btn-primary" @click="load">重新加载</button>
    </ErrorState>

    <template v-else-if="summary">
      <!-- 概览指标 -->
      <section class="stat-grid">
        <div class="stat-card">
          <div class="stat-num">{{ pendingTotal }}</div>
          <div class="stat-label">待派车运单（{{ summary.scope }}）</div>
        </div>
        <div class="stat-card">
          <div class="stat-num">{{ summary.today_departures.length }}</div>
          <div class="stat-label">今日应离</div>
        </div>
        <div class="stat-card">
          <div class="stat-num">{{ summary.today_arrivals.length }}</div>
          <div class="stat-label">今日应到</div>
        </div>
        <div class="stat-card" :class="{ 'stat-alert': alertTotal > 0 }">
          <div class="stat-num">
            <span v-if="alertTotal > 0" class="dot"></span>{{ alertTotal }}
          </div>
          <div class="stat-label">异常与超时</div>
        </div>
      </section>

      <!-- 各企业待派车漏斗 -->
      <section class="card">
        <div class="card-head">
          <h2>待派车漏斗</h2>
          <span class="card-note">填报 → 自审 → 待核验 → 已派车待发车</span>
        </div>
        <div class="funnel-grid">
          <div v-for="f in summary.funnel" :key="f.enterprise_id" class="funnel-card">
            <div class="funnel-title">
              <span>{{ f.enterprise_name }}</span>
              <span class="funnel-total">待派车 {{ f.pending_dispatch }}</span>
            </div>
            <div class="funnel-bar">
              <div
                v-for="seg in funnelSegments(f)"
                :key="seg.label"
                class="funnel-seg"
                :class="seg.cls"
                :style="{ flexGrow: Math.max(seg.count, seg.count ? 1 : 0) }"
                :title="`${seg.label} ${seg.count}`"
              >
                <span v-if="seg.count">{{ seg.count }}</span>
              </div>
            </div>
            <div class="funnel-legend">
              <span v-for="seg in funnelSegments(f)" :key="seg.label">
                <i class="legend-dot" :class="seg.cls"></i>{{ seg.label }} {{ seg.count }}
              </span>
            </div>
          </div>
        </div>
      </section>

      <!-- 今日应到应离 -->
      <section class="today-grid">
        <div class="card">
          <div class="card-head"><h2>今日应离</h2><span class="card-note">计划发车在今天</span></div>
          <div v-if="!summary.today_departures.length" class="empty">今日无应离运单</div>
          <div v-for="w in summary.today_departures" :key="w.id" class="row-item" @click="goDetail(w.id)">
            <span v-if="w.late" class="dot" title="发车超时"></span>
            <div class="row-main">
              <div class="row-title">{{ w.waybill_no }} <StateBadge :status="w.status" /></div>
              <div class="row-sub">{{ w.enterprise_name }}</div>
            </div>
            <div class="row-time">
              <div>计划 {{ fmtTime(w.planned_departure) }}</div>
              <div class="row-sub">{{ w.actual_departure ? `实发 ${fmtTime(w.actual_departure)}` : (w.late ? '已超时' : '未发车') }}</div>
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h2>今日应到</h2><span class="card-note">计划到达在今天</span></div>
          <div v-if="!summary.today_arrivals.length" class="empty">今日无应到运单</div>
          <div v-for="w in summary.today_arrivals" :key="w.id" class="row-item" @click="goDetail(w.id)">
            <span v-if="w.late" class="dot" title="到达超时"></span>
            <div class="row-main">
              <div class="row-title">{{ w.waybill_no }} <StateBadge :status="w.status" /></div>
              <div class="row-sub">{{ w.enterprise_name }}</div>
            </div>
            <div class="row-time">
              <div>计划 {{ fmtTime(w.planned_arrival) }}</div>
              <div class="row-sub">{{ w.actual_arrival ? `实到 ${fmtTime(w.actual_arrival)}` : (w.late ? '已超时' : '在途') }}</div>
            </div>
          </div>
        </div>
      </section>

      <!-- 异常与超时红点 -->
      <section class="alert-grid">
        <div class="card alert-card" :class="{ armed: summary.alerts.aborted_today.length }">
          <div class="card-head">
            <h2><span v-if="summary.alerts.aborted_today.length" class="dot"></span>今日异常中止</h2>
            <span class="badge-count">{{ summary.alerts.aborted_today.length }}</span>
          </div>
          <div v-if="!summary.alerts.aborted_today.length" class="empty">今日无异常中止</div>
          <div v-for="a in summary.alerts.aborted_today" :key="a.id" class="row-item" @click="goDetail(a.id)">
            <div class="row-main">
              <div class="row-title">{{ a.waybill_no }}</div>
              <div class="row-sub">{{ a.enterprise_name }} · {{ fmtTime(a.created_at) }}</div>
              <div class="row-reason">{{ a.reason }}</div>
            </div>
          </div>
        </div>
        <div class="card alert-card" :class="{ armed: summary.alerts.timeout_departures.length }">
          <div class="card-head">
            <h2><span v-if="summary.alerts.timeout_departures.length" class="dot"></span>发车超时</h2>
            <span class="badge-count">{{ summary.alerts.timeout_departures.length }}</span>
          </div>
          <div v-if="!summary.alerts.timeout_departures.length" class="empty">无超时未发车</div>
          <div v-for="a in summary.alerts.timeout_departures" :key="a.id" class="row-item" @click="goDetail(a.id)">
            <div class="row-main">
              <div class="row-title">{{ a.waybill_no }}</div>
              <div class="row-sub">{{ a.enterprise_name }} · 应发 {{ fmtDT(a.planned_departure) }}</div>
            </div>
          </div>
        </div>
        <div class="card alert-card" :class="{ armed: summary.alerts.timeout_arrivals.length }">
          <div class="card-head">
            <h2><span v-if="summary.alerts.timeout_arrivals.length" class="dot"></span>到达超时</h2>
            <span class="badge-count">{{ summary.alerts.timeout_arrivals.length }}</span>
          </div>
          <div v-if="!summary.alerts.timeout_arrivals.length" class="empty">无超时未到达</div>
          <div v-for="a in summary.alerts.timeout_arrivals" :key="a.id" class="row-item" @click="goDetail(a.id)">
            <div class="row-main">
              <div class="row-title">{{ a.waybill_no }}</div>
              <div class="row-sub">{{ a.enterprise_name }} · 应到 {{ fmtDT(a.planned_arrival) }}</div>
            </div>
          </div>
        </div>
      </section>

      <div class="dash-foot">数据更新于 {{ fmtClock(summary.generated_at) }} · 每 30 秒自动刷新</div>
    </template>

    <div v-else class="loading">加载中…</div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { getCached } from '../api.js';
import { store } from '../store.js';
import { fmtTime, fmtDT, fmtClock } from '../utils.js';
import StateBadge from '../components/StateBadge.vue';
import ErrorState from '../components/ErrorState.vue';

const router = useRouter();
const summary = ref(null);
const stale = ref(false);
const cachedAt = ref(null);
const error = ref(null);
const errorType = ref('error');
let timer = null;

const pendingTotal = computed(() => (summary.value?.funnel || []).reduce((s, f) => s + Number(f.pending_dispatch), 0));
const alertTotal = computed(() => {
  const a = summary.value?.alerts;
  if (!a) return 0;
  return a.aborted_today.length + a.timeout_departures.length + a.timeout_arrivals.length;
});

function funnelSegments(f) {
  return [
    { label: '填报中', count: Number(f.draft), cls: 'seg-draft' },
    { label: '自审中', count: Number(f.enterprise_review), cls: 'seg-review' },
    { label: '待核验', count: Number(f.regulator_verify), cls: 'seg-verify' },
    { label: '已派车待发车', count: Number(f.dispatched_waiting), cls: 'seg-dispatched' },
  ];
}

async function load() {
  try {
    const r = await getCached('/dashboard/summary');
    summary.value = r.data;
    stale.value = r.stale;
    cachedAt.value = r.cachedAt;
    error.value = null;
  } catch (e) {
    error.value = e;
    errorType.value = e.code === 'OFFLINE' ? 'offline' : (e.status === 403 ? 'forbidden' : 'error');
  }
}

function goDetail(id) {
  router.push(`/waybills/${id}`);
}

onMounted(() => {
  load();
  timer = setInterval(() => {
    if (store.online && !document.hidden) load();
  }, 30000);
});
onUnmounted(() => clearInterval(timer));
</script>
