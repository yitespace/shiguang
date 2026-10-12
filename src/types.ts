// =============================================================
// 拾光 · 类型定义
// =============================================================

/** 一条语音记录附件 */
export interface AudioAttachment {
  id: string;
  kind?: string;
  /** 浏览器端可直接播放的地址（相对路径） */
  url?: string;
  mime?: string;
  bytes?: number;
  durationMs: number;
  /** 语音转写的原始文字 */
  transcript?: string;
  /** AI 从口语里提炼的要点 */
  points: string[];
}

export interface Entry {
  id: string;
  createdAt: number;
  updatedAt: number;
  /** 归属日期 YYYY-MM-DD（本地时区） */
  date: string;
  mood: number | null;
  tags: string[];
  title: string;
  content: string;
  kind: string;
  attachments?: AudioAttachment[];
  deleted: boolean;
  /** 仅存在于本地：尚未同步到服务器 */
  _pending?: boolean;
}

export interface Hit {
  entry: Entry;
  score: number;
  snippet: string;
}

export interface TimeRange {
  from: string;
  to: string;
  label: string;
  spanDays: number;
}

export interface AiMeta {
  range: TimeRange | null;
  keywords: string;
  usedEntries?: number;
  scanned?: number;
  usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
}

export interface Stats {
  total: number;
  days: number;
  chars: number;
  streak: number;
  firstDate: string | null;
  lastDate: string | null;
  heat: { date: string; count: number }[];
  tags: { name: string; count: number }[];
}

export interface DaySummary {
  date: string;
  summary: string;
  count?: number;
  at?: number;
  stamp?: number;
  cached?: boolean;
  empty?: boolean;
}

/** 那年今日：往年的同一天 */
export interface MemoryGroup {
  yearsAgo: number;
  date: string;
  entries: Entry[];
}

export interface MemoryResult {
  date: string;
  groups: MemoryGroup[];
  count: number;
}

export interface AsrInfo {
  enabled: boolean;
  provider: string | null;
  label: string | null;
  model: string | null;
}

export interface AuthStatus {
  authed: boolean;
  /** 当前登录的人（没登录时是 null） */
  me: {
    id: string;
    phone: string;
    phoneMasked: string;
    nickname: string;
    role: string;
    createdAt: number;
  } | null;
  ai: boolean;
  asr?: AsrInfo;
  model: string;
  cookiePath?: string;
  /** 注册开没开、能不能用 */
  register?: { open: boolean; sms: boolean; reason: string | null };
}

/** AI 从一段口语里整理出的结构化结果 */
export interface VoiceExtract {
  cleaned: string;
  points: string[];
  mood: number | null;
  tags: string[];
  title: string;
  model?: string;
}

export type Mood = 1 | 2 | 3 | 4 | 5;

export const MOODS: { v: Mood; emoji: string; label: string; color: string }[] = [
  { v: 1, emoji: '😞', label: '很差', color: '#8b8bd6' },
  { v: 2, emoji: '😕', label: '低落', color: '#7fa8e0' },
  { v: 3, emoji: '😐', label: '一般', color: '#9aa0a6' },
  { v: 4, emoji: '🙂', label: '不错', color: '#5fc9a8' },
  { v: 5, emoji: '😄', label: '很好', color: '#f5a524' },
];

export function moodOf(v: number | null | undefined) {
  if (v == null) return null;
  return MOODS.find((m) => m.v === v) || null;
}
