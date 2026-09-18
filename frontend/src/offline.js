import { store, toast, persistQueue, persistFailed } from './store.js';
import { transitionWaybill, newIdempotencyKey } from './api.js';

/**
 * 离线机制（山区无网场景）：
 *  - 断网时启运/到达等关键操作进入本地队列，页面明确提示「离线暂存」；
 *  - 恢复网络后自动重放，重放沿用首次生成的幂等键 + 原始发生时间；
 *  - 服务端按幂等键去重，重复提交不会产生重复事件/重复运单。
 */

let flushing = false;

export function enqueueTransition(waybill, action, label) {
  store.queue.push({
    key: newIdempotencyKey(),
    waybillId: waybill.id,
    waybillNo: waybill.waybill_no,
    action,
    label,
    occurredAt: new Date().toISOString(), // 记录真实发生时间，同步时上报
    enqueuedAt: new Date().toISOString(),
  });
  persistQueue();
}

export async function flushQueue() {
  if (flushing || !store.online || !store.queue.length) return;
  flushing = true;
  try {
    for (const item of [...store.queue]) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const res = await transitionWaybill(item.waybillId, item.action, {
          occurredAt: item.occurredAt,
          idempotencyKey: item.key, // 关键：沿用首次幂等键
        });
        removeFromQueue(item.key);
        toast(
          `离线变更已同步：${item.waybillNo}「${item.label}」${res.deduplicated ? '（服务端幂等去重）' : ''}`,
          'success',
        );
      } catch (e) {
        if (e.code === 'OFFLINE') return; // 又断了，保留队列下次再试
        removeFromQueue(item.key);
        store.failedSync.push({ ...item, error: e.message });
        persistFailed();
        toast(`同步失败：${item.waybillNo}「${item.label}」— ${e.message}`, 'error');
      }
    }
  } finally {
    flushing = false;
  }
}

function removeFromQueue(key) {
  const i = store.queue.findIndex((q) => q.key === key);
  if (i >= 0) store.queue.splice(i, 1);
  persistQueue();
}

export function clearFailed() {
  store.failedSync.splice(0, store.failedSync.length);
  persistFailed();
}

/** 启动在线状态监听：浏览器事件 + 离线期每 10 秒探测恢复 */
export function startOfflineWatch() {
  window.addEventListener('online', () => {
    store.online = true;
    flushQueue();
  });
  window.addEventListener('offline', () => {
    store.online = false;
  });
  setInterval(async () => {
    if (store.online) return;
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      if (r.ok) {
        store.online = true;
        toast('网络已恢复，正在同步离线变更…', 'info');
        flushQueue();
      }
    } catch { /* 仍离线 */ }
  }, 10000);
}
