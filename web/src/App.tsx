import { useEffect, useRef, useState } from "react";

const API = import.meta.env.VITE_API_BASE ?? "http://localhost:8787";

type Citation = { docName: string; seq: number; text: string; score: number };
type Msg = { role: "user" | "assistant"; content: string; citations?: Citation[] };

export default function App() {
  const [docs, setDocs] = useState<{ id: number; name: string; chunks: number }[]>([]);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [question, setQuestion] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [health, setHealth] = useState<{ embedding: string; llm: string } | null>(null);
  const [error, setError] = useState("");
  const esRef = useRef<EventSource | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const refreshDocs = () =>
    fetch(`${API}/api/docs`)
      .then((r) => r.json())
      .then((d) => setDocs(d.docs ?? []))
      .catch(() => setError("连不上后端，确认 node index.js 已启动"));

  useEffect(() => {
    fetch(`${API}/api/health`).then((r) => r.json()).then(setHealth).catch(() => {});
    refreshDocs();
    return () => esRef.current?.close();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function upload(file: File) {
    setError("");
    const text = await file.text();
    const res = await fetch(`${API}/api/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: file.name, text }),
    });
    const json = await res.json();
    if (!res.ok) setError(json.error ?? "上传失败");
    else {
      setError("");
      refreshDocs();
    }
  }

  function ask() {
    const q = question.trim();
    if (!q || streaming) return;
    setError("");
    setQuestion("");
    setStreaming(true);
    setMessages((m) => [...m, { role: "user", content: q }, { role: "assistant", content: "" }]);

    // SSE：浏览器原生 EventSource，只能 GET，所以走后端 /api/ask/stream
    const es = new EventSource(`${API}/api/ask/stream?sessionId=web&question=${encodeURIComponent(q)}`);
    esRef.current = es;

    const append = (text: string) =>
      setMessages((m) => {
        const copy = [...m];
        copy[copy.length - 1] = { ...copy[copy.length - 1], content: copy[copy.length - 1].content + text };
        return copy;
      });

    es.addEventListener("citations", (e) => {
      const cites = JSON.parse((e as MessageEvent).data) as Citation[];
      setMessages((m) => {
        const copy = [...m];
        copy[copy.length - 1] = { ...copy[copy.length - 1], citations: cites };
        return copy;
      });
    });

    es.addEventListener("delta", (e) => {
      append((JSON.parse((e as MessageEvent).data) as { text: string }).text);
    });

    es.addEventListener("done", () => {
      setStreaming(false);
      es.close();
    });

    es.addEventListener("error", () => {
      // 浏览器在连接异常时也会触发 error，避免误报
      if (es.readyState === EventSource.CLOSED) {
        setStreaming(false);
        setError("流式连接中断");
      }
    });
  }

  return (
    <div className="wrap">
      <header>
        <h1>知识库问答</h1>
        {health && (
          <div className={`badges ${health.llm === "offline" ? "warn" : ""}`}>
            <span>向量：{health.embedding === "hash" ? "本地哈希（演示）" : "API"}</span>
            <span>模型：{health.llm === "offline" ? "离线兜底" : "API"}</span>
          </div>
        )}
      </header>

      <section className="panels">
        <div className="card">
          <h2>1. 上传文档</h2>
          <input
            type="file"
            accept=".txt,.md,.csv,.json"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload(f);
            }}
          />
          <p className="hint">支持 .txt / .md / .csv / .json（纯文本）</p>
          <h2>已入库 {docs.length} 个</h2>
          <ul className="docs">
            {docs.map((d) => (
              <li key={d.id}>
                {d.name} <em>{d.chunks} 块</em>
              </li>
            ))}
            {!docs.length && <li className="empty">还没有文档</li>}
          </ul>
        </div>

        <div className="card chat">
          <h2>2. 提问</h2>
          <div className="msgs">
            {messages.map((m, i) => (
              <div key={i} className={`msg ${m.role}`}>
                <div className="who">{m.role === "user" ? "我" : "助手"}</div>
                <div className="text">{m.content || (streaming && i === messages.length - 1 ? "…" : "")}</div>
                {m.citations && m.citations.length > 0 && (
                  <details className="cites">
                    <summary>引用 {m.citations.length} 条</summary>
                    {m.citations.map((c, j) => (
                      <div key={j} className="cite">
                        <b>[{j + 1}]</b> {c.docName} 第 {c.seq + 1} 块 · 相似度 {c.score}
                        <div className="cite-text">{c.text.slice(0, 160)}…</div>
                      </div>
                    ))}
                  </details>
                )}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          <div className="input-row">
            <textarea
              value={question}
              placeholder="例如：内核怎么把数据传给用户态？"
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) ask();
              }}
            />
            <button onClick={ask} disabled={streaming || !question.trim()}>
              {streaming ? "生成中…" : "提问"}
            </button>
          </div>
          <p className="hint">Ctrl / ⌘ + Enter 发送</p>
        </div>
      </section>

      {error && <div className="error">{error}</div>}
    </div>
  );
}
