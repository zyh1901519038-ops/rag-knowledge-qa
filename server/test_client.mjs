/**
 * test_client.mjs —— 端到端自测（不需要浏览器、不需要 API key）
 * 用法：先 node index.js 启动服务，再 node test_client.mjs
 */
const BASE = process.env.BASE || 'http://localhost:8787';

const SAMPLE_DOC = `Linux 字符设备驱动开发笔记

字符设备通过设备号区分，主设备号标识驱动，次设备号标识具体设备。cdev_add 负责把设备号范围绑定到 file_operations。

alloc_chrdev_region 可以动态申请主设备号，避免与已有驱动冲突。cdev_add 只是让内核知道设备号归属，并不会创建设备文件；需要配合 class_create 和 device_create，由 udev 自动创建 /dev 下的节点。

用户态和内核态地址空间是分开的，内核不能直接解引用用户态指针。copy_to_user 和 copy_from_user 会做地址合法性检查，失败时返回未拷贝的字节数，驱动应当转换成 EFAULT。

阻塞读通过 wait_queue 实现，wait_event_interruptible 让进程睡眠，写端放入数据后调用 wake_up_interruptible 唤醒。醒来之后必须重新判断条件，因为数据可能已被其他进程取走。

poll 机制让用户态可以同时等待多个文件描述符。驱动实现 .poll 回调时，需要分别对读队列和写队列调用 poll_wait，否则某一端永远等不到唤醒。

printk 是内核里的日志输出方式，配合 dmesg 查看。它有日志级别，可以进行分级控制。`;

const SAMPLE_QUERY = '内核里怎么把数据传给用户态？失败怎么办？';
const UNRELATED_QUERY = '今天晚饭吃什么比较好';

const post = async (path, body) => {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
};

const line = (s) => console.log(s);

(async () => {
  line('\n=== 0. 健康检查 ===');
  const h = await fetch(BASE + '/api/health').then((r) => r.json());
  line(JSON.stringify(h));

  line('\n=== 1. 上传文档 ===');
  const up = await post('/api/upload', { name: 'linux-chardev-notes.txt', text: SAMPLE_DOC });
  line(`status=${up.status} ` + JSON.stringify(up.json));

  line('\n=== 2. 文档列表 ===');
  const docs = await fetch(BASE + '/api/docs').then((r) => r.json());
  line(JSON.stringify(docs));

  line('\n=== 3. 提问（非流式）===');
  const ask = await post('/api/ask', { question: SAMPLE_QUERY, sessionId: 'test' });
  line(`status=${ask.status}`);
  line(`refused=${ask.json.refused}`);
  line(`引用 ${ask.json.citations?.length ?? 0} 条：` + (ask.json.citations || []).map((c) => `${c.docName}#${c.seq}(score=${c.score})`).join(', '));
  line('答案：\n' + ask.json.answer);

  line('\n=== 4. 无关问题（应拒答）===');
  const bad = await post('/api/ask', { question: UNRELATED_QUERY, sessionId: 'test' });
  line(`refused=${bad.json.refused}  答案=${bad.json.answer}`);

  line('\n=== 5. SSE 流式 ===');
  const res = await fetch(`${BASE}/api/ask/stream?question=${encodeURIComponent('阻塞读是怎么实现的？')}&sessionId=test`);
  line(`status=${res.status} content-type=${res.headers.get('content-type')}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let chunks = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const s = dec.decode(value, { stream: true });
    chunks += (s.match(/event: delta/g) || []).length;
    for (const m of s.matchAll(/event: delta\ndata: (\{.*\})/g)) {
      try { text += JSON.parse(m[1]).text || ''; } catch { /* ignore */ }
    }
  }
  line(`收到 delta 帧 ${chunks} 个，拼接后长度 ${text.length}`);
  line('流式答案前 120 字：' + text.slice(0, 120).replace(/\n/g, ' '));

  line('\n=== 6. 历史消息 ===');
  const msgs = await fetch(`${BASE}/api/messages?sessionId=test`).then((r) => r.json());
  line(`共 ${msgs.messages.length} 条：` + msgs.messages.map((m) => m.role).join(', '));

  const pass =
    h.ok === true &&
    up.status === 200 &&
    (ask.json.citations?.length ?? 0) > 0 &&
    bad.json.refused === true &&
    chunks > 0;
  line(`\n===== 结论：${pass ? '全部通过 ✓' : '有失败项 ✗'} =====`);
  process.exit(pass ? 0 : 1);
})();
