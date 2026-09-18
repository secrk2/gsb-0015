import { pool } from './db.js';
import { cacheGet, cacheSet } from './redis.js';

/**
 * 幂等保障（防离线重放/双击/重试产生重复运单或重复事件）：
 *  1. 客户端对每次写操作生成唯一 Idempotency-Key；
 *  2. 命中已存结果 → 原样回放（HTTP 200 + Idempotency-Replayed 头）；
 *  3. 未命中 → 在业务事务内写入幂等记录；并发撞键由唯一索引兜底。
 */

export function requireIdempotencyKey(req, res, next) {
  const key = req.get('Idempotency-Key');
  if (!key || key.length < 8 || key.length > 64) {
    return res.status(400).json({
      error: { code: 'IDEMPOTENCY_KEY_REQUIRED', message: '写操作必须携带 Idempotency-Key 请求头（8-64 字符）' },
    });
  }
  req.idempotencyKey = key;
  next();
}

/** 查询已存结果（先 Redis 后 MySQL），命中则回放响应并返回 true */
export async function replayIfExists(req, res) {
  const key = req.idempotencyKey;
  const cached = await cacheGet(`idem:${key}`);
  if (cached) return replay(res, cached);

  const [rows] = await pool.query(
    'SELECT http_status, response_body FROM idempotency_keys WHERE idem_key = ?',
    [key],
  );
  if (!rows.length) return false;
  // MySQL 8 的 JSON 列由驱动自动解析；MariaDB 的 JSON 是 LONGTEXT 别名需手动解析
  const raw = rows[0].response_body;
  const body = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const record = { status: rows[0].http_status, body };
  await cacheSet(`idem:${key}`, record, 7 * 24 * 3600);
  return replay(res, record);
}

function replay(res, record) {
  res.set('Idempotency-Replayed', 'true');
  res.status(record.status).json(record.body);
  return true;
}

/** 在业务事务内保存首次执行结果（与业务写入同生共死） */
export async function storeIdempotentResult(conn, req, { waybillId = null, status, body }) {
  await conn.query(
    `INSERT INTO idempotency_keys (idem_key, user_id, endpoint, waybill_id, http_status, response_body)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [req.idempotencyKey, req.user.id, `${req.method} ${req.baseUrl}${req.path}`, waybillId, status, JSON.stringify(body)],
  );
  await cacheSet(`idem:${req.idempotencyKey}`, { status, body }, 7 * 24 * 3600);
}

export function isDuplicateKeyError(err) {
  return err && err.code === 'ER_DUP_ENTRY';
}
