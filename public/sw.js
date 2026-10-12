// =============================================================
// 拾光 · Service Worker
// 静态资源走缓存优先（离线也能打开界面），
// 接口请求永远走网络（笔记必须实时，不能被缓存糊弄）
// =============================================================

// 界面大改就换一次版本号：activate 时会把旧缓存整个删掉。
// 不换的话，用户手机上会一直停在上一版的壳上（静态资源是缓存优先）。
//
// 这个坑在自动化测试里踩得最狠：反复重建 dist 时，浏览器里装着的
// SW 会继续拿旧壳跑，测试报的「失败」其实是上一版代码的问题。
// 所以所有测试脚本在开始前都要「注销 SW + 清空 Cache Storage」。
const VERSION = 'shiguang-v3';
const SHELL = `${VERSION}-shell`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(['./', './index.html', './favicon.svg', './manifest.webmanifest']))
      .catch(() => {})
      .then(() => self.skipWaiting()),
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
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put('./index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./'))),
    );
    return;
  }

  // 静态资源：缓存优先
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req)
          .then((res) => {
            if (res.ok && res.type === 'basic') {
              const copy = res.clone();
              caches.open(SHELL).then((c) => c.put(req, copy)).catch(() => {});
            }
            return res;
          })
          .catch(() => hit),
    ),
  );
});
