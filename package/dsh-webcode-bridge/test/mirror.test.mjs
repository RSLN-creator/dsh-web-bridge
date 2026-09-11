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
  //    502 = 路由承认并尝试转发；404 才代表「域未声明」。真机可达时是 200。
  const asset = await fetch('http://127.0.0.1:' + relayPort + '/__static/assets.example.com/app/main.js');
  assert.notEqual(asset.status, 404, '声明过的静态域不应被拒绝');
  // 5) 未声明的静态域必须拒绝
  const denied = await fetch('http://127.0.0.1:' + relayPort + '/__static/evil.example.com/x.js');
  assert.equal(denied.status, 404);
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

