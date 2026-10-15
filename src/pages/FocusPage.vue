<script setup lang="ts">
// =============================================================
// 学习模式
//
// 这一页有个绕不开的现实：**浏览器里锁不了应用**。
// 安卓上唯一的现实路径是无障碍服务（AccessibilityService），而且必须由用户
// 手动去系统设置里打开 —— App 没有权限自己开。
//
// 所以这一页分两种形态：
//   网页版 / 没开权限：只做「专注计时」，并且在最显眼的位置说清楚
//                      「这里拦不住你刷手机，要拦得装 App 并开权限」
//   开了权限：          规则会真的生效，到点把黑名单应用盖住
//
// 刻意不画一个点了没反应的开关 —— 那比明说做不到糟糕得多，
// 用户会以为自己设好了，然后在刷了两小时短视频之后发现根本没锁。
// =============================================================
import { computed, onMounted, ref } from 'vue';
import Icon from '../components/Icon.vue';
import * as care from '../lib/care';
import { toast } from '../lib/store';
import {
  focusStatus,
  listInstalledApps,
  openAccessibilitySettings,
  refreshSchedule,
  type FocusStatus,
  type InstalledApp,
} from '../lib/native';

const loading = ref(true);
const status = ref<FocusStatus | null>(null);
const apps = ref<InstalledApp[]>([]);
const info = ref<care.FocusInfo | null>(null);
const appPickerOpen = ref(false);
/** 正在给哪条规则挑应用 */
const pickingFor = ref<string>('');
const appFilter = ref('');

const blocks = ref<care.FocusBlock[]>([]);
const alwaysAllow = ref<string[]>([]);

// 专注计时（网页版也能用的那部分）
const timerMin = ref(25);
const timerLeft = ref(0);
const timerRunning = ref(false);
let tick: number | null = null;

const canBlock = computed(() => !!status.value?.supported && !!status.value?.enabled);
const dirty = ref(false);

const filteredApps = computed(() => {
  const q = appFilter.value.trim().toLowerCase();
  const list = apps.value;
  if (!q) return list;
  return list.filter((a) => a.label.toLowerCase().includes(q) || a.package.toLowerCase().includes(q));
});

function fmtLeft(sec: number) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function newBlock() {
  blocks.value.push({
    id: `b${Date.now().toString(36)}`,
    label: '专注',
    from: '20:00',
    to: '22:00',
    days: [],
    packages: [],
    enabled: true,
  });
  dirty.value = true;
}

function dropBlock(i: number) {
  blocks.value.splice(i, 1);
  dirty.value = true;
}

function openPicker(block: care.FocusBlock) {
  pickingFor.value = block.id;
  appFilter.value = '';
  appPickerOpen.value = true;
  if (!apps.value.length) loadApps();
}

async function loadApps() {
  const list = await listInstalledApps();
  apps.value = list;
  if (!list.length) toast('读不到应用列表，确认一下权限');
}

function togglePick(pkg: string) {
  const b = blocks.value.find((x) => x.id === pickingFor.value);
  if (!b) return;
  const i = b.packages.indexOf(pkg);
  if (i >= 0) b.packages.splice(i, 1);
  else b.packages.push(pkg);
  dirty.value = true;
}

function isPicked(pkg: string) {
  const b = blocks.value.find((x) => x.id === pickingFor.value);
  return !!b?.packages.includes(pkg);
}

/*
 * 常见应用的包名 → 中文名。
 *
 * 有原生插件时用的是系统给的真实应用名，这个表用不上；
 * 但在网页版上（或者换台设备打开同一个账号）拿不到应用列表，
 * 只显示 com.ss.android.ugc.aweme 谁也认不出来自己选的是不是抖音。
 * 只覆盖到这类功能真正会挡的那几个，不追求全。
 */
const PKG_NAMES: Record<string, string> = {
  'com.ss.android.ugc.aweme': '抖音',
  'com.ss.android.ugc.aweme.lite': '抖音极速版',
  'com.smile.gifmaker': '快手',
  'com.kuaishou.nebula': '快手极速版',
  'com.xingin.xhs': '小红书',
  'com.tencent.mm': '微信',
  'com.tencent.mobileqq': 'QQ',
  'com.sina.weibo': '微博',
  'tv.danmaku.bili': '哔哩哔哩',
  'com.zhihu.android': '知乎',
  'com.douban.frodo': '豆瓣',
  'com.tencent.qqlive': '腾讯视频',
  'com.qiyi.video': '爱奇艺',
  'com.youku.phone': '优酷',
  'com.hunantv.imgo.activity': '芒果 TV',
  'com.taobao.taobao': '淘宝',
  'com.jingdong.app.mall': '京东',
  'com.xunmeng.pinduoduo': '拼多多',
  'com.tencent.tmgp.sgame': '王者荣耀',
  'com.tencent.tmgp.pubgmhd': '和平精英',
  'com.netease.sky': '光·遇',
  'com.tencent.qqmusic': 'QQ 音乐',
  'com.netease.cloudmusic': '网易云音乐',
  'com.ss.android.article.news': '今日头条',
  'com.tencent.news': '腾讯新闻',
  'com.achievo.vipshop': '唯品会',
  'com.eg.android.AlipayGphone': '支付宝',
};

function labelOf(pkg: string) {
  return apps.value.find((a) => a.package === pkg)?.label || PKG_NAMES[pkg] || pkg.split('.').pop() || pkg;
}

const DAYS = ['日', '一', '二', '三', '四', '五', '六'];

function toggleDay(b: care.FocusBlock, d: number) {
  const i = b.days.indexOf(d);
  if (i >= 0) b.days.splice(i, 1);
  else b.days.push(d);
  b.days.sort((x, y) => x - y);
  dirty.value = true;
}

async function load() {
  loading.value = true;
  try {
    status.value = await focusStatus();
    const r = await care.getFocus();
    info.value = r;
    blocks.value = JSON.parse(JSON.stringify(r.focus.blocks));
    alwaysAllow.value = [...r.focus.alwaysAllow];
  } catch (e: any) {
    toast(e?.message || '加载失败');
  } finally {
    loading.value = false;
  }
}

async function save() {
  try {
    // 规则本身存服务端；能不能真锁取决于这台设备有没有开权限
    const r = await care.saveFocus({ blocks: blocks.value, alwaysAllow: alwaysAllow.value });
    blocks.value = JSON.parse(JSON.stringify(r.focus.blocks));
    dirty.value = false;
    toast(canBlock.value ? '规则已生效' : '规则存下来了，装上 App 并开权限之后才会真的锁');
    await refreshSchedule(care.getSchedule, 7);
    await load();
  } catch (e: any) {
    toast(e?.message || '保存失败');
  }
}

async function askPermission() {
  await openAccessibilitySettings();
  toast('在「无障碍」里找到拾光并打开，回来点一下刷新');
}

async function recheck() {
  status.value = await focusStatus();
  if (status.value.enabled) {
    toast('权限好了，规则开始生效');
    await refreshSchedule(care.getSchedule, 7);
  } else {
    toast('还没打开，再去系统设置里看一眼');
  }
}

/** 网页版也能用的专注计时：到点提醒，但拦不住应用 */
function startTimer() {
  timerLeft.value = timerMin.value * 60;
  timerRunning.value = true;
  if (tick) clearInterval(tick);
  tick = window.setInterval(() => {
    timerLeft.value -= 1;
    if (timerLeft.value <= 0) finishTimer(true);
  }, 1000);
}

async function finishTimer(done: boolean) {
  if (tick) clearInterval(tick);
  tick = null;
  const spent = Math.round((timerMin.value * 60 - Math.max(0, timerLeft.value)) / 60);
  timerRunning.value = false;
  timerLeft.value = 0;
  if (spent >= 1) {
    try {
      await care.logFocus({ minutes: spent, label: '专注计时', ended: done ? 'done' : 'giveup' });
      await load();
    } catch {
      /* 记不上也不该弹错 */
    }
  }
  toast(done ? `专注了 ${spent} 分钟，记下了` : `停了，也记了 ${spent} 分钟`);
}

const stats = computed(() => info.value?.stats || { sessions: 0, minutes: 0, todayMinutes: 0, week: 0 });
const nowBlocking = computed(() => info.value?.now.blocking && canBlock.value);
const nextStart = computed(() => info.value?.next || null);

function whenText(ts: number) {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? `今天 ${p(d.getHours())}:${p(d.getMinutes())}` : `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function remainText(min: number) {
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  const r = min % 60;
  return r ? `${h} 小时 ${r} 分` : `${h} 小时`;
}

onMounted(load);
</script>

<template>
  <div class="focus-page">
    <div class="page-head">
      <div>
        <h1>学习模式</h1>
        <p class="sub">到点了，把该做的做完</p>
      </div>
    </div>

    <div v-if="loading" class="card pad muted">正在读…</div>

    <template v-else>
      <!-- ============ 正在专注 / 下一次 ============ -->
      <div v-if="nowBlocking" class="card now-card">
        <span class="now-ring"><Icon name="lock" :size="20" /></span>
        <div class="now-text">
          <b>正在专注 · {{ info?.now.block?.label }}</b>
          <p>
            挡着 {{ info?.now.packages.length }} 个应用
            <template v-if="info?.now.remaining">，还有 {{ remainText(info.now.remaining) }}</template>
          </p>
        </div>
      </div>
      <div v-else-if="nextStart && canBlock" class="card next-card">
        <span class="now-ring soft"><Icon name="hourglass" :size="19" /></span>
        <div class="now-text">
          <b>下一次：{{ whenText(nextStart.at) }} · {{ nextStart.label }}</b>
          <p>到点会自动把黑名单里的应用盖住。</p>
        </div>
      </div>

      <!-- ============ 能力说明：不能锁就直说 ============ -->
      <div v-if="!canBlock" class="card cap-card">
        <span class="cap-icon"><Icon name="alert" :size="18" /></span>
        <div class="cap-body">
          <b>{{ status?.supported ? '还差一步：打开无障碍权限' : '这里拦不住你刷手机' }}</b>
          <p v-if="status?.supported">
            拾光要靠在系统的「无障碍」里注册一个服务，才能发现你切到了哪个应用并把它盖住。
            系统不允许 App 自己打开这个权限，只能你手动去开一次（开完就一直有效）。
          </p>
          <p v-else>
            {{ status?.note }}
          </p>
          <p v-if="status?.supported" class="cap-hint">
            小米 / 华为 / OPPO 这些系统，还要在「应用管理」里给拾光开「自启动」和「后台运行」，
            否则服务会被系统清掉，锁就失效了。
          </p>
        </div>
        <div class="cap-acts">
          <button v-if="status?.supported" class="btn btn-sm btn-primary" @click="askPermission">去打开</button>
          <button v-if="status?.supported" class="btn btn-sm" @click="recheck">我开好了</button>
        </div>
      </div>

      <!-- ============ 专注计时：网页版也能用 ============ -->
      <section class="group">
        <h2 class="group-title">专注一会儿</h2>
        <div class="card timer-card">
          <div v-if="!timerRunning" class="timer-setup">
            <div class="chips">
              <button v-for="m in [15, 25, 45, 60]" :key="m" class="chip" :class="{ active: timerMin === m }" @click="timerMin = m">
                {{ m }} 分
              </button>
            </div>
            <button class="btn btn-primary wide" @click="startTimer">
              <Icon name="play" :size="16" /> 开始
            </button>
          </div>
          <div v-else class="timer-run">
            <b class="num">{{ fmtLeft(timerLeft) }}</b>
            <p>计时结束会提醒你。{{ canBlock ? '黑名单里的应用现在打不开。' : '（这里只计时，拦不住应用）' }}</p>
            <button class="btn" @click="finishTimer(false)">停在这里</button>
          </div>
        </div>
        <p class="stats-line">
          今天 {{ stats.todayMinutes }} 分钟 · 这周 {{ stats.week }} 分钟 · 一共 {{ stats.sessions }} 次
        </p>
      </section>

      <!-- ============ 规则 ============ -->
      <section class="group">
        <div class="group-head">
          <h2 class="group-title">什么时候锁</h2>
          <button class="text-btn" @click="newBlock"><Icon name="plus" :size="14" /> 加一条</button>
        </div>

        <div v-if="!blocks.length" class="card empty">
          <p class="tip">还没有规则。加一条「晚上 8 点到 10 点，除了微信都别开」，到点它自己会生效。</p>
        </div>

        <div v-for="(b, i) in blocks" :key="b.id" class="card block-card" :class="{ off: !b.enabled }">
          <div class="bl-head">
            <input v-model="b.label" class="bl-label" type="text" maxlength="8" @input="dirty = true" />
            <label class="sw">
              <input v-model="b.enabled" type="checkbox" @change="dirty = true" />
              <span class="sw-track"><span class="sw-dot"></span></span>
            </label>
            <button class="icon-btn sm" title="删掉这条" @click="dropBlock(i)"><Icon name="trash" :size="16" /></button>
          </div>

          <div class="bl-time">
            <input v-model="b.from" type="time" @change="dirty = true" />
            <span class="bl-dash">→</span>
            <input v-model="b.to" type="time" @change="dirty = true" />
            <span v-if="b.from > b.to" class="overnight">跨零点</span>
          </div>

          <div class="bl-days">
            <button
              v-for="(d, di) in DAYS"
              :key="di"
              class="day"
              :class="{ active: !b.days.length || b.days.includes(di) }"
              :title="b.days.length ? '' : '每天'"
              @click="toggleDay(b, di)"
            >
              {{ d }}
            </button>
            <span class="days-hint">{{ b.days.length ? '' : '每天' }}</span>
          </div>

          <button class="bl-apps" @click="openPicker(b)">
            <Icon name="lock" :size="15" />
            <span v-if="b.packages.length">
              挡 {{ b.packages.length }} 个应用
              <em>{{ b.packages.slice(0, 2).map(labelOf).join('、') }}{{ b.packages.length > 2 ? ' 等' : '' }}</em>
            </span>
            <span v-else class="warn">还没选要挡哪些应用</span>
            <Icon name="arrowRight" :size="14" class="chev" />
          </button>
        </div>

        <button v-if="dirty" class="btn btn-primary wide save-bar" @click="save">保存规则</button>
      </section>

      <p class="foot">
        学习模式只在你自己的手机上生效，规则也只在你自己账号里。<br />
        它可以被强行绕过（重启服务、卸载 App），它的作用是帮你把那几秒钟的冲动挡回去。
      </p>
    </template>

    <!-- ============ 挑应用 ============ -->
    <Transition name="sheet">
      <div v-if="appPickerOpen" class="sheet-mask" @click.self="appPickerOpen = false">
        <div class="sheet tall">
          <div class="sheet-grabber"></div>
          <header class="sheet-head">
            <h3>要挡哪些应用</h3>
            <button class="icon-btn" title="关闭" @click="appPickerOpen = false"><Icon name="x" :size="19" /></button>
          </header>
          <div class="picker-body">
            <input v-model="appFilter" class="search" type="search" placeholder="搜应用名" />
            <p v-if="!apps.length" class="muted">读不到应用列表。得先开无障碍权限，App 才有权看装了哪些应用。</p>
            <ul v-else class="app-list">
              <li v-for="a in filteredApps" :key="a.package">
                <button class="app-row" :class="{ picked: isPicked(a.package) }" @click="togglePick(a.package)">
                  <span class="app-name">{{ a.label }}</span>
                  <span class="app-pkg">{{ a.package }}</span>
                  <span class="app-check"><Icon v-if="isPicked(a.package)" name="check" :size="15" /></span>
                </button>
              </li>
            </ul>
          </div>
          <footer class="picker-foot">
            <button class="btn btn-primary wide" @click="appPickerOpen = false">
              好了（{{ blocks.find((x) => x.id === pickingFor)?.packages.length || 0 }} 个）
            </button>
          </footer>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.group {
  margin-top: 22px;
}

.group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0 4px 8px;
}

.group-title {
  font-size: 0.78rem;
  font-weight: 620;
  color: var(--text-3);
  letter-spacing: 0.06em;
  margin: 0;
}

.group-head .text-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 0.78rem;
  color: var(--brand-deep);
  font-weight: 600;
}

.pad {
  padding: 18px 16px;
}

.muted {
  color: var(--text-3);
  font-size: 0.88rem;
  line-height: 1.7;
}

/* ---------- 专注中 ---------- */
.now-card,
.next-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px;
  margin-top: 4px;
}

.now-card {
  border-left: 3px solid var(--ai);
  background: var(--ai-tint);
}

.next-card {
  border-left: 3px solid var(--brand);
}

.now-ring {
  flex: 0 0 auto;
  width: 38px;
  height: 38px;
  border-radius: 12px;
  display: grid;
  place-items: center;
  background: var(--surface);
  color: var(--ai-text);
}

.now-ring.soft {
  color: var(--brand-deep);
}

.now-text b {
  display: block;
  font-size: 0.95rem;
  font-weight: 650;
}

.now-text p {
  margin: 2px 0 0;
  font-size: 0.8rem;
  color: var(--text-2);
}

/* ---------- 能力说明 ---------- */
.cap-card {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 11px;
  padding: 14px;
  margin-top: 14px;
  border-color: var(--border-2);
  background: var(--amber-tint);
}

.cap-icon {
  flex: 0 0 auto;
  color: var(--amber-text);
  margin-top: 1px;
}

.cap-body {
  flex: 1;
  min-width: 200px;
}

.cap-body b {
  display: block;
  font-size: 0.92rem;
  font-weight: 650;
}

.cap-body p {
  margin: 5px 0 0;
  font-size: 0.81rem;
  line-height: 1.7;
  color: var(--text-2);
}

.cap-body p.cap-hint {
  font-size: 0.76rem;
  color: var(--text-3);
}

.cap-acts {
  display: flex;
  gap: 8px;
  width: 100%;
}

/* ---------- 计时 ---------- */
.timer-card {
  padding: 16px;
}

.timer-setup .chips {
  display: flex;
  gap: 7px;
  margin-bottom: 12px;
}

.chip {
  flex: 1;
  padding: 8px 0;
  border-radius: var(--r-full);
  background: var(--surface-2);
  border: 1px solid var(--border);
  font-size: 0.86rem;
  color: var(--text-2);
  transition: all var(--dur);
}

.chip.active {
  background: var(--brand);
  border-color: var(--brand);
  color: #fff;
  font-weight: 600;
}

.btn.wide {
  width: 100%;
}

.timer-run {
  text-align: center;
  padding: 6px 0 2px;
}

.timer-run b {
  font-size: 2.6rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}

.timer-run p {
  margin: 4px 0 12px;
  font-size: 0.8rem;
  color: var(--text-3);
}

.stats-line {
  margin: 9px 4px 0;
  font-size: 0.78rem;
  color: var(--text-3);
  text-align: center;
}

/* ---------- 规则卡 ---------- */
.empty {
  padding: 22px 18px;
  text-align: center;
}

.empty .tip {
  margin: 0;
  color: var(--text-2);
  font-size: 0.87rem;
  line-height: 1.75;
}

.block-card {
  padding: 13px 14px;
  margin-bottom: 10px;
  transition: opacity var(--dur);
}

.block-card.off {
  opacity: 0.55;
}

.bl-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.bl-label {
  flex: 1;
  min-width: 0;
  font-size: 0.98rem;
  font-weight: 640;
  color: var(--text);
  background: transparent;
  border: 0;
  padding: 2px 0;
}

.bl-label:focus {
  outline: none;
  border-bottom: 1px solid var(--brand);
}

/* 小开关 */
.sw {
  flex: 0 0 auto;
  cursor: pointer;
}

.sw input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.sw-track {
  display: block;
  width: 40px;
  height: 23px;
  border-radius: var(--r-full);
  background: var(--surface-3);
  padding: 2px;
  transition: background var(--dur);
}

.sw-dot {
  display: block;
  width: 19px;
  height: 19px;
  border-radius: 50%;
  background: #fff;
  box-shadow: var(--shadow-xs);
  transition: transform var(--dur);
}

.sw input:checked + .sw-track {
  background: var(--brand);
}

.sw input:checked + .sw-track .sw-dot {
  transform: translateX(17px);
}

.bl-time {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 10px 0;
}

.bl-time input {
  padding: 7px 10px;
  border-radius: var(--r-sm);
  background: var(--surface-2);
  border: 1px solid var(--border);
  font: inherit;
  font-size: 0.88rem;
  color: var(--text);
}

.bl-time input:focus {
  outline: none;
  border-color: var(--brand);
}

.bl-dash {
  color: var(--text-3);
}

.overnight {
  font-size: 0.7rem;
  padding: 1px 7px;
  border-radius: var(--r-full);
  background: var(--sky-tint);
  color: var(--text-2);
}

.bl-days {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-bottom: 11px;
}

.day {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  font-size: 0.78rem;
  background: var(--surface-2);
  border: 1px solid var(--border);
  color: var(--text-3);
  transition: all var(--dur);
}

.day.active {
  background: var(--brand-tint);
  border-color: transparent;
  color: var(--brand-deep);
  font-weight: 620;
}

.days-hint {
  margin-left: 4px;
  font-size: 0.72rem;
  color: var(--text-3);
}

.bl-apps {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: var(--r-sm);
  background: var(--surface-2);
  font-size: 0.85rem;
  color: var(--text-2);
  text-align: left;
  transition: background var(--dur);
}

.bl-apps:hover {
  background: var(--surface-3);
}

.bl-apps em {
  font-style: normal;
  color: var(--text-3);
  font-size: 0.78rem;
}

.bl-apps .warn {
  color: var(--amber-text);
}

.bl-apps .chev {
  margin-left: auto;
  color: var(--text-3);
}

.save-bar {
  margin-top: 4px;
}

.foot {
  margin: 24px 4px 8px;
  font-size: 0.76rem;
  color: var(--text-3);
  text-align: center;
  line-height: 1.8;
}

/* ---------- 挑应用 ---------- */
.sheet.tall {
  max-height: 86vh;
  display: flex;
  flex-direction: column;
}

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

.picker-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 16px;
}

.search {
  width: 100%;
  padding: 10px 13px;
  border-radius: var(--r-sm);
  background: var(--surface-2);
  border: 1px solid var(--border);
  font: inherit;
  font-size: 0.9rem;
  color: var(--text);
  margin-bottom: 10px;
}

.search:focus {
  outline: none;
  border-color: var(--brand);
}

.app-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.app-row {
  width: 100%;
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 11px 4px;
  border-bottom: 1px solid var(--border);
  text-align: left;
}

.app-name {
  font-size: 0.9rem;
  color: var(--text);
}

.app-pkg {
  flex: 1;
  min-width: 0;
  font-size: 0.68rem;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.app-check {
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 1.5px solid var(--border-2);
  display: grid;
  place-items: center;
  color: #fff;
}

.app-row.picked .app-check {
  background: var(--brand);
  border-color: var(--brand);
}

.picker-foot {
  padding: 12px 16px calc(16px + var(--safe-bottom));
  border-top: 1px solid var(--border);
}
</style>
