import express from 'express';
import cors from 'cors';
import { pool } from './db.js';
import { redis } from './redis.js';
import authRoutes from './routes/auth.routes.js';
import metaRoutes from './routes/meta.routes.js';
import waybillRoutes from './routes/waybill.routes.js';
import dashboardRoutes from './routes/dashboard.routes.js';

// Express 应用与启动流程分离：index.js 负责 listen，测试可直接挂载 app
export const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// 健康检查（compose healthcheck 与前端离线探测共用）
app.get('/api/health', async (req, res) => {
  let db = 'down';
  let cache = 'down';
  try { await pool.query('SELECT 1'); db = 'up'; } catch { /* ignore */ }
  try { await redis.ping(); cache = 'up'; } catch { /* ignore */ }
  res.status(db === 'up' ? 200 : 503).json({ ok: db === 'up', db, redis: cache, ts: Date.now() });
});

app.use('/api/auth', authRoutes);
app.use('/api/meta', metaRoutes);
app.use('/api/waybills', waybillRoutes);
app.use('/api/dashboard', dashboardRoutes);

app.use('/api', (req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: '接口不存在' } });
});

// 统一错误出口：任何异常都返回结构化错误，绝不让前端拿到空白响应
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ error: { code: 'INTERNAL', message: '服务器内部错误，请稍后重试' } });
});
