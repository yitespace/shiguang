<script setup lang="ts">
// =============================================================
// 那年今日
// 翻出往年同一天写过的东西。记录类应用最动人的功能之一：
// 你会突然看见一年前的自己，在同一天做什么、想什么。
// =============================================================
import { computed, onMounted, ref } from 'vue';
import Icon from './Icon.vue';
import AudioPlayer from './AudioPlayer.vue';
import * as api from '../lib/api';
import { hhmm, shortDate, today } from '../lib/date';
import { renderMarkdown } from '../lib/markdown';
import { aiReady, toast } from '../lib/store';
import { moodOf, type MemoryGroup } from '../types';

const props = defineProps<{ date?: string }>();

const groups = ref<MemoryGroup[]>([]);
const loading = ref(true);
const expanded = ref<Record<number, boolean>>({});
const reflection = ref('');
const reflecting = ref(false);

const date = computed(() => props.date || today());

/** 记录变化后要重新取（比如补记了一条去年的） */
const total = computed(() => groups.value.reduce((n, g) => n + g.entries.length, 0));

async function load() {
  loading.value = true;
  try {
    const res = await api.getMemories(date.value, 5);
    groups.value = res.groups || [];
    // 只有一组时默认展开，省一次点击
    if (groups.value.length === 1) expanded.value = { [groups.value[0].yearsAgo]: true };
  } catch {
    groups.value = [];
  } finally {
    loading.value = false;
  }
}

function toggle(y: number) {
  expanded.value = { ...expanded.value, [y]: !expanded.value[y] };
}

async function reflect() {
  if (reflecting.value) return;
  reflecting.value = true;
  reflection.value = '';
  try {
    const res = await api.reflectMemories(date.value);
    reflection.value = res.summary || '';
    if (!res.summary) toast('没有什么可说的');
  } catch (e: any) {
    toast(e?.message || 'AI 暂时不可用');
  } finally {
    reflecting.value = false;
  }
}

/** 点日期跳到「过往」那一天（日历和时间线现在在同一页） */
function gotoPast(d: string) {
  location.hash = `#/?d=${d}`;
}

function plain(content: string, max = 120): string {
  const t = content.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

onMounted(load);
defineExpose({ reload: load });
</script>

<template>
  <!-- 没有过往记录时整块不出现，不占地方 -->
  <section v-if="loading || total" class="card memory">
    <div class="mem-head">
      <span class="mem-title">
        <Icon name="history" :size="16" />
        那年今日
      </span>
      <span v-if="total" class="mem-count">翻到 {{ total }} 条</span>
    </div>

    <div v-if="loading" class="mem-loading">
      <span class="skeleton" style="width: 60%; height: 14px; display: block"></span>
      <span class="skeleton" style="width: 85%; height: 14px; display: block; margin-top: 8px"></span>
    </div>

    <template v-else>
      <div v-for="g in groups" :key="g.yearsAgo" class="mem-group">
        <button class="mem-row" @click="toggle(g.yearsAgo)">
          <span class="mem-when">
            <b class="num">{{ g.yearsAgo }}</b> 年前的今天
            <span class="mem-date">{{ shortDate(g.date) }}</span>
          </span>
          <span class="mem-toggle">
            {{ g.entries.length }} 条
            <Icon :name="expanded[g.yearsAgo] ? 'x' : 'arrowRight'" :size="14" />
          </span>
        </button>

        <Transition name="fade">
          <div v-if="expanded[g.yearsAgo]" class="mem-body">
            <article v-for="e in g.entries" :key="e.id" class="mem-entry">
              <div class="mem-entry-head">
                <span class="mem-time num">{{ hhmm(e.createdAt) }}</span>
                <span v-if="moodOf(e.mood)" class="mem-mood">{{ moodOf(e.mood)!.emoji }}</span>
                <button class="mem-jump" @click="gotoPast(g.date)">回到那天 →</button>
              </div>
              <p v-if="e.title" class="mem-entry-title">{{ e.title }}</p>
              <p class="mem-entry-text">{{ plain(e.content) }}</p>
              <div v-if="e.attachments?.length" class="mem-audio">
                <AudioPlayer v-for="a in e.attachments" :key="a.id" :att="a" compact />
              </div>
              <div v-if="e.tags.length" class="mem-tags">
                <span v-for="t in e.tags" :key="t" class="tag">#{{ t }}</span>
              </div>
            </article>
          </div>
        </Transition>
      </div>

      <!-- AI 串一段话（可选） -->
      <div v-if="aiReady" class="mem-ai">
        <div v-if="reflection" class="mem-reflection" v-html="renderMarkdown(reflection)"></div>
        <button v-else class="btn btn-sm" :disabled="reflecting" @click="reflect">
          <span v-if="reflecting" class="think-dot" style="margin-right: 6px"><i></i><i></i><i></i></span>
          <Icon name="sparkles" :size="14" />
          {{ reflecting ? '正在翻旧账…' : '让 AI 说说这几年的今天' }}
        </button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.memory {
  margin-top: 14px;
  padding: 14px 16px;
  background: linear-gradient(180deg, var(--amber-tint), var(--surface));
  border-color: color-mix(in srgb, var(--amber) 26%, transparent);
}

.mem-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 4px;
}

.mem-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 640;
  font-size: 0.94rem;
  color: #b4761a;
}

.mem-count {
  font-size: 0.76rem;
  color: var(--text-3);
}

.mem-loading {
  padding: 10px 0 4px;
}

.mem-group + .mem-group {
  border-top: 1px solid var(--border);
  margin-top: 6px;
  padding-top: 6px;
}

.mem-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  padding: 9px 0;
  text-align: left;
}

.mem-when {
  font-size: 0.92rem;
  font-weight: 560;
}

.mem-when b {
  font-size: 1.1rem;
  color: var(--amber-text);
  margin-right: 2px;
}

.mem-date {
  font-size: 0.76rem;
  color: var(--text-3);
  font-weight: 400;
  margin-left: 6px;
}

.mem-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.78rem;
  color: var(--text-3);
  white-space: nowrap;
}

.mem-body {
  padding: 2px 0 8px;
  display: grid;
  gap: 10px;
}

.mem-entry {
  padding: 11px 13px;
  border-radius: var(--r-sm);
  background: var(--surface);
  border: 1px solid var(--border);
}

.mem-entry-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 5px;
}

.mem-time {
  font-size: 0.74rem;
  color: var(--text-3);
}

.mem-mood {
  font-size: 0.86rem;
}

.mem-jump {
  margin-left: auto;
  font-size: 0.74rem;
  color: var(--brand-deep);
  font-weight: 560;
}

:root[data-theme='dark'] .mem-jump {
  color: var(--brand-soft);
}

.mem-entry-title {
  font-weight: 600;
  font-size: 0.92rem;
  margin-bottom: 2px;
}

.mem-entry-text {
  font-size: 0.9rem;
  line-height: 1.7;
  color: var(--text);
  word-break: break-word;
}

.mem-audio {
  margin-top: 8px;
}

.mem-tags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 7px;
}

.mem-ai {
  margin-top: 12px;
  padding-top: 11px;
  border-top: 1px dashed var(--border-2);
}

.mem-reflection {
  font-size: 0.92rem;
  line-height: 1.78;
}

.mem-reflection :deep(p) {
  margin: 0 0 7px;
}

.mem-reflection :deep(p:last-child) {
  margin-bottom: 0;
}
</style>
