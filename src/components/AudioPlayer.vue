<script setup lang="ts">
// =============================================================
// 记录里的语音回放条
// 不直接用 <audio controls>：原生控件在深色模式下很丑，
// 这里自己做一条，带进度、时长、倍速
// =============================================================
import { computed, onUnmounted, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { audioUrl } from '../lib/api';
import type { AudioAttachment } from '../types';

const props = defineProps<{ att: AudioAttachment; compact?: boolean }>();

const el = ref<HTMLAudioElement | null>(null);
const playing = ref(false);
const current = ref(0);
const total = ref((props.att.durationMs || 0) / 1000);
const rate = ref(1);
const failed = ref(false);

const src = computed(() => audioUrl(props.att));

const pct = computed(() => (total.value > 0 ? Math.min(100, (current.value / total.value) * 100) : 0));

function fmt(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${String(ss).padStart(2, '0')}`;
}

const curText = computed(() => fmt(current.value));
const totalText = computed(() => fmt(total.value || current.value));

function toggle() {
  const a = el.value;
  if (!a) return;
  if (a.paused) {
    a.playbackRate = rate.value;
    a.play().catch(() => {
      failed.value = true;
    });
  } else {
    a.pause();
  }
}

function onTime() {
  const a = el.value;
  if (!a) return;
  current.value = a.currentTime;
  if (Number.isFinite(a.duration) && a.duration > 0) total.value = a.duration;
}

function seek(e: MouseEvent) {
  const a = el.value;
  const bar = e.currentTarget as HTMLElement;
  if (!a || !total.value) return;
  const rect = bar.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  a.currentTime = ratio * total.value;
  current.value = a.currentTime;
}

function cycleRate() {
  const order = [1, 1.5, 2, 0.75];
  rate.value = order[(order.indexOf(rate.value) + 1) % order.length];
  if (el.value) el.value.playbackRate = rate.value;
}

watch(
  () => props.att.id,
  () => {
    playing.value = false;
    current.value = 0;
    total.value = (props.att.durationMs || 0) / 1000;
    failed.value = false;
  },
);

onUnmounted(() => {
  try {
    el.value?.pause();
  } catch {
    /* ignore */
  }
});
</script>

<template>
  <div class="vp" :class="{ compact }">
    <audio
      ref="el"
      :src="src"
      preload="metadata"
      @play="playing = true"
      @pause="playing = false"
      @ended="playing = false; current = 0"
      @timeupdate="onTime"
      @loadedmetadata="onTime"
      @error="failed = true"
    ></audio>

    <button class="vp-btn" :title="playing ? '暂停' : '播放'" @click="toggle">
      <Icon :name="playing ? 'pause' : 'play'" :size="15" />
    </button>

    <div class="vp-body">
      <div class="vp-bar" @click="seek">
        <i :style="{ width: `${pct}%` }"></i>
      </div>
      <div class="vp-meta">
        <span class="num">{{ curText }} / {{ totalText }}</span>
        <button v-if="!compact" class="vp-rate num" title="切换速度" @click="cycleRate">{{ rate }}×</button>
        <span v-if="failed" class="vp-fail">录音丢失</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.vp {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 9px 12px;
  border-radius: var(--r-sm);
  background: var(--brand-tint);
  border: 1px solid color-mix(in srgb, var(--brand) 18%, transparent);
}

.vp.compact {
  padding: 7px 10px;
}

.vp-btn {
  flex: 0 0 auto;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: linear-gradient(135deg, var(--brand), var(--brand-deep));
  color: #fff;
  box-shadow: var(--shadow-xs);
  transition: transform 0.18s var(--spring);
}

.vp-btn:active {
  transform: scale(0.9);
}

.vp-body {
  flex: 1;
  min-width: 0;
}

.vp-bar {
  height: 5px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--brand) 16%, transparent);
  cursor: pointer;
  overflow: hidden;
}

.vp-bar > i {
  display: block;
  height: 100%;
  border-radius: 5px;
  background: var(--brand);
  transition: width 0.12s linear;
}

.vp-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 5px;
  font-size: 0.72rem;
  color: var(--text-3);
}

.vp-rate {
  padding: 0 6px;
  border-radius: 6px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--text-2);
  font-size: 0.7rem;
}

.vp-fail {
  color: var(--rose);
}
</style>
