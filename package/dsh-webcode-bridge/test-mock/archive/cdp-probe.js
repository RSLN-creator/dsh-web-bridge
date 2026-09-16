// cdp-probe.js — inspect SW + page contexts of the running Edge via CDP.
import { WebSocket } from 'ws';

const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
const sw = list.find((t) => t.type === 'service_worker' && t.url.includes('background/service_worker.js'));
const page = list.find((t) => t.type === 'page' && t.url.includes('127.0.0.1:8932'));

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: false });
    let id = 0;
    const pending = new Map();
    ws.on('open', () => resolve({
      close() { try { ws.close(); } catch {} },
      send(method, params = {}) {
        return new Promise((res2, rej2) => {
          const mid = ++id;
          pending.set(mid, { res2, rej2 });
          ws.send(JSON.stringify({ id: mid, method, params }));
        });
      },
    }));
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id && pending.has(msg.id)) {
        const { res2, rej2 } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej2(new Error(JSON.stringify(msg.error))) : res2(msg.result);
      }
    });
    ws.on('error', reject);
  });
}

async function evaluate(client, expr) {
  const r = await client.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  return r.result?.value ?? r.result;
}

if (page) {
  const c = await connect(page.webSocketDebuggerUrl);
  console.log('--- page context ---');
  console.log('capture installed (MAIN):', await evaluate(c, 'window.__webcodeCaptureInstalled === true'));
  console.log('textarea count:', await evaluate(c, "document.querySelectorAll('textarea.ds-scroll-area').length"));
  await c.send('Runtime.evaluate', {
    expression: `(async () => {
      // probe isolated world via a fresh content-script-visible channel? not accessible; use chrome.send? skip
      return 'ok';
    })()`,
  });
  c.close();
} else console.log('--- page target not found ---');

if (sw) {
  const c = await connect(sw.webSocketDebuggerUrl);
  console.log('--- service worker context ---');
  console.log('cfg:', await evaluate(c, 'JSON.stringify(cfg)'));
  console.log('tabs query:', await evaluate(c, `chrome.tabs.query({url:'http://127.0.0.1:8932/*'}).then(ts => JSON.stringify(ts.map(t => t.url)))`));
  console.log('sw ws state:', await evaluate(c, 'ws ? ws.readyState : "null"'));
  // try sending a webcode-send directly and watch what happens
  console.log('probe dispatch:', await evaluate(c, `
    (async () => {
      try {
        const tabs = await chrome.tabs.query({url:'http://127.0.0.1:8932/*'});
        if (!tabs.length) return 'no tabs';
        const resp = await chrome.tabs.sendMessage(tabs[0].id, {cmd:'webcode-send', requestId:'probe-1', prompt:'CDP 探针'});
        return 'sendMessage ok: ' + JSON.stringify(resp);
      } catch (e) { return 'sendMessage ERR: ' + e.message; }
    })()
  `));
  c.close();
} else console.log('--- sw target not found ---');
