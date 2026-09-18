// 展示辅助
export function fmtDT(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtTime(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtClock(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const pad = (n) => String(n).padStart(2, '0');

export const ACTION_LABELS = {
  create: '创建运单',
  submit: '提交自审',
  return_to_draft: '退回修改',
  enterprise_approve: '自审通过',
  regulator_return: '监管退回',
  regulator_approve: '核验通过·派车',
  depart: '启运',
  arrive: '到达签收',
  abort: '异常中止',
};
