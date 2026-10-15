// =============================================================
// 拾光 · 本地状态
// 记录以服务器为准，localStorage 只做离线缓存与待同步队列，
// 所以清掉浏览器数据也不会丢笔记。
// =============================================================

import { computed, ref } from 'vue';
import * as api from './api';
import * as careApi from './care';
import type { CareToday } from './care';
import type { AsrInfo, AudioAttachment, AuthStatus, Entry, Stats, TimeRange } from '../types';

const LS_ENTRIES = 'shiguang.entries.v1';
const LS_QUEUE = 'shiguang.queue.v1';
const LS_THEME = 'shiguang.theme';
const LS_DRAFT = 'shiguang.draft';

/**
 * 生成 id。
 * crypto.randomUUID 只在安全上下文（https / localhost）可用，
 * 用 IP 走 http 打开时会没有，所以要兜底。
 */
function uid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  if (c?.getRandomValues) {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------- 全局状态 ----------
export const authed = ref(false);
export const aiReady = ref(false);
export const model = ref('deepseek-flash');
/** 当前登录的人（手机号账号）。没登录时是 null。 */
export const me = ref<AuthStatus['me']>(null);
/**
 * 账号资料（昵称、简介、手机号…）。
 * 放在全局是因为「我的」页头图和「个人资料」页都要读它，
 * 在个人资料页改完名字，返回时头图得立刻跟着变。
 */
export const profile = ref<api.Profile | null>(null);
/** 服务端语音转写通道状态 */
export const asr = ref<AsrInfo>({ enabled: false, provider: null, label: null, model: null });
export const ready = ref(false);

export const entries = ref<Entry[]>([]);
export const stats = ref<Stats | null>(null);
export const tags = ref<{ name: string; count: number }[]>([]);
export const loading = ref(false);
export const online = ref(typeof navigator === 'undefined' ? true : navigator.onLine);
export const pendingCount = ref(0);

const toastMsg = ref('');
const toastOn = ref(false);
const toastAction = ref<{ label: string; run: () => void } | null>(null);
let toastTimer: number | undefined;

/**
 * 弹出提示。
 * 传 action 时会带一个可点的按钮（主要用于「撤销删除」）。
 */
export function toast(msg: string, action?: { label: string; run: () => void }, ms = 2600) {
  toastMsg.value = msg;
  toastAction.value = action || null;
  toastOn.value = true;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastOn.value = false;
    toastAction.value = null;
  }, action ? Math.max(ms, 5000) : ms);
}

export function runToastAction() {
  const a = toastAction.value;
  toastOn.value = false;
  toastAction.value = null;
  window.clearTimeout(toastTimer);
  a?.run();
}

export const toastText = computed(() => toastMsg.value);
export const toastVisible = computed(() => toastOn.value);
export const toastActionLabel = computed(() => toastAction.value?.label || '');
export const toastHasAction = computed(() => !!toastAction.value);

// ---------- 主题 ----------
export const theme = ref<'light' | 'dark'>('light');

export function applyTheme(next: 'light' | 'dark') {
  theme.value = next;
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(LS_THEME, next);
  } catch {
    /* 无痕模式忽略 */
  }
}

export function initTheme() {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(LS_THEME);
  } catch {
    /* ignore */
  }
  if (saved === 'light' || saved === 'dark') return applyTheme(saved);
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  applyTheme(prefersDark ? 'dark' : 'light');
}

export function toggleTheme() {
  applyTheme(theme.value === 'dark' ? 'light' : 'dark');
}

// ---------- 本地缓存 ----------
function readLS<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeLS(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 超出配额等忽略 */
  }
}

// ---------- 草稿（防止写着写着关掉就没了） ----------
export interface Draft {
  text: string;
  at: number;
}

/** 草稿只留 24 小时，过期就不要了，免得下次打开一脸懵 */
const DRAFT_TTL = 24 * 3600 * 1000;

export function saveDraft(text: string) {
  try {
    const t = String(text || '');
    if (t.trim()) {
      localStorage.setItem(LS_DRAFT, JSON.stringify({ text: t, at: Date.now() } satisfies Draft));
    } else {
      localStorage.removeItem(LS_DRAFT);
    }
  } catch {
    /* 无痕模式等忽略 */
  }
}

export function loadDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(LS_DRAFT);
    if (!raw) return null;
    // 兼容早期只存纯文本的格式
    if (!raw.startsWith('{')) return { text: raw, at: Date.now() };
    const d = JSON.parse(raw) as Draft;
    if (!d?.text?.trim()) return null;
    if (Date.now() - (d.at || 0) > DRAFT_TTL) {
      localStorage.removeItem(LS_DRAFT);
      return null;
    }
    return d;
  } catch {
    return null;
  }
}

// ---------- 检索历史（经常反复搜同一个词） ----------
const LS_SEARCHES = 'shiguang.searches.v1';
const MAX_SEARCHES = 8;

export function loadSearches(): string[] {
  try {
    const raw = localStorage.getItem(LS_SEARCHES);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string').slice(0, MAX_SEARCHES) : [];
  } catch {
    return [];
  }
}

export function pushSearch(q: string): string[] {
  const term = String(q || '').trim();
  if (!term) return loadSearches();
  const list = [term, ...loadSearches().filter((x) => x !== term)].slice(0, MAX_SEARCHES);
  try {
    localStorage.setItem(LS_SEARCHES, JSON.stringify(list));
  } catch {
    /* ignore */
  }
  return list;
}

export function clearSearches() {
  try {
    localStorage.removeItem(LS_SEARCHES);
  } catch {
    /* ignore */
  }
}

export function clearDraft() {
  try {
    localStorage.removeItem(LS_DRAFT);
  } catch {
    /* ignore */
  }
}

// ---------- 待同步队列 ----------
interface QueueItem {
  op: 'put' | 'delete';
  payload: any;
  at: number;
}

function readQueue(): QueueItem[] {
  return readLS<QueueItem[]>(LS_QUEUE, []);
}

function writeQueue(q: QueueItem[]) {
  writeLS(LS_QUEUE, q);
  pendingCount.value = q.length;
}

function enqueue(op: 'put' | 'delete', payload: any) {
  const q = readQueue();
  // 同一条记录的多次改动只保留最后一次
  const idx = q.findIndex((x) => x.payload?.id === payload?.id);
  if (idx >= 0) q.splice(idx, 1);
  q.push({ op, payload, at: Date.now() });
  writeQueue(q);
}

export async function flushQueue() {
  const q = readQueue();
  if (!q.length) return;
  if (!navigator.onLine) return;
  const remaining: QueueItem[] = [];
  for (const item of q) {
    try {
      if (item.op === 'delete') await api.deleteEntry(item.payload.id);
      else await api.createEntry(item.payload);
    } catch (e: any) {
      if (e?.status === 401) {
        remaining.push(item);
        break;
      }
      remaining.push(item);
    }
  }
  writeQueue(remaining);
  if (q.length && remaining.length < q.length) {
    await refresh({ silent: true });
  }
}

// ---------- 启动 ----------
/**
 * 今天的关怀状态（有没有没吃的药、有没有快到点的提醒、现在该不该专注）。
 *
 * 放在 store 里、并进启动流程，而不是让各页面自己拉：
 * 首页那张「还有 N 次药没吃」的卡如果晚一拍才插进去，会把整条时间线
 * 往下推一次 —— 用户看到的就是「页面刚打开自己跳了一下」。
 * 跟着 bootstrap 一起加载，等外壳显示出来的时候它已经在了。
 */
export const careToday = ref<CareToday | null>(null);

/**
 * 连不上服务器。
 *
 * 和「没登录」是两件完全不同的事，以前却混在一起：authStatus 一失败就把
 * authed 置成 false，于是网络断了的人会被扔到登录页，然后开始怀疑自己
 * 密码记错了 —— 而问题根本不在这儿。
 *
 * 现在遇到了网络错误就把它标出来，界面显示一块「连不上服务器」，
 * 说清楚是哪一步不通、能不能重试，而不是假装人家没登录。
 */
export const netDown = ref(false);
/** 连不上时的具体提示，直接显示给用户 */
export const netDownMsg = ref('');

export async function refreshCare() {
  try {
    careToday.value = await careApi.careToday();
  } catch {
    /* 拉不到就当没有，首页不显示那张卡，绝不因此弹错误 */
  }
}

export async function bootstrap() {
  initTheme();

  // 先用本地缓存立刻渲染，界面不会白屏
  const cached = readLS<Entry[]>(LS_ENTRIES, []);
  if (cached.length) entries.value = cached;
  pendingCount.value = readQueue().length;

  window.addEventListener('online', () => {
    online.value = true;
    toast('已恢复网络连接');
    flushQueue();
  });
  window.addEventListener('offline', () => {
    online.value = false;
    toast('已离线，记录会先存在本地');
  });

  try {
    const st = await api.authStatus();
    netDown.value = false;
    netDownMsg.value = '';
    authed.value = st.authed;
    me.value = st.me || null;
    aiReady.value = st.ai;
    model.value = st.model;
    if (st.asr) asr.value = st.asr;
    if (st.authed) {
      // 记录、资料、关怀状态一起拉：这几样都决定首屏长什么样，
      // 分两批会让首屏先画一次再跳一次
      await Promise.all([refresh({ silent: true }), loadProfile(), refreshCare()]);
    }
  } catch (e: any) {
    /*
     * 服务器暂时不可达。
     *
     * status === 0 表示「根本没连上」，不是「服务器说你没登录」。
     * 这两种情况要分开处理：连不上时把人踢到登录页，他会以为是自己
     * 密码记错了，然后一遍遍重试 —— 真正的问题（网络）反而被藏起来了。
     */
    const offline = e instanceof api.ApiError && e.status === 0;
    if (offline) {
      netDown.value = true;
      netDownMsg.value = String(e.message || '');
      // 本地有缓存就当作还在登录态，至少能翻以前的记录
      authed.value = cached.length > 0;
    } else {
      authed.value = false;
      me.value = null;
      profile.value = null;
    }
  } finally {
    ready.value = true;
  }
}

/** 手动重试启动流程（界面上「再试一次」用的） */
export async function retryBootstrap() {
  ready.value = false;
  await bootstrap();
}

/** 拉一次账号资料；失败不抛，页面照常显示 */
export async function loadProfile() {
  try {
    profile.value = await api.getProfile();
  } catch {
    /* 静默失败，页面显示默认文案 */
  }
}

/** 改昵称和简介，成功后同步到全局 */
export async function saveProfile(nickname: string, bio: string) {
  const res = await api.saveProfile(nickname, bio);
  if (profile.value) profile.value = { ...profile.value, nickname: res.nickname, bio: res.bio };
  else await loadProfile();
  return res;
}

/** 登录成功后统一走这里刷新全局状态（密码和短信两种方式共用） */
export async function reloadSession() {
  authed.value = true;
  const st = await api.authStatus();
  me.value = st.me || null;
  aiReady.value = st.ai;
  model.value = st.model;
  if (st.asr) asr.value = st.asr;
  await refresh({ silent: true });
  await loadProfile();
  await flushQueue();
}

export async function doLogin(phone: string, password: string) {
  const res = await api.login(phone, password);
  me.value = res.me || null;
  await reloadSession();
}

export async function doRegister(phone: string, inviteCode: string, password: string) {
  const res = await api.register(phone, inviteCode, password);
  me.value = res.me || null;
  await reloadSession();
}

export async function doLogout() {
  try {
    // 服务端清 cookie 才叫真退出，光清本地状态下次刷新又进来了
    await api.signOut();
  } catch {
    /* ignore */
  }
  authed.value = false;
  entries.value = [];
  stats.value = null;
  tags.value = [];
}

// ---------- 数据加载 ----------
export async function refresh(opts: { silent?: boolean } = {}) {
  if (!opts.silent) loading.value = true;

  const pull = async () => {
    const [list, st] = await Promise.all([api.listEntries({ limit: 2000 }), api.getStats()]);
    entries.value = list.entries;
    stats.value = st;
    tags.value = st.tags;
    writeLS(LS_ENTRIES, list.entries);
  };

  try {
    await pull();
  } catch (e: any) {
    if (e?.status === 401) {
      authed.value = false;
      return;
    }
    /*
     * 后台静默刷新失败时自动再试一次。
     * 网络抖一下、或者服务端正好在处理别的请求，不该让首页的时间线空着——
     * 用户看到的是「我记的东西没了」，比慢一秒可怕得多。
     */
    if (opts.silent) {
      try {
        await new Promise((r) => setTimeout(r, 1200));
        await pull();
        return;
      } catch {
        /* 还是不行就不弹提示，页面本身还有本地缓存兜底 */
      }
    }
    if (!opts.silent) toast(e?.message || '加载失败');
  } finally {
    loading.value = false;
  }
}

// ---------- 写入 ----------
export interface SaveInput {
  id?: string;
  content: string;
  title?: string;
  tags?: string[];
  mood?: number | null;
  kind?: string;
  date?: string;
  createdAt?: number;
  /** 语音附件（保存时带上，录音本体已经在服务器上了） */
  attachments?: { id: string; durationMs: number; points: string[] }[];
}

function localDate(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 新增或修改一条记录：先本地生效，再同步服务器 */
export async function saveEntry(input: SaveInput): Promise<Entry> {
  const now = Date.now();
  const existing = input.id ? entries.value.find((e) => e.id === input.id) : undefined;

  if (existing) {
    const optimistic: Entry = {
      ...existing,
      ...input,
      tags: input.tags ?? existing.tags,
      attachments: (input.attachments as AudioAttachment[]) ?? existing.attachments,
      updatedAt: now,
      _pending: true,
    };
    entries.value = entries.value.map((e) => (e.id === existing.id ? optimistic : e));
    try {
      const { entry } = await api.updateEntry(existing.id, input);
      entries.value = entries.value.map((e) => (e.id === entry.id ? entry : e));
      writeLS(LS_ENTRIES, entries.value);
      refreshStats();
      return entry;
    } catch {
      enqueue('put', { ...optimistic, id: existing.id, _pending: undefined });
      toast('已存到本地，联网后自动同步');
      return optimistic;
    }
  }

  const createdAt = input.createdAt ?? now;
  const optimistic: Entry = {
    id: input.id || uid(),
    createdAt,
    updatedAt: now,
    date: input.date || localDate(createdAt),
    mood: input.mood ?? null,
    tags: input.tags || [],
    title: input.title || '',
    content: input.content,
    kind: input.kind || 'note',
    attachments: (input.attachments || []) as AudioAttachment[],
    deleted: false,
    _pending: true,
  };
  entries.value = [optimistic, ...entries.value].sort((a, b) => b.createdAt - a.createdAt);

  try {
    const { entry } = await api.createEntry({ ...input, id: optimistic.id, createdAt });
    entries.value = entries.value.map((e) => (e.id === entry.id ? entry : e));
    writeLS(LS_ENTRIES, entries.value);
    refreshStats();
    announceSaved(entry);
    return entry;
  } catch {
    enqueue('put', { ...input, id: optimistic.id, createdAt });
    toast('已存到本地，联网后自动同步');
    // 离线也照样问一次：识别是打服务器的，失败就什么都不做，
    // 但联网的时候用户不该因为「刚才断了一下」就少了这个功能
    announceSaved(optimistic);
    return optimistic;
  }
}

/**
 * 广播「刚存了一条」。
 *
 * 放在这里而不是两个弹层里：saveEntry 是所有保存路径的唯一出口，
 * 在这儿广播就不会出现「文字记录会问要不要设提醒、语音记录不会」这种
 * 一半有一半没有的情况。
 *
 * 用 setTimeout 让出去一拍再发：调用方紧接着就会关弹层、弹 toast，
 * 识别要打一次 AI，别和这些抢同一帧。
 */
function announceSaved(entry: Entry) {
  if (!entry || entry.deleted) return;
  window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent('sg:saved', { detail: { id: entry.id, content: entry.content } }));
  }, 60);
}

/**
 * 删除一条记录。
 * 返回被删的那条，调用方可以拿它做「撤销」。
 */
export async function removeEntry(id: string): Promise<Entry | null> {
  const target = entries.value.find((e) => e.id === id) || null;
  if (!target) return null;
  entries.value = entries.value.filter((e) => e.id !== id);
  try {
    await api.deleteEntry(id);
    writeLS(LS_ENTRIES, entries.value);
    refreshStats();
  } catch {
    enqueue('delete', { id });
  }
  return target;
}

/** 把删掉的记录放回去（先在本地恢复，再重新提交给服务器） */
export async function restoreEntry(entry: Entry) {
  entries.value = [entry, ...entries.value].sort((a, b) => b.createdAt - a.createdAt);
  writeLS(LS_ENTRIES, entries.value);
  try {
    const { entry: saved } = await api.createEntry({
      id: entry.id,
      content: entry.content,
      title: entry.title,
      tags: entry.tags,
      mood: entry.mood,
      kind: entry.kind,
      date: entry.date,
      createdAt: entry.createdAt,
      attachments: (entry.attachments || []).map((a) => ({
        id: a.id,
        durationMs: a.durationMs,
        points: a.points || [],
      })),
    });
    entries.value = entries.value.map((e) => (e.id === saved.id ? saved : e));
    writeLS(LS_ENTRIES, entries.value);
    refreshStats();
    toast('已恢复');
  } catch {
    enqueue('put', {
      id: entry.id,
      content: entry.content,
      title: entry.title,
      tags: entry.tags,
      mood: entry.mood,
      kind: entry.kind,
      date: entry.date,
      createdAt: entry.createdAt,
      attachments: (entry.attachments || []).map((a) => ({ id: a.id, durationMs: a.durationMs, points: a.points || [] })),
    });
    toast('已恢复到本地，联网后同步');
  }
}

async function refreshStats() {
  try {
    const st = await api.getStats();
    stats.value = st;
    tags.value = st.tags;
  } catch {
    /* 统计失败不影响主流程 */
  }
}

// ---------- 派生数据 ----------
export const groupedByDate = computed(() => {
  const map = new Map<string, Entry[]>();
  for (const e of entries.value) {
    if (!map.has(e.date)) map.set(e.date, []);
    map.get(e.date)!.push(e);
  }
  for (const list of map.values()) list.sort((a, b) => b.createdAt - a.createdAt);
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
});

export function entriesOfDate(date: string): Entry[] {
  return entries.value.filter((e) => e.date === date).sort((a, b) => a.createdAt - b.createdAt);
}

export const allTags = computed(() => {
  const m = new Map<string, number>();
  for (const e of entries.value) for (const t of e.tags) m.set(t, (m.get(t) || 0) + 1);
  return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
});

export type { TimeRange };
