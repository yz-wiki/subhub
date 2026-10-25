import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  // 相对路径：反代挂到 /sub 这类子路径时，静态资源仍能正确解析
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1600,
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8090',
      // 只代理订阅路径 /s/，否则 /src/... 这类模块请求也会被误转发
      '^/s/': 'http://127.0.0.1:8090',
    },
  },
});
