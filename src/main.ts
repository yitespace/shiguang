import { createApp } from 'vue';
import { createRouter, createWebHashHistory } from 'vue-router';
import App from './App.vue';
import './styles/global.css';

import PastPage from './pages/PastPage.vue';
import FindPage from './pages/FindPage.vue';
import StatsPage from './pages/StatsPage.vue';
import SettingsPage from './pages/SettingsPage.vue';
import MinePage from './pages/MinePage.vue';
import ProfilePage from './pages/ProfilePage.vue';
import MedsPage from './pages/MedsPage.vue';
import RemindersPage from './pages/RemindersPage.vue';
import FocusPage from './pages/FocusPage.vue';

// 用 hash 路由：静态托管无需任何服务端重写规则，任何路径刷新都不会 404
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    // 记录和日历合并成「过往」：上日历下时间线
    { path: '/', name: 'past', component: PastPage },
    { path: '/past', redirect: '/' },
    // 日历不再单独成页，带 ?d= 的旧链接重定向到过往
    { path: '/calendar', redirect: (to) => ({ path: '/', query: to.query }) },
    // 检索和对话合并成一页「拾迹」；旧地址重定向，别让收藏的链接失效
    { path: '/find', name: 'find', component: FindPage },
    { path: '/mine', name: 'mine', component: MinePage },
    // 点头像进来的个人资料页：昵称、简介、账号、通用
    { path: '/profile', name: 'profile', component: ProfilePage },
    { path: '/search', redirect: '/find' },
    { path: '/chat/:id?', redirect: '/find' },
    // 关怀三件套：吃药、提醒、学习模式。入口在「我的」页顶部的关怀区块
    { path: '/meds', name: 'meds', component: MedsPage },
    { path: '/reminders', name: 'reminders', component: RemindersPage },
    { path: '/focus', name: 'focus', component: FocusPage },
    { path: '/stats', name: 'stats', component: StatsPage },
    { path: '/settings', name: 'settings', component: SettingsPage },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
  scrollBehavior(_to, _from, saved) {
    return saved || { top: 0 };
  },
});

createApp(App).use(router).mount('#app');

// 注册 Service Worker：装上浏览器/手机后可以离线打开界面
/*
 * 注册 Service Worker，并处理版本切换。
 *
 * 这里解决的是一个真出过的问题：用户一直停在旧版本上。
 * 根因在 public/sw.js（那个文件从上线起就没变过，浏览器因此从不重装它），
 * 但光修那边还不够 —— 切换的时机也得管好，否则会出现
 * 「新 SW 已接管、页面还在跑旧 JS」的错配，旧 JS 去要已经删掉的文件名，
 * 页面当场碎掉。
 *
 * 所以流程是：
 *   · 新 SW 装好之后先等着（sw.js 里刻意不 skipWaiting）
 *   · 页面这边发现了就让它接管，接管后刷新一次，两边版本对齐
 *   · 刷新只做一次（用 sessionStorage 打标记），避免来回弹
 */
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js')
      .then((reg) => {
        // 上次切换留下的标记，这次进来先清掉
        sessionStorage.removeItem('sg.switching');

        const takeOver = (worker: ServiceWorker | null) => {
          if (!worker) return;
          if (sessionStorage.getItem('sg.switching') === '1') return;
          sessionStorage.setItem('sg.switching', '1');
          worker.postMessage({ type: 'SKIP_WAITING' });
        };

        // 打开页面时就已经有一个新版本在等着了：直接换上
        if (reg.waiting) takeOver(reg.waiting);

        reg.addEventListener('updatefound', () => {
          const sw = reg.installing;
          if (!sw) return;
          sw.addEventListener('statechange', () => {
            // 只有当页面上已经有 SW 在管事时才算「更新」；
            // 第一次安装不该触发刷新
            if (sw.state === 'installed' && navigator.serviceWorker.controller) takeOver(sw);
          });
        });

        // 新 SW 接管之后刷新一次，让页面和缓存对齐
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (sessionStorage.getItem('sg.switching') === '1') {
            sessionStorage.removeItem('sg.switching');
            location.reload();
          }
        });

        // 每次打开都问一下有没有新版本（浏览器自己也会定期问，这里只是快一点）
        reg.update().catch(() => {});
      })
      .catch(() => {
        /* 注册失败不影响使用 */
      });
  });
}
