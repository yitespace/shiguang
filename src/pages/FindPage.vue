<script setup lang="ts">
// =============================================================
// 拾迹
// 拾迹（原名「找回」）：之前「检索」和「AI 对话」是两个页面，但背后是同一件事：
// 都是「从我的记录里找出某段回忆」。合并成一个输入框：
//   · 打字立刻出结果列表（毫秒级，本地索引）
//   · 按回车或点「问 AI」让 AI 读完相关记录，给一段回答
//   · 回答下面直接列出它依据的记录，能就地展开、能跳去那天
// =============================================================
import { computed, nextTick, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import { hhmm, shortDate, today, weekdayOf } from '../lib/date';
import { highlight, renderMarkdown } from '../lib/markdown';
import * as api from '../lib/api';
import { aiReady, allTags, clearSearches, entries, loadSearches, pushSearch, refresh, toast } from '../lib/store';
import { moodOf, type AiMeta, type Entry, type Hit } from '../types';

const router = useRouter();

const q = ref('');
const typed = ref(false);
const inputRef = ref<HTMLInputElement | null>(null);
const scroller = ref<HTMLElement | null>(null);

// 检索
const hits = ref<Hit[]>([]);
const keywords = ref('');
const searching = ref(false);
let seq = 0;
let timer: number | undefined;

// AI 回答
const asking = ref(false);
const asked = ref('');           // 这次问的是什么
const answer = ref('');
const refs = ref<string[]>([]);
const cited = ref<Entry[]>([]);  // AI 依据的记录
const meta = ref<AiMeta | null>(null);
const errorMsg = ref('');
const showAllCited = ref(false);
let abort: (() => void) | null = null;

const recent = ref<string[]>([]);

const SUGGESTS = [
  '今天做了什么？',
  '昨天呢？',
  '这一周我主要在忙什么？',
  '这个月工作上推进了哪些事？',
  '最近我的心情怎么样？',
  '我软考复习到哪一步了？',
];

const activeTags = computed(() => allTags.value.slice(0, 12));
const shownCited = computed(() => (showAllCited.value ? cited.value : cited.value.slice(0, 3)));

/** 打字时实时检索（本地索引很快，防抖 200ms 就够） */
function onInput() {
  typed.value = !!q.value.trim();
  window.clearTimeout(timer);
  const text = q.value.trim();
  if (!text) {
    hits.value = [];
    keywords.value = '';
    return;
  }
  timer = window.setTimeout(async () => {
    const my = ++seq;
    searching.value = true;
    try {
      const res = await api.search(text, 40);
      if (my !== seq) return;
      hits.value = res.hits;
      keywords.value = res.keywords;
      if (res.hits.length) recent.value = pushSearch(text);
    } catch {
      if (my === seq) hits.value = [];
    } finally {
      if (my === seq) searching.value = false;
    }
  }, 200);
}

/**
 * 兜底：服务端偶尔会因为上下文挑选策略没命中而回一个空的 entries，
 * 但模型自己会在回答末尾列出它引用过的日期。
 * 这时候不要只甩几个日期给用户看——本地本来就存着全部记录，
 * 直接按日期把它们捞出来，照样能展开原文、点进去跳到那天。
 */
function citedFromRefs(dates: string[]): Entry[] {
  if (!dates?.length) return [];
  const wanted = new Set(dates);
  return entries.value
    .filter((e) => wanted.has(e.date))
    .sort((a, b) => (a.date === b.date ? b.createdAt - a.createdAt : a.date < b.date ? 1 : -1))
    .slice(0, 30);
}

/** 问 AI：暂停打字检索，进入回答态 */
async function ask(question?: string) {  const text = (question ?? q.value).trim();
  if (!text || asking.value) return;
  if (!aiReady.value) {
    toast('服务端没有配置 AI');
    return;
  }
  q.value = text;
  typed.value = true;
  asked.value = text;
  answer.value = '';
  refs.value = [];
  cited.value = [];
  meta.value = null;
  errorMsg.value = '';
  showAllCited.value = false;
  asking.value = true;
  hits.value = [];
  await scrollDown();

  const history: { role: string; content: string }[] = [];

  await new Promise<void>((resolve) => {
    abort = api.askStream(text, history, {
      onDelta: (t) => {
        answer.value += t;
        scrollDown(false);
      },
      onDone: (payload) => {
        answer.value = payload.answer || answer.value;
        refs.value = payload.refs || [];
        cited.value = payload.entries?.length ? payload.entries : citedFromRefs(refs.value);
        meta.value = payload.meta;
        asking.value = false;
        abort = null;
        resolve();
      },
      onError: (msg) => {
        errorMsg.value = msg;
        asking.value = false;
        abort = null;
        resolve();
      },
    });
  });
  await scrollDown();
}

function stopAsk() {
  abort?.();
  abort = null;
  asking.value = false;
}

function reset() {
  stopAsk();
  q.value = '';
  typed.value = false;
  hits.value = [];
  asked.value = '';
  answer.value = '';
  refs.value = [];
  cited.value = [];
  meta.value = null;
  errorMsg.value = '';
  nextTick(() => inputRef.value?.focus());
}

async function scrollDown(smooth = true) {
  await nextTick();
  const el = scroller.value;
  if (!el) return;
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

function goDay(date: string) {
  router.push(`/calendar?d=${date}`);
}

function useTerm(t: string) {
  q.value = t;
  onInput();
  inputRef.value?.focus();
}

function forgetRecent() {
  clearSearches();
  recent.value = [];
  toast('已清空搜索历史');
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    ask();
  }
  if (e.key === 'Escape') reset();
}

onMounted(async () => {
  await refresh({ silent: true });
  recent.value = loadSearches();
  inputRef.value?.focus();
});
</script>

<template>
  <div class="find-page">
    <div class="page-head">
      <div>
        <h1><Icon name="search" :size="22" /> 拾迹</h1>
        <p class="sub">打字直接搜，按回车让 AI 读完记录给你讲</p>
      </div>
    </div>

    <!-- 输入区 -->
    <div class="ask-box">
      <span class="ask-icon"><Icon name="search" :size="19" /></span>
      <input
        ref="inputRef"
        v-model="q"
        type="search"
        placeholder="搜「沈警官」「软考」，或直接问「上周三我在忙什么」"
        aria-label="搜索或提问"
        @input="onInput"
        @keydown="onKeydown"
      />
      <button v-if="q" class="clear" title="清空" aria-label="清空" @click="reset">
        <Icon name="x" :size="17" />
      </button>
      <button v-if="asking" class="ask-btn stop" title="停止" @click="stopAsk">
        <Icon name="x" :size="16" />
      </button>
      <button v-else class="ask-btn" :disabled="!q.trim()" title="让 AI 回答" @click="ask()">
        <Icon name="sparkles" :size="16" />
        <span>问 AI</span>
      </button>
    </div>
    <p v-if="q.trim()" class="enter-hint">按 <kbd>Enter</kbd> 让 AI 回答，<kbd>Esc</kbd> 清空</p>

    <div ref="scroller" class="find-scroll">
      <!-- ============ 空状态：给方向 ============ -->
      <template v-if="!typed">
        <section class="block">
          <h2 class="block-title">试试这样问</h2>
          <div class="chips">
            <button v-for="s in SUGGESTS" :key="s" class="chip suggest" @click="ask(s)">
              <Icon name="sparkles" :size="13" />
              {{ s }}
            </button>
          </div>
        </section>

        <section v-if="recent.length" class="block">
          <h2 class="block-title">
            搜过的
            <button class="link-btn" @click="forgetRecent">清空</button>
          </h2>
          <div class="chips">
            <button v-for="r in recent" :key="r" class="chip" @click="useTerm(r)">
              <Icon name="history" :size="13" />
              {{ r }}
            </button>
          </div>
        </section>

        <section v-if="activeTags.length" class="block">
          <h2 class="block-title">按标签找</h2>
          <div class="chips">
            <button v-for="t in activeTags" :key="t.name" class="chip" @click="useTerm(t.name)">
              #{{ t.name }}
              <em class="cnt">{{ t.count }}</em>
            </button>
          </div>
        </section>
      </template>

      <!-- ============ AI 回答 ============ -->
      <section v-if="asked" class="answer">
        <div class="asked-line">
          <Icon name="search" :size="14" />
          <span>{{ asked }}</span>
        </div>

        <div class="bubble ai">
          <div v-if="asking && !answer" class="think-dot"><i></i><i></i><i></i></div>
          <div v-else-if="errorMsg" class="err">
            <Icon name="alert" :size="15" />
            <span>{{ errorMsg }}</span>
          </div>
          <div v-else class="md" v-html="renderMarkdown(answer)"></div>
          <span v-if="asking && answer" class="typing-caret"></span>
        </div>

        <!-- AI 依据的记录：就地看，不用跳走 -->
        <div v-if="cited.length" class="cited">
          <div class="cited-head">
            <span>依据 {{ cited.length }} 条记录</span>
            <span v-if="meta?.range" class="scope">{{ meta.range.label }}</span>
          </div>
          <article v-for="e in shownCited" :key="e.id" class="cited-item" @click="goDay(e.date)">
            <div class="cited-meta">
              <span class="cited-date">{{ shortDate(e.date) }} 周{{ weekdayOf(e.date) }}</span>
              <span class="cited-time num">{{ hhmm(e.createdAt) }}</span>
              <span v-if="moodOf(e.mood)" class="cited-mood">{{ moodOf(e.mood)!.emoji }}</span>
            </div>
            <p class="cited-text">{{ e.content }}</p>
            <div v-if="e.tags.length" class="cited-tags">
              <span v-for="t in e.tags" :key="t" class="tag">#{{ t }}</span>
            </div>
          </article>
          <button v-if="cited.length > 3" class="link-btn more" @click="showAllCited = !showAllCited">
            {{ showAllCited ? '收起' : `展开全部 ${cited.length} 条` }}
          </button>
        </div>

        <div v-else-if="refs.length" class="cited">
          <div class="cited-head"><span>依据的日期</span></div>
          <div class="chips">
            <button v-for="d in refs" :key="d" class="chip" @click="goDay(d)">
              {{ shortDate(d) }}
            </button>
          </div>
        </div>

        <div class="answer-acts">
          <button class="btn btn-sm" @click="goDay(meta?.range?.from || today())">
            <Icon name="calendar" :size="14" /> 去那天看看
          </button>
          <button class="btn btn-sm" @click="ask(asked)">
            <Icon name="refresh" :size="14" /> 重新问
          </button>
        </div>
      </section>

      <!-- ============ 搜到的记录 ============ -->
      <section v-else-if="typed" class="results">
        <div class="results-head">
          <span v-if="searching">正在搜…</span>
          <span v-else-if="hits.length">找到 {{ hits.length }} 条</span>
          <span v-else>没有匹配「{{ q }}」的记录</span>
        </div>

        <div v-if="!hits.length && !searching" class="empty">
          <span class="big">🔍</span>
          <p class="tip">
            换个词试试，或者按 <kbd>Enter</kbd> 让 AI 帮你找。<br />
            记的都是你自己的话，用当时的说法最容易搜到。
          </p>
        </div>

        <article v-for="h in hits" :key="h.entry.id" class="hit" @click="goDay(h.entry.date)">
          <div class="hit-meta">
            <span class="hit-date">{{ shortDate(h.entry.date) }} 周{{ weekdayOf(h.entry.date) }}</span>
            <span class="hit-time num">{{ hhmm(h.entry.createdAt) }}</span>
            <span v-if="moodOf(h.entry.mood)" class="hit-mood">{{ moodOf(h.entry.mood)!.emoji }}</span>
          </div>
          <p class="hit-text" v-html="highlight(h.entry.content, keywords)"></p>
          <div v-if="h.entry.tags.length" class="hit-tags">
            <span v-for="t in h.entry.tags" :key="t" class="tag">#{{ t }}</span>
          </div>
        </article>
      </section>

      <div class="tail" aria-hidden="true"></div>
    </div>
  </div>
</template>

<style scoped>
.find-page {
  display: flex;
  flex-direction: column;
  min-height: calc(100dvh - 200px);
}

/* ---------- 输入区 ---------- */
.ask-box {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 6px 6px 14px;
  border-radius: var(--r-lg);
  background: var(--surface);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-sm);
  transition: border-color var(--dur), box-shadow var(--dur);
}

.ask-box:focus-within {
  border-color: color-mix(in srgb, var(--brand) 45%, transparent);
  box-shadow: 0 0 0 3px var(--brand-tint);
}

.ask-icon {
  color: var(--text-3);
  display: grid;
  place-items: center;
  flex: 0 0 auto;
}

.ask-box input {
  flex: 1;
  min-width: 0;
  border: none;
  background: none;
  outline: none;
  font-size: 0.97rem;
  padding: 9px 0;
}

.ask-box input::-webkit-search-cancel-button {
  display: none;
}

.clear {
  flex: 0 0 auto;
  width: 30px;
  height: 30px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  color: var(--text-3);
}

.clear:hover {
  background: var(--surface-2);
  color: var(--text);
}

.ask-btn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 9px 14px;
  border-radius: var(--r-sm);
  font-size: 0.86rem;
  font-weight: 600;
  color: var(--on-ai);
  background: var(--ai-grad);
  box-shadow: 0 2px 8px -2px rgba(32, 130, 125, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.22);
  transition: transform var(--dur), opacity var(--dur);
}

.ask-btn:active {
  transform: scale(0.96);
}

.ask-btn:disabled {
  opacity: var(--disabled-opacity);
  box-shadow: none;
}

.ask-btn.stop {
  background: var(--surface-3);
  color: var(--text-2);
  box-shadow: none;
  padding: 9px 12px;
}

.enter-hint {
  font-size: 0.72rem;
  color: var(--text-3);
  margin: 7px 2px 0;
}

.enter-hint kbd {
  display: inline-block;
  padding: 0 5px;
  border-radius: 5px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  font-family: var(--font-num);
  font-size: 0.7rem;
}

/* ---------- 内容区 ---------- */
.find-scroll {
  flex: 1;
  margin-top: 16px;
}

.block + .block {
  margin-top: 22px;
}

.block-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 0.82rem;
  font-weight: 560;
  color: var(--text-2);
  margin-bottom: 10px;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}

.chip.suggest {
  text-align: left;
}

.chip .cnt {
  font-style: normal;
  font-size: 0.7rem;
  color: var(--text-3);
}

.link-btn {
  font-size: 0.76rem;
  color: var(--text-3);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.link-btn:hover {
  color: var(--brand-deep);
}

.link-btn.more {
  display: block;
  width: 100%;
  margin-top: 10px;
  text-align: center;
  padding: 6px 0;
}

/* ---------- AI 回答 ---------- */
.answer {
  padding-bottom: 8px;
}

.asked-line {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 0.8rem;
  color: var(--text-3);
  margin-bottom: 9px;
}

.bubble.ai {
  padding: 14px 16px;
  border-radius: var(--r-lg) var(--r-lg) var(--r-lg) 6px;
  background: var(--surface);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-xs);
}

.md {
  font-size: 0.94rem;
  line-height: 1.8;
}

.md :deep(p) {
  margin: 0 0 9px;
}

.md :deep(p:last-child) {
  margin-bottom: 0;
}

.md :deep(ul),
.md :deep(ol) {
  margin: 7px 0;
  padding-left: 20px;
}

.md :deep(li) {
  margin: 3px 0;
}

.md :deep(h2),
.md :deep(h3) {
  font-size: 0.98rem;
  margin: 12px 0 6px;
}

.md :deep(strong) {
  font-weight: 650;
}

.md :deep(blockquote) {
  margin: 8px 0;
  padding-left: 11px;
  border-left: 3px solid var(--border-2);
  color: var(--text-2);
}

.err {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--rose);
  font-size: 0.88rem;
}

/* ---------- 依据的记录 ---------- */
.cited {
  margin-top: 14px;
}

.cited-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.76rem;
  color: var(--text-3);
  margin-bottom: 8px;
}

.scope {
  padding: 1px 8px;
  border-radius: var(--r-full);
  background: var(--ai-tint);
  color: var(--ai-text);
  font-weight: 600;
}

.cited-item {
  padding: 11px 13px;
  border-radius: var(--r);
  background: var(--surface);
  border: 1px solid var(--border);
  cursor: pointer;
  transition: border-color var(--dur), box-shadow var(--dur);
}

.cited-item + .cited-item {
  margin-top: 7px;
}

.cited-item:hover {
  border-color: var(--border-2);
  box-shadow: var(--shadow-xs);
}

.cited-meta,
.hit-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.72rem;
  color: var(--text-3);
  margin-bottom: 5px;
}

.cited-date,
.hit-date {
  font-weight: 600;
  color: var(--text-2);
}

.cited-text,
.hit-text {
  font-size: 0.9rem;
  line-height: 1.7;
  color: var(--text);
  word-break: break-word;
}

.cited-tags,
.hit-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 7px;
}

.answer-acts {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 14px;
}

/* ---------- 搜索结果 ---------- */
.results-head {
  font-size: 0.8rem;
  color: var(--text-3);
  margin-bottom: 10px;
}

.hit {
  padding: 12px 14px;
  border-radius: var(--r);
  background: var(--surface);
  border: 1px solid var(--border);
  cursor: pointer;
  transition: border-color var(--dur), box-shadow var(--dur), transform var(--dur);
}

.hit + .hit {
  margin-top: 8px;
}

.hit:hover {
  border-color: var(--border-2);
  box-shadow: var(--shadow-sm);
}

.hit:active {
  transform: scale(0.995);
}

.empty {
  padding: 40px 16px;
}

.empty kbd {
  display: inline-block;
  padding: 0 5px;
  border-radius: 5px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  font-family: var(--font-num);
  font-size: 0.76rem;
}

.tail {
  height: 96px;
}
</style>
