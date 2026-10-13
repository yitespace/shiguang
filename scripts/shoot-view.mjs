// =============================================================
// 拾光 · 视口截图（不做整页拼接）
//
// 为什么不复用 audit-ui.mjs 的截图：
//   audit 用 Page.captureScreenshot({captureBeyondViewport:true}) 截整页，
//   这种截法会把 position:fixed/sticky 的元素（底栏、顶部栏）按当前滚动位置
//   重绘一次，拼出来的长图里底栏会「浮」在页面中间，看起来像重叠或错位。
//   这个脚本只截视口，用来肉眼确认真实的首屏观感。
//
// 用法：node scripts/shoot-view.mjs [baseUrl] [--desktop] [--dark]
// 输出：.shots/view-<mob|desk>-<light|dark>/<场景>.png
// =============================================================

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));
const BASE = (positional[0] || 'http://127.0.0.1:8791').replace(/\/+$/, '');
const DESKTOP = argv.includes('--desktop');
const DARK = argv.includes('--dark');
const PASSWORD = process.env.PASSWORD || 'test-pass-1';
const PHONE = process.env.TEST_PHONE || '13800138000';
/** 登录：账号是手机号，先填手机号再填密码，分开一步再点（Vue 的 disabled 要等渲染） */
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

const PORT = 9412;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAG = `${DESKTOP ? 'desk' : 'mob'}-${DARK ? 'dark' : 'light'}`;
const OUT = path.join(ROOT, '.shots', `view-${TAG}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOME = process.env.HOME || os.homedir();
const CHROME = [
  path.join(HOME, '.cache/ms-playwright/chromium-1217/chrome-linux64/chrome'),
  path.join(HOME, '.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell'),
].find((p) => fs.existsSync(p));

/**
 * 场景表：每一项先跳路由、可选再执行一段页面脚本，然后截视口。
 * action 里可以点按钮、开弹层，用来看各种状态下的排版。
 */
const SCENES = [
  { name: '1-过往', hash: '#/' },
  { name: '2-过往-下滑', hash: '#/', action: `window.scrollTo(0, 900)`, settle: 700 },
  { name: '3-拾迹', hash: '#/find' },
  { name: '4-统计', hash: '#/stats' },
  { name: '5-我的', hash: '#/mine' },
  { name: '6-设置', hash: '#/settings' },
  { name: '5b-我的-下半', hash: '#/mine', action: `window.scrollTo(0, 620)`, settle: 800 },
  { name: '5c-个人资料', hash: '#/profile' },
  { name: '5d-个人资料-下半', hash: '#/profile', action: `window.scrollTo(0, 640)`, settle: 700 },
  {
    name: '6b-设置-换手机号',
    hash: '#/settings',
    action: `(() => {
      const card = [...document.querySelectorAll('.section-title')].find(x => /安全/.test(x.textContent));
      card?.scrollIntoView({ block: 'start' });
      const b = [...document.querySelectorAll('button')].find(x => /换手机号/.test(x.textContent));
      b?.click();
      setTimeout(() => document.querySelector('.card-pad .btn-row')?.closest('.card')?.scrollIntoView({ block: 'start' }), 300);
    })()`,
    settle: 1000,
  },
  {
    name: '7-记一记-选择',
    hash: '#/',
    action: `document.querySelector('.fab-main')?.click()`,
    settle: 700,
  },
  {
    name: '8-记一记-写一条',
    hash: '#/',
    action: `document.querySelector('.fab-main')?.click(); setTimeout(() => [...document.querySelectorAll('.pick-item')][0]?.click(), 400)`,
    settle: 1100,
  },
  {
    name: '9-记一记-说一句',
    hash: '#/',
    action: `document.querySelector('.fab-main')?.click(); setTimeout(() => [...document.querySelectorAll('.pick-item')][1]?.click(), 400)`,
    settle: 1100,
  },
  { name: '10-登录页', hash: '#/', action: `(async () => {
      const api = await import('./assets/' + [...document.querySelectorAll('script[type=module]')].map(s=>s.src.split('/').pop())[0]);
    })()`, skip: true },
];
let msgId = 0;
const pending = new Map();
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
  if (!CHROME) throw new Error('找不到 Chromium');
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

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
      '--force-device-scale-factor=2',
      `--user-data-dir=${path.join(os.tmpdir(), `sg-view-${TAG}`)}`,
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
  const apiLog = [];
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
    if (m.method === 'Network.responseReceived') {
      const u = m.params?.response?.url || '';
      if (u.includes('/api/')) apiLog.push(`${m.params.response.status} ${u.replace(BASE, '')}`);
    }
  });

  const { targetId } = await send(ws, 'Target.createTarget', { url: 'about:blank' });
  const { sessionId: S } = await send(ws, 'Target.attachToTarget', { targetId, flatten: true });
  await send(ws, 'Page.enable', {}, S);
  await send(ws, 'Runtime.enable', {}, S);
  await send(ws, 'Network.enable', {}, S);

  const metrics = DESKTOP
    ? { width: 1360, height: 880, deviceScaleFactor: 2, mobile: false }
    : { width: 412, height: 880, deviceScaleFactor: 2, mobile: true };
  await send(ws, 'Emulation.setDeviceMetricsOverride', metrics, S);

  const run = (expr) => send(ws, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, S);

  try {
    // 登录：先停掉 Service Worker，免得命中旧构建的缓存
    await send(ws, 'Page.navigate', { url: `${BASE}/` }, S);
    await sleep(3000);
    // 光注销 SW 还不够：它 precache 过一份 index.html，留着的话
    // 这里会跑上一版界面，测出来的结果全是假的。缓存也一起清掉。
    await run(`(async () => { try { const rs = await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map(r => r.unregister())); const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); } catch {} })()`);
    for (let i = 0; i < 8; i++) {
      const st = await run(`!!document.querySelector('.shell')`);
      if (st.result?.value) break;
      await run(
        LOGIN_JS,
      );
      await sleep(400);
      await run(`document.querySelector('.gate .btn-primary')?.click()`);
      await sleep(2200);
    }

    await run(`(() => { location.reload(); })()`);
    await sleep(2500);

    if (DARK) {
      await run(`document.documentElement.dataset.theme = 'dark'`);
      await sleep(700);
    }

    const shot = async (name) => {
      const { data } = await send(ws, 'Page.captureScreenshot', { format: 'png' }, S);
      fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
      console.log(`  ✓ ${name}`);
    };

    for (const sc of SCENES) {
      if (sc.skip) continue;
      await run(`location.hash = '${sc.hash}'`);
      await sleep(2000);
      if (DARK) {
        await run(`document.documentElement.dataset.theme = 'dark'`);
        await sleep(200);
      }
      if (sc.action) {
        await run(sc.action);
        await sleep(sc.settle ?? 600);
      }
      if (DARK) {
        await run(`document.documentElement.dataset.theme = 'dark'`);
        await sleep(200);
      }
      await shot(sc.name);
    }

    // 登录页单独来两张：清掉登录态再看
    const lo = await run(`(async () => {
      try {
        const r = await fetch('./api/auth/logout', { method: 'POST', credentials: 'include' });
        const s = await fetch('./api/auth/status', { credentials: 'include' }).then((x) => x.json());
        return 'status=' + r.status + ' authed=' + s.data.authed + ' origin=' + location.origin + ' path=' + location.pathname;
      } catch (e) { return 'ERR ' + e.message; }
    })()`);
    console.log(`  退出登录：${lo.result?.value}`);
    await sleep(500);
    await send(ws, 'Page.navigate', { url: `${BASE}/` }, S);
    await sleep(3500);
    // 截图前先确认真的退出了：不然截到的还是主界面，白忙一场
    const di = JSON.parse(
      String(
        (await run(`JSON.stringify({ gate: !!document.querySelector('.gate-card') })`)).result?.value || '{}',
      ),
    );
    if (!di.gate) console.log('  \x1b[33m! 退出登录没生效，接下来的登录页截图会是主界面\x1b[0m');
    if (DARK) {
      await run(`document.documentElement.dataset.theme = 'dark'`);
      await sleep(400);
    }
    await shot('11-登录页');

    // 登录页的另外两个页签：验证码登录 / 注册
    // 没配短信时不会出现「验证码登录」，点不到就跳过
    for (const [re, name] of [
      ['/验证码/', '12-登录页-验证码'],
      ['/注册/', '13-登录页-注册'],
    ]) {
      const hit = await run(`(() => {
        const t = [...document.querySelectorAll('.gate .tab')].find(x => ${re}.test(x.textContent));
        if (!t) return false;
        t.click();
        return true;
      })()`);
      if (!hit.result?.value) continue;
      await sleep(700);
      if (DARK) {
        await run(`document.documentElement.dataset.theme = 'dark'`);
        await sleep(200);
      }
      await shot(name);
    }
  } finally {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    proc.kill('SIGKILL');
  }

  console.log(`\n截图目录：${OUT}\n`);
}

main().catch((e) => {
  console.error('\x1b[31m截图失败：\x1b[0m', e.message);
  process.exit(2);
});
