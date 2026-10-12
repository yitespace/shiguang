// =============================================================
// 拾光 · 线上验收（真实公网地址 + 真实操作）
// 走一遍用户真正会做的事：登录 → 写一条 → 检索 → 问 AI → 看统计
// 结束后会删掉测试数据，不留痕迹
//
// 用法：node scripts/verify-live.mjs [url]
// =============================================================

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));
const BASE = (positional[0] || 'https://zhuangrongjian.space/shiguang/').replace(/\/+$/, '');
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

const PORT = 9340;
// 路径里有中文，必须用 fileURLToPath 解码
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.shots-live');
const SHOT = argv.includes('--shots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name} ${extra}`);
  }
}

const HOME = os.homedir();
const CHROME = path.join(HOME, '.cache/ms-playwright/chromium-1217/chrome-linux64/chrome');

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
      '--password-store=basic',
      '--use-mock-keyring',
      '--force-device-scale-factor=2',
      `--user-data-dir=${path.join(os.tmpdir(), 'sg-live-profile')}`,
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
  if (!wsUrl) throw new Error('DevTools 端口未就绪');

  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  ws.addEventListener('message', (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
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
      consoleErrors.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200));
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
  await send(ws, 'Emulation.setDeviceMetricsOverride', { width: 412, height: 900, deviceScaleFactor: 2, mobile: true }, S);

  const ev = async (expr) => {
    const r = await send(ws, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, S);
    if (r.exceptionDetails) return `ERR:${String(r.exceptionDetails.exception?.description || '').slice(0, 160)}`;
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
    console.log(`\n\x1b[36m拾光 · 线上验收\x1b[0m  ${BASE}\n`);

    // 1) 打开页面
    await send(ws, 'Page.navigate', { url: `${BASE}/` }, S);
    await sleep(4000);
    // 注销 Service Worker 并清掉它 precache 的页面。
    // 只注销不清缓存的话，浏览器可能还在跑上一版构建，
    // 测出来的「失败」其实是旧代码的，排查方向会被带偏。
    await send(ws, 'Runtime.evaluate', { expression: `(async () => { try { const rs = await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map(r => r.unregister())); const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); } catch {} })()`, awaitPromise: true }, S);
    await sleep(400);
    const loaded = await ev(`document.querySelector('.gate') ? 'gate' : (document.querySelector('.shell') ? 'shell' : 'unknown')`);
    check('页面能打开（拿到首屏）', loaded !== 'unknown', `实际=${loaded}`);
    check('静态资源加载正常（样式已生效）', (await ev(`getComputedStyle(document.body).backgroundColor`)) !== 'rgba(0, 0, 0, 0)');
    const title = await ev(`document.title`);
    check('标题正确', /拾光/.test(String(title)), `实际=${title}`);
    await shot('01-登录页');

    // 2) 登录
    if (loaded === 'gate') {
      for (let i = 0; i < 8; i++) {
        await ev(LOGIN_JS);
        await sleep(300);
        await ev(`document.querySelector('.gate .btn-primary')?.click()`);
        await sleep(2500);
        if (await ev(`!!document.querySelector('.shell')`)) break;
      }
    }
    check('登录成功（进入主界面）', await ev(`!!document.querySelector('.shell')`));
    await sleep(1500);
    await shot('02-首页');

    // 3) 写一条记录（走真实 UI）
    // 「记一记」现在先弹一个选择层，选「写一条」才进记录面板
    const testContent = `线上验收自检 ${new Date().toLocaleTimeString('zh-CN')}`;
    await ev(`document.querySelector('.tabbar .fab-main')?.click()`);
    await sleep(900);
    const pickOk = await ev(`document.querySelectorAll('.pick-item').length`);
    check('「记一记」弹出两个入口', Number(pickOk) === 2, `实际 ${pickOk} 个`);
    await ev(`[...document.querySelectorAll('.pick-item')][0]?.click()`);
    await sleep(1000);
    const sheetOk = await ev(`!!document.querySelector('.recorder')`);
    check('选「写一条」能打开记录面板', sheetOk);
    await ev(`(() => {
      const ta = document.querySelector('.recorder textarea');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, ${JSON.stringify(testContent)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(500);
    await shot('03-记一笔');
    await ev(`Array.from(document.querySelectorAll('.recorder .btn')).find(b => /记下来|保存/.test(b.textContent))?.click()`);
    await sleep(3500);
    const saved = await ev(`document.body.innerText.includes(${JSON.stringify(testContent)})`);
    check('记录已写入并出现在时间线', saved);
    await shot('04-写入后');

    // 4) 检索（已并进「拾迹」）
    await ev(`location.hash = '#/find'`);
    await sleep(1500);
    await ev(`(() => {
      const i = document.querySelector('.ask-box input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(i, '线上验收');
      i.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(2500);
    const hits = await ev(`document.querySelectorAll('.results .hit').length`);
    check('检索能搜到刚写的记录', Number(hits) >= 1, `命中=${hits}`);
    await shot('05-检索');

    // 5) AI 问答（真实 DeepSeek，现在和检索同页）
    // 刚才搜索过，页面还停在结果态；先清空回到引导态，建议问题才会出现
    await ev(`document.querySelector('.ask-box .clear')?.click()`);
    await sleep(1200);
    const suggestOk = await ev(`document.querySelectorAll('.chip.suggest').length`);
    check('拾迹页有建议问题', Number(suggestOk) >= 1, `实际 ${suggestOk} 个`);
    await ev(`document.querySelector('.chip.suggest')?.click()`);
    await sleep(1500);
    // 点了建议问题就该发出请求，没有的话说明按钮没被命中
    const askedOrNot = await ev(`!!document.querySelector('.bubble.ai, .think-dot')`);
    check('点击后进入回答状态', askedOrNot === true);
    let answer = '';
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      answer = String(await ev(`(() => {
        const l = document.querySelector('.bubble.ai');
        return l ? l.innerText.trim() : '';
      })()`) || '');
      if (answer.length > 30) break;
    }
    check('AI 能基于记录回答问题', answer.length > 30, `长度=${answer.length}`);
    check('回答里带日期标注', /\d{2}\/\d{2}|\d{4}-\d{2}-\d{2}/.test(answer));
    const refs = await ev(`document.querySelectorAll('.cited-item').length`);
    check('回答带可跳转的依据记录', Number(refs) >= 1, `依据=${refs}`);
    await shot('06-AI对话');
    console.log(`\n  \x1b[90mAI 回答：\x1b[0m\n  ${answer.replace(/\n/g, '\n  ').slice(0, 400)}\n`);

    // 6) 其它页面
    for (const [hash, name] of [['#/mine', '07-我的'], ['#/stats', '08-统计'], ['#/settings', '09-设置']]) {
      await ev(`location.hash = '${hash}'`);
      await sleep(1800);
      const ok = await ev(`document.querySelector('.page-head h1, .hero h1')?.innerText || ''`);
      check(`${hash} 页面正常渲染`, String(ok).length > 0);
      await shot(name);
    }

    // 7) 桌面视图
    await send(ws, 'Emulation.setDeviceMetricsOverride', { width: 1360, height: 950, deviceScaleFactor: 2, mobile: false }, S);
    await ev(`location.hash = '#/'`);
    await sleep(2000);
    const sideNav = await ev(`!!document.querySelector('.side')`);
    check('桌面端显示左侧导航', sideNav);
    await shot('10-桌面首页');

    // 8) 清理测试数据（直接调接口，可靠且不依赖交互）
    const cleaned = await ev(`
      (async () => {
        // 页面在 /shiguang/ 下，接口在 /shiguang/api/*
        const m = location.pathname.match(/^(.*\\/shiguang)\\//);
        const api = (m ? m[1] : '') + '/api';
        const list = await fetch(api + '/entries?limit=2000', { credentials: 'include' }).then(r => r.json());
        const target = ${JSON.stringify(testContent)};
        const hit = (list.data?.entries || []).find(e => e.content.includes(target));
        if (!hit) return 'not-found';
        const del = await fetch(api + '/entries/' + hit.id, { method: 'DELETE', credentials: 'include' });
        return del.ok ? 'deleted' : 'delete-failed:' + del.status;
      })()
    `);
    await sleep(1200);
    await ev(`location.hash = '#/'`);
    await sleep(1500);
    await ev(`location.reload()`);
    await sleep(4000);
    const gone = await ev(`!document.body.innerText.includes(${JSON.stringify(testContent)})`);
    check('测试记录已清理干净', cleaned === 'deleted' && gone, `清理=${cleaned}`);

    // 9) 控制台体检
    const realErrors = consoleErrors.filter((e) => !/favicon|manifest|sw\.js|ERR_|Failed to load resource/i.test(e));
    check('没有未捕获的页面异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
    check('没有控制台报错', realErrors.length === 0, realErrors.slice(0, 2).join(' | '));

    console.log(`\n\x1b[36m接口调用轨迹\x1b[0m`);
    const uniq = [...new Set(apiLog)];
    for (const l of uniq.slice(0, 14)) console.log(`  ${l}`);
    if (apiLog.some((l) => l.startsWith('500'))) check('没有 500 错误', false, '见上方轨迹');
  } finally {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    proc.kill('SIGKILL');
  }

  console.log(
    `\n\x1b[1m${failed === 0 ? '\x1b[32m线上验收全部通过' : '\x1b[31m线上验收有失败项'}\x1b[0m  ${pass} 通过 / ${failed} 失败\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\x1b[31m验收脚本异常：\x1b[0m', e.message);
  process.exit(1);
});
