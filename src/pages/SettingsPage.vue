<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import Icon from '../components/Icon.vue';
import * as api from '../lib/api';
import { fullDate, hhmm } from '../lib/date';
import {
  entries,
  flushQueue,
  online,
  pendingCount,
  refresh,
  toast,
} from '../lib/store';

const oldPw = ref('');
const newPw = ref('');
const newPw2 = ref('');
const pwBusy = ref(false);
const pwMsg = ref('');
const showPw = ref(false);

const clearBusy = ref(false);

// 手机号就是账号，所以这里是「换手机号」（等于换账号）。
// 用当前密码验证，不用短信——注册都不靠短信了，这里再要验证码只会把人卡住。
const profile = ref<api.Profile | null>(null);
const showPhone = ref(false);
const newPhone = ref('');
const bindPassword = ref('');
const bindBusy = ref(false);
const bindMsg = ref('');

const phoneMasked = computed(() => profile.value?.phoneMasked || '');
const canSubmitPhone = computed(
  () => /^1[3-9]\d{9}$/.test(newPhone.value) && bindPassword.value.length > 0 && !bindBusy.value,
);

async function loadProfile() {
  try {
    profile.value = await api.getProfile();
  } catch {
    profile.value = null;
  }
}

async function submitBind() {
  bindMsg.value = '';
  bindBusy.value = true;
  try {
    const res = await api.changePhone(newPhone.value, bindPassword.value);
    profile.value = profile.value
      ? { ...profile.value, phone: res.phone, phoneMasked: res.phoneMasked }
      : profile.value;
    showPhone.value = false;
    newPhone.value = bindPassword.value = '';
    toast('手机号已更换，下次登录请用新号');
  } catch (e: any) {
    bindMsg.value = e?.message || '换号失败';
  } finally {
    bindBusy.value = false;
  }
}

// 账号就是手机号，所以没有「解绑」这个操作了（解绑完就没法登录了）

const totalChars = computed(() => entries.value.reduce((s, e) => s + e.content.length, 0));
const oldest = computed(() => {
  if (!entries.value.length) return '暂无';
  const t = Math.min(...entries.value.map((e) => e.createdAt));
  return fullDate(new Date(t).toISOString().slice(0, 10));
});

async function changePw() {
  pwMsg.value = '';
  if (newPw.value.length < 4) {
    pwMsg.value = '新密码至少 4 位';
    return;
  }
  if (newPw.value !== newPw2.value) {
    pwMsg.value = '两次输入的新密码不一致';
    return;
  }
  pwBusy.value = true;
  try {
    await api.changePassword(oldPw.value, newPw.value);
    oldPw.value = newPw.value = newPw2.value = '';
    showPw.value = false;
    toast('密码已修改，其它设备需要重新登录');
  } catch (e: any) {
    pwMsg.value = e?.message || '修改失败';
  } finally {
    pwBusy.value = false;
  }
}

/** 导出为 Markdown（按日期分节，直接能放进 Obsidian） */
function buildMarkdown(): string {
  const byDate = new Map<string, typeof entries.value>();
  for (const e of entries.value) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date)!.push(e);
  }
  const dates = [...byDate.keys()].sort().reverse();
  const lines: string[] = ['# 拾光 · 全部记录', '', `> 导出时间：${new Date().toLocaleString('zh-CN')}　共 ${entries.value.length} 条`, ''];
  for (const d of dates) {
    lines.push(`## ${d}`, '');
    const list = byDate.get(d)!.sort((a, b) => a.createdAt - b.createdAt);
    for (const e of list) {
      const time = hhmm(e.createdAt);
      const tags = e.tags.length ? `　${e.tags.map((t) => `#${t}`).join(' ')}` : '';
      const moodEmoji = e.mood ? ['', '😞', '😕', '😐', '🙂', '😄'][e.mood] : '';
      lines.push(`- **${time}** ${moodEmoji}${e.title ? ` **${e.title}**` : ''}${tags}`);
      for (const cl of e.content.split('\n')) lines.push(`  ${cl}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

function download(name: string, content: string, type = 'text/markdown;charset=utf-8') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  toast('已开始下载');
}

function exportMarkdown() {
  const stamp = new Date().toISOString().slice(0, 10);
  download(`拾光记录-${stamp}.md`, buildMarkdown());
}

function exportJSON() {
  const stamp = new Date().toISOString().slice(0, 10);
  download(`shiguang-backup-${stamp}.json`, JSON.stringify({ exportedAt: Date.now(), count: entries.value.length, entries: entries.value }, null, 2), 'application/json');
}

async function copyAll() {
  try {
    await navigator.clipboard.writeText(buildMarkdown());
    toast('全部记录已复制到剪贴板');
  } catch {
    toast('复制失败，请改用下载');
  }
}

async function syncNow() {
  await flushQueue();
  await refresh();
  toast('已同步');
}

async function clearLocal() {
  clearBusy.value = true;
  try {
    // 只清本地缓存；服务器上的数据不动
    localStorage.removeItem('shiguang.entries.v1');
    localStorage.removeItem('shiguang.queue.v1');
    localStorage.removeItem('shiguang.draft');
    await refresh();
    toast('本地缓存已清理，数据仍保存在服务器');
  } finally {
    clearBusy.value = false;
  }
}

onMounted(() => {
  refresh({ silent: true });
  loadProfile();
});
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1><Icon name="settings" :size="22" /> 设置</h1>
        <p class="sub">导出、数据情况、改密码</p>
      </div>
    </div>

    <!-- 数据概况 -->
    <div class="section-title"><h2><Icon name="book" :size="17" /> 数据情况</h2></div>
    <div class="card card-pad">
      <div class="kv">
        <span>记录总数</span>
        <b class="num">{{ entries.length }} 条</b>
      </div>
      <div class="kv">
        <span>写下多少字</span>
        <b class="num">{{ totalChars.toLocaleString() }} 字</b>
      </div>
      <div class="kv">
        <span>最早的一条</span>
        <b>{{ oldest }}</b>
      </div>
      <div class="kv">
        <span>数据存在哪</span>
        <b>你自己的服务器上</b>
      </div>
      <div class="kv">
        <span>同步</span>
        <b :style="pendingCount ? 'color: var(--amber-text)' : 'color: var(--mint)'">
          {{ !online ? '离线中' : pendingCount ? `${pendingCount} 条待同步` : '已同步' }}
        </b>
      </div>
      <button class="btn btn-sm" style="margin-top: 12px" :disabled="!online" @click="syncNow">
        <Icon name="refresh" :size="15" /> 立即同步
      </button>
    </div>

    <!-- 导出 -->
    <div class="section-title"><h2><Icon name="download" :size="17" /> 导出与备份</h2></div>
    <div class="card card-pad">
      <p class="note" style="margin-top: 0">
        服务器按天保存你的每一条记录，改动也留了历史。想搬到别处就点下面。
      </p>
      <div class="btn-row">
        <button class="btn btn-sm" @click="exportMarkdown">
          <Icon name="download" :size="15" /> 导出 Markdown
        </button>
        <button class="btn btn-sm" @click="exportJSON">
          <Icon name="download" :size="15" /> 导出 JSON
        </button>
        <button class="btn btn-sm" @click="copyAll">
          <Icon name="copy" :size="15" /> 复制全部
        </button>
      </div>
      <p class="note">
        导出的 Markdown 按日期分好节，能直接放进 Obsidian 当笔记。
      </p>
    </div>

    <!-- 安全 -->
    <div class="section-title"><h2><Icon name="lock" :size="17" /> 安全</h2></div>
    <div class="card card-pad">
      <template v-if="!showPw">
        <div class="kv">
          <span>登录密码</span>
          <button class="btn btn-sm" @click="showPw = true">
            <Icon name="lock" :size="15" /> 修改密码
          </button>
        </div>
      </template>

      <template v-else>
        <div class="label">当前密码</div>
        <div class="field">
          <input v-model="oldPw" type="password" placeholder="当前密码" autocomplete="current-password" />
        </div>
        <div class="label">新密码</div>
        <div class="field">
          <input v-model="newPw" type="password" placeholder="至少 4 位" autocomplete="new-password" />
        </div>
        <div class="label">再输一次</div>
        <div class="field">
          <input
            v-model="newPw2"
            type="password"
            placeholder="确认新密码"
            autocomplete="new-password"
            @keydown.enter="changePw"
          />
        </div>
        <p v-if="pwMsg" class="err">{{ pwMsg }}</p>
        <div class="btn-row" style="margin-top: 14px">
          <button class="btn btn-sm btn-primary" :disabled="pwBusy || !oldPw || !newPw" @click="changePw">
            {{ pwBusy ? '提交中…' : '保存新密码' }}
          </button>
          <button class="btn btn-sm" @click="showPw = false; pwMsg = ''">取消</button>
        </div>
        <p class="note">改完密码后，其它已登录的设备需要重新登录。</p>
      </template>

      <hr class="hr" />

      <!-- 手机号就是账号本身，所以这里是「换手机号」而不是「绑定/解绑」 -->
      <template v-if="!showPhone">
        <div class="kv">
          <span>账号（手机号）</span>
          <span class="kv-right"><em class="mono">{{ phoneMasked || '—' }}</em></span>
        </div>
        <div class="btn-row" style="margin-top: 12px">
          <button class="btn btn-sm" @click="showPhone = true">
            <Icon name="phone" :size="15" /> 换手机号
          </button>
        </div>
        <p class="note">
          手机号就是登录账号，所以只能换成另一个号，不能解绑。<br />
          换号要输当前密码——确认是本人操作。
        </p>
      </template>

      <template v-else>
        <div class="label">新手机号</div>
        <div class="field">
          <input v-model="newPhone" type="tel" inputmode="numeric" maxlength="11" placeholder="11 位手机号" />
        </div>
        <div class="label">当前密码</div>
        <div class="field">
          <input
            v-model="bindPassword"
            type="password"
            placeholder="确认是你本人在操作"
            autocomplete="current-password"
            @keydown.enter="canSubmitPhone && submitBind()"
          />
        </div>
        <p v-if="bindMsg" class="err">{{ bindMsg }}</p>
        <div class="btn-row" style="margin-top: 14px">
          <button class="btn btn-sm btn-primary" :disabled="!canSubmitPhone" @click="submitBind">
            {{ bindBusy ? '提交中…' : '确认更换' }}
          </button>
          <button class="btn btn-sm" @click="showPhone = false; bindMsg = ''">取消</button>
        </div>
        <p class="note">换完以后，登录请用新手机号；原来的号会释放出来，别人可以用它注册。</p>
      </template>
    </div>

    <!-- 其它 -->
    <div class="section-title"><h2><Icon name="settings" :size="17" /> 其它</h2></div>
    <div class="card card-pad">
      <div class="kv">
        <span>清理本地缓存</span>
        <button class="btn btn-sm" :disabled="clearBusy" @click="clearLocal">
          {{ clearBusy ? '处理中…' : '清理' }}
        </button>
      </div>
      <p class="note">只清浏览器里的副本，服务器上的记录不受影响。</p>

      <div class="kv" style="margin-top: 14px">
        <span>快捷键</span>
        <b><kbd>N</kbd> 直接开写 · <kbd>V</kbd> 直接开说</b>
      </div>
    </div>

    <p class="version">拾光 v1.0.0 · 数据都在你自己的服务器上</p>
  </div>
</template>

<style scoped>
.kv {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 9px 0;
  font-size: 0.92rem;
  border-bottom: 1px solid var(--border);
}

.kv:last-of-type {
  border-bottom: none;
}

.kv > span {
  color: var(--text-2);
}

.kv b {
  font-weight: 600;
}

kbd {
  display: inline-block;
  padding: 1px 7px;
  border-radius: 6px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  font-family: var(--font-num);
  font-size: 0.82rem;
  margin-right: 4px;
}

.note {
  font-size: 0.8rem;
  color: var(--text-3);
  line-height: 1.75;
  margin-top: 12px;
}

.btn-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.err {
  color: var(--rose);
  font-size: 0.84rem;
  margin-top: 9px;
}

/* 手机号绑定区 */
.hr {
  height: 1px;
  border: none;
  background: var(--border);
  margin: 16px 0 4px;
}

.kv-right {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.kv-right em {
  font-style: normal;
  font-weight: 560;
}

.mono {
  font-family: var(--font-num);
  letter-spacing: 0.03em;
  color: var(--text);
}

.dim {
  color: var(--text-3);
  font-weight: 460;
}

.field .send-code {
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

:root[data-theme='dark'] .field .send-code {
  color: var(--brand-soft);
}

.field .send-code:disabled {
  opacity: var(--disabled-opacity);
}

.note.ok {
  color: var(--ai-text);
}

.note code {
  font-family: var(--font-num);
  font-size: 0.94em;
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--surface-3);
}

.version {
  text-align: center;
  font-size: 0.76rem;
  color: var(--text-3);
  margin-top: 30px;
}
</style>
