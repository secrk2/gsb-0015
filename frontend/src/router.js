import { createRouter, createWebHistory } from 'vue-router';
import { store } from './store.js';
import LoginView from './views/LoginView.vue';
import DashboardView from './views/DashboardView.vue';
import WaybillListView from './views/WaybillListView.vue';
import WaybillDetailView from './views/WaybillDetailView.vue';
import WaybillCreateView from './views/WaybillCreateView.vue';
import ErrorView from './views/ErrorView.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: LoginView, meta: { public: true, title: '登录' } },
    {
      path: '/',
      name: 'dashboard',
      component: DashboardView,
      meta: { title: '运单作战台', roles: ['REGULATOR', 'ENTERPRISE_ADMIN'] },
    },
    { path: '/waybills', name: 'waybills', component: WaybillListView, meta: { title: '电子运单' } },
    {
      path: '/waybills/new',
      name: 'waybill-new',
      component: WaybillCreateView,
      meta: { title: '填报运单', roles: ['ENTERPRISE_ADMIN'] },
    },
    { path: '/waybills/:id(\\d+)', name: 'waybill-detail', component: WaybillDetailView, meta: { title: '运单详情' } },
    { path: '/403', name: 'forbidden', component: ErrorView, meta: { title: '无权访问' } },
    { path: '/:pathMatch(.*)*', name: 'not-found', component: ErrorView, meta: { title: '页面不存在' } },
  ],
});

router.beforeEach((to) => {
  if (to.meta.public) return true;
  if (!store.token) return { name: 'login', query: to.fullPath !== '/' ? { redirect: to.fullPath } : {} };
  if (to.meta.roles && !to.meta.roles.includes(store.user?.role)) return { name: 'forbidden' };
  return true;
});

router.afterEach((to) => {
  document.title = to.meta.title ? `安运通 · ${to.meta.title}` : '安运通 · 危货运输监管平台';
});
