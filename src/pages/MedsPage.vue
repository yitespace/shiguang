<script setup lang="ts">
// =============================================================
// 吃药提醒
//
// 给谁用的：正在服药的抑郁/焦虑患者。他们的共同点是——漏服很常见，
// 而且漏了之后容易自责、干脆不看了。所以这一页有几个刻意的选择：
//
//   1. 「没吃」不说成「错过」。红色 + 责备语气只会让人不想打开这个页面。
//   2. 打卡是一等公民：一屏之内点得到，点完立刻有反馈，不弹二次确认。
//   3. 录入有三条路（打字 / 说话 / 拍医嘱），但**都只是草稿**，
//      AI 解析出来的必须让用户逐条确认才落库 —— 这是要吃进嘴里的东西。
//   4. 「必要时服用」的药单独一块，不排定时提醒，也不显示成「你没吃」。
//      到点催一个按需吃的苯二氮䓬是会吃出依赖的。
// =============================================================
import { computed, onMounted, ref } from 'vue';
import Icon from '../components/Icon.vue';
import * as care from '../lib/care';
import { toast } from '../lib/store';
import { notifyStatus, refreshSchedule, requestNotifyPermission, type NotifyStatus } from '../lib/native';

const loading = ref(true);
const meds = ref<care.Med[]>([]);
const plan = ref<care.PlanItem[]>([]);
const notify = ref<NotifyStatus | null>(null);
const busy = ref('');

// 录入面板
const composeOpen = ref(false);
const composeText = ref('');
const draft = ref<care.ParsedMed[]>([]);
const draftUnclear = ref<string[]>([]);
const draftSummary = ref('');
const imageIds = ref<string[]>([]);
const parsing = ref(false);

// 手动编辑某一种药
const editOpen = ref(false);
const editing = ref<care.Med | null>(null);

const today = computed(() => new Date().toISOString().slice(0, 10));
const pending = computed(() => plan.value.filter((x) => x.status === 'pending' && !x.prn));
const nextDose = computed(() => plan.value.find((x) => x.status === 'pending' && !x.prn && x.dueAt > Date.now()) || null);
const prnToday = computed(() => plan.value.filter((x) => x.prn));

/** 「8:00」→「早上 8:00」，读起来比纯数字快 */
function prettyAt(at: string) {
  const h = Number(at.slice(0, 2));
  const part = h < 6 ? '凌晨' : h < 11 ? '早上' : h < 13 ? '中午' : h < 18 ? '下午' : h < 23 ? '晚上' : '深夜';
  return `${part} ${at}`;
}

function slotText(med: care.Med) {
  return med.slots.map((s) => `${s.label || prettyAt(s.at)}${s.dose || med.dose ? ` ${s.dose || med.dose}` : ''}`).join(' · ');
}

async function load() {
  loading.value = true;
  try {
    const r = await care.listMeds();
    meds.value = r.meds;
    plan.value = r.today;
  } catch (e: any) {
    toast(e?.message || '加载失败');
  } finally {
    loading.value = false;
  }
}

async function loadNotify() {
  notify.value = await notifyStatus();
}

/** 任何改动之后都要重排提醒：改了时间但闹钟还是旧的，比没有提醒更糟 */
async function sync() {
  try {
    await refreshSchedule(care.getSchedule, 7);
  } catch {
    /* 排不上不该挡住页面本身 */
  }
}

async function take(item: care.PlanItem) {
  busy.value = `${item.medId}@${item.at}`;
  try {
    const r = await care.logDose(item.medId, { at: item.at, date: today.value, action: 'taken' });
    plan.value = r.today;
    toast(`记下了：${item.name}`);
    await sync();
  } catch (e: any) {
    toast(e?.message || '没记上，再试一次');
  } finally {
    busy.value = '';
  }
}

async function undo(item: care.PlanItem) {
  try {
    const r = await care.logDose(item.medId, { at: item.at, date: today.value, action: 'undo' });
    plan.value = r.today;
    await sync();
  } catch (e: any) {
    toast(e?.message || '操作失败');
  }
}

function openCompose() {
  composeOpen.value = true;
  composeText.value = '';
  draft.value = [];
  draftUnclear.value = [];
  draftSummary.value = '';
  imageIds.value = [];
}

function closeCompose() {
  composeOpen.value = false;
}

const fileRef = ref<HTMLInputElement | null>(null);

/**
 * 选图片。
 * 压到 1600px 再上传：手机原图动辄五六 MB，而模型那边
 * 超过 1300px 也会自己缩，传原图纯属浪费流量和等待时间。
 */
async function pickImages(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const files = Array.from(input.files || []).slice(0, 4);
  input.value = '';
  if (!files.length) return;
  parsing.value = true;
  try {
    const images: { mime: string; data: string }[] = [];
    for (const f of files) {
      if (!/^image\/(jpeg|png|webp|gif)$/.test(f.type)) {
        toast('只支持 JPG / PNG / WebP 的图片');
        continue;
      }
      images.push({ mime: f.type, data: await shrink(f) });
    }
    if (!images.length) return;
    await doParse({ images });
  } catch (e: any) {
    toast(e?.message || '图片处理失败');
  } finally {
    parsing.value = false;
  }
}

/** 缩到最长边 1600 并转成 JPEG base64 */
function shrink(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const max = 1600;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      const ctx = cv.getContext('2d');
      if (!ctx) return reject(new Error('画布不可用'));
      ctx.drawImage(img, 0, 0, w, h);
      const data = cv.toDataURL('image/jpeg', 0.86).split(',')[1];
      resolve(data || '');
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('这张图读不出来'));
    };
    img.src = url;
  });
}

/** 语音录入：复用录音组件，转写完把文本填进输入框 */
async function speak() {
  window.dispatchEvent(new CustomEvent('sg:voice'));
  toast('说完点一下结束，回来再点「让 AI 整理」');
}

async function doParse(payload: { text?: string; images?: { mime: string; data: string }[] }) {
  parsing.value = true;
  try {
    const r = await care.parseMeds({ ...payload, today: today.value });
    draft.value = r.meds;
    draftUnclear.value = r.unclear;
    draftSummary.value = r.summary;
    imageIds.value = r.images.map((x) => x.id);
    if (!r.meds.length) toast('没读出服药安排，换个说法或者拍清楚一点再试');
  } catch (e: any) {
    toast(e?.message || '解析失败');
  } finally {
    parsing.value = false;
  }
}

function pickFile() {
  fileRef.value?.click();
}

async function parseText() {
  const t = composeText.value.trim();
  if (!t) return toast('先说一句或者打几个字');
  await doParse({ text: t });
}

/** 把草稿里的第 n 条落库 */
async function acceptDraft(i: number) {
  const d = draft.value[i];
  if (!d) return;
  busy.value = `accept${i}`;
  try {
    await care.saveMed({
      name: d.name,
      dose: d.dose,
      slots: d.slots,
      note: d.note,
      days: d.days,
      startDate: d.startDate,
      endDate: d.endDate,
      prn: d.prn,
      source: composeText.value.trim() ? 'text' : imageIds.value.length ? 'photo' : 'manual',
      imageId: imageIds.value[0] || '',
    });
    draft.value.splice(i, 1);
    toast(`已添加：${d.name}`);
    await load();
    await sync();
    if (!draft.value.length) closeCompose();
  } catch (e: any) {
    toast(e?.message || '保存失败');
  } finally {
    busy.value = '';
  }
}

async function acceptAll() {
  for (let i = draft.value.length - 1; i >= 0; i--) await acceptDraft(i);
}

function openEdit(med: care.Med) {
  editing.value = JSON.parse(JSON.stringify(med));
  editOpen.value = true;
}

async function saveEdit() {
  const m = editing.value;
  if (!m) return;
  busy.value = 'edit';
  try {
    await care.saveMed(m);
    editOpen.value = false;
    toast('改好了');
    await load();
    await sync();
  } catch (e: any) {
    toast(e?.message || '保存失败');
  } finally {
    busy.value = '';
  }
}

async function removeMed(med: care.Med) {
  if (!confirm(`不再提醒「${med.name}」？\n已经记下的服药流水会保留。`)) return;
  try {
    await care.removeMed(med.id);
    toast('已移除');
    await load();
    await sync();
  } catch (e: any) {
    toast(e?.message || '删除失败');
  }
}

async function enableNotify() {
  const p = await requestNotifyPermission();
  await loadNotify();
  if (p === 'granted') {
    toast('可以了，提醒会准时到');
    await sync();
  } else if (p === 'denied') {
    toast('系统里把通知关掉了，得去设置里打开');
  }
}

onMounted(async () => {
  await Promise.all([load(), loadNotify()]);
  await sync();
});
</script>

<template>
  <div class="meds-page">
    <div class="page-head">
      <div>
        <h1>吃药提醒</h1>
        <p class="sub">到点提醒你，不替你决定吃不吃</p>
      </div>
      <button class="icon-btn" title="添加" aria-label="添加" @click="openCompose">
        <Icon name="plus" :size="19" />
      </button>
    </div>

    <!-- ============ 提醒能力：不够用就直说，别装作能用 ============ -->
    <div v-if="notify && notify.permission !== 'granted'" class="card notice">
      <span class="notice-icon"><Icon name="alert" :size="17" /></span>
      <div class="notice-body">
        <b>{{ notify.permission === 'unsupported' ? '这个环境收不到提醒' : '还没打开通知' }}</b>
        <p>{{ notify.note || '不打开通知的话，到点不会有任何提示。' }}</p>
      </div>
      <button v-if="notify.permission !== 'unsupported'" class="btn btn-sm btn-primary" @click="enableNotify">打开</button>
    </div>
    <div v-else-if="notify && !notify.background" class="card notice soft">
      <span class="notice-icon"><Icon name="alert" :size="17" /></span>
      <div class="notice-body">
        <b>只在页面开着的时候提醒</b>
        <p>{{ notify.note }}</p>
      </div>
    </div>

    <!-- ============ 今天 ============ -->
    <section class="group">
      <h2 class="group-title">今天</h2>

      <div v-if="loading" class="card pad muted">正在读…</div>

      <div v-else-if="!plan.length && !meds.length" class="card empty">
        <span class="big"><Icon name="pill" :size="30" /></span>
        <p class="tip">
          还没有在吃的药。<br />
          可以说一句、打几个字，或者直接拍医生开的处方单。
        </p>
        <button class="btn btn-primary" @click="openCompose">
          <Icon name="plus" :size="16" /> 添加
        </button>
      </div>

      <div v-else class="card dose-card" :class="{ done: !pending.length }">
        <div class="dose-head">
          <span class="dh-icon"><Icon :name="pending.length ? 'pill' : 'check'" :size="18" /></span>
          <div class="dh-text">
            <b v-if="pending.length">还有 {{ pending.length }} 次药没吃</b>
            <b v-else>今天的药都吃过了</b>
            <p v-if="nextDose">下一次 {{ prettyAt(nextDose.at) }} · {{ nextDose.name }}</p>
            <p v-else-if="!pending.length && plan.length">明天见</p>
          </div>
        </div>

        <ul class="dose-list">
          <li v-for="item in plan.filter((x) => !x.prn)" :key="`${item.medId}@${item.at}`" class="dose-row" :class="{ taken: item.status === 'taken', late: item.overdue }">
            <span class="dr-time num">{{ item.at }}</span>
            <span class="dr-main">
              <b>{{ item.name }}</b>
              <em v-if="item.dose">{{ item.dose }}</em>
              <span v-if="item.label" class="dr-label">{{ item.label }}</span>
            </span>
            <button
              v-if="item.status === 'pending'"
              class="dr-act"
              :disabled="busy === `${item.medId}@${item.at}`"
              @click="take(item)"
            >
              吃了
            </button>
            <button v-else class="dr-act done" title="点一下撤销" @click="undo(item)">
              <Icon name="check" :size="15" />
            </button>
          </li>
        </ul>
      </div>

      <!-- 按需服用的药单独一块：不催，但可以记 -->
      <div v-if="prnToday.length" class="card prn-card">
        <div class="prn-head">
          <Icon name="alert" :size="15" />
          <b>需要时服用</b>
          <span>{{ prnToday.length }} 种</span>
        </div>
        <p class="prn-note">这些药医嘱写的是「必要时服用」，不会定时提醒你 —— 免得催出依赖。想吃的时候自己记一笔就行。</p>
        <ul class="dose-list">
          <li v-for="item in prnToday" :key="`prn-${item.medId}@${item.at}`" class="dose-row" :class="{ taken: item.status === 'taken' }">
            <!--
              这里显示的是「睡前」而不是「22:00」。
              写具体时刻会让人以为这是张定时表，而医嘱写的是「必要时服用」——
              一个按需吃的药不该看起来像有固定钟点。
            -->
            <span class="dr-time">{{ item.label || '需要时' }}</span>
            <span class="dr-main">
              <b>{{ item.name }}</b>
              <em v-if="item.dose">{{ item.dose }}</em>
            </span>
            <button v-if="item.status === 'pending'" class="dr-act ghost" @click="take(item)">记一笔</button>
            <button v-else class="dr-act done" @click="undo(item)"><Icon name="check" :size="15" /></button>
          </li>
        </ul>
      </div>
    </section>

    <!-- ============ 在吃的药 ============ -->
    <section v-if="meds.length" class="group">
      <h2 class="group-title">在吃的药</h2>
      <div class="card menu">
        <button v-for="med in meds" :key="med.id" class="menu-row" @click="openEdit(med)">
          <span class="mi" :class="med.prn ? 'amber' : 'brand'"><Icon name="pill" :size="16" /></span>
          <span class="ml">
            <b>{{ med.name }}</b>
            <em>{{ slotText(med) }}</em>
            <em v-if="med.endDate" class="hint">吃到 {{ med.endDate }}</em>
            <em v-else-if="med.prn" class="hint">需要时服用 · 不提醒</em>
          </span>
          <span v-if="med.alarm" class="mi-tag" title="用闹钟提醒"><Icon name="bell" :size="13" /></span>
          <Icon name="arrowRight" :size="15" class="chev" />
        </button>
      </div>
    </section>

    <p class="foot">
      提醒只是提醒。吃不吃、吃多少，永远以医生的话为准。
    </p>

    <!-- ============ 添加：三条路 ============ -->
    <Transition name="sheet">
      <div v-if="composeOpen" class="sheet-mask" @click.self="closeCompose">
        <div class="sheet">
          <div class="sheet-grabber"></div>
          <header class="sheet-head">
            <h3>添加吃药提醒</h3>
            <button class="icon-btn" title="关闭" @click="closeCompose"><Icon name="x" :size="19" /></button>
          </header>

          <div class="sheet-body">
            <textarea
              v-model="composeText"
              class="ta"
              rows="3"
              placeholder="比如：早上饭后一片舍曲林，晚上睡前半片"
            ></textarea>

            <div class="ways">
              <button class="way" @click="pickFile">
                <Icon name="camera" :size="17" />
                <b>拍医嘱</b>
                <em>处方单 / 药盒</em>
              </button>
              <button class="way" @click="speak">
                <Icon name="mic" :size="17" />
                <b>说一句</b>
                <em>懒得打字就说</em>
              </button>
              <button class="way primary" :disabled="parsing" @click="parseText">
                <Icon name="sparkles" :size="17" />
                <b>{{ parsing ? '读…' : '让 AI 整理' }}</b>
                <em>生成草稿</em>
              </button>
            </div>
            <input ref="fileRef" type="file" accept="image/*" multiple hidden @change="pickImages" />

            <!-- 草稿：必须逐条确认，绝不自动保存 -->
            <div v-if="draft.length" class="draft">
              <div class="draft-head">
                <b>读出来这些，确认一下</b>
                <button class="text-btn" @click="acceptAll">全部添加</button>
              </div>
              <p v-if="draftSummary" class="draft-sum">{{ draftSummary }}</p>
              <ul>
                <li v-for="(d, i) in draft" :key="i" class="draft-item">
                  <div class="di-main">
                    <b>{{ d.name }}</b>
                    <span v-if="d.prn" class="prn-tag">必要时</span>
                    <em>{{ d.slots.map((s) => `${s.at}${s.dose ? ` ${s.dose}` : ''}`).join(' · ') }}</em>
                    <em v-if="d.note" class="di-note">{{ d.note }}</em>
                    <em v-if="d.endDate" class="di-note">吃到 {{ d.endDate }}</em>
                  </div>
                  <button class="btn btn-sm btn-primary" :disabled="busy === `accept${i}`" @click="acceptDraft(i)">就用这个</button>
                </li>
              </ul>
              <p v-if="draftUnclear.length" class="unclear">
                <Icon name="alert" :size="13" />
                有几处没看准：{{ draftUnclear.join('；') }}
              </p>
            </div>
            <p v-else-if="!parsing" class="draft-tip">
              读出来的东西不会自动保存，要先给你过一眼。吃药这事不能让机器替你做主。
            </p>
          </div>
        </div>
      </div>
    </Transition>

    <!-- ============ 编辑某一种药 ============ -->
    <Transition name="sheet">
      <div v-if="editOpen && editing" class="sheet-mask" @click.self="editOpen = false">
        <div class="sheet">
          <div class="sheet-grabber"></div>
          <header class="sheet-head">
            <h3>编辑</h3>
            <button class="icon-btn" title="关闭" @click="editOpen = false"><Icon name="x" :size="19" /></button>
          </header>
          <div class="sheet-body">
            <label class="field">
              <span>药名</span>
              <input v-model="editing.name" type="text" maxlength="40" />
            </label>
            <label class="field">
              <span>剂量</span>
              <input v-model="editing.dose" type="text" maxlength="40" placeholder="1 片" />
            </label>

            <div class="field">
              <span>服药时间</span>
              <div class="slots">
                <div v-for="(s, i) in editing.slots" :key="i" class="slot-row">
                  <input v-model="s.at" type="time" />
                  <input v-model="s.label" type="text" maxlength="8" placeholder="早" class="slot-label" />
                  <input v-model="s.dose" type="text" maxlength="40" placeholder="剂量（可留空）" />
                  <button class="icon-btn sm" title="删掉这个时间" @click="editing.slots.splice(i, 1)">
                    <Icon name="x" :size="15" />
                  </button>
                </div>
                <button class="btn btn-sm" @click="editing.slots.push({ at: '08:00', label: '', dose: '' })">
                  <Icon name="plus" :size="14" /> 加一个时间
                </button>
              </div>
            </div>

            <label class="field">
              <span>备注</span>
              <input v-model="editing.note" type="text" maxlength="200" placeholder="饭后吃 / 忌酒" />
            </label>

            <label class="field row">
              <span>吃到哪天为止</span>
              <input v-model="editing.endDate" type="date" />
            </label>

            <div class="switches">
              <label class="switch">
                <input v-model="editing.alarm" type="checkbox" />
                <span>
                  <b>用闹钟提醒</b>
                  <em>到点响铃，静音也响，必须手动关掉。适合不能漏的药。</em>
                </span>
              </label>
              <label class="switch">
                <input v-model="editing.prn" type="checkbox" />
                <span>
                  <b>需要时服用</b>
                  <em>只在清单里留着，不设定时提醒。医嘱写「必要时服用」的勾这个。</em>
                </span>
              </label>
            </div>

            <div class="edit-acts">
              <button class="btn danger" @click="removeMed(editing)"><Icon name="trash" :size="15" /> 不提醒了</button>
              <button class="btn btn-primary" :disabled="busy === 'edit'" @click="saveEdit">保存</button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.group {
  margin-top: 22px;
}

.group-title {
  font-size: 0.78rem;
  font-weight: 620;
  color: var(--text-3);
  letter-spacing: 0.06em;
  margin: 0 4px 8px;
}

.pad {
  padding: 18px 16px;
}

.muted {
  color: var(--text-3);
  font-size: 0.9rem;
}

/* ---------- 通知能力提示 ---------- */
.notice {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 12px 14px;
  margin-top: 14px;
  border-color: var(--border-2);
  background: var(--amber-tint);
}

.notice.soft {
  border-color: var(--border);
  background: var(--surface-2);
}

.notice-icon {
  flex: 0 0 auto;
  color: var(--amber-text);
  display: grid;
  place-items: center;
}

.notice-body {
  flex: 1;
  min-width: 0;
}

.notice-body b {
  display: block;
  font-size: 0.9rem;
  font-weight: 620;
}

.notice-body p {
  margin: 2px 0 0;
  font-size: 0.8rem;
  color: var(--text-2);
  line-height: 1.5;
}

/* ---------- 今天 ---------- */
.empty {
  padding: 30px 20px;
  text-align: center;
}

.empty .big {
  color: var(--brand);
  display: inline-grid;
  place-items: center;
  margin-bottom: 8px;
}

.empty .tip {
  margin: 0 0 14px;
  color: var(--text-2);
  font-size: 0.9rem;
  line-height: 1.75;
}

.dose-card {
  padding: 14px 14px 6px;
  border-left: 3px solid var(--brand);
}

.dose-card.done {
  border-left-color: var(--ai);
}

.dose-head {
  display: flex;
  align-items: center;
  gap: 11px;
  padding-bottom: 12px;
}

.dh-icon {
  flex: 0 0 auto;
  width: 34px;
  height: 34px;
  border-radius: 11px;
  display: grid;
  place-items: center;
  background: var(--brand-tint);
  color: var(--brand-deep);
}

.dose-card.done .dh-icon {
  background: var(--ai-tint);
  color: var(--ai-text);
}

.dh-text b {
  display: block;
  font-size: 0.98rem;
  font-weight: 650;
}

.dh-text p {
  margin: 2px 0 0;
  font-size: 0.8rem;
  color: var(--text-2);
}

.dose-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.dose-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 0;
  border-top: 1px solid var(--border);
}

.dose-row.taken {
  opacity: 0.55;
}

.dr-time {
  flex: 0 0 auto;
  font-size: 0.84rem;
  color: var(--text-3);
  width: 44px;
  white-space: nowrap;
}

.dose-row.late .dr-time {
  color: var(--rose-text);
  font-weight: 650;
}

.dr-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
}

.dr-main b {
  font-size: 0.92rem;
  font-weight: 600;
}

.dr-main em {
  font-style: normal;
  font-size: 0.8rem;
  color: var(--text-2);
}

.dr-label {
  font-size: 0.7rem;
  padding: 1px 6px;
  border-radius: var(--r-full);
  background: var(--surface-2);
  color: var(--text-3);
}

.dr-act {
  flex: 0 0 auto;
  min-width: 56px;
  height: 32px;
  padding: 0 14px;
  border-radius: var(--r-full);
  background: var(--brand);
  color: #fff;
  font-size: 0.85rem;
  font-weight: 600;
  transition: transform var(--dur), opacity var(--dur);
}

.dr-act:active {
  transform: scale(0.95);
}

.dr-act:disabled {
  opacity: 0.5;
}

.dr-act.done {
  background: var(--ai-tint);
  color: var(--ai-text);
  min-width: 40px;
  padding: 0 10px;
  display: grid;
  place-items: center;
}

.dr-act.ghost {
  background: var(--surface-2);
  color: var(--text-2);
}

/* ---------- 按需服用 ---------- */
.prn-card {
  margin-top: 12px;
  padding: 13px 14px 5px;
  border-style: dashed;
}

.prn-head {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--amber-text);
  font-size: 0.88rem;
}

.prn-head b {
  font-weight: 620;
}

.prn-head span {
  margin-left: auto;
  font-size: 0.76rem;
  color: var(--text-3);
}

.prn-note {
  margin: 6px 0 2px;
  font-size: 0.78rem;
  line-height: 1.6;
  color: var(--text-3);
}

/* ---------- 药列表 ---------- */
.menu {
  padding: 4px 0;
  overflow: hidden;
}

.menu-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 14px;
  text-align: left;
  transition: background var(--dur);
}

.menu-row:hover {
  background: var(--surface-2);
}

.mi {
  flex: 0 0 auto;
  width: 30px;
  height: 30px;
  border-radius: 10px;
  display: grid;
  place-items: center;
}

.mi.brand {
  background: var(--brand-tint);
  color: var(--brand-deep);
}

.mi.amber {
  background: var(--amber-tint);
  color: var(--amber-text);
}

.ml {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.ml b {
  font-size: 0.93rem;
  font-weight: 600;
}

.ml em {
  font-style: normal;
  font-size: 0.79rem;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ml em.hint {
  color: var(--text-3);
  font-size: 0.74rem;
}

.mi-tag {
  flex: 0 0 auto;
  color: var(--amber-text);
}

.chev {
  flex: 0 0 auto;
  color: var(--text-3);
}

.foot {
  margin: 22px 4px 8px;
  font-size: 0.78rem;
  color: var(--text-3);
  text-align: center;
  line-height: 1.7;
}

/* ---------- 录入面板 ---------- */
.sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 16px 12px;
}

.sheet-head h3 {
  margin: 0;
  font-size: 1.02rem;
  font-weight: 650;
}

.sheet-body {
  padding: 0 16px calc(20px + var(--safe-bottom));
}

.ta {
  width: 100%;
  resize: none;
  padding: 12px 14px;
  border-radius: var(--r);
  background: var(--surface-2);
  border: 1px solid var(--border);
  font: inherit;
  font-size: 0.92rem;
  line-height: 1.7;
  color: var(--text);
}

.ta:focus {
  outline: none;
  border-color: var(--brand);
  background: var(--surface);
}

.ways {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin-top: 10px;
}

.way {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 11px 6px;
  border-radius: var(--r);
  background: var(--surface-2);
  border: 1px solid var(--border);
  color: var(--text-2);
  transition: transform var(--dur), border-color var(--dur);
}

.way:active {
  transform: scale(0.97);
}

.way b {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--text);
}

.way em {
  font-style: normal;
  font-size: 0.68rem;
  color: var(--text-3);
}

.way.primary {
  background: var(--brand-tint);
  border-color: var(--border-2);
  color: var(--brand-deep);
}

.way:disabled {
  opacity: 0.6;
}

.draft {
  margin-top: 16px;
}

.draft-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.draft-head b {
  font-size: 0.9rem;
  font-weight: 620;
}

.draft-sum {
  margin: 0 0 10px;
  font-size: 0.82rem;
  color: var(--text-2);
  line-height: 1.6;
}

.draft ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.draft-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 12px;
  border-radius: var(--r);
  background: var(--surface-2);
  border: 1px solid var(--border);
}

.di-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.di-main b {
  font-size: 0.92rem;
  font-weight: 620;
}

.di-main em {
  font-style: normal;
  font-size: 0.8rem;
  color: var(--text-2);
}

.di-main em.di-note {
  font-size: 0.75rem;
  color: var(--text-3);
}

.prn-tag {
  align-self: flex-start;
  font-size: 0.68rem;
  padding: 1px 6px;
  border-radius: var(--r-full);
  background: var(--amber-tint);
  color: var(--amber-text);
  margin-left: 6px;
}

.unclear {
  display: flex;
  gap: 6px;
  margin: 10px 0 0;
  font-size: 0.78rem;
  line-height: 1.6;
  color: var(--amber-text);
}

.draft-tip {
  margin: 14px 0 0;
  font-size: 0.78rem;
  line-height: 1.7;
  color: var(--text-3);
}

/* ---------- 编辑 ---------- */
.field {
  display: block;
  margin-bottom: 12px;
}

.field > span {
  display: block;
  font-size: 0.78rem;
  color: var(--text-3);
  margin-bottom: 5px;
}

.field input[type='text'],
.field input[type='date'],
.field input[type='time'] {
  width: 100%;
  padding: 9px 12px;
  border-radius: var(--r-sm);
  background: var(--surface-2);
  border: 1px solid var(--border);
  font: inherit;
  font-size: 0.9rem;
  color: var(--text);
}

.field input:focus {
  outline: none;
  border-color: var(--brand);
}

.slots {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.slot-row {
  display: grid;
  grid-template-columns: 96px 62px 1fr 30px;
  gap: 6px;
  align-items: center;
}

.switches {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 6px 0 16px;
}

.switch {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}

.switch input {
  margin-top: 3px;
  width: 17px;
  height: 17px;
  accent-color: var(--brand);
  flex: 0 0 auto;
}

.switch b {
  display: block;
  font-size: 0.88rem;
  font-weight: 600;
}

.switch em {
  display: block;
  font-style: normal;
  font-size: 0.76rem;
  color: var(--text-3);
  line-height: 1.55;
  margin-top: 1px;
}

.edit-acts {
  display: flex;
  gap: 10px;
  justify-content: space-between;
}

.btn.danger {
  color: var(--rose-text);
  background: var(--rose-tint);
  border-color: var(--border-2);
}
</style>
