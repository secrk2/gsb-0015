import mysql from 'mysql2/promise';
import { config } from './config.js';

// 时区统一 +08:00：DATETIME 存取均为东八区墙钟时间，与 MySQL 容器 TZ 一致
export const pool = mysql.createPool({
  ...config.db,
  waitForConnections: true,
  connectionLimit: 10,
  timezone: '+08:00',
  dateStrings: false,
  supportBigNumbers: true,
  bigNumberStrings: false,
});

/** 启动期等待数据库就绪（compose 里虽有 healthcheck，本地直跑也需要） */
export async function waitForDb(retries = 30, intervalMs = 1000) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw new Error(`数据库连接失败（重试 ${retries} 次）: ${lastErr?.message}`);
}

/** 在事务中执行 fn(conn)，自动 commit/rollback/release */
export async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try { await conn.rollback(); } catch { /* ignore */ }
    throw err;
  } finally {
    conn.release();
  }
}
