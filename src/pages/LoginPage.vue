<script setup lang="ts">
// =============================================================
// 登录 / 注册
//
// 账号就是手机号。三种进法：
//   1. 手机号 + 密码        —— 常规登录
//   2. 手机号 + 短信验证码  —— 快捷登录（配了短信才有这一栏）
//   3. 注册                 —— 手机号 + 邀请码 + 自己设的密码
//
// 注册走邀请码、不走短信；短信只是登录的一种快捷方式，
// 没配好时第 2 栏自动隐藏，只留 1 和 3。
// =============================================================
import { computed, onMounted, onUnmounted, ref } from 'vue';
import Icon from '../components/Icon.vue';
import * as api from '../lib/api';
import { doLogin, doRegister, reloadSession } from '../lib/store';

type Mode = 'password' | 'sms' | 'register';

const mode = ref<Mode>('password');
const inviteCode = ref('');

const phone = ref('');
const password = ref('');
const code = ref('');
const busy = ref(false);
const err = ref('');
const tip = ref('');
const methods = ref<api.AuthMethods | null>(null);
const countdown = ref(0);

let timer: number | undefined;

const smsReady = computed(() => !!methods.value?.sms);
const registerOpen = computed(() => !!methods.value?.register);
const phoneOk = computed(() => /^1[3-9]\d{9}$/.test(phone.value));
const canSend = computed(() => phoneOk.value && countdown.value === 0 && !busy.value);
const canSubmitPassword = computed(() => phoneOk.value && password.value.length > 0);

/** 顶上那排页签：只有真的能用才显示 */
const tabs = computed(() => {
  const list: { key: Mode; label: string }[] = [{ key: 'password', label: '密码登录' }];
  if (smsReady.value) list.push({ key: 'sms', label: '验证码登录' });
  if (registerOpen.value) list.push({ key: 'register', label: '注册' });
  return list;
});

/** 注册要邀请码，不要短信 */
const canSubmitRegister = computed(
  () => phoneOk.value && inviteCode.value.trim().length >= 4 && password.value.length >= 6,
);

async function loadMethods() {
  try {
    const m = await api.authMethods();
    methods.value = m;
    // 一个号都没有 → 默认停在注册页，管理员进来第一眼就知道该干嘛
    if (m.register && m.userCount === 0) mode.value = 'register';
    else if (!m.sms) mode.value = 'password';
  } catch {
    methods.value = { password: true, sms: false, register: false, invite: true, smsReason: null, userCount: 0 };
  }
}

function switchTo(next: Mode) {
  mode.value = next;
  err.value = '';
  tip.value = '';
  code.value = '';
  password.value = '';
  inviteCode.value = '';
}

async function sendCode() {
  if (!canSend.value) return;
  err.value = '';
  tip.value = '';
  busy.value = true;
  try {
    const res = await api.sendSmsCode(phone.value);
    if (res.devCode) {
      // 后端没配真短信时会把码回显，方便自测，不让人卡住
      code.value = res.devCode;
      tip.value = `测试模式：验证码 ${res.devCode}（服务端尚未配置短信通道）`;
    } else {
      tip.value = '验证码已发送，5 分钟内有效';
    }
    countdown.value = 60;
    window.clearInterval(timer);
    timer = window.setInterval(() => {
      countdown.value -= 1;
      if (countdown.value <= 0) window.clearInterval(timer);
    }, 1000);
  } catch (e: any) {
    err.value = e?.message || '发送失败';
  } finally {
    busy.value = false;
  }
}

async function submitPassword() {
  if (busy.value || !canSubmitPassword.value) return;
  busy.value = true;
  err.value = '';
  try {
    await doLogin(phone.value, password.value);
  } catch (e: any) {
    err.value = e?.message || '登录失败';
    password.value = '';
  } finally {
    busy.value = false;
  }
}

async function submitSms() {
  if (busy.value || !phoneOk.value || !code.value) return;
  busy.value = true;
  err.value = '';
  try {
    await api.smsLogin(phone.value, code.value);
    await reloadSession();
  } catch (e: any) {
    err.value = e?.message || '登录失败';
    code.value = '';
  } finally {
    busy.value = false;
  }
}

async function submitRegister() {
  if (busy.value || !canSubmitRegister.value) return;
  busy.value = true;
  err.value = '';
  try {
    await doRegister(phone.value, inviteCode.value.trim(), password.value);
  } catch (e: any) {
    err.value = e?.message || '注册失败';
  } finally {
    busy.value = false;
  }
}

onMounted(loadMethods);
onUnmounted(() => window.clearInterval(timer));
</script>

<template>
  <div class="gate">
    <div class="gate-card">
      <div class="gate-mark"><Icon name="feather" :size="30" /></div>
      <h1>{{ mode === 'register' ? '注册一个账号' : '拾光' }}</h1>
      <p class="desc">
        <template v-if="mode === 'register'">
          账号就是手机号。<br />
          填上管理员给你的邀请码就能进来。
        </template>
        <template v-else>
          随手记下每天发生的事，<br />
          再用对话的方式，把它们找回来。
        </template>
      </p>

      <!-- 三种进法：能用的才显示 -->
      <div v-if="tabs.length > 1" class="tabs" role="tablist">
        <button
          v-for="t in tabs"
          :key="t.key"
          class="tab"
          :class="{ on: mode === t.key }"
          role="tab"
          :aria-selected="mode === t.key"
          @click="switchTo(t.key)"
        >
          {{ t.label }}
        </button>
      </div>

      <!-- 手机号：每种模式都要填 -->
      <div class="field">
        <span class="icon"><Icon name="phone" :size="18" /></span>
        <input
          v-model="phone"
          type="tel"
          inputmode="numeric"
          maxlength="11"
          placeholder="手机号"
          autocomplete="tel"
          aria-label="手机号"
        />
      </div>

      <!-- 密码登录 -->
      <template v-if="mode === 'password'">
        <div class="field">
          <span class="icon"><Icon name="lock" :size="18" /></span>
          <input
            v-model="password"
            type="password"
            placeholder="密码"
            autocomplete="current-password"
            aria-label="密码"
            @keydown.enter="submitPassword"
          />
        </div>
        <button class="btn btn-primary btn-block submit" :disabled="busy || !canSubmitPassword" @click="submitPassword">
          {{ busy ? '正在验证…' : '进入' }}
        </button>
      </template>

      <!-- 注册：手机号 + 邀请码 + 密码，不牵扯短信 -->
      <template v-if="mode === 'register'">
        <div class="field">
          <span class="icon"><Icon name="check" :size="18" /></span>
          <input
            v-model="inviteCode"
            type="text"
            maxlength="32"
            placeholder="邀请码"
            autocapitalize="characters"
            aria-label="邀请码"
          />
        </div>
        <div class="field">
          <span class="icon"><Icon name="lock" :size="18" /></span>
          <input
            v-model="password"
            type="password"
            placeholder="设置密码（至少 6 位）"
            autocomplete="new-password"
            aria-label="设置密码"
            @keydown.enter="submitRegister"
          />
        </div>
        <button
          class="btn btn-primary btn-block submit"
          :disabled="busy || !canSubmitRegister"
          @click="submitRegister"
        >
          {{ busy ? '正在创建…' : '注册并进入' }}
        </button>
      </template>

      <!-- 验证码快捷登录 -->
      <template v-else>
        <div class="field">
          <span class="icon"><Icon name="check" :size="18" /></span>
          <input
            v-model="code"
            type="text"
            inputmode="numeric"
            maxlength="6"
            placeholder="6 位验证码"
            autocomplete="one-time-code"
            aria-label="验证码"
          />
          <button class="send-code" :disabled="!canSend" @click="sendCode">
            {{ countdown > 0 ? `${countdown}s` : '获取验证码' }}
          </button>
        </div>

        <button
          class="btn btn-primary btn-block submit"
          :disabled="busy || !phoneOk || !code"
          @click="submitSms"
        >
          {{ busy ? '正在验证…' : '进入' }}
        </button>
      </template>

      <p v-if="err" class="err">{{ err }}</p>
      <p v-if="tip" class="tip">{{ tip }}</p>

      <!-- 短信只是登录的一种快捷方式，没配好不影响注册和登录 -->
      <p v-if="!smsReady && mode !== 'register'" class="hint">
        服务端没配置短信通道，所以没有「验证码登录」这一栏。<br />
        用手机号 + 密码照样进；注册要的是邀请码。
      </p>

      <button
        v-if="mode === 'password' && registerOpen"
        class="btn btn-block alt"
        @click="switchTo('register')"
      >
        还没有账号？注册一个
      </button>
      <button v-else-if="mode === 'register'" class="btn btn-block alt" @click="switchTo('password')">
        已经有账号了，去登录
      </button>

      <p v-if="mode === 'register'" class="hint muted">
        邀请码找管理员要。每个账号的记录互相看不见，只有你自己能打开。
      </p>
      <p class="hint muted">所有内容都只存在这台服务器上，不会流向别处。</p>
    </div>
  </div>
</template>

<style scoped>
.gate-card {
  text-align: center;
}

.tabs {
  display: flex;
  gap: 4px;
  padding: 4px;
  margin-bottom: 16px;
  border-radius: var(--r-full);
  background: var(--surface-2);
  border: 1px solid var(--border);
}

.tab {
  flex: 1;
  min-width: 0;
  padding: 8px 6px;
  border-radius: var(--r-full);
  font-size: 0.84rem;
  font-weight: 560;
  color: var(--text-2);
  white-space: nowrap;
  transition: background var(--dur), color var(--dur), box-shadow var(--dur);
}

.tab.on {
  background: var(--surface);
  color: var(--brand-deep);
  box-shadow: var(--shadow-xs);
}

:root[data-theme='dark'] .tab.on {
  color: var(--brand-soft);
}

.field + .field {
  margin-top: 10px;
}

.send-code {
  flex: 0 0 auto;
  padding: 7px 12px;
  border-radius: var(--r-sm);
  font-size: 0.8rem;
  font-weight: 560;
  color: var(--brand-deep);
  background: var(--brand-tint);
  white-space: nowrap;
  transition: opacity var(--dur);
}

:root[data-theme='dark'] .send-code {
  color: var(--brand-soft);
}

.send-code:disabled {
  opacity: var(--disabled-opacity);
}

.submit {
  margin-top: 16px;
}

.hint {
  margin-top: 14px;
  font-size: 0.8rem;
  color: var(--text-3);
  line-height: 1.7;
}

.muted {
  margin-top: 6px;
  opacity: 0.85;
}

/* 次级动作：和主按钮一样大，别做成句子里的小链接（点不准） */
.alt {
  margin-top: 12px;
  font-weight: 560;
}

.tip {
  margin-top: 12px;
  font-size: 0.8rem;
  color: var(--ai-text);
  line-height: 1.6;
  word-break: break-all;
}

.err {
  margin-top: 12px;
  font-size: 0.86rem;
  color: var(--rose-text);
}
</style>
