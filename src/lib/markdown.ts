// =============================================================
// 拾光 · 轻量 Markdown 渲染
// 只支持 AI 回答里真正会用到的那几种语法，先转义再渲染，避免 XSS
// 并把 [YYYY-MM-DD] 日期标注变成可点击的「跳转到那天」
// =============================================================

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 行内元素：粗体、斜体、行内代码、链接、日期引用 */
function inline(s: string): string {
  let t = s;
  // 行内代码先占位，避免内部被继续解析
  const codes: string[] = [];
  t = t.replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push(`<code>${c}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });

  // 日期引用 [2026-09-17] 或 【2026-09-17】 → 可点击
  t = t.replace(/[[【](\d{4}-\d{2}-\d{2})[\]】]/g, (_m, d: string) => {
    return `<span class="cite" data-date="${d}" title="查看这一天的记录">${d.slice(5).replace('-', '/')}</span>`;
  });

  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,，。]|$)/g, '$1<em>$2</em>');

  t = t.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)] || '');
  return t;
}

/**
 * 渲染 Markdown 片段为 HTML
 */
export function renderMarkdown(src: string): string {
  if (!src) return '';
  const lines = escapeHtml(src).split('\n');
  const out: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join('<br>'))}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (!line.trim()) {
      flushPara();
      closeList();
      continue;
    }

    // 分割线
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flushPara();
      closeList();
      out.push('<hr>');
      continue;
    }

    // 标题
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      closeList();
      const lv = Math.min(h[1].length + 1, 4);
      out.push(`<h${lv}>${inline(h[2])}</h${lv}>`);
      continue;
    }

    // 引用
    const quote = /^&gt;\s?(.*)$/.exec(line);
    if (quote) {
      flushPara();
      closeList();
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }

    // 无序列表
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (ul) {
      flushPara();
      if (listType !== 'ul') {
        closeList();
        out.push('<ul>');
        listType = 'ul';
      }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }

    // 有序列表
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ol) {
      flushPara();
      if (listType !== 'ol') {
        closeList();
        out.push('<ol>');
        listType = 'ol';
      }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }

    closeList();
    para.push(line);
  }

  flushPara();
  closeList();
  return out.join('');
}

/** 纯文本预览（去掉 Markdown 记号，用于列表摘要） */
export function plainText(src: string, max = 120): string {
  const t = String(src || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[*_>#]+/g, '')
    .replace(/[[【]\d{4}-\d{2}-\d{2}[\]】]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 高亮关键词（用于检索结果） */
export function highlight(text: string, keywords: string): string {
  const safe = escapeHtml(text);
  const words = keywords
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2)
    .sort((a, b) => b.length - a.length)
    .slice(0, 6);
  if (!words.length) return safe;
  let out = safe;
  for (const w of words) {
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(${esc})`, 'gi'), '<mark>$1</mark>');
  }
  return out;
}
