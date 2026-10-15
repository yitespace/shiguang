// =============================================================
// 拾光 · 关怀模块的数据层
//
// 存在 data/u/<userId>/care/ 下面，和记录完全分开：
//   meds.json        药（当前有效的那份定义）
//   doses.jsonl      服药流水，append-only
//   reminders.json   提醒
//   focus.json       学习模式规则
//   focus-log.jsonl  专注时长流水，append-only
//
// 为什么药和提醒用「整份重写」而流水用 append-only：
// 药和提醒是配置，条目少、改动是「编辑一条」，整份重写最简单也不会写坏；
// 服药打卡和专注记录是事实，只会往上加，追加写天然就是备份。
// =============================================================

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeAtomic } from './atomic.mjs';
import { isHHMM, parseLocalISO, dateStr, addDays } from './care-logic.mjs';

/** 医嘱图片：和 AI 那边能接受的类型保持一致，体积再收紧一点 */
export const IMAGE_MAX_BYTES = 6 * 1024 * 1024;
const IMAGE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const EXT_IMAGE = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

const MAX_MEDS = 60;
const MAX_REMINDERS = 200;
const MAX_BLOCKS = 20;
const MAX_PACKAGES = 200;

const str = (v, max) => String(typeof v === 'string' ? v : '').trim().slice(0, max);
const bool = (v) => v === true || v === 'true' || v === 1 || v === '1';

/** 生成一个短 id：够用且不会和别人的撞（数据是分目录的） */
const newId = () => crypto.randomBytes(6).toString('hex');

/**
 * "HH:MM" 数组：去重、排序、限量。
 *
 * 每个时间点可以带自己的剂量 ——「舍曲林早上一片、晚上半片」是很常见的开法。
 * 如果按剂量拆成两条，用户会看到两张「舍曲林」卡片，还得自己反应过来
 * 这是同一种药。按「一种药 + 多个时间点」存才符合人的直觉。
 */
function cleanSlots(input) {
  const list = Array.isArray(input) ? input : [];
  const out = [];
  const seen = new Set();
  for (const raw of list.slice(0, 12)) {
    const at = typeof raw === 'string' ? raw : raw && raw.at;
    if (!isHHMM(at) || seen.has(at)) continue;
    seen.add(at);
    const slot = { at };
    if (typeof raw === 'object' && raw) {
      const label = str(raw.label, 8);
      const dose = str(raw.dose, 40);
      if (label) slot.label = label;
      if (dose) slot.dose = dose;
    }
    out.push(slot);
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** 星期几数组：0=周日。空数组或者给全 7 天都视为「每天」 */
function cleanDays(input) {
  if (!Array.isArray(input)) return [];
  const out = [...new Set(input.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))];
  return out.length >= 7 ? [] : out.sort((a, b) => a - b);
}

const cleanDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '');

export class Care {
  /** @param {string} userDir 这个用户的数据根目录（data/u/<id>） */
  constructor(userDir) {
    this.root = path.join(userDir, 'care');
    this.meds = [];
    this.reminders = [];
    this.focus = { version: 1, blocks: [], alwaysAllow: [], updatedAt: 0 };
    this.doses = [];
    this.focusLog = [];
    /** 所有写操作排成一条链，避免并发改同一份配置互相覆盖 */
    this.queue = Promise.resolve();
  }

  async init() {
    await fsp.mkdir(this.root, { recursive: true });
    this.meds = await this.readJSON('meds.json', []);
    this.reminders = await this.readJSON('reminders.json', []);
    this.focus = { ...this.focus, ...(await this.readJSON('focus.json', {})) };
    this.doses = await this.readJSONL('doses.jsonl');
    this.focusLog = await this.readJSONL('focus-log.jsonl');
    return this;
  }

  async readJSON(name, fallback) {
    try {
      const raw = await fsp.readFile(path.join(this.root, name), 'utf8');
      const v = JSON.parse(raw);
      return v == null ? fallback : v;
    } catch {
      return fallback;
    }
  }

  async readJSONL(name) {
    try {
      const raw = await fsp.readFile(path.join(this.root, name), 'utf8');
      return raw
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /** 排进写队列：读-改-写这一整段不能被别的请求插进来 */
  run(fn) {
    const next = this.queue.then(fn, fn);
    // 队列本身不能因为一次失败就断掉
    this.queue = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  async writeJSON(name, obj) {
    await writeAtomic(path.join(this.root, name), JSON.stringify(obj, null, 2));
  }

  async appendJSONL(name, rec) {
    await fsp.appendFile(path.join(this.root, name), JSON.stringify(rec) + '\n', 'utf8');
  }

  // ---------- 药 ----------

  listMeds() {
    return this.meds.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  getMed(id) {
    return this.meds.find((m) => m.id === id) || null;
  }

  /**
   * 新建或更新一种药。
   * 只接受白名单字段：模型解析出来的东西会直接怼进这里，
   * 不筛的话什么奇怪的键都会落到磁盘上。
   */
  saveMed(input) {
    return this.run(async () => {
      const now = Date.now();
      const src = input && typeof input === 'object' ? input : {};
      const id = str(src.id, 40);
      const existing = id ? this.getMed(id) : null;
      if (id && !existing) return { ok: false, error: '没有这种药' };

      const name = str(src.name, 40);
      if (!name) return { ok: false, error: '药名不能空着' };
      const slots = cleanSlots(src.slots);
      if (!slots.length) return { ok: false, error: '至少填一个服药时间' };

      const startDate = cleanDate(src.startDate);
      const endDate = cleanDate(src.endDate);
      if (startDate && endDate && endDate < startDate) return { ok: false, error: '结束日期早于开始日期' };

      const med = {
        id: existing ? existing.id : newId(),
        name,
        dose: str(src.dose, 40),
        note: str(src.note, 200),
        slots,
        days: cleanDays(src.days),
        startDate,
        endDate,
        alarm: bool(src.alarm),
        /*
         * 「必要时服用」的药不排定时提醒。
         * 到点催一个按需吃的药是危险的 —— 阿普唑仑、劳拉西泮这类
         * 苯二氮䓬天天催着吃会吃出依赖。它照样出现在清单里，
         * 用户想吃的时候可以自己打卡，只是不会被催。
         */
        prn: bool(src.prn),
        enabled: src.enabled === undefined ? true : bool(src.enabled),
        source: ['manual', 'text', 'voice', 'photo'].includes(src.source) ? src.source : 'manual',
        imageId: str(src.imageId, 60),
        rawText: str(src.rawText, 2000),
        createdAt: existing ? existing.createdAt : now,
        updatedAt: now,
      };

      if (existing) {
        this.meds = this.meds.map((m) => (m.id === med.id ? med : m));
      } else {
        if (this.meds.length >= MAX_MEDS) return { ok: false, error: `最多 ${MAX_MEDS} 种药` };
        this.meds.push(med);
      }
      await this.writeJSON('meds.json', this.meds);
      return { ok: true, med };
    });
  }

  removeMed(id) {
    return this.run(async () => {
      const before = this.meds.length;
      this.meds = this.meds.filter((m) => m.id !== id);
      if (this.meds.length === before) return { ok: false, error: '没有这种药' };
      await this.writeJSON('meds.json', this.meds);
      return { ok: true };
    });
  }

  // ---------- 服药打卡 ----------

  /**
   * 记一次服药动作。
   * action: taken 吃了 / skipped 这顿跳过 / undo 撤销（回到未处理）
   * 追加写，「撤销」也是一条新记录 —— 历史不会被抹掉。
   */
  logDose({ medId, at, ds, action, source }) {
    return this.run(async () => {
      const med = this.getMed(str(medId, 40));
      if (!med) return { ok: false, error: '没有这种药' };
      if (!isHHMM(at)) return { ok: false, error: '服药时间点不对' };
      const day = cleanDate(ds) || dateStr(new Date());
      const act = ['taken', 'skipped', 'undo'].includes(action) ? action : 'taken';
      const rec = {
        id: newId(),
        medId: med.id,
        at,
        date: day,
        action: act,
        source: ['app', 'notification', 'widget'].includes(source) ? source : 'app',
        ts: Date.now(),
      };
      this.doses.push(rec);
      await this.appendJSONL('doses.jsonl', rec);
      return { ok: true, record: rec };
    });
  }

  /** 服药流水。只留最近 400 天，文件不至于无限长 */
  doseLog(days = 400) {
    const since = addDays(dateStr(new Date()), -days);
    return this.doses.filter((d) => d.date >= since);
  }

  // ---------- 提醒 ----------

  listReminders() {
    return this.reminders.slice().sort((a, b) => (parseLocalISO(a.at) || 0) - (parseLocalISO(b.at) || 0));
  }

  saveReminder(input) {
    return this.run(async () => {
      const now = Date.now();
      const src = input && typeof input === 'object' ? input : {};
      const id = str(src.id, 40);
      const existing = id ? this.reminders.find((r) => r.id === id) : null;
      if (id && !existing) return { ok: false, error: '没有这条提醒' };

      const title = str(src.title, 60);
      if (!title) return { ok: false, error: '提醒得有个名字' };
      const at = parseLocalISO(src.at);
      if (at == null) return { ok: false, error: '提醒时间不对' };

      const advanceRaw = Number(src.advance);
      const advance = Number.isFinite(advanceRaw) ? Math.max(0, Math.min(24 * 60, Math.round(advanceRaw))) : 0;

      const reminder = {
        id: existing ? existing.id : newId(),
        title,
        at: str(src.at, 20).replace(' ', 'T'),
        advance,
        alarm: bool(src.alarm),
        done: src.done === undefined ? (existing ? existing.done : false) : bool(src.done),
        source: ['manual', 'note'].includes(src.source) ? src.source : 'manual',
        entryId: str(src.entryId, 60),
        quote: str(src.quote, 200),
        createdAt: existing ? existing.createdAt : now,
        updatedAt: now,
      };

      if (existing) this.reminders = this.reminders.map((r) => (r.id === reminder.id ? reminder : r));
      else {
        if (this.reminders.length >= MAX_REMINDERS) return { ok: false, error: `最多 ${MAX_REMINDERS} 条提醒` };
        this.reminders.push(reminder);
      }
      await this.writeJSON('reminders.json', this.reminders);
      return { ok: true, reminder };
    });
  }

  removeReminder(id) {
    return this.run(async () => {
      const before = this.reminders.length;
      this.reminders = this.reminders.filter((r) => r.id !== id);
      if (this.reminders.length === before) return { ok: false, error: '没有这条提醒' };
      await this.writeJSON('reminders.json', this.reminders);
      return { ok: true };
    });
  }

  /** 同一条笔记只该问一次「要不要设提醒」，记下来免得反复弹 */
  hasReminderForEntry(entryId) {
    const key = str(entryId, 60);
    return !!key && this.reminders.some((r) => r.entryId === key);
  }

  // ---------- 学习模式 ----------

  getFocus() {
    return {
      version: 1,
      blocks: (this.focus.blocks || []).map((b) => ({ ...b })),
      alwaysAllow: [...(this.focus.alwaysAllow || [])],
      updatedAt: this.focus.updatedAt || 0,
    };
  }

  saveFocus(input) {
    return this.run(async () => {
      const src = input && typeof input === 'object' ? input : {};
      const blocks = [];
      for (const raw of (Array.isArray(src.blocks) ? src.blocks : []).slice(0, MAX_BLOCKS)) {
        if (!raw || typeof raw !== 'object') continue;
        const from = str(raw.from, 5);
        const to = str(raw.to, 5);
        if (!isHHMM(from) || !isHHMM(to)) continue;
        blocks.push({
          id: str(raw.id, 40) || newId(),
          label: str(raw.label, 20) || '专注',
          from,
          to,
          days: cleanDays(raw.days),
          packages: [...new Set((Array.isArray(raw.packages) ? raw.packages : []).map((p) => str(p, 120)).filter(Boolean))].slice(0, MAX_PACKAGES),
          enabled: raw.enabled === undefined ? true : bool(raw.enabled),
        });
      }
      const alwaysAllow = [...new Set((Array.isArray(src.alwaysAllow) ? src.alwaysAllow : []).map((p) => str(p, 120)).filter(Boolean))].slice(0, MAX_PACKAGES);
      this.focus = { version: 1, blocks, alwaysAllow, updatedAt: Date.now() };
      await this.writeJSON('focus.json', this.focus);
      return { ok: true, focus: this.getFocus() };
    });
  }

  logFocus({ minutes, blockId, label, ended }) {
    return this.run(async () => {
      const m = Math.max(0, Math.min(24 * 60, Math.round(Number(minutes) || 0)));
      if (!m) return { ok: false, error: '时长得大于 0' };
      const rec = {
        id: newId(),
        minutes: m,
        blockId: str(blockId, 40),
        label: str(label, 20),
        ended: ['done', 'giveup'].includes(ended) ? ended : 'done',
        ts: Date.now(),
      };
      this.focusLog.push(rec);
      await this.appendJSONL('focus-log.jsonl', rec);
      return { ok: true, record: rec };
    });
  }

  focusLogRecent(days = 60) {
    const since = Date.now() - days * 86400000;
    return this.focusLog.filter((r) => (r.ts || 0) >= since);
  }

  // ---------- 医嘱图片 ----------

  /**
   * 存一张医嘱/药盒照片。
   * 为什么要留底：处方单是最该留着的东西——过两个月想知道「当时医生开的是
   * 哪一种」，翻相册多半已经找不到了。只留 AI 解析出的文字是不够的，
   * 剂量和医生手写备注经常需要回头看原图。
   */
  saveImage({ mime, data }) {
    return this.run(async () => {
      const ext = IMAGE_EXT[String(mime || '').split(';')[0].trim().toLowerCase()];
      if (!ext) return { ok: false, error: '只支持 JPG / PNG / WebP / GIF' };
      const buf = Buffer.from(String(data || ''), 'base64');
      if (!buf.length) return { ok: false, error: '图片是空的' };
      if (buf.length > IMAGE_MAX_BYTES) return { ok: false, error: `图片太大了（上限 ${Math.round(IMAGE_MAX_BYTES / 1024 / 1024)}MB）` };
      const id = newId();
      const dir = path.join(this.root, 'images');
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, `${id}.${ext}`), buf);
      return { ok: true, image: { id, ext, bytes: buf.length, mime: EXT_IMAGE[ext] } };
    });
  }

  /** 图片的绝对路径（找不到返回 null，别让调用方拿到一个不存在的路径去读） */
  imageFile(id) {
    const safe = str(id, 40).replace(/[^a-f0-9]/g, '');
    if (!safe) return null;
    for (const ext of Object.values(IMAGE_EXT)) {
      const p = path.join(this.root, 'images', `${safe}.${ext}`);
      if (fs.existsSync(p)) return { path: p, mime: EXT_IMAGE[ext] };
    }
    return null;
  }
}
