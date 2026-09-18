import bcrypt from 'bcryptjs';
import { allocateWaybillNo } from './waybillNo.js';

/**
 * 演示数据（仅当 enterprises 为空且 SEED_DEMO=true 时注入，幂等）：
 *  - 3 家危货企业（AL 安澜石化 / HY 宏远危化 / QF 青峰燃气）
 *  - 四类账号：监管员、企业管理员、驾驶员、押运员（密码统一 Ayt@123456）
 *  - 覆盖全部状态的运单：填报/企业自审/监管核验(待核验)/已派车/运输中/已完成/异常中止
 *  - 时间相对注入时刻生成：今日应到应离、发车/到达超时红点开箱即见
 */

const DEMO_PASSWORD = 'Ayt@123456';

const H = 3600 * 1000;

export async function seedIfEmpty(pool) {
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM enterprises');
  if (n > 0) {
    console.log('[seed] 已存在数据，跳过演示数据注入');
    return false;
  }

  const now = new Date();
  const at = (h) => new Date(now.getTime() + h * H);
  const sameDay = (d) => d.toDateString() === now.toDateString();
  const laterToday = (h) => { const t = at(h); return sameDay(t) ? t : endOfDay(now); };
  const earlierToday = (h) => { const t = at(-h); return sameDay(t) ? t : startOfDay(now); };
  const dayShift = (days, hh, mm = 0) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(hh, mm, 0, 0);
    return d;
  };
  function endOfDay(base) { const d = new Date(base); d.setHours(23, 40, 0, 0); return d; }
  function startOfDay(base) { const d = new Date(base); d.setHours(0, 20, 0, 0); return d; }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // ---- 企业 ----
    const enterprises = {};
    for (const e of [
      { key: 'AL', name: '安澜石化运输有限公司', license_no: '云交运管许可YL20260001', contact_phone: '0580-88010001' },
      { key: 'HY', name: '宏远危化物流有限公司', license_no: '云交运管许可YL20260002', contact_phone: '0580-88010002' },
      { key: 'QF', name: '青峰燃气运输有限公司', license_no: '云交运管许可YL20260003', contact_phone: '0580-88010003' },
    ]) {
      const [r] = await conn.query(
        'INSERT INTO enterprises (name, code_prefix, license_no, contact_phone) VALUES (?, ?, ?, ?)',
        [e.name, e.key, e.license_no, e.contact_phone],
      );
      enterprises[e.key] = { id: r.insertId, code_prefix: e.key, name: e.name };
    }

    // ---- 账号 ----
    const hash = bcrypt.hashSync(DEMO_PASSWORD, 10);
    const users = {};
    async function addUser(username, name, role, entKey, phone) {
      const [r] = await conn.query(
        'INSERT INTO users (username, password_hash, name, role, enterprise_id, phone) VALUES (?, ?, ?, ?, ?, ?)',
        [username, hash, name, role, entKey ? enterprises[entKey].id : null, phone],
      );
      users[username] = { id: r.insertId, name, role, enterprise_id: entKey ? enterprises[entKey].id : null };
      return users[username];
    }

    await addUser('regulator', '陈监管', 'REGULATOR', null, '0580-12345');

    const staffPlan = {
      AL: { admin: ['al_admin', '李安全'], drivers: [['al_driver1', '张远航'], ['al_driver2', '孙越']], escorts: [['al_escort1', '周同'], ['al_escort2', '吴畏']] },
      HY: { admin: ['hy_admin', '王安全'], drivers: [['hy_driver1', '郑长路'], ['hy_driver2', '冯山']], escorts: [['hy_escort1', '蒋卫'], ['hy_escort2', '沈护']] },
      QF: { admin: ['qf_admin', '赵安全'], drivers: [['qf_driver1', '韩江'], ['qf_driver2', '杨帆']], escorts: [['qf_escort1', '朱守'], ['qf_escort2', '秦安']] },
    };
    let phoneSeq = 100;
    for (const [entKey, plan] of Object.entries(staffPlan)) {
      await addUser(plan.admin[0], plan.admin[1], 'ENTERPRISE_ADMIN', entKey, `1390000${phoneSeq++}`);
      for (const [u, n] of plan.drivers) await addUser(u, n, 'DRIVER', entKey, `1390000${phoneSeq++}`);
      for (const [u, n] of plan.escorts) await addUser(u, n, 'ESCORT', entKey, `1390000${phoneSeq++}`);
    }

    // ---- 运单 ----
    // walkTo: ABORTED 在中止前走到的阶段；actualDeparture/actualArrival 仅运输阶段需要
    const W = [
      // ===== AL 安澜石化 =====
      { ent: 'AL', admin: 'al_admin', driver: 'al_driver1', escort: 'al_escort1', status: 'DRAFT',
        cargo: ['汽油', '第3类 易燃液体', 28.5], route: ['云州市经开区油库', '望海市港区加油站'], plate: '云A·D3101',
        planned: [dayShift(1, 8), dayShift(1, 18)], createdAt: at(-5) },
      { ent: 'AL', admin: 'al_admin', driver: 'al_driver2', escort: 'al_escort2', status: 'ENTERPRISE_REVIEW',
        cargo: ['柴油', '第3类 易燃液体', 30], route: ['云州市经开区油库', '临江市物流园'], plate: '云A·D3102',
        planned: [dayShift(1, 7), dayShift(1, 16)], createdAt: at(-8) },
      { ent: 'AL', admin: 'al_admin', driver: 'al_driver1', escort: 'al_escort2', status: 'REGULATOR_VERIFY',
        cargo: ['甲醇', '第3类 易燃液体', 25], route: ['云州市化工园区', '望海市精细化工厂'], plate: '云A·D3103',
        planned: [laterToday(3), dayShift(1, 8)], createdAt: dayShift(-1, 16) },
      { ent: 'AL', admin: 'al_admin', driver: 'al_driver2', escort: 'al_escort1', status: 'REGULATOR_VERIFY',
        cargo: ['液氨', '第2类 气体', 18], route: ['云州市化工园区', '北川县化肥厂'], plate: '云A·D3105',
        planned: [dayShift(1, 6), dayShift(1, 20)], createdAt: dayShift(-1, 15) },
      { ent: 'AL', admin: 'al_admin', driver: 'al_driver1', escort: 'al_escort1', status: 'DISPATCHED',
        cargo: ['汽油', '第3类 易燃液体', 29], route: ['云州市经开区油库', '临江市中心油站'], plate: '云A·D3106',
        planned: [laterToday(2), laterToday(8)], createdAt: dayShift(-1, 10) },
      { ent: 'AL', admin: 'al_admin', driver: 'al_driver2', escort: 'al_escort2', status: 'DISPATCHED',
        cargo: ['柴油', '第3类 易燃液体', 31], route: ['云州市经开区油库', '北川县矿区'], plate: '云A·D3107',
        planned: [dayShift(-1, 18), dayShift(0, 6)], createdAt: dayShift(-2, 9) }, // 发车超时红点
      { ent: 'AL', admin: 'al_admin', driver: 'al_driver1', escort: 'al_escort1', status: 'IN_TRANSIT',
        cargo: ['乙醇', '第3类 易燃液体', 26], route: ['云州市化工园区', '望海市制药厂'], plate: '云A·D3108',
        planned: [earlierToday(6), laterToday(4)], actualDeparture: earlierToday(5.5), createdAt: dayShift(-2, 14) }, // 今日应到
      { ent: 'AL', admin: 'al_admin', driver: 'al_driver2', escort: 'al_escort2', status: 'IN_TRANSIT',
        cargo: ['甲苯', '第3类 易燃液体', 24], route: ['云州市化工园区', '邻省新材料基地'], plate: '云A·D3109',
        planned: [dayShift(-1, 9), dayShift(-1, 20)], actualDeparture: dayShift(-1, 9, 20), createdAt: dayShift(-3, 11) }, // 到达超时红点
      { ent: 'AL', admin: 'al_admin', driver: 'al_driver1', escort: 'al_escort2', status: 'COMPLETED',
        cargo: ['柴油', '第3类 易燃液体', 30], route: ['望海市港区油库', '云州市经开区油库'], plate: '云A·D3110',
        planned: [dayShift(-1, 7), earlierToday(3)], actualDeparture: dayShift(-1, 7, 10), actualArrival: earlierToday(2.5), createdAt: dayShift(-3, 16) }, // 今日已到
      { ent: 'AL', admin: 'al_admin', driver: 'al_driver2', escort: 'al_escort1', status: 'COMPLETED',
        cargo: ['汽油', '第3类 易燃液体', 27], route: ['云州市经开区油库', '临江市机场油库'], plate: '云A·D3111',
        planned: [dayShift(-3, 8), dayShift(-3, 19)], actualDeparture: dayShift(-3, 8, 5), actualArrival: dayShift(-3, 18, 40), createdAt: dayShift(-4, 10) },
      { ent: 'AL', admin: 'al_admin', driver: 'al_driver1', escort: 'al_escort1', status: 'ABORTED', walkTo: 'IN_TRANSIT',
        cargo: ['液化石油气', '第2类 气体', 20], route: ['云州市燃气储备站', '北川县山区供气点'], plate: '云A·D3112',
        planned: [earlierToday(9), laterToday(3)], actualDeparture: earlierToday(8.5),
        abort: { at: earlierToday(2), by: 'regulator', reason: '山区路段塌方交通管制，车辆安全停靠待命，本次运输异常中止，已启动应急预案' },
        createdAt: dayShift(-2, 15) },

      // ===== HY 宏远危化 =====
      { ent: 'HY', admin: 'hy_admin', driver: 'hy_driver1', escort: 'hy_escort1', status: 'DRAFT',
        cargo: ['硝酸铵（水溶液）', '第5类 氧化性物质', 15], route: ['临江市化工港', '云州市矿业公司'], plate: '云B·H2201',
        planned: [dayShift(2, 8), dayShift(2, 22)], createdAt: at(-3) },
      { ent: 'HY', admin: 'hy_admin', driver: 'hy_driver2', escort: 'hy_escort2', status: 'ENTERPRISE_REVIEW',
        cargo: ['硫酸', '第8类 腐蚀性物质', 22], route: ['临江市硫酸厂', '望海市电镀园'], plate: '云B·H2202',
        planned: [dayShift(1, 9), dayShift(1, 21)], createdAt: at(-6) },
      { ent: 'HY', admin: 'hy_admin', driver: 'hy_driver1', escort: 'hy_escort2', status: 'REGULATOR_VERIFY',
        cargo: ['盐酸', '第8类 腐蚀性物质', 19], route: ['临江市化工港', '云州市污水处理厂'], plate: '云B·H2203',
        planned: [laterToday(5), dayShift(1, 2)], createdAt: dayShift(-1, 14) },
      { ent: 'HY', admin: 'hy_admin', driver: 'hy_driver2', escort: 'hy_escort1', status: 'DISPATCHED',
        cargo: ['氢氧化钠溶液', '第8类 腐蚀性物质', 28], route: ['临江市氯碱厂', '望海市造纸厂'], plate: '云B·H2205',
        planned: [laterToday(4), laterToday(10)], createdAt: dayShift(-1, 9) },
      { ent: 'HY', admin: 'hy_admin', driver: 'hy_driver1', escort: 'hy_escort1', status: 'IN_TRANSIT',
        cargo: ['双氧水', '第5类 氧化性物质', 17], route: ['临江市化工港', '北川县选矿厂'], plate: '云B·H2206',
        planned: [earlierToday(7), laterToday(6)], actualDeparture: earlierToday(6.5), createdAt: dayShift(-2, 10) },
      { ent: 'HY', admin: 'hy_admin', driver: 'hy_driver2', escort: 'hy_escort2', status: 'COMPLETED',
        cargo: ['硫酸', '第8类 腐蚀性物质', 24], route: ['临江市硫酸厂', '云州市化肥厂'], plate: '云B·H2207',
        planned: [dayShift(-1, 8), dayShift(-1, 18)], actualDeparture: dayShift(-1, 8, 15), actualArrival: dayShift(-1, 17, 30), createdAt: dayShift(-3, 9) },

      // ===== QF 青峰燃气 =====
      { ent: 'QF', admin: 'qf_admin', driver: 'qf_driver1', escort: 'qf_escort1', status: 'DRAFT',
        cargo: ['液化天然气', '第2类 气体', 21], route: ['望海市LNG接收站', '云州市城市门站'], plate: '云C·Q3301',
        planned: [dayShift(1, 6), dayShift(1, 14)], createdAt: at(-2) },
      { ent: 'QF', admin: 'qf_admin', driver: 'qf_driver2', escort: 'qf_escort2', status: 'REGULATOR_VERIFY',
        cargo: ['液化石油气', '第2类 气体', 16], route: ['云州市燃气储备站', '临江市液化气站'], plate: '云C·Q3302',
        planned: [laterToday(6), dayShift(1, 1)], createdAt: dayShift(-1, 11) },
      { ent: 'QF', admin: 'qf_admin', driver: 'qf_driver1', escort: 'qf_escort2', status: 'DISPATCHED',
        cargo: ['压缩天然气', '第2类 气体', 12], route: ['云州市CNG母站', '北川县山区供气点'], plate: '云C·Q3303',
        planned: [dayShift(-1, 17), dayShift(-1, 23)], createdAt: dayShift(-2, 16) }, // 发车超时红点
      { ent: 'QF', admin: 'qf_admin', driver: 'qf_driver2', escort: 'qf_escort1', status: 'IN_TRANSIT',
        cargo: ['液化天然气', '第2类 气体', 22], route: ['望海市LNG接收站', '临江市工业园'], plate: '云C·Q3305',
        planned: [earlierToday(8), laterToday(2)], actualDeparture: earlierToday(7.5), createdAt: dayShift(-2, 13) }, // 今日应到
      { ent: 'QF', admin: 'qf_admin', driver: 'qf_driver1', escort: 'qf_escort1', status: 'ABORTED', walkTo: 'DISPATCHED',
        cargo: ['丙烯', '第2类 气体', 14], route: ['云州市石化厂', '望海市聚丙烯厂'], plate: '云C·Q3306',
        planned: [dayShift(-1, 10), dayShift(-1, 22)],
        abort: { at: dayShift(-1, 12), by: 'regulator', reason: '监管抽查发现随车安全告知卡缺失，责令中止运输，整改后重新填报' },
        createdAt: dayShift(-2, 9) },
    ];

    for (const spec of W) {
      await insertSeedWaybill(conn, { ...spec, users, enterprises });
    }

    await conn.commit();
    console.log(`[seed] 演示数据注入完成：3 家企业 / ${Object.keys(users).length} 个账号 / ${W.length} 张运单（统一密码 ${DEMO_PASSWORD}）`);
    return true;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

const RANK = { DRAFT: 0, ENTERPRISE_REVIEW: 1, REGULATOR_VERIFY: 2, DISPATCHED: 3, IN_TRANSIT: 4, COMPLETED: 5 };

async function insertSeedWaybill(conn, spec) {
  const ent = spec.enterprises[spec.ent];
  const admin = spec.users[spec.admin];
  const driver = spec.users[spec.driver];
  const escort = spec.users[spec.escort];
  const regulator = spec.users.regulator;

  const { waybillNo } = await allocateWaybillNo(conn, ent);
  const [cargoName, cargoClass, qty] = spec.cargo;
  const [plannedDep, plannedArr] = spec.planned;

  const [r] = await conn.query(
    `INSERT INTO waybills
      (waybill_no, enterprise_id, status, cargo_name, cargo_class, quantity, unit,
       origin, destination, vehicle_plate, driver_id, escort_id,
       planned_departure, planned_arrival, actual_departure, actual_arrival, abort_reason, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, '吨', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      waybillNo, ent.id, spec.status, cargoName, cargoClass, qty,
      spec.route[0], spec.route[1], spec.plate, driver.id, escort.id,
      plannedDep, plannedArr, spec.actualDeparture || null, spec.actualArrival || null,
      spec.abort ? spec.abort.reason : null, admin.id, spec.createdAt,
    ],
  );
  const waybillId = r.insertId;

  // 事件留痕：按目标状态补齐流转链
  const targetRank = spec.status === 'ABORTED' ? RANK[spec.walkTo] : RANK[spec.status];
  const events = [];
  const t0 = spec.createdAt.getTime();
  const stepAt = (i) => new Date(t0 + (i + 1) * 45 * 60 * 1000);

  events.push({ action: 'create', from: null, to: 'DRAFT', actor: admin, at: spec.createdAt });
  if (targetRank >= 1) events.push({ action: 'submit', from: 'DRAFT', to: 'ENTERPRISE_REVIEW', actor: admin, at: stepAt(0) });
  if (targetRank >= 2) events.push({ action: 'enterprise_approve', from: 'ENTERPRISE_REVIEW', to: 'REGULATOR_VERIFY', actor: admin, at: stepAt(1) });
  if (targetRank >= 3) events.push({ action: 'regulator_approve', from: 'REGULATOR_VERIFY', to: 'DISPATCHED', actor: regulator, at: stepAt(2) });
  if (targetRank >= 4) events.push({ action: 'depart', from: 'DISPATCHED', to: 'IN_TRANSIT', actor: driver, at: spec.actualDeparture });
  if (spec.status === 'COMPLETED') events.push({ action: 'arrive', from: 'IN_TRANSIT', to: 'COMPLETED', actor: driver, at: spec.actualArrival });
  if (spec.status === 'ABORTED') {
    const fromStatus = spec.walkTo;
    events.push({
      action: 'abort', from: fromStatus, to: 'ABORTED',
      actor: spec.abort.by === 'regulator' ? regulator : admin,
      at: spec.abort.at, reason: spec.abort.reason,
    });
  }

  let seq = 0;
  for (const ev of events) {
    seq += 1;
    await conn.query(
      `INSERT INTO waybill_events (waybill_id, seq, action, from_status, to_status, actor_id, actor_name, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [waybillId, seq, ev.action, ev.from, ev.to, ev.actor.id, ev.actor.name, ev.reason || null, ev.at],
    );
  }
}
