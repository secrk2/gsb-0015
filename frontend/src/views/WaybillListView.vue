<template>
  <div>
    <div v-if="stale" class="stale-banner">
      ⚠️ 当前展示离线缓存列表（更新于 {{ fmtClock(cachedAt) }}），运单状态可能已变化。
    </div>

    <div class="card">
      <div class="filter-bar">
        <div class="chip-row">
          <button
            v-for="c in statusChips"
            :key="c.value"
            class="chip"
            :class="{ active: filters.status === c.value }"
            @click="setStatus(c.value)"
          >{{ c.label }}</button>
        </div>
        <div class="filter-tools">
          <select v-if="isRegulator" v-model="filters.enterprise_id" class="input" @change="reload">
            <option value="">全部企业</option>
            <option v-for="e in enterprises" :key="e.id" :value="e.id">{{ e.name }}</option>
          </select>
          <input
            v-model.trim="filters.q"
            class="input search"
            placeholder="搜索单号 / 货物 / 车牌"
            @keyup.enter="reload"
          />
          <button class="btn btn-ghost" @click="reload">查询</button>
          <RouterLink v-if="canCreate" to="/waybills/new" class="btn btn-primary">＋ 填报运单</RouterLink>
        </div>
      </div>

      <ErrorState v-if="error" :type="errorType" :message="error.message">
        <button class="btn btn-primary" @click="load">重新加载</button>
      </ErrorState>

      <template v-else>
        <!-- 桌面表格（≥641px） -->
        <table class="data-table">
          <thead>
            <tr>
              <th>运单号</th><th>状态</th><th>货物</th><th>企业</th>
              <th>路线</th><th>车辆</th><th>驾驶员 / 押运员</th><th>计划发车</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="w in list.items" :key="w.id" @click="goDetail(w.id)">
              <td class="mono">{{ w.waybill_no }}</td>
              <td><StateBadge :status="w.status" /></td>
              <td>{{ w.cargo_name }}<div class="cell-sub">{{ w.cargo_class }} · {{ w.quantity }}{{ w.unit }}</div></td>
              <td>{{ w.enterprise_name }}</td>
              <td>{{ w.origin }} → {{ w.destination }}</td>
              <td class="mono">{{ w.vehicle_plate }}</td>
              <td>{{ w.driver_name }} / {{ w.escort_name }}</td>
              <td>{{ fmtDT(w.planned_departure) }}</td>
            </tr>
            <tr v-if="!list.items.length"><td colspan="8" class="empty">暂无符合条件的运单</td></tr>
          </tbody>
        </table>

        <!-- 移动卡片（≤640px） -->
        <div class="card-list">
          <div v-for="w in list.items" :key="w.id" class="waybill-card" @click="goDetail(w.id)">
            <div class="waybill-card-head">
              <span class="mono">{{ w.waybill_no }}</span>
              <StateBadge :status="w.status" />
            </div>
            <div class="waybill-card-body">
              <div>{{ w.cargo_name }}（{{ w.quantity }}{{ w.unit }}）</div>
              <div class="cell-sub">{{ w.origin }} → {{ w.destination }}</div>
              <div class="cell-sub">{{ w.driver_name }} / {{ w.escort_name }} · {{ w.vehicle_plate }}</div>
              <div class="cell-sub">计划发车 {{ fmtDT(w.planned_departure) }}</div>
            </div>
          </div>
          <div v-if="!list.items.length" class="empty">暂无符合条件的运单</div>
        </div>

        <div class="pager">
          <button class="btn btn-ghost btn-sm" :disabled="filters.page <= 1" @click="turnPage(-1)">上一页</button>
          <span>第 {{ filters.page }} 页 / 共 {{ list.total }} 条</span>
          <button class="btn btn-ghost btn-sm" :disabled="filters.page * pageSize >= list.total" @click="turnPage(1)">下一页</button>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, getCached } from '../api.js';
import { store } from '../store.js';
import { fmtDT, fmtClock } from '../utils.js';
import StateBadge from '../components/StateBadge.vue';
import ErrorState from '../components/ErrorState.vue';

const router = useRouter();
const pageSize = 10;

const filters = reactive({ status: '', enterprise_id: '', q: '', page: 1 });
const list = ref({ items: [], total: 0 });
const enterprises = ref([]);
const stale = ref(false);
const cachedAt = ref(null);
const error = ref(null);
const errorType = ref('error');

const isRegulator = computed(() => store.user?.role === 'REGULATOR');
const canCreate = computed(() => store.user?.role === 'ENTERPRISE_ADMIN');

const statusChips = computed(() => [
  { value: '', label: '全部' },
  ...(store.enums?.states || []).map((s) => ({ value: s.value, label: s.label })),
]);

const queryString = computed(() => {
  const p = new URLSearchParams();
  if (filters.status) p.set('status', filters.status);
  if (filters.enterprise_id) p.set('enterprise_id', filters.enterprise_id);
  if (filters.q) p.set('q', filters.q);
  p.set('page', filters.page);
  p.set('page_size', pageSize);
  return p.toString();
});

async function load() {
  try {
    const r = await getCached(`/waybills?${queryString.value}`);
    list.value = r.data;
    stale.value = r.stale;
    cachedAt.value = r.cachedAt;
    error.value = null;
  } catch (e) {
    error.value = e;
    errorType.value = e.code === 'OFFLINE' ? 'offline' : (e.status === 403 ? 'forbidden' : 'error');
  }
}

function setStatus(v) { filters.status = v; filters.page = 1; load(); }
function reload() { filters.page = 1; load(); }
function turnPage(d) { filters.page += d; load(); }
function goDetail(id) { router.push(`/waybills/${id}`); }

onMounted(async () => {
  load();
  if (isRegulator.value) {
    try { enterprises.value = (await api.get('/meta/enterprises')).items; } catch { /* 忽略 */ }
  }
});
</script>
