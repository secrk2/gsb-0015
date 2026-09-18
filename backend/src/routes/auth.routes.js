import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pool } from '../db.js';
import { signToken, authRequired } from '../auth.js';

const router = Router();

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: '用户名和密码不能为空' } });
    }
    const [rows] = await pool.query(
      `SELECT u.*, e.name AS enterprise_name
       FROM users u LEFT JOIN enterprises e ON e.id = u.enterprise_id
       WHERE u.username = ?`,
      [String(username).trim()],
    );
    const user = rows[0];
    if (!user || !user.active || !(await bcrypt.compare(String(password), user.password_hash))) {
      return res.status(401).json({ error: { code: 'BAD_CREDENTIALS', message: '用户名或密码错误' } });
    }
    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.get('/me', authRequired, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    role: u.role,
    enterprise_id: u.enterprise_id,
    enterprise_name: u.enterprise_name || null,
  };
}

export default router;
