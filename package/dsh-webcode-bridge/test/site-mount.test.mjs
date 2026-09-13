// site-mount.test.mjs — 0.12.9 子域挂载与登录判定的护栏。
//
// 这一轮的真机缺陷全部来自「两个浏览器世界」的边界，单测不能替代真机验收
// （见 test-mock/real-mirror-matrix.mjs）。这里锁的是**回归面**：那些一旦被
// 改回去就会静默重现真机症状、而真机矩阵要跑十几分钟才能发现的不变量。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMirror } from '../lib/mirror.js';
import { createWebControl } from '../lib/web-control.js';
import { isLoopbackHost, originMatchesHost } from '../lib/loopback.js';
import { composerStrategy } from '../lib/browser-driver.js';

const logger = { log() {}, warn() {} };
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

test('loopback 判定：IP / localhost / <site>.localhost 回环，其它一律拒绝', () => {
  for (const ok of ['127.0.0.1:8931', '127.0.0.1', '[::1]:8931', 'localhost:8931', 'localhost',
    'doubao.localhost:8931', 'zai.localhost', 'a.b.localhost:1']) {
    assert.equal(isLoopbackHost(ok), true, ok + ' 应判为回环');
  }
  for (const bad of ['evil.example', 'localhost.evil.example', 'notlocalhost',
    '127.0.0.2:8931', '10.0.0.5', 'doubao.local', '', null, undefined]) {
    assert.equal(isLoopbackHost(bad), false, String(bad) + ' 不得判为回环');
  }
  // 同源只认 host（含端口）逐字相等：别的回环端口是另一个应用，不是「我们」
  assert.equal(originMatchesHost('http://doubao.localhost:8931', 'doubao.localhost:8931'), true);
  assert.equal(originMatchesHost('http://127.0.0.1:9999', '127.0.0.1:8931'), false);
  assert.equal(originMatchesHost('javascript:alert(1)', '127.0.0.1:8931'), false);
});

test('mirror 子域形态（mountPrefix 空）：根相对资源不改写，子域 Host 放行', async (t) => {
  // 子域形态下站点就住在根上：把 /main.js 改成 /<prefix>/main.js 反而会打断
  // SPA 的根相对加载。绝对第三方域仍需改写（CORS 非法通配问题与挂载形态无关）。
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head>'
      + '<script src="/main.js"></script>'
      + '<script src="https://cdn.example.com/vendor.js"></script>'
      + '</head><body><div id="app"></div></body></html>');
  });
  const upPort = await listen(upstream);
  const mirror = createMirror({ siteOrigin: `http://127.0.0.1:${upPort}`, logger, mountPrefix: '' });
  const relay = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://loopback');
    mirror.handle(req, res, url.pathname, url.search)
      .then((handled) => { if (!handled) { res.writeHead(404); res.end(); } })
      .catch(() => { try { res.writeHead(500); res.end(); } catch {} });
  });
  const relayPort = await listen(relay);
  t.after(() => { upstream.close(); relay.close(); });

  const viaSubdomain = await fetch(`http://127.0.0.1:${relayPort}/`, { headers: { host: `doubao.localhost:${relayPort}` } });
  assert.equal(viaSubdomain.status, 200);
  const html = await viaSubdomain.text();
  assert.match(html, /src="\/main\.js"/, '子域形态下根相对资源必须原样保留');
  assert.doesNotMatch(html, /__webcode\/site\/doubao\/main\.js/, '不得给根相对资源加路径前缀');
  assert.match(html, /\/__static\/cdn\.example\.com\/vendor\.js/, '绝对第三方域仍要同源转发');

  // 回环名称族之外一律 403（DNS 重绑定防护不得因为加子域而放宽）
  const foreign = await new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: relayPort, path: '/', headers: { host: 'evil.example' } }, resolve);
    req.on('error', reject);
  });
  foreign.resume();
  assert.equal(foreign.statusCode, 403);
});

test('web-control：子域 Origin 不被当成跨站（真机曾 403），外站仍拒', async (t) => {
  // 真机证据（2026-09-13）：右栏站点 iframe 住在 <sid>.localhost:8931，
  // 旧 csrfSafe 的正则只认裸 localhost → 子域上的 /__webcode/* 全被
  // 「cross-site control requests are not allowed」拒掉，面板拿不到任何状态。
  const control = createWebControl({
    driver: { status: () => ({ loggedIn: true }), interact: async () => ({}) },
    relay: null, config: {}, logger,
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://loopback');
    control.handle(req, res, url.pathname).then((handled) => {
      if (!handled) { res.writeHead(404); res.end(); }
    }).catch(() => { try { res.writeHead(500); res.end(); } catch {} });
  });
  const port = await listen(server);
  t.after(() => server.close());

  const call = (headers) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/__webcode/status', method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });

  const sub = await call({ host: `zai.localhost:${port}`, origin: `http://zai.localhost:${port}`, 'sec-fetch-site': 'same-origin' });
  assert.equal(sub.status, 200, '子域同源控制面必须放行：' + sub.body);

  const hostile = await call({ host: `zai.localhost:${port}`, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
  assert.equal(hostile.status, 403, '跨站 Origin 必须仍然拒绝');

  const rebind = await call({ host: 'evil.example', origin: 'http://evil.example' });
  assert.equal(rebind.status, 403, '非回环 Host 必须仍然拒绝');
});

test('web-control：site-probe 区分「可达」与「网络不通」', async (t) => {
  // 右栏据此决定是否挂 iframe（不可达站点挂上去只会是裸错误页，还常驻保活）。
  const up = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><title>ok</title></html>'); });
  const upPort = await listen(up);
  const control = createWebControl({ driver: {}, relay: null, config: {}, logger });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://loopback');
    control.handle(req, res, url.pathname).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } })
      .catch(() => { try { res.writeHead(500); res.end(); } catch {} });
  });
  const port = await listen(server);
  t.after(() => { up.close(); server.close(); });

  const probe = (body) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/__webcode/site-probe', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(JSON.parse(b))); });
    req.on('error', reject);
    req.end(payload);
  });

  const unknown = await probe({ siteId: 'nope' });
  assert.equal(unknown.ok, false);

  const known = await probe({ siteId: 'deepseek' });
  assert.equal(known.ok, true);
  assert.equal(known.siteId, 'deepseek');
  assert.equal(typeof known.reachable, 'boolean', '探活必须给出明确的可达性结论');
});

test('composer 分派：textarea 走 fill，contenteditable 走富文本路径', () => {
  // 真机 2026-09-13：doubao（tiptap）与 kimi（div.chat-input-editor）的输入框
  // 不是 textarea。旧实现一律 input.fill() + inputValue()，对富文本编辑器要么
  // 写不进去、要么回读抛错被判成 PROMPT_TRUNCATED —— 表现就是「打不开/发不出」。
  assert.equal(composerStrategy({ tag: 'textarea', editable: false }), 'field');
  assert.equal(composerStrategy({ tag: 'input', editable: false }), 'field');
  assert.equal(composerStrategy({ tag: 'div', editable: true }), 'editable');
  // 未声明 contenteditable 的 div：仍按富文本处理（fill() 对 div 直接抛错）
  assert.equal(composerStrategy({ tag: 'div', editable: false }), 'editable');
  assert.equal(composerStrategy(null), 'unknown');
});

test('cookie 导入不可用时的报错必须可操作且不被截断', () => {
  // 真机 2026-09-13：Edge 128+ 用 app-bound 加密（v20）把 cookie 密钥绑定到 Edge
  // 应用身份，复制 profile 后 storageState 返回 0 枚 cookie —— 「导入本机登录态」
  // 在本机不可能成功。它会静默返回 loggedIn:false，看起来像「导入成功但没登录」。
  // 因此驱动的报错必须：① 说清为什么；② 给出替代动作；③ 短到不被控制面截断
  //（web-control 把错误截到 200 字符，可操作的那句必须在前面）。
  const msg = 'cookie 无法解密：Edge 128+ 用 app-bound 加密（v20）把密钥绑定到 Edge 应用身份，复制 profile 读不出任何 cookie。请改用该站点的「登录」按钮——弹出的真实 Edge 窗口里登录一次即可，登录态会持久保存在桥自己的 profile 里。';
  assert.ok(msg.length <= 200, `报错会被截断（${msg.length} > 200 字符），用户看不到可操作建议`);
  assert.match(msg, /无法解密/, '必须说明原因');
  assert.match(msg, /「登录」按钮/, '必须给出替代动作');
});

test('web-control：session-import 按站点路由，失败原因是可读错误', async (t) => {
  // 真机背景：桥 profile 里除 deepseek 外没有任何站点 cookie，导入是唯一通路。
  // sessionImport 挂在 relay.config 上（与 login/window 同一层注入）。
  const calls = [];
  const control = createWebControl({
    driver: {}, config: {}, logger,
    relay: { config: { sessionImport: async (siteId, dir) => { calls.push([siteId, dir]); return { loggedIn: true }; } } },
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://loopback');
    control.handle(req, res, url.pathname).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } })
      .catch(() => { try { res.writeHead(500); res.end(); } catch {} });
  });
  const port = await listen(server);
  t.after(() => server.close());

  const post = (body) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/__webcode/session-import', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b) })); });
    req.on('error', reject);
    req.end(payload);
  });

  // 不存在的源目录：必须回可读原因（面板直接显示），且不触发导入
  const missing = await post({ siteId: 'glm', sourceProfileDir: 'Z:\\definitely\\not\\here' });
  assert.equal(missing.body.ok, false);
  assert.match(String(missing.body.error), /不存在|不可访问/);
  assert.equal(calls.length, 0, '源目录不存在时不得调用导入');

  const src = process.env.LOCALAPPDATA || process.cwd();
  const ok = await post({ siteId: 'glm', sourceProfileDir: src });
  assert.equal(ok.body.ok, true);
  // 站点 id 必须原样透传（这是「按站点路由」的契约：旧实现写死默认驱动，
  // 对 glm 调用会去改 DeepSeek 的登录态 —— 站点串号）。
  assert.deepEqual(calls[0], ['glm', src]);
  assert.equal(ok.body.siteId, 'glm');
});