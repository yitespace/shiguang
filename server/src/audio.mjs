// =============================================================
// 拾光 · 语音附件存储
// 录音文件放在 data/audio/YYYY-MM/<id>.<ext>，元数据单独记一份 JSONL
// 元数据里只存相对路径，不存 base64，避免把记录文件撑大
// =============================================================

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/** 单个录音上限：8MB（大约 15 分钟 opus） */
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
/** 录音时长上限：5 分钟（前端也会卡，这里是兜底） */
export const MAX_AUDIO_MS = 5 * 60 * 1000;

const MIME_EXT = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/aac': 'aac',
  'audio/3gpp': '3gp',
};

const EXT_MIME = {
  webm: 'audio/webm',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  aac: 'audio/aac',
  '3gp': 'audio/3gpp',
};

/** 允许的扩展名，防止路径穿越 */
const SAFE_EXT = new Set(Object.keys(EXT_MIME));

export function extForMime(mime) {
  const base = String(mime || '').split(';')[0].trim().toLowerCase();
  return MIME_EXT[base] || 'webm';
}

export function mimeForExt(ext) {
  return EXT_MIME[String(ext).replace(/^\./, '').toLowerCase()] || 'application/octet-stream';
}

/**
 * 大致估算时长。
 * 浏览器的 MediaRecorder 不告诉我们时长，但 opus/aac 码率稳定，
 * 按体积估算误差很小（前端拿到真实时长后会覆盖这个值）。
 */
export function estimateDurationMs(bytes, ext) {
  const bps = ext === 'wav' ? 256000 / 8 : 32000 / 8; // wav 未压缩，其余按 32kbps
  return Math.round((bytes / bps) * 1000);
}

export class AudioStore {
  /** @param {string} dataRoot 数据根目录（与 notes 同级） */
  constructor(dataRoot) {
    this.root = path.join(dataRoot, 'audio');
    /** @type {Map<string, any>} id -> 元数据 */
    this.meta = new Map();
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await fsp.mkdir(this.root, { recursive: true });
    await this.loadMeta();
    return this;
  }

  async loadMeta() {
    const dir = this.root;
    let months = [];
    try {
      months = (await fsp.readdir(dir)).filter((f) => /^\d{4}-\d{2}$/.test(f));
    } catch {
      return;
    }
    for (const m of months) {
      const file = path.join(dir, m, 'index.jsonl');
      let raw = '';
      try {
        raw = await fsp.readFile(file, 'utf8');
      } catch {
        continue;
      }
      for (const line of raw.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        try {
          const rec = JSON.parse(s);
          if (rec?.id) this.meta.set(rec.id, rec);
        } catch {
          /* 忽略坏行 */
        }
      }
    }
  }

  monthDir(ts = Date.now()) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}`;
  }

  /**
   * 保存一段录音
   * @param {Buffer} buf 音频数据
   * @param {{mime?:string, durationMs?:number, transcript?:string, ext?:string}} opts
   */
  async save(buf, opts = {}) {
    if (!buf?.length) throw new Error('音频内容为空');
    if (buf.length > MAX_AUDIO_BYTES) {
      throw new Error(`录音太大（${(buf.length / 1024 / 1024).toFixed(1)}MB），请控制在 ${MAX_AUDIO_BYTES / 1024 / 1024}MB 以内`);
    }
    const id = crypto.randomUUID();
    const ext = SAFE_EXT.has(opts.ext) ? opts.ext : extForMime(opts.mime);
    const month = this.monthDir();
    const dir = path.join(this.root, month);
    await fsp.mkdir(dir, { recursive: true });

    const fileName = `${id}.${ext}`;
    await fsp.writeFile(path.join(dir, fileName), buf);

    const rec = {
      id,
      // 相对路径：换机器/改数据目录都不用改数据
      rel: path.posix.join(month, fileName),
      ext,
      mime: mimeForExt(ext),
      bytes: buf.length,
      durationMs: Number(opts.durationMs) || estimateDurationMs(buf.length, ext),
      transcript: String(opts.transcript || ''),
      at: Date.now(),
    };
    this.meta.set(id, rec);
    this.writeQueue = this.writeQueue.then(() =>
      fsp.appendFile(path.join(dir, 'index.jsonl'), JSON.stringify(rec) + '\n', 'utf8').catch(() => {}),
    );
    return rec;
  }

  get(id) {
    if (!id || !/^[\w-]+$/.test(id)) return null;
    return this.meta.get(id) || null;
  }

  /** 绝对路径（已校验，不会跳出数据目录） */
  absPath(rec) {
    if (!rec?.rel) return null;
    const full = path.join(this.root, rec.rel);
    if (!full.startsWith(this.root)) return null;
    return full;
  }

  exists(rec) {
    const p = this.absPath(rec);
    return !!p && fs.existsSync(p);
  }

  async remove(id) {
    const rec = this.get(id);
    if (!rec) return false;
    const p = this.absPath(rec);
    if (p) await fsp.rm(p, { force: true }).catch(() => {});
    this.meta.delete(id);
    return true;
  }

  /** 把元数据挂到记录上，供前端直接渲染 */
  publicMeta(rec) {
    if (!rec) return null;
    return {
      id: rec.id,
      url: `api/audio/${rec.id}`,
      mime: rec.mime,
      bytes: rec.bytes,
      durationMs: rec.durationMs,
      transcript: rec.transcript || '',
    };
  }

  /** 统计：总条数、总字节 */
  stats() {
    let bytes = 0;
    for (const r of this.meta.values()) bytes += r.bytes || 0;
    return { count: this.meta.size, bytes };
  }

  async flush() {
    await this.writeQueue;
  }
}

/**
 * 解析 HTTP Range 头，用于音频拖动播放
 * @returns {{start:number,end:number}|null}
 */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /bytes=(\d*)-(\d*)/.exec(String(header));
  if (!m) return null;
  let start = m[1] === '' ? null : Number(m[1]);
  let end = m[2] === '' ? null : Number(m[2]);
  if (start === null && end === null) return null;
  if (start === null) {
    // bytes=-N 表示最后 N 字节
    start = Math.max(0, size - end);
    end = size - 1;
  } else if (end === null || end >= size) {
    end = size - 1;
  }
  if (start > end || start >= size) return null;
  return { start, end };
}
