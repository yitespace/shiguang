// =============================================================
// 拾光 · 语音功能验收（真实浏览器）
// 无头环境拿不到真麦克风，所以这条链路这样验：
//   1) 语音弹层的入口、打开、UI 状态
//   2) 用脚本直接注入一段「转写文本」→ 走真实的 AI 提炼接口
//   3) 保存 → 检查时间线里的回放条 / 要点 / 语音原文
//   4) 通过接口塞一段真录音挂到记录上 → 检查回放组件能加载（Range 请求）
//   5) 关闭时清理测试数据
//
// 用法：node scripts/verify-voice.mjs [baseUrl]
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

const PORT = 9350;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.shots-voice');

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

/** 一段真实的口语（有语气词、重复） */
const SPOKEN =
  '呃今天那个心情挺差的然后就是客户系统又改需求了嘛我下午改接口改到六点多饭都没顾上吃不过后来小李帮我带了份饭还挺感动的';

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
      // 允许无麦克风环境下走假设备，避免权限流程卡住
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--force-device-scale-factor=2',
      `--user-data-dir=${path.join(os.tmpdir(), 'sg-voice-profile')}`,
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
  // 授权麦克风，让录音按钮流程能往下走
  await send(
    ws,
    'Browser.grantPermissions',
    { origin: BASE, permissions: ['audioCapture'] },
    undefined,
  ).catch(() => {});
  await send(ws, 'Emulation.setDeviceMetricsOverride', { width: 412, height: 900, deviceScaleFactor: 2, mobile: true }, S);

  const ev = async (expression) => {
    const r = await send(ws, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, S);
    if (r.exceptionDetails) return `ERR:${String(r.exceptionDetails.exception?.description || '').slice(0, 200)}`;
    return r.result?.value;
  };
  const shot = async (name) => {
    fs.mkdirSync(OUT, { recursive: true });
    const { data } = await send(ws, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, S);
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
    console.log(`  📷 ${name}.png`);
  };

  try {
    console.log(`\n\x1b[36m拾光 · 语音功能验收\x1b[0m  ${BASE}\n`);

    await send(ws, 'Page.navigate', { url: `${BASE}/` }, S);
    await sleep(4000);
    // 注销 Service Worker 并清掉它 precache 的页面。
    // 只注销不清缓存的话，浏览器可能还在跑上一版构建，
    // 测出来的「失败」其实是旧代码的，排查方向会被带偏。
    await send(ws, 'Runtime.evaluate', { expression: `(async () => { try { const rs = await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map(r => r.unregister())); const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); } catch {} })()`, awaitPromise: true }, S);
    await sleep(400);

    // 登录
    for (let i = 0; i < 8; i++) {
      if (await ev(`!!document.querySelector('.shell')`)) break;
      await ev(LOGIN_JS);
      await sleep(300);
      await ev(`document.querySelector('.gate .btn-primary')?.click()`);
      await sleep(2200);
    }
    check('登录成功', await ev(`!!document.querySelector('.shell')`));

    // 1) 入口按钮
    check('底栏有「记一记」大按钮', await ev(`!!document.querySelector('.tabbar .fab-main')`));
    await shot('01-底栏语音入口');

    // 2) 打开语音弹层
    // 现在录音入口收在「记一记」里：先点大按钮，再选「说一句」
    await ev(`document.querySelector('.tabbar .fab-main').click()`);
    await sleep(600);
    await ev(`[...document.querySelectorAll('.pick-item')][1]?.click()`);
    await sleep(900);
    check('语音弹层能打开', await ev(`!!document.querySelector('.voice-sheet')`));
    check('显示录音按钮', await ev(`!!document.querySelector('.rec-btn')`));
    const supportMsg = await ev(`!!document.querySelector('.voice-sheet .banner')`);
    console.log(`  录音可用性提示：${supportMsg ? '显示不支持提示' : '正常（可录音）'}`);
    await shot('02-语音待机');

    // 3) 真实开始录音（假麦克风）
    await ev(`document.querySelector('.rec-btn').click()`);
    await sleep(2500);
    const recording = await ev(`!!document.querySelector('.rec-btn.is-stop')`);
    check('能进入录音状态', recording, '（无头环境若无麦克风会显示提示）');
    if (recording) {
      await sleep(1500);
      const t = await ev(`document.querySelector('.rec-time')?.innerText`);
      check('录音计时在走', /\d{2}:\d{2}/.test(String(t)), `计时=${t}`);
      check('波形画布存在', await ev(`!!document.querySelector('canvas.wave')`));
      await shot('03-录音中');
      // 结束录音 -> 会走真实的上传+转写
      await ev(`document.querySelector('.rec-btn.is-stop').click()`);
      await sleep(9000);
    }

    // 4) 注入一段真实口语，走真实 AI 提炼（不依赖麦克风）
    await ev(`
      (() => {
        const sheet = document.querySelector('.voice-sheet');
        if (!sheet) { window.dispatchEvent(new CustomEvent('sg:voice')); return 'opened'; }
        return 'already';
      })()
    `);
    await sleep(1200);
    // 直接切到预览态：填入转写文本
    const injected = await ev(`
      (() => {
        const ta = document.querySelector('.voice-sheet textarea');
        if (!ta) return 'no-textarea';
        ta.value = ${JSON.stringify(SPOKEN)};
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return 'ok';
      })()
    `);
    check('能填入转写文本', injected === 'ok', String(injected));
    await sleep(400);

    // 点「让 AI 整理要点」
    const clicked = await ev(`
      (() => {
        const b = document.querySelector('.voice-sheet .ai-refine');
        if (!b) return 'no-button';
        if (b.disabled) return 'disabled';
        b.click();
        return 'clicked';
      })()
    `);
    check('AI 整理按钮可用', clicked === 'clicked', String(clicked));

    // 等要点出现
    let points = [];
    for (let i = 0; i < 45; i++) {
      await sleep(1000);
      points = (await ev(`Array.from(document.querySelectorAll('.voice-sheet .points li')).map(li => li.innerText.trim())`)) || [];
      if (points.length) break;
    }
    check('AI 提炼出要点', points.length >= 1, JSON.stringify(points));
    console.log(`  要点：${JSON.stringify(points)}`);
    // 心情是 AI 顺带判断的，可能比要点晚一拍才渲染出来，轮询等一下
    let moodText = '';
    for (let i = 0; i < 15; i++) {
      moodText = await ev(`document.querySelector('.voice-sheet .mood-btn.is-active .label')?.innerText || ''`);
      if (moodText) break;
      await sleep(700);
    }
    console.log(`  AI 判断心情：${moodText || '（未判断）'}`);
    check('AI 判断了心情（这段话有明显负面情绪）', !!moodText);
    const tagText = await ev(`Array.from(document.querySelectorAll('.voice-sheet .tags-row .chip.is-active')).map(c => c.innerText.trim())`);
    console.log(`  AI 建议标签：${JSON.stringify(tagText)}`);
    await shot('04-AI提炼结果');

    // 5) 保存
    const saved = await ev(`
      (() => {
        const btns = Array.from(document.querySelectorAll('.voice-sheet .acts .btn'));
        const b = btns.find(x => /保存/.test(x.innerText));
        if (!b) return 'no-save';
        b.click();
        return 'clicked';
      })()
    `);
    check('保存按钮可点', saved === 'clicked', String(saved));
    await sleep(4000);
    await shot('05-保存后首页');

    const inTimeline = await ev(`document.querySelector('.day-group')?.innerText.includes('客户系统') || document.body.innerText.includes('客户系统')`);
    check('语音记录出现在时间线', !!inTimeline);

    // 6) 用接口塞一段真录音，验证回放组件与 Range
    await ev(`location.hash = '#/'`);
    await sleep(800);
    const attached = await ev(`
      (async () => {
        const m = location.pathname.match(/^(.*\\/shiguang)\\//);
        const api = (m ? m[1] : '') + '/api';
        // 4KB 的伪音频，只验证存储与播放链路
        const bytes = new Uint8Array(4096);
        bytes.set([0x1a,0x45,0xdf,0xa3], 0);
        let bin = '';
        for (const b of bytes) bin += String.fromCharCode(b);
        const b64 = btoa(bin);
        const up = await fetch(api + '/voice/upload', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audio: b64, mime: 'audio/webm', durationMs: 8000, transcript: '这是通过接口塞进来的测试语音' }),
        }).then(r => r.json());
        if (!up.ok) return 'upload-failed:' + JSON.stringify(up).slice(0, 80);
        const id = up.data.audio.id;
        const mk = await fetch(api + '/entries', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: '（语音记录）测试回放',
            kind: 'voice',
            attachments: [{ id, durationMs: 8000, points: ['回放测试要点'] }],
          }),
        }).then(r => r.json());
        return mk.ok ? id : 'entry-failed';
      })()
    `);
    check('能通过接口挂上真录音', typeof attached === 'string' && attached.length > 20, String(attached));

    await ev(`location.reload()`);
    await sleep(4500);
    const playerOk = await ev(`!!document.querySelector('.vp')`);
    check('时间线里渲染出回放组件', playerOk);
    const pointOk = await ev(`document.body.innerText.includes('回放测试要点')`);
    check('展示语音要点', pointOk);
    await shot('06-回放组件');

    // 回放组件的音频能否真的加载（触发 Range 请求）
    const audioState = await ev(`
      (async () => {
        const a = document.querySelector('.vp audio');
        if (!a) return 'no-audio';
        a.load();
        await new Promise(r => setTimeout(r, 1500));
        return JSON.stringify({ src: a.getAttribute('src'), readyState: a.readyState, err: a.error ? a.error.code : null });
      })()
    `);
    console.log(`  audio 元素状态：${audioState}`);
    const ranged = apiLog.some((l) => /206 .*\/api\/audio\//.test(l));
    check('录音通过 Range 请求加载（可拖动）', ranged, ranged ? '' : '未见 206 响应');

    // 7) 清理
    const cleaned = await ev(`
      (async () => {
        const m = location.pathname.match(/^(.*\\/shiguang)\\//);
        const api = (m ? m[1] : '') + '/api';
        const list = await fetch(api + '/entries?limit=2000', { credentials: 'include' }).then(r => r.json());
        let n = 0;
        for (const e of list.data.entries) {
          if (e.kind === 'voice' || /客户系统|测试回放/.test(e.content)) {
            for (const a of e.attachments || []) {
              await fetch(api + '/audio/' + a.id, { method: 'DELETE', credentials: 'include' }).catch(() => {});
            }
            await fetch(api + '/entries/' + e.id, { method: 'DELETE', credentials: 'include' });
            n++;
          }
        }
        return n;
      })()
    `);
    check('测试数据已清理', Number(cleaned) >= 1, `清理了 ${cleaned} 条`);

    // 8) 控制台
    const realErrors = consoleErrors.filter((e) => !/favicon|manifest|sw\.js|ERR_|Failed to load resource/i.test(e));
    check('没有未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
    check('没有控制台报错', realErrors.length === 0, realErrors.slice(0, 2).join(' | '));

    console.log('\n\x1b[36m语音相关接口调用\x1b[0m');
    for (const l of [...new Set(apiLog)].filter((x) => /voice|audio/.test(x))) console.log(`  ${l}`);
  } finally {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    proc.kill('SIGKILL');
  }

  console.log(
    `\n\x1b[1m${failed === 0 ? '\x1b[32m语音功能验收全部通过' : '\x1b[31m有失败项'}\x1b[0m  ${pass} 通过 / ${failed} 失败\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\x1b[31m验收脚本异常：\x1b[0m', e.message);
  process.exit(1);
});
