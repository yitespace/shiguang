// =============================================================
// 拾光 · 语音转文字
// 多通道适配器，按顺序尝试，任何一家通了就用：
//   1) 阿里云百炼 DashScope（qwen3-asr-flash，注册送额度，推荐）
//   2) 硅基流动（Qwen3-ASR 快 / SenseVoiceSmall 兜底）
//   3) 任意 OpenAI 兼容的 /audio/transcriptions
//
// 相关环境变量（都在 /etc/shiguang.env）：
//   ASR_PROVIDER=auto | dashscope | siliconflow | openai
//   DASHSCOPE_API_KEY / SILICONFLOW_API_KEY / ASR_API_KEY
//   ASR_MODEL（整体覆盖模型名）
// =============================================================

const SILICONFLOW_BASE = 'https://api.siliconflow.cn/v1';
/**
 * 百炼的服务地址。
 *  - 通用：https://dashscope.aliyuncs.com
 *  - 业务空间专属（sk-ws- 开头的 Key 必须用专属域名，见控制台「API Key」页）
 * 原生接口路径 /api/v1/services/... 会拼在它后面。
 */
const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com';

/**
 * 硅基流动默认模型顺序（实测 15 秒中文语音）：
 *   Qwen/Qwen3-ASR-1.7B         0.6s   标点更好  ← 首选
 *   FunAudioLLM/SenseVoiceSmall 14~42s 兜底
 */
const SILICONFLOW_MODELS = ['Qwen/Qwen3-ASR-1.7B', 'FunAudioLLM/SenseVoiceSmall'];
/** 百炼默认模型：qwen3-asr-flash 有免费额度 */
const DASHSCOPE_MODELS = ['qwen3-asr-flash'];

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

/** 解析出当前生效的转写通道（按顺序） */
export function asrConfig() {
  const provider = (process.env.ASR_PROVIDER || 'auto').toLowerCase();
  const forceModel = process.env.ASR_MODEL || '';

  const dsKey = process.env.DASHSCOPE_API_KEY || '';
  const sfKey = process.env.SILICONFLOW_API_KEY || '';
  const oaKey = process.env.ASR_API_KEY || process.env.OPENAI_API_KEY || '';

  const dashscope = {
    name: 'dashscope',
    label: '阿里云百炼',
    kind: 'dashscope',
    key: dsKey,
    base: (process.env.DASHSCOPE_BASE_URL || DASHSCOPE_BASE).replace(/\/+$/, '').replace(/\/compatible-mode\/v1$/, ''),
    models: forceModel ? [forceModel] : DASHSCOPE_MODELS,
    ready: dsKey.length > 8,
  };

  const siliconflow = {
    name: 'siliconflow',
    label: '硅基流动',
    kind: 'openai',
    key: sfKey,
    base: (process.env.SILICONFLOW_BASE_URL || SILICONFLOW_BASE).replace(/\/+$/, ''),
    models: forceModel ? [forceModel] : SILICONFLOW_MODELS,
    ready: sfKey.length > 8,
  };

  const openai = {
    name: 'openai',
    label: 'OpenAI 兼容接口',
    kind: 'openai',
    key: oaKey,
    base: (process.env.ASR_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    models: [forceModel || 'whisper-1'],
    ready: oaKey.length > 8,
  };

  const all = { dashscope, siliconflow, openai };
  if (all[provider]) return all[provider].ready ? [all[provider]] : [];
  // auto：百炼优先（免费额度大），其次硅基流动，最后泛用通道
  return [dashscope, siliconflow, openai].filter((p) => p.ready);
}

export function asrEnabled() {
  return asrConfig().length > 0;
}

export function asrInfo() {
  const list = asrConfig();
  const cur = list[0];
  return {
    enabled: list.length > 0,
    provider: cur?.name || null,
    label: cur?.label || null,
    model: cur?.models?.[0] || null,
    fallbacks: list.slice(1).map((p) => `${p.label}/${p.models[0]}`),
  };
}

// ---------------------------------------------------------------
// 各家实现
// ---------------------------------------------------------------

/** 硅基流动 / OpenAI 系：multipart 上传 */
async function tryOpenAICompatible(p, model, buf, { ext, mime, language, prompt, signal }) {
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime }), `audio.${ext}`);
  form.append('model', model);
  form.append('language', language || 'zh');
  if (prompt) form.append('prompt', prompt);

  const res = await fetch(`${p.base}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${p.key}` },
    body: form,
    signal,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`${p.label}/${model} ${res.status}: ${t.slice(0, 160)}`);
  }
  const json = await res.json();
  const text = String(json.text || json.result || '').trim();
  if (!text) throw new Error(`${p.label}/${model} 返回了空文本`);
  return { text, raw: json };
}

/**
 * 阿里云百炼：走官方原生接口。
 *
 * 为什么不用 OpenAI 兼容模式：实测兼容模式的 input_audio 会被拒
 * （InternalError.Algo.InvalidParameter: dedicated task `asr` does not support this input），
 * 必须用 /api/v1/services/aigc/multimodal-generation/generation。
 *
 * 额外的收获：这个接口会顺带返回 emotion（情绪）和 language（语种），
 * 情绪可以直接拿来预填「此刻心情」。
 */
async function tryDashscope(p, model, buf, { ext, mime, signal }) {
  const type = mime || EXT_MIME[ext] || 'audio/webm';
  const dataUrl = `data:${type};base64,${buf.toString('base64')}`;

  const body = {
    model,
    input: {
      messages: [
        {
          role: 'user',
          content: [{ audio: dataUrl }],
        },
      ],
    },
    parameters: {},
  };

  const url = `${p.base}/api/v1/services/aigc/multimodal-generation/generation`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${p.key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`${p.label}/${model} ${res.status}: ${t.slice(0, 200)}`);
  }
  const json = await res.json();
  const msg = json.output?.choices?.[0]?.message;
  const text = String(msg?.content?.[0]?.text || '').trim();
  if (!text) throw new Error(`${p.label}/${model} 返回了空文本`);

  const ann = Array.isArray(msg?.annotations) ? msg.annotations[0] : null;
  return {
    text,
    emotion: ann?.emotion || null,
    language: ann?.language || null,
    raw: json,
  };
}

/**
 * 转写一段音频
 * @param {Buffer} buf 音频数据
 * @param {{ext?:string, mime?:string, language?:string, signal?:AbortSignal, prompt?:string}} opts
 * @returns {Promise<{text:string, provider:string, model:string, elapsedMs:number, emotion?:string|null, language?:string|null, raw:any}>}
 */
export async function transcribe(buf, opts = {}) {
  const list = asrConfig();
  if (!list.length) {
    const err = new Error('服务端没有配置语音转写通道（需要 DASHSCOPE_API_KEY 或 SILICONFLOW_API_KEY）');
    err.kind = 'unconfigured';
    err.hint = '在服务器 /etc/shiguang.env 里加一个语音识别服务的 Key，然后重启服务。';
    throw err;
  }

  const ext = (opts.ext || 'webm').replace(/^\./, '');
  const mime = opts.mime || EXT_MIME[ext] || 'audio/webm';
  const errors = [];

  for (const p of list) {
    for (const model of p.models || []) {
      const t0 = Date.now();
      try {
        const out =
          p.kind === 'dashscope'
            ? await tryDashscope(p, model, buf, { ext, mime, signal: opts.signal })
            : await tryOpenAICompatible(p, model, buf, {
                ext,
                mime,
                language: opts.language,
                prompt: opts.prompt,
                signal: opts.signal,
              });
        return {
          text: out.text,
          provider: p.name,
          model,
          elapsedMs: Date.now() - t0,
          emotion: out.emotion || null,
          language: out.language || null,
          raw: out.raw,
        };
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        errors.push(String(e?.message || e));
        // 换下一个模型/通道继续试
      }
    }
  }

  const detail = errors.join('；');
  const cls = classifyAsrError(detail);
  const err = new Error(`语音转写失败：${detail}`);
  err.kind = cls.kind;
  err.hint = cls.hint;
  throw err;
}

// ---------------------------------------------------------------
// 错误翻译：让用户知道该做什么
// ---------------------------------------------------------------
export function classifyAsrError(message) {
  const m = String(message || '');
  if (/30001|balance is insufficient|insufficient.*balance|余额不足|欠费|Arrearage/i.test(m)) {
    return {
      kind: 'balance',
      hint:
        '语音识别服务的账户余额不足。可以改用阿里云百炼的 qwen3-asr-flash（语音识别有免费额度），' +
        '或给现在这家充值后点「重试识别」。',
    };
  }
  if (/401|invalid.*(token|api.?key)|Unauthorized|令牌.*无效|鉴权失败|InvalidApiKey/i.test(m)) {
    return { kind: 'auth', hint: '语音服务的 API Key 无效，请到服务器 /etc/shiguang.env 里换一个再重启。' };
  }
  if (/429|rate.?limit|too many requests|请求过于频繁|Throttling/i.test(m)) {
    return { kind: 'rate', hint: '请求太频繁了，等几秒点「重试识别」。' };
  }
  if (/402|quota|exceeded|超出.*额度|free.*tier/i.test(m)) {
    return { kind: 'quota', hint: '免费额度用完了，去服务商控制台看看用量或充值。' };
  }
  if (/unsupported|format|decode|音频|audio.*invalid/i.test(m)) {
    return { kind: 'format', hint: '这段音频格式服务商不认，可以先手动输入文字，录音一样会保存。' };
  }
  return { kind: 'unknown', hint: '' };
}
