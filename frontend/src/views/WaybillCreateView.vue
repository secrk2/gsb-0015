<template>
  <div class="card form-card">
    <div class="card-head"><h2>填报电子运单</h2><span class="card-note">带 * 为必填项</span></div>

    <ErrorState v-if="loadError" type="error" :message="loadError" />

    <form v-else class="form-grid" @submit.prevent="onSubmit">
      <label class="form-item">
        <span>货物名称 *</span>
        <input v-model.trim="form.cargo_name" class="input" maxlength="128" placeholder="如：汽油" />
        <em v-if="errors.cargo_name" class="field-error">{{ errors.cargo_name }}</em>
      </label>
      <label class="form-item">
        <span>危险货物类别 *</span>
        <select v-model="form.cargo_class" class="input">
          <option value="" disabled>请选择</option>
          <option v-for="c in cargoClasses" :key="c" :value="c">{{ c }}</option>
        </select>
        <em v-if="errors.cargo_class" class="field-error">{{ errors.cargo_class }}</em>
      </label>
      <label class="form-item">
        <span>数量 *</span>
        <input v-model.number="form.quantity" class="input" type="number" min="0" step="0.01" placeholder="如：28.5" />
        <em v-if="errors.quantity" class="field-error">{{ errors.quantity }}</em>
      </label>
      <label class="form-item">
        <span>计量单位</span>
        <input v-model.trim="form.unit" class="input" maxlength="8" placeholder="吨" />
      </label>
      <label class="form-item">
        <span>装货地 *</span>
        <input v-model.trim="form.origin" class="input" maxlength="255" placeholder="如：云州市经开区油库" />
        <em v-if="errors.origin" class="field-error">{{ errors.origin }}</em>
      </label>
      <label class="form-item">
        <span>卸货地 *</span>
        <input v-model.trim="form.destination" class="input" maxlength="255" placeholder="如：望海市港区加油站" />
        <em v-if="errors.destination" class="field-error">{{ errors.destination }}</em>
      </label>
      <label class="form-item">
        <span>承运车辆号牌 *</span>
        <input v-model.trim="form.vehicle_plate" class="input" maxlength="10" placeholder="如：云A·D3101" />
        <em v-if="errors.vehicle_plate" class="field-error">{{ errors.vehicle_plate }}</em>
      </label>
      <label class="form-item">
        <span>驾驶员 *</span>
        <select v-model="form.driver_id" class="input">
          <option :value="null" disabled>请选择驾驶员</option>
          <option v-for="d in crew.drivers" :key="d.id" :value="d.id">{{ d.name }}（{{ d.phone || '无电话' }}）</option>
        </select>
        <em v-if="errors.driver_id" class="field-error">{{ errors.driver_id }}</em>
      </label>
      <label class="form-item">
        <span>押运员 *</span>
        <select v-model="form.escort_id" class="input">
          <option :value="null" disabled>请选择押运员</option>
          <option v-for="s in crew.escorts" :key="s.id" :value="s.id">{{ s.name }}（{{ s.phone || '无电话' }}）</option>
        </select>
        <em v-if="errors.escort_id" class="field-error">{{ errors.escort_id }}</em>
      </label>
      <label class="form-item">
        <span>计划发车时间 *</span>
        <input v-model="form.planned_departure" class="input" type="datetime-local" />
        <em v-if="errors.planned_departure" class="field-error">{{ errors.planned_departure }}</em>
      </label>
      <label class="form-item">
        <span>计划到达时间 *</span>
        <input v-model="form.planned_arrival" class="input" type="datetime-local" />
        <em v-if="errors.planned_arrival" class="field-error">{{ errors.planned_arrival }}</em>
      </label>
      <label class="form-item form-item-wide">
        <span>备注</span>
        <textarea v-model.trim="form.remark" class="input" rows="2" maxlength="500" placeholder="选填"></textarea>
      </label>

      <div v-if="samePerson" class="form-error-banner">驾驶员与押运员不得为同一人</div>
      <div v-if="submitError" class="form-error-banner">{{ submitError }}</div>

      <div class="form-actions">
        <button type="submit" class="btn btn-primary" :disabled="submitting || samePerson">
          {{ submitting ? '提交中…' : '保存（填报状态）' }}
        </button>
        <RouterLink to="/waybills" class="btn btn-ghost">取消</RouterLink>
      </div>
    </form>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, newIdempotencyKey } from '../api.js';
import { store, toast } from '../store.js';
import ErrorState from '../components/ErrorState.vue';

const router = useRouter();
const crew = reactive({ drivers: [], escorts: [] });
const cargoClasses = ref([]);
const errors = reactive({});
const submitError = ref('');
const loadError = ref('');
const submitting = ref(false);
// 同一张表单共用一个幂等键：双击 / 重试不得开出两张单；成功后换键，允许继续开下一单
const idemKey = ref(newIdempotencyKey());

const form = reactive({
  cargo_name: '',
  cargo_class: '',
  quantity: null,
  unit: '吨',
  origin: '',
  destination: '',
  vehicle_plate: '',
  driver_id: null,
  escort_id: null,
  planned_departure: '',
  planned_arrival: '',
  remark: '',
});

const samePerson = computed(() => form.driver_id && form.escort_id && form.driver_id === form.escort_id);

onMounted(async () => {
  try {
    const [crewRes, enumsRes] = await Promise.all([
      api.get('/meta/crew'),
      store.enums ? Promise.resolve(store.enums) : api.get('/meta/enums'),
    ]);
    crew.drivers = crewRes.drivers;
    crew.escorts = crewRes.escorts;
    store.enums = store.enums || enumsRes;
    cargoClasses.value = (store.enums || enumsRes).cargoClasses;
  } catch (e) {
    loadError.value = e.message || '基础数据加载失败';
  }
});

async function onSubmit() {
  Object.keys(errors).forEach((k) => delete errors[k]);
  submitError.value = '';
  if (samePerson.value) return;
  submitting.value = true;
  try {
    const res = await api.post('/waybills', { ...form }, { 'Idempotency-Key': idemKey.value });
    idemKey.value = newIdempotencyKey();
    toast(`运单 ${res.waybill.waybill_no} 创建成功（填报状态）`, 'success');
    router.push(`/waybills/${res.waybill.id}`);
  } catch (e) {
    if (e.details) Object.assign(errors, e.details);
    submitError.value = e.message;
  } finally {
    submitting.value = false;
  }
}
</script>
