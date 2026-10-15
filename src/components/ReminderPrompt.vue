<script setup lang="ts">
// =============================================================
// 「要不要设个提醒」浮卡（纯展示）
//
// 检测和保存都在 App.vue 里：它才持有弹层和全局状态。
// 这里只管把认出来的那件事显示清楚，并把用户的选择抛出去。
//
// 默认什么都不做（而不是默认设上）。抑郁的人本来就容易被「待办」压住，
// 多一个默认勾选的选项只会更累。
// =============================================================
import { ref, watch } from 'vue';
import Icon from '../components/Icon.vue';

const props = defineProps<{
  open: boolean;
  title: string;
  at: string;
  advance: number;
  busy?: boolean;
}>();

const emit = defineEmits<{
  (e: 'accept', advance: number): void;
  (e: 'dismiss'): void;
  (e: 'off'): void;
}>();

const adv = ref(props.advance || 10);

watch(
  () => [props.open, props.advance],
  () => {
    if (props.open) adv.value = props.advance || 10;
  },
);

/** 「2026-10-14T22:00」→「10/14 22:00」，今天的话只说时间 */
function whenText(at: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(at || '');
  if (!m) return at || '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? `${m[4]}:${m[5]}` : `${Number(m[2])}/${Number(m[3])} ${m[4]}:${m[5]}`;
}
</script>

<template>
  <Transition name="sheet">
    <div v-if="open" class="prompt-mask" @click.self="emit('dismiss')">
      <div class="prompt">
        <span class="p-icon"><Icon name="bell" :size="17" /></span>
        <div class="p-body">
          <b>这条记录里像是有件事要办</b>
          <p class="p-what">
            {{ title }}
            <span class="p-when">{{ whenText(at) }}</span>
          </p>
          <div class="p-adv">
            <span>提前</span>
            <button
              v-for="a in [0, 5, 10, 30]"
              :key="a"
              class="chip"
              :class="{ active: adv === a }"
              @click="adv = a"
            >
              {{ a === 0 ? '准点' : `${a} 分` }}
            </button>
          </div>
        </div>
        <div class="p-acts">
          <button class="btn btn-sm btn-primary" :disabled="busy" @click="emit('accept', adv)">好</button>
          <button class="text-btn" @click="emit('dismiss')">不用</button>
          <button class="text-btn dim" @click="emit('off')">以后别问了</button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.prompt-mask {
  position: fixed;
  left: 0;
  right: 0;
  bottom: calc(var(--safe-bottom) + 74px);
  z-index: 45;
  display: flex;
  justify-content: center;
  padding: 0 var(--pad);
  pointer-events: none;
}

.prompt {
  pointer-events: auto;
  width: 100%;
  max-width: 520px;
  display: flex;
  align-items: flex-start;
  gap: 11px;
  padding: 13px 14px;
  border-radius: var(--r-lg);
  background: var(--surface);
  border: 1px solid var(--brand);
  box-shadow: var(--shadow-lg);
  animation: rise 0.24s var(--ease);
}

@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
}

.p-icon {
  flex: 0 0 auto;
  width: 32px;
  height: 32px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  background: var(--brand-tint);
  color: var(--brand-deep);
}

.p-body {
  flex: 1;
  min-width: 0;
}

.p-body b {
  display: block;
  font-size: 0.86rem;
  font-weight: 620;
  color: var(--text-2);
}

.p-what {
  margin: 3px 0 7px;
  font-size: 0.95rem;
  font-weight: 640;
  display: flex;
  align-items: baseline;
  gap: 7px;
  flex-wrap: wrap;
}

.p-when {
  font-size: 0.76rem;
  font-weight: 500;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.p-adv {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 0.76rem;
  color: var(--text-3);
}

.chip {
  padding: 3px 10px;
  border-radius: var(--r-full);
  background: var(--surface-2);
  border: 1px solid var(--border);
  font-size: 0.76rem;
  color: var(--text-2);
  transition: all var(--dur);
}

.chip.active {
  background: var(--brand);
  border-color: var(--brand);
  color: #fff;
  font-weight: 600;
}

.p-acts {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
  text-align: center;
}

.text-btn {
  font-size: 0.74rem;
  color: var(--text-3);
  padding: 2px;
}

.text-btn.dim {
  font-size: 0.68rem;
  opacity: 0.75;
}
</style>
