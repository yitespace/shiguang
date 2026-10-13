// =============================================================
// 拾光 · 个人资料验收
//
// 覆盖这次改版的三件事：
//   · 「我的」页头图能不能点进个人资料
//   · 昵称和简介能不能改，改完「我的」页头图要立刻跟着变
//   · 账号 / 通用 / 服务有没有从「我的」挪干净
//
// 用法：SHIGUANG_SMS_DEV=1 node scripts/verify-profile.mjs [baseUrl]
// =============================================================

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));
const BASE = (positional[0] || 'http://127.0.0.1:8791').replace(/\/+$/, '');
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

const PORT = 9416;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.audit/profile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOME = process.env.HOME || os.homedir();
const CHROME = [
  path.join(HOME, '.cache/ms-playwright/chromium-1217/chrome-linux64/chrome'),
  path.join(HOME, '.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell'),
].find((p) => fs.existsSync(p));

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
  if (!CHROME) throw new Error('找不到 chromium');
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
      `--user-data-dir=${path.join(os.tmpdir(), 'sg-profile')}`,
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

  const consoleErrors = [];
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
    if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
      consoleErrors.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
    }
  });

  const { targetId } = await send(ws, 'Target.createTarget', { url: 'about:blank' });
  const { sessionId: S } = await send(ws, 'Target.attachToTarget', { targetId, flatten: true });
  await send(ws, 'Page.enable', {}, S);
  await send(ws, 'Runtime.enable', {}, S);
  await send(ws, 'Emulation.setDeviceMetricsOverride', { width: 412, height: 900, deviceScaleFactor: 2, mobile: true }, S);

  const ev = async (expr) => {
    const r = await send(ws, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, S);
    if (r.exceptionDetails) return `__ERR__ ${r.exceptionDetails.exception?.description || ''}`.slice(0, 200);
    return r.result?.value;
  };
  const shot = async (name) => {
    const { data } = await send(ws, 'Page.captureScreenshot', { format: 'png' }, S);
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
  };
  /** 填表单：用原生 setter 写值再派发 input，Vue 的 v-model 才认 */
  const fill = (sel, value) =>
    ev(`(() => {
      const i = document.querySelector(${JSON.stringify(sel)});
      if (!i) return 'no-input';
      const proto = i.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(i, ${JSON.stringify(value)});
      i.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()`);
  const call = async (p, opts = {}) =>
    JSON.parse(String(await ev(`(async () => { const r = await fetch('${p}', ${JSON.stringify(opts)}); return JSON.stringify(await r.json()); })()`)));

  /** 把接口里的资料读回来（用来确认改动真的落盘了，而不只是前端状态） */
  const readProfile = () => call('./api/auth/profile');

  try {
    console.log(`\n\x1b[36m拾光 · 个人资料验收\x1b[0m  ${BASE}\n`);

    // ---------- 准备 ----------
    await send(ws, 'Page.navigate', { url: `${BASE}/` }, S);
    await sleep(2500);
    // 注销 SW 之外还要清 Cache Storage，否则页面可能跑的是上一版构建
    await ev(`(async () => { try { const rs = await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map(r => r.unregister())); const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); } catch {} })()`);
    // 清缓存只解决了下一次导航；当前页面还跑着旧的 index.html 引用的 JS。
    // 不马上重载的话，后面每一步都可能是在一个白屏上操作。
    await ev(`setTimeout(() => location.reload(), 0)`);
    await sleep(3000);
    for (let i = 0; i < 8; i++) {
      if (await ev(`!!document.querySelector('.shell')`)) break;
      await ev(
        LOGIN_JS,
      );
      await sleep(400);
      await ev(`document.querySelector('.gate .btn-primary')?.click()`);
      await sleep(2200);
    }
    check('登录成功', (await ev(`!!document.querySelector('.shell')`)) === true);

    // 把资料清空，从这个状态开始测
    await call('./api/auth/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: '', bio: '' }),
    });
    await ev(`location.hash = '#/mine'; location.reload()`);
    await sleep(3500);

    // ---------- 1. 未设置时「我的」页的兜底文案 ----------
    console.log('\n  \x1b[36m· 还没起名字的时候\x1b[0m');
    check('头图标题退回「我的」', String(await ev(`document.querySelector('.hero-name')?.innerText || ''`)) === '我的');
    check('头图退回记录足迹', /从 .* 记到现在|还没有开始/.test(String(await ev(`document.querySelector('.hero-sub')?.innerText || ''`))));
    check('头像用的是图形而不是文字', (await ev(`!!document.querySelector('.hero-avatar svg')`)) === true);

    // ---------- 2. 头图可点，进个人资料 ----------
    console.log('\n  \x1b[36m· 点头像进个人资料\x1b[0m');
    const hit = JSON.parse(
      String(
        await ev(`JSON.stringify({
          tag: document.querySelector('.hero-hit')?.tagName || '',
          href: document.querySelector('.hero-hit')?.getAttribute('href') || '',
          label: (document.querySelector('.hero-hit')?.innerText || '').trim(),
          aria: document.querySelector('.hero-hit')?.getAttribute('aria-label') || '',
        })`),
      ),
    );
    check('头图是一个链接', hit.tag === 'A', JSON.stringify(hit));
    check('链接指向个人资料页', hit.href === '#/profile', hit.href);
    // 真链接不需要额外 aria-label，但它得有可读名字
    check('头图有可读的名字', hit.label.length > 0 || hit.aria.length > 0, JSON.stringify(hit));
    check('头图里有一个一级标题', (await ev(`document.querySelectorAll('.hero h1').length`)) === 1);
    await ev(`document.querySelector('.hero-hit')?.click()`);
    await sleep(2200);
    check('跳到了个人资料页', String(await ev(`location.hash`)).startsWith('#/profile'), String(await ev(`location.hash`)));
    check('个人资料页渲染出来了', (await ev(`!!document.querySelector('.profile-page')`)) === true);
    await shot('01-个人资料-空');

    // ---------- 3. 账号 / 通用 / 服务 挪过来了 ----------
    console.log('\n  \x1b[36m· 内容搬运\x1b[0m');
    const profileText = String(await ev(`document.querySelector('.profile-page')?.innerText || ''`));
    for (const [kw, label] of [
      ['登录方式', '账号：登录方式'],
      ['手机号', '账号：手机号'],
      ['修改密码', '账号：修改密码'],
      ['外观', '通用：外观'],
      ['数据同步', '通用：数据同步'],
      ['AI 理解与问答', '服务：AI'],
      ['语音转写', '服务：语音'],
    ]) {
      check(`个人资料页有「${label}」`, profileText.includes(kw));
    }

    await ev(`location.hash = '#/mine'`);
    await sleep(1800);
    const mineText = String(await ev(`document.querySelector('.mine-page')?.innerText || ''`));
    check('「我的」页还留着统计入口', mineText.includes('统计'));
    check('「我的」页还留着导出入口', mineText.includes('导出与备份'));
    check('「我的」页还留着退出登录', mineText.includes('退出登录'));
    for (const [kw, label] of [
      ['登录方式', '账号：登录方式'],
      ['修改密码', '账号：修改密码'],
      ['数据同步', '通用：数据同步'],
      ['语音转写', '服务：语音'],
    ]) {
      check(`「我的」页不再有「${label}」`, !mineText.includes(kw));
    }

    // ---------- 4. 改昵称和简介 ----------
    console.log('\n  \x1b[36m· 改昵称和简介\x1b[0m');
    await ev(`location.hash = '#/profile'`);
    await sleep(1800);

    const NICK = '阿简';
    const BIO = '写点东西，留给以后的自己';
    check('保存按钮一开始是禁用的', (await ev(`document.querySelector('.acts .btn-primary')?.disabled`)) === true);

    await fill('#nickname', NICK);
    await sleep(400);
    check('填了昵称后保存按钮可用', (await ev(`document.querySelector('.acts .btn-primary')?.disabled`)) === false);
    check('出现「还没保存」提示', String(await ev(`document.body.innerText`)).includes('还没保存'));
    check('头图预览跟着变', String(await ev(`document.querySelector('.hero-name')?.innerText || ''`)) === NICK);
    check('头像换成昵称首字', String(await ev(`document.querySelector('.hero-avatar')?.innerText || ''`)).trim() === '阿');

    await fill('#bio', BIO);
    await sleep(400);
    check('简介也能填进去', String(await ev(`document.querySelector('#bio')?.value || ''`)) === BIO);
    await shot('02-个人资料-填好了');

    await ev(`document.querySelector('.acts .btn-primary')?.click()`);
    await sleep(2500);
    const saved = await readProfile();
    check('昵称落库了', saved.data?.nickname === NICK, JSON.stringify(saved.data?.nickname));
    check('简介落库了', saved.data?.bio === BIO, JSON.stringify(saved.data?.bio));
    check('保存后跳回上一页', String(await ev(`location.hash`)).startsWith('#/mine'), String(await ev(`location.hash`)));
    await sleep(1200);

    // ---------- 5. 「我的」页头图立刻反映新资料 ----------
    console.log('\n  \x1b[36m· 「我的」页跟着变\x1b[0m');
    check('头图标题变成昵称', String(await ev(`document.querySelector('.hero-name')?.innerText || ''`)) === NICK);
    check('头图副标题变成简介', String(await ev(`document.querySelector('.hero-sub')?.innerText || ''`)) === BIO);
    check('头像显示首字', String(await ev(`document.querySelector('.hero-avatar')?.innerText || ''`)).trim() === '阿');
    await shot('03-我的-改好了');

    // 刷新一次，确认不是只存在于内存里
    await ev(`location.reload()`);
    await sleep(3500);
    check('刷新后昵称还在', String(await ev(`document.querySelector('.hero-name')?.innerText || ''`)) === NICK);
    check('刷新后简介还在', String(await ev(`document.querySelector('.hero-sub')?.innerText || ''`)) === BIO);

    // ---------- 6. 清空后能退回默认 ----------
    console.log('\n  \x1b[36m· 清空资料\x1b[0m');
    await ev(`location.hash = '#/profile'`);
    await sleep(1800);
    await fill('#nickname', '');
    await fill('#bio', '');
    await sleep(400);
    await ev(`document.querySelector('.acts .btn-primary')?.click()`);
    await sleep(2500);
    const cleared = await readProfile();
    check('昵称能清空', cleared.data?.nickname === '', JSON.stringify(cleared.data?.nickname));
    check('简介能清空', cleared.data?.bio === '', JSON.stringify(cleared.data?.bio));
    await sleep(1000);
    check('清空后头图退回「我的」', String(await ev(`document.querySelector('.hero-name')?.innerText || ''`)) === '我的');
    check('清空后头像退回图形', (await ev(`!!document.querySelector('.hero-avatar svg')`)) === true);

    // ---------- 7. 超长与特殊字符 ----------
    console.log('\n  \x1b[36m· 边界\x1b[0m');
    const long = await call('./api/auth/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: '名'.repeat(40), bio: '字'.repeat(200) }),
    });
    check('超长昵称被截到 20 字', long.data?.nickname?.length === 20, `实际 ${long.data?.nickname?.length}`);
    check('超长简介被截到 80 字', long.data?.bio?.length === 80, `实际 ${long.data?.bio?.length}`);

    const spaced = await call('./api/auth/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: '  换\n行   空格  ', bio: '上\n下' }),
    });
    check('昵称里的换行被压成空格', !/[\n\r]/.test(spaced.data?.nickname || ''), JSON.stringify(spaced.data?.nickname));
    check('简介里的换行被压成空格', !/[\n\r]/.test(spaced.data?.bio || ''), JSON.stringify(spaced.data?.bio));

    const html = await call('./api/auth/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: '<script>alert(1)</script>', bio: '<img src=x onerror=alert(1)>' }),
    });
    check('昵称原样存下来（渲染时才转义）', html.data?.nickname?.includes('script'), JSON.stringify(html.data?.nickname));

    await ev(`location.hash = '#/mine'`);
    await sleep(1500);
    const hasScriptTag = await ev(`!!document.querySelector('.mine-page script, .mine-page img')`);
    check('「我的」页没有被注入出脚本或图片标签', hasScriptTag === false);
    await ev(`location.hash = '#/profile'`);
    await sleep(1500);
    check('个人资料页也没有被注入', (await ev(`!!document.querySelector('.profile-page script, .profile-page img')`)) === false);
    await shot('04-特殊字符');

    // 收拾干净，别把测试数据留在库里
    await call('./api/auth/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: '', bio: '' }),
    });
    console.log('  \x1b[90m（测试资料已清空）\x1b[0m');

    // ---------- 8. 直接打开这个地址也能用（刷新 / 书签） ----------
    console.log('\n  \x1b[36m· 直接打开的情况\x1b[0m');
    // 先离开本站再进来，否则同文档的 hash 跳转不会重置 history.state，
    // 测出来的还是「有上一页」的情况
    await send(ws, 'Page.navigate', { url: 'about:blank' }, S);
    await sleep(600);
    await send(ws, 'Page.navigate', { url: `${BASE}/#/profile` }, S);
    await sleep(3500);
    check('直接打开个人资料页能渲染', (await ev(`!!document.querySelector('.profile-page')`)) === true);
    check(
      '这一页确实没有上一页',
      (await ev(`window.history.state?.back == null`)) === true,
      String(await ev(`JSON.stringify(window.history.state)`)),
    );
    await ev(`document.querySelector('.hero-back')?.click()`);
    await sleep(2000);
    const afterBack = String(await ev(`location.hash`));
    check('没有上一页时「返回」回到「我的」而不是退出站点', afterBack.startsWith('#/mine'), afterBack);
    check('还留在应用里', (await ev(`!!document.querySelector('.mine-page')`)) === true);

    // ---------- 9. 控制台 ----------
    console.log('\n  \x1b[36m· 控制台\x1b[0m');
    const noisy = consoleErrors.filter((e) => !/favicon|sw\.js|ServiceWorker|manifest/i.test(e));
    check('没有控制台报错', noisy.length === 0, noisy.slice(0, 2).join(' | '));
  } finally {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    proc.kill('SIGKILL');
  }

  console.log('');
  if (failed) {
    console.log(`\x1b[1m\x1b[31m有失败项\x1b[0m  ${pass} 通过 / ${failed} 失败`);
    console.log(`\n失败项：${failures.join('、')}\n`);
    process.exit(1);
  }
  console.log(`\x1b[1m\x1b[32m个人资料验收全部通过\x1b[0m  ${pass} 通过 / 0 失败\n`);
  process.exit(0);
}

main().catch((e) => {
  console.error('\x1b[31m验收失败：\x1b[0m', e.message);
  process.exit(2);
});
