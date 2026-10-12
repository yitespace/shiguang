<script setup lang="ts">
// =============================================================
// 语音记录 · 全屏弹层
// 心情差不想打字时：按住说话 → 自动转文字 → AI 提炼要点 → 存下来
// 录音本体也会保存，之后可以回放当时的声音
// =============================================================
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import Icon from './Icon.vue';
import * as api from '../lib/api';
import { finishRecording, isSecure, isSupported, MAX_MS, previewUrl, startRecording } from '../lib/recorder';
import { clearDraft, saveEntry, toast } from '../lib/store';
import { MOODS, type Mood, type VoiceExtract } from '../types';

/**
 * 语音服务返回的情绪 → 心情分档。
 * 百炼的 qwen3-asr-flash 会顺带标注 emotion，
 * 直接拿来预填比让模型再猜一次更准。
 */
const EMOTION_TO_MOOD: Record<string, Mood> = {
  sad: 2,
  angry: 2,
  fearful: 2,
  disgusted: 2,
  happy: 5,
  surprised: 4,
  neutral: 3,
};
import { hhmm, shortDate, today } from '../lib/date';
import { fallbackPoints, simpleClean } from '../lib/voice-text';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'update:open', v: boolean): void }>();

type Phase = 'idle' | 'recording' | 'working' | 'preview';

const phase = ref<Phase>('idle');
const elapsed = ref(0);
const level = ref(0);
const errorMsg = ref('');
const hint = ref('');

// 结果
const transcript = ref('');
const cleaned = ref('');
const points = ref<string[]>([]);
const mood = ref<Mood | null>(null);
const tags = ref<string[]>([]);
const title = ref('');
const audioId = ref('');
const durationMs = ref(0);
const localPreview = ref('');
const asrFailed = ref(false);
/** 转写失败时的可操作提示（例如余额不足该去哪充） */
const errorHint = ref('');
/** 语音服务直接给出的情绪（优先于 AI 猜的） */
const asrEmotion = ref('');
const worked = ref({ transcribe: false, extract: false });

let handle: Awaited<ReturnType<typeof startRecording>> | null = null;
let blobRef: Blob | null = null;
let tickTimer: number | undefined;
let rafId = 0;
const canvas = ref<HTMLCanvasElement | null>(null);
const wave: number[] = [];

const supported = computed(() => isSupported() && isSecure());
const tooLong = computed(() => elapsed.value >= MAX_MS);
const secs = computed(() => Math.floor(elapsed.value / 1000));
const timeText = computed(() => {
  const s = secs.value;
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
});
const remainText = computed(() => {
  const left = Math.max(0, Math.ceil((MAX_MS - elapsed.value) / 1000));
  return `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
});

/** 有内容的转写才值得走 AI */
const canExtract = computed(() => cleaned.value.trim().length > 0);

watch(
  () => props.open,
  (open) => {
    if (open) reset();
    else hardStop();
  },
);

onUnmounted(() => hardStop());

function reset() {
  phase.value = 'idle';
  elapsed.value = 0;
  level.value = 0;
  errorMsg.value = '';
  errorHint.value = '';
  asrEmotion.value = '';
  hint.value = '';
  transcript.value = '';
  cleaned.value = '';
  points.value = [];
  mood.value = null;
  tags.value = [];
  title.value = '';
  audioId.value = '';
  durationMs.value = 0;
  asrFailed.value = false;
  worked.value = { transcribe: false, extract: false };
  wave.length = 0;
  if (localPreview.value) URL.revokeObjectURL(localPreview.value);
  localPreview.value = '';
  blobRef = null;
}

function hardStop() {
  window.clearInterval(tickTimer);
  cancelAnimationFrame(rafId);
  if (handle) {
    try {
      handle.stop();
    } catch {
      /* ignore */
    }
    handle = null;
  }
}

// ---------------------------------------------------------------
// 录音
// ---------------------------------------------------------------
async function begin() {
  errorMsg.value = '';
  reset();
  try {
    handle = await startRecording((m) => (errorMsg.value = m));
  } catch (e: any) {
    errorMsg.value = e?.message || '无法开始录音';
    return;
  }
  phase.value = 'recording';
  const started = Date.now();
  tickTimer = window.setInterval(() => {
    elapsed.value = Date.now() - started;
    level.value = handle?.level?.() || 0;
    if (tooLong.value) void finish();
  }, 100);
  draw();
}

function draw() {
  const el = canvas.value;
  if (!el) return;
  const dpr = window.devicePixelRatio || 1;
  const w = el.clientWidth || 300;
  const h = el.clientHeight || 90;
  if (el.width !== w * dpr || el.height !== h * dpr) {
    el.width = w * dpr;
    el.height = h * dpr;
  }
  const ctx = el.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  if (phase.value === 'recording') {
    wave.push(level.value);
    if (wave.length > 120) wave.shift();
  }

  const n = wave.length || 1;
  const barW = 3;
  const gap = 2;
  const maxBars = Math.floor(w / (barW + gap));
  const start = Math.max(0, n - maxBars);
  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, 'rgba(109, 94, 252, 0.35)');
  grad.addColorStop(1, 'rgba(18, 179, 168, 0.95)');
  ctx.fillStyle = grad;

  for (let i = start; i < n; i++) {
    const v = wave[i] || 0;
    const bh = Math.max(3, v * (h - 8));
    const x = (i - start) * (barW + gap);
    const y = (h - bh) / 2;
    const r = barW / 2;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + barW, y, x + barW, y + bh, r);
    ctx.arcTo(x + barW, y + bh, x, y + bh, r);
    ctx.arcTo(x, y + bh, x, y, r);
    ctx.arcTo(x, y, x + barW, y, r);
    ctx.fill();
  }

  rafId = requestAnimationFrame(draw);
}

/** 结束录音 → 转写 → 提炼 */
async function finish() {
  if (!handle) return;
  const h = handle;
  handle = null;
  window.clearInterval(tickTimer);
  phase.value = 'working';
  hint.value = '正在识别语音…';

  try {
    const res = await finishRecording(h);
    blobRef = res.blob;
    durationMs.value = res.durationMs;
    localPreview.value = previewUrl(res.blob);
  } catch (e: any) {
    phase.value = 'idle';
    errorMsg.value = e?.message || '录音失败';
    return;
  }

  const blob = blobRef!;

  // 1) 上传 + 转写
  try {
    const result = await api.transcribeAudio({
      audio: await toBase64(blob),
      mime: (blob.type || 'audio/webm').split(';')[0],
      durationMs: durationMs.value,
      language: 'zh',
    });
    audioId.value = result.audio?.id || '';
    transcript.value = result.transcript || '';
    // 语音服务直接标了情绪就先用上，AI 之后还能覆盖
    if (result.emotion) {
      asrEmotion.value = result.emotion;
      const guess = EMOTION_TO_MOOD[String(result.emotion).toLowerCase()];
      if (guess && !mood.value) mood.value = guess;
    }
    asrFailed.value = !result.transcript;
    worked.value.transcribe = !!result.transcript;
    errorHint.value = result.hint || '';
    if (result.error || !result.transcript) {
      errorMsg.value = result.error
        ? `语音识别没成功。录音已经保存下来了，你可以在下面直接输入文字。`
        : '没听清内容。录音已经保存下来了，你可以在下面直接输入文字。';
    }
  } catch (e: any) {
    asrFailed.value = true;
    const msg = String(e?.message || '上传失败');
    if (/余额|balance|30001/i.test(msg)) {
      errorHint.value =
        '语音识别服务的账户余额不足：去服务商控制台充值，或改用阿里云百炼的 qwen3-asr-flash（有 10 小时免费额度）。';
      errorMsg.value = '语音识别暂时用不了。录音已保存，你可以在下面直接输入文字。';
    } else {
      errorMsg.value = `${msg}。你可以直接在下面手动输入内容，录音会一起保存。`;
    }
  }

  // 2) AI 提炼
  cleaned.value = transcript.value || '';
  if (transcript.value) await refine(true);

  phase.value = 'preview';
  await nextTick();
  hint.value = '';
}

async function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || '');
      const i = s.indexOf(',');
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    r.onerror = () => reject(new Error('录音读取失败'));
    r.readAsDataURL(blob);
  });
}

async function refine(silent = false) {
  const text = cleaned.value.trim();
  if (!text || busy.value) return;
  busy.value = true;
  phase.value = 'working';
  hint.value = 'AI 正在整理要点…';
  try {
    const ex: VoiceExtract = await api.extractVoice(text);
    cleaned.value = ex.cleaned || text;
    points.value = ex.points || [];
    // 语音服务给了情绪就优先用它；否则用 AI 从文字里判断的
    if (!asrEmotion.value && ex.mood) mood.value = ex.mood as Mood;
    if (ex.tags?.length) tags.value = [...new Set([...tags.value, ...ex.tags])].slice(0, 6);
    if (ex.title && !title.value) title.value = ex.title;
    worked.value.extract = true;
    errorMsg.value = '';
  } catch (e: any) {
    // AI 不可用时用本地规则清理，至少看着干净
    const local = simpleClean(text);
    if (local && local !== text) cleaned.value = local;
    points.value = fallbackPoints(local || text);
    if (!silent) errorMsg.value = `AI 整理失败（${e?.message || '未知错误'}），已用本地规则简单清理`;
  } finally {
    busy.value = false;
    if (phase.value === 'working') phase.value = 'preview';
    hint.value = '';
  }
}

// 转写失败时用户手动补文字，也能让 AI 整理
function onManualInput() {
  if (!cleaned.value.trim()) return;
  asrFailed.value = false;
}

async function retryAsr() {
  if (!blobRef) return;
  phase.value = 'working';
  hint.value = '重新识别中…';
  try {
    const result = await api.transcribeAudio({
      audio: await toBase64(blobRef),
      mime: (blobRef.type || 'audio/webm').split(';')[0],
      durationMs: durationMs.value,
      language: 'zh',
    });
    audioId.value = result.audio?.id || audioId.value;
    transcript.value = result.transcript || '';
    if (result.transcript) {
      asrFailed.value = false;
      errorMsg.value = '';
      cleaned.value = result.transcript;
      await refine(true);
    } else {
      errorMsg.value = result.error ? `还是没成功：${result.error}` : '还是没听清，直接写文字吧';
    }
  } catch (e: any) {
    errorMsg.value = e?.message || '重试失败';
  } finally {
    phase.value = 'preview';
    hint.value = '';
  }
}

// ---------------------------------------------------------------
// 保存
// ---------------------------------------------------------------
const saving = ref(false);
const busy = ref(false);

async function save() {
  const text = (cleaned.value || transcript.value).trim();
  if (!text && !audioId.value) {
    errorMsg.value = '还没有内容';
    return;
  }
  saving.value = true;
  const attachments = audioId.value
    ? [{ id: audioId.value, durationMs: durationMs.value, points: points.value }]
    : undefined;

  emit('update:open', false);
  clearDraft();
  await saveEntry({
    content: text || '（一段语音）',
    title: title.value.trim(),
    tags: tags.value,
    mood: mood.value,
    kind: audioId.value ? 'voice' : 'note',
    attachments,
  });
  saving.value = false;
  toast('已记下这段语音');
  reset();
}

function discard() {
  if (phase.value === 'working') return;
  emit('update:open', false);
  reset();
}

const moodList = MOODS;
const todayLabel = computed(() => `${shortDate(today())} ${hhmm(Date.now())}`);

/** 可选的常见标签，点一下就加 */
const QUICK_TAGS = ['情绪', '工作', '健康', '家庭', '人际', '学习', '想法'];
function toggleTag(t: string) {
  tags.value = tags.value.includes(t) ? tags.value.filter((x) => x !== t) : [...tags.value, t].slice(0, 6);
}
</script>

<template>
  <Teleport to="body">
    <Transition name="sheet">
      <div v-if="open" class="sheet-mask voice-mask" @click.self="discard">
        <div class="sheet voice-sheet">
          <div class="sheet-grabber"></div>

          <div class="sheet-title">
            <h3>
              {{ phase === 'preview' ? '这段语音记下来' : phase === 'recording' ? '正在听你说' : '说几句，我帮你记' }}
            </h3>
            <button class="icon-btn" title="关闭" @click="discard"><Icon name="x" :size="19" /></button>
          </div>

          <!-- 不支持 / 不安全上下文 -->
          <div v-if="!supported" class="banner">
            <Icon name="alert" :size="18" />
            <span>
              当前环境不能录音。录音需要 <b>HTTPS</b> 或 localhost，
              并且浏览器要支持麦克风（Chrome / Edge / Safari 都可以）。
            </span>
          </div>

          <!-- 待机 -->
          <template v-else-if="phase === 'idle'">
            <p class="voice-lead">
              心情不好、不想打字的时候，直接说就行。<br />
              我会把话记下来，顺手帮你整理出要点。
            </p>
            <button class="rec-btn" @click="begin">
              <Icon name="mic" :size="34" />
            </button>
            <p class="voice-tip">点一下开始，最长 5 分钟</p>
            <p v-if="errorMsg" class="voice-err">{{ errorMsg }}</p>
          </template>

          <!-- 录音中 -->
          <template v-else-if="phase === 'recording'">
            <div class="rec-status">
              <span class="rec-dot"></span>
              <span class="rec-time num">{{ timeText }}</span>
              <span class="rec-remain">剩余 {{ remainText }}</span>
            </div>
            <canvas ref="canvas" class="wave"></canvas>
            <p class="voice-tip">说完点下面的按钮结束</p>
            <button class="rec-btn is-stop" @click="finish">
              <Icon name="check" :size="30" />
            </button>
            <button class="text-btn" @click="discard">取消这段录音</button>
          </template>

          <!-- 处理中 -->
          <template v-else-if="phase === 'working'">
            <div class="working">
              <div class="think-dot"><i></i><i></i><i></i></div>
              <p>{{ hint || '正在处理…' }}</p>
              <audio v-if="localPreview" :src="localPreview" controls class="hidden-audio"></audio>
            </div>
          </template>

          <!-- 结果预览 -->
          <template v-else>
            <!-- 回放 -->
            <div v-if="localPreview || audioId" class="playback">
              <Icon name="mic" :size="16" />
              <audio :src="localPreview || api.audioUrl({ id: audioId })" controls preload="metadata"></audio>
              <span class="pb-time num">{{ (durationMs / 1000).toFixed(1) }}s</span>
            </div>

            <div v-if="errorMsg" class="banner banner-col" style="margin-bottom: 12px">
              <div class="banner-line">
                <Icon name="alert" :size="18" />
                <span>{{ errorMsg }}</span>
              </div>
              <p v-if="errorHint" class="banner-hint">{{ errorHint }}</p>
              <button v-if="blobRef && asrFailed" class="btn btn-sm" @click="retryAsr">重试识别</button>
            </div>

            <!-- 说的话（可改） -->
            <div class="label">你说的话{{ asrFailed ? '（可直接输入）' : '（可修改）' }}</div>
            <div class="field">
              <textarea
                v-model="cleaned"
                rows="3"
                placeholder="转写结果会出现在这里，也可以自己输入"
                @input="onManualInput"
              ></textarea>
            </div>

            <button class="btn btn-sm ai-refine" :disabled="!canExtract || busy" @click="refine()">
              <Icon name="sparkles" :size="14" /> 让 AI 整理要点
            </button>

            <!-- AI 要点 -->
            <template v-if="points.length">
              <div class="label">AI 提炼的要点</div>
              <ul class="points">
                <li v-for="(p, i) in points" :key="i">
                  <Icon name="check" :size="13" />
                  <span>{{ p }}</span>
                </li>
              </ul>
            </template>

            <!-- 心情 -->
            <div class="label">
              此刻心情{{ asrEmotion ? '（从语气里听出来的，可以改）' : '（AI 猜的，可以改）' }}
            </div>
            <div class="mood-row">
              <button
                v-for="m in moodList"
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
              <button
                v-for="t in QUICK_TAGS"
                :key="t"
                class="chip"
                :class="{ 'is-active': tags.includes(t) }"
                @click="toggleTag(t)"
              >
                #{{ t }}
              </button>
            </div>

            <div class="label">标题（可选）</div>
            <div class="field">
              <input v-model="title" placeholder="给这段留个短标题" maxlength="24" />
            </div>

            <p class="voice-when">会记在 {{ todayLabel }}</p>

            <div class="acts">
              <button class="btn" @click="discard">不留了</button>
              <div class="spacer"></div>
              <button class="btn btn-primary" :disabled="saving || (!cleaned.trim() && !audioId)" @click="save">
                <Icon name="check" :size="16" /> 保存
              </button>
            </div>
          </template>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.banner-col {
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
}

.banner-line {
  display: flex;
  align-items: center;
  gap: 9px;
}

.banner-hint {
  font-size: 0.8rem;
  color: var(--text-2);
  line-height: 1.7;
  padding-left: 27px;
}

.banner-col .btn {
  align-self: flex-start;
  margin-left: 27px;
}

.voice-mask {
  align-items: flex-end;
}

.voice-sheet {
  max-width: min(600px, 100%);
  text-align: center;
}

.voice-lead {
  font-size: 0.92rem;
  color: var(--text-2);
  line-height: 1.8;
  margin: 10px 0 22px;
}

.voice-tip {
  font-size: 0.8rem;
  color: var(--text-3);
  margin-top: 12px;
}

.voice-err {
  font-size: 0.86rem;
  color: var(--rose);
  margin-top: 14px;
  line-height: 1.7;
}

/* 录音按钮 */
.rec-btn {
  width: 96px;
  height: 96px;
  margin: 6px auto 4px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  color: #fff;
  background: linear-gradient(135deg, var(--brand), var(--brand-deep));
  box-shadow: 0 16px 38px -12px var(--brand-glow);
  transition: transform 0.22s var(--spring), box-shadow var(--dur);
  position: relative;
}

.rec-btn:active {
  transform: scale(0.93);
}

.rec-btn::after {
  content: '';
  position: absolute;
  inset: -8px;
  border-radius: 50%;
  border: 2px solid var(--brand-tint);
}

.rec-btn.is-stop {
  background: linear-gradient(135deg, var(--ai), #0e9e94);
  box-shadow: 0 16px 38px -12px rgba(18, 179, 168, 0.55);
  animation: pulse-ring 1.9s infinite;
}

@keyframes pulse-ring {
  0% {
    box-shadow: 0 16px 38px -12px rgba(18, 179, 168, 0.55), 0 0 0 0 rgba(18, 179, 168, 0.42);
  }
  70% {
    box-shadow: 0 16px 38px -12px rgba(18, 179, 168, 0.55), 0 0 0 20px rgba(18, 179, 168, 0);
  }
  100% {
    box-shadow: 0 16px 38px -12px rgba(18, 179, 168, 0.55), 0 0 0 0 rgba(18, 179, 168, 0);
  }
}

.rec-status {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin: 12px 0 6px;
}

.rec-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--rose);
  animation: blink 1s steps(2) infinite;
}

.rec-time {
  font-size: 1.5rem;
  font-weight: 680;
  letter-spacing: -0.02em;
}

.rec-remain {
  font-size: 0.76rem;
  color: var(--text-3);
}

.wave {
  display: block;
  width: 100%;
  height: 92px;
  margin: 8px 0 4px;
}

.text-btn {
  display: block;
  margin: 16px auto 0;
  font-size: 0.84rem;
  color: var(--text-3);
}

.text-btn:hover {
  color: var(--rose);
}

/* 处理中 */
.working {
  padding: 44px 0 40px;
  display: grid;
  gap: 14px;
  place-items: center;
  color: var(--text-2);
  font-size: 0.92rem;
}

.hidden-audio {
  display: none;
}

/* 回放 */
.playback {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  margin-bottom: 14px;
  border-radius: var(--r);
  background: var(--brand-tint);
  color: var(--brand-deep);
  text-align: left;
}

.playback audio {
  flex: 1;
  min-width: 0;
  height: 34px;
}

.pb-time {
  font-size: 0.78rem;
  color: var(--text-2);
  white-space: nowrap;
}

/* 表单区：左对齐 */
.voice-sheet :deep(.label),
.voice-sheet .label {
  text-align: left;
}

.voice-sheet .field {
  text-align: left;
}

.ai-refine {
  margin: 10px 0 4px;
}

.points {
  list-style: none;
  margin: 0;
  padding: 14px 16px;
  border-radius: var(--r);
  background: var(--ai-tint);
  border: 1px solid color-mix(in srgb, var(--ai) 24%, transparent);
  text-align: left;
  display: grid;
  gap: 8px;
}

.points li {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 0.92rem;
  line-height: 1.65;
}

.points li :deep(svg) {
  color: var(--ai);
  flex: 0 0 auto;
  margin-top: 4px;
}

.tags-row {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}

.voice-when {
  font-size: 0.76rem;
  color: var(--text-3);
  margin-top: 14px;
  text-align: left;
}

.acts {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 18px;
}

.spacer {
  flex: 1;
}

.mood-row .mood-btn .label {
  text-align: center;
}
</style>
