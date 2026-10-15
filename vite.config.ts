import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * 把构建号注进 sw.js。
 *
 * 浏览器只在 **sw.js 的字节变化** 时才装新的 Service Worker。
 * 而 public/ 是原样拷贝的，内容每次构建都一样 —— 于是 SW 永远不会更新，
 * 旧缓存永远不会清，用户会一直停在旧版本上（这个坑真踩过，
 * 表现是「网站改了但用户看到的还是几天前的界面」）。
 *
 * 这里用产物里的静态资源文件名算一个短哈希，写进 sw.js 的占位符。
 * 资源一变哈希就变，sw.js 跟着变，SW 就会重装。
 */
function swBuildId() {
  return {
    name: 'sw-build-id',
    closeBundle() {
      const outDir = process.env.VITE_OUT_DIR || 'dist';
      const sw = path.join(outDir, 'sw.js');
      const assets = path.join(outDir, 'assets');
      if (!fs.existsSync(sw)) return;
      const names = fs.existsSync(assets) ? fs.readdirSync(assets).sort().join('|') : String(Date.now());
      const id = createHash('sha256').update(names).digest('hex').slice(0, 10);
      const src = fs.readFileSync(sw, 'utf8').replace(/__BUILD_ID__/g, id);
      fs.writeFileSync(sw, src);
    },
  };
}

// 部署到 https://zhuangrongjian.space/shiguang/
// 为了同时兼容 Capacitor / 本地 file:// 打开，使用相对路径 base
export default defineConfig({
  base: './',
  plugins: [vue(), swBuildId()],
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
