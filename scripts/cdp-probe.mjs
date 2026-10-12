// =============================================================
// 拾光 · CDP 探针
//
// 调试用的万能小工具：起一个无头浏览器、登录、跳到你指定的路由，
// 然后在页面里执行一段表达式，把结果打出来。
// 排查「某个元素的真实尺寸/颜色是什么」这类问题时比截图快得多。
//
// 用法：
//   node scripts/cdp-probe.mjs <端口> "<表达式>"
//   NO_LOGIN=1 node scripts/cdp-probe.mjs <端口> "<表达式>"   # 停在登录页
//   BASE=https://... node scripts/cdp-probe.mjs <端口> "<表达式>"
//
// 例：量一下「记一记」按钮的真实尺寸
//   node scripts/cdp-probe.mjs 9413 \
//     "JSON.stringify(document.querySelector('.fab-main').getBoundingClientRect())"
// =============================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PORT = Number(process.argv[2] || 9413);
const PHONE = process.env.TEST_PHONE || '13800138000';
const PASSWORD = process.env.PASSWORD || 'test-pass-1';
const EXPR = process.argv[3] || '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOME = process.env.HOME || os.homedir();
const CHROME = [
  path.join(HOME, '.cache/ms-playwright/chromium-1217/chrome-linux64/chrome'),
  path.join(HOME, '.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell'),
].find((p) => fs.existsSync(p));

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
    `--user-data-dir=${path.join(os.tmpdir(), `sg-probe-${PORT}`)}`,
    'about:blank',
  ],
  { stdio: 'ignore', env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: '/dev/null' } },
);

let id = 0;
const pending = new Map();
const send = (ws, method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const mid = ++id;
    const t = setTimeout(() => pending.has(mid) && (pending.delete(mid), reject(new Error(method + ' 超时'))), 30000);
    pending.set(mid, { resolve: (v) => (clearTimeout(t), resolve(v)), reject: (e) => (clearTimeout(t), reject(e)) });
    ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

let wsUrl = '';
for (let i = 0; i < 60 && !wsUrl; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    wsUrl = (await r.json()).webSocketDebuggerUrl;
  } catch {}
  if (!wsUrl) await sleep(250);
}
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
  }
});

const { targetId } = await send(ws, 'Target.createTarget', { url: 'about:blank' });
const { sessionId: S } = await send(ws, 'Target.attachToTarget', { targetId, flatten: true });
await send(ws, 'Page.enable', {}, S);
await send(ws, 'Runtime.enable', {}, S);
await send(ws, 'Emulation.setDeviceMetricsOverride', { width: 412, height: 880, deviceScaleFactor: 2, mobile: true }, S);

const BASE = process.env.BASE || 'http://127.0.0.1:8791';
await send(ws, 'Page.navigate', { url: `${BASE}/` }, S);
await sleep(2500);
await send(ws, 'Runtime.evaluate', { expression: `(async () => { try { const rs = await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map(r => r.unregister())); const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); } catch {} })()`, awaitPromise: true }, S);
if (process.env.NO_LOGIN !== '1') for (let i = 0; i < 6; i++) {
  const st = await send(ws, 'Runtime.evaluate', { expression: `!!document.querySelector('.shell')`, returnByValue: true }, S);
  if (st.result?.value) break;
  // 账号是手机号：先填号再填密码，等一拍再点，否则会点到还禁用着的按钮
  await send(ws, 'Runtime.evaluate', { expression: `(() => {
    const gate = document.querySelector('.gate'); if (!gate) return;
    const set = (el, v) => { if (!el) return; Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    set(gate.querySelector('input[type=tel]'), ${JSON.stringify(PHONE)});
    set(gate.querySelector('input[type=password]'), ${JSON.stringify(PASSWORD)});
  })()` }, S);
  await sleep(400);
  await send(ws, 'Runtime.evaluate', { expression: `document.querySelector('.gate .btn-primary')?.click()` }, S);
  await sleep(2000);
}
await sleep(500);
const r = await send(ws, 'Runtime.evaluate', { expression: EXPR, awaitPromise: true, returnByValue: true }, S);
console.log(JSON.stringify(r.result?.value ?? r.exceptionDetails ?? null, null, 2));

ws.close();
proc.kill('SIGKILL');
process.exit(0);
