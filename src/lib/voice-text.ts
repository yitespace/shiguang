// =============================================================
// 拾光 · 语音文本的本地清理
// AI 不可用时（没配 Key / 网络不通）至少把明显的口语噪音去掉，
// 让用户看到的东西是可读的
// =============================================================

/** 常见的口语填充词 */
const FILLERS = [
  '嗯', '呃', '额', '啊', '哦', '唉', '诶', '哎呀', '哎',
  '那个', '这个', '就是', '然后呢', '然后', '反正', '其实吧', '就是说',
  '你知道吧', '怎么说呢', '有点', '稍微',
];

/**
 * 轻量清理：去掉重复的语气词、合并重复标点、补句号
 * 只做「减法」，绝不添加内容
 */
export function simpleClean(input: string): string {
  let t = String(input || '').trim();
  if (!t) return '';

  // 语音识别常见的重复： 「然后然后」「我我」
  t = t.replace(/([\u4e00-\u9fa5]{1,2})\1{1,}/g, '$1');

  // 去掉填充词（只去掉独立出现的，不动词内的字）
  for (const f of FILLERS) {
    const re = new RegExp(`(^|[，。！？、\\s])${f}(?=[，。！？、\\s]|$)`, 'g');
    t = t.replace(re, '$1');
  }

  // 合并重复标点
  t = t.replace(/[，,]{2,}/g, '，').replace(/[。.]{2,}/g, '。').replace(/[！!]{2,}/g, '！');
  // 去掉行首行尾的孤立标点
  t = t.replace(/^[，。、！？\s]+/, '').replace(/[，、\s]+$/, '');

  // 太长的句子按逗号断一下（超过 40 字且没有句号）
  t = t
    .split(/(?<=[。！？])/)
    .map((x) => x.trim())
    .filter(Boolean)
    .join('');

  if (t && !/[。！？…]$/.test(t)) t += '。';
  // 全角化逗号
  t = t.replace(/,/g, '，');
  return t;
}

/** 简单拆要点：按句号/问号断句，取前几句（AI 不可用时的兜底） */
export function fallbackPoints(text: string, max = 3): string[] {
  return String(text || '')
    .split(/[。！？!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4)
    .slice(0, max)
    .map((s) => (s.length > 22 ? `${s.slice(0, 22)}…` : s));
}
