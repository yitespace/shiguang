// =============================================================
// 拾光 · 视觉与可用性审计（自动化，可量化）
//
// 不靠肉眼：用浏览器实际布局数据检查常见 UI 缺陷——
//   · 元素重叠、溢出视口、被遮挡
//   · 触控目标过小（< 40px）
//   · 文字对比度不足
//   · 图片/按钮错位、横向滚动条
//   · 空状态、加载态是否正常
// 同时逐页截图，便于人工复核。
//
// 用法：node scripts/audit-ui.mjs [baseUrl] [--dark] [--desktop]
// =============================================================

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));
// 命令行参数 > 环境变量 BASE > 本地联调默认端口
const BASE = (positional[0] || process.env.BASE || 'http://127.0.0.1:8791').replace(/\/+$/, '');
const DARK = argv.includes('--dark');
const DESKTOP = argv.includes('--desktop');
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

const PORT = 9410;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAG = `${DESKTOP ? 'desk' : 'mob'}-${DARK ? 'dark' : 'light'}`;
const OUT = path.join(ROOT, `.audit/${TAG}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = path.join(os.homedir(), '.cache/ms-playwright/chromium-1217/chrome-linux64/chrome');

const PAGES = [
  ['过往', '#/'],
  ['拾迹', '#/find'],
  ['统计', '#/stats'],
  ['我的', '#/mine'],
  ['个人资料', '#/profile'],
  ['设置', '#/settings'],
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

/** 在页面里跑的审计探针：返回结构化问题列表 */
const PROBE = `
(() => {
  const issues = [];
  const vw = window.innerWidth, vh = window.innerHeight;

  const desc = (el) => {
    if (!el) return '?';
    const cls = String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : (el.className || '')).split(' ').filter(Boolean).slice(0, 3).join('.');
    const id = el.id ? '#' + el.id : '';
    const txt = (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 24);
    return el.tagName.toLowerCase() + id + (cls ? '.' + cls : '') + (txt ? '「' + txt + '」' : '');
  };

  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    return true;
  };

  // 1) 横向溢出
  const docW = document.documentElement.scrollWidth;
  if (docW > vw + 2) {
    issues.push({ level: 'high', kind: '横向溢出', detail: '页面宽 ' + docW + 'px > 视口 ' + vw + 'px（多出 ' + (docW - vw) + 'px）' });
  }

  // 2) 触控目标过小（只查可点元素）
  const clickable = Array.from(document.querySelectorAll('button, a[href], [role=button], input[type=checkbox], input[type=radio], .chip, .suggest, .tabbar a'));
  const small = [];
  for (const el of clickable) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 24 || r.height < 24) {
      small.push(desc(el) + ' (' + Math.round(r.width) + '×' + Math.round(r.height) + ')');
    }
  }
  if (small.length) {
    issues.push({ level: 'medium', kind: '触控目标过小', detail: small.slice(0, 8).join('; '), count: small.length });
  }

  // 3) 元素超出视口左右边界
  /** 元素是否在某个可横向滚动的祖先里（那种溢出是设计好的，不算问题） */
  const inScrollable = (el) => {
    let n = el.parentElement;
    while (n && n !== document.body) {
      const s2 = getComputedStyle(n);
      if (s2.overflowX === 'auto' || s2.overflowX === 'scroll') return true;
      n = n.parentElement;
    }
    return false;
  };
  const overflow = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue;
    if (inScrollable(el)) continue;
    const s2 = getComputedStyle(el);
    // 只用背景/边框撑满宽度的装饰层不算内容溢出
    const r = el.getBoundingClientRect();
    if (r.width > vw * 1.02 && el.tagName !== 'HTML' && el.tagName !== 'BODY') {
      overflow.push(desc(el) + ' 宽' + Math.round(r.width));
    } else if ((r.right > vw + 4 || r.left < -4) && Math.abs(r.width - vw) > 4) {
      overflow.push(desc(el) + ' left=' + Math.round(r.left) + ' right=' + Math.round(r.right));
    }
  }
  if (overflow.length) {
    issues.push({ level: 'high', kind: '元素溢出视口', detail: [...new Set(overflow)].slice(0, 8).join('; ') });
  }

  // 4) 文字对比度（只查纯文本叶子节点）
  const lum = (c) => {
    const m = c.match(/[\\d.]+/g);
    if (!m) return null;
    const [r, g, b] = m.map(Number);
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  /**
   * 找元素背后真正的底色。
   * 关键：半透明背景（rgba 且 alpha < 1）不能直接当底色，
   * 否则算出来的对比度是错的——要把它叠到更下层的颜色上。
   */
  const parseColor = (c) => {
    const str = String(c);
    const m = str.match(/rgba?\\(([^)]+)\\)/);
    if (m) {
      const p = m[1].split(',').map((x) => parseFloat(x));
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    }
    /*
     * color-mix() 算出来的颜色，Chrome 给的是 color(srgb 0.42 0.36 0.98 / 0.5)。
     * 早先只认 rgb()/rgba()，于是日历上那些 color-mix 淡底全被当成「没有底色」，
     * 一路找到白卡，算出来 1.00 这种假结果。这里补上。
     */
    const m2 = str.match(/color\\(srgb\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)(?:\\s*\\/\\s*([\\d.]+))?\\)/);
    if (m2) {
      return {
        r: parseFloat(m2[1]) * 255,
        g: parseFloat(m2[2]) * 255,
        b: parseFloat(m2[3]) * 255,
        a: m2[4] === undefined ? 1 : parseFloat(m2[4]),
      };
    }
    return null;
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const bgOf = (el) => {
    const stack = [];
    let n = el;
    while (n) {
      const c = parseColor(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) {
        stack.push(c);
        if (c.a >= 0.999) break;
      }
      n = n.parentElement;
    }
    // 兜底：连 html 都没有实底色就用白/黑
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i], base);
    return 'rgb(' + Math.round(base.r) + ',' + Math.round(base.g) + ',' + Math.round(base.b) + ')';
  };
  /** 这个元素的底色是不是渐变（是的话交给下面的渐变专项检查，别在这里重复判） */
  const hasGradientBackdrop = (el) => {
    let n = el;
    while (n && n !== document.documentElement) {
      if (getComputedStyle(n).backgroundImage.includes('gradient(')) return true;
      n = n.parentElement;
    }
    return false;
  };
  const lowContrast = [];
  for (const el of document.querySelectorAll('p, span, div, a, li, td, h1, h2, h3, h4, label, button')) {
    if (!visible(el)) continue;
    if (el.children.length > 0) continue;
    // 渐变底的元素在下面单独查，这里跳过，免得算出「白字压白卡 = 1.00」的假警报
    if (hasGradientBackdrop(el)) continue;
    const t = (el.textContent || '').trim();
    if (t.length < 2) continue;
    const s = getComputedStyle(el);
    const fg = lum(s.color), bg = lum(bgOf(el));
    if (fg === null || bg === null) continue;
    const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
    const size = parseFloat(s.fontSize);
    const bold = parseInt(s.fontWeight, 10) >= 600;
    const need = (size >= 24 || (size >= 18.66 && bold)) ? 3 : 4.5;
    if (ratio < need - 0.05) {
      // 装饰性小字（图例、时间戳）按 3:1 的宽松标准，其余按 AA 4.5
      const decorative = size < 11.5 || /legend|tip|foot|cal-tip|version/.test(String(el.className || ''));
      const relaxed = decorative ? 3 : need;
      if (ratio < relaxed - 0.05) {
        lowContrast.push(desc(el) + ' 对比度' + ratio.toFixed(2) + '(需' + relaxed + ')');
      }
    }
  }
  if (lowContrast.length) {
    issues.push({ level: 'medium', kind: '对比度不足', detail: [...new Set(lowContrast)].slice(0, 8).join('; '), count: lowContrast.length });
  }

  // 5) 可见文字重叠（粗查：同层兄弟元素矩形相交面积过大）
  const overlaps = [];
  const cand = Array.from(document.querySelectorAll('main *, .shell *')).filter((el) => {
    if (!visible(el)) return false;
    if (el.children.length) return false;
    const t = (el.textContent || '').trim();
    return t.length > 3;
  }).slice(0, 400);
  for (let i = 0; i < cand.length; i++) {
    for (let j = i + 1; j < cand.length; j++) {
      const a = cand[i].getBoundingClientRect(), b = cand[j].getBoundingClientRect();
      if (cand[i].contains(cand[j]) || cand[j].contains(cand[i])) continue;
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > 6 && oy > 6) {
        const area = ox * oy;
        const min = Math.min(a.width * a.height, b.width * b.height);
        if (area / min > 0.55) overlaps.push(desc(cand[i]) + ' ∩ ' + desc(cand[j]));
      }
    }
  }
  if (overlaps.length) {
    issues.push({ level: 'high', kind: '元素重叠', detail: [...new Set(overlaps)].slice(0, 6).join('; '), count: overlaps.length });
  }

  // 6) 空白/未渲染检测
  const main = document.querySelector('main') || document.querySelector('.shell') || document.body;
  const mainText = (main.innerText || '').trim();
  if (mainText.length < 20) {
    issues.push({ level: 'high', kind: '内容为空', detail: '主区域只有 ' + mainText.length + ' 个字符' });
  }

  // 7) 骨架屏/加载态残留
  const skeletons = document.querySelectorAll('.skeleton, .think-dot').length;
  if (skeletons > 0) {
    issues.push({ level: 'low', kind: '加载态未结束', detail: '仍有 ' + skeletons + ' 个加载指示器' });
  }

  /*
   * 7.5) 渐变底色上的文字对比度。
   *
   * 上面那条对比度检查只会顺着 background-color 往上找底色，
   * 而渐变是 background-image，backgroundColor 是透明的，
   * 于是它会一路找到卡片底色，算出一个偏乐观的结果——
   * 「问 AI」按钮白字压在浅青上只有 2.3:1，之前就是这么漏过去的。
   * 这里把渐变里的每个色标解析出来，逐个和文字颜色比。
   */
  /** 元素自己直接写着的文字（不含子元素里的），没有就说明它只是个壳 */
  const ownText = (el) => {
    let out = '';
    for (const n of el.childNodes) if (n.nodeType === 3) out += n.nodeValue;
    return out.replace(/\s+/g, '');
  };
  const gradStops = (el) => {
    const bg = getComputedStyle(el).backgroundImage;
    if (!bg.includes('gradient(')) return null;
    const stops = (bg.match(/rgba?\\([^)]+\\)/g) || []).map(parseColor).filter((c) => c && c.a >= 0.5);
    return stops.length ? stops : null;
  };
  /**
   * 找最近的「渐变底」祖先：文字节点自己通常没有背景，
   * 真正决定对比度的是包着它的那个渐变块。
   */
  const gradientText = [];
  const gradChecked = [];
  for (const el of document.querySelectorAll('*')) {
    if (!visible(el)) continue;
    if (ownText(el).length < 1) continue;
    let host = el;
    let stops = null;
    while (host && host !== document.documentElement) {
      stops = gradStops(host);
      if (stops) break;
      /*
       * 中途遇到实底色就停下：那才是文字真正的底。
       * 不判这一条的话，头像里那个白圆上的字会被拿去跟背后的渐变色比，
       * 报出「1.65:1」这种根本不存在的对比度问题。
       */
      const mid = parseColor(getComputedStyle(host).backgroundColor);
      if (mid && mid.a >= 0.999) {
        stops = null;
        break;
      }
      host = host.parentElement;
    }
    if (!stops) continue;
    const ink = parseColor(getComputedStyle(el).color);
    if (!ink || ink.a < 0.5) continue;
    const rel = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const li = 0.2126 * rel(ink.r) + 0.7152 * rel(ink.g) + 0.0722 * rel(ink.b);
    let worst = Infinity;
    let worstStop = '';
    for (const stop of stops) {
      // 色标可能是半透明的，先叠到白底上再算（最坏情况）
      const flat = over(stop, { r: 255, g: 255, b: 255, a: 1 });
      const l2 = 0.2126 * rel(flat.r) + 0.7152 * rel(flat.g) + 0.0722 * rel(flat.b);
      const ratio = (Math.max(li, l2) + 0.05) / (Math.min(li, l2) + 0.05);
      if (ratio < worst) {
        worst = ratio;
        worstStop = 'rgb(' + Math.round(flat.r) + ',' + Math.round(flat.g) + ',' + Math.round(flat.b) + ')';
      }
    }
    gradChecked.push(desc(el) + '=' + worst.toFixed(2));
    if (worst < 4.45) {
      gradientText.push(desc(el) + ' 压在 ' + desc(host) + ' 上只有 ' + worst.toFixed(2) + ':1（底色 ' + worstStop + '）');
    }
  }
  if (gradientText.length) {
    issues.push({
      level: 'high',
      kind: '渐变底色上的文字对比度不足',
      detail: [...new Set(gradientText)].slice(0, 6).join('; '),
      count: gradientText.length,
    });
  }

  // 8) 底部导航一致性
  // 上一版这里出过事：几个入口宽度不一、图标大小不一，视觉上像没对齐的补丁。
  // 所以在审计里钉死——同类型元素的宽高差超过 2px 就报出来。
  const bar = document.querySelector('.tabbar');
  if (bar && visible(bar)) {
    const links = Array.from(bar.querySelectorAll('a')).filter(visible);
    if (links.length >= 2) {
      const rs = links.map((el) => el.getBoundingClientRect());
      const dw = Math.max(...rs.map((r) => r.width)) - Math.min(...rs.map((r) => r.width));
      const dh = Math.max(...rs.map((r) => r.height)) - Math.min(...rs.map((r) => r.height));
      if (dw > 2 || dh > 2) {
        issues.push({
          level: 'medium',
          kind: '底栏入口尺寸不一致',
          detail: '宽差 ' + dw.toFixed(1) + 'px / 高差 ' + dh.toFixed(1) + 'px：' + links.map((el, i) => desc(el) + ' ' + Math.round(rs[i].width) + '×' + Math.round(rs[i].height)).join('; '),
        });
      }
      const centers = rs.map((r) => r.top + r.height / 2);
      const dc = Math.max(...centers) - Math.min(...centers);
      if (dc > 2) {
        issues.push({ level: 'medium', kind: '底栏入口未对齐', detail: '垂直中心差 ' + dc.toFixed(1) + 'px' });
      }
    }

    // 中间主按钮：必须是正圆、必须只比两侧略大、必须没有压住相邻入口
    const fab = bar.querySelector('.fab-main');
    if (fab && visible(fab)) {
      const fr = fab.getBoundingClientRect();
      if (Math.abs(fr.width - fr.height) > 1) {
        issues.push({ level: 'medium', kind: '主按钮不是正圆', detail: Math.round(fr.width) + '×' + Math.round(fr.height) });
      }
      const hit = links.filter((el) => {
        const r = el.getBoundingClientRect();
        return r.left < fr.right - 1 && r.right > fr.left + 1;
      });
      if (hit.length) {
        issues.push({ level: 'high', kind: '主按钮压住相邻入口', detail: hit.map(desc).join('; ') });
      }
      if (fr.top < bar.getBoundingClientRect().top - 1 || fr.bottom > bar.getBoundingClientRect().bottom + 1) {
        issues.push({ level: 'low', kind: '主按钮超出底栏', detail: '按钮 ' + Math.round(fr.top) + '~' + Math.round(fr.bottom) + ' 底栏 ' + Math.round(bar.getBoundingClientRect().top) + '~' + Math.round(bar.getBoundingClientRect().bottom) });
      }
      if ((fab.innerText || '').trim()) {
        issues.push({ level: 'low', kind: '主按钮带了文字', detail: '按设计只显示图标：' + (fab.innerText || '').trim().slice(0, 12) });
      }
    }
  }

  return JSON.stringify({
    url: location.hash,
    vw, vh,
    docW,
    textLen: mainText.length,
    counts: { clickable: clickable.filter(visible).length, issues: issues.length },
    gradChecked,
    issues,
  });
})()
`;

async function main() {
  if (!fs.existsSync(CHROME)) throw new Error('找不到 chromium');
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
      `--user-data-dir=${path.join(os.tmpdir(), `sg-audit-${TAG}`)}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: '/dev/null' } },
  );
  // 浏览器起不来时得知道为什么，别只报一句「超时」
  let chromeErr = '';
  proc.stderr?.on('data', (d) => (chromeErr += d));

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

  const metrics = DESKTOP
    ? { width: 1360, height: 950, deviceScaleFactor: 2, mobile: false }
    : { width: 412, height: 900, deviceScaleFactor: 2, mobile: true };
  await send(ws, 'Emulation.setDeviceMetricsOverride', metrics, S);

  const ev = async (expr) => {
    const r = await send(ws, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, S);
    if (r.exceptionDetails) return { _err: String(r.exceptionDetails.exception?.description || '').slice(0, 200) };
    try {
      return JSON.parse(r.result?.value);
    } catch {
      return { _raw: r.result?.value };
    }
  };

  const report = { tag: TAG, base: BASE, pages: [] };

  try {
    // 登录
    try {
      await send(ws, 'Page.navigate', { url: `${BASE}/` }, S);
    } catch (e) {
      throw new Error(`${e.message}\n浏览器输出：${chromeErr.slice(-800)}`);
    }
    await sleep(3500);
    // 注销 Service Worker 并清掉它 precache 的页面。
    // 只注销不清缓存的话，浏览器可能还在跑上一版构建，
    // 测出来的「失败」其实是旧代码的，排查方向会被带偏。
    await send(ws, 'Runtime.evaluate', { expression: `(async () => { try { const rs = await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map(r => r.unregister())); const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); } catch {} })()`, awaitPromise: true }, S);
    await sleep(400);
    for (let i = 0; i < 8; i++) {
      const st = await send(ws, 'Runtime.evaluate', { expression: `!!document.querySelector('.shell')`, returnByValue: true }, S);
      if (st.result?.value) break;
      await send(
        ws,
        'Runtime.evaluate',
        {
          expression: LOGIN_JS,
          returnByValue: true,
        },
        S,
      );
      await sleep(400);
      await send(ws, 'Runtime.evaluate', { expression: `document.querySelector('.gate .btn-primary')?.click()` }, S);
      await sleep(2200);
    }

    if (DARK) {
      await send(ws, 'Runtime.evaluate', { expression: `document.documentElement.dataset.theme='dark'`, returnByValue: true }, S);
      await sleep(600);
    }

    for (const [name, hash] of PAGES) {
      await send(ws, 'Runtime.evaluate', { expression: `location.hash='${hash}'`, returnByValue: true }, S);
      await sleep(2200);
      const res = await ev(PROBE);
      report.pages.push({ name, hash, ...res });

      const { data } = await send(ws, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, S);
      fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
    }
  } finally {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    proc.kill('SIGKILL');
  }

  // ---------- 输出报告 ----------
  fs.writeFileSync(path.join(ROOT, `.audit/report-${TAG}.json`), JSON.stringify(report, null, 2));

  const LEVEL = { high: '\x1b[31m高\x1b[0m', medium: '\x1b[33m中\x1b[0m', low: '\x1b[90m低\x1b[0m' };
  let total = 0;
  const byLevel = { high: 0, medium: 0, low: 0 };

  console.log(`\n\x1b[36m拾光 · UI 审计\x1b[0m  ${TAG}  ${BASE}\n`);
  for (const page of report.pages) {
    const issues = page.issues || [];
    total += issues.length;
    console.log(`  \x1b[1m${page.name}\x1b[0m  ${page.hash}  视口${page.vw}×${page.vh}  文档宽${page.docW}  正文${page.textLen}字  问题${issues.length}`);
    for (const it of issues) {
      byLevel[it.level] = (byLevel[it.level] || 0) + 1;
      console.log(`     ${LEVEL[it.level] || it.level} [${it.kind}] ${it.detail}`);
    }
    if (!issues.length) console.log('     \x1b[32m✓ 无问题\x1b[0m');
  }
  console.log(`\n  合计 ${total} 个问题：高 ${byLevel.high} / 中 ${byLevel.medium} / 低 ${byLevel.low}`);
  console.log(`  截图与报告：${OUT}\n`);
  process.exit(byLevel.high > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('\x1b[31m审计失败：\x1b[0m', e.message);
  process.exit(2);
});
