import { reactive } from 'vue';

// 全局轻量状态：登录态 / 在线状态 / 离线队列 / 全局提示
export const store = reactive({
  token: localStorage.getItem('ayt_token') || '',
  user: readJson('ayt_user'),
  online: navigator.onLine !== false,
  queue: readJson('ayt_offline_queue') || [],
  failedSync: readJson('ayt_failed_sync') || [],
  enums: null,
  toasts: [],
});

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}

export function setAuth(token, user) {
  store.token = token;
  store.user = user;
  localStorage.setItem('ayt_token', token);
  localStorage.setItem('ayt_user', JSON.stringify(user));
}

export function logout() {
  store.token = '';
  store.user = null;
  localStorage.removeItem('ayt_token');
  localStorage.removeItem('ayt_user');
}

let toastSeq = 0;
export function toast(text, type = 'info', duration = 4500) {
  const id = ++toastSeq;
  store.toasts.push({ id, text, type });
  setTimeout(() => {
    const i = store.toasts.findIndex((t) => t.id === id);
    if (i >= 0) store.toasts.splice(i, 1);
  }, duration);
}

export function persistQueue() {
  localStorage.setItem('ayt_offline_queue', JSON.stringify(store.queue));
}

export function persistFailed() {
  localStorage.setItem('ayt_failed_sync', JSON.stringify(store.failedSync));
}
