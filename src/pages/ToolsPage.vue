<script setup lang="ts">
// =============================================================
// 功能
//
// 底栏第三格。这一页不是「又来一堆入口」，而是一个**工具箱**：
// 以后每加一个单独的小功能，就在这里多一张卡。
//
// 现在第一个、也是唯一一个是「服药提醒」—— 它做得足够重
// （周期服药、签到、全屏闹钟），单独占一页。
// =============================================================
import { computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import { careToday as care, refreshCare } from '../lib/store';

const router = useRouter();

/** 今天的服药状态，做成卡上的副标题 */
const medLine = computed(() => {
  const m = care.value?.meds;
  if (!m || !m.plan.length) return '还没添加在吃的药';
  if (!m.pending) return '今天的药都吃过了';
  const next = m.next ? `，下一次 ${m.next.slot}` : '';
  return `今天还有 ${m.pending} 次没吃${next}`;
});

const medTone = computed(() => {
  const m = care.value?.meds;
  if (!m) return 'idle';
  if (m.overdue) return 'late';
  if (m.pending) return 'due';
  return 'done';
});

onMounted(() => {
  void refreshCare();
});
</script>

<template>
  <div class="tools-page">
    <div class="page-head">
      <div>
        <h1>功能</h1>
        <p class="sub">一些单独的小工具，慢慢长</p>
      </div>
    </div>

    <button class="tool-card" :class="medTone" @click="router.push('/meds')">
      <span class="tc-icon"><Icon name="pill" :size="20" /></span>
      <span class="tc-body">
        <b>服药提醒</b>
        <em>{{ medLine }}</em>
      </span>
      <Icon name="arrowRight" :size="16" class="tc-go" />
    </button>

    <p class="soon">
      <Icon name="sparkles" :size="13" />
      还有几个在做了，会陆续放上来
    </p>
  </div>
</template>

<style scoped>
.tool-card {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 13px;
  padding: 16px 15px;
  border-radius: var(--r-lg);
  text-align: left;
  background: var(--surface);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-sm);
  transition: border-color var(--dur), transform var(--dur);
}

.tool-card:active {
  transform: scale(0.99);
}

.tool-card.due {
  border-color: var(--brand);
}

.tool-card.late {
  border-color: var(--rose);
}

.tc-icon {
  flex: 0 0 auto;
  width: 40px;
  height: 40px;
  border-radius: 13px;
  display: grid;
  place-items: center;
  background: var(--brand-tint);
  color: var(--brand-deep);
}

.tool-card.late .tc-icon {
  background: var(--rose-tint);
  color: var(--rose-text);
}

.tool-card.done .tc-icon {
  background: var(--ai-tint);
  color: var(--ai-text);
}

.tc-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.tc-body b {
  font-size: 0.98rem;
  font-weight: 650;
}

.tc-body em {
  font-style: normal;
  font-size: 0.8rem;
  color: var(--text-2);
}

.tc-go {
  flex: 0 0 auto;
  color: var(--text-3);
}

.soon {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-top: 22px;
  font-size: 0.76rem;
  color: var(--text-3);
}
</style>
