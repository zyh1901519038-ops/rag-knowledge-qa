# RAG 知识库问答（React + TypeScript / Node.js）

完整链路：**上传文档 → 分段（带重叠）→ 向量化 → 相似度检索 top-k → 拼接上下文 → 流式回答 → 展示引用来源**。

> **服务端零依赖**（只用 node 内置模块），**没有 API key 也能跑通全链路**（本地哈希向量 + 离线兜底回答）。
> 跑通这一步是为了验证"管道是通的"；换成真实 embedding 和模型后，才谈得上检索质量。

## 快速开始

### 1. 后端（零依赖，直接跑）

```bash
cd server
node index.js            # 默认 http://localhost:8787
```

### 2. 端到端自测（另开一个终端）

```bash
cd server
node test_client.mjs     # 6 项检查：健康 / 上传 / 列表 / 提问 / 拒答 / SSE / 历史
```

### 3. 前端

```bash
cd web
npm install
npm run dev              # http://localhost:5173
```

### 4. 接真实模型（可选）

```bash
# 回答用大模型
set LLM_API_KEY=sk-xxx
set LLM_BASE_URL=https://api.deepseek.com/v1
set LLM_MODEL=deepseek-chat

# 检索用真实语义向量（不设则用本地哈希向量，仅供演示）
set EMBED_API_KEY=sk-xxx
set EMBED_BASE_URL=https://api.openai.com/v1
set EMBED_MODEL=text-embedding-3-small
```

## 结构

| 文件 | 职责 |
|---|---|
| `server/rag.js` | 分块（含重叠）、向量化（API / 哈希两套）、余弦检索、JSON 持久化、prompt 拼装 |
| `server/llm.js` | OpenAI 兼容的**流式**聊天（SSE 解析）+ 离线兜底 |
| `server/index.js` | 原生 http 服务：/api/upload、/api/ask、/api/ask/stream（SSE）、/api/docs、/api/health |
| `server/test_client.mjs` | 端到端自测 |
| `web/src/App.tsx` | 上传、提问、流式渲染、引用折叠展示 |

## 实现要点

### 1. 分块 + 重叠

按段落聚合，单块约 400 字，块间保留 80 字符重叠。

**为什么要有重叠**：一句关键的话如果正好被切在块边界，两边都拿到半句，检索时可能都不命中。
重叠让边界内容在两块里各出现一次。

**为什么不用定长滑窗切一切**：按段落切能保住语义单元的完整性，定长切会把一个概念切成两半。

### 2. 检索与拒答

- 问题也做向量化 → 与所有块算**余弦相似度** → 取 top-4
- 最高分低于阈值（0.15）时**直接返回"知识库中未找到相关内容"**，不给模型硬编的机会
- 回答里带引用编号（`[1] [2]`），前端可展开看原文

### 3. 流式（SSE）

- 后端 `Content-Type: text/event-stream`，每个 token 推一个 `event: delta`
- **必须设 `X-Accel-Buffering: no`**，否则 nginx 会缓冲，流式变成一次性吐出来
- 上游 LLM 的 SSE 也按行解析，注意一次 `read()` 可能包含多个 `data:` 帧
- 前端用浏览器原生 `EventSource`（只能 GET，所以接口设计成 GET + query）

### 4. 工程细节

| 点 | 做法 |
|---|---|
| 请求体上限 | 2MB，超了直接断开，防大文件打爆内存 |
| 落盘 | 合并写（200ms 防抖），不是每块都写文件 |
| 错误处理 | 统一 try/catch，SSE 里出错推 `event: error` 而不是静默断流 |
| 消息持久化 | user / assistant 都入库，带 citations |

## 实测结果（本机真实运行）

用示例文档（一段 Linux 驱动笔记，切成 2 块）跑自测：

```
=== 0. 健康检查 === {"ok":true,"embedding":"hash","llm":"offline","docs":0}
=== 1. 上传文档 === status=200 {"ok":true,"doc":{...,"chunkCount":2}}
=== 3. 提    问 === refused=false
    引用 2 条：linux-chardev-notes.txt#1(score=0.2224), #0(score=0.1555)
=== 4. 无关问题 === refused=true  答案=知识库中未找到相关内容。
=== 5. SSE 流式 === status=200 content-type=text/event-stream
    收到 delta 帧 30 个，拼接后长度 359
=== 6. 历史消息 === 共 6 条：user,assistant,user,assistant,user,assistant
===== 结论：全部通过 ✓ =====
```
