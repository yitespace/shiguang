// =============================================================
// 拾光 · 页面截图 / 渲染自检
// 用本机 Playwright 自带的 chromium，通过 CDP 驱动：
//   1) 打开页面 → 自动登录
//   2) 逐页截图，方便肉眼检查排版
//   3) 顺手收集控制台报错与页面异常，作为前端冒烟测试
//
// 用法：node scripts/shoot.mjs [baseUrl]
// =============================================================

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.argv[2] || process.env.BASE || 'http://127.0.0.1:8791';
const OUT = path.join(ROOT, '.shots');
const PORT = 9331;
const PASSWORD = process.env.PASSWORD || '123456';

const HOME = process.env.HOME || os.homedir();
const CANDIDATES = [
  path.join(HOME, '.cache/ms-playwright/chromium-1217/chrome-linux64/chrome'),
  path.join(HOME, '.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell'),
];

function findChrome() {
  for (const c of CANDIDATES) if (fs.existsSync(c)) return c;
  throw new Error('没有找到 chromium，可执行文件都不存在');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let msgId = 0;
const pending = new Map();
const consoleErrors = [];
const pageErrors = [];
const apiCalls = [];
const apiErrors = [];

function send(ws, method, params = {}, sessionId) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    // 加超时：CDP 偶尔不回应，卡住不如直接报错
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} 超时（20s 无响应）`));
      }
    }, 20000);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
      method,
    });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const chrome = findChrome();
  const profile = path.join(OUT, 'cdp-profile');

  const proc = spawn(
    chrome,
    [
      `--remote-debugging-port=${PORT}`,
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--no-first-run',
      '--disable-crash-reporter',
      // 关键：不要碰系统钥匙环。
      // 不加这几项时 chromium 会去 gnome-keyring 存它自己的加密密钥，
      // 桌面上就会弹出「输入密码以解锁登录钥匙环」的 gcr-prompter 对话框。
      '--password-store=basic',
      '--use-mock-keyring',
      '--disable-features=PasswordManagerOnboarding,AutofillServerCommunication',
      '--force-device-scale-factor=2',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // 再上一道保险：切断 D-Bus 会话总线，让它连不上钥匙环服务
        DBUS_SESSION_BUS_ADDRESS: '/dev/null',
      },
    },
  );
  proc.stderr.on('data', () => {});

  // 等 DevTools 端口就绪
  let wsUrl = '';
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const j = await res.json();
      wsUrl = j.webSocketDebuggerUrl;
      if (wsUrl) break;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  if (!wsUrl) {
    proc.kill('SIGKILL');
    throw new Error('DevTools 端口没有起来');
  }

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject, method } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      consoleErrors.push((msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params?.exceptionDetails;
      pageErrors.push(d?.exception?.description || d?.text || '未知异常');
    }
    if (msg.method === 'Network.responseReceived' && /\/api\//.test(msg.params?.response?.url || '')) {
      apiCalls.push({
        url: msg.params.response.url.replace(/^https?:\/\/[^/]+/, ''),
        status: msg.params.response.status,
        mime: msg.params.response.mimeType,
        t: Date.now(),
      });
    }
    if (msg.method === 'Network.loadingFailed') {
      apiErrors.push(`${msg.params?.errorText} (${msg.params?.type})`);
    }
  });

  // 新建一个页面并附加
  const { targetId } = await send(ws, "Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send(ws, 'Target.attachToTarget', { targetId, flatten: true });

  await send(ws, 'Page.enable', {}, sessionId);
  await send(ws, 'Runtime.enable', {}, sessionId);
  await send(ws, 'Network.enable', {}, sessionId);

  // 手机尺寸视口（主力使用场景）
  const MOBILE = { width: 412, height: 900, deviceScaleFactor: 2, mobile: true };
  await send(ws, 'Emulation.setDeviceMetricsOverride', MOBILE, sessionId);

  async function evaluate(expression) {
    const r = await send(
      ws,
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || '页面脚本出错');
    return r.result?.value;
  }

  async function goto(url, waitMs = 1600) {
    await send(ws, 'Page.navigate', { url }, sessionId);
    await sleep(waitMs);
  }

  async function shot(name) {
    const { data } = await send(
      ws,
      'Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: true },
      sessionId,
    );
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    const size = fs.statSync(file).size;
    console.log(`  📷 ${name}.png  (${(size / 1024).toFixed(0)} KB)`);
    return file;
  }

  try {
    console.log(`\n\x1b[36m拾光 · 页面渲染自检\x1b[0m  ${BASE}\n`);

    // ---- 登录页 ----
    await goto(`${BASE}/`);
    const gateText = await evaluate(`document.querySelector('.gate') ? 'gate' : (document.querySelector('.shell') ? 'shell' : 'unknown')`);
    console.log(`  首屏状态：${gateText}`);
    await shot('01-登录页');

    // ---- 登录（首次运行需要，之后 profile 里已有会话）----
    if (gateText === 'gate') {
      for (let i = 0; i < 8; i++) {
        await evaluate(`
          (() => {
            const input = document.querySelector('.gate input[type=password]');
            if (!input) return false;
            input.value = ${JSON.stringify(PASSWORD)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
          })()
        `);
        await sleep(300);
        await evaluate(`document.querySelector('.gate .btn-primary')?.click()`);
        await sleep(2200);
        if (await evaluate(`!!document.querySelector('.shell')`)) break;
      }
    }
    const afterLogin = await evaluate(`document.querySelector('.shell') ? 'ok' : 'still-gate'`);
    console.log(`  登录结果：${afterLogin}`);
    await shot('02-记录首页');

    // ---- 各页面 ----
    const pages = [
      ['03-拾迹', '#/find'],
      ['04-统计', '#/stats'],
      ['05-我的', '#/mine'],
      ['06-设置', '#/settings'],
    ];
    for (const [name, hash] of pages) {
      await evaluate(`location.hash = ${JSON.stringify(hash)}`);
      await sleep(1800);
      await shot(name);
    }

    // ---- 检索交互：搜一个词并等 AI 回答 ----
    await evaluate(`location.hash = '#/find'`);
    await sleep(1200);
    await evaluate(`
      (() => {
        const input = document.querySelector('.ask-box input');
        input.value = '沈警官';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()
    `);
    await sleep(1500);
    await shot('08-检索结果');

    const hitCount = await evaluate(`document.querySelectorAll('.results .hit').length`);
    console.log(`  检索「沈警官」命中 ${hitCount} 条`);

    // ---- AI 问答实测（点建议问题，等流式回答）----
    // 检索页和对话页已经合并成「拾迹」：同一个输入框，打字是搜，回车/点「问 AI」是问
    await evaluate(`location.hash = '#/find'`);
    await sleep(2000);
    const sendOk = await evaluate(`
      (() => {
        if (document.querySelector('.bubble.ai')) return 'already';
        const s = document.querySelector('.chip.suggest');
        if (s) { s.click(); return 'clicked-suggest'; }
        const ta = document.querySelector('.ask-box input');
        if (!ta) return 'no-input';
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(ta, '昨天我做了什么？');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        const btn = document.querySelector('.ask-btn');
        if (!btn) return 'no-button';
        btn.click();
        return 'clicked-send';
      })()
    `);
    console.log(`  提问发送：${sendOk}`);

    // 等流式回答出现（最多 60 秒）
    let answerLen = 0;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      answerLen = await evaluate(`
        (() => {
          const b = document.querySelector('.bubble.ai');
          return b ? b.innerText.trim().length : 0;
        })()
      `);
      if (answerLen > 30) break;
    }
    console.log(`  AI 回答长度：${answerLen} 字`);

    // 诊断：看看接口到底返回了什么
    const aiCalls = apiCalls.filter((c) => c.url.includes('/ai/'));
    if (aiCalls.length) {
      console.log(`  接口调用：${aiCalls.map((c) => `${c.url} → ${c.status} ${c.mime}`).join(', ')}`);
    } else {
      console.log('  \x1b[33m! 浏览器没有发出 /api/ai/chat 请求\x1b[0m');
    }
    if (apiErrors.length) console.log(`  \x1b[33m网络失败：${apiErrors.slice(0, 4).join(' | ')}\x1b[0m`);

    const domState = await evaluate(`
      (() => {
        const b = document.querySelector('.bubble.ai');
        const err = document.querySelector('.bubble.ai .err');
        return {
          count: b ? 1 : 0,
          list: b ? ['bubble.ai :: ' + b.innerText.replace(/\\n/g, ' ').slice(0, 120)] : [],
          err: err ? err.innerText : '',
          streaming: !!document.querySelector('.typing-caret'),
        };
      })()
    `);
    console.log(`  对话 DOM：${domState.count} 条消息，仍在流式=${domState.streaming}`);
    for (const line of domState.list) console.log(`    · ${line}`);
    if (domState.err) console.log(`  \x1b[31m报错文案：${domState.err}\x1b[0m`);
    await shot('09-AI回答');

    const answerText = await evaluate(`
      (() => {
        const b = document.querySelector('.bubble.ai');
        return b ? b.innerText.trim().slice(0, 400) : '';
      })()
    `);
    console.log(`\n  \x1b[90mAI 回答内容：\x1b[0m\n  ${String(answerText).replace(/\n/g, '\n  ')}\n`);

    // 引用跳转是否可用
    const refCount = await evaluate(`document.querySelectorAll('.cited-item').length`);
    console.log(`  回答里的依据记录：${refCount} 条`);

    // ---- 桌面尺寸再截几张 ----
    await send(ws, 'Emulation.setDeviceMetricsOverride', { width: 1320, height: 950, deviceScaleFactor: 2, mobile: false }, sessionId);
    await evaluate(`location.hash = '#/'`);
    await sleep(1800);
    await shot('10-桌面-记录');
    await evaluate(`location.hash = '#/stats'`);
    await sleep(1800);
    await shot('11-桌面-统计');

    // ---- 深色模式 ----
    await evaluate(`location.hash = '#/'; document.documentElement.dataset.theme = 'dark'; try { localStorage.setItem('shiguang.theme','dark'); } catch(e){}`);
    await sleep(1500);
    await shot('12-深色-记录');
    await evaluate(`location.hash = '#/find'`);
    await sleep(1500);
    await shot('13-深色-拾迹');

    // ---- 移动端记录弹层 ----
    await send(ws, 'Emulation.setDeviceMetricsOverride', MOBILE, sessionId);
    await evaluate(`document.documentElement.dataset.theme = 'light'; try { localStorage.setItem('shiguang.theme','light'); } catch(e){} location.hash = '#/'`);
    await sleep(1400);
    await evaluate(`document.querySelector('.tabbar .fab-main').click()`);
    await sleep(600);
    await evaluate(`[...document.querySelectorAll('.pick-item')][0]?.click()`);
    await sleep(900);
    const sheetOpen = await evaluate(`!!document.querySelector('.recorder')`);
    console.log(`  记录弹层打开：${sheetOpen}`);
    await evaluate(`
      (() => {
        const ta = document.querySelector('.recorder textarea');
        ta.value = '下午把拾光这个网站写完并部署上线，AI 回忆功能测试通过';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()
    `);
    await sleep(600);
    await shot('14-记录弹层');

    // ---- 控制台错误汇总 ----
    console.log('\n\x1b[36m控制台检查\x1b[0m');
    if (pageErrors.length) {
      console.log(`  \x1b[31m页面异常 ${pageErrors.length} 条：\x1b[0m`);
      for (const e of pageErrors.slice(0, 6)) console.log(`    · ${String(e).split('\n')[0]}`);
    } else {
      console.log('  \x1b[32m✓ 没有未捕获的页面异常\x1b[0m');
    }
    const realErrors = consoleErrors.filter((e) => !/favicon|manifest|sw\.js|ERR_/.test(e));
    if (realErrors.length) {
      console.log(`  \x1b[33m控制台 error ${realErrors.length} 条：\x1b[0m`);
      for (const e of realErrors.slice(0, 6)) console.log(`    · ${e.slice(0, 160)}`);
    } else {
      console.log('  \x1b[32m✓ 没有控制台报错\x1b[0m');
    }
    console.log(`\n截图目录：${OUT}\n`);
  } finally {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    proc.kill('SIGKILL');
  }
}

main().catch((e) => {
  console.error('\x1b[31m截图失败：\x1b[0m', e.message);
  process.exit(1);
});
