// =============================================================
// 拾光 · AI 大脑
// 职责：从提问里理解「时间」+「关键词」，检索相关笔记，
//       拼成克制但信息完整的上下文，让模型只依据笔记回答
// =============================================================

import { chat, chatStream, aiEnabled } from './deepseek.mjs';
import { tokenize, scoreDoc } from './text.mjs';
import { toDateStr } from './store.mjs';

const MAX_CONTEXT_CHARS = 60000;

const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];

// ---------------------------------------------------------------
// 日期理解
// ---------------------------------------------------------------

function shiftDays(base, n) {
  const d = new Date(base);
  d.setDate(d.getDate() + n);
  return d;
}

/** 解析 "2026-09-17" -> Date（本地零点） */
function parseYMD(s) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 「今天」是哪天。
 * 默认取服务器时间，但如果前端传来了它所在时区的今天，就用前端的，
 * 否则跨时区时 AI 会把日期算错一天。
 */
export function anchorDate(clientToday) {
  if (typeof clientToday === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(clientToday)) {
    const d = parseYMD(clientToday);
    if (d) return d;
  }
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/**
 * 从自然语言里解析时间范围
 * 支持：今天/昨天/前天/大前天、N天前、上周X、本周X、周X/星期X、X月X日/号、
 *       去年/今年/上个月/这个月、X月（整月）、X年
 * @returns {{from:string,to:string,label:string,spanDays:number}|null}
 */
export function parseTimeRange(text, now = new Date()) {
  if (!text) return null;
  const s = String(text);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const ymd = (d) => toDateStr(d);
  const single = (d, label) => ({ from: ymd(d), to: ymd(d), label, spanDays: 1 });

  // 今天 / 今日
  if (/(今天|今日|刚才|刚刚)/.test(s)) return single(today, '今天');
  if (/(昨天|昨日)/.test(s)) return single(shiftDays(today, -1), '昨天');
  if (/前天/.test(s) && !/大前天/.test(s)) return single(shiftDays(today, -2), '前天');
  if (/大前天/.test(s)) return single(shiftDays(today, -3), '大前天');
  if (/(明天|明日)/.test(s)) return single(shiftDays(today, 1), '明天');

  // N 天前 / N 天前的那天
  let m = /(\d{1,3})\s*天前/.exec(s);
  if (m) {
    const d = shiftDays(today, -Number(m[1]));
    return single(d, `${m[1]}天前（${ymd(d)}）`);
  }

  // 上周 / 这周 / 本周（整周）
  if (/(上个?周|上个?星期|上星期)/.test(s)) {
    const day = today.getDay() === 0 ? 7 : today.getDay();
    const mondayThis = shiftDays(today, -(day - 1));
    const from = shiftDays(mondayThis, -7);
    const to = shiftDays(mondayThis, -1);
    return { from: ymd(from), to: ymd(to), label: '上周', spanDays: 7 };
  }
  if (/(这周|本周|这个星期|这星期)/.test(s)) {
    const day = today.getDay() === 0 ? 7 : today.getDay();
    const monday = shiftDays(today, -(day - 1));
    return { from: ymd(monday), to: ymd(today), label: '本周', spanDays: 7 };
  }

  // 周X / 星期X / 礼拜X
  m = /(?:上|上个|上个星期|上星期|上礼拜|本周|这周|这个星期|星期|周|礼拜)([一二三四五六日天1-7])/.exec(s);
  if (m) {
    const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7 };
    const want = map[m[1]];
    const cur = today.getDay() === 0 ? 7 : today.getDay();
    let diff = cur - want;
    const isLast = /上/.test(m[0]);
    if (isLast) diff += 7;
    else if (diff < 0) diff += 7; // 未来则回到上一个
    const d = shiftDays(today, -diff);
    return single(d, `${isLast ? '上' : ''}周${m[1]}（${ymd(d)}）`);
  }

  // 完整日期 2026-09-17 / 2026/9/17
  m = /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/.exec(s);
  if (m) {
    const d = parseYMD(`${m[1]}-${m[2]}-${m[3]}`);
    if (d) return single(d, `${m[1]}年${m[2]}月${m[3]}日`);
  }

  // X月X日 / X月X号
  m = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/.exec(s);
  if (m) {
    const mo = Number(m[1]);
    const day = Number(m[2]);
    if (mo >= 1 && mo <= 12 && day >= 1 && day <= 31) {
      let year = today.getFullYear();
      let d = new Date(year, mo - 1, day);
      // 若该日期还没到，默认指的是去年
      if (d.getTime() > today.getTime() + 86400000) d = new Date(year - 1, mo - 1, day);
      return single(d, `${d.getFullYear()}年${mo}月${day}日`);
    }
  }

  // X月（整月）
  m = /(\d{1,2})\s*月/.exec(s);
  if (m) {
    const mo = Number(m[1]);
    if (mo >= 1 && mo <= 12) {
      let year = today.getFullYear();
      if (mo > today.getMonth() + 1) year -= 1;
      const from = new Date(year, mo - 1, 1);
      const to = new Date(year, mo, 0);
      return { from: ymd(from), to: ymd(to), label: `${year}年${mo}月`, spanDays: to.getDate() };
    }
  }

  // 上个月 / 这个月 / 本月
  if (/(上个?月|上个月)/.test(s)) {
    const from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const to = new Date(today.getFullYear(), today.getMonth(), 0);
    return { from: ymd(from), to: ymd(to), label: '上个月', spanDays: to.getDate() };
  }
  if (/(这个月|本月|当月)/.test(s)) {
    const from = new Date(today.getFullYear(), today.getMonth(), 1);
    return { from: ymd(from), to: ymd(today), label: '这个月', spanDays: today.getDate() };
  }

  // 去年 / 今年 / 前年
  if (/(去年|上一年)/.test(s)) {
    const y = today.getFullYear() - 1;
    return { from: `${y}-01-01`, to: `${y}-12-31`, label: `${y}年`, spanDays: 365 };
  }
  if (/(今年|本年)/.test(s)) {
    const y = today.getFullYear();
    return { from: `${y}-01-01`, to: ymd(today), label: `${y}年`, spanDays: 365 };
  }
  m = /(\d{4})\s*年/.exec(s);
  if (m) {
    const y = Number(m[1]);
    if (y > 1990 && y < 2200) return { from: `${y}-01-01`, to: `${y}-12-31`, label: `${y}年`, spanDays: 365 };
  }

  // 最近 N 天 / 这几天
  m = /(?:最近|近|过去)\s*(\d{1,3})\s*天/.exec(s);
  if (m) {
    const n = Number(m[1]);
    return { from: ymd(shiftDays(today, -(n - 1))), to: ymd(today), label: `最近${n}天`, spanDays: n };
  }
  if (/(最近|这几天|近期)/.test(s)) {
    return { from: ymd(shiftDays(today, -6)), to: ymd(today), label: '最近一周', spanDays: 7 };
  }

  return null;
}

/** 去掉提问里的时间词，留下真正要检索的关键词 */
export function stripTimeWords(text) {
  return String(text || '')
    .replace(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})[日号]?/g, ' ')
    .replace(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g, ' ')
    .replace(/(今天|今日|昨天|昨日|前天|大前天|明天|明日|刚才|刚刚|最近|近期|这几天)/g, ' ')
    .replace(/(上个?周|上个?星期|上星期|这周|本周|这个星期|这星期|上个?月|这个月|本月|当月|去年|今年|上一年|本年)/g, ' ')
    .replace(/(星期|周|礼拜)[一二三四五六日天1-7]/g, ' ')
    .replace(/(\d{1,3})\s*天前/g, ' ')
    .replace(/(我|你|请问|帮我|查一下|找一下|看下|看看|回想|回忆|还有|做了|干了|发生|什么|哪些|有没有|记得)/g, ' ')
    .replace(/[?？。，,、!！:：;；]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------
// 上下文组织
// ---------------------------------------------------------------

const MOOD_CN = { 1: '很差', 2: '不太好', 3: '一般', 4: '不错', 5: '很好' };

function renderEntry(e, withTime = true) {
  const d = new Date(e.createdAt || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  const time = withTime ? ` ${p(d.getHours())}:${p(d.getMinutes())}` : '';
  const tags = (e.tags || []).length ? ` 标签#${e.tags.join(' #')}` : '';
  const mood = e.mood ? ` 心情:${MOOD_CN[e.mood] || e.mood}` : '';
  const title = e.title ? `【${e.title}】` : '';
  return `- ${e.date}${time}${tags}${mood}\n  ${title}${(e.content || '').replace(/\n/g, '\n  ')}`;
}

/**
 * 组装 AI 上下文
 * @param {import('./store.mjs').Store} store
 * @param {{question:string, keywords:string, range:object|null, maxChars?:number}} opts
 */
export function buildContext(store, { question, keywords, range, todayStr, maxChars = MAX_CONTEXT_CHARS }) {
  const all = store.active();
  const parts = [];
  const refs = new Set();
  let chars = 0;

  const push = (text, dates = []) => {
    if (chars + text.length > maxChars) return false;
    parts.push(text);
    chars += text.length;
    for (const d of dates) refs.add(d);
    return true;
  };

  // 1) 总览：让模型知道自己看到了什么范围的数据
  const stats = store.stats();
  const today = anchorDate(todayStr);
  push(
    `# 我的记录总览\n共 ${stats.total} 条记录，覆盖 ${stats.days} 天，` +
      `从 ${stats.firstDate || '暂无'} 到 ${stats.lastDate || '暂无'}。` +
      `用户所在时区的「今天」是 ${toDateStr(today)}（星期${WEEK_CN[today.getDay()]}）。`,
  );

  if (!all.length) {
    return { text: parts.join('\n\n'), refs: [], usedEntries: 0, stats };
  }

  const used = new Set();

  // 2) 时间范围命中的记录：完整给出
  if (range) {
    const inRange = store.range(range.from, range.to, 400);
    if (inRange.length) {
      const block = [`# ${range.label}（${range.from} ~ ${range.to}）的记录，共 ${inRange.length} 条`];
      for (const e of inRange) {
        block.push(renderEntry(e));
        used.add(e.id);
        refs.add(e.date);
      }
      push(block.join('\n'));
    } else {
      push(`# ${range.label}（${range.from} ~ ${range.to}）\n（这一天没有任何记录）`);
    }

    // 前后各 3 天作为「附近」参考，帮助模型理解上下文脉络
    const near = [];
    for (let i = 1; i <= 3; i++) {
      for (const sign of [-1, 1]) {
        const d = new Date(Date.parse(range.from + 'T12:00:00'));
        d.setDate(d.getDate() + sign * i);
        const ds = toDateStr(d);
        if (ds < range.from || ds > range.to) {
          for (const e of store.byDate(ds)) {
            if (!used.has(e.id)) {
              near.push(e);
              used.add(e.id);
            }
          }
        }
      }
    }
    if (near.length) {
      near.sort((a, b) => a.createdAt - b.createdAt);
      push(`# 相邻几天的记录（仅作背景参考）\n${near.map((e) => renderEntry(e)).join('\n')}`);
    }
  }

  // 3) 关键词检索命中：最相关的若干条
  const kw = (keywords || '').trim();
  if (kw) {
    const phrases = kw.split(/\s+/).filter((x) => x.length >= 1);
    const qTokens = [...new Set(tokenize(kw))];
    const scored = [];
    for (const e of all) {
      if (used.has(e.id)) continue;
      const doc = store.index.get(e.id);
      if (!doc) continue;
      const sc = scoreDoc(doc, qTokens, phrases);
      if (sc > 0) scored.push({ e, sc });
    }
    scored.sort((a, b) => b.sc - a.sc || b.e.createdAt - a.e.createdAt);
    const top = scored.slice(0, 60);
    if (top.length) {
      const block = ['# 与问题关键词最相关的记录（按相关度排序）'];
      for (const { e } of top) {
        block.push(renderEntry(e));
        used.add(e.id);
        refs.add(e.date);
      }
      push(block.join('\n'));
    }
  }

  // 3.5) 兜底：问题很泛时（比如「我最近在忙什么」），时间范围和关键词都可能
  // 一条都没命中，于是「依据的记录」会空着——用户看到一个没有任何出处的回答。
  // 这种情况下把最近写的一批记录也纳入范围，保证模型有真实材料可引、界面有据可查。
  if (!used.size && all.length) {
    const recent = [...all].sort((a, b) => b.createdAt - a.createdAt).slice(0, 30);
    const block = ['# 最近写下的记录（问题没有指向特定时间或关键词，按时间倒序给出）'];
    for (const e of recent) {
      block.push(renderEntry(e));
      used.add(e.id);
      refs.add(e.date);
    }
    push(block.join('\n'));
  }

  // 4) 兜底 / 补充：时间线索引，让模型对全局有感知
  const timeline = all.map((e) => {
    const one = (e.content || '').replace(/\s+/g, ' ').slice(0, 46);
    return `${e.date} ${e.title ? `【${e.title}】` : ''}${one}`;
  });
  const timelineText = `# 全部记录时间线速览\n${timeline.join('\n')}`;
  push(timelineText);

  // 把真正喂给模型的记录也带出来，前端要拿它渲染「相关记录」
  const entriesUsed = [...used]
    .map((id) => store.get(id))
    .filter(Boolean)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, 30);

  return {
    text: parts.join('\n\n'),
    refs: [...refs].sort(),
    usedEntries: used.size,
    entries: entriesUsed,
    stats,
  };
}

// ---------------------------------------------------------------
// 提示词
// ---------------------------------------------------------------

const BASE_RULES = `你是「拾光」，用户私人记录库里的回忆助手。用户平时随手记录自己做过的事、想法、心情，你来帮他回忆、梳理、总结。

铁律：
1. 只依据下面提供的「我的记录」回答。记录里没有的事，绝对不要编造，也不要靠常识补全。
2. 如果记录里确实找不到答案，就直接说「记录里没有写到这件事」，并提示他可以换个说法或去补记；不要用模棱两可的话糊弄。
3. 引用事实时在句末标注日期，格式 [YYYY-MM-DD]，一天可以标注多个。
4. 用中文回答，语气像熟悉他的朋友：自然、简洁、有温度，不要用「根据您的记录显示」这类公文腔。
5. 不要复述全部记录。挑重点，用短句、列表或小标题让答案一眼能看懂。
6. 一天里有多个线索时，按时间顺序串起来讲，像讲故事一样还原那一天。`;

/** 追加在回答末尾的引用块，前端会剥离并渲染成「跳转到那天」 */
const REFS_INSTRUCTION = `\n\n最后另起一行，输出一个引用块，列出你这次回答真正依据的日期（最多 8 个，倒序），格式严格如下，不要加别的字符：\n<!--REFS:["2026-09-17","2026-09-12"]-->`;

/** 生成回答的完整 messages */export function buildAnswerMessages({ question, context, history = [] }) {
  const sys = `${BASE_RULES}${REFS_INSTRUCTION}

──────────────── 我的记录 ────────────────
${context.text}
──────────────── 记录结束 ────────────────`;

  const msgs = [{ role: 'system', content: sys }];
  for (const h of history.slice(-8)) {
    if (h.role === 'user' || h.role === 'assistant') {
      msgs.push({ role: h.role, content: String(h.content || '').slice(0, 4000) });
    }
  }
  msgs.push({ role: 'user', content: question });
  return msgs;
}

/** 从模型回答里剥离引用块 */
export function splitRefs(text) {
  const m = /<!--\s*REFS:\s*(\[[\s\S]*?\])\s*-->/.exec(text);
  let refs = [];
  if (m) {
    try {
      const arr = JSON.parse(m[1]);
      if (Array.isArray(arr)) refs = arr.filter((x) => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x)).slice(0, 8);
    } catch {
      /* 忽略格式错误 */
    }
  }
  const clean = text.replace(/<!--\s*REFS:[\s\S]*?-->/g, '').trim();
  return { clean, refs };
}

// ---------------------------------------------------------------
// 对外能力
// ---------------------------------------------------------------

/**
 * 对话式问答（流式）
 * @param {object} opts
 * @param {import('./store.mjs').Store} opts.store
 * @param {string} opts.question
 * @param {Array} opts.history
 * @param {(s:string)=>void} opts.onDelta
 * @param {(s:string)=>void} [opts.onReasoning]
 * @param {AbortSignal} [opts.signal]
 */
export async function askStream({ store, question, history = [], todayStr, onDelta, onReasoning, signal }) {
  if (!aiEnabled()) throw new Error('服务端未配置 DEEPSEEK_API_KEY');
  const range = parseTimeRange(question, anchorDate(todayStr));
  const keywords = stripTimeWords(question);
  const context = buildContext(store, { question, keywords, range, todayStr });

  const messages = buildAnswerMessages({ question, context, history });
  let buffer = '';
  let visible = '';
  // 引用块在回答结尾，所以先扣住一小段不发给前端。
  // 注意不能按固定长度切：标记 <!--REFS: 可能刚好被切断，
  // 半截标记会漏给用户看到。所以只发到最后一个 '<' 之前。
  const HOLD = 24;

  const { usage } = await chatStream({
    messages,
    onDelta: (d) => {
      buffer += d;
      if (buffer.length <= HOLD) return;
      const limit = buffer.length - HOLD;
      const lt = buffer.lastIndexOf('<', limit - 1);
      const cut = lt >= 0 ? lt : limit;
      if (cut <= 0) return;
      const chunk = buffer.slice(0, cut);
      buffer = buffer.slice(cut);
      visible += chunk;
      onDelta(chunk);
    },
    onReasoning,
    signal,
  });

  const full = visible + buffer;
  const { clean, refs } = splitRefs(full);
  // 把可能被扣留的尾巴补上（引用块已剔除）
  const tail = clean.slice(visible.length);
  if (tail) onDelta(tail);

  return {
    answer: clean,
    /*
     * refs 本该由模型在回答末尾的 <!--REFS:[...]--> 里给出，
     * 但它偶尔会忘记写。这时候退回到「这次真正喂给它的记录里有哪些日期」——
     * 界面上「依据的日期」不该因为模型少写一行就空掉。
     */
    refs: refs.length ? refs : [...new Set((context.entries || []).map((e) => e.date))].sort().slice(-8),
    // 直接把引用的记录正文带上，前端能在对话里展开看，不用另开检索页
    entries: (context.entries || []).map((e) => ({
      id: e.id,
      date: e.date,
      createdAt: e.createdAt,
      content: e.content,
      title: e.title,
      tags: e.tags || [],
      mood: e.mood ?? null,
    })),
    meta: {
      range: range ? { from: range.from, to: range.to, label: range.label } : null,
      keywords,
      usedEntries: context.usedEntries,
      scanned: context.stats.total,
      usage,
    },
  };
}

/** 非流式（供检索页「AI 总结」用） */
export async function ask({ store, question, history = [], todayStr }) {
  if (!aiEnabled()) throw new Error('服务端未配置 DEEPSEEK_API_KEY');
  const range = parseTimeRange(question, anchorDate(todayStr));
  const keywords = stripTimeWords(question);
  const context = buildContext(store, { question, keywords, range, todayStr });
  const messages = buildAnswerMessages({ question, context, history });
  const json = await chat({ messages });
  const raw = json.choices?.[0]?.message?.content || '';
  const { clean, refs } = splitRefs(raw);
  return {
    answer: clean,
    refs,
    meta: {
      range: range ? { from: range.from, to: range.to, label: range.label } : null,
      keywords,
      usedEntries: context.usedEntries,
      usage: json.usage,
    },
  };
}

/** 生成某一天的总结，并缓存 */
export async function summarizeDay(store, date, { force = false } = {}) {
  if (!aiEnabled()) throw new Error('服务端未配置 DEEPSEEK_API_KEY');
  const entries = store.byDate(date);
  if (!entries.length) return { date, empty: true, summary: '' };

  const newest = Math.max(...entries.map((e) => e.updatedAt || 0));
  if (!force) {
    const cached = await store.getSummary(date);
    if (cached && cached.stamp === newest && cached.summary) return { ...cached, cached: true };
  }

  // 星期必须从日期字符串本身算，不能用 new Date() 依赖服务器时区，
  // 否则服务器在 UTC 时，中国用户会看到「今天」被算成昨天
  const d = parseYMD(date) || new Date();
  const sys = `你是「拾光」的每日回顾助手。用户会给你他某一天的全部记录。
请写一段当天回顾，要求：
1. 只写记录里有的内容，不要脑补，不要评价他没做的事。
2. 用中文，第二人称「你」，语气像朋友帮他回忆。
3. 结构：先用一句话概括这一天的主线；再用「- 」列出 2~5 件具体做过的事（带上关键细节：人名、项目名、数字）；如果记录里体现了心情或状态，最后用一句话点出来。
4. 总长度控制在 120~220 字，不要写「总结如下」这类套话，直接开始。`;

  const body = entries.map((e) => renderEntry(e)).join('\n');
  const json = await chat({
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: `日期：${date}（星期${WEEK_CN[d.getDay()]}）\n\n当天的记录：\n${body}` },
    ],
    temperature: 1.0,
  });
  const summary = (json.choices?.[0]?.message?.content || '').trim();
  const out = { date, summary, stamp: newest, count: entries.length, at: Date.now() };
  await store.putSummary(out);
  return out;
}

export { aiEnabled, WEEK_CN };

// ---------------------------------------------------------------
// 语音记录：从口语转写里提炼要点
// ---------------------------------------------------------------

const VOICE_SYS = `你是「拾光」的语音整理助手。用户心情不好或懒得打字时，会随口说几句话，语音转文字的结果往往有口语、重复、语气词、错别字。

你的任务是把这段话整理成好读的记录，并提炼要点。

要求：
1. **绝不能编造**。用户没说的信息一个字都不要加，不要替他补充原因、结论、建议。
2. cleaned 是整理后的正文：去掉「呃、那个、就是、然后然后」这类语气词和重复，补上标点，分成通顺的句子。保留他的原话风格和所有具体信息（人名、项目名、数字、时间）。
3. 如果原话本身就很短很干净，cleaned 可以基本等于原话。
4. 转写里明显的错别字可以按上下文纠正（例如人名、专有名词），拿不准就保持原样。
5. points 是 1~4 条要点，每条不超过 20 字，抓真正重要的信息。内容太少时给 1 条或空数组。
6. mood 判断情绪：1=很差 2=低落 3=一般 4=不错 5=很好。看不出情绪就给 null，不要硬猜。
7. tags 给 0~3 个标签，从内容里归纳（如 工作、健康、情绪、学习、家庭、人际）。看不出就给空数组。
8. title 可以给一个不超过 12 字的短标题；如果内容零散或太短就给空字符串。

只输出 JSON，不要加任何解释文字。格式：
{"cleaned":"整理后的正文","points":["要点1","要点2"],"mood":3,"tags":["工作"],"title":""}`;

/**
 * 把一段口语转写整理成结构化记录
 * @param {string} transcript 原始转写
 * @param {{todayStr?:string}} opts
 */
export async function extractVoice(transcript, opts = {}) {
  const raw = String(transcript || '').trim();
  if (!raw) throw new Error('没有可整理的内容');
  // 太短就不麻烦模型了
  if (raw.length <= 12) {
    return { cleaned: raw, points: [], mood: null, tags: [], title: '', model: 'passthrough' };
  }

  const today = anchorDate(opts.todayStr);
  const user = `用户所在时区的今天是 ${toDateStr(today)}（星期${WEEK_CN[today.getDay()]}）。\n\n语音转写原文：\n${raw}`;

  const json = await chat({
    messages: [
      { role: 'system', content: VOICE_SYS },
      { role: 'user', content: user },
    ],
    temperature: 0.3,
    maxTokens: 1200,
    json: true,
  });

  const text = json.choices?.[0]?.message?.content || '{}';
  let parsed = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    // 模型偶尔会包一层 ```json，兜一下
    const m = /\{[\s\S]*\}/.exec(text);
    if (m) {
      try {
        parsed = JSON.parse(m[0]);
      } catch {
        parsed = {};
      }
    }
  }

  const points = Array.isArray(parsed.points)
    ? parsed.points.map((p) => String(p).trim()).filter(Boolean).slice(0, 4)
    : [];
  const tags = Array.isArray(parsed.tags)
    ? parsed.tags.map((t) => String(t).replace(/^#/, '').trim()).filter(Boolean).slice(0, 3)
    : [];
  const moodNum = Number(parsed.mood);
  const mood = Number.isInteger(moodNum) && moodNum >= 1 && moodNum <= 5 ? moodNum : null;

  return {
    cleaned: String(parsed.cleaned || raw).trim().slice(0, 4000),
    points,
    mood,
    tags,
    title: String(parsed.title || '').trim().slice(0, 24),
    model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
  };
}

// ---------------------------------------------------------------
// 关怀：医嘱解析 / 笔记里的时间约定检测
// ---------------------------------------------------------------

/** 模型偶尔会把 JSON 包在 ```json 里，或者前后带解释，兜一下 */
function parseJSONLoose(text) {
  const raw = String(text || '').trim();
  try {
    return JSON.parse(raw);
  } catch {
    /* 继续兜 */
  }
  const m = /\{[\s\S]*\}/.exec(raw);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {
      /* 放弃 */
    }
  }
  return {};
}

/**
 * 允许的图片类型与体积。
 * DeepSeek 支持 JPEG/PNG/GIF/WebP，格式按内容判断不按文件名；
 * base64 单张上限 32MB、整个请求 48MB —— 医嘱照片通常一两 MB，
 * 这里再收紧一点，免得一张 20MB 的原图把请求顶爆。
 */
export const MED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
export const MED_IMAGE_MAX_BYTES = 6 * 1024 * 1024;
export const MED_IMAGE_MAX_COUNT = 4;

const MED_SYS = `你是「拾光」的用药信息录入助手。用户会给你医生的处方单、药盒照片、出院小结，或者他自己口述/打字的用药说明。你要把里面的**服药安排**整理成结构化数据。

最重要的一条：**这是一份会用来提醒吃药的清单，抄错比抄不全危险得多。**

铁律：
1. 只写材料上确实有的信息。看不清、没写、拿不准的，一律留空并在 unclear 里说明，**绝不推测**。
2. 不要给任何医疗建议，不要评价药物，不要补充说明书上的内容，不要提醒副作用。
3. 剂量照抄原文（「1 片」「半片」「50mg」「一次两粒」都行），不要换算单位。
4. 时间要转成 24 小时的 HH:MM。原文说「早饭后」→ 08:00、「中午」→ 12:00、「晚上睡前」→ 22:00、「bid」→ 08:00 和 20:00、「tid」→ 08:00、14:00、20:00、「qd」→ 08:00。这样转是常规做法，但要在 note 里保留原话（例如 note 写「早饭后服用」）。
5. **同一种药只返回一条**，一天吃几次就给它几个 slots。早晚剂量不一样时，
   把剂量写在各自的 slot 里（slot 有自己的 dose 字段），不要拆成两条 ——
   「舍曲林早上一片、晚上半片」是一张卡片上的两个时间点，不是两种药。
   med.dose 只在整个药只有一个剂量时才填。
6. 剂量或频次看不清时，slots 也要给（宁可提醒了没吃，也别漏提醒），但在 unclear 里明确说哪一条没看清。
7. **「必要时服用」「需要时吃」「按需」「prn」「sos」这类要单独标出来**：把 prn 设成 true。
   这类药照样给 slots（写清楚通常什么时候吃），但它不会变成定时提醒 ——
   到点催一个「按需吃」的药是危险的，尤其是阿普唑仑、劳拉西泮这类
   苯二氮䓬，天天催着吃会吃出依赖。判错了后果比漏一提醒重得多。

只输出 JSON，不要加任何解释文字。格式：
{"meds":[{"name":"药名","dose":"","prn":false,"slots":[{"at":"08:00","label":"早","dose":"1 片"},{"at":"22:00","label":"睡前","dose":"半片"}],"note":"早饭后服用","days":[],"startDate":"","endDate":""}],"unclear":["第 3 条剂量看不清"],"summary":"一共 2 种药，每天 3 次"}

说明：
- slots[].dose：这个时间点吃多少；整盒药只有一个剂量时留空字符串，写在上面的 med.dose
- prn：true 表示「必要时服用」，不排定时提醒；拿不准时填 false，并在 note 里保留原话
- days：需要限定星期几时给 [0,1,2,3,4,5,6]（0=周日）的子集；每天吃就给 []
- startDate/endDate：材料上写了疗程起止才填，格式 YYYY-MM-DD，没写就空字符串
- label：时段中文简称，如 早/中/晚/睡前，没有就空字符串
- 材料里没有任何服药信息时返回 {"meds":[],"unclear":[],"summary":""}`;

/**
 * 解析用药方案。
 * 输入可以是纯文字（打字或语音转写），也可以带医嘱图片。
 * 注意：**结果只是草稿**，必须让用户确认后再落库——医疗场景不能让模型直接写库。
 *
 * @param {{text?:string, images?:Array<{mime:string,data:string}>, todayStr?:string}} opts
 */
export async function parseMedication(opts = {}) {
  const text = String(opts.text || '').trim().slice(0, 4000);
  const images = (Array.isArray(opts.images) ? opts.images : [])
    .filter((im) => im && MED_IMAGE_TYPES.includes(String(im.mime)) && typeof im.data === 'string' && im.data.length > 32)
    .slice(0, MED_IMAGE_MAX_COUNT)
    .filter((im) => Math.floor((im.data.length * 3) / 4) <= MED_IMAGE_MAX_BYTES);

  if (!text && !images.length) return { meds: [], unclear: [], summary: '', model: 'passthrough' };

  const today = anchorDate(opts.todayStr);
  const lines = [
    `用户所在时区的今天是 ${toDateStr(today)}（星期${WEEK_CN[today.getDay()]}）。`,
    '',
  ];
  if (text) lines.push('用户提供的文字说明：', text, '');
  if (images.length) lines.push(`另有 ${images.length} 张医嘱/药盒图片，请看图。`);

  const content = [{ type: 'text', text: lines.join('\n') }];
  for (const im of images) {
    content.push({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.data}`, detail: 'high' } });
  }

  const json = await chat({
    messages: [
      { role: 'system', content: MED_SYS },
      { role: 'user', content },
    ],
    temperature: 0.1,
    maxTokens: 2000,
    json: true,
  });

  const parsed = parseJSONLoose(json.choices?.[0]?.message?.content || '{}');
  const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
  const meds = (Array.isArray(parsed.meds) ? parsed.meds : [])
    .slice(0, 20)
    .map((m) => {
      if (!m || typeof m !== 'object') return null;
      const name = String(m.name || '').trim().slice(0, 40);
      if (!name) return null;
      const slots = [];
      const seen = new Set();
      for (const s of Array.isArray(m.slots) ? m.slots.slice(0, 12) : []) {
        const at = typeof s === 'string' ? s : s && s.at;
        if (!HHMM.test(String(at || '')) || seen.has(at)) continue;
        seen.add(at);
        const slot = { at };
        if (typeof s === 'object' && s) {
          const label = String(s.label || '').trim().slice(0, 8);
          const dose = String(s.dose || '').trim().slice(0, 40);
          if (label) slot.label = label;
          if (dose) slot.dose = dose;
        }
        slots.push(slot);
      }
      if (!slots.length) return null;
      slots.sort((a, b) => a.at.localeCompare(b.at));
      const days = Array.isArray(m.days)
        ? [...new Set(m.days.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort((a, b) => a - b)
        : [];
      const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '');
      return {
        name,
        dose: String(m.dose || '').trim().slice(0, 40),
        prn: m.prn === true,
        slots,
        note: String(m.note || '').trim().slice(0, 200),
        days: days.length >= 7 ? [] : days,
        startDate: ymd(m.startDate),
        endDate: ymd(m.endDate),
      };
    })
    .filter(Boolean);

  return {
    meds,
    unclear: (Array.isArray(parsed.unclear) ? parsed.unclear : []).map((x) => String(x).trim().slice(0, 120)).filter(Boolean).slice(0, 8),
    summary: String(parsed.summary || '').trim().slice(0, 120),
    model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
  };
}

const REMIND_SYS = `你是「拾光」的提醒识别助手。用户刚写下一条记录，你要判断里面有没有「将来某个时间点要做的一件事」，如果有，替他起草一条提醒。

判定的门槛要高——**宁可漏，不要误报**。用户只是随手记点东西，弹一堆「要不要设提醒」只会让人烦。

返回 found=true 需要同时满足：
1. 有明显的时间点（几点、中午、明天下午三点、下周一……），而且要能落到**具体某天某时刻**；
2. 有件**将来要做的**事（开会、复诊、交材料、打电话、取快递、面试……）。

以下一律 found=false：
- 时间已经过去了（「昨天十点开了个会」「早上吃了药」）
- 只是描述状态或心情（「今天好累」「晚上睡不着」）
- 只有时间没有事（「下午三点了」），或者只有事没有时间（「记得交材料」）
- 习惯性的、没有具体某天的事（「以后早点睡」）
- 拿不准的一律 false

advance 给「提前多少分钟提醒」的建议：开会/约见 10，面试/复诊/看医生 30，考试/出发赶车 60，吃药 0，其它默认 10。

只输出 JSON，不要加任何解释文字。格式：
{"found":true,"title":"开会","at":"2026-10-14T22:00","advance":10,"quote":"晚上十点有个会"}
found=false 时给 {"found":false}`;

/**
 * 从一条记录里找「到点要做的事」。
 *
 * 刻意不接进保存流程：记录是最高频的操作，不能被一次 AI 调用拖慢。
 * 客户端保存完之后再单独打这个接口，识别失败也无所谓。
 *
 * @param {{text:string, todayStr?:string, nowTs?:number}} opts
 */
export async function detectReminder(opts = {}) {
  const text = String(opts.text || '').trim();
  // 太短的一律没戏，省一次调用
  if (text.length < 5) return { found: false, model: 'passthrough' };

  const now = Number.isFinite(opts.nowTs) ? new Date(opts.nowTs) : new Date();
  const today = anchorDate(opts.todayStr);
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const user = [
    `现在的本地时间是 ${toDateStr(today)} ${hhmm}（星期${WEEK_CN[today.getDay()]}）。`,
    `「今天」「今晚」指 ${toDateStr(today)}；「明天」指 ${toDateStr(new Date(today.getTime() + 86400000))}。`,
    '只判断这条记录本身，不要参考任何其它信息。',
    '',
    '记录内容：',
    text.slice(0, 1000),
  ].join('\n');

  const json = await chat({
    messages: [
      { role: 'system', content: REMIND_SYS },
      { role: 'user', content: user },
    ],
    temperature: 0.1,
    maxTokens: 400,
    json: true,
  });

  const parsed = parseJSONLoose(json.choices?.[0]?.message?.content || '{}');
  if (parsed.found !== true) return { found: false, model: process.env.DEEPSEEK_MODEL || 'deepseek-flash' };

  const at = String(parsed.at || '').trim().replace(' ', 'T').slice(0, 16);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(at)) return { found: false, model: process.env.DEEPSEEK_MODEL || 'deepseek-flash' };
  const title = String(parsed.title || '').trim().slice(0, 40);
  if (!title) return { found: false, model: process.env.DEEPSEEK_MODEL || 'deepseek-flash' };

  // 模型偶尔会给出已经过去的时间，这种直接丢掉
  const atTs = new Date(Number(at.slice(0, 4)), Number(at.slice(5, 7)) - 1, Number(at.slice(8, 10)), Number(at.slice(11, 13)), Number(at.slice(14, 16)), 0, 0).getTime();
  if (!(atTs > now.getTime())) return { found: false, model: process.env.DEEPSEEK_MODEL || 'deepseek-flash' };

  const advRaw = Number(parsed.advance);
  const advance = Number.isFinite(advRaw) ? Math.max(0, Math.min(24 * 60, Math.round(advRaw))) : 10;

  return {
    found: true,
    title,
    at,
    advance,
    quote: String(parsed.quote || '').trim().slice(0, 120),
    model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
  };
}

// ---------------------------------------------------------------
// 那年今日：翻出同一天在往年写下的东西
// ---------------------------------------------------------------

const MEMORY_SYS = `你是「拾光」的回忆助手。用户打开了今天这个日子，你想让他看见过去的自己在同一天做过什么。

要求：
1. 只根据提供的往年记录说话，不要编造，也不要过度解读。
2. 用第二人称「你」，语气像老朋友，自然、有温度，不要煽情。
3. 先点出「几年前的今天你在做什么」这件事本身，再挑 1~3 个具体细节。
4. 如果看得出前后的变化或呼应（比如同一件事的进展、同一个人），可以点一句。
5. 控制在 80~150 字，不要写「总结」「回顾如下」这类套话，直接说。`;

/**
 * 取某一天在往年的记录
 * @param {import('./store.mjs').Store} store
 * @param {string} date YYYY-MM-DD
 * @param {number} years 往前看几年
 */
export function memoriesOf(store, date, years = 5) {
  const [y, m, d] = date.split('-').map(Number);
  const out = [];
  for (let i = 1; i <= years; i++) {
    const past = `${y - i}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const list = store.byDate(past);
    if (list.length) {
      out.push({
        yearsAgo: i,
        date: past,
        entries: list.map((e) => ({
          id: e.id,
          createdAt: e.createdAt,
          content: e.content,
          title: e.title,
          tags: e.tags,
          mood: e.mood,
          attachments: (e.attachments || []).map((a) => ({
            id: a.id,
            durationMs: a.durationMs,
            points: a.points || [],
            url: `api/audio/${a.id}`,
            mime: 'audio/webm',
          })),
        })),
      });
    }
  }
  return out;
}

/**
 * 生成「那年今日」的一段话（可选，按需调用）
 */
export async function reflectMemories(store, date, opts = {}) {
  if (!aiEnabled()) throw new Error('服务端未配置 DEEPSEEK_API_KEY');
  const mem = memoriesOf(store, date, 5);
  if (!mem.length) return { date, summary: '', empty: true };

  const body = mem
    .map(
      (g) =>
        `## ${g.yearsAgo} 年前的今天（${g.date}）\n` +
        g.entries
          .map((e) => {
            const pts = (e.attachments || []).flatMap((a) => a.points || []);
            return `- ${e.title ? `【${e.title}】` : ''}${e.content}${pts.length ? `（要点：${pts.join('；')}）` : ''}`;
          })
          .join('\n'),
    )
    .join('\n\n');

  const json = await chat({
    messages: [
      { role: 'system', content: MEMORY_SYS },
      { role: 'user', content: `今天是 ${date}。下面是你翻到的往年同日记录：\n\n${body}` },
    ],
    temperature: 1.0,
    maxTokens: 600,
  });
  const summary = String(json.choices?.[0]?.message?.content || '').trim();
  return { date, summary, groups: mem.length, model: process.env.DEEPSEEK_MODEL || 'deepseek-flash' };
}
