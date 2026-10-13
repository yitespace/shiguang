<script setup lang="ts">
// =============================================================
// 登录 / 注册
//
// 账号就是手机号。页面上只留两条路：
//   登录 —— 手机号 + 密码（配了短信的话多一栏「验证码登录」）
//   注册 —— 手机号 + 邀请码 + 自己设的密码
//
// 设计上刻意克制：
//   · 一个动作只有一个入口。有「注册」页签就不再放「去注册」按钮
//   · 每种模式只显示自己需要的输入框，绝不并排出现
//   · 底部最多一句提示，且只在真的需要时出现
// =============================================================
import { computed, onMounted, onUnmounted, ref } from 'vue';
import Icon from '../components/Icon.vue';
import * as api from '../lib/api';
import { doLogin, doRegister, reloadSession } from '../lib/store';

type Mode = 'password' | 'sms' | 'register';

const mode = ref<Mode>('password');

const phone = ref('');
const password = ref('');
const code = ref('');
const inviteCode = ref('');
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

const canSubmitLogin = computed(() => phoneOk.value && password.value.length > 0);
const canSubmitSms = computed(() => phoneOk.value && code.value.length >= 4);
const canSubmitRegister = computed(
  () => phoneOk.value && inviteCode.value.trim().length >= 4 && password.value.length >= 6,
);

/** 页签：能用的才出现。没配短信就只有「登录 / 注册」两个 */
const tabs = computed(() => {
  const list: { key: Mode; label: string }[] = [{ key: 'password', label: '登录' }];
  if (smsReady.value) list.push({ key: 'sms', label: '验证码登录' });
  if (registerOpen.value) list.push({ key: 'register', label: '注册' });
  return list;
});

/** 底部提示：只在真的需要说的时候才占一行 */
const hint = computed(() => {
  if (mode.value === 'register') return '邀请码找管理员要。每个人的记录互相看不见。';
  if (mode.value === 'sms') return '没收到？60 秒后可以重发。';
  return '';
});

async function loadMethods() {
  try {
    const m = await api.authMethods();
    methods.value = m;
    // 一个号都还没有 → 默认停在注册，管理员进来第一眼就知道该干嘛
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
      code.value = res.devCode;
      tip.value = `测试模式：验证码 ${res.devCode}`;
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

async function run(fn: () => Promise<unknown>, fallback: string) {
  if (busy.value) return;
  busy.value = true;
  err.value = '';
  try {
    await fn();
  } catch (e: any) {
    err.value = e?.message || fallback;
    password.value = '';
  } finally {
    busy.value = false;
  }
}

const submitLogin = () => canSubmitLogin.value && run(() => doLogin(phone.value, password.value), '登录失败');

const submitSms = () =>
  canSubmitSms.value &&
  run(async () => {
    await api.smsLogin(phone.value, code.value);
    await reloadSession();
  }, '登录失败');

const submitRegister = () =>
  canSubmitRegister.value &&
  run(() => doRegister(phone.value, inviteCode.value.trim(), password.value), '注册失败');

onMounted(loadMethods);
onUnmounted(() => window.clearInterval(timer));
</script>

<template>
  <div class="gate">
    <div class="gate-card">
      <div class="gate-mark"><Icon name="feather" :size="30" /></div>
      <h1>拾光</h1>
      <p class="desc">随手记下每天发生的事，<br />再用对话的方式，把它们找回来。</p>

      <!-- 登录 / 注册。配了短信才会多出「验证码登录」 -->
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

      <!-- 手机号：三种模式都要 -->
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

      <!-- ① 密码登录 -->
      <template v-if="mode === 'password'">
        <div class="field">
          <span class="icon"><Icon name="lock" :size="18" /></span>
          <input
            v-model="password"
            type="password"
            placeholder="密码"
            autocomplete="current-password"
            aria-label="密码"
            @keydown.enter="submitLogin"
          />
        </div>
        <button class="btn btn-primary btn-block submit" :disabled="busy || !canSubmitLogin" @click="submitLogin">
          {{ busy ? '正在验证…' : '进入' }}
        </button>
      </template>

      <!-- ② 验证码登录（只有配了短信才有这一栏） -->
      <template v-else-if="mode === 'sms'">
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
            @keydown.enter="submitSms"
          />
          <button class="send-code" :disabled="!canSend" @click="sendCode">
            {{ countdown > 0 ? `${countdown}s` : '获取验证码' }}
          </button>
        </div>
        <button class="btn btn-primary btn-block submit" :disabled="busy || !canSubmitSms" @click="submitSms">
          {{ busy ? '正在验证…' : '进入' }}
        </button>
      </template>

      <!-- ③ 注册 -->
      <template v-else>
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
        <button class="btn btn-primary btn-block submit" :disabled="busy || !canSubmitRegister" @click="submitRegister">
          {{ busy ? '正在创建…' : '注册并进入' }}
        </button>
      </template>

      <p v-if="err" class="err">{{ err }}</p>
      <p v-else-if="tip" class="tip">{{ tip }}</p>
      <p v-else-if="hint" class="hint">{{ hint }}</p>
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
  padding: 9px 6px;
  border-radius: var(--r-full);
  font-size: 0.86rem;
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

/* 报错 / 提示 / 说明共用一行，同时只出现一条，不叠着占地方 */
.err,
.tip,
.hint {
  margin-top: 14px;
  font-size: 0.8rem;
  line-height: 1.7;
}

.err {
  color: var(--rose-text);
  font-size: 0.86rem;
}

.tip {
  color: var(--ai-text);
  word-break: break-all;
}

.hint {
  color: var(--text-3);
}
</style>
