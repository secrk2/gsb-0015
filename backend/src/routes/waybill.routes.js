import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import { authRequired, requireRole } from '../auth.js';
import {
  checkTransition, allowedActions, isDuplicateOfApplied, TRANSITIONS,
} from '../stateMachine.js';
import { allocateWaybillNo } from '../waybillNo.js';
import { validateWaybillPayload, validateOccurredAt, parseLocalDateTime } from '../validators.js';
import {
  requireIdempotencyKey, replayIfExists, storeIdempotentResult, isDuplicateKeyError,
} from '../idempotency.js';
import { cacheDelPrefix } from '../redis.js';

const router = Router();
router.use(authRequired);

/** 数据隔离：返回当前用户可见范围的 WHERE 片段 */
function scopeClause(user, params) {
  if (user.role === 'REGULATOR') return { sql: '1=1' };
  if (user.role === 'ENTERPRISE_ADMIN') {
    params.push(user.enterprise_id);
    return { sql: 'w.enterprise_id = ?' };
  }
  if (user.role === 'DRIVER') {
    params.push(user.id);
    return { sql: 'w.driver_id = ?' };
  }
  // ESCORT
  params.push(user.id);
  return { sql: 'w.escort_id = ?' };
}

/** 单条运单的越权判定：无权时返回中文错误（前端据此展示错误态而非空白页） */
function assertCanSee(waybill, user) {
  if (user.role === 'REGULATOR') return null;
  if (user.role === 'ENTERPRISE_ADMIN' && waybill.enterprise_id === user.enterprise_id) return null;
  if (user.role === 'DRIVER' && waybill.driver_id === user.id) return null;
  if (user.role === 'ESCORT' && waybill.escort_id === user.id) return null;
  return {
    status: 403,
    error: { code: 'FORBIDDEN_ENTERPRISE', message: '无权查看该运单：不属于本企业/本人，企业间数据已隔离。' },
  };
}

const LIST_SELECT = `
  SELECT w.id, w.waybill_no, w.status, w.cargo_name, w.cargo_class, w.quantity, w.unit,
         w.origin, w.destination, w.vehicle_plate,
         w.planned_departure, w.planned_arrival, w.actual_departure, w.actual_arrival,
         w.created_at, e.name AS enterprise_name, d.name AS driver_name, s.name AS escort_name
  FROM waybills w
  JOIN enterprises e ON e.id = w.enterprise_id
  JOIN users d ON d.id = w.driver_id
  JOIN users s ON s.id = w.escort_id`;

// GET 运单列表（按角色隔离）
router.get('/', async (req, res, next) => {
  try {
    const params = [];
    const where = [scopeClause(req.user, params).sql];

    if (req.query.status) {
      where.push('w.status = ?');
      params.push(String(req.query.status));
    }
    if (req.query.enterprise_id && req.user.role === 'REGULATOR') {
      where.push('w.enterprise_id = ?');
      params.push(Number(req.query.enterprise_id));
    }
    if (req.query.q) {
      where.push('(w.waybill_no LIKE ? OR w.cargo_name LIKE ? OR w.vehicle_plate LIKE ?)');
      const like = `%${String(req.query.q).trim()}%`;
      params.push(like, like, like);
    }

    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(req.query.page_size) || 10));
    const whereSql = where.join(' AND ');

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM waybills w WHERE ${whereSql}`,
      params,
    );
    const [items] = await pool.query(
      `${LIST_SELECT} WHERE ${whereSql} ORDER BY w.id DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize],
    );
    res.json({ items, total, page, page_size: pageSize });
  } catch (err) {
    next(err);
  }
});

// 新建运单（填报）——企业管理员；Idempotency-Key 防重复开单
router.post('/', requireRole('ENTERPRISE_ADMIN'), requireIdempotencyKey, async (req, res, next) => {
  try {
    if (await replayIfExists(req, res)) return;

    const body = req.body || {};
    const check = validateWaybillPayload(body);
    if (!check.ok) {
      return res.status(422).json({
        error: { code: 'VALIDATION_FAILED', message: '填报内容校验未通过', details: check.errors },
      });
    }

    const driverId = Number(body.driver_id);
    const escortId = Number(body.escort_id);
    const [crew] = await pool.query(
      `SELECT id, role, enterprise_id, active FROM users WHERE id IN (?, ?)`,
      [driverId, escortId],
    );
    const driver = crew.find((u) => u.id === driverId);
    const escort = crew.find((u) => u.id === escortId);
    const crewError = (msg) => res.status(422).json({
      error: { code: 'VALIDATION_FAILED', message: msg },
    });
    if (!driver || driver.role !== 'DRIVER' || !driver.active) return crewError('驾驶员不存在、非驾驶员角色或已停用');
    if (!escort || escort.role !== 'ESCORT' || !escort.active) return crewError('押运员不存在、非押运员角色或已停用');
    if (driver.enterprise_id !== req.user.enterprise_id || escort.enterprise_id !== req.user.enterprise_id) {
      return crewError('驾驶员与押运员必须属于本企业');
    }

    const [[enterprise]] = await pool.query(
      'SELECT id, code_prefix FROM enterprises WHERE id = ?',
      [req.user.enterprise_id],
    );
    if (!enterprise) {
      return res.status(400).json({ error: { code: 'NO_ENTERPRISE', message: '当前账号未关联企业' } });
    }

    const created = await withTransaction(async (conn) => {
      const { waybillNo } = await allocateWaybillNo(conn, enterprise);
      const [result] = await conn.query(
        `INSERT INTO waybills
          (waybill_no, enterprise_id, status, cargo_name, cargo_class, quantity, unit,
           origin, destination, vehicle_plate, driver_id, escort_id,
           planned_departure, planned_arrival, remark, idempotency_key, created_by)
         VALUES (?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          waybillNo, enterprise.id,
          String(body.cargo_name).trim(), body.cargo_class, Number(body.quantity),
          String(body.unit || '吨').trim(), String(body.origin).trim(), String(body.destination).trim(),
          String(body.vehicle_plate).trim().toUpperCase(), driverId, escortId,
          parseLocalDateTime(body.planned_departure), parseLocalDateTime(body.planned_arrival),
          body.remark ? String(body.remark).trim() : null, req.idempotencyKey, req.user.id,
        ],
      );
      const waybillId = result.insertId;
      await conn.query(
        `INSERT INTO waybill_events (waybill_id, seq, action, from_status, to_status, actor_id, actor_name, idempotency_key)
         VALUES (?, 1, 'create', NULL, 'DRAFT', ?, ?, ?)`,
        [waybillId, req.user.id, req.user.name, req.idempotencyKey],
      );
      const waybill = await loadDetail(conn, waybillId);
      const responseBody = { waybill, deduplicated: false };
      // 幂等结果与业务写入同一事务落库：重试/双击/离线重放均回放首次结果，不再开新单
      await storeIdempotentResult(conn, req, { waybillId, status: 201, body: responseBody });
      return { waybill, responseBody };
    });

    await cacheDelPrefix('dash:');
    res.status(201).json(created.responseBody);
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      // 并发撞键：首个请求已落库，回放其结果
      if (await replayIfExists(req, res)) return;
    }
    next(err);
  }
});

// 运单详情（含流转留痕与当前可执行动作）
router.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const waybill = await loadDetail(pool, id);
    if (!waybill) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: '运单不存在' } });
    }
    const denied = assertCanSee(waybill, req.user);
    if (denied) return res.status(denied.status).json({ error: denied.error });

    const [events] = await pool.query(
      `SELECT id, seq, action, from_status, to_status, actor_name, reason,
              client_occurred_at, created_at
       FROM waybill_events WHERE waybill_id = ? ORDER BY seq`,
      [id],
    );
    res.json({ waybill, events, allowed_actions: computeAllowedActions(waybill, req.user) });
  } catch (err) {
    next(err);
  }
});

// 状态流转（提交/自审/核验/启运/到达/中止）——状态机统一拦截非法流转
router.post('/:id/transition', requireIdempotencyKey, async (req, res, next) => {
  try {
    if (await replayIfExists(req, res)) return;

    const id = Number(req.params.id);
    const { action, reason } = req.body || {};
    const occurred = validateOccurredAt(req.body?.occurred_at);
    if (!occurred.ok) {
      return res.status(400).json({ error: { code: 'BAD_OCCURRED_AT', message: occurred.message } });
    }

    const outcome = await withTransaction(async (conn) => {
      const [rows] = await conn.query('SELECT * FROM waybills WHERE id = ? FOR UPDATE', [id]);
      const waybill = rows[0];
      if (!waybill) {
        return { httpStatus: 404, body: { error: { code: 'NOT_FOUND', message: '运单不存在' } } };
      }

      const check = checkTransition(waybill, action, req.user, reason);

      // 离线合并幂等：同一执行者的同一动作已生效 → 按成功去重，不产生重复事件
      if (!check.ok && check.error.code === 'ILLEGAL_TRANSITION'
          && isDuplicateOfApplied(waybill, action, req.user)) {
        const [ev] = await conn.query(
          'SELECT id FROM waybill_events WHERE waybill_id = ? AND action = ? AND actor_id = ? LIMIT 1',
          [id, action, req.user.id],
        );
        if (ev.length) {
          const body = {
            waybill: await loadDetail(conn, id),
            deduplicated: true,
            message: '该操作此前已生效（离线重放/重复提交），本次按幂等去重处理，未产生重复记录。',
          };
          await storeIdempotentResult(conn, req, { waybillId: id, status: 200, body });
          return { httpStatus: 200, body };
        }
      }

      if (!check.ok) {
        return { httpStatus: check.status, body: { error: check.error } };
      }

      const to = check.to;
      const sets = ['status = ?'];
      const params = [to];
      if (action === 'depart') {
        sets.push('actual_departure = ?');
        params.push(occurred.value || new Date());
      }
      if (action === 'arrive') {
        sets.push('actual_arrival = ?');
        params.push(occurred.value || new Date());
      }
      if (action === 'abort') {
        sets.push('abort_reason = ?');
        params.push(String(reason).trim());
      }
      params.push(id);
      await conn.query(`UPDATE waybills SET ${sets.join(', ')} WHERE id = ?`, params);

      const [[{ nextSeq }]] = await conn.query(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM waybill_events WHERE waybill_id = ?',
        [id],
      );
      await conn.query(
        `INSERT INTO waybill_events
          (waybill_id, seq, action, from_status, to_status, actor_id, actor_name, reason, idempotency_key, client_occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, nextSeq, action, waybill.status, to, req.user.id, req.user.name,
          reason ? String(reason).trim() : null, req.idempotencyKey, occurred.value,
        ],
      );

      const body = { waybill: await loadDetail(conn, id), deduplicated: false };
      await storeIdempotentResult(conn, req, { waybillId: id, status: 200, body });
      return { httpStatus: 200, body };
    });

    // 作战台缓存键前缀为 dash:（见 dashboard.routes.js），失效前缀必须与之匹配
    if (outcome.httpStatus < 300) await cacheDelPrefix('dash:');
    res.status(outcome.httpStatus).json(outcome.body);
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      if (await replayIfExists(req, res)) return;
    }
    next(err);
  }
});

/** 当前用户在该运单上可执行的动作（服务端权威，前端直接渲染按钮） */
function computeAllowedActions(waybill, user) {
  return allowedActions(waybill.status, user.role)
    .filter((a) => {
      const t = TRANSITIONS[a.action];
      if (t.driverOnly && waybill.driver_id !== user.id) return false;
      if (user.role !== 'REGULATOR' && waybill.enterprise_id !== user.enterprise_id) return false;
      return true;
    });
}

async function loadDetail(connOrPool, id) {
  const [rows] = await connOrPool.query(
    `SELECT w.*, e.name AS enterprise_name, e.code_prefix,
            d.name AS driver_name, d.phone AS driver_phone,
            s.name AS escort_name, s.phone AS escort_phone
     FROM waybills w
     JOIN enterprises e ON e.id = w.enterprise_id
     JOIN users d ON d.id = w.driver_id
     JOIN users s ON s.id = w.escort_id
     WHERE w.id = ?`,
    [id],
  );
  return rows[0] || null;
}

export default router;
