// =============================================================
// 拾光 · 认证
// 密码用 scrypt 加盐哈希，会话是 HMAC 签名的 HttpOnly Cookie。
//
// 多用户之后 token 里要带上「是谁」：
//   v1.<userId>.<epoch>.<exp>.<sig>
// epoch 是每个用户自己的代数，改密码时 +1 —— 这样改密码只会把
// 自己其它设备踢下线，不会顺手把别人也踢了（早先轮换全局密钥就会）。
// =============================================================

import crypto from 'node:crypto';

const SCRYPT_KEYLEN = 64;
const SESSION_DAYS = 30;
export const COOKIE = 'sg_session';
export const DEFAULT_PASSWORD = '123456';

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, record) {
  if (!record?.salt || !record?.hash) return false;
  const test = crypto.scryptSync(password, record.salt, SCRYPT_KEYLEN);
  const known = Buffer.from(record.hash, 'hex');
  if (known.length !== test.length) return false;
  return crypto.timingSafeEqual(test, known);
}

/**
 * 生成会话 token。
 * @param {string} secret 全局签名密钥
 * @param {string} userId 这个 token 属于谁
 * @param {number} epoch  用户代数（改密码会 +1）
 */
export function makeToken(secret, userId, epoch = 1, days = SESSION_DAYS) {
  const exp = Date.now() + days * 24 * 3600 * 1000;
  const payload = `v1.${userId}.${epoch}.${exp}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/**
 * 校验 token，通过就返回 { userId, epoch }，否则 null。
 * 注意：这里只验签名和有效期，epoch 是否过期要拿用户记录再对一次。
 */
export function verifyToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 5) return null;
  const [ver, userId, epochStr, expStr, sig] = parts;
  if (ver !== 'v1' || !userId) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  const payload = `${ver}.${userId}.${epochStr}.${expStr}`;
  const expect = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  return { userId, epoch: Number(epochStr) || 1 };
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/**
 * 生成会话 Cookie。
 *
 * SameSite 必须分情况：
 *   同源（网页版）→ Lax，最安全
 *   跨站（安卓 App，页面在 localhost、接口在自己域名）→ 必须是 None，
 *     否则浏览器会直接丢掉这个 Cookie，表现就是「登录成功但下一步又是未登录」
 *   SameSite=None 要求 Secure，所以只在 https 下用
 */
export function sessionCookie(token, { maxAge = SESSION_DAYS * 24 * 3600, crossSite = false } = {}) {
  const sameSite = crossSite ? 'None; Secure' : 'Lax';
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}`;
}

export function clearCookie({ crossSite = false } = {}) {
  const sameSite = crossSite ? 'None; Secure' : 'Lax';
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=0`;
}

/** 从请求里取出会话（只验签名，不管用户还在不在） */
export function sessionOf(req, secret) {
  const cookies = parseCookies(req.headers.cookie);
  return verifyToken(cookies[COOKIE], secret);
}
