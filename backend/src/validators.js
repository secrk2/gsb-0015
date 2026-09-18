// 电子运单填报/提交校验 —— 纯函数，便于单测

export const CARGO_CLASSES = [
  '第1类 爆炸品',
  '第2类 气体',
  '第3类 易燃液体',
  '第4类 易燃固体',
  '第5类 氧化性物质',
  '第6类 毒性和感染性物质',
  '第7类 放射性物质',
  '第8类 腐蚀性物质',
  '第9类 杂项危险物质',
];

const REQUIRED = [
  ['cargo_name', '货物名称'],
  ['cargo_class', '危险货物类别'],
  ['origin', '装货地'],
  ['destination', '卸货地'],
  ['vehicle_plate', '承运车辆号牌'],
];

/**
 * 校验填报内容（创建与提交自审时都执行）。
 * crew: { driver_id, escort_id }（已解析为数字）
 * @returns { ok:boolean, errors: Record<string,string> }
 */
export function validateWaybillPayload(body) {
  const errors = {};

  for (const [key, label] of REQUIRED) {
    if (!body[key] || !String(body[key]).trim()) errors[key] = `${label}不能为空`;
  }

  if (body.cargo_class && !CARGO_CLASSES.includes(body.cargo_class)) {
    errors.cargo_class = '危险货物类别不在法定目录内';
  }

  const qty = Number(body.quantity);
  if (!Number.isFinite(qty) || qty <= 0) errors.quantity = '数量必须大于 0';
  if (Number.isFinite(qty) && qty > 99999999) errors.quantity = '数量超出合理范围';

  if (body.unit && String(body.unit).length > 8) errors.unit = '计量单位过长';

  const plate = String(body.vehicle_plate || '').trim();
  if (plate && !/^[一-龥][A-Z][·]?[A-Z0-9]{5,6}$/.test(plate)) {
    errors.vehicle_plate = '车辆号牌格式不正确（如 鲁A12345）';
  }

  const dep = parseLocalDateTime(body.planned_departure);
  const arr = parseLocalDateTime(body.planned_arrival);
  if (!dep) errors.planned_departure = '计划发车时间缺失或格式不正确';
  if (!arr) errors.planned_arrival = '计划到达时间缺失或格式不正确';
  if (dep && arr && arr <= dep) errors.planned_arrival = '计划到达时间必须晚于计划发车时间';

  const driverId = Number(body.driver_id);
  const escortId = Number(body.escort_id);
  if (!Number.isInteger(driverId) || driverId <= 0) errors.driver_id = '必须绑定一名驾驶员';
  if (!Number.isInteger(escortId) || escortId <= 0) errors.escort_id = '必须绑定一名押运员';
  if (driverId > 0 && escortId > 0 && driverId === escortId) {
    errors.escort_id = '驾驶员与押运员不得为同一人';
  }

  if (body.remark && String(body.remark).length > 500) errors.remark = '备注不能超过 500 字';

  return { ok: Object.keys(errors).length === 0, errors };
}

/**
 * 解析前端时间：支持 ISO（含时区）与 datetime-local 的 "YYYY-MM-DDTHH:mm"（按东八区解释）。
 */
export function parseLocalDateTime(input) {
  if (input === null || input === undefined || input === '') return null;
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;
  const s = String(input).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) {
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}+08:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 离线补录的发生时间：不得明显晚于服务端当前时间（容忍 10 分钟时钟漂移） */
export function validateOccurredAt(input, now = new Date()) {
  if (input === null || input === undefined || input === '') return { ok: true, value: null };
  const d = parseLocalDateTime(input);
  if (!d) return { ok: false, message: '发生时间格式不正确' };
  if (d.getTime() > now.getTime() + 10 * 60 * 1000) {
    return { ok: false, message: '发生时间不能晚于当前时间（时钟漂移容忍 10 分钟）' };
  }
  return { ok: true, value: d };
}
