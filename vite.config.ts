import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 部署到 https://zhuangrongjian.space/shiguang/
// 为了同时兼容 Capacitor / 本地 file:// 打开，使用相对路径 base
export default defineConfig({
  base: './',
  plugins: [vue()],
  build: {
    // 网页版出到 dist；打 App 时用 VITE_OUT_DIR 出到 dist-app。
    // 两者必须分开：App 版会把后端地址写成绝对路径，混用会让本地
    // 和测试环境的前端跑去连线上接口（登录会莫名其妙 401）。
    outDir: process.env.VITE_OUT_DIR || 'dist',
    assetsDir: 'assets',
    target: 'es2020',
    cssCodeSplit: false,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 1200,
  },
  server: {
    host: '127.0.0.1',
    port: 5181,
    proxy: {
      // 本地开发时把 /api 代理到本地 Node 服务
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
});
