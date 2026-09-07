// mock-server.js — a fake chat.deepseek.com for extension testing.
// Serves a page with the same DOM selectors the extension uses, plus
// POST /api/v0/chat/completion answering in the real DeepSeek SSE protocol
// (JSON-patch ops over fragments), streamed with delays.
//
//   node test-mock/mock-server.js [port=8932]

import http from 'node:http';

const port = Number(process.argv[2] || 8932);
let seq = 0;
// per-conversation state for the session-continuity gate (M2d)
const conversations = new Map(); // sid → { prompts: string[] }

// session page route: /a/chat/s/<id> — same page, id from the path
function sessionIdFromPath(pathname) {
  const m = pathname.match(/^\/a\/chat\/s\/([0-9a-zA-Z-]{4,64})$/);
  return m ? m[1] : null;
}

const PAGE = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Mock DeepSeek</title>
<style>
  body { font-family: system-ui; max-width: 640px; margin: 40px auto; }
  #stop[hidden] { display: none; }
  .row { display: flex; gap: 8px; align-items: center; }
  textarea { width: 480px; height: 60px; }
  .btn { border: 1px solid #ccc; border-radius: 6px; padding: 6px 10px; cursor: pointer; }
  #log { margin-top: 16px; white-space: pre-wrap; border-top: 1px solid #eee; padding-top: 8px; }
</style></head>
<body>
  <h3>Mock chat.deepseek.com</h3>
  <select aria-label="Model"><option value="flash">Flash</option><option value="vision">Vision</option><option value="deepseek">DeepSeek</option></select>
  <div class="row">
    <textarea class="ds-scroll-area" id="chat-input"></textarea>
    <div role="button" id="send" class="btn"><svg><path d="M8.3125 6.5 L10 8"></path></svg>send</div>
    <div role="button" id="stop" class="btn" hidden><svg><path d="M2 4.88 L4 6"></path></svg>stop</div>
  </div>
  <div id="log"></div>
  <script>
    // login state the real site keeps in localStorage (value-wrapped form)
    localStorage.setItem('userToken', JSON.stringify({ value: 'mock-token-abc', __version: '0' }));
    const ta = document.getElementById('chat-input');
    const sendBtn = document.getElementById('send');
    const stopBtn = document.getElementById('stop');
    const log = document.getElementById('log');
    function append(s) { log.textContent += s + '\\n'; }
    function sidFromLocation() {
      const m = location.pathname.match(/^\\/a\\/chat\\/s\\/([0-9a-zA-Z-]{4,64})$/);
      return m ? m[1] : null;
    }
    async function generate() {
      const prompt = ta.value;
      ta.value = '';
      // the real site moves to /a/chat/s/<id> once the web session exists;
      // reuse the id when already inside a conversation page
      const sid = sidFromLocation() || 'sess-mock-12345678';
      history.pushState({}, '', '/a/chat/s/' + sid);
      sendBtn.hidden = true; stopBtn.hidden = false;
      append('[MOCK] generating for prompt: ' + prompt.slice(0, 60));
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/v0/chat/completion');
      xhr.setRequestHeader('content-type', 'application/json');
      xhr.send(JSON.stringify({ chat_session_id: sid, messages: [{ role: 'user', content: prompt }] }));
      await new Promise((resolve) => { xhr.onloadend = resolve; });
      append('[MOCK] done');
      sendBtn.hidden = false; stopBtn.hidden = true;
    }
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); generate(); } });
    sendBtn.addEventListener('click', () => generate());
  </script>
</body></html>`;

// DeepSeek web-internal API mocks. Bearer token required — this proves the
// driver's page-context auth (localStorage userToken) actually flows.
function authed(req) {
  return String(req.headers.authorization || '') === 'Bearer mock-token-abc';
}

function sse(event, data) {
  return 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/mock/state') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(Object.fromEntries([...conversations].map(([k, v]) => [k, v.prompts]))));
    return;
  }
  if (req.method === 'GET' && sessionIdFromPath(url.pathname)) {
    // session continuation: same page shell, remembered conversation id
    const sid = sessionIdFromPath(url.pathname);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE.replace('sess-mock-12345678', sid));
    return;
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/mock')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/v0/chat_session/fetch_page') {
    if (!authed(req)) { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: 401, msg: 'unauthorized' })); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      code: 0, msg: 'ok',
      data: { biz_code: 0, biz_data: { chat_sessions: [
        { id: 'sess-mock-12345678', title: 'Mock 网页命名会话（实时）', updated_at: Date.now() },
        { id: 'sess-mock-older9999', title: '更早的网页会话', updated_at: Date.now() - 86400000 },
      ], has_more: false } },
    }));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/v0/chat/history_messages') {
    if (!authed(req)) { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: 401, msg: 'unauthorized' })); return; }
    const sid = url.searchParams.get('chat_session_id') || '';
    if (sid !== 'sess-mock-12345678') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: { chat_messages: [] } } })); return; }
    // main line m0→m1→m2→m3 plus one regeneration branch (mb) off m0
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      code: 0, msg: 'ok',
      data: { biz_code: 0, biz_data: { chat_messages: [
        { id: 'hm0', role: 'USER', content: 'mock 历史第一条', parent_id: null, inserted_at: Date.now() - 4000 },
        { id: 'hm1', role: 'ASSISTANT', content: 'mock 主线回答 v1', parent_id: 'hm0', inserted_at: Date.now() - 3000 },
        { id: 'hmb', role: 'ASSISTANT', content: 'mock 重新生成的分支回答', parent_id: 'hm0', inserted_at: Date.now() - 2500 },
        { id: 'hm2', role: 'USER', content: '继续', parent_id: 'hm1', inserted_at: Date.now() - 2000 },
        { id: 'hm3', role: 'ASSISTANT', content: 'mock 主线最终回答', parent_id: 'hm2', inserted_at: Date.now() - 1000 },
      ] } },
    }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/v0/chat/completion') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let prompt = '';
      let sid = 'sess-mock-12345678';
      try {
        const j = JSON.parse(body);
        prompt = j.messages?.[0]?.content || '';
        if (j.chat_session_id) sid = j.chat_session_id;
      } catch {}
      // per-conversation prompt log for the session-continuity gate (M2d)
      const cs = conversations.get(sid) || { prompts: [] };
      cs.prompts.push(prompt.slice(0, 4000));
      conversations.set(sid, cs);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const id = 'm' + (++seq);
      const answer = 'MOCK-ANSWER: 已收到网页桥接请求。prompt 前缀：' + prompt.slice(0, 50);
      // DeepSeek-style JSON-patch SSE, THINK first (must never leak), then RESPONSE
      const frames = [
        sse('ready', { response_message_id: id }),
        sse('message', { v: { response: { role: 'ASSISTANT', message_id: id, status: 'WIP', fragments: [ { type: 'THINK', content: '' }, { type: 'RESPONSE', content: '' } ] } } }),
      ];
      const thinkText = '（思考片段：不应出现在桥接输出中）';
      for (let i = 0; i < thinkText.length; i += 6) {
        frames.push(sse('message', { o: 'APPEND', p: 'response/fragments/0/content', v: thinkText.slice(i, i + 6) }));
      }
      for (let i = 0; i < answer.length; i += 12) {
        frames.push(sse('message', { o: 'APPEND', p: 'response/fragments/-1/content', v: answer.slice(i, i + 12) }));
      }
      frames.push(sse('message', { o: 'SET', p: 'response/status', v: 'FINISHED' }));
      frames.push(sse('close', {}));

      let i = 0;
      const timer = setInterval(() => {
        if (i >= frames.length) { clearInterval(timer); res.end(); return; }
        res.write(frames[i++]);
      }, 40);
      // NOTE: req 'close' fires as soon as the request body is consumed in
      // modern Node — listening there would kill the response interval
      // immediately. Clean up on the RESPONSE stream instead.
      res.on('close', () => clearInterval(timer));
    });
    return;
  }
  res.writeHead(404); res.end('not found');
});

server.listen(port, '127.0.0.1', () => console.log('[mock] listening on http://127.0.0.1:' + port));
