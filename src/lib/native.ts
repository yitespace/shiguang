// =============================================================
// 拾光 · 原生能力桥
//
// 网页版和安卓 App 用的是同一套前端代码，差异全收在这个文件里：
//
//   通知/闹钟   App 里有原生插件就用它（能后台响、能全屏闹钟）；
//                网页版退化成 Notification API + 页面开着时的定时器。
//   应用锁      只有 App 里有；网页版连想都不要想，浏览器没有任何
//                权限去阻止你打开别的应用。所以 isFocusSupported() 会是 false，
//                界面上如实说明，而不是画一个点了没反应的开关。
//
// 原则：**能力不足时要如实降级并说清楚**，不要装作能用。
// 一个点了没反应的提醒开关，比明说「网页版做不到」糟糕得多。
// =============================================================

import { isNativeShell } from './api';
import type { ScheduleItem } from './care';

/** Capacitor 的原生插件挂在 window.Capacitor.Plugins 上 */
interface CapacitorGlobal {
  Plugins?: Record<string, any>;
  getPlatform?: () => string;
}

function cap(): CapacitorGlobal | null {
  const c = (globalThis as any).Capacitor as CapacitorGlobal | undefined;
  return c && typeof c === 'object' ? c : null;
}

function plugin(name: string): any {
  return cap()?.Plugins?.[name] || null;
}

/** 当前跑在安卓 App 里吗 */
export function isApp(): boolean {
  if (!isNativeShell()) return false;
  return !!cap()?.getPlatform && cap()!.getPlatform!() === 'android';
}

// ---------------------------------------------------------------
// 通知与闹钟
// ---------------------------------------------------------------

export type NotifyPermission = 'granted' | 'denied' | 'prompt' | 'unsupported';

/** 提醒能力现在处于什么状态，界面上要如实显示 */
export interface NotifyStatus {
  /** 能不能真的在后台弹出提醒 */
  background: boolean;
  permission: NotifyPermission;
  /** 精确闹钟权限（安卓 12+ 要单独授权，否则提醒会晚几分钟到几十分钟） */
  exactAlarm: boolean;
  /** 全屏闹钟权限（安卓 14+ 才需要，没有就退化成普通通知） */
  fullScreen: boolean;
  /** 一句话说明当前能力，直接显示给用户 */
  note: string;
}

const ShiguangNotify = () => plugin('ShiguangNotify');

export async function notifyStatus(): Promise<NotifyStatus> {
  const p = ShiguangNotify();
  if (p?.status) {
    try {
      const r = await p.status();
      return {
        background: true,
        permission: r.permission || 'prompt',
        exactAlarm: r.exactAlarm !== false,
        fullScreen: r.fullScreen !== false,
        note: r.note || '',
      };
    } catch {
      /* 掉到下面按网页版处理 */
    }
  }
  if (typeof Notification === 'undefined') {
    return { background: false, permission: 'unsupported', exactAlarm: false, fullScreen: false, note: '这个浏览器不支持通知' };
  }
  const permission = Notification.permission as NotifyPermission;
  return {
    background: false,
    permission,
    exactAlarm: false,
    fullScreen: false,
    note:
      permission === 'granted'
        ? '网页版只能在页面开着的时候提醒你。想让它关掉页面也能响，装上安卓 App。'
        : '网页版需要你允许通知，而且只在页面开着时有效。',
  };
}

/** 申请通知权限 */
export async function requestNotifyPermission(): Promise<NotifyPermission> {
  const p = ShiguangNotify();
  if (p?.requestPermission) {
    try {
      const r = await p.requestPermission();
      return r.permission || 'prompt';
    } catch {
      /* 继续走网页版 */
    }
  }
  if (typeof Notification === 'undefined') return 'unsupported';
  try {
    return (await Notification.requestPermission()) as NotifyPermission;
  } catch {
    return 'denied';
  }
}

/** 跳到系统的精确闹钟 / 全屏通知授权页 */
export async function openNotifySettings(which: 'exactAlarm' | 'fullScreen' | 'app' = 'app'): Promise<void> {
  const p = ShiguangNotify();
  if (p?.openSettings) {
    try {
      await p.openSettings({ which });
    } catch {
      /* 忽略：跳不过去也不该让页面炸掉 */
    }
  }
}

/**
 * 重排全部提醒。
 * 每次都整份替换，不做增量 —— 增量在「改了一条药的时间」这种场景下
 * 很容易漏掉旧的闹钟，留着就会在错误的时间响。
 */
export async function reschedule(items: ScheduleItem[]): Promise<{ ok: boolean; count: number; note?: string }> {
  const p = ShiguangNotify();
  if (p?.schedule) {
    try {
      const r = await p.schedule({
        items: items.map((x) => ({
          id: x.id,
          at: x.at,
          title: x.title,
          body: x.body,
          alarm: x.alarm,
          kind: x.kind,
        })),
      });
      return { ok: true, count: r?.count ?? items.length };
    } catch (e: any) {
      return { ok: false, count: 0, note: String(e?.message || e) };
    }
  }
  armWebTimers(items);
  return { ok: true, count: items.length, note: '仅本次页面打开期间有效' };
}

/** 取消所有提醒 */
export async function cancelAll(): Promise<void> {
  const p = ShiguangNotify();
  if (p?.cancelAll) {
    try {
      await p.cancelAll();
      return;
    } catch {
      /* 忽略 */
    }
  }
  armWebTimers([]);
}

// ---- 网页版降级：页面开着时的定时器 ----

let webTimers: number[] = [];

function armWebTimers(items: ScheduleItem[]) {
  for (const t of webTimers) clearTimeout(t);
  webTimers = [];
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const now = Date.now();
  for (const it of items) {
    const delay = it.at - now;
    // setTimeout 的上限是 24.8 天，而且页面关掉就没了，只排最近的
    if (delay <= 0 || delay > 6 * 3600 * 1000) continue;
    webTimers.push(
      window.setTimeout(() => {
        try {
          new Notification(it.title, { body: it.body, tag: it.id, icon: './icon-192.png' });
        } catch {
          /* 有些浏览器在非安全上下文里会直接抛错 */
        }
      }, delay),
    );
  }
}

// ---------------------------------------------------------------
// 学习模式：应用锁
// ---------------------------------------------------------------

export interface InstalledApp {
  package: string;
  label: string;
  system: boolean;
}

export interface FocusStatus {
  /** 这台设备到底能不能锁应用 */
  supported: boolean;
  /** 无障碍服务开了没 */
  enabled: boolean;
  note: string;
}

const ShiguangFocus = () => plugin('ShiguangFocus');

/**
 * 网页版永远返回 supported:false。
 * 浏览器里没有任何 API 能阻止用户切到别的应用 —— 与其做一个假的开关，
 * 不如直接告诉用户「这件事只有装上 App 才做得到」。
 */
export async function focusStatus(): Promise<FocusStatus> {
  const p = ShiguangFocus();
  if (!p?.status) {
    return {
      supported: false,
      enabled: false,
      note: isApp() ? '这个版本的 App 还不支持应用锁，请更新到最新版' : '锁应用只有安卓 App 做得到。浏览器没有权限拦住你打开别的应用。',
    };
  }
  try {
    const r = await p.status();
    return { supported: true, enabled: !!r.enabled, note: r.note || '' };
  } catch (e: any) {
    return { supported: false, enabled: false, note: String(e?.message || e) };
  }
}

/** 跳到系统的无障碍设置页，让用户手动把拾光打开 */
export async function openAccessibilitySettings(): Promise<void> {
  const p = ShiguangFocus();
  if (p?.openSettings) {
    try {
      await p.openSettings();
    } catch {
      /* 忽略 */
    }
  }
}

/** 列出可以锁的应用（已排除系统应用，锁了也没意义还容易出事） */
export async function listInstalledApps(): Promise<InstalledApp[]> {
  const p = ShiguangFocus();
  if (!p?.listApps) return [];
  try {
    const r = await p.listApps();
    return Array.isArray(r?.apps) ? r.apps : [];
  } catch {
    return [];
  }
}

/** 一个已经展开好的锁定时段：从 from 到 to 这段时间，packages 里的应用打不开 */
export interface FocusInterval {
  from: number;
  to: number;
  label: string;
  packages: string[];
}

/**
 * 把「这段时间锁这些应用」同步给无障碍服务。
 *
 * 传的是**展开好的具体时刻**，不是规则本身。
 * 服务在后台跑，拿不到 JS；如果让它自己解释「周三、跨零点、白名单」，
 * 那套逻辑就得在 Java 里再写一遍，而 Java 那份在这台机器上没法测。
 * 展开之后它只剩一个时间戳比较和一次字符串包含。
 */
export async function syncFocus(payload: { intervals: FocusInterval[] }): Promise<{ ok: boolean; note?: string }> {
  const p = ShiguangFocus();
  if (!p?.sync) return { ok: false, note: '当前环境不支持' };
  try {
    await p.sync(payload);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, note: String(e?.message || e) };
  }
}

// ---------------------------------------------------------------
// 统一刷新：任何一处改了药/提醒/专注，都调它一次
// ---------------------------------------------------------------

/**
 * 重新拉时间表并重排本地提醒。
 * 提醒页、吃药页、学习模式页改动之后都该调一次，否则改了时间但闹钟
 * 还是旧的，那比没有提醒更糟 —— 用户会以为设好了。
 */
export async function refreshSchedule(
  fetchSchedule: (days?: number) => Promise<{ schedule: ScheduleItem[]; focusIntervals?: FocusInterval[] }>,
  days = 7,
): Promise<{ schedule: number; focusSynced: boolean; note?: string }> {
  const data = await fetchSchedule(days);
  const r = await reschedule(data.schedule || []);

  // 学习模式：把展开好的时段同步给无障碍服务
  let focusSynced = false;
  if (Array.isArray(data.focusIntervals) && ShiguangFocus()?.sync) {
    const s = await syncFocus({ intervals: data.focusIntervals });
    focusSynced = s.ok;
  }
  return { schedule: data.schedule?.length || 0, focusSynced, note: r.note };
}

/** 立刻弹一条测试通知，让用户确认「真的能收到」 */
export async function testNotify(): Promise<boolean> {
  const p = ShiguangNotify();
  if (p?.test) {
    try {
      await p.test();
      return true;
    } catch {
      return false;
    }
  }
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      new Notification('拾光', { body: '提醒长这样。', icon: './icon-192.png' });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
