// =============================================================
// 拾光 · 边界场景测试
// 真实使用里最容易崩的不是正常路径，而是这些：
//   · 一条记录都没有（新用户第一眼）
//   · 内容特别长 / 特别短
//   · 一天记很多条
//   · 跨月、跨年、闰年、月末 31 号
//   · 检索无结果、标签为空
// 每一条都检查：页面不白屏、不报错、关键元素在
//
// 用法：node scripts/verify-edge.mjs [baseUrl]
// =============================================================

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const BASE = (argv.find((a) => !a.startsWith('--')) || process.env.BASE || 'http://127.0.0.1:8791').replace(/\/+$/, '');
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

const PORT = 9430;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.shots-edge');

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
      // 模拟一个麦克风，否则 headless 里 getUserMedia 直接失败，
      // 「点一下就开录」这类用例会假失败
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--force-device-scale-factor=2',
      `--user-data-dir=${path.join(os.tmpdir(), 'sg-edge')}`,
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
  await send(ws, 'Emulation.setDeviceMetricsOverride', { width: 412, height: 900, deviceScaleFactor: 2, mobile: true }, S);

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
   * 注意：这个用例会清空全部记录（为了测「新用户第一眼」），
   * 所以必须在其它测试之前跑，或者跑完自己把数据补回来。
   * 这里用 SEED_AFTER 环境变量控制是否在结束时留一条演示数据。
   */

  /** 直接用接口造数据 / 清空数据 */
  const api = async (js) => ev(`(async () => { const m = location.pathname.match(/^(.*\\/shiguang)\\//); const api = (m ? m[1] : '') + '/api'; ${js} })()`);
  const clearAll = () =>
    api(`
      const list = await fetch(api + '/entries?limit=2000', { credentials: 'include' }).then(r => r.json());
      for (const e of list.data.entries) {
        for (const a of e.attachments || []) await fetch(api + '/audio/' + a.id, { method: 'DELETE', credentials: 'include' }).catch(()=>{});
        await fetch(api + '/entries/' + e.id, { method: 'DELETE', credentials: 'include' });
      }
      return 'cleared';
    `);
  const addEntry = (content, date, tags = []) =>
    api(`
      const r = await fetch(api + '/entries', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: ${JSON.stringify(content)}, date: ${JSON.stringify(date)}, tags: ${JSON.stringify(tags)}, createdAt: new Date(${JSON.stringify(date)} + 'T12:00:00').getTime() }),
      }).then(x => x.json());
      return r.ok ? r.data.entry.id : 'fail';
    `);

  try {
    console.log(`\n\x1b[36m拾光 · 边界场景测试\x1b[0m  ${BASE}\n`);

    await send(ws, 'Page.navigate', { url: `${BASE}/` }, S);
    await sleep(3500);
    // 注销 Service Worker 并清掉它 precache 的页面。
    // 只注销不清缓存的话，浏览器可能还在跑上一版构建，
    // 测出来的「失败」其实是旧代码的，排查方向会被带偏。
    await send(ws, 'Runtime.evaluate', { expression: `(async () => { try { const rs = await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map(r => r.unregister())); const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); } catch {} })()`, awaitPromise: true }, S);
    await sleep(400);
    // 清缓存只解决了下一次导航；当前页面还跑着旧的 index.html 引用的 JS。
    // 不马上重载的话，测的可能是一个已经不存在的文件（页面全白，全是假失败）。
    await send(ws, 'Page.navigate', { url: `${BASE}/` }, S);
    await sleep(3000);
    for (let i = 0; i < 8; i++) {
      if (await ev(`!!document.querySelector('.shell')`)) break;
      await ev(LOGIN_JS);
      await sleep(400);
      await ev(`document.querySelector('.gate .btn-primary')?.click()`);
      await sleep(2200);
    }
    check('登录成功', await ev(`!!document.querySelector('.shell')`));

    // ---------- 1. 完全空数据 ----------
    console.log('\n  \x1b[36m· 空数据（新用户第一眼）\x1b[0m');
    await clearAll();
    await ev(`location.hash='#/'`);
    await sleep(500);
    await ev(`location.reload()`);
    await sleep(4000);

    for (const [name, hash] of [
      ['过往', '#/'],
      ['拾迹', '#/find'],
      ['统计', '#/stats'],
      ['我的', '#/mine'],
    ]) {
      await ev(`location.hash='${hash}'`);
      await sleep(2000);
      const state = await ev(`JSON.stringify({
        textLen: (document.querySelector('main')?.innerText || '').length,
        hasEmpty: !!document.querySelector('.empty'),
        hasError: /出错了|Error|undefined|NaN/.test(document.querySelector('main')?.innerText || '')
      })`);
      const st = typeof state === 'string' ? JSON.parse(state) : {};
      check(`空数据下「${name}」页有内容且不报错`, st.textLen > 10 && !st.hasError, JSON.stringify(st));
    }
    await shot('01-空状态-统计');

    // 空状态里那两个按钮得真能点 —— 一条记录都没有的时候，
    // 「说一句」是最可能被点的那个（心情差的时候没人想打字）
    await ev(`location.hash='#/'`);
    await sleep(1200);
    const emptyBtns = await ev(`
      (() => {
        const names = Array.from(document.querySelectorAll('.empty .empty-actions .btn'))
          .map(b => b.innerText.trim());
        const mic = Array.from(document.querySelectorAll('.empty .empty-actions .btn'))
          .find(b => /说一句/.test(b.innerText));
        mic?.click();
        return JSON.stringify(names);
      })()
    `);
    await sleep(2500);
    check('空状态给出「记一笔」和「说一句」两条路', /记一笔/.test(String(emptyBtns)) && /说一句/.test(String(emptyBtns)), String(emptyBtns));
    check('空状态点「说一句」直接进录音', await ev(`!!document.querySelector('.voice-sheet .rec-btn.is-stop')`));
    await ev(`document.querySelector('.voice-sheet .icon-btn[title="关闭"]')?.click()`);
    await sleep(600);

    // ---------- 2. 超长内容 ----------
    console.log('\n  \x1b[36m· 超长 / 超短内容\x1b[0m');
    // 必须用「本地」日期：界面上按本地日期分组，
    // 用 toISOString() 拿的是 UTC，跨时区会差一天（这就是刚才误报的原因）
    const today = await ev(`
      (() => { const d = new Date(); const p = (n) => String(n).padStart(2,'0');
        return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()); })()
    `);
    const longText = '这是一段很长的记录内容，用来测试换行和折叠是否正常。'.repeat(40);
    await addEntry(longText, today, ['压测']);
    await addEntry('短', today, []);
    await addEntry('带 emoji 和特殊符号 <>&"\' 的记录 🎉🔥', today, ['符号']);
    await ev(`location.hash='#/'`);
    await sleep(1000);
    await ev(`location.reload()`);
    await sleep(4000);

    const longOk = await ev(`JSON.stringify({
      overflow: document.documentElement.scrollWidth > window.innerWidth + 2,
      hasClamp: !!document.querySelector('.entry-content.clamp'),
      hasExpand: !!document.querySelector('.entry .expand')
    })`);
    const lo = typeof longOk === 'string' ? JSON.parse(longOk) : {};
    check('超长内容不撑破页面', !lo.overflow, JSON.stringify(lo));
    check('超长内容默认折叠', lo.hasClamp === true);
    check('超长内容可展开', lo.hasExpand === true);
    await shot('02-超长内容');

    // 展开看看
    await ev(`document.querySelector('.entry .expand')?.click()`);
    await sleep(800);
    check('展开后不溢出', (await ev(`document.documentElement.scrollWidth <= window.innerWidth + 2`)) === true);

    // ---------- 3. 一天记很多条 ----------
    console.log('\n  \x1b[36m· 一天记很多条\x1b[0m');
    const ids = [];
    for (let i = 1; i <= 15; i++) {
      const id = await addEntry(`压测第 ${i} 条：这一天发生了很多事情`, today, ['压测']);
      if (typeof id === 'string' && id !== 'fail') ids.push(id);
    }
    await ev(`location.reload()`);
    await sleep(4500);
    // 诊断：这 15 条到底落在哪一天
    const diag = await api(`
      const list = await fetch(api + '/entries?limit=2000', { credentials: 'include' }).then(r => r.json());
      const byDate = {};
      for (const e of list.data.entries) byDate[e.date] = (byDate[e.date] || 0) + 1;
      const todayLocal = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const localToday = todayLocal.getFullYear() + '-' + pad(todayLocal.getMonth()+1) + '-' + pad(todayLocal.getDate());
      return JSON.stringify({ total: list.data.entries.length, byDate, localToday, browserUTC: new Date().toISOString().slice(0,10) });
    `);
    if (!process.env.EDGE_VERBOSE) { /* 诊断信息仅在需要时看 */ } else { console.log(`     [诊断] ${diag}`); }

    const manyState = await ev(`JSON.stringify({
      count: document.querySelectorAll('.entry').length,
      overflow: document.documentElement.scrollWidth > window.innerWidth + 2,
      badge: document.querySelector('.cal-day.is-today .cal-dot') ? 'dot' : ''
    })`);
    const ms = typeof manyState === 'string' ? JSON.parse(manyState) : {};
    check('多条记录都能渲染', ms.count >= 15, `渲染 ${ms.count} 条`);
    check('多条记录不撑破页面', !ms.overflow);
    await shot('03-一天多條');

    // 日历格子的「有记录」标记（数据是异步加载的，要轮询等它出现）。
    // 现在格子上放的是一个小圆点 + 强度底色，条数写在 aria-label 里。
    await ev(`location.hash='#/'`);
    let badge = '';
    let dots = 0;
    for (let i = 0; i < 20; i++) {
      await sleep(600);
      const st = JSON.parse(String(await ev(`JSON.stringify({
        label: document.querySelector('.cal-day.is-today')?.getAttribute('aria-label') || '',
        dots: document.querySelectorAll('.cal-day .cal-dot').length,
      })`)));
      badge = (st.label.match(/，(\d+) 条记录/) || [])[1] || '';
      dots = st.dots;
      if (badge) break;
    }
    // 不写死数字：前面几组用例也在同一天留了数据
    check('日历格子标出当天条数', Number(badge) >= 15, `今天(${today})显示「${badge}」`);
    check('有记录的格子带小圆点', dots > 0, `圆点 ${dots} 个`);
    await shot('04-日历-高密度');

    // ---------- 4. 跨月 / 跨年 / 闰年 ----------
    console.log('\n  \x1b[36m· 日期边界\x1b[0m');
    await addEntry('跨年记录', '2025-12-31', ['边界']);
    await addEntry('闰日记录', '2024-02-29', ['边界']);
    await addEntry('月末记录', '2026-01-31', ['边界']);
    await ev(`location.reload()`);
    await sleep(4000);

    // 逐月翻，看有没有崩
    await ev(`location.hash='#/'`);
    await sleep(2200);
    let monthIssues = [];
    for (let i = 0; i < 14; i++) {
      await ev(`document.querySelectorAll('.cal-nav')[0]?.click()`);
      await sleep(900);
      const st = await ev(`JSON.stringify({
        title: document.querySelector('.cal-title b')?.innerText || '',
        cells: document.querySelectorAll('.cal-day:not(.is-blank)').length,
        overflow: document.documentElement.scrollWidth > window.innerWidth + 2
      })`);
      const s2 = typeof st === 'string' ? JSON.parse(st) : {};
      if (!s2.title || s2.cells < 28 || s2.cells > 31 || s2.overflow) {
        monthIssues.push(`${s2.title}(格子${s2.cells}${s2.overflow ? ' 溢出' : ''})`);
      }
    }
    check('连续翻 14 个月都正常', monthIssues.length === 0, monthIssues.join('; '));

    // 闰年 2 月应有 29 天
    const leap = await ev(`
      (async () => {
        // 直接问接口：2024-02 的日历
        const m = location.pathname.match(/^(.*\\/shiguang)\\//);
        const api = (m ? m[1] : '') + '/api';
        const r = await fetch(api + '/calendar?month=2024-02', { credentials: 'include' }).then(x => x.json());
        return JSON.stringify({ ok: r.ok, count: Object.keys(r.data?.counts || {}).length });
      })()
    `);
    const lp = typeof leap === 'string' ? JSON.parse(leap) : {};
    check('闰年 2 月接口正常', lp.ok === true, JSON.stringify(lp));

    // ---------- 5. 检索边界 ----------
    console.log('\n  \x1b[36m· 检索边界\x1b[0m');
    await ev(`location.hash='#/find'`);
    await sleep(1800);
    for (const [q, desc] of [
      ['zzzz不存在的词zzzz', '无结果'],
      ['a', '单字符'],
      ['   ', '纯空格'],
      ['🎉', 'emoji'],
      ['<script>alert(1)</script>', '特殊字符'],
    ]) {
      await ev(`(() => { const i = document.querySelector('.ask-box input'); const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; s.call(i, ${JSON.stringify(q)}); i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
      await sleep(1600);
      const st = await ev(`JSON.stringify({ textLen: (document.querySelector('main')?.innerText||'').length, raw: /undefined|NaN|\\[object/.test(document.querySelector('main')?.innerText||'') })`);
      const s3 = typeof st === 'string' ? JSON.parse(st) : {};
      check(`检索「${desc}」不崩且无脏数据`, s3.textLen > 5 && !s3.raw, JSON.stringify(s3));
    }
    await shot('05-检索特殊字符');

    // ---------- 6. 清理 ----------
    console.log('\n  \x1b[36m· 清理压测数据\x1b[0m');
    const cleared = await clearAll();
    check('压测数据已清理', cleared === 'cleared');

    // ---------- 收尾：需要的话补一条演示数据 ----------
    if (process.env.SEED_AFTER === '1') {
      await addEntry('演示数据：边界测试收尾时留下的一条记录', today, ['演示']);
      console.log('\n  （已留下一条演示数据）');
    }

    // ---------- 控制台 ----------
    console.log('\n  \x1b[36m· 控制台\x1b[0m');
    const realErrors = consoleErrors.filter((e) => !/favicon|manifest|sw\.js|ERR_|Failed to load resource/i.test(e));
    check('没有未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
    check('没有控制台报错', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
  } finally {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    proc.kill('SIGKILL');
  }

  console.log(`\n\x1b[1m${failed === 0 ? '\x1b[32m边界测试全部通过' : '\x1b[31m有失败项'}\x1b[0m  ${pass} 通过 / ${failed} 失败\n`);
  if (failures.length) console.log(`失败项：${failures.join('、')}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\x1b[31m边界测试异常：\x1b[0m', e.message);
  process.exit(2);
});
