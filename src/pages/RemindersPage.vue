<script setup lang="ts">
// =============================================================
// 快捷提醒
//
// 两条来路：
//   1. 你在别处写的记录里被 AI 认出「到点要做的事」，会浮一张卡问你要不要设
//      （那条路在记录保存之后自动跑，见 components/ReminderPrompt.vue）
//   2. 就是现在这一页，自己手动加一条
//
// 所以这一页的重点不是「怎么加」，而是「加过的东西现在什么状态」——
// 用户回来多半是想确认「我那个提醒到底设上没有」。
// =============================================================
import { computed, onMounted, ref } from 'vue';
import Icon from '../components/Icon.vue';
import * as care from '../lib/care';
import { toast } from '../lib/store';
import { notifyStatus, refreshSchedule, requestNotifyPermission, testNotify, type NotifyStatus } from '../lib/native';

const loading = ref(true);
const upcoming = ref<(care.Reminder & { fireAt: number })[]>([]);
const past = ref<care.Reminder[]>([]);
const notify = ref<NotifyStatus | null>(null);

const addOpen = ref(false);
const form = ref({ title: '', date: '', time: '', advance: 10, alarm: false });

const ADVANCES = [0, 5, 10, 15, 30, 60, 120];

function localDate(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function localTime(d = new Date(Date.now() + 3600_000)) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function openAdd() {
  form.value = { title: '', date: localDate(), time: localTime(), advance: 10, alarm: false };
  addOpen.value = true;
}

async function load() {
  loading.value = true;
  try {
    const r = await care.listReminders();
    upcoming.value = r.upcoming;
    past.value = r.past;
  } catch (e: any) {
    toast(e?.message || '加载失败');
  } finally {
    loading.value = false;
  }
}

async function sync() {
  try {
    await refreshSchedule(care.getSchedule, 7);
  } catch {
    /* 排不上不该挡住页面 */
  }
}

async function add() {
  const f = form.value;
  if (!f.title.trim()) return toast('给这条提醒起个名字');
  if (!f.date || !f.time) return toast('得选个时间');
  try {
    await care.saveReminder({
      title: f.title.trim(),
      at: `${f.date}T${f.time}`,
      advance: f.advance,
      alarm: f.alarm,
      source: 'manual',
    });
    addOpen.value = false;
    toast('设好了');
    await load();
    await sync();
  } catch (e: any) {
    toast(e?.message || '没设上');
  }
}

async function remove(r: care.Reminder) {
  try {
    await care.removeReminder(r.id);
    toast('删掉了');
    await load();
    await sync();
  } catch (e: any) {
    toast(e?.message || '删除失败');
  }
}

async function markDone(r: care.Reminder) {
  try {
    await care.saveReminder({ id: r.id, title: r.title, at: r.at, advance: r.advance, done: true });
    await load();
    await sync();
  } catch (e: any) {
    toast(e?.message || '操作失败');
  }
}

/** 「3 小时后」「明天 09:00」这种相对说法比绝对时间好读 */
function when(ts: number) {
  const diff = ts - Date.now();
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const today = localDate();
  const day = localDate(d);
  const tomorrow = localDate(new Date(Date.now() + 86400000));
  if (diff < 0) return `${day === today ? '今天' : day} ${hm}`;
  if (diff < 3600_000) return `${Math.max(1, Math.round(diff / 60000))} 分钟后`;
  if (diff < 6 * 3600_000) return `${Math.round(diff / 3600_000)} 小时后`;
  if (day === today) return `今天 ${hm}`;
  if (day === tomorrow) return `明天 ${hm}`;
  return `${day.slice(5).replace('-', '/')} ${hm}`;
}

async function enableNotify() {
  const p = await requestNotifyPermission();
  notify.value = await notifyStatus();
  if (p === 'granted') {
    toast('可以了');
    await sync();
  } else if (p === 'denied') {
    toast('系统里把通知关掉了，得去设置里打开');
  }
}

async function tryTest() {
  const ok = await testNotify();
  toast(ok ? '弹出来了，看到了吗' : '没弹出来，检查一下通知权限');
}

const notifyNote = computed(() => notify.value?.note || '');

onMounted(async () => {
  await Promise.all([load(), (async () => (notify.value = await notifyStatus()))()]);
  await sync();
});
</script>

<template>
  <div class="reminders-page">
    <div class="page-head">
      <div>
        <h1>快捷提醒</h1>
        <p class="sub">你说过的「几点要干嘛」，到点拉你一把</p>
      </div>
      <button class="icon-btn" title="加一条" aria-label="加一条" @click="openAdd">
        <Icon name="plus" :size="19" />
      </button>
    </div>

    <div v-if="notify && notify.permission !== 'granted'" class="card notice">
      <span class="notice-icon"><Icon name="alert" :size="17" /></span>
      <div class="notice-body">
        <b>{{ notify.permission === 'unsupported' ? '这个环境收不到提醒' : '还没打开通知' }}</b>
        <p>{{ notifyNote || '不打开通知的话，到点不会有任何提示。' }}</p>
      </div>
      <button v-if="notify.permission !== 'unsupported'" class="btn btn-sm btn-primary" @click="enableNotify">打开</button>
    </div>
    <div v-else-if="notify" class="card notice soft">
      <span class="notice-icon ok"><Icon name="check" :size="17" /></span>
      <div class="notice-body">
        <b>提醒是通的</b>
        <p>{{ notify.background ? 'App 关着也能准时响。' : notifyNote }}</p>
      </div>
      <button class="btn btn-sm" @click="tryTest">试一条</button>
    </div>

    <section class="group">
      <h2 class="group-title">接下来</h2>
      <div v-if="loading" class="card pad muted">正在读…</div>
      <div v-else-if="!upcoming.length" class="card empty">
        <span class="big"><Icon name="bell" :size="28" /></span>
        <p class="tip">
          还没有设提醒。<br />
          写记录的时候提到「晚上十点有个会」这类事，我会主动问你要不要提醒。
        </p>
        <button class="btn btn-primary" @click="openAdd"><Icon name="plus" :size="16" /> 自己加一条</button>
      </div>
      <ul v-else class="card list">
        <li v-for="r in upcoming" :key="r.id" class="row">
          <span class="r-time">
            <b>{{ when(r.fireAt) }}</b>
            <em v-if="r.advance > 0">提前 {{ r.advance }} 分</em>
          </span>
          <span class="r-main">
            <b>{{ r.title }}</b>
            <em v-if="r.quote">{{ r.quote }}</em>
            <em v-else class="dim">定在 {{ r.at.replace('T', ' ') }}</em>
          </span>
          <span v-if="r.source === 'note'" class="r-from" title="从记录里认出来的"><Icon name="sparkles" :size="13" /></span>
          <span v-if="r.alarm" class="r-from" title="闹钟模式"><Icon name="bell" :size="13" /></span>
          <button class="icon-btn sm" title="完成" @click="markDone(r)"><Icon name="check" :size="16" /></button>
          <button class="icon-btn sm" title="删掉" @click="remove(r)"><Icon name="trash" :size="16" /></button>
        </li>
      </ul>
    </section>

    <section v-if="past.length" class="group">
      <h2 class="group-title">已经过去</h2>
      <ul class="card list faded">
        <li v-for="r in past.slice(0, 12)" :key="r.id" class="row">
          <span class="r-time"><b>{{ r.at.slice(5).replace('T', ' ') }}</b></span>
          <span class="r-main"><b>{{ r.title }}</b></span>
          <span v-if="r.done" class="r-done">已完成</span>
          <button class="icon-btn sm" title="删掉" @click="remove(r)"><Icon name="trash" :size="16" /></button>
        </li>
      </ul>
    </section>

    <!-- ============ 加一条 ============ -->
    <Transition name="sheet">
      <div v-if="addOpen" class="sheet-mask" @click.self="addOpen = false">
        <div class="sheet">
          <div class="sheet-grabber"></div>
          <header class="sheet-head">
            <h3>加一条提醒</h3>
            <button class="icon-btn" title="关闭" @click="addOpen = false"><Icon name="x" :size="19" /></button>
          </header>
          <div class="sheet-body">
            <label class="field">
              <span>要干什么</span>
              <input v-model="form.title" type="text" maxlength="40" placeholder="开会 / 复诊 / 交材料" />
            </label>
            <div class="two">
              <label class="field">
                <span>哪天</span>
                <input v-model="form.date" type="date" />
              </label>
              <label class="field">
                <span>几点</span>
                <input v-model="form.time" type="time" />
              </label>
            </div>
            <div class="field">
              <span>提前多久提醒</span>
              <div class="chips">
                <button
                  v-for="a in ADVANCES"
                  :key="a"
                  class="chip"
                  :class="{ active: form.advance === a }"
                  @click="form.advance = a"
                >
                  {{ a === 0 ? '准点' : `${a} 分` }}
                </button>
              </div>
            </div>
            <label class="switch">
              <input v-model="form.alarm" type="checkbox" />
              <span>
                <b>用闹钟提醒</b>
                <em>到点响铃，静音也响，必须手动关掉。重要的事再勾。</em>
              </span>
            </label>
            <button class="btn btn-primary wide" @click="add">设好</button>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
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

.pad {
  padding: 18px 16px;
}

.muted {
  color: var(--text-3);
  font-size: 0.9rem;
}

.notice {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 12px 14px;
  margin-top: 14px;
  border-color: var(--border-2);
  background: var(--amber-tint);
}

.notice.soft {
  border-color: var(--border);
  background: var(--surface-2);
}

.notice-icon {
  flex: 0 0 auto;
  color: var(--amber-text);
  display: grid;
  place-items: center;
}

.notice-icon.ok {
  color: var(--ai-text);
}

.notice-body {
  flex: 1;
  min-width: 0;
}

.notice-body b {
  display: block;
  font-size: 0.9rem;
  font-weight: 620;
}

.notice-body p {
  margin: 2px 0 0;
  font-size: 0.8rem;
  color: var(--text-2);
  line-height: 1.5;
}

.empty {
  padding: 30px 20px;
  text-align: center;
}

.empty .big {
  color: var(--brand);
  display: inline-grid;
  place-items: center;
  margin-bottom: 8px;
}

.empty .tip {
  margin: 0 0 14px;
  color: var(--text-2);
  font-size: 0.9rem;
  line-height: 1.75;
}

.list {
  list-style: none;
  margin: 0;
  padding: 4px 0;
}

.list.faded {
  opacity: 0.72;
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 14px;
}

.row + .row {
  border-top: 1px solid var(--border);
}

.r-time {
  flex: 0 0 auto;
  width: 82px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.r-time b {
  font-size: 0.82rem;
  font-weight: 640;
  color: var(--brand-deep);
}

.r-time em {
  font-style: normal;
  font-size: 0.7rem;
  color: var(--text-3);
}

.r-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.r-main b {
  font-size: 0.92rem;
  font-weight: 600;
}

.r-main em {
  font-style: normal;
  font-size: 0.78rem;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.r-main em.dim {
  color: var(--text-3);
}

.r-from {
  flex: 0 0 auto;
  color: var(--text-3);
  display: grid;
  place-items: center;
}

.r-done {
  flex: 0 0 auto;
  font-size: 0.72rem;
  padding: 1px 7px;
  border-radius: var(--r-full);
  background: var(--ai-tint);
  color: var(--ai-text);
}

/* ---------- 面板 ---------- */
.sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 16px 12px;
}

.sheet-head h3 {
  margin: 0;
  font-size: 1.02rem;
  font-weight: 650;
}

.sheet-body {
  padding: 0 16px calc(20px + var(--safe-bottom));
}

.field {
  display: block;
  margin-bottom: 12px;
}

.field > span {
  display: block;
  font-size: 0.78rem;
  color: var(--text-3);
  margin-bottom: 5px;
}

.field input {
  width: 100%;
  padding: 9px 12px;
  border-radius: var(--r-sm);
  background: var(--surface-2);
  border: 1px solid var(--border);
  font: inherit;
  font-size: 0.9rem;
  color: var(--text);
}

.field input:focus {
  outline: none;
  border-color: var(--brand);
}

.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip {
  padding: 6px 13px;
  border-radius: var(--r-full);
  background: var(--surface-2);
  border: 1px solid var(--border);
  font-size: 0.82rem;
  color: var(--text-2);
  transition: all var(--dur);
}

.chip.active {
  background: var(--brand);
  border-color: var(--brand);
  color: #fff;
  font-weight: 600;
}

.switch {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  margin: 4px 0 18px;
}

.switch input {
  margin-top: 3px;
  width: 17px;
  height: 17px;
  accent-color: var(--brand);
  flex: 0 0 auto;
}

.switch b {
  display: block;
  font-size: 0.88rem;
  font-weight: 600;
}

.switch em {
  display: block;
  font-style: normal;
  font-size: 0.76rem;
  color: var(--text-3);
  line-height: 1.55;
  margin-top: 1px;
}

.btn.wide {
  width: 100%;
}
</style>
