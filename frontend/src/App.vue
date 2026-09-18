<template>
  <router-view v-if="isLoginPage" />
  <div v-else class="layout">
    <aside class="sidebar">
      <div class="logo">安运通</div>
      <div class="logo-sub">危货运输监管平台</div>
      <nav class="menu">
        <RouterLink
          v-for="m in menus"
          :key="m.path"
          :to="m.path"
          class="menu-item"
          :class="{ active: isActive(m) }"
        >
          <span class="menu-icon">{{ m.icon }}</span>
          <span class="menu-label">{{ m.label }}</span>
        </RouterLink>
      </nav>
      <div class="sidebar-foot">v0.1 骨架版</div>
    </aside>

    <div class="main">
      <OfflineBanner />
      <header class="topbar">
        <div class="page-title">{{ route.meta.title || '' }}</div>
        <div class="user-chip">
          <span class="user-name">{{ store.user?.name }}</span>
          <span class="tag">{{ roleLabel }}</span>
          <span v-if="store.user?.enterprise_name" class="user-ent">{{ store.user.enterprise_name }}</span>
          <button class="btn btn-ghost btn-sm" @click="onLogout">退出</button>
        </div>
      </header>
      <main class="content">
        <router-view />
      </main>
    </div>

    <nav class="tabbar">
      <RouterLink
        v-for="m in menus"
        :key="m.path"
        :to="m.path"
        class="tab-item"
        :class="{ active: isActive(m) }"
      >
        <span class="tab-icon">{{ m.icon }}</span>
        <span>{{ m.label }}</span>
      </RouterLink>
    </nav>
  </div>
  <ToastHost />
</template>

<script setup>
import { computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { store, logout } from './store.js';
import { api } from './api.js';
import OfflineBanner from './components/OfflineBanner.vue';
import ToastHost from './components/ToastHost.vue';

const route = useRoute();
const router = useRouter();

const isLoginPage = computed(() => route.name === 'login');

// 登录后拉取一次状态机/角色枚举（状态徽章、筛选器、按钮渲染共用）
async function ensureEnums() {
  if (!store.token || store.enums) return;
  try { store.enums = await api.get('/meta/enums'); } catch { /* 离线时用组件内置回退 */ }
}
onMounted(ensureEnums);
watch(() => store.token, ensureEnums);

const ALL_MENUS = [
  { path: '/', label: '运单作战台', icon: '📊', roles: ['REGULATOR', 'ENTERPRISE_ADMIN'], exact: true },
  { path: '/waybills', label: '电子运单', icon: '📄', roles: ['REGULATOR', 'ENTERPRISE_ADMIN', 'DRIVER', 'ESCORT'] },
];

const menus = computed(() => ALL_MENUS.filter((m) => m.roles.includes(store.user?.role)));

const roleLabel = computed(() => store.enums?.roles?.[store.user?.role]
  || { ENTERPRISE_ADMIN: '企业管理员', DRIVER: '驾驶员', ESCORT: '押运员', REGULATOR: '监管员' }[store.user?.role]
  || '');

function isActive(m) {
  if (m.exact) return route.path === m.path;
  return route.path.startsWith(m.path);
}

function onLogout() {
  logout();
  router.push('/login');
}
</script>
