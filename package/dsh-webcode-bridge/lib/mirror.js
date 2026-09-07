// mirror.js - serve the real DeepSeek web app inside the right sidebar.
// The upstream is fixed at siteOrigin; this is a same-origin relay, not an
// open proxy. The page token is injected only into the relay origin's storage.

export function createMirror(options = {}) {
  const {
    siteOrigin = 'https://chat.deepseek.com',
    getToken = async () => null,
    logger = console,
  } = options;
  const upstreamOrigin = new URL(siteOrigin).origin.replace(/\/$/, '');
  const upstreamHost = new URL(upstreamOrigin).host;
  const log = (...args) => logger.log?.('[webcode-mirror]', ...args);
  const warn = (...args) => logger.warn?.('[webcode-mirror]', ...args);

  const LOCAL_PREFIXES = ['/v1/', '/bridge/', '/webcode/', '/__webcode/'];
  const HOP_BY_HOP = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
  ]);
  const STRIP_RESPONSE = new Set([
    'content-security-policy', 'content-security-policy-report-only',
    'x-frame-options', 'cross-origin-embedder-policy',
    'cross-origin-embedder-policy-report-only', 'clear-site-data',
    'content-length', 'content-encoding',
  ]);

  const isLocal = (pathname) => LOCAL_PREFIXES.some((prefix) =>
    pathname === prefix.slice(0, -1) || pathname.startsWith(prefix));

  function loopbackOnly(req, res) {
    const host = String(req.headers.host || '');
    if (/^(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/i.test(host)) return true;
    res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: { message: 'mirror: loopback only' } }));
    return false;
  }

  function rewriteLocation(value) {
    try {
      const url = new URL(value, upstreamOrigin);
      return url.host === upstreamHost ? url.pathname + url.search + url.hash : value;
    } catch {
      return value;
    }
  }

  function rewriteCookie(value) {
    return String(value)
      .replace(/;\s*domain=[^;]*/gi, '')
      .replace(/;\s*secure/gi, '')
      .replace(/;\s*samesite=none/gi, '; SameSite=Lax');
  }

  function bootstrap(token) {
    const tokenLiteral = token
      ? JSON.stringify(JSON.stringify({ value: token, __version: '0' })).replace(/</g, '\\u003c')
      : 'null';
    const originLiteral = JSON.stringify(upstreamOrigin);
    return `<script data-webcode-mirror>(function(){
try{if(${tokenLiteral}!==null)localStorage.setItem('userToken',${tokenLiteral});}catch(e){}
try{if(navigator.serviceWorker)navigator.serviceWorker.register=function(){return Promise.reject(new Error('mirror: service worker disabled'));};}catch(e){}
var UP=${originLiteral};
var fetch0=window.fetch;
if(fetch0)window.fetch=function(input,init){try{
if(typeof input==='string'&&input.indexOf(UP)===0)input=input.slice(UP.length)||'/';
else if(input&&typeof input.url==='string'&&input.url.indexOf(UP)===0)input=new Request(input.url.slice(UP.length)||'/',input);
}catch(e){}return fetch0.call(this,input,init);};
var open0=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(method,url){if(typeof url==='string'&&url.indexOf(UP)===0)url=url.slice(UP.length)||'/';return open0.apply(this,arguments);};
})();</script>`;
  }

  async function readRequestBody(req, limit = 8 * 1024 * 1024) {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) return { tooLarge: true };
    const chunks = [];
    let size = 0;
    const tooLarge = await new Promise((resolve) => {
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) resolve(true);
        else chunks.push(chunk);
      });
      req.on('end', () => resolve(false));
      req.on('error', () => resolve(true));
    });
    return tooLarge ? { tooLarge: true } : { body: Buffer.concat(chunks) };
  }

  async function handle(req, res, pathname = new URL(req.url, upstreamOrigin).pathname, search = new URL(req.url, upstreamOrigin).search) {
    if (isLocal(pathname)) return false;
    if (!loopbackOnly(req, res)) return true;

    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      const lower = key.toLowerCase();
      if (HOP_BY_HOP.has(lower) || lower.startsWith('sec-fetch-') || lower === 'origin' || lower === 'referer') continue;
      headers[key] = value;
    }
    if (req.headers.cookie) headers.cookie = req.headers.cookie;
    headers.referer = upstreamOrigin + '/';

    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const result = await readRequestBody(req);
      if (result.tooLarge) {
        res.writeHead(413, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ error: { message: 'mirror: request body too large' } }));
        return true;
      }
      body = result.body;
      if (body.length) headers['content-length'] = String(body.length);
    }

    let upstream;
    try {
      upstream = await fetch(upstreamOrigin + pathname + search, {
        method: req.method,
        headers,
        body: body?.length ? body : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      warn('upstream failed:', pathname, error?.message);
      res.writeHead(502, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: { message: 'mirror upstream unreachable' } }));
      return true;
    }

    const out = {};
    for (const [key, value] of upstream.headers) {
      const lower = key.toLowerCase();
      if (HOP_BY_HOP.has(lower) || STRIP_RESPONSE.has(lower) || lower === 'set-cookie') continue;
      out[key] = lower === 'location' ? rewriteLocation(value) : value;
    }
    const cookies = upstream.headers.getSetCookie?.() || [];
    if (cookies.length) out['set-cookie'] = cookies.map(rewriteCookie);
    out['x-webcode-mirror'] = '1';

    const contentType = String(out['content-type'] || '');
    if (contentType.includes('text/html')) {
      const html = Buffer.from(await upstream.arrayBuffer()).toString('utf8');
      let token = null;
      try { token = await getToken(); } catch { /* page remains usable for login */ }
      const injected = bootstrap(typeof token === 'string' ? token : null);
      const patched = html.includes('</head>')
        ? html.replace('</head>', injected + '</head>')
        : injected + html;
      out['content-length'] = String(Buffer.byteLength(patched));
      res.writeHead(upstream.status, out);
      res.end(patched);
      return true;
    }

    res.writeHead(upstream.status, out);
    if (req.method === 'HEAD' || !upstream.body) {
      res.end();
      return true;
    }
    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    } catch { /* client disconnected */ }
    try { res.end(); } catch {}
    log('proxied', req.method, pathname);
    return true;
  }

  return { handle, isLocal };
}
