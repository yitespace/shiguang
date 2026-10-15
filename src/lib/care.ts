// =============================================================
// 拾光 · 关怀模块的接口
// 吃药提醒 / 快捷提醒 / 学习模式，三个都走 /api/care/*
//
// 这里只做类型和请求，**不做时间计算**：
// 「下一次该吃什么药」「提醒几点响」「现在该不该锁应用」全在服务端算好
// （见 server/src/care-logic.mjs）。客户端算一遍、服务端算一遍，
// 早晚会出现两边不一致的情况，而且安卓那边的 Java 更没法测。
// =============================================================

import { request } from './api';

export interface MedSlot {
  at: string;
  label?: string;
  dose?: string;
}

export interface Med {
  id: string;
  name: string;
  dose: string;
  note: string;
  slots: MedSlot[];
  /** 需要限定星期几时的子集，0=周日。空数组表示每天 */
  days: number[];
  startDate: string;
  endDate: string;
  /** true = 到点用全屏闹钟（响铃+震动，必须手动关） */
  alarm: boolean;
  /** true = 「必要时服用」，只进清单、不排定时提醒 */
  prn: boolean;
  enabled: boolean;
  source: 'manual' | 'text' | 'voice' | 'photo';
  imageId: string;
  createdAt: number;
  updatedAt: number;
}

export interface PlanItem {
  medId: string;
  name: string;
  dose: string;
  note: string;
  label: string;
  at: string;
  dueAt: number;
  alarm: boolean;
  prn: boolean;
  status: 'pending' | 'taken' | 'skipped';
  takenAt: number | null;
  overdue: boolean;
}

export interface CareToday {
  date: string;
  meds: {
    plan: PlanItem[];
    pending: number;
    overdue: number;
    next: { at: number; date: string; slot: string; name: string; dose: string } | null;
  };
  reminders: { id: string; title: string; at: string; fireAt: number; advance: number }[];
  focus: {
    blocking: boolean;
    label: string;
    packages: number;
    remaining: number;
    next: { at: number; label: string } | null;
  };
}

export interface Reminder {
  id: string;
  title: string;
  /** 本地时间，形如 2026-10-14T22:00 */
  at: string;
  /** 提前多少分钟提醒 */
  advance: number;
  alarm: boolean;
  done: boolean;
  source: 'manual' | 'note';
  entryId: string;
  quote: string;
  createdAt: number;
  updatedAt: number;
}

export interface FocusBlock {
  id: string;
  label: string;
  from: string;
  to: string;
  days: number[];
  packages: string[];
  enabled: boolean;
}

export interface FocusSettings {
  version: number;
  blocks: FocusBlock[];
  alwaysAllow: string[];
  updatedAt: number;
}

export interface ScheduleItem {
  kind: 'med' | 'reminder';
  id: string;
  refId: string;
  at: number;
  alarm: boolean;
  title: string;
  body: string;
  date?: string;
  slot?: string;
}

export interface FocusInfo {
  focus: FocusSettings;
  now: { blocking: boolean; block: FocusBlock | null; packages: string[]; remaining: number };
  next: { at: number; label: string } | null;
  stats: { sessions: number; minutes: number; todayMinutes: number; week: number };
}

// ---------- 首页浮卡 ----------
export const careToday = (today?: string) =>
  request<CareToday>(`/care/today${today ? `?today=${encodeURIComponent(today)}` : ''}`);

// ---------- 吃药 ----------
export const listMeds = () => request<{ meds: Med[]; today: PlanItem[] }>('/care/meds');

export const saveMed = (med: Partial<Med>) =>
  request<{ med: Med; today: PlanItem[] }>('/care/meds', { method: 'POST', body: JSON.stringify(med) });

export const removeMed = (id: string) =>
  request<{ removed: string }>(`/care/meds/${id}`, { method: 'DELETE' });

export const logDose = (medId: string, payload: { at: string; date?: string; action: 'taken' | 'skipped' | 'undo' }) =>
  request<{ record: unknown; today: PlanItem[] }>(`/care/meds/${medId}/dose`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

export interface ParsedMed {
  name: string;
  dose: string;
  prn: boolean;
  slots: MedSlot[];
  note: string;
  days: number[];
  startDate: string;
  endDate: string;
}

export interface ParseResult {
  meds: ParsedMed[];
  unclear: string[];
  summary: string;
  images: { id: string; ext: string; bytes: number; mime: string }[];
}

/** 解析医嘱。文字、语音转写文本、图片混着传都行。结果只是草稿，要用户确认 */
export const parseMeds = (payload: { text?: string; images?: { mime: string; data: string }[]; today?: string }) =>
  request<ParseResult>('/care/meds/parse', { method: 'POST', body: JSON.stringify(payload) });

export const careImageUrl = (id: string) => {
  const m = location.pathname.match(/^(.*\/shiguang)\//);
  const base = m ? m[1] : '';
  return `${base}/api/care/images/${encodeURIComponent(id)}`;
};

// ---------- 快捷提醒 ----------
export const listReminders = () =>
  request<{ reminders: Reminder[]; upcoming: (Reminder & { fireAt: number })[]; past: Reminder[] }>('/care/reminders');

export const saveReminder = (r: Partial<Reminder>) =>
  request<{ reminder: Reminder }>('/care/reminders', { method: 'POST', body: JSON.stringify(r) });

export const removeReminder = (id: string) =>
  request<{ removed: string }>(`/care/reminders/${id}`, { method: 'DELETE' });

export interface DetectedReminder {
  found: boolean;
  title?: string;
  at?: string;
  advance?: number;
  quote?: string;
  skipped?: 'asked';
}

/**
 * 看看刚写的记录里有没有「到点要做的事」。
 * 保存完之后单独调，不挡保存 —— 记录是最高频的操作，不能被一次 AI 调用拖慢。
 */
export const detectReminder = (text: string, entryId?: string, today?: string) =>
  request<DetectedReminder>('/care/reminders/detect', {
    method: 'POST',
    body: JSON.stringify({ text, entryId, today }),
  });

// ---------- 学习模式 ----------
export const getFocus = () => request<FocusInfo>('/care/focus');

export const saveFocus = (focus: { blocks?: FocusBlock[]; alwaysAllow?: string[] }) =>
  request<{ focus: FocusSettings }>('/care/focus', { method: 'PUT', body: JSON.stringify(focus) });

export const logFocus = (payload: { minutes: number; blockId?: string; label?: string; ended?: 'done' | 'giveup' }) =>
  request<{ record: { id: string; minutes: number } }>('/care/focus/log', { method: 'POST', body: JSON.stringify(payload) });

// ---------- 时间表：客户端照着排本地通知 ----------
export const getSchedule = (days = 7) =>
  request<{
    generatedAt: number;
    schedule: ScheduleItem[];
    /** 展开好的锁定时段，直接交给安卓的无障碍服务，不用再解释规则 */
    focusIntervals: { from: number; to: number; label: string; packages: string[] }[];
    focus: {
      blocking: boolean;
      label: string;
      packages: string[];
      remaining: number;
      next: { at: number; label: string } | null;
    };
  }>(`/care/schedule?days=${days}`);
