// =============================================================
// 拾光 · DeepSeek 客户端
// 纯 Node 内置模块实现：Chat Completions + SSE 流式解析 + 工具调用
// 无第三方依赖，避免服务器上装包出错
// =============================================================

const DEFAULT_BASE = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-flash';

export function apiKey() {
  return process.env.DEEPSEEK_API_KEY || '';
}
export function baseUrl() {
  return (process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
}
export function defaultModel() {
  return process.env.DEEPSEEK_MODEL || DEFAULT_MODEL;
}
/** 可选：详细思考程度 low|high|max（不传则用服务端默认） */
function effort() {
  const e = process.env.DEEPSEEK_EFFORT;
  return e === 'low' || e === 'high' || e === 'max' ? e : '';
}

export function aiEnabled() {
  return apiKey().length > 8;
}

/**
 * 发起一次非流式对话
 * @param {{messages:Array, model?:string, temperature?:number, maxTokens?:number, tools?:Array}} opts
 */
export async function chat(opts) {
  const body = {
    model: opts.model || defaultModel(),
    messages: opts.messages,
    stream: false,
  };
  if (opts.temperature != null) body.temperature = opts.temperature;
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  if (opts.tools) body.tools = opts.tools;
  if (opts.json) body.response_format = { type: 'json_object' };
  if (effort()) body.reasoning_effort = effort();

  const res = await fetch(`${baseUrl()}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey()}`,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`DeepSeek ${res.status}: ${t.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * 流式对话：逐步回调增量文本
 * @param {{messages:Array, model?:string, onDelta:(s:string)=>void, onReasoning?:(s:string)=>void, signal?:AbortSignal}} opts
 * @returns {Promise<{content:string, reasoning:string, usage:any}>}
 */
export async function chatStream(opts) {
  const body = {
    model: opts.model || defaultModel(),
    messages: opts.messages,
    stream: true,
  };
  if (opts.temperature != null) body.temperature = opts.temperature;
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  if (effort()) body.reasoning_effort = effort();

  const res = await fetch(`${baseUrl()}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey()}`,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`DeepSeek ${res.status}: ${t.slice(0, 300)}`);
  }

  let content = '';
  let reasoning = '';
  let usage = null;
  let buf = '';

  for await (const chunk of res.body) {
    buf += Buffer.from(chunk).toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line || !line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      if (json.usage) usage = json.usage;
      const delta = json.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.reasoning_content) {
        reasoning += delta.reasoning_content;
        opts.onReasoning?.(delta.reasoning_content);
      }
      if (delta.content) {
        content += delta.content;
        opts.onDelta?.(delta.content);
      }
    }
  }
  return { content, reasoning, usage };
}
