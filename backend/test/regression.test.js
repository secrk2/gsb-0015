// 端到端回归（红→绿）：测试自行拉起真实后端（不同端口），打真实 MySQL / Redis / HTTP，
// 不做任何 mock。复现的是一线三个生产事故：
//   1. 弱网双击开出两张单号不同、内容完全一致的运单；
//   2. 司机启运成功，作战台/监管台仍停在"已派车"；
//   3. 作战台选中某一天的超时单，过一天再点同一天，数字变成另一天的。
//
// 运行：npm test（需 127.0.0.1:3306 MySQL 与 :6379 Redis，见 README「本地开发」）
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import mysql from 'mysql2/promise';
import Redis from 'ioredis';

const PORT = process.env.TEST_PORT || '7103';
const BASE = `http://127.0.0.1:${PORT}/api`;

const dbConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'aytdb123',
  database: process.env.DB_NAME || 'anyuntong',
  timezone: '+08:00',
  dateStrings: true,
};

const sql = await mysql.createConnection(dbConfig);
const redis = new Redis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: 2,
});

let server;

before(async () => {
  await redis.flushdb();
  server = spawn(process.execPath, ['src/index.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      PORT,
      SEED_DEMO: 'false',
      DB_HOST: dbConfig.host,
      DB_PORT: String(dbConfig.port),
      DB_USER: dbConfig.user,
      DB_PASSWORD: dbConfig.password,
      DB_NAME: dbConfig.database,
      REDIS_HOST: process.env.REDIS_HOST || '127.0.0.1',
      REDIS_PORT: process.env.REDIS_PORT || '6379',
      TZ: 'Asia/Shanghai',
    },
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) break;
    } catch { /* 尚未就绪 */ }
    if (Date.now() > deadline) throw new Error('测试用后端 15s 内未启动');
    await new Promise((r) => setTimeout(r, 200));
  }
});

after(async () => {
  server?.kill('SIGTERM');
  await sql.end();
  redis.disconnect();
});

async function login(username, password = 'Ayt@123456') {
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(r.status, 200, `${username} 登录失败`);
  return (await r.json()).token;
}

const authGet = (token, path) => fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });

async function cleanupWaybills(ids) {
  if (!ids.length) return;
  const ph = ids.map(() => '?').join(',');
  await sql.query(`DELETE FROM waybill_events WHERE waybill_id IN (${ph})`, ids);
  await sql.query(`DELETE FROM idempotency_keys WHERE waybill_id IN (${ph})`, ids);
  await sql.query(`DELETE FROM waybills WHERE id IN (${ph})`, ids);
}

const runId = `${Date.now()}${Math.floor(Math.random() * 1e4)}`;
const pad = (n) => String(n).padStart(2, '0');
const localISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

// ---------------------------------------------------------------------------
// 事故 1：弱网点双击 → 两张单号不同、内容完全一致的运单
// ---------------------------------------------------------------------------
describe('双击开单幂等', () => {
  test('同一 Idempotency-Key 并发双击只开出一张单，第二次回放首次结果', async () => {
    const token = await login('al_admin');
    const crew = await (await authGet(token, '/meta/crew')).json();
    const driver = crew.drivers[0];
    const escort = crew.escorts.find((s) => s.id !== driver.id);

    const tomorrow = new Date(Date.now() + 26 * 3600 * 1000);
    const dayAfter = new Date(Date.now() + 50 * 3600 * 1000);
    const plate = `云A·T${String(runId).slice(-5)}`;
    const payload = {
      cargo_name: '双击复测汽油', cargo_class: '第3类 易燃液体', quantity: 28.5, unit: '吨',
      origin: '云州市经开区油库', destination: '望海市港区加油站', vehicle_plate: plate,
      driver_id: driver.id, escort_id: escort.id,
      planned_departure: localISO(tomorrow), planned_arrival: localISO(dayAfter),
    };
    const idemKey = `dblclick-e2e-${runId}`;

    const createdIds = [];
    try {
      // 模拟司机手快点两下：两个请求完全同时发出，用同一个幂等键
      const [r1, r2] = await Promise.all([1, 2].map(() => fetch(`${BASE}/waybills`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': idemKey,
        },
        body: JSON.stringify(payload),
      })));

      const [b1, b2] = await Promise.all([r1.json(), r2.json()]);
      // 并发下两个都应是 201、同一张单；恰有一个是"首次执行"，另一个回放首次结果
      assert.equal(r1.status, 201, `首单应 201，实际 ${r1.status}`);
      assert.equal(r2.status, 201, `双击第二单必须回放首次的 201，实际 ${r2.status}: ${JSON.stringify(b2)}`);
      const replays = [r1, r2].filter((r) => r.headers.get('idempotency-replayed') === 'true').length;
      assert.equal(replays, 1, `并发双击恰有一个请求回放首次结果，实际 ${replays} 个带回放头`);
      assert.ok(b1.waybill && b2.waybill, '两次响应都应是运单体');
      assert.equal(b2.waybill.id, b1.waybill.id, '双击不得生成两张运单（单号必须相同）');
      assert.equal(b2.waybill.waybill_no, b1.waybill.waybill_no);
      createdIds.push(b1.waybill.id);

      // 弱网重试（顺序、稍晚）同样回放，不开新单
      const r3 = await fetch(`${BASE}/waybills`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': idemKey,
        },
        body: JSON.stringify(payload),
      });
      const b3 = await r3.json();
      assert.equal(r3.status, 201);
      assert.equal(r3.headers.get('idempotency-replayed'), 'true');
      assert.equal(b3.waybill.id, b1.waybill.id);

      // 库里只有一张：企业、车辆、货物、路线一致，且 idempotency_key 真实落库
      const [rows] = await sql.query(
        'SELECT id, waybill_no, idempotency_key FROM waybills WHERE vehicle_plate = ?',
        [plate],
      );
      assert.equal(rows.length, 1, `同车牌只应有 1 张运单，实际 ${rows.length}`);
      assert.equal(rows[0].id, b1.waybill.id);
      assert.equal(rows[0].idempotency_key, idemKey);

      const [keys] = await sql.query(
        'SELECT http_status, waybill_id FROM idempotency_keys WHERE idem_key = ?',
        [idemKey],
      );
      assert.equal(keys.length, 1);
      assert.equal(keys[0].http_status, 201);
      assert.equal(Number(keys[0].waybill_id), b1.waybill.id);
    } finally {
      // 兜底：若故障仍在，双击会造出两张，两张都清掉
      const [extra] = await sql.query('SELECT id FROM waybills WHERE vehicle_plate = ?', [plate]);
      createdIds.push(...extra.map((x) => x.id));
      await cleanupWaybills([...new Set(createdIds)]);
      await sql.query('DELETE FROM idempotency_keys WHERE idem_key = ?', [idemKey]);
    }
  });
});

// ---------------------------------------------------------------------------
// 事故 2：司机点「启运」手机显示成功，作战台/监管台却还停在「已派车」
// ---------------------------------------------------------------------------
describe('启运后作战台即时一致', () => {
  test('启运提交成功后，作战台立即反映为运输中（不命中旧缓存）', async () => {
    const regToken = await login('regulator');
    const driverToken = await login('al_driver1');

    const [[ent]] = await sql.query(
      `SELECT u.enterprise_id FROM users u WHERE u.username = 'al_driver1'`,
    );
    const [[driver]] = await sql.query(`SELECT id FROM users WHERE username = 'al_driver1'`);
    const [[escort]] = await sql.query(
      `SELECT id FROM users WHERE role = 'ESCORT' AND enterprise_id = ? AND id <> ? LIMIT 1`,
      [ent.enterprise_id, driver.id],
    );
    const [[admin]] = await sql.query(
      `SELECT id FROM users WHERE role = 'ENTERPRISE_ADMIN' AND enterprise_id = ? LIMIT 1`,
      [ent.enterprise_id],
    );

    const depAt = new Date(Date.now() + 2 * 3600 * 1000); // 计划两小时后发车
    const arrAt = new Date(Date.now() + 10 * 3600 * 1000);
    const plate = `云A·E${String(runId).slice(-5)}`;
    const [wres] = await sql.query(
      `INSERT INTO waybills
        (waybill_no, enterprise_id, status, cargo_name, cargo_class, quantity, unit,
         origin, destination, vehicle_plate, driver_id, escort_id,
         planned_departure, planned_arrival, created_by)
       VALUES (?, ?, 'DISPATCHED', '柴油', '第3类 易燃液体', 20, '吨',
               'A库', 'B站', ?, ?, ?, ?, ?, ?)`,
      [`TE8${String(runId).slice(-7)}`, ent.enterprise_id, plate, driver.id, escort.id, depAt, arrAt, admin.id],
    );
    const wid = wres.insertId;
    // 截到秒并回退 1 秒：避开 JS 毫秒时间戳与 SQL NOW() 当秒 .000 的边界，
    // 保证这些"历史事件"在接下来的实时口径 created_at <= NOW() 中可见
    const now = new Date(Math.floor(Date.now() / 1000) * 1000 - 1000);
    const events = [
      [1, 'create', null, 'DRAFT', now],
      [2, 'submit', 'DRAFT', 'ENTERPRISE_REVIEW', now],
      [3, 'enterprise_approve', 'ENTERPRISE_REVIEW', 'REGULATOR_VERIFY', now],
      [4, 'regulator_approve', 'REGULATOR_VERIFY', 'DISPATCHED', now],
    ];
    for (const [seq, action, from, to, at] of events) {
      // eslint-disable-next-line no-await-in-loop
      await sql.query(
        `INSERT INTO waybill_events (waybill_id, seq, action, from_status, to_status, actor_id, actor_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, '测试', ?)`,
        [wid, seq, action, from, to, admin.id, at],
      );
    }

    try {
      const funnelDispatched = async () => {
        const s = await (await authGet(regToken, '/dashboard/summary')).json();
        const row = s.funnel.find((f) => f.enterprise_id === ent.enterprise_id);
        return Number(row.dispatched_waiting);
      };

      // 先查一次，把作战台聚合缓存建立起来（此时测试单是"已派车待发车"）
      const before = await funnelDispatched();

      const rr = await fetch(`${BASE}/waybills/${wid}/transition`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${driverToken}`,
          'Idempotency-Key': `depart-fresh-${runId}`,
        },
        body: JSON.stringify({ action: 'depart' }),
      });
      const rb = await rr.json();
      assert.equal(rr.status, 200, `启运应成功，实际 ${rr.status}: ${JSON.stringify(rb)}`);
      assert.equal(rb.waybill.status, 'IN_TRANSIT');

      // 关键断言：不等待、不刷新重试，作战台下一个请求必须已是启运后的口径
      const after = await funnelDispatched();
      assert.equal(after, before - 1,
        `启运后作战台"已派车待发车"应立即 -1（${before} → ${before - 1}），实际为 ${after}（命中了 15s 旧缓存）`);

      // 今日应离列表里该单状态也应是运输中
      const s2 = await (await authGet(regToken, '/dashboard/summary')).json();
      const card = s2.today_departures.find((w) => w.id === wid);
      // 计划发车在两小时后，可能不在"今日应离"，故只在出现时校验
      if (card) assert.equal(card.status, 'IN_TRANSIT');
    } finally {
      await cleanupWaybills([wid]);
      await sql.query('DELETE FROM idempotency_keys WHERE idem_key = ?', [`depart-fresh-${runId}`]);
    }
  });
});

// ---------------------------------------------------------------------------
// 事故 3：作战台选中某一天的超时单，过一天再点同一天，数字变成另一天的
// ---------------------------------------------------------------------------
describe('作战台按日统计可复现', () => {
  test('同一历史日期无论哪天查询，超时/应到应离数字与单号完全一致', async () => {
    const token = await login('regulator');
    const [[alEnt]] = await sql.query(`SELECT id FROM enterprises WHERE code_prefix = 'AL'`);
    const [[driver]] = await sql.query(`SELECT id FROM users WHERE username = 'al_driver1'`);
    const [[escort]] = await sql.query(
      `SELECT id FROM users WHERE role = 'ESCORT' AND enterprise_id = ? AND id <> ? LIMIT 1`,
      [alEnt.id, driver.id],
    );
    const [[admin]] = await sql.query(
      `SELECT id FROM users WHERE role = 'ENTERPRISE_ADMIN' AND enterprise_id = ? LIMIT 1`,
      [alEnt.id],
    );

    const created = [];
    // WD：9/10 08:00 应发车，直到查询口径终了都没启运（发车超时）
    // WA：9/10 06:00 启运、计划当天 16:00 到达，直到查询口径终了都没签收（到达超时；且发车本身晚点 20 分钟）
    const insertCase = async (no, status, plate, depPlan, arrPlan, events) => {
      const [result] = await sql.query(
        `INSERT INTO waybills
          (waybill_no, enterprise_id, status, cargo_name, cargo_class, quantity, unit,
           origin, destination, vehicle_plate, driver_id, escort_id,
           planned_departure, planned_arrival, created_by)
         VALUES (?, ?, ?, '汽油', '第3类 易燃液体', 20, '吨', 'A库', 'B站', ?, ?, ?, ?, ?, ?)`,
        [no, alEnt.id, status, plate, driver.id, escort.id, depPlan, arrPlan, admin.id],
      );
      const id = result.insertId;
      for (const [seq, action, from, to, at, actor = admin.id] of events) {
        // eslint-disable-next-line no-await-in-loop
        await sql.query(
          `INSERT INTO waybill_events (waybill_id, seq, action, from_status, to_status, actor_id, actor_name, created_at)
           VALUES (?, ?, ?, ?, ?, ?, '测试', ?)`,
          [id, seq, action, from, to, actor, at],
        );
      }
      created.push(id);
      return id;
    };

    const d9 = '2026-09-09';
    const d10 = '2026-09-10';
    const wd = await insertCase(
      `TD${String(runId).slice(-8)}`, 'DISPATCHED', `云A·D${String(runId).slice(-5)}`,
      `${d10} 08:00:00`, `${d10} 18:00:00`,
      [
        [1, 'create', null, 'DRAFT', `${d9} 09:00:00`],
        [2, 'submit', 'DRAFT', 'ENTERPRISE_REVIEW', `${d9} 10:00:00`],
        [3, 'enterprise_approve', 'ENTERPRISE_REVIEW', 'REGULATOR_VERIFY', `${d9} 11:00:00`],
        [4, 'regulator_approve', 'REGULATOR_VERIFY', 'DISPATCHED', `${d9} 12:00:00`],
      ],
    );
    const wa = await insertCase(
      `TA${String(runId).slice(-8)}`, 'IN_TRANSIT', `云A·A${String(runId).slice(-5)}`,
      `${d10} 06:00:00`, `${d10} 16:00:00`,
      [
        [1, 'create', null, 'DRAFT', `${d9} 09:00:00`],
        [2, 'submit', 'DRAFT', 'ENTERPRISE_REVIEW', `${d9} 10:00:00`],
        [3, 'enterprise_approve', 'ENTERPRISE_REVIEW', 'REGULATOR_VERIFY', `${d9} 11:00:00`],
        [4, 'regulator_approve', 'REGULATOR_VERIFY', 'DISPATCHED', `${d9} 12:00:00`],
        [5, 'depart', 'DISPATCHED', 'IN_TRANSIT', `${d10} 06:20:00`, driver.id],
      ],
    );

    const summary = async (date) => (await authGet(token, `/dashboard/summary?date=${date}`)).json();
    const idsOf = (list) => list.map((x) => x.id).filter((id) => created.includes(id));

    try {
      // 非法日期 400
      const bad = await authGet(token, '/dashboard/summary?date=2026-9-10');
      assert.equal(bad.status, 400);

      // 9/10 当天：两张都在计划列表里，且都超时
      const day10a = await summary('2026-09-10');
      assert.ok(idsOf(day10a.today_departures).includes(wd), '9/10 应离列表必须包含 ALT9991（按所选日而非今天过滤）');
      assert.ok(idsOf(day10a.today_arrivals).includes(wa), '9/10 应到列表必须包含 ALT9992');
      assert.ok(idsOf(day10a.alerts.timeout_departures).includes(wd), '9/10 发车超时必须包含 ALT9991');
      assert.ok(idsOf(day10a.alerts.timeout_arrivals).includes(wa), '9/10 到达超时必须包含 ALT9992');
      const depCard = day10a.today_departures.find((w) => w.id === wa);
      assert.equal(depCard.late, 1, 'ALT9992 实际 06:20 发车晚于计划 06:00，应标 late');

      // 9/9（前一天终了口径）：计划在 9/10，尚未超时
      const day9 = await summary('2026-09-09');
      assert.ok(!idsOf(day9.today_departures).includes(wd), '9/9 应离列表不得包含 9/10 计划发车的 ALT9991');
      assert.ok(!idsOf(day9.alerts.timeout_departures).includes(wd),
        '9/9 终了 ALT9991 计划时刻未到，不得算发车超时（旧实现按"当前状态"统计会误报）');
      assert.ok(!idsOf(day9.alerts.timeout_arrivals).includes(wa));

      // 9/11：两张仍超时，且应离/应到列表不再包含（计划日是 9/10）
      const day11 = await summary('2026-09-11');
      assert.ok(idsOf(day11.alerts.timeout_departures).includes(wd));
      assert.ok(idsOf(day11.alerts.timeout_arrivals).includes(wa));
      assert.ok(!idsOf(day11.today_departures).includes(wd));
      assert.ok(!idsOf(day11.today_arrivals).includes(wa));

      // 复现性：9/10 再查两次（模拟"过一天再点同一天"），结果必须逐单一致
      const strip = (s) => ({
        dep: idsOf(s.today_departures), arr: idsOf(s.today_arrivals),
        td: idsOf(s.alerts.timeout_departures), ta: idsOf(s.alerts.timeout_arrivals),
        ab: idsOf(s.alerts.aborted_today),
        funnel: s.funnel.map((f) => [f.enterprise_id, Number(f.pending_dispatch), Number(f.dispatched_waiting)]),
      });
      const expect = strip(day10a);
      for (const _ of [1, 2]) {
        // eslint-disable-next-line no-await-in-loop
        assert.deepEqual(strip(await summary('2026-09-10')), expect,
          '同一日期重复查询结果必须完全一致（旧实现随查询当天的 CURDATE()/NOW() 漂移）');
      }
    } finally {
      await cleanupWaybills(created);
    }
  });
});
