import { Router } from 'express';
import { pool } from '../db.js';
import { authRequired, requireRole } from '../auth.js';
import { cacheGet, cacheSet } from '../redis.js';

const router = Router();
router.use(authRequired, requireRole('REGULATOR', 'ENTERPRISE_ADMIN'));

/**
 * 运单作战台聚合：
 *  - funnel：各企业待派车漏斗（填报→自审→待核验→已派车待发车）
 *  - today_departures / today_arrivals：所选日应离 / 应到（含超时标记）
 *  - alerts：所选日异常中止、发车超时、到达超时（红点数据源）
 *
 * 三个时间口径（修复"过一天再点同一天数字就变"）：
 *  - dayStart/dayEnd：所选自然日的 00:00 与次日 00:00——只用于"计划/事件落在哪一天"；
 *  - asOf：状态快照截止时刻。实时视角=NOW(3)；历史视角=所选日次日 00:00。
 *    历史视角下运单状态/实际发到时间一律由 waybill_events（不可变）重算，
 *    因此无论哪一天点开同一个日期，数字完全一致。
 *  - NOW(3) 必须毫秒精度：事件 created_at 为 DATETIME(3)，秒精度 NOW() 会
 *    把"同一秒内刚发生"的启运/到达错误排除在截止时刻之外。
 */

// 截止时刻前每个运单的最新状态（事件流即为状态机的唯一真相）
const stateAtSql = (asOf) => `
  SELECT t.waybill_id, t.to_status
  FROM waybill_events t
  JOIN (
    SELECT waybill_id, MAX(seq) AS max_seq
    FROM waybill_events
    WHERE created_at <= ${asOf}
    GROUP BY waybill_id
  ) m ON m.waybill_id = t.waybill_id AND m.max_seq = t.seq
`;

// 截止时刻前的实际发车/到达事件时刻（优先离线端真实发生时间）
const actionEventSql = (action, asOf) => `
  SELECT waybill_id, MAX(COALESCE(client_occurred_at, created_at)) AS occurred_at
  FROM waybill_events
  WHERE action = '${action}' AND COALESCE(client_occurred_at, created_at) <= ${asOf}
  GROUP BY waybill_id
`;

function parseDate(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // 拒绝 02-31 这类被 Date 规整的非法日期
  if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) {
    return null;
  }
  return `${m[1]}-${m[2]}-${m[3]}`;
}

router.get('/summary', async (req, res, next) => {
  try {
    const scopeEnt = req.user.role === 'REGULATOR' ? null : req.user.enterprise_id;

    const date = req.query.date ? parseDate(req.query.date) : null;
    if (req.query.date && !date) {
      return res.status(400).json({
        error: { code: 'BAD_DATE', message: '日期格式不正确，应为 YYYY-MM-DD（如 2026-09-18）' },
      });
    }
    const isHistory = !!date;
    // 计划/事件落日始终按整个自然日；只有状态快照随 asOf 截止
    const dayStart = isHistory ? "STR_TO_DATE(?, '%Y-%m-%d')" : 'CURDATE()';
    const dayEnd = isHistory ? "STR_TO_DATE(?, '%Y-%m-%d') + INTERVAL 1 DAY" : 'CURDATE() + INTERVAL 1 DAY';
    const asOf = isHistory ? dayEnd : 'NOW(3)';
    // 各表达式需要绑定的 date 参数；NOW()/CURDATE() 无参
    const pDayStart = isHistory ? [date] : [];
    const pDayEnd = isHistory ? [date] : [];
    const pAsOf = isHistory ? [date] : [];

    const cacheKey = `dash:${req.user.role}:${scopeEnt || 'all'}:${date || 'today'}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const scopeSql = scopeEnt ? 'AND w.enterprise_id = ?' : '';
    const scopeParams = scopeEnt ? [scopeEnt] : [];

    // 待派车漏斗（按企业分组；企业用户仅本企业一行）——按截止时刻的状态统计
    const [funnel] = await pool.query(
      `WITH state_at AS (${stateAtSql(asOf)})
       SELECT e.id AS enterprise_id, e.name AS enterprise_name,
              COALESCE(SUM(s.to_status = 'DRAFT'), 0)            AS draft,
              COALESCE(SUM(s.to_status = 'ENTERPRISE_REVIEW'), 0) AS enterprise_review,
              COALESCE(SUM(s.to_status = 'REGULATOR_VERIFY'), 0)  AS regulator_verify,
              COALESCE(SUM(s.to_status = 'DISPATCHED'), 0)        AS dispatched_waiting
       FROM enterprises e
       LEFT JOIN waybills w ON w.enterprise_id = e.id
       LEFT JOIN state_at s ON s.waybill_id = w.id
       ${scopeEnt ? 'WHERE e.id = ?' : ''}
       GROUP BY e.id, e.name
       ORDER BY e.id`,
      [...pAsOf, ...scopeParams],
    );

    // 所选日应离：计划发车落在该自然日（整天），状态取截止时刻口径
    const [todayDepartures] = await pool.query(
      `WITH state_at AS (${stateAtSql(asOf)}), dep_ev AS (${actionEventSql('depart', asOf)})
       SELECT w.id, w.waybill_no, s.to_status AS status, w.planned_departure, d.occurred_at AS actual_departure,
              e.name AS enterprise_name,
              (s.to_status = 'DISPATCHED' AND w.planned_departure < ${asOf})
                OR (d.occurred_at IS NOT NULL AND d.occurred_at > w.planned_departure) AS late
       FROM waybills w
       JOIN enterprises e ON e.id = w.enterprise_id
       JOIN state_at s ON s.waybill_id = w.id
       LEFT JOIN dep_ev d ON d.waybill_id = w.id
       WHERE w.planned_departure >= ${dayStart} AND w.planned_departure < ${dayEnd}
         AND s.to_status IN ('DISPATCHED','IN_TRANSIT','COMPLETED') ${scopeSql}
       ORDER BY w.planned_departure`,
      // 顺序：state_at 截止、dep_ev 截止、late 截止、计划窗口起、计划窗口止
      [...pAsOf, ...pAsOf, ...pAsOf, ...pDayStart, ...pDayEnd, ...scopeParams],
    );

    // 所选日应到：计划到达落在该自然日（整天），状态取截止时刻口径
    const [todayArrivals] = await pool.query(
      `WITH state_at AS (${stateAtSql(asOf)}), arr_ev AS (${actionEventSql('arrive', asOf)})
       SELECT w.id, w.waybill_no, s.to_status AS status, w.planned_arrival, a.occurred_at AS actual_arrival,
              e.name AS enterprise_name,
              (s.to_status = 'IN_TRANSIT' AND w.planned_arrival < ${asOf})
                OR (a.occurred_at IS NOT NULL AND a.occurred_at > w.planned_arrival) AS late
       FROM waybills w
       JOIN enterprises e ON e.id = w.enterprise_id
       JOIN state_at s ON s.waybill_id = w.id
       LEFT JOIN arr_ev a ON a.waybill_id = w.id
       WHERE w.planned_arrival >= ${dayStart} AND w.planned_arrival < ${dayEnd}
         AND s.to_status IN ('IN_TRANSIT','COMPLETED') ${scopeSql}
       ORDER BY w.planned_arrival`,
      [...pAsOf, ...pAsOf, ...pAsOf, ...pDayStart, ...pDayEnd, ...scopeParams],
    );

    // 红点：所选日异常中止（按事件真实发生时间落日，整天窗口）
    const [abortedToday] = await pool.query(
      `SELECT w.id, w.waybill_no, e.name AS enterprise_name, ev.reason,
              COALESCE(ev.client_occurred_at, ev.created_at) AS created_at
       FROM waybill_events ev
       JOIN waybills w ON w.id = ev.waybill_id
       JOIN enterprises e ON e.id = w.enterprise_id
       WHERE ev.action = 'abort'
         AND COALESCE(ev.client_occurred_at, ev.created_at) >= ${dayStart}
         AND COALESCE(ev.client_occurred_at, ev.created_at) < ${dayEnd} ${scopeSql}
       ORDER BY created_at DESC`,
      [...pDayStart, ...pDayEnd, ...scopeParams],
    );

    // 红点：截止时刻仍已派车且计划发车时刻已过（历史日=该日终了仍未启运；实时=当前仍未启运）
    const [timeoutDepartures] = await pool.query(
      `WITH state_at AS (${stateAtSql(asOf)})
       SELECT w.id, w.waybill_no, e.name AS enterprise_name, w.planned_departure
       FROM waybills w
       JOIN enterprises e ON e.id = w.enterprise_id
       JOIN state_at s ON s.waybill_id = w.id
       WHERE s.to_status = 'DISPATCHED' AND w.planned_departure < ${asOf} ${scopeSql}
       ORDER BY w.planned_departure`,
      [...pAsOf, ...pAsOf, ...scopeParams],
    );

    // 红点：截止时刻仍运输中且计划到达时刻已过（历史日=该日终了仍未到达；实时=当前仍未到达）
    const [timeoutArrivals] = await pool.query(
      `WITH state_at AS (${stateAtSql(asOf)})
       SELECT w.id, w.waybill_no, e.name AS enterprise_name, w.planned_arrival
       FROM waybills w
       JOIN enterprises e ON e.id = w.enterprise_id
       JOIN state_at s ON s.waybill_id = w.id
       WHERE s.to_status = 'IN_TRANSIT' AND w.planned_arrival < ${asOf} ${scopeSql}
       ORDER BY w.planned_arrival`,
      [...pAsOf, ...pAsOf, ...scopeParams],
    );

    const payload = {
      generated_at: new Date().toISOString(),
      // 历史视角截止于所选日次日 00:00（东八区）；实时视角即当前时刻
      as_of: isHistory
        ? new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)) + 1).toISOString()
        : new Date().toISOString(),
      date: date || null,
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
