// =============================================================
// 拾光 · 关怀模块自测（纯逻辑 + 存储层，不需要起服务、不花 AI 的钱）
//
// 用法：node scripts/test-care.mjs
//
// 为什么单独一个文件：这些函数决定「什么时候提醒吃药」「现在该不该锁应用」，
// 算错了后果比界面难看严重得多（漏服、或者该专注的时候没锁）。
// 拆成纯函数就是为了能在这里一个一个压边界。
// =============================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isHHMM,
  hhmmToMin,
  minToHhmm,
  dateStr,
  atLocal,
  parseLocalISO,
  toLocalISO,
  addDays,
  medSlotsOn,
  slotLabel,
  slotDose,
  doseKey,
  doseState,
  todayPlan,
  pendingCount,
  overdueCount,
  nextDoseAt,
  reminderFireAt,
  upcomingReminders,
  activeBlock,
  blockedPackages,
  nextBlockStart,
  blockRemainingMin,
  humanMinutes,
  buildSchedule,
  buildFocusIntervals,
} from '../server/src/care-logic.mjs';
import { Care } from '../server/src/care.mjs';

let pass = 0;
let failed = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name} ${extra}`);
  }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(os.tmpdir(), `shiguang-care-${Date.now()}`);

/** 造一个本地时间戳，避免测试受机器时区影响 */
const ts = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

// =============================================================
// 1. 时间小工具
// =============================================================
console.log('\n\x1b[36m拾光 · 关怀模块自测\x1b[0m\n');
console.log('  \x1b[36m· 时间解析\x1b[0m');

check('isHHMM 认合法的', isHHMM('08:00') && isHHMM('23:59') && isHHMM('00:00'));
check('isHHMM 挡掉不合法的', !isHHMM('24:00') && !isHHMM('8:00') && !isHHMM('08:60') && !isHHMM('') && !isHHMM(null));
check('hhmmToMin 换算正确', hhmmToMin('08:30') === 510 && hhmmToMin('00:00') === 0);
check('minToHhmm 会绕圈', minToHhmm(510) === '08:30' && minToHhmm(1440) === '00:00' && minToHhmm(-60) === '23:00');
check('atLocal 拼出本地时间', atLocal('2026-10-14', '08:00') === ts(2026, 10, 14, 8, 0));
check('atLocal 对坏输入返回 null', atLocal('2026-10-14', '25:00') === null && atLocal('', '08:00') === null);

/*
 * 这条很关键：提醒时间以前如果用 Date.parse("2026-10-14T22:00")，
 * 不同引擎有的当本地有的当 UTC，算出来会整整差 8 小时。
 */
check('parseLocalISO 按本地时间理解，不会差 8 小时', parseLocalISO('2026-10-14T22:00') === ts(2026, 10, 14, 22, 0));
check('parseLocalISO 也吃带空格的写法', parseLocalISO('2026-10-14 22:00') === ts(2026, 10, 14, 22, 0));
check('parseLocalISO 对垃圾返回 null', parseLocalISO('明天晚上') === null && parseLocalISO('') === null);
check('toLocalISO 和 parseLocalISO 能来回', parseLocalISO(toLocalISO(ts(2026, 10, 14, 22, 5))) === ts(2026, 10, 14, 22, 5));
check('addDays 跨月正确', addDays('2026-10-31', 1) === '2026-11-01');
check('addDays 跨年正确', addDays('2026-12-31', 1) === '2027-01-01');
check('addDays 往回跨月正确', addDays('2026-11-01', -1) === '2026-10-31');

// =============================================================
// 2. 服药计划
// =============================================================
console.log('\n  \x1b[36m· 服药计划\x1b[0m');

const medA = {
  id: 'm1',
  name: '舍曲林',
  dose: '1 片',
  slots: [{ at: '08:00', label: '早' }, { at: '20:00', label: '晚' }],
  days: [],
  enabled: true,
};

check('每天吃的药两个时间点都出来', medSlotsOn(medA, '2026-10-14').join(',') === '08:00,20:00');
check('停用的药一次都不出', medSlotsOn({ ...medA, enabled: false }, '2026-10-14').length === 0);
check('时段名能取到', slotLabel(medA, '08:00') === '早' && slotLabel(medA, '12:00') === '');

/*
 * 早上一片、晚上半片是最常见的开法。
 * 必须支持「一种药、多个时间点、各自剂量」——拆成两条药的话，
 * 用户会看到两张「舍曲林」卡片，还得自己反应过来这是同一种药。
 */
const medSplit = {
  id: 'm9',
  name: '舍曲林',
  dose: '',
  slots: [{ at: '08:00', label: '早', dose: '1 片' }, { at: '22:00', label: '睡前', dose: '半片' }],
  days: [],
  enabled: true,
};
const splitPlan = todayPlan([medSplit], [], '2026-10-14', ts(2026, 10, 14, 6, 0));
check('早晚剂量不同只算一种药', splitPlan.length === 2);
check('早上那次取的是 1 片', splitPlan[0].dose === '1 片', splitPlan[0].dose);
check('晚上那次取的是半片', splitPlan[1].dose === '半片', splitPlan[1].dose);
check('时间点没写剂量时退回整药剂量', slotDose(medA, '08:00') === '1 片');
check('时间点自己的剂量优先于整药剂量', slotDose({ ...medA, slots: [{ at: '08:00', dose: '2 片' }] }, '08:00') === '2 片');

const medWeekday = { ...medA, days: [1, 3] }; // 周一、周三
// 2026-10-14 是周三
check('限定星期的药，对的那天出得来', medSlotsOn(medWeekday, '2026-10-14').length === 2);
// 2026-10-15 是周四
check('限定星期的药，错的那天不出', medSlotsOn(medWeekday, '2026-10-15').length === 0);

const medRange = { ...medA, startDate: '2026-10-10', endDate: '2026-10-20' };
check('疗程第一天算在内（不是「大于」）', medSlotsOn(medRange, '2026-10-10').length === 2);
check('疗程最后一天算在内', medSlotsOn(medRange, '2026-10-20').length === 2);
check('疗程开始前不出', medSlotsOn(medRange, '2026-10-09').length === 0);
check('疗程结束后不出', medSlotsOn(medRange, '2026-10-21').length === 0);

check(
  '同一时间点写两遍只算一次',
  medSlotsOn({ ...medA, slots: [{ at: '08:00' }, { at: '08:00' }, '08:00'] }, '2026-10-14').join(',') === '08:00',
);
check('没写时间点的药一次都不出', medSlotsOn({ ...medA, slots: [] }, '2026-10-14').length === 0);

// ---- 打卡状态 ----
const day = '2026-10-14';
const log = [
  { medId: 'm1', at: '08:00', date: day, action: 'taken', ts: ts(2026, 10, 14, 8, 5) },
];
let state = doseState(log, day);
check('打卡记上了', state.get(doseKey('m1', '08:00'))?.action === 'taken');
check('别的天不会串进来', doseState(log, '2026-10-13').size === 0);

const logUndo = [...log, { medId: 'm1', at: '08:00', date: day, action: 'undo', ts: ts(2026, 10, 14, 9, 0) }];
check('撤销之后就当没打卡', doseState(logUndo, day).size === 0);

const logSkip = [...logUndo, { medId: 'm1', at: '08:00', date: day, action: 'skipped', ts: ts(2026, 10, 14, 9, 1) }];
check('跳过一次之后状态是 skipped', doseState(logSkip, day).get(doseKey('m1', '08:00'))?.action === 'skipped');

// ---- 今天的计划 ----
const plan = todayPlan([medA], log, day, ts(2026, 10, 14, 12, 0));
check('今天两次计划都在', plan.length === 2);
check('早上那次是已吃', plan[0].status === 'taken');
check('晚上那次还没到点', plan[1].status === 'pending');
check('没到点的不算逾期', plan[1].overdue === false);
check('还没处理的次数是 1', pendingCount(plan) === 1);

/*
 * 按需服用的药不能算进「欠着几次」。
 * 首页那张浮卡用的是这个数字，算进去就会天天挂着「还有 1 次药没吃」，
 * 而阿普唑仑这类药医嘱本来就写着「必要时服用」。
 */
const planWithPrn = todayPlan([medA, { ...medA, id: 'prn2', name: '阿普唑仑', prn: true }], [], '2026-10-14', ts(2026, 10, 14, 12, 0));
check('按需服用的药不算进「还有几次没吃」', pendingCount(planWithPrn) === 2, `实际 ${pendingCount(planWithPrn)}`);
check('按需服用的药也不算进「过点了」', overdueCount(todayPlan([{ ...medA, prn: true }], [], '2026-10-14', ts(2026, 10, 15, 1, 0))) === 0);

const planLate = todayPlan([medA], log, day, ts(2026, 10, 14, 21, 30));
check('晚上那次过了点也没打卡', planLate[1].status === 'pending');
check('超过一小时才算逾期', planLate[1].overdue === true);

const planJustLate = todayPlan([medA], [], day, ts(2026, 10, 14, 20, 30));
check('刚过点 30 分钟不算逾期（别急着吓人）', planJustLate[1].overdue === false);

// ---- 下一次该吃药 ----
const next = nextDoseAt([medA], log, ts(2026, 10, 14, 12, 0));
check('下一次吃药是今天晚上 20:00', next && next.at === ts(2026, 10, 14, 20, 0), JSON.stringify(next && next.slot));

const logAll = [
  ...log,
  { medId: 'm1', at: '20:00', date: day, action: 'taken', ts: ts(2026, 10, 14, 20, 3) },
];
const nextTomorrow = nextDoseAt([medA], logAll, ts(2026, 10, 14, 21, 0));
check('今天都吃完了就找到明天早上', nextTomorrow && nextTomorrow.at === ts(2026, 10, 15, 8, 0), JSON.stringify(nextTomorrow && nextTomorrow.date));

check('一种药都没有时返回 null', nextDoseAt([], [], ts(2026, 10, 14, 12, 0)) === null);
/*
 * 「下一次」也不能是「必要时服用」的药。
 * 首页会把它写成「下一次 22:00 · 某某药」，读起来就是「晚上十点该吃一次」——
 * 而按需吃的药没有钟点。第一版漏了这个过滤，线上截图里真的出现了。
 */
check(
  '「下一次」不会指向按需服用的药',
  nextDoseAt([{ ...medA, id: 'only-prn', name: '阿普唑仑', slots: [{ at: '22:00' }], prn: true }], [], ts(2026, 10, 14, 12, 0)) === null,
);
check(
  '有定时药时，「下一次」挑的是定时的那种',
  nextDoseAt(
    [
      { ...medA, id: 'p1', name: '按需药', slots: [{ at: '21:00' }], prn: true },
      { ...medA, id: 't1', name: '定时药', slots: [{ at: '22:00' }] },
    ],
    [],
    ts(2026, 10, 14, 12, 0),
  )?.med.name === '定时药',
);
/*
 * 疗程结束的药不该再排下一次。
 * 注意别拿「今天结束 + 今天还有个没到点的 slot」来测 —— 那种情况下
 * 23:00 那次确实还没到，排出来是对的（我一开始就把用例写错了）。
 * 要测的是「疗程已经翻篇了」。
 */
check(
  '疗程昨天就结束的药不会再排下一次',
  nextDoseAt([{ ...medA, endDate: '2026-10-13' }], [], ts(2026, 10, 14, 12, 0)) === null,
);
check(
  '疗程最后一天里、还没到点的那次照常排',
  nextDoseAt([{ ...medA, endDate: '2026-10-14', slots: [{ at: '23:00' }] }], [], ts(2026, 10, 14, 22, 0))?.at ===
    ts(2026, 10, 14, 23, 0),
);

// =============================================================
// 3. 提醒
// =============================================================
console.log('\n  \x1b[36m· 提醒\x1b[0m');

check('没有提前量就是准点', reminderFireAt({ at: '2026-10-14T22:00', advance: 0 }) === ts(2026, 10, 14, 22, 0));
check('提前 10 分钟', reminderFireAt({ at: '2026-10-14T22:00', advance: 10 }) === ts(2026, 10, 14, 21, 50));
check('提前量是负数时按 0 处理', reminderFireAt({ at: '2026-10-14T22:00', advance: -30 }) === ts(2026, 10, 14, 22, 0));
check('提前量离谱大时夹到一天', reminderFireAt({ at: '2026-10-14T22:00', advance: 999999 }) === ts(2026, 10, 13, 22, 0));
check('提前量是 NaN 时按 0 处理', reminderFireAt({ at: '2026-10-14T22:00', advance: 'abc' }) === ts(2026, 10, 14, 22, 0));
check('时间坏掉就返回 null', reminderFireAt({ at: '晚上十点', advance: 10 }) === null);

const now = ts(2026, 10, 14, 12, 0);
const ups = upcomingReminders(
  [
    { id: 'r1', title: '开会', at: '2026-10-14T22:00', advance: 10, done: false },
    { id: 'r2', title: '已经过去', at: '2026-10-14T09:00', advance: 0, done: false },
    { id: 'r3', title: '已完成', at: '2026-10-14T23:00', advance: 0, done: true },
    { id: 'r4', title: '复诊', at: '2026-10-16T09:00', advance: 30, done: false },
  ],
  now,
);
check('只留将来的、没完成的', ups.length === 2, `实际 ${ups.length}`);
check('按该响的时间排序', ups[0].id === 'r1' && ups[1].id === 'r4');
check('复诊按提前 30 分算', ups[1].fireAt === ts(2026, 10, 16, 8, 30));

// =============================================================
// 4. 学习模式
// =============================================================
console.log('\n  \x1b[36m· 学习模式\x1b[0m');

const evening = { id: 'b1', label: '晚自习', from: '20:00', to: '22:00', days: [], packages: ['com.ss.android.ugc.aweme'], enabled: true };
check('时段内会锁', activeBlock([evening], ts(2026, 10, 14, 21, 0))?.id === 'b1');
check('开始那一刻就锁（含左端）', activeBlock([evening], ts(2026, 10, 14, 20, 0))?.id === 'b1');
check('结束那一刻不锁（不含右端）', activeBlock([evening], ts(2026, 10, 14, 22, 0)) === null);
check('时段外不锁', activeBlock([evening], ts(2026, 10, 14, 19, 59)) === null);

const overnight = { id: 'b2', label: '睡前', from: '22:30', to: '01:00', days: [], packages: ['com.x'], enabled: true };
check('跨零点的规则，23:00 会锁', activeBlock([overnight], ts(2026, 10, 14, 23, 0))?.id === 'b2');
check('跨零点的规则，凌晨 0:30 还锁着', activeBlock([overnight], ts(2026, 10, 15, 0, 30))?.id === 'b2');
check('跨零点的规则，凌晨 1:00 解除', activeBlock([overnight], ts(2026, 10, 15, 1, 0)) === null);
check('跨零点的规则，中午不锁', activeBlock([overnight], ts(2026, 10, 15, 12, 0)) === null);

const onlyWed = { ...evening, id: 'b3', days: [3] };
check('限定周三的规则，周三生效', activeBlock([onlyWed], ts(2026, 10, 14, 21, 0))?.id === 'b3');
check('限定周三的规则，周四不生效', activeBlock([onlyWed], ts(2026, 10, 15, 21, 0)) === null);

check('停用的规则不生效', activeBlock([{ ...evening, enabled: false }], ts(2026, 10, 14, 21, 0)) === null);
check('起止相同视为无效规则，不会一整天锁死', activeBlock([{ ...evening, from: '20:00', to: '20:00' }], ts(2026, 10, 14, 20, 0)) === null);
check('时间写坏的规则跳过', activeBlock([{ ...evening, from: '25:00' }], ts(2026, 10, 14, 21, 0)) === null);

const bp = blockedPackages([evening], ts(2026, 10, 14, 21, 0), ['com.ss.android.ugc.aweme']);
check('白名单里的包会被放行', bp.block?.id === 'b1' && bp.packages.length === 0, JSON.stringify(bp.packages));
const bp2 = blockedPackages([evening], ts(2026, 10, 14, 21, 0), []);
check('不在白名单里的包照锁', bp2.packages.length === 1);
check('不在时段内就没有要锁的', blockedPackages([evening], ts(2026, 10, 14, 12, 0), []).packages.length === 0);

const nextStart = nextBlockStart([evening], ts(2026, 10, 14, 12, 0));
check('下一次开始是今天 20:00', nextStart && nextStart.at === ts(2026, 10, 14, 20, 0));
const nextStartTomorrow = nextBlockStart([evening], ts(2026, 10, 14, 21, 0));
check('已经开始了就找明天', nextStartTomorrow && nextStartTomorrow.at === ts(2026, 10, 15, 20, 0));
check('没有任何规则时返回 null', nextBlockStart([], ts(2026, 10, 14, 12, 0)) === null);

check('时段内剩余时间：普通区间', blockRemainingMin(evening, ts(2026, 10, 14, 21, 0)) === 60);
check('时段内剩余时间：跨零点', blockRemainingMin(overnight, ts(2026, 10, 14, 23, 0)) === 120);
check('时段内剩余时间：跨零点过午夜后', blockRemainingMin(overnight, ts(2026, 10, 15, 0, 30)) === 30);
check('时段外剩余为 0', blockRemainingMin(evening, ts(2026, 10, 14, 12, 0)) === 0);

check('humanMinutes 小于一小时', humanMinutes(45) === '45 分钟');
check('humanMinutes 整小时', humanMinutes(120) === '2 小时');
check('humanMinutes 带零头', humanMinutes(80) === '1 小时 20 分');
check('humanMinutes 对负数兜底', humanMinutes(-5) === '0 分钟');

// =============================================================
// 5. 时间表（交给客户端排本地通知的那份）
// =============================================================
console.log('\n  \x1b[36m· 时间表\x1b[0m');

const schedNow = ts(2026, 10, 14, 12, 0);
const sched = buildSchedule(
  {
    meds: [medA],
    doses: log, // 早上那次已经吃了
    reminders: [
      { id: 'r1', title: '开会', at: '2026-10-14T22:00', advance: 10, done: false },
      { id: 'r2', title: '过去的', at: '2026-10-14T09:00', advance: 0, done: false },
      { id: 'r3', title: '已完成的', at: '2026-10-14T23:00', advance: 0, done: true },
    ],
  },
  { days: 2, now: schedNow },
);

check('时间表里排进了今天晚上那次药', sched.some((x) => x.kind === 'med' && x.at === ts(2026, 10, 14, 20, 0)));
check('已经吃过的那次不再排', !sched.some((x) => x.kind === 'med' && x.date === '2026-10-14' && x.slot === '08:00'));
check('排进了明天的两次药', sched.filter((x) => x.kind === 'med' && x.date === '2026-10-15').length === 2);
check('提前量算进提醒时间', sched.some((x) => x.kind === 'reminder' && x.refId === 'r1' && x.at === ts(2026, 10, 14, 21, 50)));
check('过去的提醒不排', !sched.some((x) => x.refId === 'r2'));
check('已完成的提醒不排', !sched.some((x) => x.refId === 'r3'));
check('整张表按时间排序', sched.every((x, i) => i === 0 || sched[i - 1].at <= x.at));
check('药的 id 带上日期，同一种药不同天不会撞', new Set(sched.filter((x) => x.kind === 'med').map((x) => x.id)).size === sched.filter((x) => x.kind === 'med').length);
/*
 * 按需服用的药绝不能进时间表。
 * 阿普唑仑这类苯二氮䓬写的是「必要时服用」，到点催着吃会吃出依赖；
 * 判错这一条的后果比漏一个提醒重得多。
 */
const prnMed = { ...medA, id: 'prn1', name: '阿普唑仑', prn: true };
const prnSched = buildSchedule({ meds: [prnMed], doses: [], reminders: [] }, { days: 3, now: schedNow });
check('「必要时服用」的药不会被排进提醒', prnSched.length === 0, `实际排了 ${prnSched.length} 条`);
const prnPlan = todayPlan([prnMed], [], '2026-10-14', ts(2026, 10, 14, 6, 0));
check('但它照样出现在今天的清单里（想吃可以自己打卡）', prnPlan.length === 2 && prnPlan[0].prn === true);
check('普通药的 prn 是 false', todayPlan([medA], [], '2026-10-14', ts(2026, 10, 14, 6, 0))[0].prn === false);

check(
  '每种都带标题和正文（通知栏直接能用）',
  sched.every((x) => typeof x.title === 'string' && x.title.length > 0 && typeof x.body === 'string'),
);
check('条数有上限，不会无限长', buildSchedule({ meds: [{ ...medA, slots: Array.from({ length: 12 }, (_, i) => ({ at: `${String(i + 8).padStart(2, '0')}:00` })) }], doses: [], reminders: [] }, { days: 30, now: schedNow }).length <= 240);

// =============================================================
// 5b. 学习模式展开成具体时刻（交给安卓无障碍服务的那份）
// =============================================================
console.log('\n  \x1b[36m· 专注时段展开\x1b[0m');

const fNow = ts(2026, 10, 14, 12, 0); // 周三中午
const fBlocks = [
  { id: 'b1', label: '晚自习', from: '20:00', to: '22:00', days: [], packages: ['com.a', 'com.b'], enabled: true },
  { id: 'b2', label: '睡前', from: '22:30', to: '01:00', days: [], packages: ['com.a'], enabled: true },
];
const fiv = buildFocusIntervals(fBlocks, { days: 3, now: fNow, alwaysAllow: ['com.b'] });

check('展开出了时段', fiv.length >= 4, `实际 ${fiv.length}`);
check('第一条是今天 20:00–22:00', fiv[0].from === ts(2026, 10, 14, 20, 0) && fiv[0].to === ts(2026, 10, 14, 22, 0), JSON.stringify(fiv[0]));
check('白名单里的包被剔掉了', fiv[0].packages.join(',') === 'com.a', JSON.stringify(fiv[0].packages));
check('跨零点那条结束在第二天凌晨 1 点', fiv.some((x) => x.from === ts(2026, 10, 14, 22, 30) && x.to === ts(2026, 10, 15, 1, 0)));
check('每一条都带标签（盖住的页面上要显示）', fiv.every((x) => typeof x.label === 'string' && x.label.length));
check('按开始时间排好序', fiv.every((x, i) => i === 0 || fiv[i - 1].from <= x.from));
check('已经过去的时段不会再给', buildFocusIntervals(fBlocks, { days: 1, now: ts(2026, 10, 14, 23, 0) }).every((x) => x.to > ts(2026, 10, 14, 23, 0)));
check('正在进行的时段 from 会夹到「现在」', buildFocusIntervals(fBlocks, { days: 1, now: ts(2026, 10, 14, 21, 0) })[0].from === ts(2026, 10, 14, 21, 0));
check('停用的规则不展开', buildFocusIntervals([{ ...fBlocks[0], enabled: false }], { days: 2, now: fNow }).length === 0);
check('限定星期的规则只在那天展开', buildFocusIntervals([{ ...fBlocks[0], days: [3] }], { days: 3, now: fNow }).every((x) => x.from === ts(2026, 10, 14, 20, 0)));
check('没选应用的规则不展开', buildFocusIntervals([{ ...fBlocks[0], packages: [] }], { days: 2, now: fNow }).length === 0);
check(
  '全被白名单挡掉也不展开',
  buildFocusIntervals([{ ...fBlocks[0], packages: ['com.b'] }], { days: 2, now: fNow, alwaysAllow: ['com.b'] }).length === 0,
);

// =============================================================
// 6. 存储层
// =============================================================
console.log('\n  \x1b[36m· 存储层\x1b[0m');

const care = await new Care(TMP).init();

let r = await care.saveMed({ name: '', slots: [{ at: '08:00' }] });
check('药名不能空', r.ok === false && /药名/.test(r.error), String(r.error));

r = await care.saveMed({ name: '舍曲林', slots: [] });
check('至少得有一个服药时间', r.ok === false && /时间/.test(r.error), String(r.error));

r = await care.saveMed({ name: '舍曲林', slots: [{ at: '25:00' }] });
check('非法时间点会被筛掉，等于没填', r.ok === false, JSON.stringify(r));

r = await care.saveMed({ name: '舍曲林', slots: [{ at: '08:00' }, { at: '08:00' }], dose: '1 片' });
check('能建出药', r.ok === true && r.med.slots.length === 1, JSON.stringify(r));
const medId = r.med.id;

r = await care.saveMed({ name: '碳酸锂', slots: [{ at: '22:00', label: '睡前' }] });
check('能建第二种药', r.ok === true);
const medId2 = r.med.id;

r = await care.saveMed({ id: medId, name: '舍曲林', slots: [{ at: '07:30' }], dose: '半片' });
check('能改已有的药', r.ok === true && r.med.id === medId && r.med.slots[0].at === '07:30');
check('改完不会多出一条', care.listMeds().length === 2);

r = await care.saveMed({ id: medId, name: '舍曲林', slots: [{ at: '07:30' }], startDate: '2026-10-20', endDate: '2026-10-10' });
check('结束日期早于开始日期会被拦', r.ok === false && /结束日期/.test(r.error), String(r.error));

r = await care.saveMed({ id: 'nope', name: '不存在', slots: [{ at: '08:00' }] });
check('改一个不存在的 id 会报错', r.ok === false, JSON.stringify(r));

// 未知字段不能落盘
r = await care.saveMed({ name: '测试药', slots: [{ at: '09:00' }], 我是坏字段: 'x', __proto__evil: 1 });
check('白名单之外的字段被丢掉', r.ok === true && !('我是坏字段' in r.med) && !('__proto__evil' in r.med), JSON.stringify(Object.keys(r.med)));
await care.removeMed(r.med.id);

// ---- 打卡 ----
r = await care.logDose({ medId: 'nope', at: '08:00', action: 'taken' });
check('给不存在的药打卡会被拦', r.ok === false, String(r.error));
r = await care.logDose({ medId, at: '99:99', action: 'taken' });
check('非法时间点打卡会被拦', r.ok === false, String(r.error));
r = await care.logDose({ medId, at: '07:30', ds: '2026-10-14', action: 'taken' });
check('正常打卡成功', r.ok === true && r.record.date === '2026-10-14');
r = await care.logDose({ medId, at: '07:30', ds: '2026-10-14', action: 'undo' });
check('撤销也是一条记录（历史不抹）', r.ok === true && care.doseLog().length === 2);
check('撤销后状态回到未处理', doseState(care.doseLog(), '2026-10-14').size === 0);

// ---- 提醒 ----
r = await care.saveReminder({ title: '', at: '2026-10-14T22:00' });
check('提醒得有名字', r.ok === false, String(r.error));
r = await care.saveReminder({ title: '开会', at: '晚上十点' });
check('提醒时间必须能解析', r.ok === false, String(r.error));
r = await care.saveReminder({ title: '开会', at: '2026-10-14T22:00', advance: 10, source: 'note', entryId: 'e1' });
check('能建提醒', r.ok === true && r.reminder.advance === 10);
const remId = r.reminder.id;
check('按笔记 id 能查到已有提醒（免得反复弹）', care.hasReminderForEntry('e1') === true);
check('没设过的笔记查不到', care.hasReminderForEntry('e2') === false);
r = await care.saveReminder({ id: remId, title: '开会（改）', at: '2026-10-14T21:30', advance: 15 });
check('能改提醒', r.ok === true && r.reminder.advance === 15);
r = await care.removeReminder(remId);
check('能删提醒', r.ok === true && care.listReminders().length === 0);

// ---- 学习模式 ----
r = await care.saveFocus({
  blocks: [
    { label: '晚自习', from: '20:00', to: '22:00', packages: ['com.a', 'com.b', 'com.a'] },
    { label: '坏的', from: '25:00', to: '26:00', packages: ['com.c'] },
  ],
  alwaysAllow: ['com.phone', 'com.phone'],
});
check('能存学习模式设置', r.ok === true);
check('时间写坏的那条被丢掉', r.focus.blocks.length === 1, JSON.stringify(r.focus.blocks));
check('重复的包会去重', r.focus.blocks[0].packages.length === 2);
check('白名单去重', r.focus.alwaysAllow.length === 1);

r = await care.logFocus({ minutes: 0 });
check('专注时长 0 分钟不记', r.ok === false, String(r.error));
r = await care.logFocus({ minutes: 25, label: '晚自习' });
check('能记一次专注', r.ok === true && care.focusLogRecent().length === 1);
r = await care.logFocus({ minutes: 99999 });
check('离谱的时长会被夹到一天', r.ok === true && r.record.minutes === 1440);

// ---- 重新打开还在不在 ----
const care2 = await new Care(TMP).init();
check('重启后药还在', care2.listMeds().length === 2);
check('重启后服药流水还在', care2.doseLog().length === 2);
check('重启后学习模式设置还在', care2.getFocus().blocks.length === 1);
check('重启后专注记录还在', care2.focusLogRecent().length === 2);

// ---- 并发写不能互相覆盖 ----
await Promise.all(
  Array.from({ length: 12 }, (_, i) => care2.logDose({ medId, at: '07:30', ds: `2026-10-${String(10 + i).padStart(2, '0')}`, action: 'taken' })),
);
const care3 = await new Care(TMP).init();
check('12 个并发打卡一条都没丢', care3.doseLog().length === 14, `实际 ${care3.doseLog().length}`);

await Promise.all([
  care3.saveMed({ name: '并发甲', slots: [{ at: '01:00' }] }),
  care3.saveMed({ name: '并发乙', slots: [{ at: '02:00' }] }),
  care3.saveMed({ name: '并发丙', slots: [{ at: '03:00' }] }),
]);
const care4 = await new Care(TMP).init();
check('并发建药不会被互相覆盖', care4.listMeds().length === 5, `实际 ${care4.listMeds().length}`);

// 数据目录里不该留临时文件
const leftover = (await fs.promises.readdir(path.join(TMP, 'care'))).filter((f) => f.includes('.tmp-'));
check('没有留下临时文件', leftover.length === 0, JSON.stringify(leftover));

await fs.promises.rm(TMP, { recursive: true, force: true });

// =============================================================
console.log('');
if (failed) {
  console.log(`\x1b[1m\x1b[31m有失败项\x1b[0m  ${pass} 通过 / ${failed} 失败`);
  console.log(`失败项：${failures.join('、')}`);
  process.exit(1);
}
console.log(`\x1b[1m\x1b[32m关怀模块自测全部通过\x1b[0m  ${pass} 通过 / 0 失败`);
