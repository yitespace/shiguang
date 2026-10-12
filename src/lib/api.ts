// =============================================================
// 拾光 · 接口封装
// =============================================================

import type {
  AiMeta,
  AudioAttachment,
  AuthStatus,
  VoiceExtract,
  DaySummary,
  Entry,
  Hit,
  MemoryResult,
  Stats,
  TimeRange,
} from '../types';

/**
 * 打包进安卓 App 时用的后端地址。
 * 网页版是同源部署（/shiguang/api），App 里页面跑在 https://localhost，
 * 必须用绝对地址，否则请求会打到 App 本地的空壳上。
 */
const NATIVE_API_HOST = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/+$/, '') || '';

/** 当前是不是跑在 Capacitor 壳里 */
export function isNativeShell(): boolean {
  if (typeof location === 'undefined') return false;
  const p = location.protocol;
  const h = location.hostname;
  return p === 'capacitor:' || p === 'ionic:' || ((h === 'localhost' || h === '127.0.0.1') && p !== 'http:' && p !== 'https:');
}

/**
 * 计算 API 根路径。
 *   网页版：页面在 /shiguang/#/xxx → 接口 /shiguang/api/*
 *   本地开发：页面在 / → 由 Vite 代理 /api → 127.0.0.1:8787
 *   安卓 App：页面在 https://localhost → 必须走绝对地址
 */
export function apiBase(): string {
  if (typeof location === 'undefined') return '/api';

  // App 壳：用绝对地址
  if (isNativeShell() || NATIVE_API_HOST) {
    const host = NATIVE_API_HOST || 'https://zhuangrongjian.space/shiguang';
    return `${host}/api`;
  }

  const path = location.pathname;
  const marker = '/shiguang';
  const idx = path.indexOf(marker);
  if (idx >= 0) {
    const after = path.slice(idx + marker.length);
    return after === '' || after === '/' || after.startsWith('/') ? `${path.slice(0, idx + marker.length)}/api` : '/api';
  }
  return '/api';
}

const BASE = apiBase();

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
  } catch {
    throw new ApiError(
      isNativeShell() ? '连不上服务器，请检查手机网络后重试' : '网络连接失败，请检查网络后重试',
      0,
    );
  }
  let json: any = null;
  let parseFailed = false;
  try {
    json = await res.json();
  } catch {
    parseFailed = true;
  }

  if (parseFailed || !json) {
    // 别再把「解析失败」说成「请求失败（200）」，那句话会把人带偏
    const ct = res.headers.get('content-type') || '未知类型';
    throw new ApiError(
      `服务器返回了不是 JSON 的内容（HTTP ${res.status}，${ct}）。` +
        (isNativeShell() ? 'App 里通常是网络不通或接口地址不对。' : '可能是请求被网关拦了。'),
      res.status,
    );
  }
  if (!res.ok || !json.ok) {
    throw new ApiError(json.error || `请求失败（HTTP ${res.status}）`, res.status);
  }
  return json.data as T;
}

// ---------- 认证 ----------
export const authStatus = () => request<AuthStatus>('/auth/status');

/** 账号就是手机号，登录要手机号 + 密码 */
export const login = (phone: string, password: string) =>
  request<{ authed: boolean; me: Me }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ phone, password }),
  });

/**
 * 注册：手机号 + 邀请码 + 自己设的密码。
 * 之所以不是短信验证码：阿里云短信要资质审核 + 运营商实名报备，
 * 个人认证过不了，整套两周起步。邀请码由管理员掌握，够用。
 */
export const register = (phone: string, inviteCode: string, password: string) =>
  request<{ authed: boolean; me: Me }>('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ phone, inviteCode, password }),
  });

/** 可用的登录方式（决定登录页显示什么） */
export interface AuthMethods {
  password: boolean;
  sms: boolean;
  register: boolean;
  /** 注册要不要邀请码 */
  invite?: boolean;
  smsReason: string | null;
  userCount: number;
}
export const authMethods = () => request<AuthMethods>('/auth/methods');

/** 请求短信验证码（只有登录这一种用途了） */
export const sendSmsCode = (phone: string) =>
  request<{ sent: boolean; devCode?: string }>('/auth/sms/send', {
    method: 'POST',
    body: JSON.stringify({ phone }),
  });

/** 短信验证码快捷登录 */
export const smsLogin = (phone: string, code: string) =>
  request<{ authed: boolean; me: Me }>('/auth/sms/login', {
    method: 'POST',
    body: JSON.stringify({ phone, code }),
  });

/** 当前登录的人 */
export interface Me {
  id: string;
  phone: string;
  phoneMasked: string;
  nickname: string;
  role: string;
  createdAt: number;
}

export interface Profile {
  nickname: string;
  bio: string;
  phone: string | null;
  phoneMasked: string | null;
  hasPassword: boolean;
  smsConfigured: boolean;
  createdAt?: number;
}

/** 账号信息 */
export const getProfile = () => request<Profile>('/auth/profile');

/** 改昵称和简介 */
export const saveProfile = (nickname: string, bio: string) =>
  request<{ nickname: string; bio: string }>('/auth/profile', {
    method: 'PUT',
    body: JSON.stringify({ nickname, bio }),
  });

/** 换手机号（账号就是手机号，等于换账号，用当前密码验证是本人） */
export const changePhone = (phone: string, password: string) =>
  request<{ phone: string; phoneMasked: string }>('/auth/phone', {
    method: 'POST',
    body: JSON.stringify({ phone, password }),
  });

/** 退出登录（清掉服务端会话） */
export const signOut = () => request<{ authed: boolean }>('/auth/signout', { method: 'POST' });

export const logout = () => request<{ authed: boolean }>('/auth/logout', { method: 'POST' });

export const changePassword = (oldPassword: string, newPassword: string) =>
  request<{ changed: boolean }>('/auth/password', {
    method: 'POST',
    body: JSON.stringify({ oldPassword, newPassword }),
  });

// ---------- 记录 ----------
export const listEntries = (params: { from?: string; to?: string; limit?: number } = {}) => {
  const q = new URLSearchParams();
  if (params.from) q.set('from', params.from);
  if (params.to) q.set('to', params.to);
  if (params.limit) q.set('limit', String(params.limit));
  const qs = q.toString();
  return request<{ entries: Entry[]; total: number }>(`/entries${qs ? `?${qs}` : ''}`);
};

export interface EntryInput {
  id?: string;
  content: string;
  title?: string;
  tags?: string[];
  mood?: number | null;
  kind?: string;
  date?: string;
  createdAt?: number;
  attachments?: { id: string; durationMs: number; points: string[] }[];
}

export const createEntry = (input: EntryInput) =>
  request<{ entry: Entry }>('/entries', { method: 'POST', body: JSON.stringify(input) });

export const updateEntry = (id: string, patch: Partial<EntryInput>) =>
  request<{ entry: Entry }>(`/entries/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });

export const deleteEntry = (id: string) => request<{ deleted: string }>(`/entries/${id}`, { method: 'DELETE' });

export const bulkUpsert = (items: EntryInput[]) =>
  request<{ saved: number; entries: Entry[] }>('/entries/bulk', { method: 'POST', body: JSON.stringify({ items }) });

// ---------- 日期 / 统计 ----------
export const getDay = (date: string) =>
  request<{ date: string; weekday: string; entries: Entry[]; summary: DaySummary | null }>(`/day/${date}`);

export const getCalendar = (month: string) =>
  request<{ month: string; counts: Record<string, number> }>(`/calendar?month=${month}`);

export const getStats = () => request<Stats>('/stats');

export const getTags = () => request<{ tags: { name: string; count: number }[] }>('/tags');

export const summarizeDay = (date: string, force = false) =>
  request<DaySummary>('/summary', { method: 'POST', body: JSON.stringify({ date, force, today: todayStr() }) });

// ---------- 检索 ----------
export const search = (q: string, limit = 40) =>
  request<{ hits: Hit[]; count: number; range: TimeRange | null; keywords: string }>(
    `/search?q=${encodeURIComponent(q)}&limit=${limit}&today=${todayStr()}`,
  );

/** 浏览器所在时区的今天，用来避免服务器时区把日期算错一天 */
function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export const aiAsk = (question: string, history: { role: string; content: string }[] = []) =>
  request<{ answer: string; refs: string[]; meta: AiMeta }>('/ai/ask', {
    method: 'POST',
    body: JSON.stringify({ question, history, today: todayStr() }),
  });

// ---------- 那年今日 ----------
export const getMemories = (date: string, years = 5) =>
  request<MemoryResult>(`/memories?date=${date}&years=${years}`);

export const reflectMemories = (date: string) =>
  request<{ date: string; summary: string; groups?: number; empty?: boolean }>('/memories/reflect', {
    method: 'POST',
    body: JSON.stringify({ date }),
  });

// ---------- 语音 ----------
export interface TranscribeResult {
  audio: AudioAttachment;
  transcript: string;
  provider?: string;
  model?: string;
  /** 转写失败时的原因（录音仍然保留） */
  error?: string;
  /** 失败类型：balance / auth / rate / quota / format / unknown */
  errorKind?: string;
  /** 给用户看的、能照着做的提示 */
  hint?: string;
  /** 语音服务识别的情绪（例如 sad / happy），用来预填「此刻心情」 */
  emotion?: string | null;
  /** 识别出的语种 */
  language?: string | null;
  /** 识别耗时（毫秒） */
  elapsedMs?: number | null;
}

/** 上传录音并转写（一步到位） */
export const transcribeAudio = (payload: { audio: string; mime: string; durationMs: number; language?: string }) =>
  request<TranscribeResult>('/voice/transcribe', { method: 'POST', body: JSON.stringify(payload) });

/** 只上传录音不转写（离线补传用） */
export const uploadAudio = (payload: { audio: string; mime: string; durationMs: number; transcript?: string }) =>
  request<{ audio: AudioAttachment }>('/voice/upload', { method: 'POST', body: JSON.stringify(payload) });

/** 让 AI 把口语转写整理成要点 */
export const extractVoice = (transcript: string) =>
  request<VoiceExtract>('/voice/extract', {
    method: 'POST',
    body: JSON.stringify({ transcript, today: todayStr() }),
  });

/** 录音附件的完整播放地址 */
export function audioUrl(att: { id: string; url?: string }): string {
  return `${BASE}/audio/${att.id}`;
}

// ---------- 流式对话 ----------
export interface StreamHandlers {
  onDelta?: (text: string) => void;
  onDone?: (payload: { answer: string; refs: string[]; entries?: Entry[]; meta: AiMeta }) => void;
  onError?: (msg: string) => void;
}

/**
 * 流式提问。返回一个中止函数。
 */
export function askStream(question: string, history: { role: string; content: string }[], h: StreamHandlers) {
  const controller = new AbortController();

  (async () => {
    let res: Response;
    try {
      res = await fetch(`${BASE}/ai/chat`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, history, today: todayStr() }),
        signal: controller.signal,
      });
    } catch (e: any) {
      if (e?.name !== 'AbortError') h.onError?.('网络连接失败，请稍后重试');
      return;
    }
    if (!res.ok) {
      let msg = `请求失败（${res.status}）`;
      try {
        const j = await res.json();
        if (j?.error) msg = j.error;
      } catch {
        /* ignore */
      }
      h.onError?.(msg);
      return;
    }
    if (!res.body) {
      h.onError?.('浏览器不支持流式响应');
      return;
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    /*
     * 服务端一定会以 done 或 error 收尾。
     * 两个都没等到就说明连接被中途掐断了——以前这里什么也不做，
     * 界面会一直停在「正在回答」的转圈上，用户既看不到出处也不知道出了什么事。
     * 现在补一句明确的提示。
     */
    let settled = false;
    const done = (payload: any) => {
      settled = true;
      h.onDone?.(payload);
    };
    const fail = (msg: string) => {
      settled = true;
      h.onError?.(msg);
    };
    try {
      while (true) {
        const { done: ended, value } = await reader.read();
        if (ended) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of block.split('\n')) {
            if (!line.startsWith('data:')) continue;
            let evt: any;
            try {
              evt = JSON.parse(line.slice(5).trim());
            } catch {
              continue;
            }
            if (evt.type === 'delta') h.onDelta?.(evt.text);
            else if (evt.type === 'done')
              done({ answer: evt.answer, refs: evt.refs || [], entries: evt.entries || [], meta: evt.meta });
            else if (evt.type === 'error') fail(evt.error || 'AI 服务出错');
          }
        }
      }
      if (!settled && !controller.signal.aborted) fail('连接中断了，回答可能不完整，可以再问一次');
    } catch (e: any) {
      if (e?.name !== 'AbortError') fail('响应中断，请重试');
    }
  })();

  return () => controller.abort();
}
