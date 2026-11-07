// =============================================================
// 从 public/favicon.svg 生成 Android 各密度图标
// 直接用 CDP 驱动 chromium（不依赖 playwright，沙箱里更稳）
// 用法：node scripts/gen-android-icons.mjs
// =============================================================

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RES = 'android/app/src/main/res';
const PORT = 9380;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME = [
  path.join(os.homedir(), '.cache/ms-playwright/chromium-1217/chrome-linux64/chrome'),
  path.join(
    os.homedir(),
    '.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell',
  ),
].find((p) => fs.existsSync(p));

if (!CHROME) {
  console.error('没有找到 chromium，跳过图标生成');
  process.exit(1);
}

// 主图标：完整圆角渐变方块 + 白色羽毛
const fullSvg = fs.readFileSync('public/favicon.svg', 'utf8');

// 自适应图标（Android 8+）：背景单独一层
const bgSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" width="108" height="108">
  <defs>
    <radialGradient id="g" cx="50%" cy="38%" r="72%">
      <stop offset="0%" stop-color="#fff6e2"/>
      <stop offset="100%" stop-color="#ffe2ad"/>
    </radialGradient>
  </defs>
  <rect width="108" height="108" fill="url(#g)"/>
</svg>`;

const fgSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" width="108" height="108">
  <defs>
    <linearGradient id="petal" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffc93f"/>
      <stop offset="100%" stop-color="#f39422"/>
    </linearGradient>
    <radialGradient id="core" cx="42%" cy="36%" r="70%">
      <stop offset="0%" stop-color="#8a5a2b"/>
      <stop offset="100%" stop-color="#5d3a18"/>
    </radialGradient>
  </defs>
  <g transform="translate(54 54) scale(2.75) translate(-12 -12)">
    <g fill="url(#petal)">
      <g transform="rotate(0 12 12)"><ellipse cx="12" cy="4.6" rx="1.9" ry="3.05"/></g>
      <g transform="rotate(30 12 12)"><ellipse cx="12" cy="4.6" rx="1.9" ry="3.05"/></g>
      <g transform="rotate(60 12 12)"><ellipse cx="12" cy="4.6" rx="1.9" ry="3.05"/></g>
      <g transform="rotate(90 12 12)"><ellipse cx="12" cy="4.6" rx="1.9" ry="3.05"/></g>
      <g transform="rotate(120 12 12)"><ellipse cx="12" cy="4.6" rx="1.9" ry="3.05"/></g>
      <g transform="rotate(150 12 12)"><ellipse cx="12" cy="4.6" rx="1.9" ry="3.05"/></g>
      <g transform="rotate(180 12 12)"><ellipse cx="12" cy="4.6" rx="1.9" ry="3.05"/></g>
      <g transform="rotate(210 12 12)"><ellipse cx="12" cy="4.6" rx="1.9" ry="3.05"/></g>
      <g transform="rotate(240 12 12)"><ellipse cx="12" cy="4.6" rx="1.9" ry="3.05"/></g>
      <g transform="rotate(270 12 12)"><ellipse cx="12" cy="4.6" rx="1.9" ry="3.05"/></g>
      <g transform="rotate(300 12 12)"><ellipse cx="12" cy="4.6" rx="1.9" ry="3.05"/></g>
      <g transform="rotate(330 12 12)"><ellipse cx="12" cy="4.6" rx="1.9" ry="3.05"/></g>
    </g>
    <circle cx="12" cy="12" r="5.05" fill="url(#core)"/>
    <g fill="#2b1a0c">
      <circle cx="10.3" cy="11.15" r="0.7"/>
      <circle cx="13.7" cy="11.15" r="0.7"/>
    </g>
    <path d="M10.1 13.2c.55.7 1.18 1.05 1.9 1.05s1.35-.35 1.9-1.05"
          fill="none" stroke="#2b1a0c" stroke-width="0.76" stroke-linecap="round"/>
  </g>
</svg>`;

const DENSITIES = [
  { dir: 'mipmap-mdpi', size: 48 },
  { dir: 'mipmap-hdpi', size: 72 },
  { dir: 'mipmap-xhdpi', size: 96 },
  { dir: 'mipmap-xxhdpi', size: 144 },
  { dir: 'mipmap-xxxhdpi', size: 192 },
];

let msgId = 0;
const pending = new Map();

function send(ws, method, params = {}, sessionId) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} 超时`));
      }
    }, 25000);
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
}

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
      '--disable-crash-reporter',
      // 不要碰系统钥匙环（否则会弹解锁密码框）
      '--password-store=basic',
      '--use-mock-keyring',
      `--user-data-dir=${path.join(os.tmpdir(), `sg-icons-${Date.now()}`)}`,
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
      /* 等它起来 */
    }
    await sleep(250);
  }
  if (!wsUrl) {
    proc.kill('SIGKILL');
    throw new Error('DevTools 未就绪');
  }

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
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

  /** 渲染一个 SVG 并截图存盘 */
  async function render(svg, size, outPath, opaque = true) {
    /*
     * 不靠替换 width/height 属性来缩放 —— 之前就是这么写的，
     * 结果换成 24×24 viewBox 的 favicon 之后，正则没命中，
     * 图标就渲染成一个 24px 的小点缩在左上角。
     * 现在直接用 CSS 让 svg 撑满容器，任何尺寸的源都能正确出图。
     */
    const html = `<!doctype html><html><head><style>
      html,body{margin:0;width:${size}px;height:${size}px;overflow:hidden;background:transparent}
      svg{display:block;width:100%;height:100%}
    </style></head><body>${svg}</body></html>`;
    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

    await send(
      ws,
      'Emulation.setDeviceMetricsOverride',
      { width: size, height: size, deviceScaleFactor: 1, mobile: false },
      S,
    );
    await send(ws, 'Page.navigate', { url: dataUrl }, S);
    await sleep(220);
    const { data } = await send(
      ws,
      'Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: false, ...(opaque ? {} : { omitBackground: true }) },
      S,
    );
    fs.writeFileSync(outPath, Buffer.from(data, 'base64'));
  }

  for (const { dir, size } of DENSITIES) {
    const target = path.join(RES, dir);
    fs.mkdirSync(target, { recursive: true });
    await render(fullSvg, size, path.join(target, 'ic_launcher.png'));
    await render(fullSvg, size, path.join(target, 'ic_launcher_round.png'));
    await render(bgSvg, size, path.join(target, 'ic_launcher_background.png'));
    await render(fgSvg, size, path.join(target, 'ic_launcher_foreground.png'), false);
    console.log('✓', dir, `${size}px`);
  }

  // 自适应图标描述
  const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`;
  const anydpi = path.join(RES, 'mipmap-anydpi-v26');
  fs.mkdirSync(anydpi, { recursive: true });
  fs.writeFileSync(path.join(anydpi, 'ic_launcher.xml'), adaptive);
  fs.writeFileSync(path.join(anydpi, 'ic_launcher_round.xml'), adaptive);
  console.log('✓ mipmap-anydpi-v26 自适应图标');

      // ---- PWA 图标（public/ 下那三个 png）----
      // 以前是手工导出的，换图标之后没人记得重新导，网页版就还挂着旧标。
      // 现在跟 Android 图标一起生成，换一次图标只跑一条命令。
      const fullForPwa = fs.readFileSync('public/favicon.svg', 'utf8');
      await render(fullForPwa, 192, 'public/icon-192.png');
      await render(fullForPwa, 512, 'public/icon-512.png');
      // maskable：Android 会把图标裁成圆形/圆角，四周要留足安全边距
      const maskable = fullForPwa.replace(
        '<rect width="24" height="24" rx="6"',
        '<g transform="translate(12 12) scale(0.78) translate(-12 -12)"><rect width="24" height="24"',
      );
      await render(maskable, 512, 'public/icon-512-maskable.png');
      console.log('✓ PWA 图标 icon-192 / icon-512 / icon-512-maskable');

  try {
    ws.close();
  } catch {
    /* ignore */
  }
  proc.kill('SIGKILL');
}

main().catch((e) => {
  console.error('图标生成失败：', e.message);
  process.exit(1);
});
