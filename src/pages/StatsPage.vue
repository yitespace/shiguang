<script setup lang="ts">
import { computed, onMounted } from 'vue';
import Icon from '../components/Icon.vue';
import { addDays, monthLabel, today } from '../lib/date';
import { entries, refresh, stats } from '../lib/store';

/** 最近 53 周的热力图（周一为每列第一格） */
const heat = computed(() => {
  const map = new Map((stats.value?.heat || []).map((h) => [h.date, h.count]));
  const t = new Date();
  const day = t.getDay() === 0 ? 7 : t.getDay();
  // 列数按「第一条记录到现在」决定，最少 12 周、最多 53 周。
  // 否则新用户会看到一大片空白格子，像没加载出来。
  const first = stats.value?.firstDate;
  let weeks = 53;
  if (first) {
    const days = Math.ceil((t.getTime() - new Date(first + 'T00:00:00').getTime()) / 86400000);
    weeks = Math.min(53, Math.max(12, Math.ceil(days / 7) + 1));
  } else {
    weeks = 12;
  }
  const start = new Date(t);
  start.setDate(start.getDate() - (day - 1) - (weeks - 1) * 7);

  const cols: { date: string; count: number; future: boolean }[][] = [];
  let cursor = new Date(start);
  const now = new Date();
  now.setHours(23, 59, 59, 999);
  for (let w = 0; w < weeks; w++) {
    const col: { date: string; count: number; future: boolean }[] = [];
    for (let d = 0; d < 7; d++) {
      const p = (n: number) => String(n).padStart(2, '0');
      const key = `${cursor.getFullYear()}-${p(cursor.getMonth() + 1)}-${p(cursor.getDate())}`;
      col.push({ date: key, count: map.get(key) || 0, future: cursor > now });
      cursor.setDate(cursor.getDate() + 1);
    }
    cols.push(col);
  }
  return cols;
});

const maxCount = computed(() => Math.max(1, ...(stats.value?.heat || []).map((h) => h.count)));
const heatWeeks = computed(() => heat.value.length);

function level(count: number): string {
  if (!count) return '';
  const m = maxCount.value;
  const r = count / m;
  if (r > 0.75) return 'l4';
  if (r > 0.5) return 'l3';
  if (r > 0.25) return 'l2';
  return 'l1';
}

/** 最活跃的星期几 */
const weekdayStats = computed(() => {
  const buckets = new Array(7).fill(0);
  for (const e of entries.value) {
    const d = new Date(e.createdAt).getDay();
    buckets[d]++;
  }
  const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const max = Math.max(1, ...buckets);
  return buckets.map((count, i) => ({ label: WEEK[i], count, pct: Math.round((count / max) * 100) }));
});

/** 一天里最常记录的时间段 */
const hourStats = computed(() => {
  const buckets = new Array(4).fill(0);
  for (const e of entries.value) {
    const h = new Date(e.createdAt).getHours();
    if (h < 6) buckets[0]++;
    else if (h < 12) buckets[1]++;
    else if (h < 18) buckets[2]++;
    else buckets[3]++;
  }
  const LABELS = ['凌晨 0-6', '上午 6-12', '下午 12-18', '晚上 18-24'];
  const max = Math.max(1, ...buckets);
  return buckets.map((count, i) => ({ label: LABELS[i], count, pct: Math.round((count / max) * 100) }));
});

/** 按月统计 */
const byMonth = computed(() => {
  const map = new Map<string, number>();
  for (const e of entries.value) {
    const m = e.date.slice(0, 7);
    map.set(m, (map.get(m) || 0) + 1);
  }
  const list = [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 6);
  const max = Math.max(1, ...list.map((x) => x[1]));
  return list.map(([m, count]) => ({ month: m, count, pct: Math.round((count / max) * 100) }));
});

/** 语音记录统计（从带音频附件的记录里算） */
const voiceStats = computed(() => {
  let count = 0;
  let ms = 0;
  let bytes = 0;
  let points = 0;
  for (const e of entries.value) {
    for (const a of e.attachments || []) {
      count++;
      ms += a.durationMs || 0;
      bytes += a.bytes || 0;
      points += (a.points || []).length;
    }
  }
  return {
    count,
    points,
    minutes: (ms / 60000).toFixed(ms < 60000 ? 1 : 0),
    size: (bytes / 1024 / 1024).toFixed(1),
  };
});

const tagStats = computed(() => {
  const list = (stats.value?.tags || []).slice(0, 8);
  const max = Math.max(1, ...list.map((t) => t.count));
  return list.map((t) => ({ ...t, pct: Math.round((t.count / max) * 100) }));
});

const monthCount = computed(() => {
  const m = today().slice(0, 7);
  return entries.value.filter((e) => e.date.startsWith(m)).length;
});

const weekCount = computed(() => {
  const from = addDays(today(), -6);
  return entries.value.filter((e) => e.date >= from).length;
});

const avgPerDay = computed(() => {
  const d = stats.value?.days || 0;
  if (!d) return '0';
  return ((stats.value?.total || 0) / d).toFixed(1);
});

const sinceDays = computed(() => {
  const first = stats.value?.firstDate;
  if (!first) return 0;
  const a = new Date(first + 'T00:00:00').getTime();
  const b = new Date(today() + 'T00:00:00').getTime();
  return Math.round((b - a) / 86400000) + 1;
});

onMounted(() => refresh({ silent: true }));
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1><Icon name="chart" :size="22" /> 统计</h1>
        <p class="sub">记录本身就是证据，这些数字是你的时间留下的痕迹</p>
      </div>
    </div>

    <!-- 顶部概览条：一眼看到最关键的三个数字 -->
    <div v-if="stats?.total" class="hero-strip">
      <div class="hs-item">
        <b class="num">{{ stats.total }}</b>
        <span>条记录</span>
      </div>
      <i class="hs-sep"></i>
      <div class="hs-item">
        <b class="num">{{ stats.days }}</b>
        <span>天有记录</span>
      </div>
      <i class="hs-sep"></i>
      <div class="hs-item" :class="{ hot: stats.streak >= 3 }">
        <b class="num">{{ stats.streak }}</b>
        <span>天连续</span>
      </div>
    </div>

    <div v-if="!stats?.total" class="empty card" style="padding: 46px 20px">
      <span class="big">📊</span>
      <p class="tip">还没有数据。<br />记满几天再回来看看。</p>
    </div>

    <template v-else>
      <!-- 概览 -->
      <div class="stat-grid">
        <div class="stat-box">
          <div class="k">总记录</div>
          <div class="v">{{ stats.total }}<span class="u">条</span></div>
        </div>
        <div class="stat-box">
          <div class="k">天有记录</div>
          <div class="v">{{ stats.days }}<span class="u">天</span></div>
        </div>
        <div class="stat-box">
          <div class="k">连续天数</div>
          <div class="v" :style="stats.streak >= 3 ? 'color: var(--amber-text)' : ''">
            {{ stats.streak }}<span class="u">天</span>
          </div>
        </div>
        <div class="stat-box">
          <div class="k">平均每天</div>
          <div class="v">{{ avgPerDay }}<span class="u">条</span></div>
        </div>
        <div class="stat-box">
          <div class="k">本周</div>
          <div class="v">{{ weekCount }}<span class="u">条</span></div>
        </div>
        <div class="stat-box">
          <div class="k">本月</div>
          <div class="v">{{ monthCount }}<span class="u">条</span></div>
        </div>
      </div>

      <!-- 热力图 -->
      <div class="section-title">
        <h2><Icon name="calendar" :size="17" /> 记录热力图</h2>
        <span class="sub">{{ sinceDays }} 天 · {{ heatWeeks }} 周</span>
      </div>
      <div class="card card-pad">
        <div class="heat-scroll">
          <div class="heat">
            <template v-for="(col, ci) in heat" :key="ci">
              <i
                v-for="cell in col"
                :key="cell.date"
                :class="[level(cell.count), { future: cell.future }]"
                :title="`${cell.date} · ${cell.count} 条`"
                :style="cell.future ? 'opacity: 0.25' : ''"
              ></i>
            </template>
          </div>
        </div>
        <div class="heat-foot">
          <span class="legend">少</span>
          <span class="legend"><i style="background: var(--surface-3)"></i></span>
          <span class="legend"><i style="background: color-mix(in srgb, var(--brand) 25%, var(--surface-3))"></i></span>
          <span class="legend"><i style="background: color-mix(in srgb, var(--brand) 50%, var(--surface-3))"></i></span>
          <span class="legend"><i style="background: color-mix(in srgb, var(--brand) 75%, var(--surface-3))"></i></span>
          <span class="legend"><i style="background: var(--brand)"></i></span>
          <span class="legend">多</span>
          <span class="spacer"></span>
          <span class="legend">第一次记录：{{ stats.firstDate }}</span>
        </div>
      </div>

      <!-- 习惯 -->
      <div class="two-col">
        <div>
          <div class="section-title"><h2>哪天记得最多</h2></div>
          <div class="card card-pad">
            <div v-for="w in weekdayStats" :key="w.label" class="bar-row">
              <span class="name">{{ w.label }}</span>
              <span class="bar"><i :style="{ width: `${w.pct}%` }"></i></span>
              <span class="cnt">{{ w.count }}</span>
            </div>
          </div>
        </div>

        <div>
          <div class="section-title"><h2>什么时候记的</h2></div>
          <div class="card card-pad">
            <div v-for="h in hourStats" :key="h.label" class="bar-row">
              <span class="name">{{ h.label.split(' ')[0] }}</span>
              <span class="bar"><i :style="{ width: `${h.pct}%`, background: 'linear-gradient(90deg, var(--ai-soft), var(--ai))' }"></i></span>
              <span class="cnt">{{ h.count }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 标签 -->
      <template v-if="tagStats.length">
        <div class="section-title">
          <h2><Icon name="tag" :size="17" /> 高频标签</h2>
          <span class="sub">共 {{ stats.tags.length }} 个</span>
        </div>
        <div class="card card-pad">
          <div v-for="t in tagStats" :key="t.name" class="bar-row">
            <span class="name">#{{ t.name }}</span>
            <span class="bar"><i :style="{ width: `${t.pct}%` }"></i></span>
            <span class="cnt">{{ t.count }}</span>
          </div>
        </div>
      </template>

      <!-- 语音记录 -->
      <template v-if="voiceStats.count">
        <div class="section-title">
          <h2><Icon name="mic" :size="17" /> 语音记录</h2>
          <span class="sub">说出的话也是记录</span>
        </div>
        <div class="stat-grid">
          <div class="stat-box">
            <div class="k">语音条数</div>
            <div class="v">{{ voiceStats.count }}<span class="u">条</span></div>
          </div>
          <div class="stat-box">
            <div class="k">总时长</div>
            <div class="v">{{ voiceStats.minutes }}<span class="u">分钟</span></div>
          </div>
          <div class="stat-box">
            <div class="k">占用空间</div>
            <div class="v">{{ voiceStats.size }}<span class="u">MB</span></div>
          </div>
          <div class="stat-box">
            <div class="k">AI 提炼要点</div>
            <div class="v">{{ voiceStats.points }}<span class="u">条</span></div>
          </div>
        </div>
      </template>

      <!-- 按月 -->
      <div class="section-title">
        <h2><Icon name="history" :size="17" /> 最近几个月</h2>
      </div>
      <div class="card card-pad">
        <div v-for="m in byMonth" :key="m.month" class="bar-row">
          <span class="name wide">{{ monthLabel(m.month) }}</span>
          <span class="bar"><i :style="{ width: `${m.pct}%` }"></i></span>
          <span class="cnt">{{ m.count }}</span>
        </div>
      </div>

      <p class="foot-note">
        合计写下约 <b class="num">{{ (stats.chars / 1000).toFixed(1) }}k</b> 字。
        这些字以后你自己会想看的。
      </p>
    </template>
  </div>
</template>

<style scoped>
/* 顶部概览条：一眼看到最关键的三个数字 */
.hero-strip {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 15px 18px;
  margin-bottom: 18px;
  border-radius: var(--r-lg);
  background: linear-gradient(135deg, var(--brand-tint), var(--ai-tint));
  border: 1px solid color-mix(in srgb, var(--brand) 16%, transparent);
}

.hs-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  min-width: 0;
}

.hs-item b {
  font-size: 1.5rem;
  font-weight: 680;
  letter-spacing: -0.03em;
  line-height: 1.15;
  color: var(--brand-deep);
}

:root[data-theme='dark'] .hs-item b {
  color: var(--brand-soft);
}

.hs-item.hot b {
  color: var(--amber-text);
}

.hs-item span {
  font-size: 0.74rem;
  color: var(--text-2);
  white-space: nowrap;
}

.hs-sep {
  width: 1px;
  height: 26px;
  background: var(--border-2);
  flex: 0 0 auto;
}

.heat-foot {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 12px;
  flex-wrap: wrap;
}

.heat-foot .spacer {
  flex: 1;
}

.two-col {
  display: grid;
  gap: 0;
}

@media (min-width: 720px) {
  .two-col {
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
}

.foot-note {
  margin-top: 24px;
  font-size: 0.84rem;
  color: var(--text-3);
  text-align: center;
  line-height: 1.8;
}

.foot-note b {
  color: var(--brand-deep);
}

:root[data-theme='dark'] .foot-note b {
  color: var(--brand-soft);
}
</style>
