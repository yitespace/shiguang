// =============================================================
// 拾光 · 关怀模块验收（吃药提醒 / 快捷提醒 / 学习模式）
//
// 用法：node scripts/verify-care.mjs [baseUrl]
//
// 纯计算那部分在 scripts/test-care.mjs 里压（跨零点、疗程、提前量……）。
// 这个脚本查的是「装到界面上之后还对不对」：
//   · 「我的」页的关怀区块三个入口
//   · 吃药：手动添加、打卡、撤销、按需服用那条特殊路径
//   · 快捷提醒：手加一条、从记录里自动认出来
//   · 学习模式：网页版如实说「拦不住」而不是画个假开关
//   · 接口鉴权：没登录的人碰不到任何一条
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

const PORT = 9422;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.shots-care');

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

const HOME = process.env.HOME || os.homedir();
const CHROME = [
  path.join(HOME, '.cache/ms-playwright/chromium-1217/chrome-linux64/chrome'),
  path.join(HOME, '.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell'),
].find((p) => fs.existsSync(p));

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
      '--lang=zh-CN',
      '--password-store=basic',
      '--use-mock-keyring',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--force-device-scale-factor=2',
      `--user-data-dir=${path.join(os.tmpdir(), 'sg-care')}`,
      'about:blank',
    ],
    { stdio: 'ignore', env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: '/dev/null' } },
  );

  try {
    let target = null;
    for (let i = 0; i < 60 && !target; i++) {
      try {
        const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
        target = list.find((t) => t.type === 'page');
      } catch {
        /* 还没起来 */
      }
      if (!target) await sleep(250);
    }
    if (!target) throw new Error('连不上浏览器');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
        return;
      }
      if (m.method === 'Runtime.exceptionThrown') {
        pageErrors.push(String(m.params.exceptionDetails.exception?.description || '').slice(0, 200));
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        consoleErrors.push(m.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 200));
      }
    });
    await new Promise((r) => ws.addEventListener('open', r));

    const s = await send(ws, 'Target.attachToTarget', { targetId: target.id, flatten: true });
    const S = s.sessionId;
    await send(ws, 'Runtime.enable', {}, S);
    await send(ws, 'Page.enable', {}, S);
    await send(ws, 'Network.enable', {}, S);

    const ev = async (expr) => {
      const r = await send(ws, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, S);
      if (r.exceptionDetails) return `ERR:${String(r.exceptionDetails.exception?.description || '').slice(0, 160)}`;
      return r.result?.value;
    };
    const shot = async (name, beyond = true) => {
      fs.mkdirSync(OUT, { recursive: true });
      /*
       * captureBeyondViewport 会把整页拉长再截，position:fixed 的浮层
       * 就会跑到拉长后视口的最上面去，看起来像「浮卡出现在页首」。
       * 要截浮层就用 beyond=false，按真实视口截。
       */
      const { data } = await send(ws, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: beyond }, S);
      fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
      console.log(`  📷 ${name}.png`);
    };
    /** 页面里直接打接口，省得每个用例都去点界面 */
    const apiCall = (js) =>
      ev(`(async () => { const _m = location.pathname.match(/^(.*\\/shiguang)\\//); const api = (_m ? _m[1] : '') + '/api'; ${js} })()`);

    console.log(`\n\x1b[36m拾光 · 关怀模块验收\x1b[0m  ${BASE}\n`);

    // ---------- 0. 没登录的人碰不到 ----------
    console.log('  \x1b[36m· 未登录的门禁\x1b[0m');
    const guard = await fetch(`${BASE}/api/care/today`).then((r) => r.json()).catch(() => ({}));
    check('未登录读不到今天的药', guard.ok === false, JSON.stringify(guard).slice(0, 80));
    const guard2 = await fetch(`${BASE}/api/care/meds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '偷偷加的', slots: [{ at: '08:00' }] }),
    }).then((r) => r.json()).catch(() => ({}));
    check('未登录加不了药', guard2.ok === false, JSON.stringify(guard2).slice(0, 80));

    // ---------- 登录 ----------
    await send(ws, 'Page.navigate', { url: `${BASE}/` }, S);
    await sleep(3000);
    await send(ws, 'Runtime.evaluate', { expression: `(async () => { try { const rs = await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map(r => r.unregister())); const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); } catch {} })()`, awaitPromise: true }, S);
    await sleep(400);
    await send(ws, 'Page.navigate', { url: `${BASE}/` }, S);
    await sleep(3000);
    for (let i = 0; i < 8; i++) {
      if (await ev(`!!document.querySelector('.shell')`)) break;
      await ev(LOGIN_JS);
      await sleep(400);
      await ev(`document.querySelector('.gate .btn-primary')?.click()`);
      await sleep(2200);
    }
    check('登录成功', await ev(`!!document.querySelector('.shell')`));

    // 清干净再开始，免得上一轮的药影响计数
    await apiCall(`
      const meds = await fetch(api + '/care/meds', { credentials: 'include' }).then(r => r.json());
      for (const m of (meds.data?.meds || [])) {
        await fetch(api + '/care/meds/' + m.id, { method: 'DELETE', credentials: 'include' });
      }
      const rem = await fetch(api + '/care/reminders', { credentials: 'include' }).then(r => r.json());
      for (const r of (rem.data?.reminders || [])) {
        await fetch(api + '/care/reminders/' + r.id, { method: 'DELETE', credentials: 'include' });
      }
      return 'cleared';
    `);

    // ---------- 1. 「我的」页的关怀区块 ----------
    console.log('\n  \x1b[36m· 「我的」页的关怀区块\x1b[0m');
    await ev(`location.hash = '#/mine'`);
    await sleep(2200);
    const careBox = JSON.parse(
      String(
        await ev(`(() => {
          const t = [...document.querySelectorAll('.group-title')].find(x => x.textContent.includes('关怀'));
          return JSON.stringify({
            hasTitle: !!t,
            entries: [...document.querySelectorAll('.care-med, .care-tile')].map(x => x.innerText.split('\\n')[0]),
          });
        })()`),
      ),
    );
    check('「我的」页有「关怀」区块', careBox.hasTitle === true, JSON.stringify(careBox));
    check(
      '三个入口都在',
      ['吃药提醒', '快捷提醒', '学习模式'].every((n) => careBox.entries.some((e) => e.includes(n))),
      JSON.stringify(careBox.entries),
    );
    await ev(`document.querySelector('.care-med')?.click()`);
    await sleep(2000);
    check('点「吃药提醒」能进页面', (await ev(`location.hash`)) === '#/meds');
    await shot('01-吃药提醒-空状态');

    const emptyTip = await ev(`document.querySelector('.meds-page .empty')?.innerText || ''`);
    check('空状态说明了三条录入路径', /说一句|打字|处方/.test(String(emptyTip)), String(emptyTip).slice(0, 60));

    // ---------- 2. 手动加一种药 ----------
    console.log('\n  \x1b[36m· 吃药：添加与打卡\x1b[0m');
    const made = await apiCall(`
      const r = await fetch(api + '/care/meds', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '验收用药', dose: '1 片', slots: [{ at: '08:00', label: '早', dose: '1 片' }, { at: '20:00', label: '晚', dose: '半片' }] }),
      }).then(x => x.json());
      return JSON.stringify({ ok: r.ok, id: r.data?.med?.id, today: r.data?.today?.map(x => [x.at, x.dose, x.status]) });
    `);
    const madeObj = JSON.parse(String(made));
    check('能加一种药', madeObj.ok === true, String(made).slice(0, 120));
    check('两个时间点各带自己的剂量', madeObj.today?.[0]?.[1] === '1 片' && madeObj.today?.[1]?.[1] === '半片', JSON.stringify(madeObj.today));
    const medId = madeObj.id;

    await ev(`location.hash = '#/'`);
    await sleep(1200);
    await ev(`location.hash = '#/meds'`);
    await sleep(2000);
    const rendered = JSON.parse(
      String(
        await ev(`JSON.stringify({
          rows: document.querySelectorAll('.dose-card .dose-row').length,
          head: document.querySelector('.dose-head b')?.innerText || '',
          acts: [...document.querySelectorAll('.dose-card .dr-act')].map(b => b.innerText.trim()),
        })`),
      ),
    );
    check('界面上列出了这一次的药', rendered.rows === 2, JSON.stringify(rendered));
    check('提醒还有几次没吃', /还有 2 次/.test(rendered.head), rendered.head);
    check('每一次都有「吃了」按钮', rendered.acts.filter((a) => a === '吃了').length === 2, JSON.stringify(rendered.acts));

    // 点「吃了」
    await ev(`Array.from(document.querySelectorAll('.dose-card .dr-act')).find(b => b.innerText.trim() === '吃了')?.click()`);
    await sleep(1800);
    const afterTake = JSON.parse(
      String(
        await ev(`JSON.stringify({
          head: document.querySelector('.dose-head b')?.innerText || '',
          done: document.querySelectorAll('.dose-card .dr-act.done').length,
        })`),
      ),
    );
    check('打卡之后计数减一', /还有 1 次/.test(afterTake.head), afterTake.head);
    check('打过的那次变成对勾', afterTake.done === 1, JSON.stringify(afterTake));
    await shot('02-吃药提醒-打过卡');

    // 撤销
    await ev(`document.querySelector('.dose-card .dr-act.done')?.click()`);
    await sleep(1800);
    check('撤销之后回到未处理', /还有 2 次/.test(String(await ev(`document.querySelector('.dose-head b')?.innerText || ''`))));

    // ---------- 3. 按需服用的药 ----------
    console.log('\n  \x1b[36m· 吃药：必要时服用\x1b[0m');
    const prn = await apiCall(`
      const r = await fetch(api + '/care/meds', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '验收按需药', dose: '1 片', slots: [{ at: '22:00', label: '睡前' }], prn: true }),
      }).then(x => x.json());
      const t = await fetch(api + '/care/today', { credentials: 'include' }).then(x => x.json());
      return JSON.stringify({ ok: r.ok, pending: t.data?.meds?.pending });
    `);
    const prnObj = JSON.parse(String(prn));
    check('能加一种「必要时服用」的药', prnObj.ok === true);
    check('按需的药不算进「还有几次没吃」', prnObj.pending === 2, `实际 ${prnObj.pending}（应为 2，不含按需那次）`);

    await ev(`location.hash = '#/'`);
    await sleep(1000);
    await ev(`location.hash = '#/meds'`);
    await sleep(2000);
    const prnUi = JSON.parse(
      String(
        await ev(`JSON.stringify({
          hasSection: !!document.querySelector('.prn-card'),
          note: document.querySelector('.prn-note')?.innerText || '',
          rows: [...document.querySelectorAll('.prn-card .dose-row')].map(r => r.innerText.replace(/\\n/g, ' ')),
          acts: [...document.querySelectorAll('.prn-card .dr-act')].map(b => b.innerText.trim()),
        })`),
      ),
    );
    check('按需的药单独一块', prnUi.hasSection === true && prnUi.rows.length === 1, JSON.stringify(prnUi.rows));
    check('说明了为什么不提醒', /不会定时提醒|依赖/.test(prnUi.note), prnUi.note.slice(0, 60));
    check('按需的药不显示具体时刻（免得像有钟点）', /睡前/.test(prnUi.rows[0]) && !/22:00/.test(prnUi.rows[0]), prnUi.rows[0]);
    check('按钮是「记一笔」而不是「吃了」', prnUi.acts[0] === '记一笔', JSON.stringify(prnUi.acts));
    await shot('03-吃药提醒-按需');

    // ---------- 4. 时间表里不能出现按需的药 ----------
    const sched = await apiCall(`
      const r = await fetch(api + '/care/schedule?days=3', { credentials: 'include' }).then(x => x.json());
      const meds = r.data.schedule.filter(x => x.kind === 'med');
      return JSON.stringify({ total: meds.length, names: [...new Set(meds.map(x => x.body))] });
    `);
    const schedObj = JSON.parse(String(sched));
    check('时间表里只有定时的那两种次', !schedObj.names.some((n) => n.includes('按需')), JSON.stringify(schedObj.names));

    // ---------- 5. 快捷提醒：手动加一条 ----------
    console.log('\n  \x1b[36m· 快捷提醒\x1b[0m');
    await ev(`location.hash = '#/reminders'`);
    await sleep(2200);
    await ev(`document.querySelector('.page-head .icon-btn')?.click()`);
    await sleep(900);
    const filled = await ev(`
      (() => {
        const set = (el, v) => {
          const proto = window.HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        const inputs = document.querySelectorAll('.sheet-body input');
        if (inputs.length < 3) return 'no-inputs';
        set(inputs[0], '验收提醒');
        set(inputs[1], new Date(Date.now() + 86400000).toISOString().slice(0, 10));
        set(inputs[2], '09:30');
        return 'ok';
      })()
    `);
    check('能填提醒表单', filled === 'ok', String(filled));
    await sleep(400);
    await ev(`Array.from(document.querySelectorAll('.sheet-body .btn')).find(b => /设好/.test(b.innerText))?.click()`);
    await sleep(2200);
    const remUi = JSON.parse(
      String(
        await ev(`JSON.stringify({
          rows: [...document.querySelectorAll('.list .row')].map(r => r.innerText.replace(/\\n/g, ' ')),
          sheetGone: !document.querySelector('.sheet-mask'),
        })`),
      ),
    );
    check('提醒出现在「接下来」', remUi.rows.some((r) => r.includes('验收提醒')), JSON.stringify(remUi.rows));
    check('设完面板关掉', remUi.sheetGone === true);
    check('显示了提前量', remUi.rows.some((r) => /提前 10 分/.test(r)), JSON.stringify(remUi.rows));
    await shot('04-快捷提醒');

    // ---------- 6. 从记录里自动认出来 ----------
    console.log('\n  \x1b[36m· 从记录里认出提醒\x1b[0m');
    const detected = await apiCall(`
      const r = await fetch(api + '/care/reminders/detect', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '我晚上十点有一个会，得提前准备一下' }),
      }).then(x => x.json());
      return JSON.stringify({ ok: r.ok, found: r.data?.found, title: r.data?.title, at: r.data?.at });
    `);
    const det = JSON.parse(String(detected));
    if (det.ok && det.found) {
      check('「晚上十点有个会」被认出来了', det.title === '开会' || /会/.test(String(det.title)), JSON.stringify(det));
      check('认出来的时间是今天晚上十点', /T22:00$/.test(String(det.at)), String(det.at));
    } else {
      // 没配 AI Key 时这条跳过，但要说不清为什么，别静悄悄地过
      console.log(`  \x1b[33m! 跳过自动识别（接口返回 ${JSON.stringify(det)}）\x1b[0m`);
      check('识别接口可用（没配 AI Key 时允许跳过）', det.ok === false, JSON.stringify(det));
    }

    const noise = await apiCall(`
      const r = await fetch(api + '/care/reminders/detect', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '今天好累啊，什么都不想干' }),
      }).then(x => x.json());
      return JSON.stringify({ ok: r.ok, found: r.data?.found });
    `);
    const noiseObj = JSON.parse(String(noise));
    check('纯情绪的记录不会被硬认出提醒', noiseObj.found !== true, JSON.stringify(noiseObj));

    const past = await apiCall(`
      const r = await fetch(api + '/care/reminders/detect', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '昨天十点开了个会，开到很晚' }),
      }).then(x => x.json());
      return JSON.stringify({ ok: r.ok, found: r.data?.found });
    `);
    check('已经过去的事不会被认成提醒', JSON.parse(String(past)).found !== true, String(past).slice(0, 80));

    // ---------- 6b. 写完一条记录之后浮出来的那张卡 ----------
    /*
     * 这条是整条链路里最容易出问题的一段：保存 → 广播 sg:saved →
     * App.vue 里识别 → 浮卡 → 点「好」→ 存提醒 + 重排本地通知。
     * 任何一环断了，用户都不会发现 —— 他只会觉得「不是说会问我吗」。
     */
    console.log('\n  \x1b[36m· 写完记录之后的那张浮卡\x1b[0m');
    if (det.ok && det.found) {
      // 先把「以后别问了」清掉，否则这一轮会被上次的选择挡住
      await ev(`localStorage.removeItem('sg.remind.auto')`);
      // 上一轮识别出来的那条提醒也删掉，免得 entryId 去重把它挡了
      await apiCall(`
        const rem = await fetch(api + '/care/reminders', { credentials: 'include' }).then(r => r.json());
        for (const r of (rem.data?.reminders || [])) {
          if (r.source === 'note') await fetch(api + '/care/reminders/' + r.id, { method: 'DELETE', credentials: 'include' });
        }
        return 'ok';
      `);

      await ev(`location.hash = '#/'`);
      await sleep(2200);
      const typed = await ev(`
        (() => {
          const ta = document.querySelector('.quick textarea');
          if (!ta) return 'no-input';
          const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          set.call(ta, '我晚上十点有一个会，得提前把材料准备好');
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          return 'ok';
        })()
      `);
      check('能往首页输入框里写字', typed === 'ok', String(typed));
      await sleep(500);
      await ev(`document.querySelector('.quick-send')?.click()`);
      await sleep(1500);

      let promptUp = false;
      for (let i = 0; i < 40; i++) {
        promptUp = (await ev(`!!document.querySelector('.prompt-mask')`)) === true;
        if (promptUp) break;
        await sleep(700);
      }
      check('写完带时间的记录之后会浮出「要不要设提醒」', promptUp === true);
      if (promptUp) {
        const pText = await ev(`document.querySelector('.prompt')?.innerText.replace(/\\n/g, ' ') || ''`);
        check('浮卡里写清楚了是什么事', /会/.test(String(pText)), String(pText).slice(0, 70));
        await shot('07-写完记录后的提醒浮卡', false);

        await ev(`Array.from(document.querySelectorAll('.prompt .btn')).find(b => /好/.test(b.innerText))?.click()`);
        await sleep(2500);
        check('点「好」之后浮卡消失', (await ev(`!document.querySelector('.prompt-mask')`)) === true);
        const saved = await apiCall(`
          const r = await fetch(api + '/care/reminders', { credentials: 'include' }).then(x => x.json());
          const fromNote = (r.data?.reminders || []).filter(x => x.source === 'note');
          return JSON.stringify({ n: fromNote.length, title: fromNote[0]?.title, entryId: !!fromNote[0]?.entryId });
        `);
        const sv = JSON.parse(String(saved));
        check('提醒真的存下来了', sv.n === 1, String(saved));
        check('记了是从哪条记录来的（同一条不再问第二遍）', sv.entryId === true, String(saved));
      }

      // 「以后别问了」要真的记住
      await ev(`localStorage.setItem('sg.remind.auto', '0')`);
      check('关掉之后有个标记记着', (await ev(`localStorage.getItem('sg.remind.auto')`)) === '0');
      await ev(`localStorage.removeItem('sg.remind.auto')`);
    } else {
      console.log('  \x1b[33m! 没配 AI Key，跳过浮卡链路\x1b[0m');
    }
    // 把这条测试记录清掉，别留在时间线上
    await apiCall(`
      const list = await fetch(api + '/entries?limit=50', { credentials: 'include' }).then(r => r.json());
      for (const e of (list.data?.entries || [])) {
        if (e.content.includes('晚上十点有一个会')) {
          await fetch(api + '/entries/' + e.id, { method: 'DELETE', credentials: 'include' });
        }
      }
      return 'ok';
    `);

    // ---------- 7. 学习模式：网页版必须说实话 ----------
    console.log('\n  \x1b[36m· 学习模式\x1b[0m');
    await ev(`location.hash = '#/focus'`);
    await sleep(2200);
    const focusUi = JSON.parse(
      String(
        await ev(`JSON.stringify({
          hasCap: !!document.querySelector('.cap-card'),
          capTitle: document.querySelector('.cap-body b')?.innerText || '',
          capText: document.querySelector('.cap-body p')?.innerText || '',
          timer: !!document.querySelector('.timer-card'),
          empty: !!document.querySelector('.empty'),
        })`),
      ),
    );
    check('网页版明说拦不住应用', /拦不住/.test(focusUi.capTitle), focusUi.capTitle);
    check('并且解释了为什么', /浏览器|App/.test(focusUi.capText), focusUi.capText.slice(0, 50));
    check('没有画一个假的锁开关', focusUi.hasCap === true && !/专注中/.test(focusUi.capTitle));
    check('专注计时照常可用', focusUi.timer === true);
    await shot('05-学习模式-网页版');

    // 计时能真的跑起来
    await ev(`Array.from(document.querySelectorAll('.timer-card .btn')).find(b => /开始/.test(b.innerText))?.click()`);
    await sleep(2600);
    const ticking = JSON.parse(
      String(
        await ev(`JSON.stringify({
          running: !!document.querySelector('.timer-run'),
          left: document.querySelector('.timer-run b')?.innerText || '',
        })`),
      ),
    );
    check('倒计时在走', ticking.running === true && /^\d{2}:\d{2}$/.test(ticking.left), JSON.stringify(ticking));
    check('计数确实在减', ticking.left !== '25:00', ticking.left);
    // 停掉，别留着定时器
    await ev(`Array.from(document.querySelectorAll('.timer-run .btn')).find(b => /停/.test(b.innerText))?.click()`);
    await sleep(1500);

    // 规则能存下来
    const savedFocus = await apiCall(`
      const r = await fetch(api + '/care/focus', { credentials: 'include' }).then(x => x.json());
      return JSON.stringify({ ok: r.ok, blocks: r.data?.focus?.blocks?.length ?? -1 });
    `);
    check('学习模式设置读得回来', JSON.parse(String(savedFocus)).ok === true, String(savedFocus).slice(0, 80));

    // ---------- 8. 首页浮卡 ----------
    console.log('\n  \x1b[36m· 首页的未服药浮卡\x1b[0m');
    await ev(`location.hash = '#/'`);
    await sleep(2500);
    const homeCard = JSON.parse(
      String(
        await ev(`(() => {
          const el = document.querySelector('.meds-due');
          return JSON.stringify({ present: !!el, text: el ? el.innerText.replace(/\\n/g, ' ') : '' });
        })()`),
      ),
    );
    check('今天有没吃的药时首页会浮一张卡', homeCard.present === true, JSON.stringify(homeCard));
    check('卡上写了还有几次', /还有 2 次/.test(homeCard.text), homeCard.text);
    await shot('06-首页-未服药浮卡');

    // 全部吃完之后浮卡该消失
    const allTaken = await apiCall(`
      const meds = await fetch(api + '/care/meds', { credentials: 'include' }).then(r => r.json());
      const d = new Date(); const p = (n) => String(n).padStart(2, '0');
      const today = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
      for (const m of meds.data.meds) {
        for (const s of m.slots) {
          await fetch(api + '/care/meds/' + m.id + '/dose', {
            method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ at: s.at, date: today, action: 'taken' }),
          });
        }
      }
      const t = await fetch(api + '/care/today', { credentials: 'include' }).then(r => r.json());
      return JSON.stringify({ pending: t.data.meds.pending });
    `);
    check('全打卡之后待办归零', JSON.parse(String(allTaken)).pending === 0, String(allTaken));
    await ev(`location.hash = '#/mine'`);
    await sleep(1200);
    await ev(`location.hash = '#/'`);
    await sleep(2500);
    check('吃完之后首页浮卡消失', (await ev(`!document.querySelector('.meds-due')`)) === true);

    // ---------- 9. 收尾 ----------
    console.log('\n  \x1b[36m· 清理\x1b[0m');
    const cleaned = await apiCall(`
      const meds = await fetch(api + '/care/meds', { credentials: 'include' }).then(r => r.json());
      for (const m of (meds.data?.meds || [])) {
        await fetch(api + '/care/meds/' + m.id, { method: 'DELETE', credentials: 'include' });
      }
      const rem = await fetch(api + '/care/reminders', { credentials: 'include' }).then(r => r.json());
      for (const r of (rem.data?.reminders || [])) {
        await fetch(api + '/care/reminders/' + r.id, { method: 'DELETE', credentials: 'include' });
      }
      await fetch(api + '/care/focus', {
        method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocks: [], alwaysAllow: [] }),
      });
      const t = await fetch(api + '/care/today', { credentials: 'include' }).then(r => r.json());
      const meds2 = await fetch(api + '/care/meds', { credentials: 'include' }).then(r => r.json());
      const rem2 = await fetch(api + '/care/reminders', { credentials: 'include' }).then(r => r.json());
      return JSON.stringify({ meds: meds2.data.meds.length, reminders: rem2.data.reminders.length, pending: t.data.meds.pending });
    `);
    const cl = JSON.parse(String(cleaned));
    check('测试数据清理干净', cl.meds === 0 && cl.reminders === 0 && cl.pending === 0, JSON.stringify(cl));

    console.log('\n  \x1b[36m· 控制台\x1b[0m');
    const realErrors = consoleErrors.filter((e) => !/favicon|网络连接失败|Failed to load resource/i.test(e));
    check('没有未捕获异常', pageErrors.length === 0, pageErrors[0] || '');
    check('没有控制台报错', realErrors.length === 0, realErrors[0] || '');

    ws.close();
  } finally {
    proc.kill();
  }

  console.log('');
  if (failed) {
    console.log(`\x1b[1m\x1b[31m有失败项\x1b[0m  ${pass} 通过 / ${failed} 失败`);
    console.log(`失败项：${failures.join('、')}`);
    process.exit(1);
  }
  console.log(`\x1b[1m\x1b[32m关怀模块验收全部通过\x1b[0m  ${pass} 通过 / 0 失败`);
  process.exit(0);
}

main().catch((e) => {
  console.error('\n\x1b[31m脚本挂了：\x1b[0m', e);
  process.exit(1);
});
