<script setup lang="ts">
// =============================================================
// 个人资料
//
// 从「我的」页点头像进来。这里放三块：
//   1. 昵称和简介（可改，改完头图立刻跟着变）
//   2. 账号：登录方式、手机号、改密码
//   3. 通用：外观、数据同步
//
// 之所以把账号和通用从「我的」挪过来，是因为「我的」现在只负责
// 「看自己的记录」；跟身份、跟设备偏好有关的东西收进二级页，
// 一级页面就不会越堆越长。
// =============================================================
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import * as api from '../lib/api';
import { fullDate } from '../lib/date';
import {
  aiReady,
  asr,
  loadProfile,
  online,
  pendingCount,
  profile,
  saveProfile,
  theme,
  toggleTheme,
  toast,
} from '../lib/store';

const router = useRouter();

const methods = ref<api.AuthMethods | null>(null);

// 昵称 / 简介
const nickname = ref('');
const bio = ref('');
const saving = ref(false);
const errMsg = ref('');

const saved = computed(() => ({
  nickname: profile.value?.nickname || '',
  bio: profile.value?.bio || '',
}));
const dirty = computed(() => nickname.value.trim() !== saved.value.nickname || bio.value.trim() !== saved.value.bio);
const previewChar = computed(() => (nickname.value.trim() || '拾').slice(0, 1));

const syncState = computed(() => {
  if (!online.value) return { text: '离线中', tone: 'warn' as const };
  if (pendingCount.value) return { text: `${pendingCount.value} 条待同步`, tone: 'warn' as const };
  return { text: '已同步', tone: 'ok' as const };
});

const loginMode = computed(() => (methods.value?.sms ? '密码 + 短信' : '手机号 + 密码'));

/** 这个账号是哪天开的 */
const since = computed(() => {
  const t = profile.value?.createdAt;
  return t ? `${fullDate(new Date(t).toISOString().slice(0, 10))} 注册` : '已设置';
});

/**
 * 返回。
 * 直接打开这个地址（刷新页面、从书签进）时浏览器里没有上一页，
 * 这时候 router.back() 会把人带出站点，所以退回「我的」。
 */
function goBack() {
  if (window.history.state?.back) router.back();
  else router.push('/mine');
}

function reset() {
  nickname.value = saved.value.nickname;
  bio.value = saved.value.bio;
  errMsg.value = '';
}

async function submit() {
  if (saving.value || !dirty.value) return;
  saving.value = true;
  errMsg.value = '';
  try {
    await saveProfile(nickname.value.trim(), bio.value.trim());
    toast('已保存');
    goBack();
  } catch (e: any) {
    errMsg.value = e?.message || '保存失败，稍后再试';
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  api.authMethods().then((m) => (methods.value = m)).catch(() => {});
  if (!profile.value) await loadProfile();
  reset();
});
</script>

<template>
  <div class="profile-page">
    <!-- ============ 头图：大头像 + 昵称 + 简介 ============ -->
    <header class="hero">
      <button class="hero-back" title="返回" aria-label="返回" @click="goBack">
        <Icon name="arrowLeft" :size="20" />
      </button>

      <div class="hero-avatar" aria-hidden="true">
        <span v-if="nickname.trim()">{{ previewChar }}</span>
        <Icon v-else name="feather" :size="30" />
      </div>
      <h1 class="hero-name">{{ nickname.trim() || '还没有起名字' }}</h1>
      <p class="hero-bio">{{ bio.trim() || '简介还空着，写一句给自己看的话' }}</p>
    </header>

    <!-- ============ 昵称与简介 ============ -->
    <section class="group">
      <h2 class="group-title">昵称与简介</h2>
      <div class="card card-pad">
        <label class="label" for="nickname">昵称</label>
        <div class="field">
          <input
            id="nickname"
            v-model="nickname"
            type="text"
            maxlength="20"
            placeholder="比如：阿简"
            autocomplete="nickname"
            @keydown.enter="submit"
          />
          <span class="count">{{ nickname.length }}/20</span>
        </div>

        <label class="label" for="bio">简介</label>
        <div class="field">
          <textarea
            id="bio"
            v-model="bio"
            rows="2"
            maxlength="80"
            placeholder="一句话介绍自己，或者写个提醒自己的句子"
          ></textarea>
          <span class="count">{{ bio.length }}/80</span>
        </div>

        <p v-if="errMsg" class="err">{{ errMsg }}</p>

        <div class="acts">
          <button class="btn btn-primary btn-sm" :disabled="saving || !dirty" @click="submit">
            {{ saving ? '保存中…' : '保存' }}
          </button>
          <button class="btn btn-sm" :disabled="!dirty" @click="reset">还原</button>
          <span v-if="dirty && !saving" class="hint">还没保存</span>
        </div>
        <p class="note">昵称和简介只显示在「我的」页的头图上，别人看不到（这本来也只有你自己用）。</p>
      </div>
    </section>

    <!-- ============ 账号 ============ -->
    <section class="group">
      <h2 class="group-title">账号</h2>
      <div class="card menu">
        <div class="menu-row static">
          <span class="mi ai"><Icon name="user" :size="17" /></span>
          <span class="ml">登录方式</span>
          <span class="mv">{{ loginMode }}</span>
        </div>
        <button class="menu-row" @click="router.push('/settings')">
          <span class="mi ai"><Icon name="phone" :size="17" /></span>
          <span class="ml">手机号</span>
          <span class="mv" :class="{ dim: !profile?.phoneMasked }">{{ profile?.phoneMasked || '未绑定' }}</span>
          <Icon name="arrowRight" :size="15" class="chev" />
        </button>
        <button class="menu-row" @click="router.push('/settings')">
          <span class="mi ai"><Icon name="lock" :size="17" /></span>
          <span class="ml">修改密码</span>
          <span class="mv">{{ since }}</span>
          <Icon name="arrowRight" :size="15" class="chev" />
        </button>
      </div>
    </section>

    <!-- ============ 通用 ============ -->
    <section class="group">
      <h2 class="group-title">通用</h2>
      <div class="card menu">
        <button class="menu-row" @click="toggleTheme">
          <span class="mi amber"><Icon :name="theme === 'dark' ? 'moon' : 'sun'" :size="17" /></span>
          <span class="ml">外观</span>
          <span class="mv">{{ theme === 'dark' ? '夜间模式' : '白天模式' }}</span>
          <span class="swap">切换</span>
        </button>
        <div class="menu-row static">
          <span class="mi amber"><Icon name="refresh" :size="17" /></span>
          <span class="ml">数据同步</span>
          <span class="mv" :class="syncState.tone">{{ syncState.text }}</span>
        </div>
      </div>
    </section>

    <!-- ============ 服务状态（从「我的」挪过来的） ============ -->
    <section class="group">
      <h2 class="group-title">服务</h2>
      <div class="card menu">
        <div class="menu-row static">
          <span class="mi brand"><Icon name="sparkles" :size="17" /></span>
          <span class="ml">AI 理解与问答</span>
          <span class="mv" :class="aiReady ? 'ok' : 'warn'">
            <i class="dot" :class="aiReady ? 'on' : 'off'"></i>{{ aiReady ? '正常' : '未配置' }}
          </span>
        </div>
        <div class="menu-row static">
          <span class="mi ai"><Icon name="mic" :size="17" /></span>
          <span class="ml">语音转写</span>
          <span class="mv" :class="asr.enabled ? 'ok' : 'warn'">
            <i class="dot" :class="asr.enabled ? 'on' : 'off'"></i>{{ asr.enabled ? asr.label || '正常' : '未配置' }}
          </span>
        </div>
      </div>
      <p class="group-note">这两项要在服务器上配好才有，没配的时候对应功能会给出提示，记录本身不受影响。</p>
    </section>
  </div>
</template>

<style scoped>
/*
 * 头图。跟「我的」页同一套渐变，但从「打招呼」变成「照镜子」：
 * 头像更大、居中，下面是昵称和简介。
 */
.hero {
  margin: calc(-1 * (var(--safe-top) + 10px)) calc(-1 * var(--pad)) 0;
  padding: calc(var(--safe-top) + 12px) var(--pad) 26px;
  background: var(--hero-grad);
  border-radius: 0 0 var(--r-xl) var(--r-xl);
  color: var(--on-hero);
  text-align: center;
}

.hero-back {
  width: 44px;
  height: 44px;
  margin-left: -10px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  color: var(--on-hero);
  transition: background var(--dur);
}

.hero-back:hover,
.hero-back:active {
  background: var(--on-hero-fade);
}

.hero-avatar {
  width: 76px;
  height: 76px;
  margin: 2px auto 12px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: var(--on-hero);
  color: var(--hero-ink);
  font-size: 1.9rem;
  font-weight: 680;
  line-height: 1;
}

.hero-avatar :deep(svg) {
  width: 30px;
  height: 30px;
}

/*
 * 这里是唯一能看见完整昵称的地方，所以允许折行；
 * 但昵称最长 20 字、简介最长 80 字，全放开会把头图撑成一整屏。
 * 各限 2 / 3 行，超出的截断——正常长度根本触发不到。
 */
.hero-name {
  font-size: 1.3rem;
  font-weight: 680;
  letter-spacing: -0.02em;
  color: var(--on-hero);
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.hero-bio {
  margin-top: 6px;
  font-size: 0.82rem;
  line-height: 1.6;
  color: var(--on-hero);
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* ---------- 分组 ---------- */
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

.mi.ai {
  background: var(--ai-tint);
  color: var(--ai-text);
}

.mi.amber {
  background: var(--amber-tint);
  color: var(--amber-text);
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

.mv.dim {
  color: var(--text-3);
}

.mv.ok {
  color: var(--ai-text);
}

.mv.warn {
  color: var(--amber-text);
}

.dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  margin-right: 6px;
  vertical-align: 1px;
}

.dot.on {
  background: var(--ai);
}

.dot.off {
  background: var(--amber);
}

.chev {
  flex: 0 0 auto;
  color: var(--text-3);
}

.swap {
  flex: 0 0 auto;
  font-size: 0.76rem;
  font-weight: 560;
  color: var(--brand-deep);
  background: var(--brand-tint);
  padding: 4px 10px;
  border-radius: var(--r-full);
}

:root[data-theme='dark'] .swap {
  color: var(--brand-soft);
}

.banner {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 14px 10px;
  padding: 10px 12px;
  border-radius: var(--r-sm);
  background: var(--amber-tint);
  color: var(--amber-text);
  font-size: 0.82rem;
  line-height: 1.5;
}

.group-note {
  margin: 8px 4px 0;
  font-size: 0.76rem;
  color: var(--text-3);
  line-height: 1.7;
}

/* ---------- 编辑表单 ---------- */
.label {
  display: block;
  font-size: 0.8rem;
  font-weight: 560;
  color: var(--text-3);
  margin: 0 2px 7px;
}

.label:not(:first-child) {
  margin-top: 16px;
}

.field {
  align-items: flex-start;
}

.field textarea {
  min-height: 52px;
  line-height: 1.6;
}

.count {
  flex: 0 0 auto;
  font-size: 0.72rem;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  padding-top: 2px;
}

.acts {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
}

.hint {
  font-size: 0.76rem;
  color: var(--amber-text);
}

.note {
  margin-top: 12px;
  font-size: 0.76rem;
  color: var(--text-3);
  line-height: 1.7;
}

.err {
  margin-top: 10px;
  font-size: 0.84rem;
  color: var(--rose-text);
}

/* ---------- 桌面端：头图收成卡片 ---------- */
@media (min-width: 1080px) {
  .hero {
    margin: 0;
    padding: 26px 26px 26px;
    border-radius: var(--r-xl);
  }
}
</style>
