<script setup lang="ts">
// =============================================================
// 我的
//
// 这一页回答两个问题：「我记了多少东西」和「今天有什么要我照顾的」。
//
// 排版上刻意做了三件事，都是为了别变成一摞长得一样的白卡：
//   1. 头图只放身份，不再在它上面叠一张浮起来的统计卡 —— 少一层，页面立刻清爽
//   2. 统计数字平铺在头图下沿，不加卡片、不加阴影，安静地待在第二层
//   3. 「关怀」是唯一需要每天看一眼的模块，给它带颜色的块；
//      记录和账号一律普通白卡，视觉重量从上往下递减
//
// 账号、通用、服务状态这些和「看记录」无关的都在个人资料页（点头像进去）。
// =============================================================
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import * as api from '../lib/api';
import { fullDate, shortDate } from '../lib/date';
import { careToday as care, doLogout, entries, loadProfile, profile, refresh, refreshCare, toast } from '../lib/store';

const router = useRouter();

const stats = ref<{ total: number; days: number; streak: number; chars: number; firstDate: string | null } | null>(null);

/** 关怀区块里的时间只显示 HH:MM，日期在标题上已经说清楚了 */
function hhmmOf(ts: number) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const totalChars = computed(() => stats.value?.chars ?? entries.value.reduce((s, e) => s + e.content.length, 0));
const oldest = computed(() => (stats.value?.firstDate ? fullDate(stats.value.firstDate) : '暂无'));

/** 头图标题：起了名字就用名字，没起就用页面名 */
const title = computed(() => profile.value?.nickname?.trim() || '我的');

/** 头像里的字：起了名字就用名字首字，否则用图形 */
const avatarChar = computed(() => profile.value?.nickname?.trim().slice(0, 1) || '');

/**
 * 头图那句副标题。
 * 有简介就显示简介（用户自己写的，优先级最高）；没有就退回到记录足迹。
 * 要短到一行放得下 —— 头图窄，左边还有头像。
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

/** 吃药那句状态：没吃 / 过点 / 吃完 / 还没添加 */
const medText = computed(() => {
  const m = care.value?.meds;
  if (!m || !m.plan.length) return '还没添加在吃的药';
  if (!m.pending) return '今天的药都吃过了';
  return m.next ? `今天还有 ${m.pending} 次没吃 · 下一次 ${m.next.slot}` : `今天还有 ${m.pending} 次没吃`;
});

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
  await Promise.all([load(), refreshCare(), profile.value ? Promise.resolve() : loadProfile()]);
});
</script>

<template>
  <div class="mine-page">
    <!-- ============ 身份条：整块可点，进个人资料 ============ -->
    <!--
      用 <a href> 而不是 <button>：<a> 的内容模型是透明的，里面可以放 <h1>；
      <button> 只允许短语内容，塞标题是非法 HTML。
      真链接还能中键新开、右键复制地址，比按钮更像个入口。
    -->
    <header class="hero">
      <a class="hero-hit" href="#/profile">
        <span class="hero-avatar" aria-hidden="true">
          <span v-if="avatarChar" class="hero-initial">{{ avatarChar }}</span>
          <Icon v-else name="feather" :size="24" />
        </span>
        <span class="hero-id">
          <h1 class="hero-name">{{ title }}</h1>
          <span class="hero-sub">{{ footprint }}</span>
        </span>
        <Icon name="arrowRight" :size="17" class="hero-go" />
      </a>
    </header>

    <!-- ============ 统计：平铺一行，不是卡片 ============ -->
    <!--
      之前这里是一张浮在白卡上的统计卡，压着头图下沿。
      它让页面多出一层「浮起来的东西」，而且和下面的关怀卡、记录卡长得一样重。
      现在改成平铺：没有外框、没有阴影，只有数字和极细的分隔线，
      视线扫过去就知道「我记了多少」，但不会被它抢走注意力。
    -->
    <button class="stats" @click="router.push('/stats')">
      <span v-for="it in statsItems" :key="it.label" class="st-cell">
        <b class="st-num" :class="{ hot: it.hot }">{{ it.value }}</b>
        <em class="st-label">{{ it.label }}</em>
      </span>
      <Icon name="arrowRight" :size="15" class="st-go" />
    </button>

    <!-- ============ 关怀 ============ -->
    <!--
      这是唯一需要每天看一眼的模块，所以给它颜色和重量；
      下面的「我的记录」和「退出登录」都退成安静的白卡，形成层级。
    -->
    <section class="group">
      <h2 class="group-title">关怀</h2>

      <button class="med-card" :class="{ due: care?.meds.pending, late: care?.meds.overdue }" @click="router.push('/meds')">
        <span class="med-icon"><Icon name="pill" :size="18" /></span>
        <span class="med-body">
          <b class="med-name">吃药提醒</b>
          <!--
            状态和「过点了几次」放在同一行里。
            以前过点是个红药丸挂在右边，和箭头挤在一起抢位置；
            现在它只是状态句子末尾的一点强调色。
          -->
          <em class="med-state">
            {{ medText }}<template v-if="care?.meds.overdue"><span class="med-late"> · {{ care.meds.overdue }} 次过点了</span></template>
          </em>
        </span>
        <Icon name="arrowRight" :size="15" class="chev" />
      </button>

      <div class="care-grid">
        <button class="care-tile brand" @click="router.push('/reminders')">
          <span class="ct-head">
            <span class="ct-icon"><Icon name="bell" :size="16" /></span>
            <b>快捷提醒</b>
            <Icon name="arrowRight" :size="13" class="ct-chev" />
          </span>
          <em v-if="care?.reminders.length">{{ care.reminders.length }} 条等着提醒</em>
          <em v-else>说了「几点要干嘛」我会问你</em>
        </button>

        <button class="care-tile ai" @click="router.push('/focus')">
          <span class="ct-head">
            <span class="ct-icon"><Icon name="hourglass" :size="16" /></span>
            <b>学习模式</b>
            <Icon name="arrowRight" :size="13" class="ct-chev" />
          </span>
          <em v-if="care?.focus.blocking">正在专注 · {{ care.focus.label }}</em>
          <em v-else-if="care?.focus.next">下一次 {{ hhmmOf(care.focus.next.at) }} 开始</em>
          <em v-else>到点锁住分心的应用</em>
        </button>
      </div>
    </section>

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

    <!-- ============ 退出登录 ============ -->
    <!--
      单独一张卡、单一行、红字居中，不再是一个和内容卡一样宽的描边大按钮 ——
      那个形状太重了，看起来像页面的主要内容。
    -->
    <button class="logout" @click="logout">
      <Icon name="x" :size="16" /> 退出登录
    </button>

    <p class="version">向阳花圃 v1.0.0 · 所有记录只存在你自己的服务器上</p>
  </div>
</template>

<style scoped>
/* ---------- 身份条 ---------- */
/*
 * 移动端用负边距顶到最上沿（连安全区一起吃掉），桌面端收成圆角卡片。
 * 高度比之前矮了一截：以前底部多留 48px 是为了让统计卡压上来，
 * 现在统计是平铺的，那段空白就没必要了。
 */
.hero {
  margin: calc(-1 * (var(--safe-top) + 10px)) calc(-1 * var(--pad)) 0;
  padding: calc(var(--safe-top) + 14px) var(--pad) 22px;
  background: var(--hero-grad);
  border-radius: 0 0 var(--r-xl) var(--r-xl);
  color: var(--on-hero);
}

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
  width: 52px;
  height: 52px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: var(--on-hero);
  color: var(--hero-ink);
  font-size: 1.3rem;
  font-weight: 680;
  line-height: 1;
}

.hero-avatar :deep(svg) {
  width: 24px;
  height: 24px;
}

.hero-id {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.hero-name {
  margin: 0;
  font-size: 1.32rem;
  font-weight: 680;
  letter-spacing: -0.02em;
  line-height: 1.25;
  color: var(--on-hero);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hero-sub {
  font-size: 0.82rem;
  color: var(--on-hero);
  opacity: 0.86;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hero-go {
  flex: 0 0 auto;
  color: var(--on-hero);
  opacity: 0.75;
}

/* ---------- 统计：平铺一行 ---------- */
/*
 * 没有外框、没有阴影、没有白色底 —— 它就长在页面上。
 * 用上下两条极细的分隔线把它和头图、关怀分开，靠留白而不是靠卡片来分组。
 */
.stats {
  width: 100%;
  display: flex;
  align-items: stretch;
  padding: 14px 2px 15px;
  border-bottom: 1px solid var(--border);
  text-align: center;
  transition: opacity var(--dur);
}

.stats:active {
  opacity: 0.7;
}

.st-cell {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  position: relative;
}

.st-cell + .st-cell {
  border-left: 1px solid var(--border);
}

.st-num {
  font-family: var(--font-num);
  font-variant-numeric: tabular-nums;
  font-size: 1.28rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.1;
  color: var(--text);
}

.st-num.hot {
  color: var(--brand-deep);
}

.st-label {
  font-style: normal;
  font-size: 0.73rem;
  color: var(--text-3);
}

.st-go {
  align-self: center;
  flex: 0 0 auto;
  margin-left: 2px;
  color: var(--text-3);
}

/* ---------- 分组 ---------- */
.group {
  margin-top: 26px;
}

.group-title {
  font-size: 0.76rem;
  font-weight: 620;
  color: var(--text-3);
  letter-spacing: 0.08em;
  margin: 0 4px 9px;
}

/* ---------- 吃药：带色的主卡 ---------- */
.med-card {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 13px 14px;
  margin-bottom: 9px;
  border-radius: var(--r-lg);
  text-align: left;
  background: var(--surface);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-sm);
  transition: border-color var(--dur), transform var(--dur);
}

.med-card:active {
  transform: scale(0.99);
}

/* 有药没吃：描边提亮，扫一眼就知道今天还没完事 */
.med-card.due {
  border-color: var(--brand);
}

.med-card.late {
  border-color: var(--rose);
}

.med-icon {
  flex: 0 0 auto;
  width: 36px;
  height: 36px;
  border-radius: 11px;
  display: grid;
  place-items: center;
  background: var(--brand-tint);
  color: var(--brand-deep);
}

.med-card.late .med-icon {
  background: var(--rose-tint);
  color: var(--rose-text);
}

.med-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.med-name {
  font-size: 0.95rem;
  font-weight: 640;
  color: var(--text);
}

.med-state {
  font-style: normal;
  font-size: 0.79rem;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.med-late {
  color: var(--rose-text);
  font-weight: 600;
}

/* ---------- 两个小入口 ---------- */
/*
 * 用很淡的品牌色/青绿底，和下面的白卡拉开一档：
 * 眼睛从上往下扫，重量是递减的（吃药 > 两个入口 > 白卡列表）。
 */
.care-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 9px;
}

.care-tile {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 13px;
  border-radius: var(--r-lg);
  text-align: left;
  transition: transform var(--dur);
}

.care-tile:active {
  transform: scale(0.98);
}

.care-tile.brand {
  background: var(--brand-tint);
}

.care-tile.ai {
  background: var(--ai-tint);
}

.ct-head {
  display: flex;
  align-items: center;
  gap: 7px;
}

.ct-icon {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
}

.care-tile.brand .ct-icon {
  color: var(--brand-deep);
}

.care-tile.ai .ct-icon {
  color: var(--ai-text);
}

.ct-head b {
  flex: 1;
  min-width: 0;
  font-size: 0.89rem;
  font-weight: 640;
  color: var(--text);
}

.ct-chev {
  flex: 0 0 auto;
  color: var(--text-3);
}

.care-tile em {
  font-style: normal;
  font-size: 0.75rem;
  line-height: 1.45;
  color: var(--text-2);
}

/* ---------- 记录列表 ---------- */
.menu {
  padding: 3px 0;
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

.menu-row + .menu-row {
  border-top: 1px solid var(--border);
}

.menu-row:not(.static):hover {
  background: var(--surface-2);
}

.menu-row:not(.static):active {
  background: var(--surface-3);
}

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
  font-size: 0.83rem;
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

/* ---------- 退出登录 ---------- */
/* 一张白卡、一行红字。不再是和内容卡一样宽的描边大按钮。 */
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
  font-size: 0.92rem;
  font-weight: 560;
  transition: background var(--dur);
}

.logout:hover {
  background: var(--rose-tint);
}

/* ---------- 版本 ---------- */
.version {
  text-align: center;
  font-size: 0.72rem;
  color: var(--text-3);
  margin: 18px 4px 4px;
  line-height: 1.6;
}

/* ---------- 桌面端：头图收成卡片 ---------- */
@media (min-width: 1080px) {
  .hero {
    /* 桌面端整页是居中一列，头图跟着这一列走，别再往外扩 */
    margin: 0;
    padding: 22px 24px;
    border-radius: var(--r-xl);
  }
}
</style>
