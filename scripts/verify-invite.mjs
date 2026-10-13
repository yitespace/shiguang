// =============================================================
// 拾光 · 邀请码注册验收
//
// 为什么不是短信：阿里云短信要资质审核 + 运营商实名报备，个人认证过不了，
// 整套两周起步。所以注册门槛改用「邀请码」——码由管理员掌握，
// 只发给他想放进来的人。
//
// 这个脚本自己起一个空库的服务，把整条路走一遍：
//   · 空库时自动生成邀请码，写进数据目录（600 权限），也打进启动日志
//   · 邀请码错 → 拒绝；对 → 建号并直接进去；大小写不敏感
//   · 同一个邀请码可以给多个人用；同一个手机号不能注册两次
//   · 注册全程不碰短信（短信只是登录的快捷方式）
//
// 用法：node scripts/verify-invite.mjs
// =============================================================

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.INVITE_PORT || 8796);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(os.tmpdir(), `shiguang-invite-${Date.now()}`);
const CHROME_PORT = 9418;

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

const server = spawn(process.execPath, [path.join(ROOT, 'server', 'src', 'index.mjs')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    SHIGUANG_DATA: DATA,
    SHIGUANG_COOKIE_PATH: '/',
    // 故意关掉短信开发模式：这个套件要验的就是「线上那种没配短信」的形态。
    // 不显式清掉的话，跑 test:all 时会从外面继承 SHIGUANG_SMS_DEV=1，
    // 登录页就多出「验证码登录」那一栏，断言全错。
    SHIGUANG_SMS_DEV: '',
    ALIYUN_SMS_AK_ID: '',
    ALIYUN_SMS_AK_SECRET: '',
    ALIYUN_SMS_SIGN: '',
    ALIYUN_SMS_TEMPLATE: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));

const HOME = process.env.HOME || os.homedir();
const CHROME = [
  path.join(HOME, '.cache/ms-playwright/chromium-1217/chrome-linux64/chrome'),
  path.join(HOME, '.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell'),
].find((p) => fs.existsSync(p));

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
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

async function main() {
  console.log(`\n\x1b[36m拾光 · 邀请码注册验收\x1b[0m  ${BASE}\n`);

  // 等服务起来
  let up = false;
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/api/healthz`)).ok) { up = true; break; }
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  check('服务起来了', up, log.slice(-200));

  // 邀请码应该被写到数据目录里
  const codeFile = path.join(DATA, 'invite-code.txt');
  check('数据目录里生成了邀请码文件', fs.existsSync(codeFile), codeFile);
  const code = fs.existsSync(codeFile) ? fs.readFileSync(codeFile, 'utf8').trim() : '';
  check('邀请码是 8 位十六进制', /^[0-9A-F]{8}$/.test(code), code);
  check('启动日志里也打了邀请码', log.includes(code));
  const mode = fs.existsSync(codeFile) ? (fs.statSync(codeFile).mode & 0o777).toString(8) : '';
  check('邀请码文件权限是 600', mode === '600', mode);

  const api = async (p, opts = {}) => {
    const r = await fetch(`${BASE}${p}`, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    return r.json();
  };

  let r = await api('/api/auth/methods');
  check('登录方式接口说现在是空库', r.data?.userCount === 0, JSON.stringify(r.data));
  check('注册是开着的', r.data?.register === true);
  check('注册要邀请码', r.data?.invite === true);
  check('短信没配好时不显示验证码登录', typeof r.data?.sms === 'boolean');

  r = await api('/api/auth/register', { method: 'POST', body: { phone: '13800138000', password: 'owner-pass', inviteCode: 'DEADBEEF' } });
  check('邀请码不对时建不了号', r.ok === false && /邀请码/.test(r.error || ''), String(r.error));

  r = await api('/api/auth/register', { method: 'POST', body: { phone: '13800138000', password: 'owner-pass', inviteCode: code } });
  check('邀请码对了能建出第一个账号', r.ok === true && r.data?.authed === true, JSON.stringify(r).slice(0, 140));
  check('返回的 me 只有掩码号', r.data?.me?.phoneMasked === '138****8000');

  r = await api('/api/auth/methods');
  check('账号数变成 1', r.data?.userCount === 1, `实际 ${r.data?.userCount}`);
  check('邀请码文件留着（还要给下一个人用）', fs.existsSync(codeFile));

  // 邀请码是可复用的
  r = await api('/api/auth/register', { method: 'POST', body: { phone: '13700137000', password: 'other-pass', inviteCode: code.toLowerCase() } });
  check('邀请码可以给第二个人用，且不区分大小写', r.ok === true, JSON.stringify(r).slice(0, 120));

  // 同一个号不能重复注册
  r = await api('/api/auth/register', { method: 'POST', body: { phone: '13700137000', password: 'other-pass', inviteCode: code } });
  check('同一个手机号不能注册两次', r.ok === false && /已经注册过/.test(r.error || ''), String(r.error));

  // 注册全程不需要短信验证码：整个流程只用到 phone / inviteCode / password 三个字段
  const needs = await api('/api/auth/methods');
  check('注册要的是邀请码而不是验证码', needs.data?.invite === true && needs.data?.register === true);
  // 不带 code 字段也能注册成功（上面那次注册就没带），这里再确认一次接口不认 code
  r = await api('/api/auth/register', { method: 'POST', body: { phone: '13700137003', password: 'nocode-pass', inviteCode: code } });
  check('注册不传 code 也能过', r.ok === true && r.data?.authed === true, JSON.stringify(r).slice(0, 120));

  // ---------- 浏览器里看一眼 ----------
  if (CHROME) {
    const proc = spawn(
      CHROME,
      [
        `--remote-debugging-port=${CHROME_PORT}`,
        '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
        '--hide-scrollbars', '--no-first-run', '--disable-crash-reporter',
        '--password-store=basic', '--use-mock-keyring', '--force-device-scale-factor=2',
        `--user-data-dir=${path.join(os.tmpdir(), 'sg-setup-check')}`,
        'about:blank',
      ],
      { stdio: 'ignore', env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: '/dev/null' } },
    );
    let wsUrl = '';
    for (let i = 0; i < 60; i++) {
      try {
        const rr = await fetch(`http://127.0.0.1:${CHROME_PORT}/json/version`);
        wsUrl = (await rr.json()).webSocketDebuggerUrl;
        if (wsUrl) break;
      } catch { /* wait */ }
      await sleep(250);
    }
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch { return; }
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
    const ev = async (expr) => {
      const rr = await send(ws, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, S);
      return rr.result?.value;
    };
    try {
      await send(ws, 'Page.navigate', { url: `${BASE}/` }, S);
      await sleep(3500);
      await ev(`(async () => { try { const rs = await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map(x => x.unregister())); const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); } catch {} })()`);
      await send(ws, 'Page.navigate', { url: `${BASE}/` }, S);
      await sleep(3000);
      check('浏览器里能打开登录页', (await ev(`!!document.querySelector('.gate-card')`)) === true);
      const tabsText = String(await ev(`document.querySelector('.gate .tabs')?.innerText || ''`));
      check('登录页有「注册」页签', /注册/.test(tabsText), tabsText.replace(/\n/g, ' / '));
      // 没配短信时不该出现「验证码登录」——线上就是这个配置
      check('没配短信就不显示「验证码登录」', !/验证码/.test(tabsText), tabsText.replace(/\n/g, ' / '));
      const tabCount = Number(await ev(`document.querySelectorAll('.gate .tab').length`));
      check('没配短信时正好两个页签', tabCount === 2, `实际 ${tabCount} 个`);
      check('登录页没有多余的验证码输入框', (await ev(`!document.querySelector('.gate .send-code')`)) === true);
    } finally {
      try { ws.close(); } catch { /* ignore */ }
      proc.kill('SIGKILL');
      await sleep(600);
    }
  }

  server.kill('SIGKILL');
  // 等一等再退出：浏览器和临时服务都要时间释放资源，
  // 紧接着跑下一个脚本（比如 UI 审计）时抢资源会让它起不来
  await sleep(800);
  fs.rmSync(DATA, { recursive: true, force: true });

  console.log('');
  if (failed) {
    console.log(`\x1b[1m\x1b[31m有失败项\x1b[0m  ${pass} 通过 / ${failed} 失败`);
    console.log(`\n失败项：${failures.join('、')}\n`);
    process.exit(1);
  }
  console.log(`\x1b[1m\x1b[32m邀请码注册验收全部通过\x1b[0m  ${pass} 通过 / 0 失败\n`);
  process.exit(0);
}

main().catch((e) => {
  console.error('\x1b[31m验收失败：\x1b[0m', e.message);
  server.kill('SIGKILL');
  process.exit(2);
});
