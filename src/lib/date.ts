// =============================================================
// 拾光 · 日期工具
// =============================================================

export const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];

const pad = (n: number) => String(n).padStart(2, '0');

/** YYYY-MM-DD（本地时区） */
export function ymd(d: Date | number = new Date()): string {
  const dt = typeof d === 'number' ? new Date(d) : d;
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

export function today(): string {
  return ymd(new Date());
}

export function parseYmd(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function addDays(s: string, n: number): string {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

export function weekdayOf(s: string): string {
  return WEEK_CN[parseYmd(s).getDay()];
}

/** 相对今天的说法：今天 / 昨天 / 3 天前 */
export function relativeDay(s: string): string {
  const diff = Math.round((parseYmd(today()).getTime() - parseYmd(s).getTime()) / 86400000);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff === 2) return '前天';
  if (diff === -1) return '明天';
  if (diff > 2 && diff < 30) return `${diff} 天前`;
  if (diff < 0 && diff > -30) return `${-diff} 天后`;
  return '';
}

/** 完整中文日期：2026年9月24日 星期四 */
export function fullDate(s: string): string {
  const d = parseYmd(s);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${WEEK_CN[d.getDay()]}`;
}

/** 简短：9月24日 */
export function shortDate(s: string): string {
  const d = parseYmd(s);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** HH:MM */
export function hhmm(ts: number | string): string {
  const d = typeof ts === 'number' ? new Date(ts) : parseYmd(ts.slice(0, 10));
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 根据当前时间给个问候 */
export function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return '夜深了';
  if (h < 11) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  if (h < 23) return '晚上好';
  return '夜深了';
}

/** 月份：YYYY-MM */
export function monthOf(s: string): string {
  return s.slice(0, 7);
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return `${y} 年 ${m} 月`;
}

/** 生成日历网格（周一开头），空位用 '' 占位 */
export function calendarGrid(month: string): string[] {
  const [y, m] = month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const daysInMonth = new Date(y, m, 0).getDate();
  const lead = (first.getDay() + 6) % 7; // 周一 = 0
  const cells: string[] = [];
  for (let i = 0; i < lead; i++) cells.push('');
  for (let d = 1; d <= daysInMonth; d++) cells.push(`${month}-${pad(d)}`);
  while (cells.length % 7 !== 0) cells.push('');
  return cells;
}

/** 某月有多少天 */
export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}
