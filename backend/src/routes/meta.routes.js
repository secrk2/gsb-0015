import { Router } from 'express';
import { pool } from '../db.js';
import { authRequired, requireRole } from '../auth.js';
import { STATES, TRANSITIONS, ROLES } from '../stateMachine.js';
import { CARGO_CLASSES } from '../validators.js';

const router = Router();
router.use(authRequired);

// 前端渲染状态徽章与操作按钮所需的全部枚举
router.get('/enums', (req, res) => {
  res.json({
    states: Object.entries(STATES).map(([value, label]) => ({ value, label })),
    roles: ROLES,
    cargoClasses: CARGO_CLASSES,
    transitions: Object.entries(TRANSITIONS).map(([action, t]) => ({
      action,
      label: t.label,
      from: t.from,
      to: t.to,
      roles: t.roles,
      needReason: !!t.needReason,
      driverOnly: !!t.driverOnly,
    })),
  });
});

// 本企业驾驶员/押运员名单（填报时选择）；监管员可按企业查询
router.get('/crew', requireRole('ENTERPRISE_ADMIN', 'REGULATOR'), async (req, res, next) => {
  try {
    let enterpriseId = req.user.enterprise_id;
    if (req.user.role === 'REGULATOR') {
      enterpriseId = Number(req.query.enterprise_id) || null;
      if (!enterpriseId) {
        return res.status(400).json({ error: { code: 'BAD_REQUEST', message: '监管员查询需指定 enterprise_id' } });
      }
    }
    const [rows] = await pool.query(
      `SELECT id, name, role, phone FROM users
       WHERE enterprise_id = ? AND role IN ('DRIVER','ESCORT') AND active = 1
       ORDER BY role, id`,
      [enterpriseId],
    );
    res.json({
      drivers: rows.filter((r) => r.role === 'DRIVER'),
      escorts: rows.filter((r) => r.role === 'ESCORT'),
    });
  } catch (err) {
    next(err);
  }
});

// 企业列表：监管员全量（用于筛选），企业用户仅本企业
router.get('/enterprises', async (req, res, next) => {
  try {
    if (req.user.role === 'REGULATOR') {
      const [rows] = await pool.query('SELECT id, name, code_prefix FROM enterprises ORDER BY id');
      return res.json({ items: rows });
    }
    const [rows] = await pool.query(
      'SELECT id, name, code_prefix FROM enterprises WHERE id = ?',
      [req.user.enterprise_id],
    );
    res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});

export default router;
