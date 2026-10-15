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
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* 注册失败不影响使用 */
    });
  });
}
