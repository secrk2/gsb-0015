import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWaybillPayload, parseLocalDateTime, validateOccurredAt } from '../src/validators.js';
import { formatWaybillNo } from '../src/waybillNo.js';

const validBody = {
  cargo_name: '汽油',
  cargo_class: '第3类 易燃液体',
  quantity: 28.5,
  unit: '吨',
  origin: '云州市经开区油库',
  destination: '望海市港区加油站',
  vehicle_plate: '云A·D3101',
  driver_id: 20,
  escort_id: 30,
  planned_departure: '2026-09-18T08:00',
  planned_arrival: '2026-09-18T18:00',
};

test('合法填报通过校验', () => {
  const r = validateWaybillPayload(validBody);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('驾驶员与押运员不得为同一人', () => {
  const r = validateWaybillPayload({ ...validBody, escort_id: 20 });
  assert.equal(r.ok, false);
  assert.match(r.errors.escort_id, /不得为同一人/);
});

test('缺驾驶员/押运员分别报错', () => {
  const r1 = validateWaybillPayload({ ...validBody, driver_id: null });
  assert.match(r1.errors.driver_id, /驾驶员/);
  const r2 = validateWaybillPayload({ ...validBody, escort_id: 0 });
  assert.match(r2.errors.escort_id, /押运员/);
});

test('必填项缺失逐项报错', () => {
  const r = validateWaybillPayload({});
  for (const k of ['cargo_name', 'cargo_class', 'origin', 'destination', 'vehicle_plate', 'quantity', 'planned_departure', 'planned_arrival']) {
    assert.ok(r.errors[k], `应缺少 ${k}`);
  }
});

test('计划到达必须晚于计划发车', () => {
  const r = validateWaybillPayload({ ...validBody, planned_arrival: '2026-09-18T07:00' });
  assert.equal(r.ok, false);
  assert.match(r.errors.planned_arrival, /晚于/);
});

test('危险货物类别必须在法定目录', () => {
  const r = validateWaybillPayload({ ...validBody, cargo_class: '第99类 不存在' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.cargo_class);
});

test('车牌格式校验', () => {
  assert.equal(validateWaybillPayload({ ...validBody, vehicle_plate: '云A·D3101' }).ok, true);
  assert.equal(validateWaybillPayload({ ...validBody, vehicle_plate: '云AD3101' }).ok, true);
  assert.equal(validateWaybillPayload({ ...validBody, vehicle_plate: 'ABC' }).ok, false);
});

test('datetime-local 按东八区解析', () => {
  const d = parseLocalDateTime('2026-09-18T08:00');
  assert.equal(d.toISOString(), '2026-09-18T00:00:00.000Z');
  assert.equal(parseLocalDateTime('not-a-date'), null);
  assert.equal(parseLocalDateTime(''), null);
});

test('离线补录时间不得明显晚于当前', () => {
  const now = new Date('2026-09-17T12:00:00+08:00');
  assert.equal(validateOccurredAt('2026-09-17T10:00', now).ok, true);
  assert.equal(validateOccurredAt('2026-09-17T12:05', now).ok, true); // 容忍 10 分钟
  assert.equal(validateOccurredAt('2026-09-17T13:00', now).ok, false);
  assert.equal(validateOccurredAt(null, now).ok, true);
});

test('运单号格式：企业前缀+年份+6位顺序号', () => {
  assert.equal(formatWaybillNo('AL', 2026, 1), 'AL2026000001');
  assert.equal(formatWaybillNo('QF', 2026, 123), 'QF2026000123');
  assert.equal(formatWaybillNo('HY', 2027, 999999), 'HY2027999999');
});
