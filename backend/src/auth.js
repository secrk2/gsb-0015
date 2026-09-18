import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { pool } from './db.js';

export function signToken(user) {
  return jwt.sign(
    { uid: user.id, role: user.role, eid: user.enterprise_id },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn },
  );
}

/** 认证中间件：校验 JWT，并从库中加载最新用户（禁用即刻生效） */
export async function authRequired(req, res, next) {
  const header = req.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '未登录或登录已过期' } });
  }
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '登录凭证无效或已过期' } });
  }
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.username, u.name, u.role, u.enterprise_id, u.active, e.name AS enterprise_name
       FROM users u LEFT JOIN enterprises e ON e.id = u.enterprise_id
       WHERE u.id = ?`,
      [payload.uid],
    );
    const user = rows[0];
    if (!user || !user.active) {
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '账号不存在或已停用' } });
    }
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/** 角色限制中间件 */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        error: { code: 'FORBIDDEN_ROLE', message: '当前角色无权访问该功能' },
      });
    }
    next();
  };
}
