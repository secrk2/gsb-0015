// 回归：状态流转后作战台聚合必须立即可见新状态（服务端缓存必须被正确失效）
// 复现路径：GET /api/dashboard/summary（建立 15s 缓存）→ 司机启运 → 立刻再查 → 不得仍是旧状态
process.env.DB_NAME = 'anyuntong_test_cache';
process.env.REDIS_DB = '12'; // 独占逻辑库，避免测试间/历次运行间的缓存污染
process.env.SEED_DEMO = 'false';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  resetTestDb, bootApp, seedOrg, login, insertWaybill, authHeaders,
} from './helpers.integration.js';

const DB = process.env.DB_NAME;
let base; let close; let redis; let adminToken; let driverToken; let ids; let waybillId;

before(async () => {
  await resetTestDb(DB);
  ({ base, close, redis } = await bootApp());
  await redis.flushdb(); // 清空本文件独占逻辑库，保证缓存命中/失效行为可重复
  ids = await seedOrg(DB);
  adminToken = await login(base, 't_admin');
  driverToken = await login(base, 't_driver');
  // 一张已派车、计划今天发车的运单（计划时间取明天，避免影响超时红点）
  waybillId = await insertWaybill(DB, {
    no: 'TT2026000001', enterpriseId: ids.enterpriseId, status: 'DISPATCHED',
    driverId: ids.driverId, escortId: ids.escortId, adminId: ids.adminId,
    plannedDeparture: '2099-01-01 08:00:00', plannedArrival: '2099-01-01 18:00:00',
  });
  const pong = await redis.ping().catch(() => null);
  assert.equal(pong, 'PONG', '本用例验证服务端缓存失效，Redis 必须可用');
});

after(async () => { await close(); });

async function fetchSummary() {
  const res = await fetch(`${base}/api/dashboard/summary`, { headers: authHeaders(adminToken) });
  assert.equal(res.status, 200);
  return res.json();
}

function alFunnel(summary) {
  const f = summary.funnel.find((x) => x.enterprise_id === ids.enterpriseId);
  assert.ok(f, '漏斗中应包含本企业');
  return f;
}

test('启运后作战台立即反映新状态（缓存被失效，而非等 TTL）', async () => {
  // 1) 建立服务端缓存（TTL 15s）
  const before1 = await fetchSummary();
  assert.equal(Number(alFunnel(before1).dispatched_waiting), 1, '启运前应有一单已派车待发车');

  // 2) 司机启运（真实走状态机）
  const dep = await fetch(`${base}/api/waybills/${waybillId}/transition`, {
    method: 'POST',
    headers: authHeaders(driverToken, { 'Idempotency-Key': 'cache-test-depart-0001' }),
    body: JSON.stringify({ action: 'depart' }),
  });
  assert.equal(dep.status, 200);
  assert.equal((await dep.json()).waybill.status, 'IN_TRANSIT');

  // 3) 立刻再查作战台（远小于 15s TTL）：必须看到新状态
  const after1 = await fetchSummary();
  assert.equal(
    Number(alFunnel(after1).dispatched_waiting), 0,
    '启运成功后作战台漏斗必须立即减少已派车待发车数量（读到了过期缓存）',
  );
});
