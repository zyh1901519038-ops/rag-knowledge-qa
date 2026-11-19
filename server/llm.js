/**
 * llm.js —— OpenAI 兼容的聊天接口（流式）+ 离线兜底
 *
 * 没有 LLM_API_KEY 时不报错，而是走「离线兜底」：直接把检索到的片段拼成回答。
 * 这样整套链路（上传 → 分块 → 检索 → 流式输出）在没有 key 的情况下也能跑通，
 * 便于演示和自测，生产环境应换成真实 embedding 模型。
 */
const API_KEY = process.env.LLM_API_KEY;
const BASE_URL = (process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/$/, '');
const MODEL = process.env.LLM_MODEL || 'deepseek-chat';

export const llmMode = () => (API_KEY ? 'api' : 'offline');

/**
 * 流式生成：每次产出一段文本
 * @param {string} prompt
 * @returns {AsyncGenerator<string>}
 */
export async function* streamAnswer(prompt) {
  if (!API_KEY) {
    yield* offlineAnswer(prompt);
    return;
  }

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL, stream: true, temperature: 0.2, messages: [{ role: 'user', content: prompt }] }),
  });

  if (!res.ok || !res.body) {
    throw new Error(`LLM 接口 ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    // SSE 按行解析，一次读到的可能包含多个 data: 帧
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        /* 忽略不完整帧 */
      }
    }
  }
}

/** 离线兜底：把 prompt 里的参考资料摘要一下，证明链路是通的 */
async function* offlineAnswer(prompt) {
  const m = prompt.match(/参考资料：\n([\s\S]*?)\n\n问题：/);
  const ctx = m ? m[1] : '';
  const first = ctx.split('\n\n')[0] || '(无检索结果)';
  const text =
    '【离线模式，未调用真实模型】\n' +
    '本次检索到的第一条资料是：\n' +
    first.slice(0, 300) +
    '\n\n配置 LLM_API_KEY 后即可获得模型生成的回答。';
  for (const ch of text.match(/[\s\S]{1,12}/g) || []) {
    yield ch;
    await new Promise((r) => setTimeout(r, 15)); // 模拟流式节奏
  }
}
