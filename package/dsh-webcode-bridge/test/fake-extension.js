// fake-extension.js — a minimal stand-in for the browser extension.
// Connects to the relay WS with consent (with reconnect/backoff, like the
// real extension), receives requests, and answers with canned streaming deltas.
// Lets the whole bridge be verified without a browser.
//
//   node test/fake-extension.js [--port 8931] [--once] [--text "回答"]

const args = process.argv.slice(2);
const get = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const PORT = Number(get('--port', process.env.WEBCODE_PORT || 8931));
const ONCE = args.includes('--once');
const TEXT = get('--text', '你好！这是来自 DeepSeek 网页版的真实回复（fake-extension 模拟）。');

const { WebSocket } = await import('ws');

let handled = 0;
let backoff = 250;
let scheduled = false; // one reconnect at a time — double timers caused a
let gen = 0;           // connect/close ping-pong against the newest-wins relay

function connect() {
  const myGen = ++gen;
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/bridge`);

  ws.on('open', () => {
    console.log(`[fake-ext] connected ws://127.0.0.1:${PORT}/bridge (gen ${myGen})`);
    backoff = 250;
    ws.send(JSON.stringify({
      type: 'hello',
      site: 'fake.deepseek.test',
      version: '0.0.1',
      consent: { accepted: true, ts: Date.now() },
    }));
  });

  ws.on('message', async (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type === 'hello-ok') console.log('[fake-ext] hello-ok', JSON.stringify(msg.config));
    if (msg.type === 'hello-rejected') { console.log('[fake-ext] hello-rejected:', msg.message); process.exit(2); }
    if (msg.type === 'request') {
      console.log(`[fake-ext] request ${msg.requestId}: ${msg.prompt.slice(0, 80).replace(/\n/g, '␤')}...`);
      const full = `${TEXT}\n\n(收到 ${Buffer.byteLength(msg.prompt, 'utf8')} 字节 prompt)`;
      for (let i = 0; i < full.length; i += 24) {
        ws.send(JSON.stringify({ type: 'delta', requestId: msg.requestId, seq: i, text: full.slice(i, i + 24) }));
        await new Promise((r) => setTimeout(r, 30));
      }
      ws.send(JSON.stringify({ type: 'done', requestId: msg.requestId, text: full }));
      handled += 1;
      if (ONCE && handled >= 2) setTimeout(() => process.exit(0), 200);
    }
  });

  ws.on('close', () => {
    // 'error' is always followed by 'close'; only close schedules the
    // reconnect, and only for the current generation.
    if (myGen === gen) scheduleReconnect('closed');
  });
  ws.on('error', () => {});
}

function scheduleReconnect(reason) {
  if (scheduled) return;
  scheduled = true;
  console.log(`[fake-ext] ${reason}; reconnect in ${backoff}ms`);
  setTimeout(() => { scheduled = false; connect(); }, backoff);
  backoff = Math.min(backoff * 2, 5000);
}

connect();
