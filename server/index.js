/**
 * index.js —— HTTP 服务（零依赖，只用 node:http）
 *
 * 路由：
 *   GET  /api/health              健康检查（返回向量化 / 模型模式）
 *   GET  /api/docs                文档列表
 *   POST /api/upload  {name,text} 入库：分块 → 向量化 → 存储
 *   POST /api/ask     {question,sessionId}   非流式回答（返回答案 + 引用）
 *   GET  /api/ask/stream?question=..&sessionId=..   SSE 流式回答
 *   GET  /api/messages?sessionId=..  历史消息
 *
 * 启动：node index.js    （默认 8787 端口）
 */
import http from 'node:http';
import { URL } from 'node:url';
import {
  addMessage, buildPrompt, ingest, getDocs, getMessages, retrieve, loadDb, embedMode,
} from './rag.js';
import { llmMode, streamAnswer } from './llm.js';

const PORT = Number(process.env.PORT || 8787);
const MAX_BODY = 2 * 1024 * 1024; // 2MB 上限，防大文件把内存打爆

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

const send = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
  res.end(body);
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大（>2MB）'));
        req.destroy();
        return;
      }
      parts.push(c);
    });
    req.on('end', () => {
      try {
        resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {});
      } catch (e) {
        reject(new Error('JSON 解析失败：' + e.message));
      }
    });
    req.on('error', reject);
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  try {
    // ---------- 健康检查 ----------
    if (path === '/api/health') {
      return send(res, 200, {
        ok: true,
        embedding: embedMode(),   // api | hash
        llm: llmMode(),           // api | offline
        docs: getDocs().length,
      });
    }

    // ---------- 文档列表 ----------
    if (path === '/api/docs' && req.method === 'GET') {
      return send(res, 200, { docs: getDocs() });
    }

    // ---------- 上传入库 ----------
    if (path === '/api/upload' && req.method === 'POST') {
      const { name, text } = await readBody(req);
      if (!name || !text) return send(res, 400, { error: '需要 name 和 text' });
      const doc = await ingest(String(name).slice(0, 100), String(text));
      return send(res, 200, { ok: true, doc });
    }

    // ---------- 非流式问答 ----------
    if (path === '/api/ask' && req.method === 'POST') {
      const { question, sessionId = 'default' } = await readBody(req);
      if (!question) return send(res, 400, { error: '需要 question' });

      const hits = await retrieve(String(question));
      if (!hits.length) {
        const refusal = '知识库中未找到相关内容。';
        addMessage(sessionId, 'user', question);
        addMessage(sessionId, 'assistant', refusal, { citations: [] });
        return send(res, 200, { answer: refusal, citations: [], refused: true });
      }

      addMessage(sessionId, 'user', question);
      let answer = '';
      for await (const piece of streamAnswer(buildPrompt(question, hits))) answer += piece;
      addMessage(sessionId, 'assistant', answer, { citations: hits });
      return send(res, 200, { answer, citations: hits, refused: false });
    }

    // ---------- SSE 流式问答 ----------
    if (path === '/api/ask/stream' && req.method === 'GET') {
      const question = url.searchParams.get('question');
      const sessionId = url.searchParams.get('sessionId') || 'default';
      if (!question) return send(res, 400, { error: '需要 question' });

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // 关键：让 nginx 别缓冲，否则流式会变成一次性输出
        ...CORS,
      });
      const sse = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      const hits = await retrieve(String(question));
      addMessage(sessionId, 'user', question);

      if (!hits.length) {
        sse('citations', []);
        sse('delta', { text: '知识库中未找到相关内容。' });
        sse('done', { refused: true });
        addMessage(sessionId, 'assistant', '知识库中未找到相关内容。', { citations: [] });
        return res.end();
      }

      sse('citations', hits);
      let answer = '';
      try {
        for await (const piece of streamAnswer(buildPrompt(question, hits))) {
          answer += piece;
          sse('delta', { text: piece });
        }
      } catch (e) {
        sse('error', { message: e.message });
      }
      sse('done', { refused: false });
      addMessage(sessionId, 'assistant', answer, { citations: hits });
      return res.end();
    }

    // ---------- 历史消息 ----------
    if (path === '/api/messages' && req.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId') || 'default';
      return send(res, 200, { messages: getMessages(sessionId) });
    }

    send(res, 404, { error: `未知路由 ${path}` });
  } catch (e) {
    console.error('[server]', e);
    if (!res.headersSent) send(res, 500, { error: e.message });
    else res.end();
  }
});

await loadDb();
server.listen(PORT, () => {
  console.log(`\nRAG 服务已启动： http://localhost:${PORT}`);
  console.log(`  向量化模式： ${embedMode()}   ${embedMode() === 'hash' ? '(本地哈希，仅演示；设置 EMBED_API_KEY 可换真实向量)' : ''}`);
  console.log(`  模型模式：   ${llmMode()}   ${llmMode() === 'offline' ? '(离线兜底；设置 LLM_API_KEY 可调用真实模型)' : ''}`);
  console.log(`  已入库文档： ${getDocs().length} 个\n`);
});
