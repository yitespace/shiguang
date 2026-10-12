// =============================================================
// 拾光 · 音频 HTTP 处理
// 单独放一个文件，避免 index.mjs 太臃肿
// =============================================================

import fs from 'node:fs';
import { MAX_AUDIO_BYTES, parseRange } from './audio.mjs';

/** 把 base64 解成 Buffer，并做大小校验 */
export function decodeAudio(base64, limit = MAX_AUDIO_BYTES) {
  let s = String(base64 || '').trim();
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(s);
  let mime = '';
  if (m) {
    mime = m[1];
    s = m[2];
  }
  s = s.replace(/\s+/g, '');
  if (!s) throw new Error('音频内容为空');
  // base64 大约膨胀 4/3，先按编码长度拦一道，避免解出超大内存
  if (s.length > Math.ceil((limit * 4) / 3) + 1024) {
    throw new Error(`录音太大，请控制在 ${Math.round(limit / 1024 / 1024)}MB 以内`);
  }
  const buf = Buffer.from(s, 'base64');
  if (!buf.length) throw new Error('音频解码失败');
  if (buf.length > limit) {
    throw new Error(`录音太大（${(buf.length / 1024 / 1024).toFixed(1)}MB）`);
  }
  return { buf, mime };
}

/**
 * 支持 Range 的音频响应（拖动进度条必需）
 */
export function sendAudio(req, res, rec, absPath, mimeForExt, extraHeaders = {}) {
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: false, error: '录音文件不存在' }));
  }

  const type = rec.mime || mimeForExt(rec.ext);
  const range = parseRange(req.headers.range, stat.size);

  if (range) {
    const { start, end } = range;
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=31536000, immutable',
      ...extraHeaders,
    });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(absPath, { start, end }).pipe(res);
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=31536000, immutable',
    ...extraHeaders,
  });
  if (req.method === 'HEAD') return res.end();
  return fs.createReadStream(absPath).pipe(res);
}
