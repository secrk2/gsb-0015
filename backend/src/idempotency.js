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

/**
 * 在业务事务内先占位认领幂等键（必须在分配单号/写运单之前执行）：
 * 并发双击时，第二个 INSERT 会被唯一索引挡住并阻塞到首个事务提交，
 * 从根上保证同键只可能有一笔业务写入。
 * 占位记录的响应体为 '{}'，业务执行成功后由 fillIdempotentResult 回填；
 * 业务失败随事务回滚，占位行一并消失，键可重新使用。
 */
export async function claimIdempotencyKey(conn, req) {
  await conn.query(
    `INSERT INTO idempotency_keys (idem_key, user_id, endpoint, waybill_id, http_status, response_body)
     VALUES (?, ?, ?, NULL, 202, JSON_OBJECT())`,
    [req.idempotencyKey, req.user.id, `${req.method} ${req.baseUrl}${req.path}`],
  );
}

/**
 * 在业务事务内回填已占位幂等键的首次执行结果（与业务写入同生共死）。
 * 仅用于创建链路：行已由 claimIdempotencyKey 在本事务内插入，这里原地更新。
 * 只写数据库；缓存必须在事务提交成功后由 rememberIdempotentResult 写入，
 * 否则事务回滚会留下能命中 7 天的幻影结果。
 */
export async function fillIdempotentResult(conn, req, { waybillId = null, status, body }) {
  await conn.query(
    `UPDATE idempotency_keys
        SET waybill_id = ?, http_status = ?, response_body = ?
      WHERE idem_key = ?`,
    [waybillId, status, JSON.stringify(body), req.idempotencyKey],
  );
  return { status, body };
}

/**
 * 在业务事务内保存首次执行结果（与业务写入同生共死），用于状态流转链路。
 * 保持纯 INSERT：并发同键时第二个事务会撞唯一索引抛 ER_DUP_ENTRY，
 * 由路由捕获后回放首次结果，绝不能 UPSERT 覆盖首次响应。
 */
export async function storeIdempotentResult(conn, req, { waybillId = null, status, body }) {
  await conn.query(
    `INSERT INTO idempotency_keys (idem_key, user_id, endpoint, waybill_id, http_status, response_body)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [req.idempotencyKey, req.user.id, `${req.method} ${req.baseUrl}${req.path}`, waybillId, status, JSON.stringify(body)],
  );
  return { status, body };
}

/** 事务提交成功后缓存首次结果（仅允许此时调用） */
export async function rememberIdempotentResult(req, { status, body }) {
  await cacheSet(`idem:${req.idempotencyKey}`, { status, body }, 7 * 24 * 3600);
}

export function isDuplicateKeyError(err) {
  return err && err.code === 'ER_DUP_ENTRY';
}
