import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMirror } from '../lib/mirror.js';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('mirror serves a fixed upstream for the sidebar iframe', async (t) => {
  const upstream = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "frame-ancestors 'none'",
        'x-frame-options': 'DENY',
        'set-cookie': 'sid=abc; Domain=upstream.test; Secure; SameSite=None',
      });
      res.end('<!doctype html><html><head></head><body><textarea>chat</textarea></body></html>');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  const upstreamPort = await listen(upstream);
  const mirror = createMirror({
    siteOrigin: `http://127.0.0.1:${upstreamPort}`,
    getToken: async () => 'test-token',
    logger: { log() {}, warn() {} },
  });
  const relay = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://loopback');
    mirror.handle(req, res, url.pathname, url.search)
      .then((handled) => { if (!handled) { res.writeHead(404); res.end(); } })
      .catch(() => { try { res.writeHead(500); res.end(); } catch {} });
  });
  const relayPort = await listen(relay);
  t.after(() => { upstream.close(); relay.close(); });

  const response = await fetch(`http://127.0.0.1:${relayPort}/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-frame-options'), null);
  assert.equal(response.headers.get('content-security-policy'), null);
  assert.match(html, /data-webcode-mirror/);
  assert.match(html, /test-token/);
  assert.match(response.headers.get('set-cookie') || '', /sid=abc/);
  assert.doesNotMatch(response.headers.get('set-cookie') || '', /Domain=|Secure|SameSite=None/i);

  const foreign = await new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port: relayPort, path: '/', headers: { host: 'evil.example' } }, resolve);
    request.on('error', reject);
  });
  foreign.resume();
  assert.equal(foreign.statusCode, 403);
  const localRoute = await fetch(`http://127.0.0.1:${relayPort}/bridge/status`);
  assert.equal(localRoute.status, 404);
});


test('mirror 同源改写静态域资源，且不污染 bootstrap 自身常量', async (t) => {
  // 站点用绝对 URL + crossorigin 引用另一域的资源；该域 ACAO 是非法通配，
  // 浏览器会硬性拒绝执行脚本（真机 DeepSeek 曾整页「资源加载异常」）。
  // mirror 必须把这些 URL 改写成同源 /__static/<host>/… 并剥离 integrity/
  // crossorigin；同时 bootstrap 里的 UP/ASSETS 常量是运行时比较基准，
  // 若被一并改写，toLocal 永不命中（真机 GLM 埋点仍被 CORS 拦）。
  const ASSET_JS = "https://assets.example.com/app/main.js";
  const ASSET_CSS = "https://assets.example.com/app/main.css";
  const upstream = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end([
        '<!doctype html><html><head>',
        '<script crossorigin defer integrity="sha384-AAAA" src="' + ASSET_JS + '"></script>',
        '<link href="' + ASSET_CSS + '" rel="stylesheet">',
        '</head><body><textarea>chat</textarea></body></html>',
      ].join(''));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/javascript' });
    res.end('window.__assetLoaded = 1;');
  });
  const upstreamPort = await listen(upstream);
  const mirror = createMirror({
    siteOrigin: 'http://127.0.0.1:' + upstreamPort,
    getToken: async () => 'tok',
    logger: { log() {}, warn() {} },
    assetOrigins: ['https://assets.example.com'],
    mountPrefix: '/__webcode/site/demo',
  });
  const relay = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://loopback');
    let pathname = url.pathname;
    const mount = '/__webcode/site/demo';
    if (pathname.startsWith(mount)) pathname = pathname.slice(mount.length) || '/';
    mirror.handle(req, res, pathname, url.search)
      .then((handled) => { if (!handled) { res.writeHead(404); res.end(); } })
      .catch(() => { try { res.writeHead(500); res.end(); } catch {} });
  });
  const relayPort = await listen(relay);
  t.after(() => { upstream.close(); relay.close(); });

  const response = await fetch('http://127.0.0.1:' + relayPort + '/');
  const html = await response.text();
  assert.equal(response.status, 200);

  // 1) 静态 URL 已改写成同源路径，且不残留静态域绝对 URL
  const localJs = '/__webcode/site/demo/__static/assets.example.com/app/main.js';
  const localCss = '/__webcode/site/demo/__static/assets.example.com/app/main.css';
  assert.ok(html.includes(localJs), "主 JS 应改写为同源路径");
  assert.ok(html.includes(localCss), "主 CSS 应改写为同源路径");
  assert.ok(!html.includes(ASSET_JS), '不应残留静态域绝对 URL');
  // 2) integrity / crossorigin 已剥离
  assert.ok(!html.includes('integrity='), 'integrity 应剥离');
  assert.ok(!html.includes('crossorigin'), 'crossorigin 应剥离');
  // 3) bootstrap 自身常量保持原始 origin（未被二次改写）
  assert.ok(html.includes('var ASSETS=["assets.example.com"]'), 'bootstrap 的 ASSETS 应为原始 host');
  // 4) 声明过的静态域被转发（该域是测试用的假域名，必然连不上上游：
  //    502 = 路由承认并尝试转发；404 才代表「域被拒绝」。真机可达时是 200。
  const asset = await fetch('http://127.0.0.1:' + relayPort + '/__static/assets.example.com/app/main.js');
  assert.notEqual(asset.status, 404, '声明过的静态域不应被拒绝');
  // 5) 0.9.9 起改写不再依赖白名单：未声明但**公网**的域同样代理（qwen 的
  //    assets.alicdn.com、GLM 的 at/o.alicdn.com 当年就是白名单漏掉的）——
  //    测试域连不上上游，502 = 路由承认并尝试转发。
  const undeclared = await fetch('http://127.0.0.1:' + relayPort + '/__static/evil.example.com/x.js');
  assert.equal(undeclared.status, 502, '公网未声明域应尝试代理而不是 404');
  // 6) 内网/回环 host 必须拒绝（防本机 SSRF）
  for (const bad of ['localhost', '127.0.0.1', '192.168.1.1', '10.0.0.2', 'METADATA.local']) {
    const denied = await fetch('http://127.0.0.1:' + relayPort + '/__static/' + bad + '/x.js');
    assert.equal(denied.status, 404, '内网/回环 host 应拒绝: ' + bad);
  }
});

test('mirror 站内 302 重定向留在镜像命名空间内', async (t) => {
  // 豆包根路径真机回 302 → /chat/。旧实现直接回写 /chat/，浏览器会把它解析成
  // 「镜像的 /chat/」，而镜像只在 <mountPrefix>/ 下服务 → 右栏只剩一张空壳。
  const upstream = http.createServer((req, res) => {
    if (req.url === '/') { res.writeHead(302, { location: '/chat/' }); res.end(''); return; }
    if (req.url === '/chat/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body><textarea>chat</textarea></body></html>');
      return;
    }
    if (req.url === '/away') { res.writeHead(302, { location: 'https://other.example/x' }); res.end(''); return; }
    res.writeHead(404).end();
  });
  const upstreamPort = await listen(upstream);
  const mirror = createMirror({
    siteOrigin: 'http://127.0.0.1:' + upstreamPort,
    getToken: async () => null,
    logger: { log() {}, warn() {} },
    mountPrefix: '/__webcode/site/demo',
  });
  const relay = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://loopback');
    let pathname = url.pathname;
    const mount = '/__webcode/site/demo';
    if (pathname.startsWith(mount)) pathname = pathname.slice(mount.length) || '/';
    mirror.handle(req, res, pathname, url.search)
      .then((handled) => { if (!handled) { res.writeHead(404); res.end(); } })
      .catch(() => { try { res.writeHead(500); res.end(); } catch {} });
  });
  const relayPort = await listen(relay);
  t.after(() => { upstream.close(); relay.close(); });
  const base = 'http://127.0.0.1:' + relayPort;

  const root = await fetch(base + '/__webcode/site/demo/', { redirect: 'manual' });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/__webcode/site/demo/chat/', '站内重定向必须带上镜像前缀');
  const followed = await fetch(base + root.headers.get('location'));
  assert.equal(followed.status, 200);
  assert.match(await followed.text(), /<textarea>/);

  const away = await fetch(base + '/__webcode/site/demo/away', { redirect: 'manual' });
  assert.equal(away.headers.get('location'), 'https://other.example/x', '跨站重定向保持原样');
});

test('mirror 把上游 CDN/WAF 错误页换成可自解释、可绕开的说明页', async (t) => {
  // 真机：本机直连 chat.deepseek.com 被 CloudFront 判成机器人 → 403 +
  // 「Request blocked. We can't connect to the server for this app…」。
  // 把这张英文错误页原样塞进右栏，用户看到的就是「DeepSeek 预览打不开、别的都行」。
  const upstream = http.createServer((req, res) => {
    res.writeHead(403, { 'content-type': 'text/html; charset=iso-8859-1' });
    res.end('<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN"><HTML><HEAD><TITLE>ERROR: The request could not be satisfied</TITLE></HEAD><BODY><H1>403 ERROR</H1><PRE>Generated by cloudfront (CloudFront)</PRE></BODY></HTML>');
  });
  const upstreamPort = await listen(upstream);
  const mirror = createMirror({
    siteOrigin: 'http://127.0.0.1:' + upstreamPort,
    getToken: async () => null,
    logger: { log() {}, warn() {} },
    mountPrefix: '/__webcode/site/demo',
  });
  const relay = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://loopback');
    let pathname = url.pathname;
    const mount = '/__webcode/site/demo';
    if (pathname.startsWith(mount)) pathname = pathname.slice(mount.length) || '/';
    mirror.handle(req, res, pathname, url.search)
      .then((handled) => { if (!handled) { res.writeHead(404); res.end(); } })
      .catch(() => { try { res.writeHead(500); res.end(); } catch {} });
  });
  const relayPort = await listen(relay);
  t.after(() => { upstream.close(); relay.close(); });

  const r = await fetch('http://127.0.0.1:' + relayPort + '/__webcode/site/demo/');
  const html = await r.text();
  assert.equal(r.status, 502, '上游错误页要转成明确的 502，而不是原样透传 403');
  assert.match(html, /拒绝了镜像请求/);
  assert.match(html, /独立窗口打开/, '必须告诉用户可绕开的路径');
  assert.doesNotMatch(html, /Generated by cloudfront/, '不得把 CDN 错误页透传给用户');
  assert.doesNotMatch(html, /data-webcode-mirror/, '错误页上不得再注入 bootstrap');
});

// ---------- 根相对资源改写（2026-09-13 真机修复） ----------
// 用户反馈「DeepSeek 右栏能开，GLM / z.ai 打不开」。真机 CDP 取证：
// GLM 的 webpack 产物用**根相对**路径引入（/runtime.*.js、/libs.*.js、
// /main.*.js、/icon/iconfont_2.js），z.ai 运行时会请求 /api/config、
// /api/v1/auths/。这些 URL 在镜像页里解析到 http://127.0.0.1:8931/…，
// 而那是**默认站点（DeepSeek）镜像的根** —— 于是：
//   · <script src="/main.*.js"> 拿到 200 + text/html（DeepSeek 的页面），
//     被浏览器按严格 MIME 校验拒绝执行 → #app 永远空白；
//   · fetch('/api/config') 拿到 HTML → 「Unexpected token '<' … is not valid JSON」。
// 它们必须被改写成 <mountPrefix> + 原路径（本站资源），但不能重复加前缀。

test('mirror 把根相对资源改写进 mountPrefix，且不二次加前缀', async (t) => {
  const upstream = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end([
        '<!doctype html><html><head>',
        // 根相对（GLM 形态）
        '<script defer src="/runtime.abc.js"></script>',
        '<script defer src="/main.def.js"></script>',
        '<link href="/icon/iconfont.css" rel="stylesheet">',
        // 协议相对（GLM / z.ai 形态）
        '<script src="//at.alicdn.com/t/c/font.js" defer></script>',
        // 已是镜像路径的（幂等性：不得被再拼一次前缀）
        '<script src="/__webcode/site/demo/__static/at.alicdn.com/already.js"></script>',
        '</head><body><div id="app"></div></body></html>',
      ].join(''));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/javascript' });
    res.end('window.__ok = 1;');
  });
  const upstreamPort = await listen(upstream);
  const mount = '/__webcode/site/demo';
  const mirror = createMirror({
    siteOrigin: 'http://127.0.0.1:' + upstreamPort,
    getToken: async () => null,
    logger: { log() {}, warn() {} },
    assetOrigins: ['https://at.alicdn.com'],
    mountPrefix: mount,
  });
  const relay = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://loopback');
    let pathname = url.pathname;
    if (pathname.startsWith(mount)) pathname = pathname.slice(mount.length) || '/';
    mirror.handle(req, res, pathname, url.search)
      .then((handled) => { if (!handled) { res.writeHead(404); res.end(); } })
      .catch(() => { try { res.writeHead(500); res.end(); } catch {} });
  });
  const relayPort = await listen(relay);
  t.after(() => { upstream.close(); relay.close(); });

  const html = await (await fetch('http://127.0.0.1:' + relayPort + mount + '/')).text();

  // 1) 根相对 → mountPrefix + 原路径
  for (const p of ['/runtime.abc.js', '/main.def.js', '/icon/iconfont.css']) {
    assert.ok(html.includes('"' + mount + p + '"'), '根相对资源应改写为 ' + mount + p);
  }
  // 2) 不得残留裸根相对引用（那会落到回环根 = 别的站点镜像）
  assert.doesNotMatch(html, /(?:src|href)="\/(?!\/|__webcode\/site\/demo\/)/, '不得残留裸根相对资源引用');
  // 3) 协议相对 → __static 同源转发
  assert.ok(html.includes(mount + '/__static/at.alicdn.com/t/c/font.js'), '协议相对资源应改写为同源静态路径');
  // 4) 幂等：已镜像路径不得被二次加前缀
  assert.ok(html.includes(mount + '/__static/at.alicdn.com/already.js'), '已镜像路径应保持原样');
  assert.doesNotMatch(html, /__webcode\/site\/demo\/__webcode\/site\/demo\//, '不得出现二次加前缀');

  // 5) 改写后的 URL 真的能取回正确 MIME（而不是落到默认站点拿到 HTML）
  const js = await fetch('http://127.0.0.1:' + relayPort + mount + '/main.def.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type') || '', /javascript/, '根相对 JS 必须取回 JS 而不是 HTML');
});

test('mirror 根相对改写对 bootstrap 注入脚本自身的 URL 也无害', async (t) => {
  const upstream = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><script src="/a.js"></script></head><body></body></html>');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/javascript' });
    res.end('');
  });
  const upstreamPort = await listen(upstream);
  const mirror = createMirror({
    siteOrigin: 'http://127.0.0.1:' + upstreamPort,
    getToken: async () => null,
    logger: { log() {}, warn() {} },
    mountPrefix: '/__webcode/site/demo',
  });
  const relay = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://loopback');
    let pathname = url.pathname;
    if (pathname.startsWith('/__webcode/site/demo')) pathname = pathname.slice('/__webcode/site/demo'.length) || '/';
    mirror.handle(req, res, pathname, url.search)
      .then((handled) => { if (!handled) { res.writeHead(404); res.end(); } })
      .catch(() => { try { res.writeHead(500); res.end(); } catch {} });
  });
  const relayPort = await listen(relay);
  t.after(() => { upstream.close(); relay.close(); });

  const html = await (await fetch('http://127.0.0.1:' + relayPort + '/__webcode/site/demo/')).text();
  // bootstrap 必须完整闭合（否则整段脚本不执行，document.createElement 仍是原生的，
  // webpack 懒加载 chunk 会全部打到回环根 404）
  assert.match(html, /<script data-webcode-mirror>[\s\S]*?<\/script>/, 'bootstrap 必须完整闭合');
  assert.match(html, /document\.createElement=/, '必须装上动态资源钩子');
  assert.match(html, /Element\.prototype\.setAttribute=/, '必须装上 setAttribute 钩子');
  assert.match(html, /function isLocalPath/, 'toLocal 需要幂等守卫，避免二次加前缀');
});

test('mirror rootPathForSpa：z.ai 需要把 pathname 改写成根，其他站点不受影响', async (t) => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head></head><body><div id="app"></div></body></html>');
  });
  const upstreamPort = await listen(upstream);
  const make = (rootPathForSpa) => createMirror({
    siteOrigin: 'http://127.0.0.1:' + upstreamPort,
    getToken: async () => null,
    logger: { log() {}, warn() {} },
    mountPrefix: '/__webcode/site/demo',
    rootPathForSpa,
  });
  const serve = async (mirror) => {
    const relay = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://loopback');
      let pathname = url.pathname;
      if (pathname.startsWith('/__webcode/site/demo')) pathname = pathname.slice('/__webcode/site/demo'.length) || '/';
      mirror.handle(req, res, pathname, url.search)
        .then((handled) => { if (!handled) { res.writeHead(404); res.end(); } })
        .catch(() => { try { res.writeHead(500); res.end(); } catch {} });
    });
    const port = await listen(relay);
    const html = await (await fetch('http://127.0.0.1:' + port + '/__webcode/site/demo/')).text();
    relay.close();
    return html;
  };
  t.after(() => upstream.close());

  const on = await serve(make(true));
  assert.match(on, /data-webcode-rootpath/, '开关打开时必须注入根路径修正脚本');
  assert.match(on, /replaceState\(null,''\,'\/'\)/, '修正脚本把 pathname 改成根');

  const off = await serve(make(false));
  assert.doesNotMatch(off, /data-webcode-rootpath/, '默认站点不得注入根路径修正（会破坏 SPA 深链）');
});

