// =============================================================
// 拾光 · 登录与账号验收
//
// 覆盖：
//   · 未登录时被挡在登录页，随便访问哪一页都进不去
//   · 手机号 + 密码登录：错误密码有反馈，正确密码能进
//   · 手机号 + 验证码快捷登录：获取验证码 → 倒计时 → 登录成功
//   · 注册：新号能注册进来自动登录，已注册的号会被挡回去
//   · 两个账号各自登录时，看到的是自己的东西
//   · 退出后会话真的失效（不只是前端清了个变量）
//
// 用法：SHIGUANG_SMS_DEV=1 node scripts/verify-auth.mjs [baseUrl]
//   baseUrl 指向一个开了 SHIGUANG_SMS_DEV=1 的服务实例
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
const PORT = 9414;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.audit/auth');
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
      `--user-data-dir=${path.join(os.tmpdir(), 'sg-auth')}`,
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
  const apiCalls = [];
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
    if (m.method === 'Network.responseReceived') {
      const u = m.params?.response?.url || '';
      if (u.includes('/api/')) apiCalls.push(`${m.params.response.status} ${u.replace(BASE, '')}`);
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
      const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      s.call(i, ${JSON.stringify(value)});
      i.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()`);

  /** 在页面里调接口，顺便带上 cookie */
  const call = async (path, opts = {}) =>
    JSON.parse(
      String(
        await ev(`(async () => {
          const r = await fetch('${path}', ${JSON.stringify(opts)});
          return JSON.stringify(await r.json());
        })()`),
      ),
    );

  try {
    console.log(`\n\x1b[36m拾光 · 登录验收\x1b[0m  ${BASE}\n`);

    // ---------- 准备：先确保没登录，并且手机号是绑好的 ----------
    await send(ws, 'Page.navigate', { url: `${BASE}/` }, S);
    await sleep(2500);
    // 注销 SW 之外还要清 Cache Storage，否则页面可能跑的是上一版构建
    await ev(`(async () => { try { const rs = await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map(r => r.unregister())); const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); } catch {} })()`);
    // 清缓存只解决了下一次导航；当前页面还跑着旧的 index.html 引用的 JS。
    // 不马上重载的话，登录页可能根本没渲染出来，后面全是假失败。
    await ev(`setTimeout(() => location.reload(), 0)`);
    await sleep(3000);
    await ev(`(async () => { await fetch('./api/auth/logout', { method: 'POST' }); })()`);

    let methods = await call('./api/auth/methods');
    check('登录方式接口可用', methods.ok === true, JSON.stringify(methods).slice(0, 120));
    check('服务端已开启短信通道（开发模式）', methods.data?.sms === true, JSON.stringify(methods.data));

    check('服务端支持注册', methods.data?.register === true, JSON.stringify(methods.data));
    // 登录方式接口不再回手机号（那是私人信息），掩码号要从账号信息里读
    const meProfile = await call('./api/auth/profile').catch(() => null);

    // ---------- 1. 未登录必须被挡住 ----------
    console.log('\n  \x1b[36m· 未登录的门禁\x1b[0m');
    await send(ws, 'Page.navigate', { url: `${BASE}/#/mine` }, S);
    await sleep(3000);
    check('直接访问「我的」会落到登录页', (await ev(`!!document.querySelector('.gate-card')`)) === true);
    check('登录页看不到主界面', (await ev(`!!document.querySelector('.shell')`)) === false);
    await shot('01-登录页-密码');

    // ---------- 2. 密码登录 ----------
    console.log('\n  \x1b[36m· 密码登录\x1b[0m');
    check('页面有手机号输入框', (await ev(`!!document.querySelector('.gate input[type=tel]')`)) === true);
    check('页面有密码输入框', (await ev(`!!document.querySelector('.gate input[type=password]')`)) === true);
    // 之前这里有个 v-if/v-else 配对错误，导致密码登录时也冒出验证码输入框。
    // 钉一条断言，别再犯。
    check(
      '密码登录模式下不该出现验证码输入框',
      (await ev(`!document.querySelector('.gate .send-code')`)) === true,
    );
    check('密码登录模式下输入框只有两个', Number(await ev(`document.querySelectorAll('.gate .field').length`)) === 2,
      `实际 ${await ev(`document.querySelectorAll('.gate .field').length`)} 个`);
    check('能切换/注册的页签都出来了', Number(await ev(`document.querySelectorAll('.gate .tab').length`)) >= 2);

    // 注意：v-model 更新的是 ref，按钮的 :disabled 要等 Vue 渲染完才变。
    // 同一个同步块里「填值 + 立刻点」会点到还处于 disabled 的按钮，点了没反应。
    await fill('.gate input[type=tel]', PHONE);
    await fill('.gate input[type=password]', '不是密码');
    await sleep(400);
    await ev(`document.querySelector('.gate .btn-primary')?.click()`);
    await sleep(2500);
    const wrongMsg = String(await ev(`document.querySelector('.gate .err')?.innerText || ''`));
    check('密码错误有明确提示', wrongMsg.length > 0, `提示「${wrongMsg}」`);
    check('密码错误仍停在登录页', (await ev(`!!document.querySelector('.gate-card')`)) === true);
    await shot('02-密码错误');

    // 没注册过的号：提示要和「密码错」一致，不暴露这个号存不存在
    await fill('.gate input[type=tel]', '13911112222');
    await fill('.gate input[type=password]', 'whatever-1');
    await sleep(400);
    await ev(`document.querySelector('.gate .btn-primary')?.click()`);
    await sleep(2500);
    const unknownMsg = String(await ev(`document.querySelector('.gate .err')?.innerText || ''`));
    check('未注册的号不会暴露「有没有这个号」', /手机号或密码/.test(unknownMsg), `提示「${unknownMsg}」`);

    await fill('.gate input[type=tel]', PHONE);
    await fill('.gate input[type=password]', PASSWORD);
    await sleep(400);
    await ev(`document.querySelector('.gate .btn-primary')?.click()`);
    let entered = false;
    for (let i = 0; i < 15; i++) {
      await sleep(800);
      if (await ev(`!!document.querySelector('.shell')`)) {
        entered = true;
        break;
      }
    }
    check('正确密码能进主界面', entered, String(await ev(`document.querySelector('.gate .err')?.innerText || ''`)));

    // ---------- 3. 退出登录 ----------
    console.log('\n  \x1b[36m· 退出登录\x1b[0m');
    await ev(`location.hash = '#/mine'`);
    // 页面切换有过渡动画，别用固定等待赌它渲染完
    let heroTitle = '';
    for (let i = 0; i < 20; i++) {
      await sleep(400);
      heroTitle = String(await ev(`document.querySelector('.hero h1')?.innerText || ''`));
      if (heroTitle) break;
    }
    // 头图标题可能是「我的」，也可能是用户自己起的昵称，两个都认
    check('「我的」页正常渲染', heroTitle.length > 0, `标题「${heroTitle}」`);

    // 手机号现在挂在个人资料页（点头像进去），一级页面不再显示
    await ev(`location.hash = '#/profile'`);
    await sleep(2000);
    const profileText = String(await ev(`document.body.innerText`));
    check('个人资料页显示了掩码手机号', profileText.includes('138****8000'), profileText.slice(0, 60));
    check('个人资料页没有暴露完整手机号', !profileText.includes(PHONE));
    await ev(`location.hash = '#/mine'`);
    await sleep(1500);
    check('「我的」页不再摊开手机号', !String(await ev(`document.body.innerText`)).includes('138****8000'));
    await shot('03-我的-已登录');

    await ev(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => /退出登录/.test(x.textContent));
      b?.click();
    })()`);
    await sleep(3000);
    check('退出后回到登录页', (await ev(`!!document.querySelector('.gate-card')`)) === true);

    const afterLogout = await call('./api/entries');
    check('退出后服务端会话确实失效', afterLogout.ok === false, JSON.stringify(afterLogout).slice(0, 100));

    // ---------- 4. 短信验证码登录 ----------
    console.log('\n  \x1b[36m· 短信验证码登录\x1b[0m');
    await send(ws, 'Page.navigate', { url: `${BASE}/` }, S);
    await sleep(3000);
    await ev(`(() => {
      const t = [...document.querySelectorAll('.gate .tab')].find(x => /验证码/.test(x.textContent));
      t?.click();
    })()`);
    await sleep(800);
    check('能切到验证码登录', (await ev(`!!document.querySelector('.gate .send-code')`)) === true);
    await shot('04-登录页-短信');

    // 先清空手机号，确认这种情况下不给发码
    await fill('.gate input[type=tel]', '');
    await sleep(400);
    const sendBtnDisabled = await ev(`document.querySelector('.gate .send-code')?.disabled`);
    check('没填手机号时「获取验证码」不可点', sendBtnDisabled === true);

    await fill('.gate input[type=tel]', PHONE);
    await sleep(500);
    await ev(`document.querySelector('.gate .send-code')?.click()`);
    await sleep(2800);

    const codeVal = String(await ev(`document.querySelector('.gate input[inputmode=numeric][maxlength="6"]')?.value || ''`));
    check('开发模式下验证码自动回填', /^\d{6}$/.test(codeVal), `拿到「${codeVal}」`);
    const tipText = String(await ev(`document.querySelector('.gate .tip')?.innerText || ''`));
    check('页面说明了这是测试模式', /测试模式|开发模式/.test(tipText), `提示「${tipText.slice(0, 40)}」`);
    const cdText = String(await ev(`document.querySelector('.gate .send-code')?.innerText || ''`));
    check('按钮进入倒计时', /\d+s/.test(cdText), `按钮显示「${cdText}」`);
    await shot('05-验证码已发送');

    await ev(`document.querySelector('.gate .submit')?.click()`);
    let smsEntered = false;
    for (let i = 0; i < 15; i++) {
      await sleep(800);
      if (await ev(`!!document.querySelector('.shell')`)) {
        smsEntered = true;
        break;
      }
    }
    check('验证码能登进去', smsEntered);
    check('登录后停在首页（过往）', String(await ev(`location.hash`)).startsWith('#/'), String(await ev(`location.hash`)));
    await shot('06-短信登录成功');

    // ---------- 5. 已登录再打开不会又跳登录页 ----------
    console.log('\n  \x1b[36m· 登录态保持\x1b[0m');
    await send(ws, 'Page.navigate', { url: `${BASE}/#/settings` }, S);
    await sleep(3000);
    check('刷新后仍是登录状态', (await ev(`!!document.querySelector('.shell')`)) === true);
    check('登录页不再出现', (await ev(`!!document.querySelector('.gate-card')`)) === false);

    // ---------- 6. 账号设置里能看到手机号 ----------
    await ev(`location.hash = '#/settings'`);
    await sleep(1800);
    const settingsText = String(await ev(`document.body.innerText`));
    check('设置页有手机号一项', /手机号/.test(settingsText));
    check('设置页显示掩码号', settingsText.includes('138****8000'), settingsText.slice(0, 60));
    check('设置页能换手机号', /换手机号/.test(settingsText));

    // ---------- 7. 注册一个全新账号（手机号 + 邀请码 + 密码） ----------
    // 手机号从时间戳里凑一个，免得和上一轮跑测试留下的号撞车
    const NEW_PHONE = `139${String(Date.now()).slice(-8)}`;
    console.log(`\n  \x1b[36m· 注册（${NEW_PHONE.replace(/^(\d{3})\d{4}/, '$1****')}）\x1b[0m`);

    // 邀请码写在服务器的数据目录里；测试直接读本地那份
    const INVITE = (process.env.SHIGUANG_INVITE_CODE || fs.readFileSync(path.join(ROOT, '.run/data/invite-code.txt'), 'utf8')).trim();

    await ev(`(async () => { await fetch('./api/auth/logout', { method: 'POST' }); location.reload(); })()`);
    await sleep(3500);
    await ev(`(() => {
      const t = [...document.querySelectorAll('.gate .tab')].find(x => /注册/.test(x.textContent));
      t?.click();
    })()`);
    await sleep(800);
    check('能切到注册', (await ev(`!!document.querySelector('.gate input[type=password]')`)) === true);
    check('注册要填邀请码', (await ev(`!!document.querySelector('.gate input[maxlength="32"]')`)) === true);
    await shot('07-注册页');

    await fill('.gate input[type=tel]', NEW_PHONE);
    await fill('.gate input[maxlength="32"]', 'WRONGCODE');
    await fill('.gate input[type=password]', 'newbie-pass');
    await sleep(400);
    await ev(`document.querySelector('.gate .btn-primary')?.click()`);
    await sleep(2200);
    check('邀请码不对时注册被拒', /邀请码/.test(String(await ev(`document.querySelector('.gate .err')?.innerText || ''`))));

    await fill('.gate input[maxlength="32"]', INVITE);
    await fill('.gate input[type=password]', '123');
    await sleep(400);
    check(
      '密码太短时注册按钮不可点',
      (await ev(`document.querySelector('.gate .btn-primary')?.disabled`)) === true,
    );

    await fill('.gate input[type=password]', 'newbie-pass');
    await sleep(400);
    await ev(`document.querySelector('.gate .btn-primary')?.click()`);
    let registered = false;
    for (let i = 0; i < 15; i++) {
      await sleep(800);
      if (await ev(`!!document.querySelector('.shell')`)) {
        registered = true;
        break;
      }
    }
    check('注册完自动进主界面', registered, String(await ev(`document.querySelector('.gate .err')?.innerText || ''`)));
    await shot('08-注册成功');

    // ---------- 8. 新账号看到的是自己的空库 ----------
    console.log('\n  \x1b[36m· 新账号看到的东西\x1b[0m');
    await ev(`location.hash = '#/mine'`);
    await sleep(2200);
    const mineText = String(await ev(`document.body.innerText`));
    check('新账号的记录数是 0', /0\s*条记录/.test(mineText), mineText.split('\n').slice(0, 6).join(' / '));
    const newEntries = await call('./api/entries');
    check('新账号的接口也确实没有记录', newEntries.data?.total === 0, JSON.stringify(newEntries.data?.total));
    await ev(`location.hash = '#/profile'`);
    await sleep(1800);
    const newProfileText = String(await ev(`document.body.innerText`));
    check(
      '新账号看到的是自己的手机号',
      newProfileText.includes(NEW_PHONE.replace(/^(\d{3})\d{4}/, '$1****')),
      NEW_PHONE.replace(/^(\d{3})\d{4}/, '$1****'),
    );

    // 同一个号不能再注册一次
    await ev(`(async () => { await fetch('./api/auth/logout', { method: 'POST' }); location.reload(); })()`);
    await sleep(3500);
    await ev(`(() => {
      const t = [...document.querySelectorAll('.gate .tab')].find(x => /注册/.test(x.textContent));
      t?.click();
    })()`);
    await sleep(700);
    await fill('.gate input[type=tel]', NEW_PHONE);
    await fill('.gate input[maxlength="32"]', INVITE);
    await fill('.gate input[type=password]', 'newbie-pass');
    await sleep(400);
    await ev(`document.querySelector('.gate .btn-primary')?.click()`);
    await sleep(2500);
    const dupMsg = String(await ev(`document.querySelector('.gate .err')?.innerText || ''`));
    check('同一个号不能注册两次', /已经注册过/.test(dupMsg), `提示「${dupMsg}」`);

    // ---------- 9. 新账号能用密码再登回来 ----------
    console.log('\n  \x1b[36m· 新账号重新登录\x1b[0m');
    await ev(`(() => {
      const t = [...document.querySelectorAll('.gate .tab')].find(x => /^登录$/.test(x.textContent.trim()));
      t?.click();
    })()`);
    await sleep(700);
    await fill('.gate input[type=tel]', NEW_PHONE);
    await fill('.gate input[type=password]', 'newbie-pass');
    await sleep(400);
    await ev(`document.querySelector('.gate .btn-primary')?.click()`);
    let backIn = false;
    for (let i = 0; i < 15; i++) {
      await sleep(800);
      if (await ev(`!!document.querySelector('.shell')`)) {
        backIn = true;
        break;
      }
    }
    check('新账号能用密码登回来', backIn);
    await shot('09-新账号登录');

    // ---------- 10. 控制台 ----------
    console.log('\n  \x1b[36m· 控制台\x1b[0m');
    const noisy = consoleErrors.filter((e) => !/favicon|sw\.js|ServiceWorker/i.test(e));
    check('没有控制台报错', noisy.length === 0, noisy.slice(0, 2).join(' | '));

    console.log('\n\x1b[90m接口调用\x1b[0m');
    for (const c of [...new Set(apiCalls)].slice(0, 20)) console.log(`  ${c}`);
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
  console.log(`\x1b[1m\x1b[32m登录验收全部通过\x1b[0m  ${pass} 通过 / 0 失败\n`);
  process.exit(0);
}

main().catch((e) => {
  console.error('\x1b[31m验收失败：\x1b[0m', e.message);
  process.exit(2);
});
