// 回归：作战台按日统计必须锚定所查日期，且历史日数字不随时间/后续操作漂移
// 复现路径：?date=2026-09-10 查到的必须是 09-10 的数据；数据变化后再查同一天，数字不得变
process.env.DB_NAME = 'anyuntong_test_date';
process.env.REDIS_DB = '13'; // 独占逻辑库，避免测试间/历次运行间的缓存污染
process.env.SEED_DEMO = 'false';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  resetTestDb, bootApp, seedOrg, login, insertWaybill, authHeaders,
} from './helpers.integration.js';

const DB = process.env.DB_NAME;
const DAY = '2026-09-10'; // 固定的历史日：任何时刻运行都已是过去
const TODAY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

let base; let close; let adminToken; let driverToken; let ids; let redis;
const W = {};

before(async () => {
  await resetTestDb(DB);
  ({ base, close, redis } = await bootApp());
  await redis.flushdb(); // 清空本文件独占逻辑库，保证按日统计不被历史缓存污染
  ids = await seedOrg(DB);
  adminToken = await login(base, 't_admin');
  driverToken = await login(base, 't_driver');

  const common = { enterpriseId: ids.enterpriseId, driverId: ids.driverId, escortId: ids.escortId, adminId: ids.adminId };
  // W1 09-10 计划发车，至今未发 → 09-10 发车超时
  W.W1 = await insertWaybill(DB, { ...common, no: 'TT2026000011', status: 'DISPATCHED', plannedDeparture: `${DAY} 08:00:00`, plannedArrival: `${DAY} 20:00:00` });
  // W2 09-10 计划发车，迟到发车 → 09-10 发车超时（实际晚于计划，事实不可变）
  W.W2 = await insertWaybill(DB, { ...common, no: 'TT2026000012', status: 'IN_TRANSIT', plannedDeparture: `${DAY} 09:00:00`, plannedArrival: '2026-09-12 21:00:00', actualDeparture: `${DAY} 10:30:00` });
  // W3 09-10 计划发车，准点发车 → 不算超时
  W.W3 = await insertWaybill(DB, { ...common, no: 'TT2026000013', status: 'IN_TRANSIT', plannedDeparture: `${DAY} 10:00:00`, plannedArrival: '2026-09-12 22:00:00', actualDeparture: `${DAY} 09:55:00` });
  // W4 计划今天 → 绝不允许出现在 09-10 的统计里
  W.W4 = await insertWaybill(DB, { ...common, no: 'TT2026000014', status: 'DISPATCHED', plannedDeparture: `${TODAY} 08:00:00`, plannedArrival: `${TODAY} 20:00:00` });
  // W5 09-10 准点发车但计划到达已过仍未到 → 09-10 到达超时
  W.W5 = await insertWaybill(DB, { ...common, no: 'TT2026000015', status: 'IN_TRANSIT', plannedDeparture: `${DAY} 07:00:00`, plannedArrival: `${DAY} 18:00:00`, actualDeparture: `${DAY} 07:00:00` });
});

after(async () => { await close(); });

async function summaryOn(date) {
  const res = await fetch(`${base}/api/dashboard/summary?date=${date}`, { headers: authHeaders(adminToken) });
  return { status: res.status, body: await res.json() };
}
const idsOf = (list) => new Set(list.map((w) => w.id));

test('按日查询：返回的必须是所查日期的数据', async () => {
  const { status, body } = await summaryOn(DAY);
  assert.equal(status, 200);

  assert.deepEqual(idsOf(body.alerts.timeout_departures), new Set([W.W1, W.W2]),
    '09-10 发车超时 = 未发车的 W1 + 迟到发车的 W2（准点的 W3、今天的 W4 不得混入）');
  assert.deepEqual(idsOf(body.alerts.timeout_arrivals), new Set([W.W5]),
    '09-10 到达超时 = 计划到达已过仍未到的 W5');
  assert.deepEqual(idsOf(body.today_departures), new Set([W.W1, W.W2, W.W3, W.W5]),
    '09-10 应离列表 = 当天计划发车的全部执行阶段运单（不含今天的 W4）');
  assert.deepEqual(idsOf(body.today_arrivals), new Set([W.W5]),
    '09-10 应到列表 = 当天计划到达的在途/已完成运单');

  const lateOf = (id) => body.today_departures.find((w) => w.id === id).late;
  assert.ok(lateOf(W.W1), 'W1 未按时发车应标记超时');
  assert.ok(lateOf(W.W2), 'W2 迟到发车应标记超时');
  assert.ok(!lateOf(W.W3), 'W3 准点发车不得标记超时');
});

test('同一历史日：统计只随真实业务事实变化，不随查询时刻/无关数据漂移', async () => {
  // 司机补启运 W1（实际发车晚于计划 → 仍属超时，数字不变）
  const dep = await fetch(`${base}/api/waybills/${W.W1}/transition`, {
    method: 'POST',
    headers: authHeaders(driverToken, { 'Idempotency-Key': 'date-test-depart-0001' }),
    body: JSON.stringify({ action: 'depart' }),
  });
  assert.equal(dep.status, 200);

  // 中止今天的 W4（应在"今天"的中止统计出现，不得影响 09-10）
  const ab = await fetch(`${base}/api/waybills/${W.W4}/transition`, {
    method: 'POST',
    headers: authHeaders(adminToken, { 'Idempotency-Key': 'date-test-abort-0001' }),
    body: JSON.stringify({ action: 'abort', reason: '回归测试：计划变更' }),
  });
  assert.equal(ab.status, 200);

  const { body } = await summaryOn(DAY);
  assert.deepEqual(idsOf(body.alerts.timeout_departures), new Set([W.W1, W.W2]),
    '关键防漂移：W1 迟到补启运后仍属 09-10 发车超时（旧口径下会从此列表消失）');
  assert.deepEqual(idsOf(body.alerts.timeout_arrivals), new Set([W.W1, W.W5]),
    'W1 补启运后进入在途且计划到达已过 → 如实地计入 09-10 到达超时（真实业务事件，非查询时刻漂移）');
  assert.equal(body.alerts.aborted_today.length, 0, '今天的中止不得计入 09-10');

  const today = await summaryOn(TODAY);
  assert.ok(idsOf(today.body.alerts.aborted_today).has(W.W4), '今天的中止应计入今天');
});

test('未来空日：所有按日列表必须为空（date 参数不得被忽略）', async () => {
  const { status, body } = await summaryOn('2099-01-01');
  assert.equal(status, 200);
  assert.equal(body.today_departures.length, 0);
  assert.equal(body.today_arrivals.length, 0);
  assert.equal(body.alerts.timeout_departures.length, 0);
  assert.equal(body.alerts.timeout_arrivals.length, 0);
  assert.equal(body.alerts.aborted_today.length, 0);
});

test('非法日期参数：明确 400，不得静默按今日返回', async () => {
  const { status, body } = await summaryOn('2026-13-40');
  assert.equal(status, 400);
  assert.equal(body.error.code, 'BAD_DATE');
});
