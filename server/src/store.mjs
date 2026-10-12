// =============================================================
// 拾光 · 存储层
// 追加式 JSONL（每天一个文件，天然是备份，损坏也只影响一天）
//   data/notes/2026-09.jsonl   每行一条记录版本，同 id 后写的生效
//   data/meta.json             元信息（密码哈希 / 会话密钥）
// =============================================================

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { tokenize, queryPhrases, scoreDoc, snippet } from './text.mjs';

export class Store {
  /** @param {string} root 数据目录 */
  constructor(root) {
    this.root = root;
    /** @type {Map<string, any>} id -> 最新版本 */
    this.entries = new Map();
    /** @type {any} 音频存储（可选注入） */
    this.audio = null;
    /** @type {Map<string, {text:string, tokens:Set<string>}>} 检索缓存 */
    this.index = new Map();
    this.meta = { version: 1, password: null, sessionSecret: crypto.randomBytes(32).toString('hex') };
    this.dirty = new Set(); // 需要重写的月份文件
    this.writeQueue = Promise.resolve();
    this.compactPending = 0;
  }

  // ---------- 启动 ----------
  async init() {
    await fsp.mkdir(path.join(this.root, 'notes'), { recursive: true });
    await this.loadMeta();
    await this.loadNotes();
    // 定期把内存中的最新版本落盘（合并被覆盖的历史行）
    setInterval(() => this.flush().catch(() => {}), 5000);
    return this;
  }

  async loadMeta() {
    try {
      const raw = await fsp.readFile(path.join(this.root, 'meta.json'), 'utf8');
      const parsed = JSON.parse(raw);
      this.meta = { ...this.meta, ...parsed };
    } catch {
      // 首次启动：生成并写入
      await this.writeJSON('meta.json', this.meta);
    }
    if (!this.meta.sessionSecret) {
      this.meta.sessionSecret = crypto.randomBytes(32).toString('hex');
      await this.writeJSON('meta.json', this.meta);
    }
  }

  async loadNotes() {
    const dir = path.join(this.root, 'notes');
    let files = [];
    try {
      files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort();
    } catch {
      return;
    }
    for (const f of files) {
      const full = path.join(dir, f);
      let raw = '';
      try {
        raw = await fsp.readFile(full, 'utf8');
      } catch {
        continue;
      }
      for (const line of raw.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        try {
          const e = JSON.parse(s);
          if (e && e.id) this.entries.set(e.id, e);
        } catch {
          // 忽略坏行，其余数据照常可用
        }
      }
    }
    this.reindexAll();
  }

  // ---------- 索引 ----------
  /**
   * 检索用的文档文本。
   * 除了正文，还带上语音附件里的「要点」和「原始转写」，
   * 这样语音记的内容也能被搜到（口语转写和整理后的正文用词可能不同）。
   */
  docText(e) {
    const parts = [e.title || '', e.content || '', (e.tags || []).join(' ')];
    for (const a of e.attachments || []) {
      if (Array.isArray(a.points) && a.points.length) parts.push(a.points.join(' '));
      const tr = this.audio?.get?.(a.id)?.transcript;
      if (tr && tr !== e.content) parts.push(tr);
    }
    return parts.filter(Boolean).join('\n');
  }

  /** 注入音频存储（用于把转写文本纳入检索），注入后重建索引 */
  attachAudio(audioStore) {
    this.audio = audioStore;
    this.reindexAll();
  }

  reindexAll() {
    this.index.clear();
    for (const e of this.entries.values()) {
      const text = this.docText(e);
      this.index.set(e.id, { text: text.toLowerCase(), tokens: new Set(tokenize(text)) });
    }
  }

  indexOne(e) {
    const text = this.docText(e);
    this.index.set(e.id, { text: text.toLowerCase(), tokens: new Set(tokenize(text)) });
  }

  // ---------- 查询 ----------
  /** 所有未删除记录，按时间倒序 */
  active() {
    const out = [];
    for (const e of this.entries.values()) if (!e.deleted) out.push(e);
    out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return out;
  }

  get(id) {
    return this.entries.get(id) || null;
  }

  /** 按日期区间取（含端点，YYYY-MM-DD） */
  range(from, to, limit = 500) {
    const lo = from ? Date.parse(from + 'T00:00:00') : -Infinity;
    const hi = to ? Date.parse(to + 'T23:59:59.999') : Infinity;
    const out = [];
    for (const e of this.entries.values()) {
      if (e.deleted) continue;
      const t = e.createdAt || 0;
      if (t >= lo && t <= hi) out.push(e);
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    return out.slice(0, limit);
  }

  /** 某一天（按本地日期字段，比时间戳更可靠） */
  byDate(date) {
    const out = [];
    for (const e of this.entries.values()) {
      if (!e.deleted && e.date === date) out.push(e);
    }
    out.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    return out;
  }

  /** 全文检索 */
  search(q, { limit = 40, from, to } = {}) {
    const phrases = queryPhrases(q);
    const qTokens = [...new Set(tokenize(q))];
    if (!qTokens.length && !phrases.length) return [];
    const lo = from ? Date.parse(from + 'T00:00:00') : -Infinity;
    const hi = to ? Date.parse(to + 'T23:59:59.999') : Infinity;

    const hits = [];
    for (const e of this.entries.values()) {
      if (e.deleted) continue;
      const t = e.createdAt || 0;
      if (t < lo || t > hi) continue;
      const doc = this.index.get(e.id);
      if (!doc) continue;
      const score = scoreDoc(doc, qTokens, phrases);
      if (score <= 0) continue;
      hits.push({ entry: e, score: Math.round(score * 100) / 100, snippet: snippet(this.docText(e), phrases) });
    }
    hits.sort((a, b) => b.score - a.score || (b.entry.createdAt || 0) - (a.entry.createdAt || 0));
    return hits.slice(0, limit);
  }

  /** 标签统计 */
  tags() {
    const m = new Map();
    for (const e of this.entries.values()) {
      if (e.deleted) continue;
      for (const t of e.tags || []) m.set(t, (m.get(t) || 0) + 1);
    }
    return [...m.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }

  /** 汇总统计 */
  stats() {
    const list = this.active();
    const byDay = new Map();
    const byTag = new Map();
    let chars = 0;
    for (const e of list) {
      byDay.set(e.date, (byDay.get(e.date) || 0) + 1);
      chars += (e.content || '').length;
      for (const t of e.tags || []) byTag.set(t, (byTag.get(t) || 0) + 1);
    }
    const days = [...byDay.keys()].sort();
    // 连续记录天数（以今天或昨天为起点）
    let streak = 0;
    const has = (d) => byDay.has(d);
    const today = new Date();
    const fmt = (dt) => {
      const p = (n) => String(n).padStart(2, '0');
      return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
    };
    let cursor = new Date(today);
    if (!has(fmt(cursor))) cursor.setDate(cursor.getDate() - 1);
    while (has(fmt(cursor))) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    }
    return {
      total: list.length,
      days: days.length,
      chars,
      streak,
      firstDate: days[0] || null,
      lastDate: days[days.length - 1] || null,
      heat: days.map((d) => ({ date: d, count: byDay.get(d) })),
      tags: [...byTag.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 24),
    };
  }

  // ---------- 写入 ----------
  /**
   * 新增或更新一条记录
   * @param {object} patch
   */
  async put(patch) {
    const now = Date.now();
    let e = patch.id ? this.entries.get(patch.id) : null;
    const isNew = !e;
    if (isNew) {
      const id = patch.id || crypto.randomUUID();
      const at = patch.createdAt || now;
      e = {
        id,
        createdAt: at,
        updatedAt: now,
        date: patch.date || toDateStr(new Date(at)),
        mood: patch.mood ?? null,
        tags: patch.tags || [],
        title: patch.title || '',
        content: patch.content || '',
        kind: patch.kind || 'note',
        attachments: patch.attachments || [],
        deleted: false,
      };
    } else {
      e = { ...e };
      if (patch.content !== undefined) e.content = patch.content;
      if (patch.title !== undefined) e.title = patch.title;
      if (patch.tags !== undefined) e.tags = patch.tags;
      if (patch.mood !== undefined) e.mood = patch.mood;
      if (patch.kind !== undefined) e.kind = patch.kind;
      if (patch.date !== undefined) e.date = patch.date;
      if (patch.createdAt !== undefined) e.createdAt = patch.createdAt;
      if (patch.attachments !== undefined) e.attachments = patch.attachments;
      if (patch.deleted !== undefined) e.deleted = !!patch.deleted;
      e.updatedAt = now;
    }
    this.entries.set(e.id, e);
    this.indexOne(e);
    await this.append(e);
    return e;
  }

  async remove(id) {
    const e = this.entries.get(id);
    if (!e) return false;
    const next = { ...e, deleted: true, updatedAt: Date.now() };
    this.entries.set(id, next);
    this.indexOne(next);
    await this.append(next);
    return true;
  }

  /** 批量导入（用于前端离线队列补传） */
  async bulk(items) {
    const out = [];
    for (const it of items.slice(0, 500)) {
      out.push(await this.put(it));
    }
    return out;
  }

  // ---------- 持久化 ----------
  monthFile(e) {
    const d = new Date(e.createdAt || Date.now());
    const p = (n) => String(n).padStart(2, '0');
    return path.join(this.root, 'notes', `${d.getFullYear()}-${p(d.getMonth() + 1)}.jsonl`);
  }

  /** 串行化写入，避免并发追加交错 */
  append(e) {
    this.writeQueue = this.writeQueue.then(async () => {
      const file = this.monthFile(e);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.appendFile(file, JSON.stringify(e) + '\n', 'utf8');
      this.compactPending++;
      if (this.compactPending >= 300) await this.compact();
    });
    return this.writeQueue;
  }

  /** 重写每个月份文件，只保留当前生效版本（历史版本另有备份） */
  async compact() {
    this.compactPending = 0;
    const byFile = new Map();
    for (const e of this.entries.values()) {
      const f = this.monthFile(e);
      if (!byFile.has(f)) byFile.set(f, []);
      byFile.get(f).push(e);
    }
    for (const [file, list] of byFile) {
      list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      const body = list.map((e) => JSON.stringify(e)).join('\n') + '\n';
      await this.writeAtomic(file, body);
    }
  }

  async writeAtomic(file, body) {
    const tmp = `${file}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, body, 'utf8');
    await fsp.rename(tmp, file);
  }

  async writeJSON(name, obj) {
    await this.writeAtomic(path.join(this.root, name), JSON.stringify(obj, null, 2));
  }

  async flush() {
    if (this.compactPending > 0) await this.compact();
  }

  // ---------- 每日总结缓存 ----------
  async getSummary(date) {
    try {
      const raw = await fsp.readFile(path.join(this.root, `summary-${date}.json`), 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async putSummary(summary) {
    await this.writeJSON(`summary-${summary.date}.json`, summary);
    return summary;
  }
}

export function toDateStr(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
