<template>
  <div class="login-page">
    <div class="login-card">
      <div class="login-brand">
        <div class="login-logo">安运通</div>
        <div class="login-slogan">危险货物道路运输监管平台</div>
      </div>
      <form class="login-form" @submit.prevent="onSubmit">
        <label>
          用户名
          <input v-model.trim="username" autocomplete="username" placeholder="请输入用户名" required />
        </label>
        <label>
          密码
          <input v-model="password" type="password" autocomplete="current-password" placeholder="请输入密码" required />
        </label>
        <div v-if="error" class="login-error">{{ error }}</div>
        <button class="btn btn-primary btn-block" :disabled="loading">
          {{ loading ? '登录中…' : '登 录' }}
        </button>
      </form>
      <div class="demo-accounts">
        <div class="demo-title">演示账号（密码统一 Ayt@123456，点击填充）</div>
        <div class="demo-grid">
          <button v-for="a in demoAccounts" :key="a.username" type="button" class="demo-item" @click="fill(a.username)">
            <span class="demo-user">{{ a.username }}</span>
            <span class="demo-role">{{ a.role }}</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { api } from '../api.js';
import { setAuth } from '../store.js';

const router = useRouter();
const route = useRoute();
const username = ref('');
const password = ref('');
const error = ref('');
const loading = ref(false);

const demoAccounts = [
  { username: 'regulator', role: '监管员' },
  { username: 'al_admin', role: '企业管理员·安澜' },
  { username: 'al_driver1', role: '驾驶员·安澜' },
  { username: 'al_escort1', role: '押运员·安澜' },
];

function fill(u) {
  username.value = u;
  password.value = 'Ayt@123456';
}

async function onSubmit() {
  error.value = '';
  loading.value = true;
  try {
    const { token, user } = await api.post('/auth/login', { username: username.value, password: password.value });
    setAuth(token, user);
    const redirect = route.query.redirect;
    if (redirect) return router.push(redirect);
    // 驾驶员/押运员直达运单任务，管理角色进作战台
    router.push(user.role === 'DRIVER' || user.role === 'ESCORT' ? '/waybills' : '/');
  } catch (e) {
    error.value = e.message || '登录失败';
  } finally {
    loading.value = false;
  }
}
</script>
