// =============================================================
// 拾光 · Service Worker
// 静态资源走缓存优先（离线也能打开界面），
// 接口请求永远走网络（笔记必须实时，不能被缓存糊弄）
//
// ⚠️ 这里的 __BUILD_ID__ 是构建时替换掉的（见 vite.config.ts 的 swBuildId 插件）。
//
// 为什么非这么做不可：
//   浏览器只在 **sw.js 的字节变了** 的时候才会装新的 Service Worker。
//   而这个文件以前写死成 'shiguang-v3'，内容是常量 ——
//   于是它从上线第一天起就再没更新过，activate 从没跑过，
//   旧缓存里的旧 index.html 一直留着。用户报「一直跑旧代码」就是这儿来的。
//   现在每次构建都会换一个 id：sw.js 必然变化 → 必然重装 → 旧缓存必然清掉。
//
// 另一条踩过的坑：以前 install 里直接 skipWaiting()。
// 那样新 SW 会立刻接管，可页面上跑的**还是旧 JS**，它去要旧的文件名，
// 而旧文件已经从服务器上删了 —— 页面当场碎掉。
// 现在新 SW 先等着，由页面决定什么时候切换（见 src/main.ts）。
// =============================================================

const VERSION = 'shiguang-__BUILD_ID__';
const SHELL = `${VERSION}-shell`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(['./', './index.html', './favicon.svg', './manifest.webmanifest']))
      .catch(() => {}),
    // 刻意不在这里 skipWaiting：等页面发话，见下面 message 的处理
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 页面说「换吧」的时候才跳过等待。
// 页面收到 controllerchange 之后会自己刷新一次，两边的版本就对上了。
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // 接口不缓存
  if (url.pathname.includes('/api/')) return;

  // 页面导航：网络优先，失败时用缓存兜底（离线可开）
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // 只缓存成功的：把 4xx/5xx 的页面存下来，用户会一直看到错误页
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put('./index.html', copy)).catch(() => {});
          }
          return res;
        })
        .catch(() =>
          // 缓存里也可能压根没有（第一次装、被清过）。
          // 那就明确给一张离线提示页，而不是让浏览器甩一个看不懂的错。
          caches.match('./index.html').then((r) => r || offlinePage()),
        ),
    );
    return;
  }

  // 静态资源：缓存优先。
  // 文件名带构建哈希，所以「缓存里有」就等于「内容没变」，可以放心用。
  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(
          () =>
            /*
             * 以前这里写的是 `.catch(() => hit)` —— 可走到这儿 hit 必然是
             * undefined（有的话上面就 return 了），等于 respondWith(undefined)，
             * 浏览器会报一个和真实原因毫无关系的错，排查时被带偏很久。
             * 明确回 504，至少日志里看得出是「离线拿不到」。
             */
            new Response('', { status: 504, statusText: 'offline' }),
        );
    }),
  );
});

/** 离线且没有缓存时的兜底页 */
function offlinePage() {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>拾光 · 离线</title><style>
body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#faf7f2;color:#322c28;
font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;padding:24px;text-align:center}
h1{font-size:1.2rem;margin:0 0 8px}p{color:#7a6c5f;font-size:.88rem;line-height:1.8;margin:0 0 20px}
button{font:inherit;padding:11px 26px;border:0;border-radius:999px;background:#6d5efc;color:#fff;font-weight:600}
</style></head><body><div>
<h1>现在连不上服务器</h1>
<p>这台设备暂时打不开拾光。<br>联网之后点下面重试就行，本地存过的记录不会丢。</p>
<button onclick="location.reload()">重试</button>
</div></body></html>`;
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
