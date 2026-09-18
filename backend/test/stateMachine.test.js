import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkTransition, allowedActions, isDuplicateOfApplied, STATES,
} from '../src/stateMachine.js';

const admin = { id: 10, role: 'ENTERPRISE_ADMIN', enterprise_id: 1 };
const otherAdmin = { id: 11, role: 'ENTERPRISE_ADMIN', enterprise_id: 2 };
const regulator = { id: 1, role: 'REGULATOR', enterprise_id: null };
const driver = { id: 20, role: 'DRIVER', enterprise_id: 1 };
const otherDriver = { id: 21, role: 'DRIVER', enterprise_id: 1 };
const escort = { id: 30, role: 'ESCORT', enterprise_id: 1 };

const wb = (status, extra = {}) => ({
  id: 100, status, enterprise_id: 1, driver_id: 20, escort_id: 30, ...extra,
});

test('主流程全链路可走通：填报→自审→核验→派车→运输→完成', () => {
  const chain = [
    ['DRAFT', 'submit', admin, 'ENTERPRISE_REVIEW'],
    ['ENTERPRISE_REVIEW', 'enterprise_approve', admin, 'REGULATOR_VERIFY'],
    ['REGULATOR_VERIFY', 'regulator_approve', regulator, 'DISPATCHED'],
    ['DISPATCHED', 'depart', driver, 'IN_TRANSIT'],
    ['IN_TRANSIT', 'arrive', driver, 'COMPLETED'],
  ];
  for (const [from, action, user, expectTo] of chain) {
    const r = checkTransition(wb(from), action, user);
    assert.equal(r.ok, true, `${action} 应允许: ${r.error?.message}`);
    assert.equal(r.to, expectTo);
  }
});

test('非法回退被拦截并说明原因（运输中→已派车）', () => {
  const r = checkTransition(wb('IN_TRANSIT'), 'depart', driver);
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.equal(r.error.code, 'ILLEGAL_TRANSITION');
  assert.match(r.error.message, /运输中/);
  assert.match(r.error.message, /已派车/);
});

test('跨级跳转被拦截（填报→核验通过）', () => {
  const r = checkTransition(wb('DRAFT'), 'regulator_approve', regulator);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'ILLEGAL_TRANSITION');
  assert.match(r.error.message, /填报/);
});

test('终态锁死：已完成/异常中止不允许任何变更', () => {
  for (const s of ['COMPLETED', 'ABORTED']) {
    const r = checkTransition(wb(s), 'abort', regulator, '原因');
    assert.equal(r.ok, false);
    assert.equal(r.status, 409);
    assert.match(r.error.message, /终态/);
  }
});

test('角色越权被拦截：企业管理员不能核验，驾驶员不能自审', () => {
  const r1 = checkTransition(wb('REGULATOR_VERIFY'), 'regulator_approve', admin);
  assert.equal(r1.ok, false);
  assert.equal(r1.status, 403);
  assert.equal(r1.error.code, 'FORBIDDEN_ROLE');

  const r2 = checkTransition(wb('ENTERPRISE_REVIEW'), 'enterprise_approve', driver);
  assert.equal(r2.ok, false);
  assert.equal(r2.error.code, 'FORBIDDEN_ROLE');

  const r3 = checkTransition(wb('DISPATCHED'), 'depart', escort);
  assert.equal(r3.ok, false);
  assert.equal(r3.error.code, 'FORBIDDEN_ROLE');
});

test('企业数据隔离：不能操作其他企业的运单', () => {
  const r = checkTransition(wb('DRAFT'), 'submit', otherAdmin);
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.equal(r.error.code, 'FORBIDDEN_ENTERPRISE');
  assert.match(r.error.message, /其他企业/);
});

test('启运/到达仅限本单绑定驾驶员', () => {
  const r = checkTransition(wb('DISPATCHED'), 'depart', otherDriver);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'FORBIDDEN_DRIVER');
});

test('退回/中止必须填写原因', () => {
  const r1 = checkTransition(wb('ENTERPRISE_REVIEW'), 'return_to_draft', admin, '');
  assert.equal(r1.ok, false);
  assert.equal(r1.error.code, 'REASON_REQUIRED');

  const r2 = checkTransition(wb('IN_TRANSIT'), 'abort', regulator, null);
  assert.equal(r2.ok, false);
  assert.equal(r2.error.code, 'REASON_REQUIRED');

  const r3 = checkTransition(wb('IN_TRANSIT'), 'abort', regulator, '山体滑坡道路中断');
  assert.equal(r3.ok, true);
});

test('合法回退路径：自审退回修改、监管退回自审', () => {
  const r1 = checkTransition(wb('ENTERPRISE_REVIEW'), 'return_to_draft', admin, '货物信息有误');
  assert.equal(r1.ok, true);
  assert.equal(r1.to, 'DRAFT');

  const r2 = checkTransition(wb('REGULATOR_VERIFY'), 'regulator_return', regulator, '证件不全');
  assert.equal(r2.ok, true);
  assert.equal(r2.to, 'ENTERPRISE_REVIEW');
});

test('未知动作被拦截', () => {
  const r = checkTransition(wb('DRAFT'), 'fly_to_moon', admin);
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.error.code, 'UNKNOWN_ACTION');
});

test('离线幂等判定：动作已生效且当前状态为目标态 → 视为重复提交', () => {
  assert.equal(isDuplicateOfApplied(wb('IN_TRANSIT'), 'depart', driver), true);
  assert.equal(isDuplicateOfApplied(wb('COMPLETED'), 'arrive', driver), true);
  assert.equal(isDuplicateOfApplied(wb('DISPATCHED'), 'depart', driver), false);
  assert.equal(isDuplicateOfApplied(wb('IN_TRANSIT'), 'arrive', driver), false);
});

test('allowedActions：按状态与角色给出合法动作', () => {
  const draftAdmin = allowedActions('DRAFT', 'ENTERPRISE_ADMIN').map((a) => a.action);
  assert.deepEqual(draftAdmin.sort(), ['abort', 'submit']);

  const dispatchedDriver = allowedActions('DISPATCHED', 'DRIVER').map((a) => a.action);
  assert.deepEqual(dispatchedDriver, ['depart']);

  const completedAny = allowedActions('COMPLETED', 'REGULATOR');
  assert.deepEqual(completedAny, []);

  // 每个状态标签都应有中文名
  for (const s of Object.keys(STATES)) assert.ok(STATES[s]);
});
