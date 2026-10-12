// =============================================================
// 拾光 · 中文分词与检索
// 中文没有空格，按「单字 + 相邻双字（bigram）」切分，
// 既保证召回（单字兜底），又保证精度（双字短语）
// =============================================================

const STOP = new Set([
  '的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '一', '上', '也',
  '很', '到', '说', '要', '去', '你', '会', '着', '没', '看', '好', '自己', '这',
  '那', '吗', '呢', '把', '被', '给', '让', '从', '对', '与', '及', '或', '而', '之',
  'the', 'a', 'an', 'of', 'to', 'in', 'is', 'are', 'was', 'and', 'or', 'for',
]);

/** 判断是否为中日韩表意文字 */
function isCJK(ch) {
  const c = ch.codePointAt(0);
  return (
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0xf900 && c <= 0xfaff)
  );
}

/**
 * 把一段文本切成检索词
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  if (!text) return [];
  const s = String(text).toLowerCase();
  const out = [];
  let ascii = '';

  const flushAscii = () => {
    if (ascii.length >= 1) {
      if (ascii.length >= 2 && !STOP.has(ascii)) out.push(ascii);
      else if (ascii.length === 1 && /[0-9]/.test(ascii)) out.push(ascii);
    }
    ascii = '';
  };

  const chars = Array.from(s);
  let prevCJK = '';
  for (const ch of chars) {
    if (isCJK(ch)) {
      flushAscii();
      if (!STOP.has(ch)) out.push(ch);
      if (prevCJK) {
        const bi = prevCJK + ch;
        if (!STOP.has(bi)) out.push(bi);
      }
      prevCJK = ch;
    } else if (/[a-z0-9_]/.test(ch)) {
      ascii += ch;
      prevCJK = '';
    } else {
      flushAscii();
      prevCJK = '';
    }
  }
  flushAscii();
  return out;
}

/**
 * 把查询拆成「词组」，用于高亮与短语匹配
 * 例："沈警官 rpa" -> ["沈警官", "rpa"]
 */
export function queryPhrases(q) {
  return String(q || '')
    .split(/[\s,，、;；/|]+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 1)
    .slice(0, 8);
}

/**
 * 给一条记录算相关性得分
 * @param {{text:string, tokens:Set<string>}} doc 预处理的文档
 * @param {string[]} qTokens 查询词
 * @param {string[]} phrases 原始短语（用于加权）
 */
export function scoreDoc(doc, qTokens, phrases) {
  if (!qTokens.length && !phrases.length) return 0;
  let score = 0;
  const text = doc.text;
  for (const t of qTokens) {
    if (doc.tokens.has(t)) score += t.length > 1 ? 3 : 1;
  }
  for (const p of phrases) {
    if (p.length >= 2 && text.includes(p.toLowerCase())) score += 8;
  }
  if (score === 0) return 0;
  // 长度归一：短记录里命中更值钱
  return score / Math.sqrt(1 + text.length / 120);
}

/** 生成命中片段，用于结果预览 */
export function snippet(text, phrases, len = 90) {
  const src = String(text || '').replace(/\s+/g, ' ').trim();
  if (!src) return '';
  const lower = src.toLowerCase();
  let at = -1;
  for (const p of phrases) {
    const i = lower.indexOf(p.toLowerCase());
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return src.slice(0, len) + (src.length > len ? '…' : '');
  const start = Math.max(0, at - Math.floor(len / 3));
  const end = Math.min(src.length, start + len);
  return (start > 0 ? '…' : '') + src.slice(start, end) + (end < src.length ? '…' : '');
}
