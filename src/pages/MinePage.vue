<script setup lang="ts">
// =============================================================
// 我的
//
// 一级页面只干一件事：让这个人看见自己的记录。
//   1. 顶部渐变头图（头像 + 昵称 + 一句状态），整块可点，进「个人资料」
//   2. 统计卡用负边距上浮，压住头图下缘，点进去看完整统计
//   3. 我的记录：统计、导出、累计字数、第一条
//   4. 退出登录单独一块
//
// 账号、通用、服务状态这些跟「看记录」无关的东西都收进了个人资料页
// （点头像进去），一级页面才不会越堆越长。
// =============================================================
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import * as api from '../lib/api';
import { fullDate, shortDate } from '../lib/date';
import { doLogout, entries, loadProfile, profile, refresh, toast } from '../lib/store';

const router = useRouter();

const stats = ref<{ total: number; days: number; streak: number; chars: number; firstDate: string | null } | null>(null);

const totalChars = computed(() => stats.value?.chars ?? entries.value.reduce((s, e) => s + e.content.length, 0));
const oldest = computed(() => (stats.value?.firstDate ? fullDate(stats.value.firstDate) : '暂无'));

/** 头图标题：起了名字就用名字，没起就用页面名 */
const title = computed(() => profile.value?.nickname?.trim() || '我的');

/** 头像里的字：起了名字就用名字首字，否则用图形 */
const avatarChar = computed(() => profile.value?.nickname?.trim().slice(0, 1) || '');

/**
 * 头图那句副标题。
 * 有简介就显示简介（这是用户自己写的，优先级最高）；
 * 没有就退回到记录足迹。要短到一行放得下——头图窄，左边还有头像。
 */
const footprint = computed(() => {
  const bio = profile.value?.bio?.trim();
  if (bio) return bio;
  const s = stats.value;
  if (!s || !s.total || !s.firstDate) return '还没有开始，写一句就算数';
  const d = new Date(`${s.firstDate}T12:00:00`);
  const start = d.getFullYear() === new Date().getFullYear() ? shortDate(s.firstDate) : fullDate(s.firstDate);
  return `从 ${start} 记到现在`;
});

const statsItems = computed(() => [
  { value: stats.value?.total ?? 0, label: '条记录' },
  { value: stats.value?.days ?? 0, label: '天有记录' },
  { value: stats.value?.streak ?? 0, label: '天连续', hot: (stats.value?.streak ?? 0) >= 3 },
]);

async function load() {
  try {
    stats.value = await api.getStats();
  } catch {
    /* 静默失败，页面照常显示 */
  }
}

async function logout() {
  await doLogout();
  toast('已退出登录');
}

onMounted(async () => {
  await refresh({ silent: true });
  await Promise.all([load(), profile.value ? Promise.resolve() : loadProfile()]);
});
</script>

<template>
  <div class="mine-page">
    <!-- ============ 头图：整块可点，进个人资料 ============ -->
    <!--
      用 <a href> 而不是 <button>：<a> 的内容模型是透明的，
      里面可以放 <h1>；<button> 只允许短语内容，塞标题是非法 HTML。
      而且真链接能中键新开、能右键复制地址，比按钮更像个入口。
    -->
    <header class="hero">
      <a class="hero-hit" href="#/profile">
        <span class="hero-avatar" aria-hidden="true">
          <span v-if="avatarChar" class="hero-initial">{{ avatarChar }}</span>
          <Icon v-else name="feather" :size="26" />
        </span>
        <span class="hero-id">
          <h1 class="hero-name">{{ title }}</h1>
          <span class="hero-sub">{{ footprint }}</span>
        </span>
        <Icon name="arrowRight" :size="18" class="hero-go" />
      </a>
    </header>

    <!-- ============ 统计卡：上浮压住头图下缘 ============ -->
    <button class="stat-card" @click="router.push('/stats')">
      <span v-for="it in statsItems" :key="it.label" class="sc-cell">
        <b class="sc-num" :class="{ hot: it.hot }">{{ it.value }}</b>
        <em class="sc-label">{{ it.label }}</em>
      </span>
      <Icon name="arrowRight" :size="16" class="sc-go" />
    </button>

    <!-- ============ 我的记录 ============ -->
    <section class="group">
      <h2 class="group-title">我的记录</h2>
      <div class="card menu">
        <button class="menu-row" @click="router.push('/stats')">
          <span class="mi brand"><Icon name="chart" :size="17" /></span>
          <span class="ml">统计</span>
          <span class="mv">热力图 · 标签 · 趋势</span>
          <Icon name="arrowRight" :size="15" class="chev" />
        </button>
        <button class="menu-row" @click="router.push('/settings')">
          <span class="mi brand"><Icon name="download" :size="17" /></span>
          <span class="ml">导出与备份</span>
          <span class="mv">Markdown / JSON</span>
          <Icon name="arrowRight" :size="15" class="chev" />
        </button>
        <div class="menu-row static">
          <span class="mi amber"><Icon name="edit" :size="17" /></span>
          <span class="ml">累计字数</span>
          <span class="mv num">{{ totalChars.toLocaleString() }} 字</span>
        </div>
        <div class="menu-row static">
          <span class="mi neutral"><Icon name="clock" :size="17" /></span>
          <span class="ml">第一条记录</span>
          <span class="mv">{{ oldest }}</span>
        </div>
      </div>
    </section>

    <!-- ============ 退出登录：单独一块 ============ -->
    <button class="logout" @click="logout">
      <Icon name="x" :size="17" /> 退出登录
    </button>

    <p class="version">拾光 v1.0.0</p>
    <p class="version sub">所有记录都只存在你自己的服务器上</p>
  </div>
</template>

<style scoped>
/*
 * 头图。
 * 移动端用负边距顶到屏幕最上沿（连安全区一起吃掉），
 * 桌面端收成一张圆角卡片，不然一条通栏色带横在侧栏旁边很怪。
 */
.hero {
  margin: calc(-1 * (var(--safe-top) + 10px)) calc(-1 * var(--pad)) 0;
  padding: calc(var(--safe-top) + 14px) var(--pad) 48px;
  background: var(--hero-grad);
  border-radius: 0 0 var(--r-xl) var(--r-xl);
  color: var(--on-hero);
}

/* 整块可点，所以做成一个按钮；样式上仍按一行排布 */
.hero-hit {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 13px;
  text-align: left;
  color: var(--on-hero);
  border-radius: var(--r);
  transition: opacity var(--dur);
}

.hero-hit:active {
  opacity: 0.85;
}

.hero-avatar {
  flex: 0 0 auto;
  width: 54px;
  height: 54px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: var(--on-hero);
  color: var(--hero-ink);
  font-size: 1.35rem;
  font-weight: 680;
  line-height: 1;
}

.hero-avatar :deep(svg) {
  width: 26px;
  height: 26px;
}

.hero-id {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.hero-name {
  display: block;
  font-size: 1.34rem;
  font-weight: 680;
  letter-spacing: -0.02em;
  color: var(--on-hero);
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hero-sub {
  margin-top: 4px;
  font-size: 0.8rem;
  line-height: 1.5;
  color: var(--on-hero);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hero-go {
  flex: 0 0 auto;
  color: var(--on-hero);
  opacity: 0.9;
}

/* ---------- 统计卡：负边距上浮，压住头图下缘 ---------- */
.stat-card {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: -30px;
  padding: 15px 14px;
  border-radius: var(--r-lg);
  background: var(--surface);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-md);
  transition: transform var(--dur);
}

.stat-card:active {
  transform: scale(0.99);
}

.sc-cell {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

/* 分隔线用边框画，别塞一个空元素进去（列布局里它会变成一条横杠） */
.sc-cell + .sc-cell {
  border-left: 1px solid var(--border-2);
}

.sc-num {
  font-size: 1.45rem;
  font-weight: 680;
  letter-spacing: -0.03em;
  line-height: 1.1;
  color: var(--brand-deep);
  font-variant-numeric: tabular-nums;
}

:root[data-theme='dark'] .sc-num {
  color: var(--brand-soft);
}

.sc-num.hot {
  color: var(--amber-text);
}

.sc-label {
  font-style: normal;
  font-size: 0.72rem;
  color: var(--text-3);
  white-space: nowrap;
}

.sc-go {
  flex: 0 0 auto;
  color: var(--text-3);
}

/* ---------- 分组菜单 ---------- */
.group {
  margin-top: 22px;
}

.group-title {
  font-size: 0.78rem;
  font-weight: 620;
  color: var(--text-3);
  letter-spacing: 0.06em;
  margin: 0 4px 8px;
}

.menu {
  padding: 4px 0;
  overflow: hidden;
}

.menu-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 14px;
  text-align: left;
  transition: background var(--dur);
}

.menu-row:not(.static):hover {
  background: var(--surface-2);
}

.menu-row:not(.static):active {
  background: var(--surface-3);
}

/* 左侧彩色圆角图标：一眼分得清是哪一类 */
.mi {
  flex: 0 0 auto;
  width: 30px;
  height: 30px;
  border-radius: 10px;
  display: grid;
  place-items: center;
}

.mi.brand {
  background: var(--brand-tint);
  color: var(--brand-deep);
}

.mi.amber {
  background: var(--amber-tint);
  color: var(--amber-text);
}

.mi.neutral {
  background: var(--surface-2);
  color: var(--text-2);
}

:root[data-theme='dark'] .mi.brand {
  color: var(--brand-soft);
}

.ml {
  flex: 1;
  min-width: 0;
  font-size: 0.93rem;
  color: var(--text);
}

.mv {
  flex: 0 0 auto;
  font-size: 0.84rem;
  color: var(--text-2);
  max-width: 52%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mv.num {
  font-family: var(--font-num);
  font-variant-numeric: tabular-nums;
}

.chev {
  flex: 0 0 auto;
  color: var(--text-3);
}

/* ---------- 退出登录：单独一块，不和别的操作混排 ---------- */
.logout {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  margin-top: 26px;
  padding: 14px;
  border-radius: var(--r-lg);
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--rose-text);
  font-size: 0.94rem;
  font-weight: 560;
  transition: background var(--dur);
}

.logout:hover {
  background: var(--rose-tint);
}

.logout:active {
  transform: scale(0.99);
}

.version {
  text-align: center;
  font-size: 0.76rem;
  color: var(--text-3);
  margin-top: 22px;
}

.version.sub {
  margin-top: 4px;
}

/* ---------- 桌面端：头图收成卡片 ---------- */
@media (min-width: 1080px) {
  .hero {
    /* 桌面端整页是居中一列，头图跟着这一列走，别再往外扩 */
    margin: 0;
    padding: 26px 26px 48px;
    border-radius: var(--r-xl);
  }
}
</style>
