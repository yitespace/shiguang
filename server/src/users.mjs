// =============================================================
// 拾光 · 用户注册表（多用户）
//
// 账号就是手机号。一个号一个目录，彼此完全看不见对方的东西：
//
//   data/users.json          注册表：手机号 -> 用户记录（含密码哈希）
//   data/u/<userId>/         这个人的全部数据，结构和以前单用户时一模一样
//     meta.json              昵称、简介、会话代数
//     notes/YYYY-MM.jsonl
//     audio/YYYY-MM/...
//
// 分开存的原因：Store 和 AudioStore 本来就是「给一个根目录就能跑」，
// 把根目录从 data/ 换成 data/u/<id>/ 就天然隔离了，
// 不用在每条记录里塞 userId，也不会因为漏加一个 where 就串号。
// =============================================================

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { hashPassword, verifyPassword } from './auth.mjs';

const USERS_FILE = 'users.json';

/** 手机号简单校验：11 位，1[3-9] 开头 */
export function isPhone(s) {
  return /^1[3-9]\d{9}$/.test(String(s || '').trim());
}

/** 手机号打码：138****8000 */
export function maskPhone(p) {
  const s = String(p || '');
  return s.length === 11 ? `${s.slice(0, 3)}****${s.slice(7)}` : s;
}

/** 密码规则：至少 6 位，不能是纯数字（纯数字太容易被撞） */
export function checkPassword(pw) {
  const s = String(pw || '');
  if (s.length < 6) return '密码至少 6 位';
  if (s.length > 64) return '密码太长了';
  if (/^\d+$/.test(s)) return '密码别用纯数字，加个字母或符号';
  return null;
}

export class Users {
  /** @param {string} root 数据根目录 */
  constructor(root) {
    this.root = root;
    /** @type {{version:number, byPhone:Record<string, any>}} */
    this.data = { version: 1, byPhone: {} };
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await fsp.mkdir(path.join(this.root, 'u'), { recursive: true });
    try {
      const raw = await fsp.readFile(path.join(this.root, USERS_FILE), 'utf8');
      this.data = { version: 1, byPhone: {}, ...JSON.parse(raw) };
      if (!this.data.byPhone) this.data.byPhone = {};
    } catch {
      await this.write();
    }
    return this;
  }

  async write() {
    this.writeQueue = this.writeQueue.then(async () => {
      const tmp = path.join(this.root, `${USERS_FILE}.tmp`);
      await fsp.writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      await fsp.rename(tmp, path.join(this.root, USERS_FILE));
    });
    return this.writeQueue;
  }

  /** 某个手机号的数据目录 */
  dirOf(user) {
    return path.join(this.root, 'u', user.id);
  }

  get(phone) {
    return this.data.byPhone[String(phone || '').trim()] || null;
  }

  /** 按内部 id 找（会话里存的是 id，不是手机号） */
  byId(id) {
    if (!id) return null;
    for (const u of Object.values(this.data.byPhone)) if (u.id === id) return u;
    return null;
  }

  has(phone) {
    return !!this.get(phone);
  }

  count() {
    return Object.keys(this.data.byPhone).length;
  }

  /**
   * 建号。
   * @returns {{ok:true, user:any} | {ok:false, error:string}}
   */
  async create(phone, password, { nickname = '', role = 'user' } = {}) {
    const p = String(phone || '').trim();
    if (!isPhone(p)) return { ok: false, error: '手机号格式不对' };
    if (this.has(p)) return { ok: false, error: '这个手机号已经注册过了' };
    const bad = checkPassword(password);
    if (bad) return { ok: false, error: bad };

    const user = {
      id: crypto.randomBytes(8).toString('hex'),
      phone: p,
      password: hashPassword(String(password)),
      nickname,
      role,
      // 改密码时 +1：旧 token 立刻作废，但只作废这一个人的
      epoch: 1,
      createdAt: Date.now(),
      lastLoginAt: null,
    };
    this.data.byPhone[p] = user;
    await fsp.mkdir(path.join(this.dirOf(user), 'notes'), { recursive: true });
    await this.write();
    return { ok: true, user };
  }

  /** 校验手机号 + 密码 */
  authenticate(phone, password) {
    const user = this.get(phone);
    if (!user) return null;
    return verifyPassword(String(password || ''), user.password) ? user : null;
  }

  async setPassword(user, password) {
    user.password = hashPassword(String(password));
    user.epoch = (user.epoch || 1) + 1;
    await this.write();
  }

  async touchLogin(user) {
    user.lastLoginAt = Date.now();
    await this.write();
  }

  async setNickname(user, nickname) {
    user.nickname = String(nickname || '').slice(0, 20);
    await this.write();
  }

  /** 拿掉密码里的哈希，剩下能安全返回给前端的字段 */
  publicView(user) {
    if (!user) return null;
    return {
      id: user.id,
      phone: user.phone,
      phoneMasked: maskPhone(user.phone),
      nickname: user.nickname || '',
      role: user.role || 'user',
      createdAt: user.createdAt,
    };
  }

  /** 所有用户（管理用） */
  list() {
    return Object.values(this.data.byPhone).sort((a, b) => a.createdAt - b.createdAt);
  }

  async remove(phone) {
    const user = this.get(phone);
    if (!user) return false;
    delete this.data.byPhone[user.phone];
    await this.write();
    // 数据目录保留不删：万一删错了还能捞回来
    return true;
  }
}

/** 目录是否为空（用来判断要不要给这个用户铺一份默认数据） */
export function dirExists(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
