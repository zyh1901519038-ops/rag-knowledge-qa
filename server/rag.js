/**
 * rag.js —— 分块、向量化、检索、持久化（零依赖，只用 node 内置模块）
 *
 * 设计取舍：
 * 1. 存储用 JSON 文件而不是数据库：为了「不装东西就能跑」。真实项目应换 PostgreSQL + pgvector。
 * 2. 向量化支持两种后端：
 *    - 有 EMBED_API_KEY：调 OpenAI 兼容的 embeddings 接口（真实语义向量）
 *    - 没有：用本地哈希向量（**仅演示/自测用，语义能力很弱**）
 *    这点必须诚实——哈希向量只能验证链路通不通，不能证明检索效果好。
 * 3. 检索后按余弦相似度排序，取 top-k，并带一个相似度阈值；低于阈值就拒答。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const DB_FILE = join(DATA_DIR, 'db.json');

/** 分块参数：块大小 + 重叠窗口（重叠是为了避免关键句被切在边界） */
export const CHUNK_SIZE = 400;
export const CHUNK_OVERLAP = 80;
export const TOP_K = 4;
export const MIN_SCORE = 0.15;

/* ------------------------------ 存储 ------------------------------ */

let db = { docs: [], chunks: [], messages: [], nextId: 1 };

export async function loadDb() {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
  if (existsSync(DB_FILE)) {
    try {
      db = JSON.parse(await readFile(DB_FILE, 'utf8'));
      db.nextId ??= db.chunks.length + 1;
    } catch (e) {
      console.error('[store] 读取 db.json 失败，使用空库：', e.message);
    }
  }
  return db;
}

let saveTimer = null;
function scheduleSave() {
  // 合并写入，避免每块都落盘
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    writeFile(DB_FILE, JSON.stringify(db), 'utf8').catch((e) =>
      console.error('[store] 保存失败：', e.message),
    );
  }, 200);
}

export const getDocs = () => db.docs.map((d) => ({ id: d.id, name: d.name, chunks: d.chunkCount }));
export const getMessages = (sessionId) => db.messages.filter((m) => m.sessionId === sessionId);

/* ---------------------------- 分块 ---------------------------- */

/**
 * 按段落聚合切块，超长段落强制切，块间保留 CHUNK_OVERLAP 字符重叠。
 * 返回 [{ text, seq }]
 */
export function chunkText(text) {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const paras = normalized.split(/\n{2,}|\n(?=\s*[-*#\d])/).filter((p) => p.trim());
  const chunks = [];
  let buf = '';

  const push = () => {
    const t = buf.trim();
    if (t) chunks.push(t);
    buf = '';
  };

  for (const p of paras) {
    if (p.length > CHUNK_SIZE) {
      // 超长段落：按窗口滑
      push();
      for (let i = 0; i < p.length; i += CHUNK_SIZE - CHUNK_OVERLAP) {
        chunks.push(p.slice(i, i + CHUNK_SIZE));
      }
      continue;
    }
    if ((buf + '\n' + p).length > CHUNK_SIZE) {
      push();
      // 重叠：把上一块的尾巴接过来
      const tail = chunks[chunks.length - 1]?.slice(-CHUNK_OVERLAP) ?? '';
      buf = tail ? tail + '\n' + p : p;
    } else {
      buf = buf ? buf + '\n' + p : p;
    }
  }
  push();

  return chunks.map((text, seq) => ({ text, seq }));
}

/* --------------------------- 向量化 --------------------------- */

const EMBED_DIM = 256;
const EMBED_API_KEY = process.env.EMBED_API_KEY;
const EMBED_BASE = process.env.EMBED_BASE_URL || 'https://api.deepseek.com/v1';
const EMBED_MODEL = process.env.EMBED_MODEL || 'text-embedding-3-small';

export const embedMode = () => (EMBED_API_KEY ? 'api' : 'hash');

/** 本地哈希向量：把每个字符 bigram 哈希进固定维度。只是「能算余弦」，没有真正语义。 */
function hashEmbed(text) {
  const v = new Float64Array(EMBED_DIM);
  const s = text.toLowerCase();
  for (let i = 0; i < s.length - 1; i++) {
    const bg = s.slice(i, i + 2);
    let h = 2166136261;
    for (let j = 0; j < bg.length; j++) {
      h ^= bg.charCodeAt(j);
      h = Math.imul(h, 16777619);
    }
    v[Math.abs(h) % EMBED_DIM] += 1;
  }
  return l2(v);
}

function l2(vec) {
  let n = 0;
  for (let i = 0; i < vec.length; i++) n += vec[i] * vec[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] /= n;
  return vec;
}

export async function embed(texts) {
  if (!EMBED_API_KEY) return texts.map(hashEmbed);

  const batches = [];
  for (let i = 0; i < texts.length; i += 32) batches.push(texts.slice(i, i + 32));

  const out = [];
  for (const batch of batches) {
    const res = await fetch(`${EMBED_BASE.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${EMBED_API_KEY}` },
      body: JSON.stringify({ model: EMBED_MODEL, input: batch }),
    });
    if (!res.ok) throw new Error(`embedding 接口 ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    for (const d of json.data) out.push(l2(Float64Array.from(d.embedding)));
  }
  return out;
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/* ---------------------------- 索引 ---------------------------- */

export async function ingest(name, text) {
  const pieces = chunkText(text);
  if (!pieces.length) throw new Error('文档内容为空');

  const doc = { id: db.nextId++, name, chunkCount: pieces.length, createdAt: Date.now() };
  const vecs = await embed(pieces.map((p) => p.text));

  pieces.forEach((p, i) => {
    db.chunks.push({
      id: db.nextId++,
      docId: doc.id,
      docName: name,
      seq: p.seq,
      text: p.text,
      vec: Array.from(vecs[i]),
    });
  });
  db.docs.push(doc);
  scheduleSave();
  return doc;
}

export async function retrieve(question, topK = TOP_K) {
  if (!db.chunks.length) return [];
  const [qv] = await embed([question]);
  const scored = db.chunks
    .map((c) => ({ ...c, score: cosine(qv, c.vec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  const best = scored[0]?.score ?? 0;
  // 相似度太低直接判为「没有相关内容」，把决定权交给上层拒答
  if (best < MIN_SCORE) return [];
  return scored.map((c) => ({
    docName: c.docName,
    seq: c.seq,
    text: c.text,
    score: Number(c.score.toFixed(4)),
  }));
}

export function addMessage(sessionId, role, content, extra = {}) {
  const msg = { id: db.nextId++, sessionId, role, content, createdAt: Date.now(), ...extra };
  db.messages.push(msg);
  scheduleSave();
  return msg;
}

export function buildPrompt(question, hits) {
  const ctx = hits
    .map((h, i) => `[${i + 1}] 来源：${h.docName} 第 ${h.seq + 1} 块\n${h.text}`)
    .join('\n\n');
  return (
    `你是知识库问答助手。只能根据下面「参考资料」回答，资料里没有的内容就回答"知识库中未找到相关内容"。\n` +
    `回答时用 [1][2] 这样的编号标注引用的资料。\n\n` +
    `参考资料：\n${ctx}\n\n问题：${question}`
  );
}
