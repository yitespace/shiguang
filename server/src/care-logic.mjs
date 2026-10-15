// =============================================================
// 拾光 · 关怀模块的纯计算
//
// 这里只放没有 IO、没有全局状态的函数：算下一次该吃什么药、
// 提醒到底该在什么时候响、学习模式此刻该不该锁。
//
// 为什么单独拆一个文件、而不是直接写进 care.mjs 或 index.mjs：
//   1) 这些是最容易算错的地方（跨零点、跨天、提前量、疗程区间），
//      拆出来才能被测试直接 import 着一个一个压。
//   2) 安卓那边跑不了自动化测试（没有模拟器），所以约定：
//      **一切判断都在 JS 里算完，Java 只做系统胶水**。
//      Java 拿到的是「从现在到 X 点，锁住这几个包」这种结果，不做推理。
// =============================================================

const HOUR_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 是不是 "HH:MM" */
export function isHHMM(s) {
  return HOUR_RE.test(String(s || ''));
}

/** "HH:MM" → 当天第几分钟 */
export function hhmmToMin(s) {
  const m = HOUR_RE.exec(String(s || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 当天第几分钟 → "HH:MM" */
export function minToHhmm(n) {
  const v = ((Math.round(n) % 1440) + 1440) % 1440;
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
}

/** 本地日期 "YYYY-MM-DD" */
export function dateStr(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** "YYYY-MM-DD" + "HH:MM" → 本地时间戳 */
export function atLocal(ds, hhmm) {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ds || ''));
  const hm = HOUR_RE.exec(String(hhmm || ''));
  if (!dm || !hm) return null;
  return new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), Number(hm[1]), Number(hm[2]), 0, 0).getTime();
}

/**
 * "YYYY-MM-DDTHH:MM" → 本地时间戳。
 * 刻意不用 Date.parse：那个遇到不带时区的字符串在不同引擎上行为不一致
 * （有的当 UTC，有的当本地），算提醒时间差一小时就是这么来的。
 */
export function parseLocalISO(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(s || ''));
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0).getTime();
}

/** 时间戳 → 本地 "YYYY-MM-DDTHH:MM"（提醒用这个格式存，直观且不带时区歧义） */
export function toLocalISO(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function addDays(ds, n) {
  const t = atLocal(ds, '12:00');
  if (t == null) return ds;
  const d = new Date(t);
  d.setDate(d.getDate() + n);
  return dateStr(d);
}

// ---------------------------------------------------------------
// 吃药
// ---------------------------------------------------------------

/**
 * 这种药在某一天要吃哪几次。
 * 三层过滤：药本身停用了、星期几不对、不在疗程区间内。
 */
export function medSlotsOn(med, ds) {
  if (!med || med.enabled === false) return [];
  if (med.startDate && ds < med.startDate) return [];
  if (med.endDate && ds > med.endDate) return [];

  const days = med.days;
  if (Array.isArray(days) && days.length && days.length < 7) {
    const noon = atLocal(ds, '12:00');
    if (noon != null && !days.includes(new Date(noon).getDay())) return [];
  }
  const slots = Array.isArray(med.slots) ? med.slots : [];
  const at = slots.map((s) => (typeof s === 'string' ? s : s && s.at)).filter(isHHMM);
  // 同一种药早上晚上各一次很常见，去重后按时间排
  return [...new Set(at)].sort();
}

/** slot 的展示名："08:00" → "早上"（没配就返回空串） */
export function slotLabel(med, at) {
  const slots = Array.isArray(med?.slots) ? med.slots : [];
  const hit = slots.find((s) => s && typeof s === 'object' && s.at === at);
  return hit?.label ? String(hit.label) : '';
}

/**
 * 这个时间点吃多少。
 * 优先用时间点自己的剂量（早上一片、晚上半片），没写就退回这种药的整体剂量。
 */
export function slotDose(med, at) {
  const slots = Array.isArray(med?.slots) ? med.slots : [];
  const hit = slots.find((s) => s && typeof s === 'object' && s.at === at);
  return (hit?.dose ? String(hit.dose) : '') || String(med?.dose || '');
}

/** 服药流水的 id：一种药一天一次，用 medId@HH:MM 做键 */
export function doseKey(medId, at) {
  return `${medId}@${at}`;
}

/**
 * 把 append-only 的服药流水折成「某天每个 slot 的最终状态」。
 * 后写的覆盖先写的，所以撤销就是再追加一条 action='undo'。
 */
export function doseState(doseLog, ds) {
  const out = new Map();
  for (const rec of doseLog || []) {
    if (!rec || rec.date !== ds) continue;
    const key = doseKey(rec.medId, rec.at);
    if (rec.action === 'undo') out.delete(key);
    else out.set(key, rec);
  }
  return out;
}

/**
 * 某一天的完整服药计划（按时间排好）。
 * status: taken 已吃 / skipped 跳过 / pending 还没到点也没打卡
 * overdue：到点超过一小时的还没打卡 —— 界面上要标红，但不算「错过」，
 *          抑郁患者本来就容易漏，用「错过」这种词只会让人更不想打开。
 */
export function todayPlan(meds, doseLog, ds, now = Date.now(), graceMin = 60) {
  const state = doseState(doseLog, ds);
  const plan = [];
  for (const med of meds || []) {
    for (const at of medSlotsOn(med, ds)) {
      const dueAt = atLocal(ds, at);
      const rec = state.get(doseKey(med.id, at));
      plan.push({
        medId: med.id,
        name: med.name || '',
        dose: slotDose(med, at),
        note: med.note || '',
        label: slotLabel(med, at),
        at,
        dueAt,
        alarm: !!med.alarm,
        prn: !!med.prn,
        status: rec ? rec.action : 'pending',
        takenAt: rec && rec.action === 'taken' ? rec.at || rec.ts : null,
        overdue: !rec && dueAt != null && now > dueAt + graceMin * 60000,
      });
    }
  }
  return plan.sort((a, b) => a.dueAt - b.dueAt || a.name.localeCompare(b.name));
}

/**
 * 今天还没处理的次数（首页浮卡、关怀区块都用它）。
 *
 * 「必要时服用」的药不算在内：那种药没有「欠着」一说，
 * 把它算进去会让首页一直挂着一句「还有 1 次药没吃」，
 * 而用户按医嘱本来就不该天天吃。催一个按需吃的苯二氮䓬是有害的。
 */
export function pendingCount(plan) {
  return (plan || []).filter((x) => x.status === 'pending' && !x.prn).length;
}

/** 过点没吃的次数，同样不算按需服用的 */
export function overdueCount(plan) {
  return (plan || []).filter((x) => x.overdue && !x.prn).length;
}

/**
 * 下一次该吃药的时间戳。
 * 今天的都吃完了就往后找，最多看 14 天（再远说明方案本身有问题）。
 *
 * 「必要时服用」的药不算 —— 首页那句「下一次 22:00 · 某某药」
 * 会被读成「晚上十点该吃一次」，而按需吃的药本来就不该有钟点。
 * 第一版漏了这个过滤，首页就真的把阿普唑仑写成了下一次。
 */
export function nextDoseAt(meds, doseLog, now = Date.now(), lookaheadDays = 14) {
  const today = dateStr(new Date(now));
  for (let i = 0; i < lookaheadDays; i++) {
    const ds = addDays(today, i);
    const plan = todayPlan(meds, doseLog, ds, now);
    const next = plan.find((x) => x.status === 'pending' && !x.prn && x.dueAt != null && x.dueAt > now);
    if (next) return { at: next.dueAt, date: ds, slot: next.at, med: next };
  }
  return null;
}

// ---------------------------------------------------------------
// 提醒
// ---------------------------------------------------------------

export const MAX_ADVANCE_MIN = 24 * 60;

/**
 * 提醒实际该响的时间。
 * 提前量夹在 0..1440 分钟之间：模型偶尔会吐出 -10 或者 99999，
 * 直接拿去排闹钟会排出很离谱的时间。
 */
export function reminderFireAt(r) {
  const at = parseLocalISO(r?.at);
  if (at == null) return null;
  const raw = Number(r.advance);
  const adv = Number.isFinite(raw) ? Math.max(0, Math.min(MAX_ADVANCE_MIN, Math.round(raw))) : 0;
  return at - adv * 60000;
}

/** 未来的提醒，按「该响的时间」排好 */
export function upcomingReminders(reminders, now = Date.now()) {
  return (reminders || [])
    .filter((r) => !r.done)
    .map((r) => ({ ...r, fireAt: reminderFireAt(r) }))
    .filter((r) => r.fireAt != null && r.fireAt > now)
    .sort((a, b) => a.fireAt - b.fireAt);
}

// ---------------------------------------------------------------
// 学习模式
// ---------------------------------------------------------------

/**
 * 这条规则在 now 这一刻生效吗。
 * 支持跨零点（22:30 → 01:00），这类「睡前别刷手机」的诉求很常见。
 */
function withinBlock(b, now) {
  if (!b || b.enabled === false) return false;
  const d = new Date(now);
  if (Array.isArray(b.days) && b.days.length && b.days.length < 7 && !b.days.includes(d.getDay())) return false;
  const from = hhmmToMin(b.from);
  const to = hhmmToMin(b.to);
  if (from == null || to == null || from === to) return false; // 起止相同是坏规则，不能让它锁一整天
  const mins = d.getHours() * 60 + d.getMinutes();
  return from < to ? mins >= from && mins < to : mins >= from || mins < to;
}

/** 现在这一刻该不该锁，锁的话是哪条规则 */
export function activeBlock(blocks, now = Date.now()) {
  for (const b of blocks || []) if (withinBlock(b, now)) return b;
  return null;
}

/** 这一刻真正要挡住的包（先取规则里的，再扣掉全局白名单） */
export function blockedPackages(blocks, now = Date.now(), alwaysAllow = []) {
  const b = activeBlock(blocks, now);
  if (!b) return { block: null, packages: [] };
  const allow = new Set((alwaysAllow || []).map(String));
  const packages = [...new Set((b.packages || []).map(String))].filter((p) => p && !allow.has(p));
  return { block: b, packages };
}

/** 下一条规则什么时候开始（界面上显示「下一次 20:00 开始」） */
export function nextBlockStart(blocks, now = Date.now(), lookaheadDays = 7) {
  const d = new Date(now);
  const mins = d.getHours() * 60 + d.getMinutes();
  for (let i = 0; i < lookaheadDays; i++) {
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i);
    const dow = day.getDay();
    let best = null;
    for (const b of blocks || []) {
      if (!b || b.enabled === false) continue;
      if (Array.isArray(b.days) && b.days.length && b.days.length < 7 && !b.days.includes(dow)) continue;
      const from = hhmmToMin(b.from);
      if (from == null) continue;
      if (i === 0 && from <= mins) continue;
      if (!best || from < best.min) best = { min: from, block: b };
    }
    if (best) return { at: new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(best.min / 60), best.min % 60).getTime(), block: best.block };
  }
  return null;
}

/**
 * 一条规则现在还剩多少分钟。
 * 只在规则**正在生效**时有意义，不在时段内一律返回 0 ——
 * 否则「晚上 8 点开始」这条规则在中午问它会答「还剩 10 小时」，
 * 界面上就会显示成「专注中还剩 10 小时」，很吓人。
 * 跨零点的时候，「到 01:00」在 23:00 这一刻是还剩 120 分钟，不是负数。
 */
export function blockRemainingMin(block, now = Date.now()) {
  if (!withinBlock(block, now)) return 0;
  const d = new Date(now);
  const mins = d.getHours() * 60 + d.getMinutes();
  const from = hhmmToMin(block.from);
  const to = hhmmToMin(block.to);
  if (from < to) return Math.max(0, to - mins);
  // 跨零点
  return mins >= from ? 1440 - mins + to : Math.max(0, to - mins);
}

/** 把分钟的剩余量写成「1 小时 20 分」 */
export function humanMinutes(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} 小时 ${rest} 分` : `${h} 小时`;
}

/**
 * 把学习模式的规则展开成一段段**具体的起止时刻**，交给安卓那边的
 * 无障碍服务去查。
 *
 * 为什么不在 Java 里判断「现在该不该锁」：那意味着「星期几、跨零点、
 * 白名单」这套逻辑要在 Java 里再写一遍，而这份代码没法自动化测试
 * （开发机上连模拟器都起不来）。展开成 [[起, 止, 包名...]] 之后，
 * Java 那边只剩一个时间戳比较和一次字符串包含，没有任何推理。
 *
 * @param {Array} blocks 规则
 * @param {{days?:number, now?:number, alwaysAllow?:string[]}} opts
 */
export function buildFocusIntervals(blocks, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const days = Math.max(1, Math.min(30, Math.round(Number(opts.days) || 7)));
  const allow = new Set((opts.alwaysAllow || []).map(String));
  const out = [];
  const today = dateStr(new Date(now));

  for (let i = 0; i < days; i++) {
    const ds = addDays(today, i);
    const dow = new Date(atLocal(ds, '12:00')).getDay();
    for (const b of blocks || []) {
      if (!b || b.enabled === false) continue;
      if (Array.isArray(b.days) && b.days.length && b.days.length < 7 && !b.days.includes(dow)) continue;
      const from = hhmmToMin(b.from);
      const to = hhmmToMin(b.to);
      if (from == null || to == null || from === to) continue;
      const packages = [...new Set((b.packages || []).map(String))].filter((p) => p && !allow.has(p));
      if (!packages.length) continue;

      const start = atLocal(ds, b.from);
      // 跨零点：结束时刻落在第二天
      const end = from < to ? atLocal(ds, b.to) : atLocal(addDays(ds, 1), b.to);
      if (end == null || end <= now) continue; // 已经过去的不用给
      out.push({
        from: Math.max(start, now),
        to: end,
        label: String(b.label || '专注').slice(0, 20),
        packages,
      });
    }
  }
  return out.sort((x, y) => x.from - y.from).slice(0, 200);
}

// ---------------------------------------------------------------
// 时间表：交给客户端去排本地通知
// ---------------------------------------------------------------

export const MAX_SCHEDULE = 240;

/**
 * 未来一段时间里所有该响的提醒，排好序。
 *
 * 为什么由服务端算：安卓那边的通知排程是纯系统胶水（Java），
 * 如果让它自己推「下一次是哪天几点」，跨零点、疗程区间、星期几这些
 * 判断就得在 Java 里再写一遍——那份代码没法自动化测试（这台机器上
 * 连模拟器都起不来）。所以统一在这里算完，客户端拿到的是
 * 「几点几分、弹什么字、要不要响铃」，照着排就行。
 *
 * @param {{meds:Array, doses:Array, reminders:Array}} data
 * @param {{days?:number, now?:number}} opts
 */
export function buildSchedule(data, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const days = Math.max(1, Math.min(30, Math.round(Number(opts.days) || 7)));
  const out = [];
  const today = dateStr(new Date(now));

  for (let i = 0; i < days; i++) {
    const ds = addDays(today, i);
    const plan = todayPlan(data.meds, data.doses, ds, now);
    for (const item of plan) {
      if (item.status !== 'pending' || item.dueAt == null || item.dueAt <= now) continue;
      // 「必要时服用」的药不排提醒，见 care.mjs 里 prn 的说明
      if (item.prn) continue;
      out.push({
        kind: 'med',
        // 同一种药每天同一时间点各是一条，id 要能唯一标识「哪一次」
        id: `med:${item.medId}:${ds}:${item.at}`,
        refId: item.medId,
        at: item.dueAt,
        alarm: !!item.alarm,
        title: item.label ? `${item.label}的药` : '该吃药了',
        body: `${item.name}${item.dose ? ` · ${item.dose}` : ''}`,
        date: ds,
        slot: item.at,
      });
    }
  }

  for (const r of data.reminders || []) {
    if (!r || r.done) continue;
    const fireAt = reminderFireAt(r);
    if (fireAt == null || fireAt <= now) continue;
    out.push({
      kind: 'reminder',
      id: `rem:${r.id}`,
      refId: r.id,
      at: fireAt,
      alarm: !!r.alarm,
      title: r.advance > 0 ? `${r.title}（还有 ${r.advance} 分钟）` : r.title,
      body: r.advance > 0 ? `定在 ${String(r.at).replace('T', ' ')}` : r.quote || '',
    });
  }

  return out.sort((a, b) => a.at - b.at).slice(0, MAX_SCHEDULE);
}

