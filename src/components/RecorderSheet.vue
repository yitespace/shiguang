<script setup lang="ts">
// =============================================================
// 记一笔 · 底部弹层
// 支持：内容 / 标题 / 标签 / 心情 / 归属日期时间
// 会从正文里自动识别「昨天」「9月17号」这类时间词并预填日期
// =============================================================
import { computed, nextTick, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { MOODS, type Mood } from '../types';
import { addDays, hhmm, relativeDay, shortDate, today, weekdayOf, ymd } from '../lib/date';
import { clearDraft, entries, loadDraft, removeEntry, restoreEntry, saveDraft, saveEntry, toast } from '../lib/store';

const props = defineProps<{ open: boolean; entryId?: string | null }>();
const emit = defineEmits<{ (e: 'update:open', v: boolean): void }>();

const content = ref('');
const title = ref('');
const tagList = ref<string[]>([]);
const tagInput = ref('');
const mood = ref<Mood | null>(null);
const date = ref(today());
const time = ref(hhmm(Date.now()));
const showMore = ref(false);
const saving = ref(false);
const ta = ref<HTMLTextAreaElement | null>(null);
/** 恢复出来的草稿时间（用于提示） */
const draftAt = ref(0);

const isEdit = computed(() => !!props.entryId);
const existing = computed(() => entries.value.find((e) => e.id === props.entryId) || null);

const dateChips = computed(() => [
  { v: today(), label: '今天' },
  { v: addDays(today(), -1), label: '昨天' },
  { v: addDays(today(), -2), label: '前天' },
]);

const relLabel = computed(() => relativeDay(date.value));
const datePretty = computed(() => `${shortDate(date.value)} 周${weekdayOf(date.value)}`);

/** 从正文里猜日期：「昨天」「9月17号」「3天前」 */
function guessDate(text: string): string | null {
  const t = text;
  if (/今天|今日/.test(t)) return today();
  if (/昨天|昨日/.test(t)) return addDays(today(), -1);
  if (/前天/.test(t) && !/大前天/.test(t)) return addDays(today(), -2);
  if (/大前天/.test(t)) return addDays(today(), -3);
  const n = /(\d{1,3})\s*天前/.exec(t);
  if (n) return addDays(today(), -Number(n[1]));
  const md = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/.exec(t);
  if (md) {
    const mo = Number(md[1]);
    const d = Number(md[2]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      const y = new Date().getFullYear();
      const guess = ymd(new Date(y, mo - 1, d));
      // 还没到的日期，认为说的是去年
      return guess > today() ? ymd(new Date(y - 1, mo - 1, d)) : guess;
    }
  }
  return null;
}

let guessTouched = false;

function autoResize() {
  const el = ta.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
}

function addTag(raw?: string) {
  const t = (raw ?? tagInput.value).trim().replace(/^#/, '');
  if (!t) return;
  if (!tagList.value.includes(t) && tagList.value.length < 12) tagList.value.push(t);
  tagInput.value = '';
}

function removeTag(t: string) {
  tagList.value = tagList.value.filter((x) => x !== t);
}

/** 切到语音记录 */
function switchToVoice() {
  emit('update:open', false);
  window.dispatchEvent(new CustomEvent('sg:voice'));
}

function reset() {
  content.value = '';
  title.value = '';
  tagList.value = [];
  tagInput.value = '';
  mood.value = null;
  date.value = today();
  time.value = hhmm(Date.now());
  showMore.value = false;
  draftAt.value = 0;
  guessTouched = false;
}

/** 打开时载入数据 */
watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    if (props.entryId && existing.value) {
      const e = existing.value;
      content.value = e.content;
      title.value = e.title;
      tagList.value = [...e.tags];
      mood.value = (e.mood as Mood) ?? null;
      date.value = e.date;
      time.value = hhmm(e.createdAt);
      showMore.value = true;
      guessTouched = true;
    } else {
      reset();
      // 恢复上次没写完的草稿
      const d = loadDraft();
      if (d) {
        content.value = d.text;
        draftAt.value = d.at;
        toast(`恢复了上次没写完的内容（${hhmm(d.at)}）`);
      }
    }
    await nextTick();
    autoResize();
    ta.value?.focus();
  },
);

/** 正文里出现时间词时自动改归属日期（用户手动改过就不再覆盖） */
watch(content, (v) => {
  autoResize();
  // 新建记录时自动存草稿，关掉页面也不怕
  if (!isEdit.value) saveDraft(v);
  if (guessTouched || isEdit.value) return;
  const g = guessDate(v);
  if (g && g !== date.value) {
    date.value = g;
    toast(`已识别为 ${shortDate(g)} 的记录`);
  }
});

function pickDate(d: string) {
  date.value = d;
  guessTouched = true;
}

async function submit() {
  const text = content.value.trim();
  if (!text || saving.value) return;
  saving.value = true;

  // 组装时间戳（日期 + 时分）
  const [hh, mm] = time.value.split(':').map(Number);
  const [yy, mo, dd] = date.value.split('-').map(Number);
  const ts = new Date(yy, mo - 1, dd, hh || 0, mm || 0).getTime();

  const keep = { content: text, title: title.value.trim(), tags: [...tagList.value], mood: mood.value, date: date.value };
  emit('update:open', false);
  saving.value = false;

  await saveEntry(isEdit.value && props.entryId ? { id: props.entryId, ...keep, createdAt: ts } : { ...keep, createdAt: ts });
  if (isEdit.value) toast('已更新');
  else clearDraft();
  draftAt.value = 0;
}

/** 删除：先本地移除，再给一次撤销的机会 */
async function del() {
  if (!props.entryId) return;
  const id = props.entryId;
  emit('update:open', false);
  const removed = await removeEntry(id);
  if (removed) toast('已删除', { label: '撤销', run: () => restoreEntry(removed) });
}
</script>

<template>
  <Teleport to="body">
    <Transition name="sheet">
      <div v-if="open" class="sheet-mask" @click.self="emit('update:open', false)">
        <div class="sheet recorder">
          <div class="sheet-grabber"></div>

          <div class="sheet-title">
            <h3>{{ isEdit ? '编辑这条记录' : '现在发生了什么？' }}</h3>
            <button class="icon-btn" title="关闭" @click="emit('update:open', false)">
              <Icon name="x" :size="19" />
            </button>
          </div>

          <!-- 归属日期 -->
          <div class="when">
            <button
              v-for="c in dateChips"
              :key="c.v"
              class="chip"
              :class="{ 'is-active': date === c.v }"
              @click="pickDate(c.v)"
            >
              {{ c.label }}
            </button>
            <label class="chip date-pick" :class="{ 'is-active': !dateChips.some((c) => c.v === date) }">
              <Icon name="calendar" :size="14" />
              {{ dateChips.some((c) => c.v === date) ? '选日期' : datePretty }}
              <input v-model="date" type="date" @change="guessTouched = true" />
            </label>
            <label class="chip time-pick">
              <Icon name="clock" :size="14" />
              <input v-model="time" type="time" />
            </label>
          </div>
          <p v-if="relLabel && !dateChips.some((c) => c.v === date)" class="when-hint">
            这条会记在「{{ relLabel }}」（{{ datePretty }}）
          </p>

          <!-- 正文 -->
          <div class="field main-field">
            <textarea
              ref="ta"
              v-model="content"
              rows="4"
              placeholder="今天做了…（回车换行，Ctrl/⌘ + Enter 保存）"
              @keydown.ctrl.enter="submit"
              @keydown.meta.enter="submit"
            ></textarea>
          </div>

          <!-- 心情 -->
          <div class="label">此刻心情（可不填）</div>
          <div class="mood-row">
            <button
              v-for="m in MOODS"
              :key="m.v"
              class="mood-btn"
              :class="{ 'is-active': mood === m.v }"
              :style="{ '--mood-color': m.color }"
              @click="mood = mood === m.v ? null : m.v"
            >
              <span class="emoji">{{ m.emoji }}</span>
              <span class="label">{{ m.label }}</span>
            </button>
          </div>

          <!-- 标签 -->
          <div class="label">标签</div>
          <div class="tags-row">
            <span v-for="t in tagList" :key="t" class="tag tag-brand tag-x" @click="removeTag(t)">
              #{{ t }}
              <Icon name="x" :size="11" />
            </span>
            <input
              v-model="tagInput"
              class="tag-input"
              placeholder="+ 加标签"
              @keydown.enter.prevent="addTag()"
              @keydown.,.prevent="addTag()"
              @blur="addTag()"
            />
          </div>

          <!-- 标题（可选） -->
          <button class="more-toggle" @click="showMore = !showMore">
            <Icon :name="showMore ? 'x' : 'plus'" :size="14" />
            {{ showMore ? '收起' : '加个标题（可选）' }}
          </button>
          <div v-if="showMore" class="field">
            <input v-model="title" placeholder="标题，例如「综治平台接口联调」" maxlength="60" />
          </div>

          <!-- 操作 -->
          <div class="acts">
            <button v-if="isEdit" class="btn btn-danger" @click="del">
              <Icon name="trash" :size="16" /> 删除
            </button>
            <button v-else class="btn btn-voice" title="改成用说的" @click="switchToVoice">
              <Icon name="mic" :size="16" /> 用说的
            </button>
            <div class="spacer"></div>
            <button class="btn" @click="emit('update:open', false)">取消</button>
            <button class="btn btn-primary" :disabled="!content.trim() || saving" @click="submit">
              <Icon name="check" :size="16" />
              {{ isEdit ? '保存修改' : '记下来' }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.btn-voice {
  color: var(--ai);
  border-color: color-mix(in srgb, var(--ai) 28%, transparent);
  background: var(--ai-tint);
}

.recorder {
  max-width: min(640px, 100%);
}

.when {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.date-pick,
.time-pick {
  position: relative;
  cursor: pointer;
  overflow: hidden;
}

.date-pick input,
.time-pick input {
  position: absolute;
  inset: 0;
  opacity: 0;
  width: 100%;
  height: 100%;
  cursor: pointer;
  border: none;
  background: none;
}

.when-hint {
  font-size: 0.78rem;
  color: var(--brand-deep);
  margin: -4px 2px 10px;
}

:root[data-theme='dark'] .when-hint {
  color: var(--brand-soft);
}

.main-field {
  align-items: flex-start;
  padding: 14px;
}

.main-field textarea {
  font-size: 1rem;
  line-height: 1.75;
  min-height: 96px;
}

.tags-row {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  padding: 9px 12px;
  border-radius: var(--r);
  background: var(--surface);
  border: 1px solid var(--border);
}

.tag-x {
  cursor: pointer;
  gap: 3px;
}

.tag-input {
  flex: 1;
  min-width: 96px;
  border: none;
  background: none;
  outline: none;
  font-size: 0.88rem;
}

.more-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 14px 2px 8px;
  font-size: 0.84rem;
  color: var(--text-3);
}

.more-toggle:hover {
  color: var(--brand-deep);
}

.acts {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-top: 20px;
}

.spacer {
  flex: 1;
}

@media (max-width: 460px) {
  .acts .btn {
    padding: 11px 14px;
  }
}
</style>
