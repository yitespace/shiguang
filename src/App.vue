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
import LoginPage from './pages/LoginPage.vue';
import {
  authed,
  bootstrap,
  online,
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
const pickOpen = ref(false);
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
  pickOpen.value = false;
}

function openVoice() {
  voiceOpen.value = true;
  menuOpen.value = false;
  pickOpen.value = false;
}

/** 中间大按钮：先问「写」还是「说」 */
function openPicker() {
  pickOpen.value = true;
  menuOpen.value = false;
}

function openEdit(id: string) {
  editingId.value = id;
  recorderOpen.value = true;
}

// 快捷键：N 直接开写，V 直接开说。
// 键盘用户不用先过一遍「写还是说」的选择层，少一步。
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
});

onUnmounted(() => {
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('sg:record', openRecorder);
  window.removeEventListener('sg:voice', openVoice);
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

      <button class="btn btn-primary side-add" @click="openPicker">
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

      <button class="fab-main" title="记一记" aria-label="记一记" @click="openPicker">
        <Icon name="plus" :size="26" />
      </button>

      <RouterLink v-for="t in TABS_RIGHT" :key="t.to" :to="t.to" :class="{ 'router-link-active': t.to === '/mine' && isMine }">
        <span class="tab-ico"><Icon :name="t.icon" :size="20" /></span>
        <span class="tab-label">{{ t.label }}</span>
      </RouterLink>
    </nav>

    <!-- ============ 「记一记」方式选择 ============ -->
    <Transition name="sheet">
      <div v-if="pickOpen" class="sheet-mask" @click.self="pickOpen = false">
        <div class="sheet pick-sheet">
          <div class="sheet-grabber"></div>
          <h3 class="pick-title">记一记</h3>
          <div class="pick-grid">
            <button class="pick-item" @click="openRecorder">
              <span class="pick-icon text-icon"><Icon name="edit" :size="24" /></span>
              <b>写一条</b>
              <em>打字记录此刻</em>
            </button>
            <button class="pick-item" @click="openVoice">
              <span class="pick-icon voice-icon"><Icon name="mic" :size="24" /></span>
              <b>说一句</b>
              <em>录音后自动转文字</em>
            </button>
          </div>
          <button class="btn btn-block pick-cancel" @click="pickOpen = false">取消</button>
        </div>
      </div>
    </Transition>

    <RecorderSheet v-model:open="recorderOpen" :entry-id="editingId" />
    <VoiceSheet v-model:open="voiceOpen" />
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

/* ---------- 「记一记」方式选择 ---------- */
.pick-sheet {
  max-width: min(520px, 100%);
  text-align: center;
}

.pick-title {
  font-size: 1.06rem;
  font-weight: 640;
  margin-bottom: 16px;
}

.pick-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.pick-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 20px 12px 18px;
  border-radius: var(--r-lg);
  background: var(--surface);
  border: 1px solid var(--border);
  transition: transform 0.2s var(--spring), border-color var(--dur), box-shadow var(--dur);
}

.pick-item:hover {
  border-color: var(--border-2);
  box-shadow: var(--shadow-sm);
}

.pick-item:active {
  transform: scale(0.97);
}

.pick-icon {
  width: 54px;
  height: 54px;
  border-radius: 18px;
  display: grid;
  place-items: center;
  color: #fff;
  margin-bottom: 4px;
}

/* 「说一句」用 AI 青，字色随主题（暗色下是深墨字，白字会糊） */
.pick-icon.voice-icon {
  color: var(--on-ai);
}

.text-icon {
  background: linear-gradient(135deg, var(--brand), var(--brand-deep));
  box-shadow: var(--shadow-glow);
}

.voice-icon {
  background: var(--ai-grad);
  box-shadow: 0 2px 8px -2px rgba(32, 130, 125, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.22);
}

.pick-item b {
  font-size: 0.96rem;
  font-weight: 620;
}

.pick-item em {
  font-style: normal;
  font-size: 0.76rem;
  color: var(--text-3);
}

.pick-cancel {
  margin-top: 14px;
}
</style>
