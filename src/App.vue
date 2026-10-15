<script setup lang="ts">
// =============================================================
// 应用外壳
// 布局：桌面端左侧导航 + 主内容；移动端底部导航（左二 + 中间大按钮 + 右二）
// =============================================================
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { RouterLink, RouterView, useRoute } from 'vue-router';
import Icon from './components/Icon.vue';
import RecorderSheet from './components/RecorderSheet.vue';
import VoiceSheet from './components/VoiceSheet.vue';
import ReminderPrompt from './components/ReminderPrompt.vue';
import LoginPage from './pages/LoginPage.vue';
import * as careApi from './lib/care';
import { refreshSchedule } from './lib/native';
import {
  authed,
  bootstrap,
  online,
  toast,
  pendingCount,
  ready,
  runToastAction,
  theme,
  toastActionLabel,
  toastHasAction,
  toastText,
  toastVisible,
  toggleTheme,
} from './lib/store';

const route = useRoute();

// 弹层
const recorderOpen = ref(false);
const voiceOpen = ref(false);
const menuOpen = ref(false);
const editingId = ref<string | null>(null);

/** 四个主入口：左二 + 右二 */
const NAV = [
  { to: '/', label: '过往', icon: 'book' },
  { to: '/find', label: '拾迹', icon: 'search' },
  { to: '/stats', label: '统计', icon: 'chart' },
  { to: '/mine', label: '我的', icon: 'user' },
];
const TABS_LEFT = [NAV[0], NAV[1]];
const TABS_RIGHT = [NAV[2], NAV[3]];

function openRecorder() {
  editingId.value = null;
  recorderOpen.value = true;
  menuOpen.value = false;
}

/** 打开语音。弹层自己会开录，这里不用传什么 */
function openVoice() {
  voiceOpen.value = true;
  menuOpen.value = false;
}

function openEdit(id: string) {
  editingId.value = id;
  recorderOpen.value = true;
}

// ---------- 快捷提醒：写完一条之后问一句 ----------
/*
 * 检测放在保存**之后**，而且是 fire-and-forget：
 * 记录是最高频的操作，绝不能被一次 AI 调用拖慢；识别失败也无所谓。
 * 用户可以在浮卡上点「以后别问了」永久关掉。
 */
const REMIND_OFF_KEY = 'sg.remind.auto';
const promptOpen = ref(false);
const promptBusy = ref(false);
const promptHit = ref<{ title: string; at: string; advance: number; quote: string } | null>(null);
const promptEntryId = ref('');

async function onSaved(e: Event) {
  const detail = (e as CustomEvent).detail || {};
  const content = String(detail.content || '').trim();
  const id = String(detail.id || '');
  if (!content || !id) return;
  if (localStorage.getItem(REMIND_OFF_KEY) === '0') return;
  // 太短的多半没有时间约定；连一个时间词都没有就别花这次 API 调用
  if (content.length < 6) return;
  if (!/\d|点|明天|后天|下周|下午|上午|晚上|中午|早上/.test(content)) return;
  try {
    const r = await careApi.detectReminder(content, id);
    if (!r.found || !r.at || !r.title) return;
    promptHit.value = { title: r.title, at: r.at, advance: r.advance ?? 10, quote: r.quote || content.slice(0, 60) };
    promptEntryId.value = id;
    promptOpen.value = true;
  } catch {
    /* 识别失败什么都不做，绝不打扰 */
  }
}

async function acceptReminder(advance: number) {
  const hit = promptHit.value;
  if (!hit) return;
  promptBusy.value = true;
  try {
    await careApi.saveReminder({
      title: hit.title,
      at: hit.at,
      advance,
      source: 'note',
      entryId: promptEntryId.value,
      quote: hit.quote,
    });
    promptOpen.value = false;
    toast('设好了，到点提醒你');
    // 排上本地通知，否则「设好了」只是一句话
    await refreshSchedule(careApi.getSchedule, 7).catch(() => {});
  } catch {
    toast('没设上，去「快捷提醒」里手动加一条');
  } finally {
    promptBusy.value = false;
  }
}

/** 永久关掉自动追问 */
function turnOffPrompt() {
  promptOpen.value = false;
  localStorage.setItem(REMIND_OFF_KEY, '0');
  toast('好，以后不问了。想开回来去「设置」里找');
}

// 快捷键：N 开写，V 开说（V 是直接开录，跟首页那个麦克风一样）
function onKey(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null;
  const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'n' || e.key === 'N') {
    e.preventDefault();
    openRecorder();
  }
  if (e.key === 'v' || e.key === 'V') {
    e.preventDefault();
    openVoice();
  }
}

onMounted(() => {
  bootstrap();
  window.addEventListener('keydown', onKey);
  window.addEventListener('sg:edit', ((e: CustomEvent) => openEdit(e.detail.id)) as EventListener);
  window.addEventListener('sg:record', openRecorder);
  window.addEventListener('sg:voice', openVoice);
  window.addEventListener('sg:saved', onSaved);
});

onUnmounted(() => {
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('sg:record', openRecorder);
  window.removeEventListener('sg:voice', openVoice);
  window.removeEventListener('sg:saved', onSaved);
});

const isMine = computed(() => route.path.startsWith('/mine') || route.path.startsWith('/settings'));
</script>

<template>
  <!-- 启动中 -->
  <div v-if="!ready" class="boot">
    <div class="boot-mark"><Icon name="feather" :size="30" /></div>
    <p>拾光</p>
  </div>

  <LoginPage v-else-if="!authed" />

  <div v-else class="shell">
    <!-- ============ 桌面端左侧导航 ============ -->
    <aside class="side">
      <div class="side-brand">
        <div class="brand-mark"><Icon name="feather" :size="17" /></div>
        <div>
          <div class="side-name">拾光</div>
          <small>随手记录 · AI 回忆</small>
        </div>
      </div>

      <nav class="side-nav">
        <RouterLink v-for="n in NAV" :key="n.to" :to="n.to">
          <Icon :name="n.icon" :size="19" />
          <span>{{ n.label }}</span>
        </RouterLink>
      </nav>

      <button class="btn btn-primary side-add" @click="openRecorder">
        <Icon name="plus" :size="18" />
        记一记
        <kbd>N</kbd>
      </button>

      <div class="side-foot">
        <RouterLink to="/settings" class="side-link" :class="{ on: route.path.startsWith('/settings') }">
          <Icon name="settings" :size="17" />
          账号设置
        </RouterLink>
        <button class="side-link" @click="toggleTheme">
          <Icon :name="theme === 'dark' ? 'sun' : 'moon'" :size="17" />
          {{ theme === 'dark' ? '白天模式' : '夜间模式' }}
        </button>
        <div v-if="!online || pendingCount" class="side-status">
          <Icon name="wifiOff" :size="14" />
          {{ online ? `${pendingCount} 条待同步` : '离线中' }}
        </div>
      </div>
    </aside>

    <!-- ============ 主内容 ============ -->
    <main class="main">
      <!-- 离线时才出现的一条窄提示，不固定，滚上去就看不见了 -->
      <p v-if="!online || pendingCount" class="off-line">
        <Icon name="wifiOff" :size="14" />
        {{ online ? `${pendingCount} 条还没同步上去` : '离线中，记录会先存在本地' }}
      </p>

      <RouterView v-slot="{ Component }">
        <Transition name="page" mode="out-in">
          <component :is="Component" />
        </Transition>
      </RouterView>
    </main>

    <!-- ============ 移动端底部导航：左二 + 中间 + 右二 ============ -->
    <nav class="tabbar">
      <RouterLink v-for="t in TABS_LEFT" :key="t.to" :to="t.to">
        <span class="tab-ico"><Icon :name="t.icon" :size="20" /></span>
        <span class="tab-label">{{ t.label }}</span>
      </RouterLink>

      <button class="fab-main" title="记一记（N）" aria-label="记一记" @click="openRecorder">
        <Icon name="plus" :size="26" />
      </button>

      <RouterLink v-for="t in TABS_RIGHT" :key="t.to" :to="t.to" :class="{ 'router-link-active': t.to === '/mine' && isMine }">
        <span class="tab-ico"><Icon :name="t.icon" :size="20" /></span>
        <span class="tab-label">{{ t.label }}</span>
      </RouterLink>
    </nav>

    <RecorderSheet v-model:open="recorderOpen" :entry-id="editingId" />
    <VoiceSheet v-model:open="voiceOpen" />

    <!--
      写完之后问一句「要不要设提醒」。
      浮在弹层之上、底栏之上，不占版面，几秒后自己消失也没关系——
      用户真想设的话会去「快捷提醒」里加。
    -->
    <ReminderPrompt
      :open="promptOpen"
      :title="promptHit?.title || ''"
      :at="promptHit?.at || ''"
      :advance="promptHit?.advance ?? 10"
      :busy="promptBusy"
      @accept="acceptReminder"
      @dismiss="promptOpen = false"
      @off="turnOffPrompt"
    />
  </div>

  <!-- 提示条（可带撤销按钮） -->
  <Transition name="fade">
    <div v-if="toastVisible" class="toast show" :class="{ 'has-action': toastHasAction }">
      <span>{{ toastText }}</span>
      <button v-if="toastHasAction" class="toast-act" @click="runToastAction">{{ toastActionLabel }}</button>
    </div>
  </Transition>
</template>

<style scoped>
.boot {
  min-height: 100dvh;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 14px;
  color: var(--text-3);
  font-size: 0.9rem;
  letter-spacing: 0.3em;
}

.boot-mark {
  width: 66px;
  height: 66px;
  border-radius: 22px;
  background: linear-gradient(135deg, var(--brand), var(--ai));
  color: #fff;
  display: grid;
  place-items: center;
  animation: pop 0.6s var(--spring);
}

@keyframes pop {
  from {
    transform: scale(0.8);
    opacity: 0;
  }
}

/* ---------- 布局 ---------- */
.shell {
  display: block;
  max-width: var(--maxw);
  margin: 0 auto;
  padding: 0 var(--pad) calc(84px + var(--safe-bottom));
  padding-top: calc(var(--safe-top) + 10px);
  min-height: 100dvh;
}

@media (min-width: 1080px) {
  .shell {
    display: grid;
    grid-template-columns: 232px minmax(0, 1fr);
    gap: 40px;
    max-width: 1120px;
    padding-bottom: 40px;
  }

  .main {
    padding-bottom: 40px;
    min-width: 0;
  }

  .main > * {
    max-width: 720px;
    margin-left: auto;
    margin-right: auto;
    width: 100%;
  }
}

/* ---------- 侧栏 ---------- */
.side {
  display: none;
}

@media (min-width: 1080px) {
  .side {
    display: flex;
    flex-direction: column;
    gap: 22px;
    position: sticky;
    top: 0;
    align-self: start;
    height: 100dvh;
    padding: 22px 0 26px;
  }
}

.side-brand {
  display: flex;
  align-items: center;
  gap: 11px;
}

.side-name {
  font-weight: 700;
  font-size: 1.05rem;
  letter-spacing: -0.02em;
}

.side-brand small {
  display: block;
  font-size: 0.7rem;
  color: var(--text-3);
  letter-spacing: 0.04em;
}

.side-nav {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.side-nav a {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 10px 13px;
  border-radius: var(--r-sm);
  color: var(--text-2);
  font-size: 0.92rem;
  font-weight: 520;
  transition: all var(--dur) var(--ease);
}

.side-nav a:hover {
  background: var(--surface-2);
  color: var(--text);
}

.side-nav a.router-link-active {
  background: var(--brand-tint);
  color: var(--brand-deep);
  font-weight: 620;
}

:root[data-theme='dark'] .side-nav a.router-link-active {
  color: var(--brand-soft);
}

.side-add {
  width: 100%;
  margin-top: 4px;
}

.side-add kbd {
  margin-left: auto;
  font-size: 0.68rem;
  padding: 1px 6px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.22);
  border: none;
  font-family: var(--font-num);
}

.side-foot {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.side-link {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 13px;
  border-radius: var(--r-sm);
  color: var(--text-3);
  font-size: 0.86rem;
  text-align: left;
  transition: all var(--dur);
}

.side-link:hover {
  background: var(--surface-2);
  color: var(--text);
}

.side-link.on {
  color: var(--brand-deep);
  background: var(--brand-tint);
}

.side-status {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 8px 13px 0;
  font-size: 0.76rem;
  color: var(--amber-text);
}

/* ---------- 离线提示（不是固定的，滚上去就没了） ---------- */
.off-line {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 12px;
  padding: 8px 12px;
  border-radius: var(--r-sm);
  background: var(--amber-tint);
  color: var(--amber-text);
  font-size: 0.8rem;
  font-weight: 540;
}

/* ---------- 底部导航 ---------- */
@media (min-width: 1080px) {
  .tabbar {
    display: none;
  }
}
</style>
