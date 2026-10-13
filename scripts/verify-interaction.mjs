// =============================================================
// 拾光 · 交互与可用性专项测试
// 布局审计查的是「画得对不对」，这个脚本查「用起来顺不顺」：
//   · 日历：换月、选日期、滑动、键盘、回到今天
//   · 对话：能输入、能发送、能收到回答、输入区不被遮挡
//   · 通用：点击后是否有反馈、按钮是否可点、有无控制台报错
//   · 小屏 360px 下的可用性
//
// 用法：node scripts/verify-interaction.mjs [baseUrl]
// =============================================================

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));
const BASE = (positional[0] || process.env.BASE || 'http://127.0.0.1:8791').replace(/\/+$/, '');
const PASSWORD = process.env.PASSWORD || 'test-pass-1';
const PHONE = process.env.TEST_PHONE || '13800138000';
/**
 * 登录脚本片段。
 * 账号是手机号，所以要先把手机号和密码都填上再点「进入」。
 * 注意不能填完立刻点：Vue 的 :disabled 要等渲染完才更新，
 * 同一个同步块里点会点到还处于禁用态的按钮。
 */
const LOGIN_JS = `(() => {
  const set = (el, v) => {
    if (!el) return false;
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  };
  const gate = document.querySelector('.gate');
  if (!gate) return 'no-gate';
  const tel = gate.querySelector('input[type=tel]');
  const pw = gate.querySelector('input[type=password]');
  if (!tel || !pw) return 'no-fields';
  set(tel, ${JSON.stringify(PHONE)});
  set(pw, ${JSON.stringify(PASSWORD)});
  return 'filled';
})()`;

const PORT = 9420;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.shots-interaction');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

const CHROME = path.join(os.homedir(), '.cache/ms-playwright/chromium-1217/chrome-linux64/chrome');
let msgId = 0;
const pending = new Map();
const pageErrors = [];
const consoleErrors = [];

const send = (ws, method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} 超时`));
      }
    }, 30000);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

async function main() {
  const proc = spawn(
    CHROME,
    [
      `--remote-debugging-port=${PORT}`,
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--no-first-run',
      '--password-store=basic',
      '--use-mock-keyring',
      '--force-device-scale-factor=2',
      `--user-data-dir=${path.join(os.tmpdir(), 'sg-interaction')}`,
      'about:blank',
    ],
    { stdio: 'ignore', env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: '/dev/null' } },
  );

  let wsUrl = '';
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      wsUrl = (await r.json()).webSocketDebuggerUrl;
      if (wsUrl) break;
    } catch {
      /* wait */
    }
    await sleep(250);
  }
  if (!wsUrl) throw new Error('DevTools 未就绪');

  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  ws.addEventListener('message', (ev) => {
    let m;
    try {
      m = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
    } catch {
      return;
    }
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push(String(m.params?.exceptionDetails?.exception?.description || '').split('\n')[0]);
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
      consoleErrors.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 160));
    }
  });

  const { targetId } = await send(ws, 'Target.createTarget', { url: 'about:blank' });
  const { sessionId: S } = await send(ws, 'Target.attachToTarget', { targetId, flatten: true });
  await send(ws, 'Page.enable', {}, S);
  await send(ws, 'Runtime.enable', {}, S);

  const setViewport = (w, h, mobile) =>
    send(ws, 'Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile }, S);

  const ev = async (expr) => {
    const r = await send(ws, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, S);
    if (r.exceptionDetails) return `ERR:${String(r.exceptionDetails.exception?.description || '').slice(0, 160)}`;
    return r.result?.value;
  };

  const shot = async (name) => {
    fs.mkdirSync(OUT, { recursive: true });
    const { data } = await send(ws, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, S);
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
    console.log(`  📷 ${name}.png`);
  };

  /**
   * 确保库里有数据。
   * 这个脚本会检查检索和 AI 回答，没有记录就什么都测不出来。
   * 不能依赖别的测试留下数据（verify-edge 会清空全库），所以自己补。
   */
  const SEED_MARK = `交互测试种子-${Date.now()}`;
  const apiCall = (js) =>
    ev(`(async () => { const _m = location.pathname.match(/^(.*\\/shiguang)\\//); const api = (_m ? _m[1] : '') + '/api'; ${js} })()`);

  const ensureData = async () => {
    const made = await apiCall(`
      const st = await fetch(api + '/stats', { credentials: 'include' }).then(r => r.json());
      if (st.data.total >= 3) return 'enough:' + st.data.total;
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      const day = (n) => { const t = new Date(d); t.setDate(t.getDate() - n); return t.getFullYear() + '-' + p(t.getMonth()+1) + '-' + p(t.getDate()); };
      const items = [
        { content: ${JSON.stringify(SEED_MARK)} + ' 上午在改拾光的找回页面，把检索和对话合并了', tags: ['项目'] },
        { content: ${JSON.stringify(SEED_MARK)} + ' 下午和客户系统对了接口字段', tags: ['工作'] },
        { content: ${JSON.stringify(SEED_MARK)} + ' 晚上跑了五公里', tags: ['健康'] },
      ];
      let n = 0;
      for (let i = 0; i < items.length; i++) {
        const r = await fetch(api + '/entries', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...items[i], date: day(i) }),
        }).then(x => x.json());
        if (r.ok) n++;
      }
      return 'seeded:' + n;
    `);
    return made;
  };

  const cleanupSeed = async () => {
    await apiCall(`
      const list = await fetch(api + '/entries?limit=2000', { credentials: 'include' }).then(r => r.json());
      let n = 0;
      for (const e of list.data.entries) {
        if (e.content.includes(${JSON.stringify(SEED_MARK)})) {
          await fetch(api + '/entries/' + e.id, { method: 'DELETE', credentials: 'include' });
          n++;
        }
      }
      return n;
    `);
  };

  try {
    console.log(`\n\x1b[36m拾光 · 交互专项测试\x1b[0m  ${BASE}\n`);

    // ---------- 小屏 360px ----------
    await setViewport(360, 780, true);
    await send(ws, 'Page.navigate', { url: `${BASE}/` }, S);
    await sleep(3500);
    // 注销 Service Worker 并清掉它 precache 的页面。
    // 只注销不清缓存的话，浏览器可能还在跑上一版构建，
    // 测出来的「失败」其实是旧代码的，排查方向会被带偏。
    await send(ws, 'Runtime.evaluate', { expression: `(async () => { try { const rs = await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map(r => r.unregister())); const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); } catch {} })()`, awaitPromise: true }, S);
    await sleep(400);
    for (let i = 0; i < 8; i++) {
      if (await ev(`!!document.querySelector('.shell')`)) break;
      await ev(LOGIN_JS);
      await sleep(400);
      await ev(`document.querySelector('.gate .btn-primary')?.click()`);
      await sleep(2200);
    }
    check('登录成功', await ev(`!!document.querySelector('.shell')`));

    // 自己保证有数据，不依赖别的测试
    const seeded = await ensureData();
    console.log(`  （数据准备：${seeded}）`);
    // 种子是直接打接口塞进去的，页面上的 store 并不知道。
    // 不重新加载的话，界面会停在「还没有任何记录」——那是缓存旧了，不是功能坏了。
    if (String(seeded).startsWith('seeded')) {
      await ev(`location.reload()`);
      await sleep(4000);
    }

    console.log('\n  \x1b[36m· 小屏 360px（老机型）\x1b[0m');
    const noHScroll = await ev(`document.documentElement.scrollWidth <= window.innerWidth + 2`);
    check('360px 下没有横向滚动', noHScroll, `文档宽 ${await ev('document.documentElement.scrollWidth')}`);

    // ---------- 日历交互 ----------
    console.log('\n  \x1b[36m· 日历交互（并进「过往」首页了）\x1b[0m');
    await ev(`location.hash='#/'`);
    await sleep(2000);
    // 首屏的记录是异步拉的。全量测试里前面几个脚本刚跑完，
    // 服务器可能还在忙，抢在前面断言会读到一个空时间线。
    for (let i = 0; i < 20; i++) {
      if (Number(await ev(`document.querySelectorAll('.entry').length`)) > 0) break;
      await sleep(500);
    }
    const tlCount = Number(await ev(`document.querySelectorAll('.entry').length`));
    if (tlCount === 0) {
      // 空时间线有两种可能：前端没渲染，或者接口真的没给数据。分开报。
      const diag = await ev(`(async () => {
        const _m = location.pathname.match(/^(.*\\/shiguang)\\//); const api = (_m ? _m[1] : '') + '/api';
        try {
          const r = await fetch(api + '/entries?limit=5', { credentials: 'include' });
          const j = await r.json();
          return 'HTTP ' + r.status + ' / 接口返回 ' + (j.data?.entries?.length ?? '?') + ' 条';
        } catch (e) { return '接口请求失败：' + e.message; }
      })()`);
      console.log(`     \x1b[90m诊断：${diag}\x1b[0m`);
    }
    check('时间线已经加载出来', tlCount > 0, `渲染 ${tlCount} 条`);

    const calShape = await ev(`
      (() => {
        const days = document.querySelectorAll('.cal-day:not(.is-blank)');
        const week = document.querySelectorAll('.cal-week span');
        const first = document.querySelector('.cal-day:not(.is-blank)');
        const r1 = first ? first.getBoundingClientRect() : null;
        // 判断是不是 7 列。
        // 注意：首行可能不满 7 个（月初不是周一时会留空），
        // 所以要找「排满 7 个」的那一行来判定。
        const byTop = {};
        document.querySelectorAll('.cal-day:not(.is-blank)').forEach((d) => {
          const t = Math.round(d.getBoundingClientRect().top);
          (byTop[t] = byTop[t] || []).push(d);
        });
        const cols = Math.max(...Object.values(byTop).map((v) => v.length));
        return JSON.stringify({ dayCount: days.length, weekHeaders: week.length, colsInRow: cols, cellH: r1 ? Math.round(r1.height) : 0 });
      })()
    `);
    const shape = typeof calShape === 'string' ? JSON.parse(calShape) : {};
    check('日历是 7 列网格', shape.colsInRow === 7, `最宽一行 ${shape.colsInRow} 列`);
    check('星期表头 7 个', shape.weekHeaders === 7, `实际 ${shape.weekHeaders}`);
    check('格子高度够手指点', shape.cellH >= 36, `实际 ${shape.cellH}px`);
    check('当月天数合理', shape.dayCount >= 28 && shape.dayCount <= 31, `实际 ${shape.dayCount}`);
    await shot('01-日历-360px');

    // ---------- 未来的日子不能选 ----------
    // 记录只可能发生在过去和现在，未来的格子点了也只会弹「没有记录」，
    // 索性不给点——否则用户会以为自己记漏了。
    const future = JSON.parse(
      String(
        await ev(`JSON.stringify({
          today: (() => { const t = new Date(); const p = (n) => String(n).padStart(2, '0'); return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate()); })(),
          total: document.querySelectorAll('.cal-day:not(.is-blank)').length,
          marked: document.querySelectorAll('.cal-day.is-future').length,
          clickable: [...document.querySelectorAll('.cal-day.is-future')].filter((c) => !c.disabled).length,
          nextDisabled: document.querySelectorAll('.cal-nav')[1]?.disabled,
        })`),
      ),
    );
    check('未来的日子被标出来了', future.marked > 0, `标了 ${future.marked} 个`);
    check('未来的日子一个都点不了', future.clickable === 0, `还能点 ${future.clickable} 个`);
    check('在当月时「下个月」箭头是禁用的', future.nextDisabled === true);

    // 回到本月，确认「今天」那格是能点的
    await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => /回到今天/.test(x.textContent)); b?.click(); })()`);
    await sleep(1200);
    check(
      '今天那一格照常能点',
      (await ev(`!document.querySelector('.cal-day.is-today')?.disabled`)) === true,
    );

    // 换月：先往前翻一个月，确认能翻、也能翻回来
    // 注意要比「月份标题变了」——之前拿它跟 YYYY-MM 格式的日期比，
    // 两种格式永远不相等，断言恒为真，等于没测
    const monthNow = await ev(`document.querySelector('.cal-title b')?.innerText`);
    await ev(`document.querySelectorAll('.cal-nav')[0]?.click()`);
    await sleep(1500);
    const monthPrev = await ev(`document.querySelector('.cal-title b')?.innerText`);
    check('点左箭头能翻到上个月', !!monthPrev && monthPrev !== monthNow, `${monthNow} → ${monthPrev}`);
    check('翻到过去之后「下个月」箭头恢复可用', (await ev(`document.querySelectorAll('.cal-nav')[1]?.disabled`)) === false);
    await ev(`document.querySelectorAll('.cal-nav')[1]?.click()`);
    await sleep(1500);
    const monthBack = await ev(`document.querySelector('.cal-title b')?.innerText`);
    check('点右箭头能翻回来', monthBack !== monthPrev, `回到 ${monthBack}`);

    // 选一天：现在不再跳去日历页，而是把下面的时间线滚到那天
    const picked = await ev(`
      (() => {
        const days = Array.from(document.querySelectorAll('.cal-day:not(.is-blank)'));
        const withData = days.find((d) => d.querySelector('.cal-dot'));
        const target = withData || days[9];
        const label = target.getAttribute('aria-label') || '';
        target.click();
        return label;
      })()
    `);
    await sleep(2500);
    const selectedInfo = await ev(`JSON.stringify({
      selectedNum: document.querySelector('.cal-day.is-selected .cal-num')?.innerText,
      scrolled: window.scrollY,
      dayHeadY: (() => { const d = document.querySelector('.cal-day.is-selected')?.getAttribute('aria-label')?.slice(0, 10); const el = d && document.querySelector('[data-date="' + d + '"]'); return el ? Math.round(el.getBoundingClientRect().top) : null; })(),
      entries: document.querySelectorAll('.entry').length
    })`);
    const sel = typeof selectedInfo === 'string' ? JSON.parse(selectedInfo) : {};
    check('点某天会在日历上选中它', !!sel.selectedNum, JSON.stringify(sel));
    check('点某天会把时间线滚到那天', sel.dayHeadY !== null && sel.dayHeadY < 260, `那天标题在视口 y=${sel.dayHeadY}`);
    check('时间线里有记录', sel.entries > 0, `${sel.entries} 条`);
    await shot('02-过往-选中某天');

    // 键盘换月
    const monthBeforeKey = await ev(`document.querySelector('.cal-title b')?.innerText`);
    await send(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 }, S);
    await send(ws, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 }, S);
    await sleep(1500);
    const monthKey = await ev(`document.querySelector('.cal-title b')?.innerText`);
    check('键盘左键能换月', monthKey !== monthBeforeKey, `${monthBeforeKey} → ${monthKey}`);

    // 回到今天
    const todayBtn = await ev(`!!Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('回到今天'))`);
    if (todayBtn) {
      await ev(`Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('回到今天')).click()`);
      await sleep(1500);
      check('「回到今天」能跳回本月', (await ev(`!!document.querySelector('.cal-day.is-today')`)) === true);
    } else {
      check('本月有「回到今天」按钮或已在本月', await ev(`!!document.querySelector('.cal-day.is-today')`));
    }

    // ---------- 找回页交互（检索 + 问答合并后） ----------
    console.log('\n  \x1b[36m· 找回页交互\x1b[0m');
    await ev(`location.hash='#/find'`);
    await sleep(2200);

    const composerBox = await ev(`
      (() => {
        const c = document.querySelector('.ask-box');
        if (!c) return 'no-askbox';
        const r = c.getBoundingClientRect();
        return JSON.stringify({ top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), vw: window.innerWidth, vh: window.innerHeight });
      })()
    `);
    const cb = typeof composerBox === 'string' && composerBox.startsWith('{') ? JSON.parse(composerBox) : null;
    check('找回页有输入区', !!cb, String(composerBox));
    if (cb) {
      check('输入区没有超出视口左右', cb.left >= -2 && cb.right <= cb.vw + 2, `left=${cb.left} right=${cb.right} vw=${cb.vw}`);
    }

    // 打字出结果
    const typed = await ev(`
      (() => {
        const i = document.querySelector('.ask-box input');
        if (!i) return 'no-input';
        const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        s.call(i, '找回页面');
        i.dispatchEvent(new Event('input', { bubbles: true }));
        return 'ok';
      })()
    `);
    check('能往输入框里打字', typed === 'ok', String(typed));
    let hitNow = 0;
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      hitNow = Number(await ev(`document.querySelectorAll('.results .hit').length`));
      if (hitNow > 0) break;
    }
    check('打字立刻出检索结果', hitNow > 0, `命中 ${hitNow} 条`);

    // 问 AI → 等流结束 + 依据记录
    await ev(`(()=>{const i=document.querySelector('.ask-box input');const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(i,'今天做了什么？');i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await sleep(500);
    await ev(`document.querySelector('.ask-btn')?.click()`);
    let answer = '';
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      answer = String((await ev(`document.querySelector('.bubble.ai .md')?.innerText || ''`)) || '');
      const done = (await ev(`!document.querySelector('.typing-caret')`)) === true;
      if (answer.length > 20 && done) break;
    }
    check('能收到 AI 回答', answer.length > 20, `长度 ${answer.length}`);
    let citedNow = 0;
    for (let i = 0; i < 20; i++) {
      citedNow = Number(await ev(`document.querySelectorAll('.cited-item').length`));
      if (citedNow > 0) break;
      await sleep(500);
    }
    check('回答下列出依据的记录', citedNow > 0, `列出 ${citedNow} 条`);
    await shot('03-找回-回答');

    // ---------- 各按钮是否真的可点 ----------
    console.log('\n  \x1b[36m· 可点性\x1b[0m');
    const clicks = await ev(`
      (() => {
        const out = {};
        // 底部导航
        out.tabs = document.querySelectorAll('.tabbar a').length;
        out.hasFab = !!document.querySelector('.tabbar .fab-main');
        // 卡片操作按钮
        document.querySelector('.tabbar a')?.click();
        return JSON.stringify(out);
      })()
    `);
    const cl = typeof clicks === 'string' ? JSON.parse(clicks) : {};
    check('底部导航齐全', cl.tabs >= 4, JSON.stringify(cl));
    check('中间有「记一记」大按钮', cl.hasFab === true);

    // 大按钮点开是个选择层：写一条 / 说一句
    await ev(`document.querySelector('.tabbar .fab-main')?.click()`);
    await sleep(700);
    const picks = await ev(
      `JSON.stringify([...document.querySelectorAll('.pick-item')].map((b) => b.innerText.replace(/\\s+/g, ' ').trim()))`,
    );
    const pk = JSON.parse(String(picks));
    check('「记一记」里有两个入口', pk.length === 2, JSON.stringify(pk));
    check('两个入口是「写一条」和「说一句」', /写一条/.test(pk[0] || '') && /说一句/.test(pk[1] || ''), JSON.stringify(pk));
    await shot('05-记一记-选择');
    await ev(`document.querySelector('.pick-sheet .pick-cancel')?.click()`);
    await sleep(500);

    await sleep(1500);
    const recOpened = await ev(`
      (() => {
        window.dispatchEvent(new CustomEvent('sg:record'));
        return 'sent';
      })()
    `);
    await sleep(1000);
    check('记录弹层能打开', await ev(`!!document.querySelector('.recorder')`));
    await ev(`document.querySelector('.recorder .icon-btn')?.click()`);
    await sleep(600);

    await ev(`window.dispatchEvent(new CustomEvent('sg:voice'))`);
    await sleep(1000);
    check('语音弹层能打开', await ev(`!!document.querySelector('.voice-sheet')`));
    await ev(`document.querySelector('.voice-sheet .icon-btn')?.click()`);
    await sleep(600);

    // ---------- 桌面端找回页（之前输入区溢出过） ----------
    console.log('\n  \x1b[36m· 桌面端布局\x1b[0m');
    await setViewport(1360, 900, false);
    await ev(`location.hash='#/find'`);
    await sleep(2200);
    const deskBox = await ev(`
      (() => {
        const c = document.querySelector('.ask-box');
        if (!c) return 'none';
        const r = c.getBoundingClientRect();
        return JSON.stringify({ left: Math.round(r.left), right: Math.round(r.right), vw: window.innerWidth, w: Math.round(r.width) });
      })()
    `);
    const db = typeof deskBox === 'string' && deskBox.startsWith('{') ? JSON.parse(deskBox) : null;
    check('桌面端输入区不溢出', !!db && db.right <= db.vw + 2 && db.left >= -2, String(deskBox));
    await shot('04-找回-桌面');

    // ---------- 清理自己造的种子数据 ----------
    await cleanupSeed();
    console.log('\n  （已清理测试种子数据）');

    // ---------- 控制台 ----------
    console.log('\n  \x1b[36m· 控制台\x1b[0m');
    const realErrors = consoleErrors.filter((e) => !/favicon|manifest|sw\.js|ERR_|Failed to load resource/i.test(e));
    check('没有未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
    check('没有控制台报错', realErrors.length === 0, realErrors.slice(0, 2).join(' | '));
  } finally {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    proc.kill('SIGKILL');
  }

  console.log(`\n\x1b[1m${failed === 0 ? '\x1b[32m交互测试全部通过' : '\x1b[31m有失败项'}\x1b[0m  ${pass} 通过 / ${failed} 失败\n`);
  if (failures.length) console.log(`失败项：${failures.join('、')}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\x1b[31m交互测试异常：\x1b[0m', e.message);
  process.exit(2);
});
