// 集成测试公共工具：真实 MySQL + Redis + 进程内 Express 应用
// 每个集成测试文件使用独立数据库（DB_NAME 由测试文件在导入本模块前通过环境变量指定）
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';

const ADMIN_DB = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'aytdb123',
};

export const TEST_PASSWORD = 'Test@12345';

/** 重建测试库（drop + create + 载入 db/init/01_schema.sql） */
export async function resetTestDb(dbName) {
  const conn = await mysql.createConnection({ ...ADMIN_DB, multipleStatements: true });
  try {
    await conn.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await conn.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await conn.changeUser({ database: dbName });
    const schema = readFileSync(new URL('../../db/init/01_schema.sql', import.meta.url), 'utf8');
    await conn.query(schema);
  } finally {
    await conn.end();
  }
}

/** 断言用直连（不走应用连接池） */
export async function connectDb(dbName) {
  return mysql.createConnection({ ...ADMIN_DB, database: dbName });
}

/** 进程内启动应用，返回 baseURL 与 close（测试文件用 after(close) 清理） */
export async function bootApp() {
  const [{ app }, { pool }, { redis }] = await Promise.all([
    import('../src/app.js'),
    import('../src/db.js'),
    import('../src/redis.js'),
  ]);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
    redis.disconnect();
  };
  return { base, pool, redis, close };
}

/** 写入最小夹具：1 家企业 + 管理员/驾驶员/押运员账号，返回各 id */
export async function seedOrg(dbName, { prefix = 'TT', name = '测试企业' } = {}) {
  const conn = await connectDb(dbName);
  try {
    const hash = bcrypt.hashSync(TEST_PASSWORD, 10);
    const [ent] = await conn.query(
      'INSERT INTO enterprises (name, code_prefix) VALUES (?, ?)', [name, prefix],
    );
    const enterpriseId = ent.insertId;
    const ids = { enterpriseId };
    for (const [key, username, uname, role] of [
      ['adminId', 't_admin', '测试管理员', 'ENTERPRISE_ADMIN'],
      ['driverId', 't_driver', '测试驾驶员', 'DRIVER'],
      ['escortId', 't_escort', '测试押运员', 'ESCORT'],
      ['regulatorId', 't_regulator', '测试监管员', 'REGULATOR'],
    ]) {
      const [u] = await conn.query(
        'INSERT INTO users (username, password_hash, name, role, enterprise_id) VALUES (?, ?, ?, ?, ?)',
        [username, hash, uname, role, role === 'REGULATOR' ? null : enterpriseId],
      );
      ids[key] = u.insertId;
    }
    return ids;
  } finally {
    await conn.end();
  }
}

/** 登录拿 token（走真实 /api/auth/login） */
export async function login(base, username) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: TEST_PASSWORD }),
  });
  if (!res.ok) throw new Error(`登录失败 ${username}: HTTP ${res.status}`);
  return (await res.json()).token;
}

/** 直接插入一条运单（统计/缓存测试的夹具），返回 waybill id */
export async function insertWaybill(dbName, w) {
  const conn = await connectDb(dbName);
  try {
    const [r] = await conn.query(
      `INSERT INTO waybills
        (waybill_no, enterprise_id, status, cargo_name, cargo_class, quantity, unit,
         origin, destination, vehicle_plate, driver_id, escort_id,
         planned_departure, planned_arrival, actual_departure, actual_arrival, created_by)
       VALUES (?, ?, ?, '测试货物', '第3类 易燃液体', 10, '吨', '起点', '终点', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        w.no, w.enterpriseId, w.status, w.plate || '云A·T0001', w.driverId, w.escortId,
        w.plannedDeparture, w.plannedArrival, w.actualDeparture || null, w.actualArrival || null,
        w.adminId,
      ],
    );
    return r.insertId;
  } finally {
    await conn.end();
  }
}

export function authHeaders(token, extra = {}) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra };
}
