// =============================================================
// 拾光 · HTTP 服务
// 纯 node:http，无框架依赖。默认监听 127.0.0.1:8787，由 Caddy 反代
// =============================================================

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { Store, toDateStr } from './store.mjs';
import { Users, isPhone, maskPhone, checkPassword } from './users.mjs';
import { sendSms, smsEnabled, smsConfig, makeCode, issueCode, verifyCode, canSend } from './sms.mjs';
import { AudioStore, MAX_AUDIO_BYTES } from './audio.mjs';
import { Care, IMAGE_MAX_BYTES } from './care.mjs';
import {
  todayPlan,
  pendingCount,
  overdueCount,
  nextDoseAt,
  upcomingReminders,
  activeBlock,
  blockedPackages,
  nextBlockStart,
  blockRemainingMin,
  buildSchedule,
  buildFocusIntervals,
  parseLocalISO,
  toLocalISO,
  dateStr,
  humanMinutes,
} from './care-logic.mjs';
import { decodeAudio, sendAudio } from './audio-http.mjs';
import { transcribe, asrInfo, asrEnabled, classifyAsrError } from './asr.mjs';
import { hashPassword, makeToken, sessionOf, sessionCookie, clearCookie } from './auth.mjs';
import {
  ask,
  askStream,
  summarizeDay,
  parseTimeRange,
  stripTimeWords,
  anchorDate,
  extractVoice,
  memoriesOf,
  reflectMemories,
  parseMedication,
  detectReminder,
  aiEnabled,
  WEEK_CN,
} from './ai.mjs';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.SHIGUANG_DATA || path.join(process.cwd(), 'server', 'data');
const COOKIE_PATH = process.env.SHIGUANG_COOKIE_PATH || '/';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-flash';
/**
 * 开放注册。默认开；想临时关门就把 SHIGUANG_OPEN_REGISTER 设成 0，
 * 已经注册的人照常登录，只是不再接受新号。
 */
const REGISTER_OPEN = !['0', 'false', 'no'].includes(String(process.env.SHIGUANG_OPEN_REGISTER || '1').toLowerCase());

const users = await new Users(DATA_DIR).init();

/**
 * 会话签名密钥。
 * 全局一把，token 里再带上 userId 和这个用户的 epoch，
 * 所以改密码只需要把 epoch +1，只踢自己，不牵连别人。
 */
const SECRET_FILE = path.join(DATA_DIR, 'server.json');
let SECRET = '';
try {
  SECRET = JSON.parse(await fsp.readFile(SECRET_FILE, 'utf8')).sessionSecret || '';
} catch {
  /* 首次启动 */
}
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex');
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(SECRET_FILE, JSON.stringify({ sessionSecret: SECRET }, null, 2), 'utf8');
}

/**
 * 注册邀请码。
 *
 * 为什么不是短信验证码：账号是手机号，本来最严谨的做法是发条短信证明号是你的。
 * 但阿里云短信现在要先办资质、再申请签名和模板，还要运营商实名报备，
 * 个人认证根本过不了，整套下来两周起步——对「先让几个朋友用起来」来说太重了。
 *
 * 邀请码解决的是「谁能注册」：码由你掌握，只发给你想放进来的人，
 * 陌生人拿到网址也注册不了。它验证不了手机号归属，这是已知的取舍。
 *
 * 三种来源，优先级从高到低：
 *   1. 环境变量 SHIGUANG_INVITE_CODE（写在 /etc/shiguang.env 里，重启生效）
 *   2. 数据目录里的 invite-code.txt（没有就自动生成一个）
 * 文件权限 600，内容也会打进启动日志，方便你去服务器上捞。
 */
const INVITE_FILE = path.join(DATA_DIR, 'invite-code.txt');
let inviteCode = '';
async function ensureInviteCode() {
  const fromEnv = String(process.env.SHIGUANG_INVITE_CODE || '').trim();
  if (fromEnv) {
    inviteCode = fromEnv;
    return;
  }
  try {
    inviteCode = (await fsp.readFile(INVITE_FILE, 'utf8')).trim();
  } catch {
    /* 还没生成过 */
  }
  if (!inviteCode) {
    inviteCode = crypto.randomBytes(4).toString('hex').toUpperCase();
    await fsp.mkdir(DATA_DIR, { recursive: true });
    await fsp.writeFile(INVITE_FILE, inviteCode + '\n', { encoding: 'utf8', mode: 0o600 });
  }
}
await ensureInviteCode();

/** 邀请码对不对（不区分大小写，省得手抄出错） */
function inviteOk(input) {
  const given = String(input || '').trim().toUpperCase();
  return !!inviteCode && given === inviteCode.toUpperCase();
}

/**
 * 每个用户一套 Store + AudioStore，按需创建、建好就缓存。
 * 之所以开成独立目录而不是在记录里加 userId：
 * 查询、检索、统计的代码一行都不用改，也就不存在「忘了加 where 就串号」的风险。
 *
 * 缓存的是 Promise 而不是建好的对象：新用户第一次进站时几个接口会同时
 * 打过来，如果只缓存结果，它们会各自建一遍 Store 并同时写 meta.json，
 * 撞在一起就是 500。
 */
const contexts = new Map();
function ctxFor(user) {
  let c = contexts.get(user.id);
  if (!c) {
    c = (async () => {
      const dir = users.dirOf(user);
      const store = await new Store(dir).init();
      const audio = await new AudioStore(dir).init();
      store.attachAudio(audio);
      const care = await new Care(dir).init();
      return { dir, store, audio, care };
    })();
    // 建失败就别把坏 Promise 留在缓存里，否则这个用户永远进不来
    c.catch(() => contexts.delete(user.id));
    contexts.set(user.id, c);
  }
  return c;
}

/** 从请求里解出「是谁」，顺带确认这个人还在、且 token 没过代 */
function whoami(req) {
  const sess = sessionOf(req, SECRET);
  if (!sess) return null;
  const user = users.byId(sess.userId);
  if (!user) return null;
  if ((user.epoch || 1) !== sess.epoch) return null; // 改过密码，旧 token 作废
  return user;
}

/** 会话 Cookie 里的 token */
function tokenFor(user) {
  return makeToken(SECRET, user.id, user.epoch || 1);
}

// ---------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

// ---------------------------------------------------------------
// 跨域（安卓 App 用）
// App 里的页面跑在 https://localhost，接口在 https://zhuangrongjian.space，
// 属于不同源，所以必须明确允许并允许携带 Cookie。
// 只放行「本机壳 + 自己域名」，不用 *（带 Cookie 时 * 也不合法）。
// ---------------------------------------------------------------
const ALLOWED_ORIGINS = new Set([
  'https://localhost',      // 安卓 Capacitor
  'http://localhost',       // 安卓 Capacitor（http scheme）
  'capacitor://localhost',  // iOS Capacitor
  'https://zhuangrongjian.space',
  'http://localhost:5181',  // 本地 vite dev
  'http://127.0.0.1:8787',
  'http://127.0.0.1:5190',
]);

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin) return {};              // 同源请求不需要
  const ok = ALLOWED_ORIGINS.has(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (!ok) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Range, If-None-Match',
    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/**
 * 会话 Cookie 用哪个 Path。
 *   同源访问（网页版，页面在 /shiguang/）→ /shiguang
 *   跨域访问（App，接口路径是 /api/...）→ /，否则 Cookie 根本不会被带上
 */
function cookiePathFor(req) {
  return req.headers.origin ? '/' : COOKIE_PATH;
}

function sendJSON(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

/** 带 CORS 的 JSON 响应 */
function sendJSONCors(req, res, code, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...corsHeaders(req),
    ...headers,
  });
  res.end(body);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * 请求日志。
 *
 * 以前只记 /api/ai/*，于是「用户说所有请求都红了」这种问题根本没法查 ——
 * 日志里既看不到请求有没有到，也看不到返回了什么。排查全靠猜。
 * 现在每个接口请求都记一行，格式固定，方便 grep：
 *
 *   [拾光] 请求 GET /api/entries 200 3ms 1.2.3.4
 *
 * 刻意**不记查询串**：/api/search?q=... 里是用户搜的内容，
 * 那是私人的东西，不该落到服务器日志里。路径本身（/api/search）不敏感。
 */
function logRequest(req, res, pathname, method, started) {
  // 静态资源不记：一个页面能带出十几个，把有用的行全冲掉了
  if (!pathname.startsWith('/api/')) return;
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '')
    .split(',')[0]
    .trim()
    .replace(/^::ffff:/, '');
  console.log(`[拾光] 请求 ${method} ${pathname} ${res.statusCode} ${Date.now() - started}ms ${ip}`);
}

/** 转写完成后把文本写回附件元数据（index.jsonl 追加一条新版本，重启后仍在） */
async function storeMetaUpdate(audio, rec) {
  const dir = path.dirname(audio.absPath(rec) || '');
  if (!dir) return;
  await fsp.appendFile(path.join(dir, 'index.jsonl'), JSON.stringify(rec) + '\n', 'utf8').catch(() => {});
}

// ---------------------------------------------------------------
// 语音附件辅助
// ---------------------------------------------------------------
/** 记录里只存附件摘要，音频本体在那个用户的 audio/ 下 */
function sanitizeAttachments(audio, list) {
  if (!Array.isArray(list)) return [];
  return list
    .slice(0, 5)
    .map((a) => {
      const id = typeof a === 'string' ? a : String(a?.id || '');
      const rec = /^[\w-]+$/.test(id) ? audio.get(id) : null;
      if (!rec) return null;
      return {
        id,
        kind: 'audio',
        durationMs: Number(a?.durationMs) || rec.durationMs || 0,
        points: Array.isArray(a?.points) ? a.points.map((x) => String(x).slice(0, 60)).slice(0, 4) : [],
      };
    })
    .filter(Boolean);
}

/** 返回给前端时把音频元信息补齐（含可播放 URL） */
function withAttachments(audio, entry) {
  if (!entry) return entry;
  const list = Array.isArray(entry.attachments) ? entry.attachments : [];
  return {
    ...entry,
    attachments: list
      .map((a) => {
        const rec = audio.get(a.id);
        if (!rec) return null;
        return {
          ...a,
          url: `api/audio/${rec.id}`,
          mime: rec.mime,
          bytes: rec.bytes,
          durationMs: a.durationMs || rec.durationMs,
          transcript: rec.transcript || '',
        };
      })
      .filter(Boolean),
  };
}

const ok = (req, res, data) => sendJSONCors(req, res, 200, { ok: true, data });
const fail = (req, res, code, msg) => sendJSONCors(req, res, code, { ok: false, error: msg });

// ---------------------------------------------------------------
// 路由
// ---------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return fail(req, res, 400, '错误的请求地址');
  }
  // 兼容 /api/xxx 与 /shiguang/api/xxx 两种前缀
  let p = url.pathname.replace(/^\/shiguang/, '');
  if (p.endsWith('/') && p.length > 1) p = p.slice(0, -1);
  const q = url.searchParams;
  const method = req.method || 'GET';

  // 静态资源托管（可选，便于单机直接跑）
  if (!p.startsWith('/api')) {
    return serveStatic(res, p);
  }

  try {
    // ---------- 跨域预检（App 会先发 OPTIONS） ----------
    if (method === 'OPTIONS') {
      const h = corsHeaders(req);
      if (!Object.keys(h).length) {
        res.writeHead(403).end();
        return;
      }
      res.writeHead(204, { ...h, 'Content-Length': '0' });
      return res.end();
    }

    // ---------- 健康检查（免登录） ----------
    // 多用户之后这里不再报「谁有多少条」——那是私人数据。
    // 只报服务本身的能力和注册人数，够运维判断就够了。
    if (p === '/api/healthz') {
      return ok(req, res, {
        status: 'up',
        users: users.count(),
        ai: aiEnabled(),
        model: MODEL,
        asr: asrInfo(),
        sms: { enabled: smsEnabled() },
        uptime: Math.round(process.uptime()),
      });
    }

    // ================= 免登录的账号接口 =================

    // ---------- 登录态 ----------
    if (p === '/api/auth/status' && method === 'GET') {
      const me0 = whoami(req);
      return ok(req, res, {
        authed: !!me0,
        me: me0 ? users.publicView(me0) : null,
        ai: aiEnabled(),
        asr: asrInfo(),
        cookiePath: COOKIE_PATH,
        model: MODEL,
        // 注册开没开、能不能用，都在这里说清楚，登录页照着渲染
        register: { open: REGISTER_OPEN, sms: false, reason: REGISTER_OPEN ? null : '服务端已关闭注册' },
      });
    }

    // ---------- 登录方式（免登录可看，决定登录页显示什么） ----------
    if (p === '/api/auth/methods' && method === 'GET') {
      return ok(req, res, {
        // 账号就是手机号，所以「密码登录」永远可用
        password: true,
        sms: smsEnabled(),
        // 注册要邀请码，和短信无关——短信只是登录的一种快捷方式
        register: REGISTER_OPEN,
        invite: true,
        smsReason: smsEnabled() ? null : '服务端没配置短信通道，所以没有「验证码登录」这一栏',
        userCount: users.count(),
      });
    }

    // ---------- 注册 ----------
    // 要邀请码，不要短信：短信要资质审核，个人账号办不下来。
    // 代价是验证不了手机号是不是本人的，这是明知的取舍。
    if (p === '/api/auth/register' && method === 'POST') {
      if (!REGISTER_OPEN) return fail(req, res, 403, '服务端已关闭注册');
      const body = await readBody(req);
      const phone = String(body.phone || '').trim();
      const password = String(body.password || '');
      const given = String(body.inviteCode || body.setupCode || '').trim();

      if (!isPhone(phone)) return fail(req, res, 400, '手机号格式不对');
      if (users.has(phone)) return fail(req, res, 409, '这个手机号已经注册过了，直接登录就行');
      const bad = checkPassword(password);
      if (bad) return fail(req, res, 400, bad);
      if (!inviteOk(given)) {
        await new Promise((r) => setTimeout(r, 400));
        return fail(req, res, 401, '邀请码不对。它写在服务器的 /var/lib/shiguang/invite-code.txt 里，也可以在服务启动日志里找到');
      }

      const made = await users.create(phone, password);
      if (!made.ok) return fail(req, res, 400, made.error);
      const user = made.user;
      console.log(`[拾光] 新用户注册：${maskPhone(phone)}（第 ${users.count()} 位）`);
      return sendJSONCors(req, res, 200, { ok: true, data: { authed: true, me: users.publicView(user) } }, {
        'Set-Cookie': sessionCookie(tokenFor(user), { crossSite: !!req.headers.origin }).replace('Path=/;', `Path=${cookiePathFor(req)};`),
      });
    }

    // ---------- 发短信验证码 ----------
    // 现在只剩「登录」一个用途：注册用邀请码，换手机号用密码。
    // 短信通道没配好时这个接口会直接告知，不会假装成功。
    if (p === '/api/auth/sms/send' && method === 'POST') {
      const body = await readBody(req);
      const phone = String(body.phone || '').trim();

      if (!isPhone(phone)) return fail(req, res, 400, '手机号格式不对');
      if (!smsEnabled()) {
        return fail(req, res, 503, '服务端还没配置短信通道，请用手机号和密码登录');
      }
      if (!users.has(phone)) return fail(req, res, 404, '这个手机号还没注册');

      const gate = canSend(phone);
      if (!gate.ok) return fail(req, res, 429, `太频繁了，${gate.wait} 秒后再试`);

      const code = makeCode();
      try {
        await sendSms(phone, code);
      } catch (e) {
        console.error('[拾光] 短信发送失败', e);
        return fail(req, res, 502, String(e?.message || '短信发送失败'));
      }
      issueCode(phone, code);
      // 真通道配好之前（开发模式）把码回给前端，方便自测；生产不会走到这条分支
      return ok(req, res, { sent: true, devCode: smsConfig().ready ? undefined : code });
    }

    // ---------- 短信验证码快捷登录 ----------
    if (p === '/api/auth/sms/login' && method === 'POST') {
      const body = await readBody(req);
      const phone = String(body.phone || '').trim();
      const code = String(body.code || '').trim();

      if (!isPhone(phone)) return fail(req, res, 400, '手机号格式不对');
      if (!smsEnabled()) return fail(req, res, 503, '服务端还没配置短信通道');
      const user = users.get(phone);
      if (!user) return fail(req, res, 404, '这个手机号还没注册');
      // 账号被停用的话，验证码也不该放进来
      if (user.disabled) return fail(req, res, 403, '这个账号已被停用');

      const check = verifyCode(phone, code);
      if (!check.ok) {
        await new Promise((r) => setTimeout(r, 400));
        return fail(req, res, 401, check.reason);
      }
      await users.touchLogin(user);
      return sendJSONCors(req, res, 200, { ok: true, data: { authed: true, me: users.publicView(user) } }, {
        'Set-Cookie': sessionCookie(tokenFor(user), { crossSite: !!req.headers.origin }).replace('Path=/;', `Path=${cookiePathFor(req)};`),
      });
    }

    // ---------- 手机号 + 密码登录 ----------
    if (p === '/api/auth/login' && method === 'POST') {
      const body = await readBody(req);
      const phone = String(body.phone || '').trim();
      const pw = String(body.password || '');
      if (!isPhone(phone)) return fail(req, res, 400, '手机号格式不对');
      const user = users.get(phone);
      if (user?.disabled) return fail(req, res, 403, '这个账号已被停用');
      const authedUser = users.authenticate(phone, pw);
      if (!authedUser) {
        await new Promise((r) => setTimeout(r, 600)); // 轻微延时，抑制暴力尝试
        // 不区分「没这个号」和「密码不对」，免得被拿来枚举用户
        return fail(req, res, 401, '手机号或密码不对');
      }
      await users.touchLogin(authedUser);
      return sendJSONCors(req, res, 200, { ok: true, data: { authed: true, me: users.publicView(authedUser) } }, {
        'Set-Cookie': sessionCookie(tokenFor(authedUser), { crossSite: !!req.headers.origin }).replace('Path=/;', `Path=${cookiePathFor(req)};`),
      });
    }

    // ---------- 退出登录 ----------
    if ((p === '/api/auth/logout' || p === '/api/auth/signout') && method === 'POST') {
      return sendJSONCors(req, res, 200, { ok: true, data: { authed: false } }, {
        'Set-Cookie': clearCookie({ crossSite: !!req.headers.origin }).replace('Path=/;', `Path=${cookiePathFor(req)};`),
      });
    }

    // ================= 以下全部需要登录 =================
    const me = whoami(req);
    if (!me) return fail(req, res, 401, '请先登录');
    // 这个人的数据。下面一律用这两个局部变量，天然只碰自己的目录。
    const { store, audio, care } = await ctxFor(me);

    // ---------- 账号信息 ----------
    if (p === '/api/auth/profile' && method === 'GET') {
      return ok(req, res, {
        nickname: me.nickname || '',
        bio: store.meta.bio || '',
        phone: me.phone,
        phoneMasked: maskPhone(me.phone),
        hasPassword: true,
        smsConfigured: smsEnabled(),
        createdAt: me.createdAt,
      });
    }

    // ---------- 改昵称和简介 ----------
    if (p === '/api/auth/profile' && (method === 'PUT' || method === 'POST')) {
      const body = await readBody(req);
      // 只认字符串：传对象进来 String() 会得到 "[object Object]"，那种脏数据别往库里写
      const asText = (v) => (typeof v === 'string' ? v : '');
      const nickname = asText(body.nickname).trim().slice(0, 20).replace(/\s+/g, ' ');
      const bio = asText(body.bio).trim().slice(0, 80).replace(/\s+/g, ' ');
      await users.setNickname(me, nickname);
      store.meta.bio = bio;
      await store.writeJSON('meta.json', store.meta);
      return ok(req, res, { nickname: me.nickname, bio: store.meta.bio });
    }

    // ---------- 换手机号 ----------
    // 账号就是手机号，所以「换绑」等于换账号。
    // 用当前密码验证，不用短信：注册都已经不依赖短信了，
    // 这里再挂一个「要验证码但根本发不出去」的按钮只会让人卡住。
    // 密码本来就是真正的凭据，够证明是本人。
    if (p === '/api/auth/phone' && method === 'POST') {
      const body = await readBody(req);
      const phone = String(body.phone || '').trim();
      const password = String(body.password || '');
      if (!isPhone(phone)) return fail(req, res, 400, '手机号格式不对');
      if (phone === me.phone) return fail(req, res, 400, '这已经是你现在的手机号了');
      if (users.has(phone)) return fail(req, res, 409, '这个手机号已经被别人注册了');
      if (!users.authenticate(me.phone, password)) {
        await new Promise((r) => setTimeout(r, 400));
        return fail(req, res, 401, '密码不对，换号需要验证是本人');
      }
      delete users.data.byPhone[me.phone];
      me.phone = phone;
      users.data.byPhone[phone] = me;
      await users.write();
      return ok(req, res, { phone, phoneMasked: maskPhone(phone) });
    }

    // ---------- 改密码 ----------
    if (p === '/api/auth/password' && method === 'POST') {
      const body = await readBody(req);
      const oldPw = String(body.oldPassword || '');
      const newPw = String(body.newPassword || '');
      if (!users.authenticate(me.phone, oldPw)) return fail(req, res, 400, '当前密码不正确');
      const bad = checkPassword(newPw);
      if (bad) return fail(req, res, 400, bad);
      // setPassword 会把 epoch +1：这个人的其它设备立刻下线，别人的不受影响
      await users.setPassword(me, newPw);
      return sendJSONCors(req, res, 200, { ok: true, data: { changed: true } }, {
        'Set-Cookie': sessionCookie(tokenFor(me), { crossSite: !!req.headers.origin }).replace('Path=/;', `Path=${cookiePathFor(req)};`),
      });
    }
    // ---------- 语音：播放录音（支持 Range，可拖动进度） ----------
    let am = /^\/api\/audio\/([\w-]+)$/.exec(p);
    if (am && (method === 'GET' || method === 'HEAD')) {
      const rec = audio.get(am[1]);
      if (!rec) return fail(req, res, 404, '录音不存在');
      const abs = audio.absPath(rec);
      if (!abs || !audio.exists(rec)) return fail(req, res, 404, '录音文件已丢失');
      return sendAudio(req, res, rec, abs, () => 'application/octet-stream', corsHeaders(req));
    }

    // ---------- 语音：删除录音 ----------
    if (am && method === 'DELETE') {
      const done = await audio.remove(am[1]);
      return done ? ok(req, res, { deleted: am[1] }) : fail(req, res, 404, '录音不存在');
    }

    // ---------- 语音：上传录音并转写 ----------
    if (p === '/api/voice/transcribe' && method === 'POST') {
      const body = await readBody(req, 20 * 1024 * 1024);
      if (!asrEnabled()) return fail(req, res, 503, '服务端没有配置语音转写通道（需要 SILICONFLOW_API_KEY）');
      const { buf, mime } = decodeAudio(body.audio, MAX_AUDIO_BYTES);
      const rec = await audio.save(buf, {
        mime,
        durationMs: body.durationMs,
      });
      try {
        const out = await transcribe(buf, {
          mime,
          ext: rec.ext,
          language: typeof body.language === 'string' ? body.language : 'zh',
        });
        // 转写文本回写到元数据，方便以后重放时看到原文
        rec.transcript = out.text;
        await storeMetaUpdate(audio, rec);
        return ok(req, res, {
          audio: { ...audio.publicMeta(rec), transcript: out.text },
          transcript: out.text,
          provider: out.provider,
          model: out.model,
          // 百炼会顺带给出情绪与语种，可以拿来预填「此刻心情」
          emotion: out.emotion || null,
          language: out.language || null,
          elapsedMs: out.elapsedMs ?? null,
        });
      } catch (e) {
        // 转写失败也保留录音，用户可以手工补文字
        const cls = classifyAsrError(String(e?.message || e));
        return ok(req, res, {
          audio: { ...audio.publicMeta(rec), transcript: '' },
          transcript: '',
          error: String(e?.message || e),
          errorKind: cls.kind,
          hint: cls.hint,
        });
      }
    }

    // ---------- 语音：AI 提炼要点 ----------
    if (p === '/api/voice/extract' && method === 'POST') {
      const body = await readBody(req, 2 * 1024 * 1024);
      if (!aiEnabled()) return fail(req, res, 503, '服务端未配置 DEEPSEEK_API_KEY');
      const out = await extractVoice(String(body.transcript || ''), {
        todayStr: typeof body.today === 'string' ? body.today : undefined,
      });
      return ok(req, res, out);
    }

    // ---------- 语音：只上传不转写（离线补传用） ----------
    if (p === '/api/voice/upload' && method === 'POST') {
      const body = await readBody(req, 20 * 1024 * 1024);
      const { buf, mime } = decodeAudio(body.audio, MAX_AUDIO_BYTES);
      const rec = await audio.save(buf, {
        mime,
        durationMs: body.durationMs,
        transcript: typeof body.transcript === 'string' ? body.transcript : '',
      });
      return ok(req, res, { audio: audio.publicMeta(rec) });
    }

    // ---------- 记录 ----------
    if (p === '/api/entries' && method === 'GET') {
      const from = q.get('from');
      const to = q.get('to');
      const limit = Math.min(Number(q.get('limit') || 600), 2000);
      const list = from || to ? store.range(from, to, limit) : store.active().slice(0, limit);
      return ok(req, res, { entries: list.map((e) => withAttachments(audio, e)), total: store.active().length });
    }

    if (p === '/api/entries' && method === 'POST') {
      const body = await readBody(req);
      if (!String(body.content || '').trim() && !String(body.title || '').trim()) {
        return fail(req, res, 400, '内容不能为空');
      }
      const entry = await store.put({
        id: body.id,
        content: String(body.content || '').slice(0, 20000),
        title: String(body.title || '').slice(0, 200),
        tags: Array.isArray(body.tags) ? body.tags.slice(0, 12).map((t) => String(t).slice(0, 24)) : [],
        mood: body.mood ?? null,
        kind: body.kind || 'note',
        date: body.date,
        createdAt: body.createdAt,
        attachments: sanitizeAttachments(audio, body.attachments),
        // 用同一个 id 重新提交视为「恢复」：必须显式清掉软删除标记
        deleted: false,
      });
      return ok(req, res, { entry: withAttachments(audio, entry) });
    }

    if (p === '/api/entries/bulk' && method === 'POST') {
      const body = await readBody(req);
      const items = Array.isArray(body.items) ? body.items : [];
      const saved = await store.bulk(items);
      return ok(req, res, { saved: saved.length, entries: saved });
    }

    let m = /^\/api\/entries\/([\w-]+)$/.exec(p);
    if (m && method === 'PATCH') {
      const body = await readBody(req);
      if (!store.get(m[1])) return fail(req, res, 404, '记录不存在');
      const patch = { ...body, id: m[1] };
      if (body.attachments !== undefined) patch.attachments = sanitizeAttachments(audio, body.attachments);
      const entry = await store.put(patch);
      return ok(req, res, { entry: withAttachments(audio, entry) });
    }
    if (m && method === 'DELETE') {
      const done = await store.remove(m[1]);
      return done ? ok(req, res, { deleted: m[1] }) : fail(req, res, 404, '记录不存在');
    }

    // ---------- 某一天 ----------
    m = /^\/api\/day\/(\d{4}-\d{2}-\d{2})$/.exec(p);
    if (m && method === 'GET') {
      const date = m[1];
      const d = new Date(date + 'T12:00:00');
      const entries = store.byDate(date).map((e) => withAttachments(audio, e));
      const summary = await store.getSummary(date);
      return ok(req, res, {
        date,
        weekday: WEEK_CN[d.getDay()],
        entries,
        summary,
      });
    }

    if (p === '/api/summary' && method === 'POST') {
      const body = await readBody(req);
      const date = String(body.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(req, res, 400, '日期格式应为 YYYY-MM-DD');
      const out = await summarizeDay(store, date, { force: !!body.force });
      return ok(req, res, out);
    }

    // ---------- 那年今日 ----------
    if (p === '/api/memories' && method === 'GET') {
      const date = q.get('date') || (typeof q.get('today') === 'string' ? q.get('today') : toDateStr(new Date()));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(req, res, 400, '日期格式应为 YYYY-MM-DD');
      const groups = memoriesOf(store, date, Math.min(Number(q.get('years') || 5), 20));
      return ok(req, res, { date, groups, count: groups.reduce((n, g) => n + g.entries.length, 0) });
    }

    if (p === '/api/memories/reflect' && method === 'POST') {
      const body = await readBody(req);
      const date = String(body.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(req, res, 400, '日期格式应为 YYYY-MM-DD');
      if (!aiEnabled()) return fail(req, res, 503, '服务端未配置 DEEPSEEK_API_KEY');
      const out = await reflectMemories(store, date);
      return ok(req, res, out);
    }

    // ---------- 检索 ----------
    if (p === '/api/search' && method === 'GET') {
      const text = q.get('q') || '';
      const from = q.get('from') || undefined;
      const to = q.get('to') || undefined;
      const limit = Math.min(Number(q.get('limit') || 40), 200);
      const hits = store.search(text, { limit, from, to });
      return ok(req, res, {
        hits,
        count: hits.length,
        range: parseTimeRange(text, anchorDate(q.get('today'))),
        keywords: stripTimeWords(text),
      });
    }

    if (p === '/api/tags' && method === 'GET') {
      return ok(req, res, { tags: store.tags() });
    }

    if (p === '/api/stats' && method === 'GET') {
      return ok(req, res, store.stats());
    }

    // ---------- 日历密度（按月） ----------
    if (p === '/api/calendar' && method === 'GET') {
      const month = q.get('month') || toDateStr(new Date()).slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(month)) return fail(req, res, 400, '月份格式应为 YYYY-MM');
      const [y, mo] = month.split('-').map(Number);
      const from = `${month}-01`;
      const last = new Date(y, mo, 0).getDate();
      const to = `${month}-${String(last).padStart(2, '0')}`;
      const list = store.range(from, to, 1000);
      const map = {};
      for (const e of list) map[e.date] = (map[e.date] || 0) + 1;
      return ok(req, res, { month, counts: map });
    }

    // ================= 关怀：吃药 / 提醒 / 学习模式 =================
    // 三块功能的数据都归 care 管，和记录完全分开存。

    /** 把「这一天的药 + 这一天的提醒 + 现在该不该专注」打包给首页浮卡用 */
    if (p === '/api/care/today' && method === 'GET') {
      const now = Date.now();
      const today = q.get('today') || dateStr(new Date(now));
      const meds = care.listMeds();
      const doses = care.doseLog();
      const plan = todayPlan(meds, doses, today, now);
      const focus = care.getFocus();
      const blocking = blockedPackages(focus.blocks, now, focus.alwaysAllow);
      const next = nextDoseAt(meds, doses, now);
      const ups = upcomingReminders(care.listReminders(), now);
      return ok(req, res, {
        date: today,
        meds: { plan, pending: pendingCount(plan), overdue: overdueCount(plan), next: next ? { at: next.at, date: next.date, slot: next.slot, name: next.med.name, dose: next.med.dose } : null },
        reminders: ups.slice(0, 5).map((r) => ({ id: r.id, title: r.title, at: r.at, fireAt: r.fireAt, advance: r.advance })),
        focus: {
          blocking: !!blocking.block,
          label: blocking.block?.label || '',
          packages: blocking.packages.length,
          remaining: blocking.block ? blockRemainingMin(blocking.block, now) : 0,
          next: (() => {
            const n = nextBlockStart(focus.blocks, now);
            return n ? { at: n.at, label: n.block.label } : null;
          })(),
        },
      });
    }

    // ---------- 吃药 ----------
    if (p === '/api/care/meds' && method === 'GET') {
      const meds = care.listMeds();
      return ok(req, res, { meds, today: todayPlan(meds, care.doseLog(), dateStr(new Date())) });
    }

    if (p === '/api/care/meds' && method === 'POST') {
      const body = await readBody(req);
      const r = await care.saveMed(body);
      if (!r.ok) return fail(req, res, 400, r.error);
      return ok(req, res, { med: r.med, today: todayPlan(care.listMeds(), care.doseLog(), dateStr(new Date())) });
    }

    if (p.startsWith('/api/care/meds/') && method === 'DELETE') {
      const id = decodeURIComponent(p.slice('/api/care/meds/'.length));
      const r = await care.removeMed(id);
      if (!r.ok) return fail(req, res, 404, r.error);
      return ok(req, res, { removed: id });
    }

    /**
     * 打卡。
     * 路由写成 /api/care/meds/<id>/dose，id 里不会出现斜杠（是随机十六进制）。
     */
    if (p.startsWith('/api/care/meds/') && p.endsWith('/dose') && method === 'POST') {
      const id = decodeURIComponent(p.slice('/api/care/meds/'.length, -'/dose'.length));
      const body = await readBody(req);
      const r = await care.logDose({ medId: id, at: body.at, ds: body.date, action: body.action, source: body.source });
      if (!r.ok) return fail(req, res, 400, r.error);
      const today = body.date || dateStr(new Date());
      return ok(req, res, { record: r.record, today: todayPlan(care.listMeds(), care.doseLog(), today) });
    }

    /**
     * 解析医嘱（文字 / 语音转写 / 图片）。
     *
     * 刻意不落库：这是要用来提醒吃药的清单，抄错了就是吃错药。
     * 一律返回草稿，由用户点过「就用这个」之后才走 POST /api/care/meds。
     */
    if (p === '/api/care/meds/parse' && method === 'POST') {
      if (!aiEnabled()) return fail(req, res, 503, '服务端未配置 DEEPSEEK_API_KEY');
      const body = await readBody(req, 40 * 1024 * 1024);
      const images = (Array.isArray(body.images) ? body.images : [])
        .slice(0, 4)
        .map((im) => ({ mime: String(im?.mime || ''), data: String(im?.data || '') }))
        .filter((im) => im.mime && im.data);
      const text = String(body.text || '').trim();
      if (!text && !images.length) return fail(req, res, 400, '给点文字或者一张医嘱图片');

      const parsed = await parseMedication({ text, images, todayStr: body.today });

      // 图片留底，处方单过两个月还想回头看
      const savedImages = [];
      for (const im of images.slice(0, 4)) {
        const s = await care.saveImage({ mime: im.mime, data: im.data });
        if (s.ok) savedImages.push(s.image);
      }
      return ok(req, res, { ...parsed, images: savedImages });
    }

    /** 医嘱原图 */
    if (p.startsWith('/api/care/images/') && method === 'GET') {
      const id = decodeURIComponent(p.slice('/api/care/images/'.length));
      const hit = care.imageFile(id);
      if (!hit) return fail(req, res, 404, '图片不存在');
      const stat = await fsp.stat(hit.path);
      res.writeHead(200, {
        'Content-Type': hit.mime,
        'Content-Length': stat.size,
        'Cache-Control': 'private, max-age=31536000, immutable',
        ...corsHeaders(req),
      });
      return fs.createReadStream(hit.path).pipe(res);
    }

    // ---------- 快捷提醒 ----------
    if (p === '/api/care/reminders' && method === 'GET') {
      const now = Date.now();
      const all = care.listReminders();
      return ok(req, res, {
        reminders: all,
        upcoming: upcomingReminders(all, now),
        past: all.filter((r) => (parseLocalISO(r.at) || 0) <= now || r.done).slice(-30).reverse(),
      });
    }

    if (p === '/api/care/reminders' && method === 'POST') {
      const body = await readBody(req);
      const r = await care.saveReminder(body);
      if (!r.ok) return fail(req, res, 400, r.error);
      return ok(req, res, { reminder: r.reminder });
    }

    if (p.startsWith('/api/care/reminders/') && method === 'DELETE') {
      const id = decodeURIComponent(p.slice('/api/care/reminders/'.length));
      const r = await care.removeReminder(id);
      if (!r.ok) return fail(req, res, 404, r.error);
      return ok(req, res, { removed: id });
    }

    /**
     * 看看一条记录里有没有「到点要做的事」。
     * 不在保存流程里调用：记录是最高频的操作，不能被一次 AI 调用拖慢。
     */
    if (p === '/api/care/reminders/detect' && method === 'POST') {
      if (!aiEnabled()) return fail(req, res, 503, '服务端未配置 DEEPSEEK_API_KEY');
      const body = await readBody(req);
      const text = String(body.text || '').trim();
      if (!text) return fail(req, res, 400, '没有要判断的内容');
      // 同一条笔记已经问过一次就不再问，免得反复弹
      const entryId = String(body.entryId || '').trim();
      if (entryId && care.hasReminderForEntry(entryId)) return ok(req, res, { found: false, skipped: 'asked' });
      const found = await detectReminder({ text, todayStr: body.today, nowTs: Date.now() });
      return ok(req, res, found);
    }

    // ---------- 学习模式 ----------
    if (p === '/api/care/focus' && method === 'GET') {
      const now = Date.now();
      const focus = care.getFocus();
      const blocking = blockedPackages(focus.blocks, now, focus.alwaysAllow);
      const log = care.focusLogRecent(60);
      const n = nextBlockStart(focus.blocks, now);
      return ok(req, res, {
        focus,
        now: { blocking: !!blocking.block, block: blocking.block, packages: blocking.packages, remaining: blocking.block ? blockRemainingMin(blocking.block, now) : 0 },
        next: n ? { at: n.at, label: n.block.label } : null,
        // 最近 60 天的专注统计，给用户一点正反馈
        stats: {
          sessions: log.length,
          minutes: log.reduce((s, r) => s + (r.minutes || 0), 0),
          todayMinutes: log.filter((r) => dateStr(new Date(r.ts)) === dateStr(new Date())).reduce((s, r) => s + (r.minutes || 0), 0),
          week: (() => {
            const since = Date.now() - 7 * 86400000;
            return log.filter((r) => r.ts >= since).reduce((s, r) => s + (r.minutes || 0), 0);
          })(),
        },
      });
    }

    if (p === '/api/care/focus' && (method === 'PUT' || method === 'POST')) {
      const body = await readBody(req);
      const r = await care.saveFocus(body);
      if (!r.ok) return fail(req, res, 400, r.error);
      return ok(req, res, { focus: r.focus });
    }

    if (p === '/api/care/focus/log' && method === 'POST') {
      const body = await readBody(req);
      const r = await care.logFocus({ minutes: body.minutes, blockId: body.blockId, label: body.label, ended: body.ended });
      if (!r.ok) return fail(req, res, 400, r.error);
      return ok(req, res, { record: r.record });
    }

    /**
     * 未来一段时间所有该响的提醒。
     * 客户端（尤其是安卓那边）拿这张表去排本地通知/闹钟，
     * 什么时候响、响什么、要不要闹钟模式，全在这里算完。
     */
    if (p === '/api/care/schedule' && method === 'GET') {
      const days = Number(q.get('days') || 7);
      const now = Date.now();
      const focus = care.getFocus();
      const blocking = blockedPackages(focus.blocks, now, focus.alwaysAllow);
      return ok(req, res, {
        generatedAt: now,
        schedule: buildSchedule({ meds: care.listMeds(), doses: care.doseLog(), reminders: care.listReminders() }, { days, now }),
        // 学习模式只把「下一次该锁什么」告诉客户端：锁是本地行为，
        // 但「现在该不该锁」的判断和提醒一样统一在这里做
        focusBlocks: focus.blocks,
        focusAlwaysAllow: focus.alwaysAllow,
        // 展开成具体的起止时刻，安卓的无障碍服务照着这个查就行
        focusIntervals: buildFocusIntervals(focus.blocks, { days, now, alwaysAllow: focus.alwaysAllow }),
        focus: {
          blocking: !!blocking.block,
          label: blocking.block?.label || '',
          packages: blocking.packages,
          remaining: blocking.block ? blockRemainingMin(blocking.block, now) : 0,
          next: (() => {
            const n = nextBlockStart(focus.blocks, now);
            return n ? { at: n.at, label: n.block.label, packages: [] } : null;
          })(),
        },
      });
    }

    // ---------- AI 对话（流式） ----------
    if (p === '/api/ai/chat' && method === 'POST') {
      const body = await readBody(req, 1024 * 1024);
      const question = String(body.question || '').trim();
      if (!question) return fail(req, res, 400, '请先说点什么');
      if (!aiEnabled()) return fail(req, res, 503, '服务端未配置 DEEPSEEK_API_KEY');

      const history = Array.isArray(body.history) ? body.history.slice(-8) : [];
      const controller = new AbortController();
      req.on('close', () => controller.abort());

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...corsHeaders(req),
      });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

      try {
        const result = await askStream({
          store,
          question,
          history,
          todayStr: typeof body.today === 'string' ? body.today : undefined,
          signal: controller.signal,
          onDelta: (d) => send({ type: 'delta', text: d }),
          onReasoning: () => {},
        });
        send({
          type: 'done',
          answer: result.answer,
          refs: result.refs,
          entries: result.entries,
          meta: result.meta,
        });
      } catch (err) {
        send({ type: 'error', error: String(err?.message || err) });
      }
      return res.end();
    }

    // ---------- AI 单轮问答（非流式，供检索页用） ----------
    if (p === '/api/ai/ask' && method === 'POST') {
      const body = await readBody(req, 1024 * 1024);
      const question = String(body.question || '').trim();
      if (!question) return fail(req, res, 400, '请先说点什么');
      const out = await ask({
        store,
        question,
        history: Array.isArray(body.history) ? body.history : [],
        todayStr: typeof body.today === 'string' ? body.today : undefined,
      });
      return ok(req, res, out);
    }


    return fail(req, res, 404, `未知接口 ${method} ${p}`);
  } catch (err) {
    console.error('[拾光] 接口出错', p, err);
    return fail(req, res, 500, String(err?.message || '服务器内部错误'));
  } finally {
    logRequest(req, res, p, method, started);
  }
});

// ---------------------------------------------------------------
// 静态文件（dist/），支持 SPA 回退
// ---------------------------------------------------------------
const DIST = process.env.SHIGUANG_DIST || path.join(process.cwd(), 'dist');

function serveStatic(res, p) {
  if (!fs.existsSync(DIST)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('前端尚未构建');
  }
  let rel = decodeURIComponent(p);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.join(DIST, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (full.startsWith(DIST) && fs.existsSync(full) && fs.statSync(full).isFile()) {
    const ext = path.extname(full).toLowerCase();
    const immutable = rel.includes('/assets/');
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    return fs.createReadStream(full).pipe(res);
  }
  const index = path.join(DIST, 'index.html');
  if (fs.existsSync(index)) {
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
    return fs.createReadStream(index).pipe(res);
  }
  res.writeHead(404).end('not found');
}

server.listen(PORT, HOST, () => {
  console.log(`[拾光] 服务已启动 http://${HOST}:${PORT}`);
  console.log(`[拾光] 数据目录 ${DATA_DIR}`);
  console.log(`[拾光] 账号 ${users.count()} 个${REGISTER_OPEN ? '（开放注册）' : '（已关闭注册）'}`);
  console.log(`[拾光] 注册邀请码 ${inviteCode}   （也存在 ${INVITE_FILE}，或写在 /etc/shiguang.env 的 SHIGUANG_INVITE_CODE 里）`);
  if (!users.count()) {
    console.log('[拾光] 还没有任何账号。打开网页用「注册」+ 上面这个邀请码建第一个，');
    console.log('[拾光] 或者用命令行：node server/src/cli.mjs add <手机号> <密码>');
  }
  console.log(`[拾光] AI ${aiEnabled() ? `已就绪（${MODEL}）` : '未配置 DEEPSEEK_API_KEY'}`);
  const asr = asrInfo();
  console.log(`[拾光] 语音转写 ${asr.enabled ? `已就绪（${asr.label} / ${asr.model}）` : '未配置 SILICONFLOW_API_KEY'}`);
  console.log(`[拾光] 短信 ${smsEnabled() ? '已就绪' : '未配置（短信登录和注册暂时关闭）'}`);
});

// 优雅退出：把内存里的最新版本落盘
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log(`[拾光] 收到 ${sig}，正在保存...`);
    // 每个开过号的用户都有一份自己的 Store，逐个落盘。
    //
    // contexts 里存的是**建上下文的 Promise**（见 ctxFor 的注释），
    // 所以必须先 await 再取 store。直接写 c.store 拿到的是 undefined，
    // 会在退出路径上报「Cannot read properties of undefined (reading 'flush')」——
    // 而且那是个只进日志的错误，很容易一直没人发现。
    for (const [id, p] of contexts) {
      try {
        const c = await p;
        await c.store.flush();
      } catch (e) {
        console.error(`保存失败（${id}）`, e);
      }
    }
    process.exit(0);
  });
}
