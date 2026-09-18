// 回归：同一 Idempotency-Key 重复/并发提交创建运单，服务端必须只开一张单
// 复现路径：弱网双击/重试 → POST /api/waybills 同键到达两次 → 不得产生第二张运单
process.env.DB_NAME = 'anyuntong_test_idem';
process.env.REDIS_DB = '11'; // 独占逻辑库，避免测试间/历次运行间的缓存污染
process.env.SEED_DEMO = 'false';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  resetTestDb, connectDb, bootApp, seedOrg, login, authHeaders,
} from './helpers.integration.js';

const DB = process.env.DB_NAME;
let base; let close; let adminToken; let ids; let db; let redis;

const payload = {
  cargo_name: '汽油', cargo_class: '第3类 易燃液体', quantity: 28.5, unit: '吨',
  origin: '云州市经开区油库', destination: '望海市港区加油站', vehicle_plate: '云A·T9001',
  planned_departure: '2026-09-19T08:00', planned_arrival: '2026-09-19T18:00',
};

before(async () => {
  await resetTestDb(DB);
  ({ base, close, redis } = await bootApp());
  await redis.flushdb(); // 清空本文件独占逻辑库：幂等缓存不得跨用例/跨次运行残留
  ids = await seedOrg(DB);
  adminToken = await login(base, 't_admin');
  db = await connectDb(DB);
});

after(async () => { await db.end(); await close(); });

async function countWaybills() {
  const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM waybills WHERE enterprise_id = ?', [ids.enterpriseId]);
  return Number(n);
}

function postCreate(key) {
  return fetch(`${base}/api/waybills`, {
    method: 'POST',
    headers: authHeaders(adminToken, { 'Idempotency-Key': key }),
    body: JSON.stringify({ ...payload, driver_id: ids.driverId, escort_id: ids.escortId }),
  });
}

test('同一幂等键重试：第二次返回首次结果，不产生重复运单', async () => {
  const key = 'idem-retry-key-0001';
  const r1 = await postCreate(key);
  assert.equal(r1.status, 201);
  const b1 = await r1.json();

  const r2 = await postCreate(key);
  assert.equal(r2.status, 201, '重试应回放首次的 201，而非报错或开新单');
  const b2 = await r2.json();

  assert.equal(r2.headers.get('idempotency-replayed'), 'true', '第二次命中幂等回放标记');
  assert.equal(b2.waybill.id, b1.waybill.id, '两次响应必须是同一张运单');
  assert.equal(b2.waybill.waybill_no, b1.waybill.waybill_no, '单号必须一致');
  assert.equal(await countWaybills(), 1, '数据库中只能有一张运单');

  const [[idemRow]] = await db.query('SELECT idem_key, waybill_id FROM idempotency_keys WHERE idem_key = ?', [key]);
  assert.ok(idemRow, '幂等键必须落库（idempotency_keys），否则重放无从查起');
  assert.equal(idemRow.waybill_id, b1.waybill.id);

  const [[wb]] = await db.query('SELECT idempotency_key FROM waybills WHERE id = ?', [b1.waybill.id]);
  assert.equal(wb.idempotency_key, key, '运单行必须写入幂等键，唯一索引才能兜底并发');
});

test('同一幂等键并发 5 连发：只允许成功创建一张运单', async () => {
  const key = 'idem-race-key-0001';
  const results = await Promise.all(Array.from({ length: 5 }, () => postCreate(key)));
  const bodies = await Promise.all(results.map(async (r) => ({ status: r.status, body: await r.json() })));

  for (const { status, body } of bodies) {
    assert.equal(status, 201, `并发请求都应拿到首次结果（201），实际 ${status}: ${JSON.stringify(body)}`);
  }
  const idsReturned = new Set(bodies.map(({ body }) => body.waybill.id));
  assert.equal(idsReturned.size, 1, '5 个并发请求必须收敛到同一张运单');
  assert.equal(await countWaybills(), 2, '连同上一用例，全库只能有 2 张运单（本次并发只新增 1 张）');
});

test('不同幂等键是两次独立开单（幂等不得误伤正常业务）', async () => {
  const r = await postCreate('idem-distinct-key-0001');
  assert.equal(r.status, 201);
  assert.equal(await countWaybills(), 3);
});
