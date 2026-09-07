// mirror.js — reverse-proxy the real chat site through the relay origin so
// the sidebar can host the ACTUAL conversation UI in an iframe (the site's
// own CSP forbids direct framing; proxying at the same origin with the frame
// headers stripped is the only honest way to show it inline).
//
// Routes everything EXCEPT the relay's own namespaces (/v1/*, /bridge/*,
// /webcode/*) to the upstream site 1:1 — the SPA's root-relative asset and
// /api paths line up unchanged. Response hardening: frame/CSP/COEP headers
// stripped, Set-Cookie rewritten onto the loopback origin (Domain/Secure
// dropped), HTML responses get a bootstrap that (a) seeds the login token,
// (b) blocks service-worker registration from hijacking relay routes, (c)
// rewrites any absolute upstream URLs the bundle may use.

const UP_HOSTS = new Set(); // filled from config origin

export function createMirror(options = {}) {
  const {
    siteOrigin = 'https://chat.deepseek.com',
    getToken = async () => null,
    logger = console,
  } = options;
  const log = (...a) => logger.log?.('[webcode-mirror]', ...a);
  const warn = (...a) => logger.warn?.('[webcode-mirror]', ...a);
  UP_HOSTS.clear();
  UP_HOSTS.add(new URL(siteOrigin).host);

  // relay-owned namespaces that must NEVER be proxied upstream
  const LOCAL_PREFIXES = ['/v1/', '/bridge/', '/webcode/', '/__webcode/'];
  const HOP_BY_HOP = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
    'content-length', // re-derived by node for our streamed body
  ]);
  const STRIP_RESPONSE = new Set([
    'content-security-policy', 'content-security-policy-report-only',
    'x-frame-options', 'cross-origin-embedder-policy', 'cross-origin-embedder-policy-report-only',
    'clear-site-data', 'content-length',
    // undici already decoded the body; passing the encoding header on would
    // make downstream clients gunzip plain text ("terminated" body errors)
    'content-encoding',
  ]);

  const BOOTSTRAP = (tokenJson) => `<script data-webcode-mirror>(function(){
try{ localStorage.setItem('userToken', ${tokenJson}); }catch(e){}
try{ if(navigator.serviceWorker){ navigator.serviceWorker.register=function(){return Promise.reject(new Error('mirror: sw disabled'))}; } }catch(e){}
var UP='${siteOrigin}';
var of=window.fetch;
if(of){ window.fetch=function(input,init){
  try{
    if(typeof input==='string'&&input.indexOf(UP)===0) input=input.slice(UP.length)||'/';
    else if(input&&typeof input==='object'&&typeof input.url==='string'&&input.url.indexOf(UP)===0) input=new Request(input.url.slice(UP.length)||'/',input);
  }catch(e){}
  return of.call(window,input,init);
};}
var oo=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(m,u){
  if(typeof u==='string'&&u.indexOf(UP)===0) u=u.slice(UP.length)||'/';
  return oo.apply(this,arguments);
};
})();</script>`;

  function isLocal(pathname) {
    return LOCAL_PREFIXES.some((p) => pathname === p.slice(0, -1) || pathname.startsWith(p));
  }

  /** Proxy one request upstream. Returns true when handled. */
  async function handle(req, res, pathname, search = '') {
    if (isLocal(pathname)) return false;
    // only same-origin-ish traffic may ride the mirror; loopback Host is
    // enforced (DNS rebinding would otherwise proxy arbitrary victims)
    const host = String(req.headers.host || '');
    if (!/^(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/i.test(host)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'mirror: loopback only' } }));
      return true;
    }
    const url = siteOrigin + pathname + search;
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const key = k.toLowerCase();
      if (HOP_BY_HOP.has(key) || key.startsWith('sec-fetch-') || key === 'origin' || key === 'referer' || key === 'cookie') continue;
      headers[k] = v;
    }
    // the mirror page's own cookies (rewritten onto loopback) ride along —
    // they carry the upstream WAF/session state once set
    const cookies = String(req.headers.cookie || '');
    if (cookies) headers['cookie'] = cookies;
    headers['referer'] = siteOrigin + '/';

    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = [];
      let total = 0;
      await new Promise((resolve) => {
        req.on('data', (c) => { total += c.length; if (total <= 8_000_000) chunks.push(c); });
        req.on('end', resolve);
        req.on('error', resolve);
      });
      body = Buffer.concat(chunks);
      if (body.length) headers['content-length'] = String(body.length);
    }

    let upstream;
    try {
      upstream = await fetch(url, {
        method: req.method,
        headers,
        body: body && body.length ? body : undefined,
        redirect: 'follow',
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      warn('upstream failed:', pathname, err?.message);
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'mirror upstream unreachable' } }));
      return true;
    }

    // response headers, hardened for iframe embedding on the loopback origin
    const out = {};
    for (const [k, v] of upstream.headers) {
      const key = k.toLowerCase();
      if (HOP_BY_HOP.has(key) || STRIP_RESPONSE.has(key)) continue;
      if (key === 'set-cookie') continue; // rewritten below
      if (key === 'location') { out[k] = rewriteLocation(v); continue; }
      out[k] = v;
    }
    const setCookies = [];
    for (const c of upstream.headers.getSetCookie?.() || []) setCookies.push(rewriteCookie(c));
    if (setCookies.length) out['set-cookie'] = setCookies;
    out['x-webcode-mirror'] = '1';

    const ctype = String(out['content-type'] || '');

    // HTML: buffer, seed token + patches, single write (rare, per page load)
    if (ctype.includes('text/html')) {
      const buf = Buffer.from(await upstream.arrayBuffer());
      let html = buf.toString('utf8');
      let token = null;
      try { token = await getToken(); } catch { /* mirror still loads; the SPA shows its own sign-in */ }
      const tokenJson = token
        ? JSON.stringify(JSON.stringify({ value: token, __version: '0' })).replace(/</g, '\\u003c')
        : 'null';
      const boot = BOOTSTRAP(tokenJson);
      html = html.includes('</head>')
        ? html.replace('</head>', boot + '</head>')
        : boot + html;
      out['content-length'] = String(Buffer.byteLength(html));
      res.writeHead(upstream.status, out);
      res.end(html);
      return true;
    }

    // everything else (assets, SSE, JSON): stream verbatim — completion SSE
    // needs chunk pass-through, so no buffering here
    res.writeHead(upstream.status, out);
    if (req.method === 'HEAD' || !upstream.body) { res.end(); return true; }
    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    } catch { /* client aborted mid-stream */ }
    try { res.end(); } catch {}
    return true;
  }

  function rewriteLocation(loc) {
    try {
      const u = new URL(loc, siteOrigin);
      if (u.host === [...UP_HOSTS][0]) return u.pathname + u.search + u.hash;
      return loc;
    } catch { return loc; }
  }

  function rewriteCookie(c) {
    return c
      .replace(/;\s*domain=[^;]*/gi, '')
      .replace(/;\s*secure/gi, '')
      .replace(/;\s*samesite=(lax|strict|none)/gi, (m) => m.replace(/none/i, 'lax'));
  }

  return { handle, isLocal };
}
