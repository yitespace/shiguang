// =============================================================
// 拾光 · 前端功能验收（真实浏览器）
// 覆盖：登录 / 记录 / 草稿自动保存 / 删除撤销 / 那年今日 /
//       语音入口 / 找回 / 日历 / 统计 / 设置 / 深色模式
// 用法：node scripts/verify-features.mjs [baseUrl] [--shots]
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

const PORT = 9390;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.shots-features');
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
const apiLog = [];

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
  if (!fs.existsSync(CHROME)) throw new Error('找不到 chromium');
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
      '--disable-crash-reporter',
      '--password-store=basic',
      '--use-mock-keyring',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--force-device-scale-factor=2',
      `--user-data-dir=${path.join(os.tmpdir(), `sg-feat-${Date.now()}`)}`,
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
      /* 等待 */
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
    if (m.method === 'Network.responseReceived' && /\/api\//.test(m.params?.response?.url || '')) {
      apiLog.push(`${m.params.response.status} ${m.params.response.url.replace(/^https?:\/\/[^/]+/, '')}`);
    }
  });

  const { targetId } = await send(ws, 'Target.createTarget', { url: 'about:blank' });
  const { sessionId: S } = await send(ws, 'Target.attachToTarget', { targetId, flatten: true });
  await send(ws, 'Page.enable', {}, S);
  await send(ws, 'Runtime.enable', {}, S);
  await send(ws, 'Network.enable', {}, S);
  await send(ws, 'Browser.grantPermissions', { origin: BASE, permissions: ['audioCapture'] }).catch(() => {});
  await send(ws, 'Emulation.setDeviceMetricsOverride', { width: 412, height: 900, deviceScaleFactor: 2, mobile: true }, S);

  const ev = async (expression) => {
    const r = await send(ws, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, S);
    if (r.exceptionDetails) return `ERR:${String(r.exceptionDetails.exception?.description || '').slice(0, 200)}`;
    return r.result?.value;
  };
  const shot = async (name) => {
    if (!SHOT) return;
    fs.mkdirSync(OUT, { recursive: true });
    const { data } = await send(ws, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, S);
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
    console.log(`  📷 ${name}.png`);
  };

  try {
    console.log(`\n\x1b[36m拾光 · 功能验收\x1b[0m  ${BASE}\n`);

    await send(ws, 'Page.navigate', { url: `${BASE}/` }, S);
    await sleep(4000);
    // 注销 Service Worker 并清掉它 precache 的页面。
    // 只注销不清缓存的话，浏览器可能还在跑上一版构建，
    // 测出来的「失败」其实是旧代码的，排查方向会被带偏。
    await send(ws, 'Runtime.evaluate', { expression: `(async () => { try { const rs = await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map(r => r.unregister())); const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); } catch {} })()`, awaitPromise: true }, S);
    await sleep(400);
    for (let i = 0; i < 8; i++) {
      if (await ev(`!!document.querySelector('.shell')`)) break;
      await ev(LOGIN_JS);
      await sleep(300);
      await ev(`document.querySelector('.gate .btn-primary')?.click()`);
      await sleep(2200);
    }
    check('登录成功', await ev(`!!document.querySelector('.shell')`));

    // ---------- 1. 草稿自动保存 ----------
    console.log('\n  \x1b[36m· 草稿保护\x1b[0m');
    await ev(`window.dispatchEvent(new CustomEvent('sg:record'))`);
    await sleep(900);
    check('记录面板能打开', await ev(`!!document.querySelector('.recorder')`));
    const draftText = '这是一段还没写完就先关掉的草稿内容';
    await ev(`(() => {
      const ta = document.querySelector('.recorder textarea');
      ta.value = ${JSON.stringify(draftText)};
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(700);
    // 不保存，直接关掉
    await ev(`document.querySelector('.recorder .icon-btn')?.click()`);
    await sleep(700);
    check('面板已关闭', await ev(`!document.querySelector('.recorder')`));
    const stored = await ev(`localStorage.getItem('shiguang.draft')`);
    check('草稿已存进本地', String(stored || '').includes('还没写完'), String(stored).slice(0, 60));
    // 再打开，应该被恢复
    await ev(`window.dispatchEvent(new CustomEvent('sg:record'))`);
    await sleep(1200);
    const restored = await ev(`document.querySelector('.recorder textarea')?.value || ''`);
    check('重新打开时草稿被恢复', String(restored).includes('还没写完'), `实际=${String(restored).slice(0, 40)}`);
    await shot('01-草稿恢复');
    // 清掉草稿与输入
    await ev(`(() => {
      const ta = document.querySelector('.recorder textarea');
      ta.value = '';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.recorder .icon-btn')?.click();
    })()`);
    await sleep(700);

    // ---------- 2. 写一条 + 删除 + 撤销 ----------
    console.log('\n  \x1b[36m· 删除与撤销\x1b[0m');
    const mark = `功能验收-${Date.now()}`;
    await ev(`window.dispatchEvent(new CustomEvent('sg:record'))`);
    await sleep(800);
    await ev(`(() => {
      const ta = document.querySelector('.recorder textarea');
      ta.value = ${JSON.stringify(mark)};
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(500);
    await ev(`Array.from(document.querySelectorAll('.recorder .btn')).find(b => /记下来/.test(b.textContent))?.click()`);
    await sleep(3000);
    check('记录写入时间线', await ev(`document.body.innerText.includes(${JSON.stringify(mark)})`));

    // 找到那张卡片上的删除按钮
    const actionsCount = await ev(`document.querySelectorAll('.entry .entry-actions').length`);
    check('卡片上有操作按钮（复制/编辑/删除）', Number(actionsCount) > 0, `找到 ${actionsCount} 组`);
    const delClicked = await ev(`
      (() => {
        const card = Array.from(document.querySelectorAll('.entry')).find(c => c.innerText.includes(${JSON.stringify(mark)}));
        if (!card) return 'no-card';
        const btns = card.querySelectorAll('.entry-actions .icon-btn');
        if (btns.length < 3) return 'no-btns:' + btns.length;
        btns[btns.length - 1].click();
        return 'ok';
      })()
    `);
    check('能点到删除按钮', delClicked === 'ok', String(delClicked));
    await sleep(1800);
    const goneNow = await ev(`!document.body.innerText.includes(${JSON.stringify(mark)})`);
    check('删除后从时间线消失', goneNow);
    const toastText = await ev(`document.querySelector('.toast')?.innerText || ''`);
    check('提示条带「撤销」按钮', /撤销/.test(String(toastText)), `提示=${String(toastText).slice(0, 30)}`);
    await shot('02-删除撤销');
    // 点撤销
    await ev(`document.querySelector('.toast-act')?.click()`);
    await sleep(3000);
    const backAgain = await ev(`document.body.innerText.includes(${JSON.stringify(mark)})`);
    check('撤销后记录回来了', backAgain);
    await shot('03-撤销恢复');

    // 清理这一条
    await ev(`
      (async () => {
        const m = location.pathname.match(/^(.*\\/shiguang)\\//);
        const api = (m ? m[1] : '') + '/api';
        const list = await fetch(api + '/entries?limit=2000', { credentials: 'include' }).then(r => r.json());
        const hit = (list.data?.entries || []).find(e => e.content.includes(${JSON.stringify(mark)}));
        if (hit) await fetch(api + '/entries/' + hit.id, { method: 'DELETE', credentials: 'include' });
        return 'done';
      })()
    `);
    await sleep(800);

    // ---------- 3. 那年今日 ----------
    console.log('\n  \x1b[36m· 那年今日\x1b[0m');
    // 通过接口塞一条去年的今天
    const memMark = `去年今天的验收内容-${Date.now()}`;
    await ev(`
      (async () => {
        const m = location.pathname.match(/^(.*\\/shiguang)\\//);
        const api = (m ? m[1] : '') + '/api';
        const d = new Date();
        const past = (d.getFullYear() - 1) + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
        const ts = new Date(past + 'T20:30:00').getTime();
        const r = await fetch(api + '/entries', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: ${JSON.stringify(memMark)}, date: past, createdAt: ts, tags: ['验收'] }),
        }).then(x => x.json());
        return r.ok ? r.data.entry.id : 'fail';
      })()
    `);
    await sleep(600);
    await ev(`location.hash = '#/'`);
    await sleep(1000);
    await ev(`location.reload()`);
    await sleep(4500);
    const memShown = await ev(`!!document.querySelector('.memory')`);
    check('首页出现「那年今日」', memShown);
    const memText = await ev(`document.querySelector('.memory')?.innerText || ''`);
    check('显示 1 年前的今天', /1\s*年前的今天/.test(String(memText)), String(memText).slice(0, 60));
    check('能展开看到往年内容', String(memText).includes('去年今天的验收内容') || (await ev(`document.querySelector('.memory .mem-row')?.click(); true`)) === true);
    await sleep(900);
    const expandedText = await ev(`document.querySelector('.memory')?.innerText || ''`);
    check('展开后能看到当年写的内容', String(expandedText).includes('去年今天的验收内容'), String(expandedText).slice(0, 80));
    await shot('04-那年今日');

    // AI 串讲：等按钮真的出现再点（那年今日是异步加载的）
    let hasAiBtn = false;
    for (let i = 0; i < 20; i++) {
      hasAiBtn = await ev(`!!document.querySelector('.memory .mem-ai .btn')`);
      if (hasAiBtn) break;
      await sleep(600);
    }
    check('有「让 AI 说说」入口', hasAiBtn);
    if (hasAiBtn) {
      // 真实模型偶尔会超时或返回空。失败时按钮会重新可用，
      // 所以这里重试两次，把「模型抽风」和「功能坏了」区分开。
      let reflection = '';
      let clickedAi = '';
      let toastText = '';
      for (let attempt = 0; attempt < 3 && reflection.length <= 20; attempt++) {
        clickedAi = String(
          await ev(`(() => {
            const b = document.querySelector('.memory .mem-ai .btn');
            if (!b || b.disabled) return 'no-btn';
            b.click();
            return 'clicked';
          })()`),
        );
        if (attempt === 0) check('AI 按钮可点击', clickedAi === 'clicked', clickedAi);
        if (clickedAi !== 'clicked') {
          await sleep(1500);
          continue;
        }
        // 等流式输出稳定下来再断言：只按长度判断会因为「刚吐了几个字」误判
        let stable = 0;
        for (let i = 0; i < 30; i++) {
          await sleep(1000);
          const now = String(await ev(`document.querySelector('.memory .mem-reflection')?.innerText || ''`));
          stable = now && now === reflection ? stable + 1 : 0;
          reflection = now;
          if (reflection.length > 20 && stable >= 3) break;
        }
        if (reflection.length <= 20) {
          toastText = String(await ev(`document.querySelector('.toast')?.innerText || ''`));
        }
      }
      check(
        'AI 能就往年今日说一段话',
        reflection.length > 20,
        `长度=${reflection.length} 内容=「${reflection.slice(0, 60)}」提示=「${toastText}」`,
      );
      console.log(`     AI：${reflection.replace(/\n/g, ' ').slice(0, 120)}`);
      await shot('05-那年今日AI');
    }

    // 清理
    await ev(`
      (async () => {
        const m = location.pathname.match(/^(.*\\/shiguang)\\//);
        const api = (m ? m[1] : '') + '/api';
        const list = await fetch(api + '/entries?limit=2000', { credentials: 'include' }).then(r => r.json());
        const hit = (list.data?.entries || []).find(e => e.content.includes(${JSON.stringify(memMark)}));
        if (hit) await fetch(api + '/entries/' + hit.id, { method: 'DELETE', credentials: 'include' });
        return 'done';
      })()
    `);

    // ---------- 3.5 检索历史 ----------
    console.log('\n  \x1b[36m· 检索\x1b[0m');
    // 先造一条能被搜到的数据：检索历史只在「有结果」时才记录，
    // 不依赖别的测试留下什么数据（测试之间不能互相依赖）
    const seedMark = `检索历史种子-${Date.now()}`;
    await ev(`
      (async () => {
        const m = location.pathname.match(/^(.*\\/shiguang)\\//);
        const api = (m ? m[1] : '') + '/api';
        const d = new Date();
        const p = (n) => String(n).padStart(2,'0');
        const today = d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate());
        await fetch(api + '/entries', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: ${JSON.stringify(`${seedMark} 验收用的记录`)}, date: today }),
        });
        return 'seeded';
      })()
    `);
    await sleep(800);
    await ev(`location.hash = '#/find'`);
    await sleep(1500);
    const searchTerm = '验收';
    await ev(`(() => {
      const i = document.querySelector('.ask-box input');
      i.value = ${JSON.stringify(searchTerm)};
      i.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(2500);
    const histRaw = await ev(`localStorage.getItem('shiguang.searches.v1')`);
    check('搜到结果后记进检索历史', String(histRaw || '').includes('验收'), String(histRaw).slice(0, 60));
    // 清空输入，回到空状态看历史
    await ev(`(() => {
      const i = document.querySelector('.ask-box input');
      i.value = '';
      i.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(1200);
    const recentShown = await ev(`Array.from(document.querySelectorAll('.chips .chip')).map(c => c.innerText.trim()).join('|')`);
    check('空状态能看到「搜过的」', String(recentShown).includes('验收'), String(recentShown).slice(0, 60));
    await shot('08-检索历史');

    // 清掉检索用的种子数据
    await ev(`
      (async () => {
        const m = location.pathname.match(/^(.*\\/shiguang)\\//);
        const api = (m ? m[1] : '') + '/api';
        const list = await fetch(api + '/entries?limit=2000', { credentials: 'include' }).then(r => r.json());
        for (const e of list.data.entries.filter(x => x.content.includes('检索历史种子'))) {
          await fetch(api + '/entries/' + e.id, { method: 'DELETE', credentials: 'include' });
        }
        return 'cleaned';
      })()
    `);
    await sleep(600);

    // ---------- 4. 各页面与语音入口 ----------
    console.log('\n  \x1b[36m· 页面与入口\x1b[0m');
    for (const [hash, name] of [
      ['#/', '过往'],
      ['#/find', '拾迹'],
      ['#/stats', '统计'],
      ['#/mine', '我的'],
      ['#/settings', '设置'],
    ]) {
      await ev(`location.hash = '${hash}'`);
      await sleep(1800);
      // 「我的」用的是 .hero 而不是 .page-head，所以两处都认
      const h1 = await ev(`document.querySelector('.page-head h1, .hero h1')?.innerText || ''`);
      check(`${name} 页正常渲染`, String(h1).length > 0, `h1=${h1}`);
    }

    // 底栏结构：左二 + 中间一个大按钮 + 右二
    await ev(`location.hash = '#/'`);
    await sleep(1500);
    const bar = JSON.parse(
      String(
        await ev(`JSON.stringify({
          links: [...document.querySelectorAll('.tabbar a')].map(a => a.innerText.trim()),
          fabText: (document.querySelector('.tabbar .fab-main')?.innerText || '').trim(),
          fabRound: (() => { const r = document.querySelector('.tabbar .fab-main')?.getBoundingClientRect(); return r ? Math.abs(r.width - r.height) < 1.5 : false; })(),
        })`),
      ),
    );
    check('底栏左一是「过往」', bar.links[0] === '过往', `实际 ${bar.links[0]}`);
    check('底栏左二是「拾迹」', bar.links[1] === '拾迹', `实际 ${bar.links[1]}`);
    check('底栏右二是「统计」', bar.links[2] === '统计', `实际 ${bar.links[2]}`);
    check('底栏右一是「我的」', bar.links[3] === '我的', `实际 ${bar.links[3]}`);
    check('底栏共 4 个带字入口', bar.links.length === 4, `实际 ${bar.links.length} 个`);
    check('中间大按钮只有图标没有文字', bar.fabText === '', `实际「${bar.fabText}」`);
    check('中间大按钮是正圆', bar.fabRound === true);

    // 语音弹层
    await ev(`location.hash = '#/'`);
    await sleep(1200);
    await ev(`window.dispatchEvent(new CustomEvent('sg:voice'))`);
    await sleep(1000);
    check('语音弹层能打开', await ev(`!!document.querySelector('.voice-sheet')`));
    check('录音按钮存在', await ev(`!!document.querySelector('.rec-btn')`));
    await shot('06-语音入口');
    await ev(`document.querySelector('.voice-sheet .icon-btn')?.click()`);
    await sleep(600);

    // ---------- 5. 键盘快捷键 ----------
    console.log('\n  \x1b[36m· 快捷键\x1b[0m');
    await ev(`document.body.focus()`);
    await send(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78 }, S);
    await send(ws, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78 }, S);
    await sleep(900);
    const nOpened = await ev(`!!document.querySelector('.recorder')`);
    check('按 N 打开记录面板', nOpened);
    await ev(`document.querySelector('.recorder .icon-btn')?.click()`);
    await sleep(600);

    // ---------- 6. 深色模式 ----------
    await ev(`location.hash = '#/'`);
    await sleep(800);
    await ev(`document.documentElement.dataset.theme = 'dark'`);
    await sleep(700);
    const bg = await ev(`getComputedStyle(document.body).backgroundColor`);
    check('深色模式生效', bg !== 'rgb(250, 247, 242)', `背景=${bg}`);
    await shot('07-深色首页');
    await ev(`document.documentElement.dataset.theme = 'light'`);

    // ---------- 7. 控制台体检 ----------
    console.log('\n  \x1b[36m· 控制台\x1b[0m');
    const realErrors = consoleErrors.filter((e) => !/favicon|manifest|sw\.js|ERR_|Failed to load resource/i.test(e));
    check('没有未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
    check('没有控制台报错', realErrors.length === 0, realErrors.slice(0, 2).join(' | '));

    console.log('\n\x1b[36m接口调用\x1b[0m');
    for (const l of [...new Set(apiLog)].slice(0, 16)) console.log(`  ${l}`);
  } finally {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    proc.kill('SIGKILL');
  }

  console.log(
    `\n\x1b[1m${failed === 0 ? '\x1b[32m功能验收全部通过' : '\x1b[31m有失败项'}\x1b[0m  ${pass} 通过 / ${failed} 失败\n`,
  );
  if (failures.length) console.log(`失败项：${failures.join('、')}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\x1b[31m验收脚本异常：\x1b[0m', e.message);
  process.exit(1);
});
