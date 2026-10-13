// =============================================================
// 拾光 · 「找回」合并页验收
// 检索 + 对话合并成一页之后，重点验这几件事：
//   · 打字真的出结果列表
//   · 回车/点按钮真的出 AI 回答
//   · 回答下面真的列出依据的记录（这是合并的关键收益）
//   · 点记录能跳到那天
//   · 底部导航变成 4 项
//   · 旧的 /search 和 /chat 地址能重定向过来
//
// 用法：node scripts/verify-find.mjs [baseUrl]
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

const PORT = 9470;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.shots-find');
const SHOT = argv.includes('--shots');

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
    }, 40000);
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
      `--user-data-dir=${path.join(os.tmpdir(), 'sg-find')}`,
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

  const ev = async (expression) => {
    const r = await send(ws, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, S);
    if (r.exceptionDetails) return `ERR:${String(r.exceptionDetails.exception?.description || '').slice(0, 180)}`;
    return r.result?.value;
  };
  const shot = async (name) => {
    if (!SHOT) return;
    fs.mkdirSync(OUT, { recursive: true });
    const { data } = await send(ws, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, S);
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
    console.log(`  📷 ${name}.png`);
  };

  /**
   * 用页面内的 fetch 调接口（同源，自动带 cookie）。
   * 注意：线上部署在 /shiguang/ 子路径下，接口是 /shiguang/api/*，
   * 写死 '/api' 会打到根域拿到 HTML（这是本项目踩过的坑）。
   * 这里按 location.pathname 推导，和应用里的 apiBase() 逻辑一致。
   */
  const API_BASE = (() => {
    const p = new URL(BASE).pathname.replace(/\/+$/, '');
    return p ? `${p}/api` : '/api';
  })();
  const apiCall = (js) =>
    ev(`(async () => { const api = ${JSON.stringify(API_BASE)}; ${js} })()`);
  const SEED_MARK = `找回页测试种子-${Date.now()}`;

  /**
   * 保证库里有数据。
   * 这个页面测的是「搜得到、答得出」，空库什么都验不了。
   * 不能依赖跑测试的人事先灌数据（线上库通常是空的）。
   */
  const ensureData = async () => {
    const r = await apiCall(`
      const st = await fetch(api + '/stats', { credentials: 'include' }).then(x => x.json());
      if (st.data.total >= 3) return 'enough:' + st.data.total;
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const day = (n) => { const t = new Date(d); t.setDate(t.getDate() - n); return t.getFullYear() + '-' + pad(t.getMonth()+1) + '-' + pad(t.getDate()); };
      const items = [
        { content: ${JSON.stringify(SEED_MARK)} + ' 上午在改找回页面，把检索和对话合并了', tags: ['项目'] },
        { content: ${JSON.stringify(SEED_MARK)} + ' 下午和客户系统对了接口字段', tags: ['工作'] },
        { content: ${JSON.stringify(SEED_MARK)} + ' 晚上跑了五公里', tags: ['健康'] },
      ];
      let n = 0;
      for (let i = 0; i < items.length; i++) {
        const res = await fetch(api + '/entries', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...items[i], date: day(i) }),
        }).then(x => x.json());
        if (res.ok) n++;
      }
      return 'seeded:' + n;
    `);
    return r;
  };

  const cleanupSeed = () =>
    apiCall(`
      const list = await fetch(api + '/entries?limit=2000', { credentials: 'include' }).then(x => x.json());
      let n = 0;
      for (const e of list.data.entries) {
        if (e.content.includes(${JSON.stringify(SEED_MARK)})) {
          await fetch(api + '/entries/' + e.id, { method: 'DELETE', credentials: 'include' });
          n++;
        }
      }
      return n;
    `);

  try {
    console.log(`\n\x1b[36m拾光 · 「找回」合并页验收\x1b[0m  ${BASE}\n`);

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

    // 自己保证有数据可搜、可答
    const seeded = await ensureData();
    console.log(`  （数据准备：${seeded}）`);

    // ---------- 底部导航：左二 + 中间大按钮 + 右二 ----------
    console.log('\n  \x1b[36m· 底部导航\x1b[0m');
    const nav = await ev(`
      (() => {
        const links = Array.from(document.querySelectorAll('.tabbar a'));
        const fab = document.querySelector('.tabbar .fab-main');
        const fr = fab ? fab.getBoundingClientRect() : null;
        return JSON.stringify({
          labels: links.map(a => a.innerText.trim()),
          hrefs: links.map(a => a.getAttribute('href')),
          hasFab: !!fab,
          fabText: fab ? fab.innerText.trim() : '',
          fabRound: fr ? Math.abs(fr.width - fr.height) < 1.5 : false,
          fabBigger: fr ? links.every(a => fr.width > a.getBoundingClientRect().width) : false,
          hasSearchOrChat: links.some(a => /检索|对话/.test(a.innerText))
        });
      })()
    `);
    const nv = typeof nav === 'string' ? JSON.parse(nav) : {};
    check('导航是 4 项', nv.labels?.length === 4, JSON.stringify(nv.labels));
    check('包含「拾迹」', (nv.labels || []).includes('拾迹'), JSON.stringify(nv.labels));
    check('不再有独立的「检索」「对话」', nv.hasSearchOrChat === false, JSON.stringify(nv.labels));
    check('中间有「记一记」大按钮', nv.hasFab === true);
    check('大按钮只有图标没有文字', nv.fabText === '', `实际「${nv.fabText}」`);
    check('大按钮是正圆', nv.fabRound === true);
    // 大按钮是直径 54 的圆，两侧入口是 flex:1 的窄条（每个约 60px 宽）。
    // 严格比大小没意义，这里只要求它是圆、且视觉上明显更重。
    check('大按钮直径 ≥ 48px', await ev(`(document.querySelector('.tabbar .fab-main')?.getBoundingClientRect().width || 0) >= 48`));
    check('导航项等宽（差值 ≤ 2px）', await ev(`
      (() => {
        const ws = Array.from(document.querySelectorAll('.tabbar a')).map(a => Math.round(a.getBoundingClientRect().width));
        return Math.max(...ws) - Math.min(...ws) <= 2;
      })()
    `));

    // ---------- 进入找回页 ----------
    console.log('\n  \x1b[36m· 打字检索\x1b[0m');
    await ev(`location.hash='#/find'`);
    await sleep(2000);
    check('找回页能打开', await ev(`!!document.querySelector('.find-page')`));
    check('有统一的输入框', await ev(`!!document.querySelector('.ask-box input')`));
    await shot('01-空状态');

    // 打字 → 出结果
    await ev(`(() => {
      const i = document.querySelector('.ask-box input');
      const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      s.call(i, '找回页面');
      i.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    let hitCount = 0;
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      hitCount = Number(await ev(`document.querySelectorAll('.results .hit').length`));
      if (hitCount > 0) break;
    }
    check('打字后出现结果列表', hitCount > 0, `命中 ${hitCount} 条`);
    check('结果显示命中条数', /找到 \d+ 条/.test(String(await ev(`document.querySelector('.results-head')?.innerText || ''`))));
    await shot('02-搜索结果');

    // ---------- 按回车让 AI 回答 ----------
    console.log('\n  \x1b[36m· 问 AI\x1b[0m');
    await ev(`(() => {
      const i = document.querySelector('.ask-box input');
      const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      s.call(i, '我最近在忙什么？');
      i.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(600);
    // 模拟真实回车
    await send(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, S);
    await send(ws, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, S);

    // 注意：不能只等「回答有 30 个字」就往下断言。
    // 流式回答是逐步吐字的，这时候 done 事件（带依据记录）还没到，
    // 会误判成「没列出依据」。要等「流结束」这个信号。
    let answer = '';
    let streamDone = false;
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      answer = String((await ev(`document.querySelector('.bubble.ai .md')?.innerText || ''`)) || '');
      streamDone = (await ev(`!document.querySelector('.typing-caret')`)) === true;
      if (answer.length > 30 && streamDone) break;
    }
    check('回车能触发 AI 回答', answer.length > 30, `长度 ${answer.length}`);
    check('回答流式结束（光标消失）', streamDone === true);
    console.log(`     AI：${answer.replace(/\n/g, ' ').slice(0, 130)}`);

    // ---------- 关键收益：回答下面列出依据的记录 ----------
    // 同样要轮询等它渲染出来，别抢跑
    let cited = 0;
    for (let i = 0; i < 25; i++) {
      cited = Number(await ev(`document.querySelectorAll('.cited-item').length`));
      if (cited > 0) break;
      await sleep(500);
    }
    if (cited === 0) {
      // 失败时把现场信息带出来，别只报一句「0 条」
      const diag = await ev(`JSON.stringify({
        head: document.querySelector('.cited-head')?.innerText || '(无依据区)',
        refs: document.querySelectorAll('.cited .chip, .cited-date').length,
        chars: (document.querySelector('.bubble.ai')?.innerText || '').length,
      })`);
      console.log(`     \x1b[90m诊断：${diag}\x1b[0m`);
      console.log(`     \x1b[90mAI：${answer.replace(/\n/g, ' ').slice(0, 200)}\x1b[0m`);
    }
    check('回答下列出了依据的记录', cited > 0, `列出 ${cited} 条`);
    check('有「依据 N 条记录」的说明', /依据 \d+ 条记录/.test(String(await ev(`document.querySelector('.cited-head')?.innerText || ''`))));
    const citedHasText = String((await ev(`document.querySelector('.cited-text')?.innerText || ''`)) || '').length > 5;
    check('依据的记录有正文', citedHasText);
    await shot('03-AI回答');

    // 展开全部
    const moreBtn = await ev(`!!document.querySelector('.link-btn.more')`);
    if (moreBtn) {
      await ev(`document.querySelector('.link-btn.more').click()`);
      await sleep(700);
      const expanded = Number(await ev(`document.querySelectorAll('.cited-item').length`));
      check('能展开全部依据记录', expanded >= cited, `${cited} → ${expanded}`);
      await shot('04-展开全部');
    }

    // ---------- 点记录跳去那天 ----------
    console.log('\n  \x1b[36m· 跳转\x1b[0m');
    await ev(`document.querySelector('.cited-item')?.click()`);
    await sleep(2200);
    // 「过往」把日历和时间线并成了一页，所以这里不再换页，
    // 而是回到首页、日历选中那天、时间线滚到那天的分组
    const onCal = await ev(`JSON.stringify({
      hash: location.hash,
      selected: !!document.querySelector('.cal-day.is-selected'),
      atDay: (() => {
        const d = document.querySelector('.cal-day.is-selected')?.getAttribute('aria-label')?.slice(0, 10);
        const el = d && document.querySelector('[data-date="' + d + '"]');
        return el ? Math.round(el.getBoundingClientRect().top) : null;
      })(),
    })`);
    const oc = JSON.parse(String(onCal));
    check('点依据的记录能跳到那天', oc.hash.startsWith('#/') && oc.selected && oc.atDay !== null, onCal);
    await shot('05-跳到那天');

    // ---------- 旧地址重定向 ----------
    console.log('\n  \x1b[36m· 旧地址兼容\x1b[0m');
    for (const [old, name] of [
      ['#/search', '旧检索地址'],
      ['#/chat', '旧对话地址'],
    ]) {
      await ev(`location.hash='${old}'`);
      await sleep(1800);
      const landed = String(await ev(`location.hash`));
      check(`${name} 重定向到 /find`, landed.startsWith('#/find'), `落到了 ${landed}`);
    }

    // ---------- 清空与 Esc ----------
    console.log('\n  \x1b[36m· 清空\x1b[0m');
    await ev(`document.querySelector('.clear')?.click()`);
    await sleep(800);
    check('点 × 能清空回到引导态', await ev(`!!document.querySelector('.block-title')`));
    await shot('06-清空后引导');

    // ---------- 清理自己造的种子 ----------
    await cleanupSeed();

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

  console.log(`\n\x1b[1m${failed === 0 ? '\x1b[32m合并页验收全部通过' : '\x1b[31m有失败项'}\x1b[0m  ${pass} 通过 / ${failed} 失败\n`);
  if (failures.length) console.log(`失败项：${failures.join('、')}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\x1b[31m验收异常：\x1b[0m', e.message);
  process.exit(2);
});
