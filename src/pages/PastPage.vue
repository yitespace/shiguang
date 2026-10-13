<script setup lang="ts">
// =============================================================
// 过往
// 把原来的「记录」和「日历」合成一页：上面日历，下面时间线。
//   点日历某一天 → 时间线滚到那天
//   时间线自己滚动时 → 日历高亮跟着变
// 这样既有一眼看全局的月历，又有连续的阅读流，不用在两页之间跳。
// =============================================================
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import Icon from '../components/Icon.vue';
import EntryCard from '../components/EntryCard.vue';
import MemoryCard from '../components/MemoryCard.vue';
import * as api from '../lib/api';
import { addMonths, calendarGrid, monthLabel, monthOf, relativeDay, shortDate, today, weekdayOf } from '../lib/date';
import { renderMarkdown } from '../lib/markdown';
import { entries, online, pendingCount, refresh, saveEntry, stats, toast } from '../lib/store';
import type { DaySummary } from '../types';

const route = useRoute();
const WEEK = ['一', '二', '三', '四', '五', '六', '日'];

const month = ref(monthOf(today()));
const selected = ref(today());
const counts = ref<Record<string, number>>({});
const loadingMonth = ref(false);
const expanded = ref(false);
const memoryRef = ref<InstanceType<typeof MemoryCard> | null>(null);
const timelineEl = ref<HTMLElement | null>(null);

// 快速记录
const quick = ref('');
const quickInput = ref<HTMLTextAreaElement | null>(null);

// 按天 AI 回顾
const summaries = ref<Record<string, DaySummary | 'loading'>>({});

const grid = computed(() => calendarGrid(month.value));
const monthTotal = computed(() => Object.values(counts.value).reduce((s, n) => s + n, 0));
const activeDays = computed(() => Object.keys(counts.value).length);
const maxCount = computed(() => Math.max(1, ...Object.values(counts.value)));

/** 时间线按天分组，倒序 */
const groups = computed(() => {
  const map = new Map<string, typeof entries.value>();
  for (const e of entries.value) {
    if (!map.has(e.date)) map.set(e.date, []);
    map.get(e.date)!.push(e);
  }
  for (const list of map.values()) list.sort((a, b) => b.createdAt - a.createdAt);
  const all = [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  return expanded.value ? all : all.slice(0, 30);
});
const hiddenDays = computed(() => {
  const total = new Set(entries.value.map((e) => e.date)).size;
  return Math.max(0, total - 30);
});

/**
 * 未来的日子。
 * 记录只可能发生在过去和现在，未来的格子点了也只会弹「没有记录」，
 * 所以直接不给点——省得人以为是自己记漏了。
 * 唯一的例外：那天真有记录（导入的历史数据、或手工补过日期），那就照常可选。
 */
function isFuture(date: string): boolean {
  return date > today();
}

/** 强度分档：给日历格子按条数上色 */
function level(date: string): number {
  const n = counts.value[date] || 0;
  if (!n) return 0;
  const r = n / maxCount.value;
  if (r > 0.75) return 4;
  if (r > 0.5) return 3;
  if (r > 0.25) return 2;
  return 1;
}

async function loadMonth() {
  loadingMonth.value = true;
  try {
    const res = await api.getCalendar(month.value);
    counts.value = res.counts || {};
  } catch {
    counts.value = {};
  } finally {
    loadingMonth.value = false;
  }
}

/** 点日历：选中并把时间线滚到那天 */
async function pick(date: string) {
  if (!date) return;
  if (isFuture(date) && !counts.value[date]) {
    toast(`${shortDate(date)} 还没到呢`);
    return;
  }
  selected.value = date;
  if (monthOf(date) !== month.value) month.value = monthOf(date);
  await nextTick();
  const el = timelineEl.value?.querySelector(`[data-date="${date}"]`) as HTMLElement | null;
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    // 那天没有记录，给个明确反馈，别让人以为点了没反应
    toast(`${shortDate(date)} 没有记录`);
  }
}

function shiftMonth(n: number) {
  if (n > 0 && !canGoNext.value) return;
  month.value = addMonths(month.value, n);
}

/**
 * 方向键换月。
 * 桌面端看日历，← → 是最自然的手势；只在「过往」这一页生效
 * （组件卸载时摘掉监听），也不抢输入框里的光标移动。
 */
function onArrow(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    shiftMonth(-1);
  } else if (e.key === 'ArrowRight' && canGoNext.value) {
    e.preventDefault();
    shiftMonth(1);
  }
}

function goToday() {
  month.value = monthOf(today());
  pick(today());
}

/** 时间线滚动时，日历高亮跟着走（用滚动位置反推当前是哪一天） */
let scrollTimer: number | undefined;
function onTimelineScroll() {
  window.clearTimeout(scrollTimer);
  scrollTimer = window.setTimeout(() => {
    const heads = timelineEl.value?.querySelectorAll('[data-date]');
    if (!heads?.length) return;
    const top = 120;
    for (const h of Array.from(heads)) {
      const r = (h as HTMLElement).getBoundingClientRect();
      if (r.bottom > top) {
        const d = (h as HTMLElement).dataset.date || '';
        if (d && d !== selected.value && monthOf(d) === month.value) selected.value = d;
        break;
      }
    }
  }, 180);
}

async function submitQuick() {
  const text = quick.value.trim();
  if (!text) return;
  quick.value = '';
  await saveEntry({ content: text });
  toast('已记下');
}

async function loadSummary(date: string, force = false) {
  summaries.value = { ...summaries.value, [date]: 'loading' };
  try {
    const res = await api.summarizeDay(date, force);
    summaries.value = { ...summaries.value, [date]: res };
  } catch (e: any) {
    summaries.value = { ...summaries.value, [date]: { date, summary: e?.message || '生成失败' } };
  }
}

function recordHere() {
  window.dispatchEvent(new CustomEvent('sg:record'));
}

/**
 * 一句话直接开录。
 * 首页这一排就是「抬手就能记」的地方：打字点输入框，说话点麦克风，
 * 都不该再经过中间的选择层。
 */
function speakHere() {
  window.dispatchEvent(new CustomEvent('sg:voice'));
}

/** 空状态里的「从服务器重新拉取」：手动重来一次，别让人以为记录没了 */
const pulling = ref(false);
async function pullAgain() {
  pulling.value = true;
  try {
    await refresh();
    await loadMonth();
    if (entries.value.length) toast(`拉回来 ${entries.value.length} 条`);
    else toast('服务器上也还没有记录');
  } finally {
    pulling.value = false;
  }
}

onMounted(async () => {
  const wanted = route.query.d;
  const jumped = typeof wanted === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(wanted);
  if (jumped) {
    selected.value = wanted as string;
    month.value = monthOf(wanted as string);
  }
  await refresh({ silent: true });
  await loadMonth();
  await nextTick();
  // 只有带 ?d= 明确指定某天时才跳过去。
  // 平时进来停在顶部——日历是这一页的主角，一进来就滚走等于白做了。
  if (jumped) {
    const el = timelineEl.value?.querySelector(`[data-date="${selected.value}"]`) as HTMLElement | null;
    if (el) el.scrollIntoView({ block: 'start' });
  }
  window.addEventListener('scroll', onTimelineScroll, { passive: true });
  window.addEventListener('keydown', onArrow);
});

onUnmounted(() => {
  window.removeEventListener('scroll', onTimelineScroll);
  window.removeEventListener('keydown', onArrow);
  window.clearTimeout(scrollTimer);
});

watch(month, async () => {
  await loadMonth();
  if (monthOf(selected.value) !== month.value) {
    const withData = Object.keys(counts.value).sort().reverse()[0];
    selected.value = withData || `${month.value}-01`;
  }
});

watch(
  () => route.query.d,
  (d) => {
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
      selected.value = d;
      month.value = monthOf(d);
      nextTick(() => pick(d));
    }
  },
);

// 记录条数变了，重新翻那年今日
watch(
  () => entries.value.length,
  () => memoryRef.value?.reload(),
);

const isCurrentMonth = computed(() => month.value === monthOf(today()));
/** 能不能往后翻：翻到当月就到头了，再往后整片格子都是灰的，没意义 */
const canGoNext = computed(() => month.value < monthOf(today()));
</script>

<template>
  <div class="past-page">
    <div class="page-head">
      <div>
        <h1><Icon name="book" :size="22" /> 过往</h1>
        <p class="sub">
          {{ stats?.total ?? 0 }} 条记录 · {{ stats?.days ?? 0 }} 天
          <template v-if="(stats?.streak ?? 0) >= 3"> · 连续 {{ stats?.streak }} 天</template>
        </p>
      </div>
      <button v-if="!isCurrentMonth" class="btn btn-sm" @click="goToday">回到今天</button>
    </div>

    <!-- ============ 上：月历 ============ -->
    <section class="cal card">
      <header class="cal-head">
        <button class="cal-nav" title="上个月（←）" aria-label="上个月" @click="shiftMonth(-1)">
          <Icon name="arrowLeft" :size="17" />
        </button>
        <div class="cal-title">
          <b>{{ monthLabel(month) }}</b>
          <small v-if="loadingMonth">载入中…</small>
          <small v-else-if="monthTotal">{{ monthTotal }} 条 · {{ activeDays }} 天</small>
          <small v-else>这个月还没有记录</small>
        </div>
        <button
          class="cal-nav"
          :disabled="!canGoNext"
          :title="canGoNext ? '下个月（→）' : '已经是最新的一个月了'"
          aria-label="下个月"
          @click="shiftMonth(1)"
        >
          <Icon name="arrowRight" :size="17" />
        </button>
      </header>

      <div class="cal-week">
        <span v-for="(w, i) in WEEK" :key="w" :class="{ weekend: i >= 5 }">{{ w }}</span>
      </div>

      <div class="cal-days">
        <button
          v-for="(d, i) in grid"
          :key="i"
          class="cal-day"
          :class="[
            d ? `lv${level(d)}` : 'is-blank',
            d && isFuture(d) && !counts[d] ? 'is-future' : '',
            d === today() ? 'is-today' : '',
            d === selected ? 'is-selected' : '',
          ]"
          :disabled="!d || (isFuture(d) && !counts[d])"
          :aria-label="d ? `${d}，${counts[d] || 0} 条记录` : undefined"
          @click="pick(d)"
        >
          <template v-if="d">
            <span class="cal-num">{{ Number(d.slice(-2)) }}</span>
            <span v-if="counts[d]" class="cal-dot"></span>
          </template>
        </button>
      </div>
    </section>

    <!-- ============ 快速记录 ============ -->
    <section class="quick card">
      <div class="field quick-field">
        <textarea
          ref="quickInput"
          v-model="quick"
          rows="1"
          placeholder="此刻发生了什么？回车记下"
          aria-label="快速记录"
          @keydown.enter.exact.prevent="submitQuick"
        ></textarea>
        <button class="quick-mic" title="说一句（直接开录）" aria-label="说一句" @click="speakHere">
          <Icon name="mic" :size="17" />
        </button>
        <button class="quick-send" :disabled="!quick.trim()" title="记下" aria-label="记下" @click="submitQuick">
          <Icon name="check" :size="16" />
        </button>
      </div>
    </section>

    <div v-if="!online || pendingCount" class="banner" style="margin-top: 12px">
      <Icon name="wifiOff" :size="18" />
      <span>{{ online ? `有 ${pendingCount} 条待同步` : '离线中，记录会先存在本机' }}</span>
    </div>

    <!-- 那年今日 -->
    <MemoryCard ref="memoryRef" :date="selected" />

    <!-- ============ 下：时间线 ============ -->
    <div ref="timelineEl" class="timeline">
      <div v-if="!entries.length" class="empty card">
        <span class="big">🌱</span>
        <p class="tip">
          还没有任何记录。<br />
          在下面写一句，或者点麦克风说一句，都算数。
        </p>
        <div class="empty-actions">
          <button class="btn btn-primary btn-sm" @click="recordHere">
            <Icon name="plus" :size="15" /> 记一笔
          </button>
          <button class="btn btn-sm" @click="speakHere">
            <Icon name="mic" :size="15" /> 说一句
          </button>
          <!--
            已经写过东西却看到这一屏，多半是这台设备上的副本还没拉下来
            （换了手机、刚清了缓存、或者首次加载正好没成功）。
            给一个明确的重新拉取入口，别让人以为记录丢了。
          -->
          <button class="btn btn-sm" :disabled="pulling" @click="pullAgain">
            <Icon name="refresh" :size="15" /> {{ pulling ? '正在拉取…' : '从服务器重新拉取' }}
          </button>
        </div>
      </div>

      <section v-for="[date, list] in groups" :key="date" :data-date="date" class="day-group">
        <header class="day-head">
          <span class="day-date">{{ shortDate(date) }}</span>
          <span class="day-wd">周{{ weekdayOf(date) }}</span>
          <span v-if="relativeDay(date)" class="day-rel">{{ relativeDay(date) }}</span>
          <span class="day-line"></span>
          <span class="day-count num">{{ list.length }} 条</span>
          <button class="day-ai" title="让 AI 回顾这一天" aria-label="AI 回顾这一天" @click="loadSummary(date)">
            <Icon name="sparkles" :size="14" />
          </button>
        </header>

        <Transition name="fade">
          <div v-if="summaries[date]" class="day-summary">
            <div v-if="summaries[date] === 'loading'" class="think-dot"><i></i><i></i><i></i></div>
            <div
              v-else
              class="recap-md"
              v-html="renderMarkdown((summaries[date] as DaySummary).summary || '（这一天没有内容）')"
            ></div>
          </div>
        </Transition>

        <EntryCard v-for="e in list" :key="e.id" :entry="e" clamp />
      </section>

      <button v-if="!expanded && hiddenDays > 0" class="btn btn-block show-more" @click="expanded = true">
        还有 {{ hiddenDays }} 天的记录，展开全部
      </button>
      <button v-else-if="expanded && hiddenDays > 0" class="btn btn-block show-more" @click="expanded = false">
        收起，只看最近
      </button>
    </div>

    <div class="tail" aria-hidden="true"></div>
  </div>
</template>

<style scoped>
/* ---------- 月历（紧凑版） ---------- */
.cal {
  padding: 12px 14px 10px;
  user-select: none;
  -webkit-user-select: none;
}

.cal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}

.cal-nav {
  flex: 0 0 auto;
  width: 34px;
  height: 34px;
  border-radius: 11px;
  display: grid;
  place-items: center;
  color: var(--text-2);
  background: var(--surface-2);
  border: 1px solid var(--border);
  transition: background var(--dur), transform var(--dur);
}

.cal-nav:hover {
  background: var(--surface-3);
  color: var(--text);
}

.cal-nav:active {
  transform: scale(0.92);
}

.cal-nav:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}

.cal-nav:disabled:hover {
  background: var(--surface-2);
  color: var(--text-2);
}

.cal-nav:disabled:active {
  transform: none;
}

.cal-title {
  text-align: center;
  line-height: 1.25;
  min-width: 0;
}

.cal-title b {
  display: block;
  font-size: 1rem;
  font-weight: 660;
  letter-spacing: -0.01em;
}

.cal-title small {
  display: block;
  font-size: 0.7rem;
  color: var(--text-3);
  margin-top: 1px;
}

.cal-week {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
  margin-bottom: 3px;
}

.cal-week span {
  text-align: center;
  font-size: 0.7rem;
  font-weight: 560;
  color: var(--text-3);
  padding: 2px 0;
}

.cal-week span.weekend {
  color: var(--text-2);
}

.cal-days {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
}

.cal-day {
  position: relative;
  aspect-ratio: 1 / 1;
  min-height: 38px;
  border-radius: 11px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  font-size: 0.84rem;
  font-variant-numeric: tabular-nums;
  color: var(--text-2);
  background: transparent;
  border: 1.5px solid transparent;
  transition: background var(--dur) var(--ease), color var(--dur), border-color var(--dur), transform 0.16s var(--spring);
}

.cal-day:not(.is-blank):hover {
  background: var(--surface-2);
}

.cal-day:not(.is-blank):active {
  transform: scale(0.93);
}

.cal-day.is-blank {
  pointer-events: none;
  visibility: hidden;
}

/*
 * 还没到的日子：压淡、去掉一切交互反馈。
 * 不用 display:none 是故意的——日历要保住 7 列的骨架，
 * 抽掉几格会让整个月看起来是错的。
 */
.cal-day.is-future {
  color: var(--text-3);
  opacity: 0.45;
  cursor: default;
}

.cal-day.is-future:disabled {
  background: transparent;
  border-color: transparent;
}

/* 有记录：按条数上色，底色只做浅层区分 */
.cal-day.lv1 { background: color-mix(in srgb, var(--brand) 10%, transparent); color: var(--brand-deep); font-weight: 600; }
.cal-day.lv2 { background: color-mix(in srgb, var(--brand) 20%, transparent); color: var(--brand-deep); font-weight: 620; }
.cal-day.lv3 { background: color-mix(in srgb, var(--brand) 34%, transparent); color: var(--brand-deep); font-weight: 640; }
/*
 * 记满的那一天。
 * 原来是「品牌色 50% 淡底 + 白字」，实测白字只有 1.99:1，基本看不清。
 * 改成实心品牌色：亮色是深紫配白字（7.6:1），暗色是亮紫配深墨字（5.6:1），
 * 既达标，也让「最忙的一天」在日历上更跳得出来。
 */
.cal-day.lv4 { background: var(--brand-deep); color: #fff; font-weight: 660; }

:root[data-theme='dark'] .cal-day.lv4 { background: var(--brand); color: #150f38; }

/*
 * 暗色下 --brand-deep 是深紫，压在同样偏暗的淡底上只有 2.3:1。
 * 淡底上的数字改用亮紫（--brand-soft），实测 5.4:1。
 */
:root[data-theme='dark'] .cal-day.lv1,
:root[data-theme='dark'] .cal-day.lv2,
:root[data-theme='dark'] .cal-day.lv3 {
  color: var(--brand-soft);
}

.cal-day.is-today {
  border-color: var(--brand);
}

.cal-day.is-selected {
  background: var(--brand);
  color: #fff;
  border-color: var(--brand);
  font-weight: 700;
}

/* 白字压亮紫只有 3.2:1，暗色下选中态换深墨字（5.6:1） */
:root[data-theme='dark'] .cal-day.is-selected {
  color: #150f38;
}

.cal-num {
  line-height: 1;
}

/* 用小圆点表示「有记录」，比数字徽标更安静 */
.cal-dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.55;
}

.cal-day.is-selected .cal-dot {
  opacity: 0.95;
  background: #fff;
}

/* ---------- 快速记录 ---------- */
.quick {
  margin-top: 12px;
  padding: 10px 12px;
}

.quick-field {
  align-items: flex-end;
  gap: 8px;
}

.quick-field textarea {
  min-height: 34px;
  max-height: 140px;
  line-height: 1.7;
  padding: 5px 0;
}

/* 麦克风：跟输入框同一排，点一下直接开始录音 */
.quick-mic {
  flex: 0 0 auto;
  width: 34px;
  height: 34px;
  border-radius: 11px;
  display: grid;
  place-items: center;
  color: var(--ai-text);
  background: var(--ai-tint);
  transition: transform var(--dur), background var(--dur);
}

.quick-mic:hover {
  background: var(--surface-3);
}

.quick-mic:active {
  transform: scale(0.92);
}

.quick-send {
  flex: 0 0 auto;
  width: 34px;
  height: 34px;
  border-radius: 11px;
  display: grid;
  place-items: center;
  color: #fff;
  background: linear-gradient(135deg, var(--brand), var(--brand-deep));
  box-shadow: var(--shadow-glow);
  transition: transform var(--dur), opacity var(--dur);
}

.quick-send:disabled {
  opacity: var(--disabled-opacity);
  box-shadow: none;
}

.quick-send:active {
  transform: scale(0.92);
}

/* ---------- 时间线 ---------- */
.timeline {
  margin-top: 20px;
}

.day-group + .day-group {
  margin-top: 22px;
}

.day-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 2px 9px;
  position: sticky;
  top: 52px;
  z-index: 20;
  background: linear-gradient(180deg, var(--bg) 72%, transparent);
}

.day-date {
  font-weight: 660;
  font-size: 0.92rem;
  letter-spacing: -0.01em;
}

.day-wd {
  font-size: 0.74rem;
  color: var(--text-3);
}

.day-rel {
  font-size: 0.7rem;
  padding: 1px 8px;
  border-radius: var(--r-full);
  background: var(--brand-tint);
  color: var(--brand-deep);
  font-weight: 620;
}

:root[data-theme='dark'] .day-rel {
  color: var(--brand-soft);
}

.day-line {
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, var(--border-2), transparent);
}

.day-count {
  font-size: 0.74rem;
  color: var(--text-3);
  white-space: nowrap;
}

.day-ai {
  display: grid;
  place-items: center;
  width: 25px;
  height: 25px;
  border-radius: 9px;
  color: var(--ai-text);
  background: var(--ai-tint);
  transition: transform var(--dur);
}

.day-ai:active {
  transform: scale(0.9);
}

.day-summary {
  padding: 12px 14px;
  margin-bottom: 9px;
  border-radius: var(--r);
  background: var(--ai-tint);
  border: 1px solid color-mix(in srgb, var(--ai) 22%, transparent);
  font-size: 0.89rem;
  line-height: 1.75;
}

.recap-md :deep(p) {
  margin: 0 0 7px;
}

.recap-md :deep(p:last-child) {
  margin-bottom: 0;
}

.recap-md :deep(ul) {
  margin: 5px 0;
  padding-left: 19px;
}

.empty {
  padding: 42px 20px;
}

.empty-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
  margin-top: 4px;
}

.show-more {
  margin-top: 16px;
}

.tail {
  height: 96px;
}

/*
 * 桌面端：主内容列宽 720px，如果日历也铺满，每个格子会变成 100×100 的
 * 大方块，数字孤零零飘在中间，既浪费空间又不像日历。
 * 这里把日历本体和快速记录都夹到 448px 居中——格子回到 ~62px 的方形，
 * 卡片两侧留白就当是呼吸感。
 */
@media (min-width: 720px) {
  .cal-head,
  .cal-week,
  .cal-days,
  .quick-field {
    max-width: 448px;
    margin-left: auto;
    margin-right: auto;
  }

  .cal {
    padding: 20px 22px 22px;
  }
}
</style>
