import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:7102' },
  },
  // 本地验证生产构建：vite preview 模拟 Nginx 反代
  preview: {
    port: 8102,
    proxy: { '/api': 'http://localhost:7102' },
  },
  build: { outDir: 'dist' },
});
