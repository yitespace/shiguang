<script setup lang="ts">
import { computed, ref } from 'vue';
import Icon from './Icon.vue';
import AudioPlayer from './AudioPlayer.vue';
import { hhmm } from '../lib/date';
import { highlight } from '../lib/markdown';
import { moodOf, type Entry } from '../types';
import { removeEntry, restoreEntry, toast } from '../lib/store';

const props = withDefaults(
  defineProps<{
    entry: Entry;
    /** 检索时传入关键词用于高亮 */
    keywords?: string;
    /** 是否把长内容折叠起来 */
    clamp?: boolean;
    /** 是否显示复制/编辑/删除按钮 */
    showActions?: boolean;
  }>(),
  {
    // 必须给显式默认值！Vue 对「没传的布尔 prop」会当成 false，
    // 之前写 v-if="showActions !== false" 结果按钮一直不显示
    keywords: '',
    clamp: false,
    showActions: true,
  },
);

const expanded = ref(false);
const mood = computed(() => moodOf(props.entry.mood));
const accent = computed(() => mood.value?.color || 'var(--brand)');

/** 是否值得展开：内容较长时给个展开按钮 */
const long = computed(() => props.entry.content.length > 220 || props.entry.content.split('\n').length > 5);

/** 语音附件里 AI 提炼的要点（可能多个附件，合并展示） */
function pointsOf(e: typeof props.entry): string[] {
  return (e.attachments || []).flatMap((a) => a.points || []).slice(0, 6);
}

function transcriptOf(e: typeof props.entry): string {
  return (e.attachments || [])
    .map((a) => a.transcript || '')
    .filter(Boolean)
    .join('\n');
}

function edit() {
  window.dispatchEvent(new CustomEvent('sg:edit', { detail: { id: props.entry.id } }));
}

async function del() {
  const removed = await removeEntry(props.entry.id);
  if (!removed) return;
  // 给一次后悔的机会：撤销按钮直接挂在提示条上
  toast('已删除', { label: '撤销', run: () => restoreEntry(removed) });
}

async function copy() {
  try {
    await navigator.clipboard.writeText(props.entry.content);
    toast('已复制内容');
  } catch {
    toast('复制失败，请手动选择');
  }
}

</script>

<template>
  <article class="entry" :style="{ '--entry-accent': accent }">
    <div class="entry-time num">{{ hhmm(entry.createdAt) }}</div>

    <div class="entry-main">
      <div v-if="entry.title" class="entry-title">{{ entry.title }}</div>

      <div
        v-if="keywords"
        class="entry-content"
        :class="{ clamp: clamp && !expanded }"
        v-html="highlight(entry.content, keywords)"
      ></div>
      <div v-else class="entry-content" :class="{ clamp: clamp && !expanded }">{{ entry.content }}</div>

      <!-- 语音：回放 + AI 要点 -->
      <div v-if="entry.attachments?.length" class="voice-block">
        <AudioPlayer v-for="a in entry.attachments" :key="a.id" :att="a" compact />
        <ul v-if="pointsOf(entry).length" class="voice-points">
          <li v-for="(p, i) in pointsOf(entry)" :key="i">
            <Icon name="sparkles" :size="12" />
            <span>{{ p }}</span>
          </li>
        </ul>
        <details v-if="transcriptOf(entry) && transcriptOf(entry) !== entry.content" class="voice-raw">
          <summary>看语音原文</summary>
          <p>{{ transcriptOf(entry) }}</p>
        </details>
      </div>

      <button v-if="clamp && long" class="expand" @click.stop="expanded = !expanded">
        {{ expanded ? '收起' : '展开全文' }}
        <Icon :name="expanded ? 'x' : 'plus'" :size="12" />
      </button>

      <div v-if="entry.tags.length || mood || entry._pending" class="entry-meta">
        <span v-if="mood" class="entry-mood" :title="mood.label">{{ mood.emoji }}</span>
        <span v-for="t in entry.tags" :key="t" class="tag">#{{ t }}</span>
        <span v-if="entry._pending" class="tag" style="color: var(--amber-text)">待同步</span>
      </div>
    </div>

    <div v-if="showActions" class="entry-actions">
      <button class="icon-btn" title="复制" @click.stop="copy"><Icon name="copy" :size="16" /></button>
      <button class="icon-btn" title="编辑" @click.stop="edit"><Icon name="edit" :size="16" /></button>
      <button class="icon-btn" title="删除" @click.stop="del"><Icon name="trash" :size="16" /></button>
    </div>
  </article>
</template>

<style scoped>
.voice-block {
  display: grid;
  gap: 8px;
  margin-top: 10px;
}

.voice-points {
  list-style: none;
  margin: 0;
  padding: 11px 13px;
  border-radius: var(--r-sm);
  background: var(--ai-tint);
  border: 1px solid color-mix(in srgb, var(--ai) 22%, transparent);
  display: grid;
  gap: 6px;
}

.voice-points li {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  font-size: 0.88rem;
  line-height: 1.6;
}

.voice-points li :deep(svg) {
  color: var(--ai);
  flex: 0 0 auto;
  margin-top: 4px;
}

.voice-raw summary {
  font-size: 0.76rem;
  color: var(--text-3);
  cursor: pointer;
  padding: 2px 0;
}

.voice-raw p {
  font-size: 0.84rem;
  color: var(--text-2);
  line-height: 1.7;
  margin-top: 6px;
  padding-left: 10px;
  border-left: 2px solid var(--border-2);
  white-space: pre-wrap;
}

.expand {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 7px;
  font-size: 0.8rem;
  color: var(--brand-deep);
  font-weight: 560;
}

:root[data-theme='dark'] .expand {
  color: var(--brand-soft);
}

/*
 * 手机上：三个按钮横排、绝对定位浮在卡片右下角。
 * 不占正文宽度，也不改变卡片高度（卡片本来就比按钮高）。
 */
@media (max-width: 640px) {
  .entry {
    position: relative;
  }

  .entry-actions {
    position: absolute;
    right: 6px;
    bottom: 6px;
    gap: 1px;
    padding: 2px;
    border-radius: var(--r-sm);
    background: color-mix(in srgb, var(--surface) 88%, transparent);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    opacity: 1;
  }

  .entry-actions .icon-btn {
    width: 32px;
    height: 32px;
    color: var(--text-3);
  }

  /* 给正文和标签让出按钮的位置，避免文字跑到按钮底下 */
  .entry-main {
    padding-right: 4px;
  }

  .entry-meta {
    padding-right: 100px;
  }
}
</style>
