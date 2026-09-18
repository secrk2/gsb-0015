// 电子运单状态机 —— 纯函数模块，不依赖数据库，便于单测
//
// 状态（7 个）：
//   DRAFT 填报 → ENTERPRISE_REVIEW 企业自审 → REGULATOR_VERIFY 监管核验
//   → DISPATCHED 已派车 → IN_TRANSIT 运输中 → COMPLETED 已完成
//   异常中止 ABORTED：任一未完结状态可中止（须填原因），终态不可逆
//
// 非法流转（回退、跳级、越角色、越企业）一律拦截并返回中文原因。

export const STATES = {
  DRAFT: '填报',
  ENTERPRISE_REVIEW: '企业自审',
  REGULATOR_VERIFY: '监管核验',
  DISPATCHED: '已派车',
  IN_TRANSIT: '运输中',
  COMPLETED: '已完成',
  ABORTED: '异常中止',
};

export const TERMINAL_STATES = ['COMPLETED', 'ABORTED'];

export const ROLES = {
  ENTERPRISE_ADMIN: '企业管理员',
  DRIVER: '驾驶员',
  ESCORT: '押运员',
  REGULATOR: '监管员',
};

/**
 * 合法流转表。
 * roles: 允许执行的角色；needReason: 必须填写原因；
 * driverOnly: 仅本单绑定驾驶员可执行（启运/到达）。
 */
export const TRANSITIONS = {
  submit: {
    label: '提交自审',
    from: ['DRAFT'],
    to: 'ENTERPRISE_REVIEW',
    roles: ['ENTERPRISE_ADMIN'],
  },
  return_to_draft: {
    label: '退回修改',
    from: ['ENTERPRISE_REVIEW'],
    to: 'DRAFT',
    roles: ['ENTERPRISE_ADMIN'],
    needReason: true,
  },
  enterprise_approve: {
    label: '自审通过',
    from: ['ENTERPRISE_REVIEW'],
    to: 'REGULATOR_VERIFY',
    roles: ['ENTERPRISE_ADMIN'],
  },
  regulator_return: {
    label: '监管退回',
    from: ['REGULATOR_VERIFY'],
    to: 'ENTERPRISE_REVIEW',
    roles: ['REGULATOR'],
    needReason: true,
  },
  regulator_approve: {
    label: '核验通过·派车',
    from: ['REGULATOR_VERIFY'],
    to: 'DISPATCHED',
    roles: ['REGULATOR'],
  },
  depart: {
    label: '启运',
    from: ['DISPATCHED'],
    to: 'IN_TRANSIT',
    roles: ['DRIVER'],
    driverOnly: true,
  },
  arrive: {
    label: '到达签收',
    from: ['IN_TRANSIT'],
    to: 'COMPLETED',
    roles: ['DRIVER'],
    driverOnly: true,
  },
  abort: {
    label: '异常中止',
    from: ['DRAFT', 'ENTERPRISE_REVIEW', 'REGULATOR_VERIFY', 'DISPATCHED', 'IN_TRANSIT'],
    to: 'ABORTED',
    roles: ['ENTERPRISE_ADMIN', 'REGULATOR'],
    needReason: true,
  },
};

const fail = (status, code, message, extra = {}) => ({
  ok: false,
  status,
  error: { code, message, ...extra },
});

/** 当前状态下可执行的合法动作（用于错误提示与前端按钮渲染） */
export function allowedActions(status, role) {
  return Object.entries(TRANSITIONS)
    .filter(([, t]) => t.from.includes(status) && (!role || t.roles.includes(role)))
    .map(([action, t]) => ({ action, label: t.label, to: t.to, needReason: !!t.needReason }));
}

/**
 * 校验一次状态流转。
 * @param waybill 运单行（需含 status / enterprise_id / driver_id）
 * @param action  动作名（TRANSITIONS 的键）
 * @param user    { id, role, enterprise_id }
 * @param reason  原因（needReason 动作必填）
 * @returns { ok:true, to, action } | { ok:false, status, error }
 */
export function checkTransition(waybill, action, user, reason) {
  const t = TRANSITIONS[action];
  if (!t) {
    return fail(400, 'UNKNOWN_ACTION', `未知操作「${action}」。`, {
      allowed: allowedActions(waybill.status, user.role),
    });
  }

  // 终态锁死：已完成/异常中止不允许任何变更
  if (TERMINAL_STATES.includes(waybill.status)) {
    return fail(409, 'ILLEGAL_TRANSITION',
      `运单已处于终态「${STATES[waybill.status]}」，不允许任何状态变更（流程不可回退）。`);
  }

  // 状态合法性（含回退/跳级拦截）
  if (!t.from.includes(waybill.status)) {
    const current = STATES[waybill.status];
    const expect = t.from.map((s) => `「${STATES[s]}」`).join('或');
    const backward = isBackward(waybill.status, t.to);
    const why = backward
      ? '流程不允许逆向回退'
      : '流程不允许跨级跳转';
    return fail(409, 'ILLEGAL_TRANSITION',
      `当前状态为「${current}」，不能执行「${t.label}」：该操作仅适用于${expect}状态的运单，${why}。`,
      { current: waybill.status, attempted: action, allowed: allowedActions(waybill.status, user.role) });
  }

  // 角色合法性
  if (!t.roles.includes(user.role)) {
    return fail(403, 'FORBIDDEN_ROLE',
      `「${ROLES[user.role] || user.role}」无权执行「${t.label}」，该操作仅限${t.roles.map((r) => `「${ROLES[r]}」`).join('、')}执行。`);
  }

  // 企业数据隔离：非监管员只能操作本企业运单
  if (user.role !== 'REGULATOR' && waybill.enterprise_id !== user.enterprise_id) {
    return fail(403, 'FORBIDDEN_ENTERPRISE', '无权操作其他企业的运单（企业数据已隔离）。');
  }

  // 启运/到达仅本单驾驶员可执行
  if (t.driverOnly && waybill.driver_id !== user.id) {
    return fail(403, 'FORBIDDEN_DRIVER', `只有本单绑定的驾驶员才能执行「${t.label}」。`);
  }

  // 原因必填
  if (t.needReason && (!reason || !String(reason).trim())) {
    return fail(400, 'REASON_REQUIRED', `执行「${t.label}」必须填写原因（将写入流转留痕）。`);
  }

  return { ok: true, to: t.to, action: t };
}

/** 主流程上的顺序，用于判断是否为回退 */
const MAIN_FLOW = ['DRAFT', 'ENTERPRISE_REVIEW', 'REGULATOR_VERIFY', 'DISPATCHED', 'IN_TRANSIT', 'COMPLETED'];

function isBackward(from, to) {
  const a = MAIN_FLOW.indexOf(from);
  const b = MAIN_FLOW.indexOf(to);
  return a !== -1 && b !== -1 && b < a;
}

/**
 * 离线合并幂等判定：同一执行者对同一运单的同一动作已生效过，
 * 且当前状态正是该动作的目标态 → 视为重复提交，按成功去重返回（不产生重复事件）。
 */
export function isDuplicateOfApplied(waybill, action, user) {
  const t = TRANSITIONS[action];
  if (!t) return false;
  return waybill.status === t.to;
}
