// =============================================================
// 拾光 · 阿里云短信
// 按阿里云 RPC 风格签名（HMAC-SHA1）直接调 API，零第三方依赖。
//
// 需要的环境变量（写在 /etc/shiguang.env）：
//   ALIYUN_SMS_AK_ID       AccessKey ID
//   ALIYUN_SMS_AK_SECRET   AccessKey Secret
//   ALIYUN_SMS_SIGN        短信签名，例如「拾光」
//   ALIYUN_SMS_TEMPLATE    模板 CODE，例如 SMS_123456789
//   ALIYUN_SMS_REGION      默认 cn-hangzhou
//
// 没配置时会退化成「开发模式」：验证码只写进服务器日志，不真发短信。
// 这样在拿到 Key 之前也能把整条登录链路跑通。
// =============================================================

import crypto from 'node:crypto';

const API_HOST = 'https://dysmsapi.aliyuncs.com';

export function smsConfig() {
  const id = process.env.ALIYUN_SMS_AK_ID || '';
  const secret = process.env.ALIYUN_SMS_AK_SECRET || '';
  const sign = process.env.ALIYUN_SMS_SIGN || '';
  const template = process.env.ALIYUN_SMS_TEMPLATE || '';
  const region = process.env.ALIYUN_SMS_REGION || 'cn-hangzhou';
  return {
    id,
    secret,
    sign,
    template,
    region,
    /** 四项齐全才算真能发短信 */
    ready: !!(id && secret && sign && template),
  };
}

/**
 * 开发模式：SHIGUANG_SMS_DEV=1 时假装短信通道已就绪，
 * 验证码不真发，只写日志并回显给前端。
 * 用途是在拿到阿里云 Key 之前把「绑定手机号 → 验证码登录」整条链路跑通。
 */
export function smsDevMode() {
  const v = String(process.env.SHIGUANG_SMS_DEV || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** 能发短信 = 真的配好了 Key，或者显式开了开发模式 */
export function smsEnabled() {
  return smsConfig().ready || smsDevMode();
}

/** 阿里云要求的那套百分号编码：空格用 %20，~ 不编码 */
function percentEncode(str) {
  return encodeURIComponent(str)
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

/**
 * 发一条短信
 * @param {string} phone 11 位手机号
 * @param {string} code 验证码
 */
export async function sendSms(phone, code) {
  const cfg = smsConfig();
  // 开发模式不发真短信，只把验证码打到日志，避免自测时误发/计费
  if (!cfg.ready) {
    if (smsDevMode()) {
      console.log(`[拾光] 短信开发模式：${phone} 的验证码是 ${code}（未真实发送）`);
      return { dev: true };
    }
    throw new Error('短信通道未配置');
  }

  const params = {
    AccessKeyId: cfg.id,
    Action: 'SendSms',
    Format: 'JSON',
    PhoneNumbers: phone,
    RegionId: cfg.region,
    SignName: cfg.sign,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: '1.0',
    TemplateCode: cfg.template,
    TemplateParam: JSON.stringify({ code }),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Version: '2017-05-25',
  };

  // 1) 参数按 key 排序并编码
  const canonical = Object.keys(params)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join('&');

  // 2) 构造待签名字符串
  const stringToSign = `POST&${percentEncode('/')}&${percentEncode(canonical)}`;

  // 3) HMAC-SHA1 签名，注意密钥后面要拼一个 &
  const signature = crypto
    .createHmac('sha1', `${cfg.secret}&`)
    .update(stringToSign)
    .digest('base64');

  // 4) 带上签名发出去（POST + 表单体是阿里云推荐的方式）
  const body = new URLSearchParams({ ...params, Signature: signature }).toString();
  const res = await fetch(API_HOST, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应 */
  }
  if (!res.ok || json?.Code !== 'OK') {
    throw new Error(`阿里云短信失败：${json?.Code || res.status} ${json?.Message || text.slice(0, 120)}`);
  }
  return { requestId: json.RequestId, bizId: json.BizId };
}

// ---------------------------------------------------------------
// 验证码的签发与校验（存内存，重启失效，单用户够用）
// ---------------------------------------------------------------
const TTL_MS = 5 * 60 * 1000;      // 5 分钟有效
const MAX_TRIES = 5;                // 最多试 5 次
/**
 * 重发冷却，默认 60 秒。
 * 自动化测试里没法真等一分钟，所以允许用 SHIGUANG_SMS_RESEND_MS 调小；
 * 生产不设这个变量，走默认值。
 */
const RESEND_MS = Math.max(0, Number(process.env.SHIGUANG_SMS_RESEND_MS || 60 * 1000)) || 60 * 1000;

/** @type {Map<string, {code:string, exp:number, sentAt:number, tries:number}>} */
const store = new Map();

/**
 * 最近一次发送时间，单独存。
 * 之前把 sentAt 放在验证码记录里，验证成功时整条记录被删掉，
 * 冷却时间也跟着没了——刚登录完就能立刻再要一条短信。
 * 限流窗口应该只跟「发过」有关，跟「用掉没有」无关。
 * @type {Map<string, number>}
 */
const lastSent = new Map();

const RESEND_MS_LOCAL = RESEND_MS;

export function makeCode() {
  return String(crypto.randomInt(100000, 1000000));
}

/** 这个手机号现在能不能发（限流） */
export function canSend(phone) {
  const at = lastSent.get(phone);
  if (!at) return { ok: true };
  const wait = Math.ceil((RESEND_MS_LOCAL - (Date.now() - at)) / 1000);
  if (wait > 0) return { ok: false, wait };
  return { ok: true };
}

export function issueCode(phone, code) {
  const now = Date.now();
  store.set(phone, { code, exp: now + TTL_MS, sentAt: now, tries: 0 });
  lastSent.set(phone, now);
}

/**
 * 校验验证码。成功会把它作废（一次性）。
 */
export function verifyCode(phone, code, { consume = true } = {}) {
  const rec = store.get(phone);
  if (!rec) return { ok: false, reason: '没发过验证码，或已经过期' };
  if (Date.now() > rec.exp) {
    store.delete(phone);
    return { ok: false, reason: '验证码过期了，重新获取' };
  }
  rec.tries += 1;
  if (rec.tries > MAX_TRIES) {
    store.delete(phone);
    return { ok: false, reason: '试错次数太多，重新获取验证码' };
  }
  if (String(code) !== rec.code) {
    return { ok: false, reason: `验证码不对，还可以试 ${Math.max(0, MAX_TRIES - rec.tries)} 次` };
  }
  if (consume) store.delete(phone);
  return { ok: true };
}

/** 定期清过期记录，避免内存里堆垃圾 */
setInterval(() => {
  const now = Date.now();
  for (const [phone, rec] of store) if (now > rec.exp) store.delete(phone);
  for (const [phone, at] of lastSent) if (now - at > RESEND_MS * 5) lastSent.delete(phone);
}, 60 * 1000).unref?.();

/** 中国手机号简单校验 */
export function isPhone(s) {
  return /^1[3-9]\d{9}$/.test(String(s || '').trim());
}
