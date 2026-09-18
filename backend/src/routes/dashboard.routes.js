import { Router } from 'express';
import { pool } from '../db.js';
import { authRequired, requireRole } from '../auth.js';
import { cacheGet, cacheSet } from '../redis.js';

const router = Router();
router.use(authRequired, requireRole('REGULATOR', 'ENTERPRISE_ADMIN'));

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 东八区今日（与数据库 default-time-zone=+08:00 一致） */
function todayStr() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * 解析 ?date=YYYY-MM-DD；未传按今日。返回 null 表示格式非法。
 * 统计口径锚定「所查日期」：[day 00:00, day+1 00:00)，超时判定以该日截止时刻
 * （历史日为日终 24:00，今天为当前时刻）为准，历史日数字一经定格不再漂移。
 */
function resolveDay(dateParam) {
  if (dateParam === undefined || dateParam === null || dateParam === '') return todayStr();
  const s = String(dateParam);
  if (!DAY_RE.test(s)) return null;
  const d = new Date(`${s}T00:00:00+08:00`);
  if (Number.isNaN(d.getTime())) return null;
  return s;
}

/**
 * 运单作战台聚合：
 *  - funnel：各企业待派车漏斗（填报→自审→待核验→已派车待发车，实时快照）
 *  - today_departures / today_arrivals：所查日应离 / 应到（含超时标记）
 *  - alerts：所查日异常中止、发车超时、到达超时（红点数据源）
 *  - ?date=YYYY-MM-DD 查看历史/指定日；未传按今日
 */
router.get('/summary', async (req, res, next) => {
  try {
    const scopeEnt = req.user.role === 'REGULATOR' ? null : req.user.enterprise_id;

    const day = resolveDay(req.query.date);
    if (!day) {
      return res.status(400).json({
        error: { code: 'BAD_DATE', message: 'date 参数格式应为 YYYY-MM-DD（如 2026-09-18）' },
      });
    }

    const cacheKey = `dash:${req.user.role}:${scopeEnt || 'all'}:${day}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const scopeSql = scopeEnt ? 'AND w.enterprise_id = ?' : '';
    const p = scopeEnt ? [scopeEnt] : [];
    // 所查日区间 [day, day+1)；超时判定的截止时刻：历史日取日终，今天取当前
    const dayRange = 'w.%COL% >= ? AND w.%COL% < ? + INTERVAL 1 DAY';
    const asOf = 'LEAST(NOW(), ? + INTERVAL 1 DAY)';

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

    // 所查日应离（计划发车在所查日，且已进入可执行阶段）
    // 超时判定锚定不可变事实：实际发车缺失或晚于计划；不以当前状态/查询时刻为转移
    const [todayDepartures] = await pool.query(
      `SELECT w.id, w.waybill_no, w.status, w.planned_departure, w.actual_departure,
              e.name AS enterprise_name,
              ((w.actual_departure IS NULL OR w.actual_departure > w.planned_departure)
                AND w.planned_departure < ${asOf}) AS late
       FROM waybills w JOIN enterprises e ON e.id = w.enterprise_id
       WHERE ${dayRange.replaceAll('%COL%', 'planned_departure')}
         AND w.status IN ('DISPATCHED','IN_TRANSIT','COMPLETED') ${scopeSql}
       ORDER BY w.planned_departure`,
      [day, day, day, ...p],
    );

    // 所查日应到（计划到达在所查日）
    const [todayArrivals] = await pool.query(
      `SELECT w.id, w.waybill_no, w.status, w.planned_arrival, w.actual_arrival,
              e.name AS enterprise_name,
              ((w.actual_arrival IS NULL OR w.actual_arrival > w.planned_arrival)
                AND w.planned_arrival < ${asOf}) AS late
       FROM waybills w JOIN enterprises e ON e.id = w.enterprise_id
       WHERE ${dayRange.replaceAll('%COL%', 'planned_arrival')}
         AND w.status IN ('IN_TRANSIT','COMPLETED') ${scopeSql}
       ORDER BY w.planned_arrival`,
      [day, day, day, ...p],
    );

    // 红点：所查日异常中止
    const [abortedToday] = await pool.query(
      `SELECT w.id, w.waybill_no, e.name AS enterprise_name, ev.reason, ev.created_at
       FROM waybill_events ev
       JOIN waybills w ON w.id = ev.waybill_id
       JOIN enterprises e ON e.id = w.enterprise_id
       WHERE ev.action = 'abort' AND ev.created_at >= ? AND ev.created_at < ? + INTERVAL 1 DAY ${scopeSql}
       ORDER BY ev.created_at DESC`,
      [day, day, ...p],
    );

    // 红点：所查日发车超时（计划发车在所查日，且未按时发车：未发或实发晚于计划）
    const [timeoutDepartures] = await pool.query(
      `SELECT w.id, w.waybill_no, e.name AS enterprise_name, w.planned_departure
       FROM waybills w JOIN enterprises e ON e.id = w.enterprise_id
       WHERE ${dayRange.replaceAll('%COL%', 'planned_departure')}
         AND w.planned_departure < ${asOf}
         AND w.status IN ('DISPATCHED','IN_TRANSIT','COMPLETED')
         AND (w.actual_departure IS NULL OR w.actual_departure > w.planned_departure)
         ${scopeSql}
       ORDER BY w.planned_departure`,
      [day, day, day, ...p],
    );

    // 红点：所查日到达超时（计划到达在所查日，且未按时到达：未到或实到晚于计划）
    const [timeoutArrivals] = await pool.query(
      `SELECT w.id, w.waybill_no, e.name AS enterprise_name, w.planned_arrival
       FROM waybills w JOIN enterprises e ON e.id = w.enterprise_id
       WHERE ${dayRange.replaceAll('%COL%', 'planned_arrival')}
         AND w.planned_arrival < ${asOf}
         AND w.status IN ('IN_TRANSIT','COMPLETED')
         AND (w.actual_arrival IS NULL OR w.actual_arrival > w.planned_arrival)
         ${scopeSql}
       ORDER BY w.planned_arrival`,
      [day, day, day, ...p],
    );

    const payload = {
      generated_at: new Date().toISOString(),
      date: day,
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
