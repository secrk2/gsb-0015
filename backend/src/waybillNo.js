// 运单号：企业前缀 + 年份 + 6 位顺序号，例：AL2026000001
// 顺序号由 waybill_counters 表按 (企业, 年份) 单调分配，作废号码留痕不复用。

export function formatWaybillNo(prefix, year, seq) {
  return `${prefix}${year}${String(seq).padStart(6, '0')}`;
}

/**
 * 在事务内为某企业分配本年度下一个顺序号（行锁保证并发不重号）。
 * @returns {Promise<{waybillNo:string, seq:number, year:number}>}
 */
export async function allocateWaybillNo(conn, enterprise) {
  const year = new Date().getFullYear();
  await conn.query(
    `INSERT INTO waybill_counters (enterprise_id, seq_year, next_seq)
     VALUES (?, ?, 1)
     ON DUPLICATE KEY UPDATE next_seq = next_seq`, // 仅确保行存在
    [enterprise.id, year],
  );
  const [rows] = await conn.query(
    'SELECT next_seq FROM waybill_counters WHERE enterprise_id = ? AND seq_year = ? FOR UPDATE',
    [enterprise.id, year],
  );
  const seq = rows[0].next_seq;
  await conn.query(
    'UPDATE waybill_counters SET next_seq = next_seq + 1 WHERE enterprise_id = ? AND seq_year = ?',
    [enterprise.id, year],
  );
  return { waybillNo: formatWaybillNo(enterprise.code_prefix, year, seq), seq, year };
}
