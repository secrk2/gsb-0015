import { Router } from 'express';
import { pool } from '../db.js';
import { authRequired, requireRole } from '../auth.js';
import { cacheGet, cacheSet } from '../redis.js';

const router = Router();
router.use(authRequired, requireRole('REGULATOR', 'ENTERPRISE_ADMIN'));

/**
 * 运单作战台聚合：
 *  - funnel：各企业待派车漏斗（填报→自审→待核验→已派车待发车）
 *  - today_departures / today_arrivals：今日应离 / 应到（含超时标记）
 *  - alerts：今日异常中止、发车超时、到达超时（红点数据源）
 */
router.get('/summary', async (req, res, next) => {
  try {
    const scopeEnt = req.user.role === 'REGULATOR' ? null : req.user.enterprise_id;
    // 支持按日期查询（?date=YYYY-MM-DD），未传按今日
    const cacheKey = `dash:${req.user.role}:${scopeEnt || 'all'}:${req.query.date || 'today'}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const scopeSql = scopeEnt ? 'AND w.enterprise_id = ?' : '';
    const p = scopeEnt ? [scopeEnt] : [];

    // 待派车漏斗（按企业分组；企业用户仅本企业一行）
    const entFilter = scopeEnt ? 'WHERE e.id = ?' : '';
    const [funnel] = await pool.query(
      `SELECT e.id AS enterprise_id, e.name AS enterprise_name,
              COALESCE(SUM(w.status = 'DRAFT'), 0)            AS draft,
              COALESCE(SUM(w.status = 'ENTERPRISE_REVIEW'), 0) AS enterprise_review,
              COALESCE(SUM(w.status = 'REGULATOR_VERIFY'), 0)  AS regulator_verify,
              COALESCE(SUM(w.status = 'DISPATCHED'), 0)        AS dispatched_waiting
       FROM enterprises e
       LEFT JOIN waybills w ON w.enterprise_id = e.id
       ${entFilter}
       GROUP BY e.id, e.name
       ORDER BY e.id`,
      p,
    );

    // 今日应离（计划发车在今天，且已进入可执行阶段）
    const [todayDepartures] = await pool.query(
      `SELECT w.id, w.waybill_no, w.status, w.planned_departure, w.actual_departure,
              e.name AS enterprise_name,
              (w.status = 'DISPATCHED' AND w.planned_departure < NOW()) AS late
       FROM waybills w JOIN enterprises e ON e.id = w.enterprise_id
       WHERE w.planned_departure >= CURDATE() AND w.planned_departure < CURDATE() + INTERVAL 1 DAY
         AND w.status IN ('DISPATCHED','IN_TRANSIT','COMPLETED') ${scopeSql}
       ORDER BY w.planned_departure`,
      p,
    );

    // 今日应到（计划到达在今天）
    const [todayArrivals] = await pool.query(
      `SELECT w.id, w.waybill_no, w.status, w.planned_arrival, w.actual_arrival,
              e.name AS enterprise_name,
              (w.status = 'IN_TRANSIT' AND w.planned_arrival < NOW()) AS late
       FROM waybills w JOIN enterprises e ON e.id = w.enterprise_id
       WHERE w.planned_arrival >= CURDATE() AND w.planned_arrival < CURDATE() + INTERVAL 1 DAY
         AND w.status IN ('IN_TRANSIT','COMPLETED') ${scopeSql}
       ORDER BY w.planned_arrival`,
      p,
    );

    // 红点：今日异常中止
    const [abortedToday] = await pool.query(
      `SELECT w.id, w.waybill_no, e.name AS enterprise_name, ev.reason, ev.created_at
       FROM waybill_events ev
       JOIN waybills w ON w.id = ev.waybill_id
       JOIN enterprises e ON e.id = w.enterprise_id
       WHERE ev.action = 'abort' AND ev.created_at >= CURDATE() ${scopeSql}
       ORDER BY ev.created_at DESC`,
      p,
    );

    // 红点：发车超时（已派车但过了计划发车时间仍未启运）
    const [timeoutDepartures] = await pool.query(
      `SELECT w.id, w.waybill_no, e.name AS enterprise_name, w.planned_departure
       FROM waybills w JOIN enterprises e ON e.id = w.enterprise_id
       WHERE w.status = 'DISPATCHED' AND w.planned_departure < NOW() ${scopeSql}
       ORDER BY w.planned_departure`,
      p,
    );

    // 红点：到达超时（运输中但已过计划到达时间）
    const [timeoutArrivals] = await pool.query(
      `SELECT w.id, w.waybill_no, e.name AS enterprise_name, w.planned_arrival
       FROM waybills w JOIN enterprises e ON e.id = w.enterprise_id
       WHERE w.status = 'IN_TRANSIT' AND w.planned_arrival < NOW() ${scopeSql}
       ORDER BY w.planned_arrival`,
      p,
    );

    const payload = {
      generated_at: new Date().toISOString(),
      scope: req.user.role === 'REGULATOR' ? '全省' : '本企业',
      funnel: funnel.map((f) => ({
        ...f,
        pending_dispatch: Number(f.draft) + Number(f.enterprise_review) + Number(f.regulator_verify),
      })),
      today_departures: todayDepartures,
      today_arrivals: todayArrivals,
      alerts: {
        aborted_today: abortedToday,
        timeout_departures: timeoutDepartures,
        timeout_arrivals: timeoutArrivals,
      },
    };
    await cacheSet(cacheKey, payload, 15);
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

export default router;
