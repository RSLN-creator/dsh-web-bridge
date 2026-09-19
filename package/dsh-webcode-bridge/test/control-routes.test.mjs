// control-routes.test.mjs — 控制面「路由可达性」护栏（0.13.0）。
//
// 这一轮的用户症状是「设置面板每个『检测』都报
// JSON.parse: unexpected end of data at line 1 column 1」。
// 真机取证（2026-09-13，对运行中的 GUI 做真实 HTTP 探针）：
//
//   POST /__webcode/connect         -> 200 JSON
//   POST /__webcode/settings        -> 200 JSON
//   POST /__webcode/verify-login    -> 405，body 长度 0   ← 「检测」按钮
//   POST /__webcode/site-probe      -> 405，body 长度 0
//   POST /__webcode/session-import  -> 405，body 长度 0   ← 「导入本机登录态」
//
// 根因：lib/web-control.js 的 action 表里有这三个，但 lib/index.js 里**手写**的
// 挂载数组漏了它们（只注册了 13 个旧后缀）。请求落到 DSH webServer 的未知 POST
// 兜底 → 405 + 空 body → 客户端 `await response.json()` 抛解析错误，真实状态码
// 被整个吞掉。
//
// 本文件锁三件事，任何一条被改回去都会在这里红：
//   1. action 表 → 挂载清单是派生的（index.js 不再手写第二份）。
//   2. 表里每个 suffix 在进程内分派器上真的可达（不是 404/405）。
//   3. 未知方法回 405 JSON、未知路径回 false（由调用方补 404 JSON）——
//      **永不再有空 body**：空 body 正是那句无意义解析错误的来源。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWebControl, routeIndex, controlRoutes } from '../lib/web-control.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const logger = { log() {}, warn() {} };
// 0.16.9：等 `listening` 事件后**重读** `address()`，并在拿到 null/越界端口时重试。
// `server.listen(0, host, cb)` 的回调在某些平台上可能早于地址可用（并发负载下实测
// 读到 null）。夹具的职责是「给出一个能连的端口」，不是「把 null 传下去让 fetch 报
// bad port」——后者会把夹具缺陷伪装成产品路由缺陷。
const listen = (server, attempts = 20) => new Promise((resolve, reject) => {
  const tryOnce = (n) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address()?.port;
      if (Number.isInteger(port) && port > 0 && port <= 65535) return resolve(port);
      server.close(() => {
        if (n <= 0) return reject(new Error('listen：反复拿不到可用端口（最后一次=' + JSON.stringify(port) + '）'));
        tryOnce(n - 1);
      });
    });
    server.once('error', reject);
  };
  tryOnce(attempts);
});

/** 最小可用的 deps：每个 action 要么直接成功，要么走到一个明确的桩。 */
function stubControl() {
  const noop = async () => ({ ok: true, stub: true });
  const driver = {
    connect: noop,
    interact: noop,
    diagnostics: async () => ({ controls: [], urlPath: null, transport: 'stub', preview: false, siteId: 'deepseek' }),
    listSessions: async () => ({ ok: true, sessions: [] }),
    fetchHistory: async () => ({ ok: true, messages: [] }),
    status: () => ({ running: false, busy: false, loggedIn: null, conversations: {} }),
  };
  const relay = {
    status: () => ({ running: true, consent: true, busy: false, queueLength: 0, activeRequests: 0, lastError: '', metrics: null }),
    setConsent() {},
    config: {
      driverStatus: () => ({ siteId: 'deepseek', sites: [], window: null }),
      siteConnect: () => ({ connect: async () => ({ ok: true, loggedIn: true }) }),
      loginAndReport: async (siteId) => ({ ok: true, siteId, loggedIn: true, ms: 1 }),
      windowOpener: async () => ({ ok: true }),
      sessionImport: async () => ({ ok: true, loggedIn: false }),
    },
  };
  return createWebControl({
    driver, relay, config: {}, host: {}, logger,
    presetInfo: () => null,
    settingsStore: { get: () => ({}), set: (v) => v },
  });
}

/** 打一个真实 HTTP 请求到进程内的控制面，返回 {status, ctype, text}。 */
async function call(control, method, pathname, body) {
  const server = http.createServer((req, res) => {
    control.handle(req, res, pathname).then((handled) => {
      if (handled) return;
      const text = JSON.stringify({ ok: false, error: 'no route: ' + pathname });
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
      res.end(text);
    }).catch(() => { try { res.writeHead(500).end(); } catch { /* closed */ } });
  });
  const port = await listen(server);
  // 0.16.9：`server.address().port` 在并发负载下偶发读到 **null**（全量测试并行时
  // 抓到的现场是 `TypeError: fetch failed` / `cause: Error: bad port`）。null 拼进
  // URL 就是 `http://127.0.0.1:null/...`，undici 判为 bad port —— 症状看起来像
  // 「路由 404 了」，真因却是「端口没读出来」。这条 flake 与产品代码无关：用
  // HEAD 版本的 lib/web-control.js 跑同一文件同样会红（实测基线 3/5 失败），
  // 所以它是**既有**的测试夹具缺陷，不是本轮改动引入的。
  // 判据必须是「拿到一个可用的端口」，拿不到就当场说清，不要让它伪装成路由失败。
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    await new Promise((r) => server.close(r));
    throw new Error('测试夹具拿不到可用端口：server.address().port=' + JSON.stringify(port));
  }
  try {
    const r = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, ctype: r.headers.get('content-type') || '', text };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('routeIndex / controlRoutes：表里的每个 suffix 都进挂载清单', () => {
  const control = stubControl();
  const index = routeIndex(control.actions);
  const routes = controlRoutes(control.actions);
  assert.deepEqual(routes, [...index.keys()], 'routes 必须就是 routeIndex 的键序');
  // 这就是当初漏掉的那三个 —— 它们必须在清单里，否则设置面板的按钮全废。
  for (const suffix of ['verify-login', 'site-probe', 'session-import']) {
    assert.ok(index.has(suffix), `挂载清单必须包含 ${suffix}`);
  }
  assert.equal(index.get('verify-login').has('POST'), true);
  assert.equal(index.get('site-probe').has('POST'), true);
  assert.equal(index.get('session-import').has('POST'), true);
  // 同一个 suffix 的多方法（window 既有 GET 又有 POST）必须合并成一个键，
  // 否则宿主会为同一路径注册两次、其中一次的 405 分支会互相遮蔽。
  assert.deepEqual([...index.get('window')].sort(), ['GET', 'POST']);
  assert.equal(routes.filter((s) => s === 'window').length, 1, 'suffix 必须去重');
});

test('lib/index.js 的挂载清单从控制面派生，不再手写第二份', () => {
  const src = fs.readFileSync(path.join(here, '..', 'lib', 'index.js'), 'utf8');
  assert.match(src, /webControl\.routes/, 'index.js 必须遍历 webControl.routes');
  // 旧写法的手写数组：`['login-sites', 'login-sites']` 这种二元组列表。
  // 它正是漏挂载的载体，必须彻底消失。
  assert.doesNotMatch(src, /\['login-sites',\s*'login-sites'\]/, '不得恢复手写 routes 数组');
  assert.doesNotMatch(src, /const routes = \[\s*\n\s*\['status',\s*'status'\]/, '不得恢复手写 routes 数组');
  // 未知路由必须补 404 **JSON**，而不是空 body。
  assert.match(src, /no route: \/__webcode\//, '未知路由必须回 JSON 404');
});

test('表里每个 action 都能被真实 HTTP 请求命中（不是 404/405）', async () => {
  const control = stubControl();
  const index = routeIndex(control.actions);
  const failures = [];
  for (const [suffix, methods] of index) {
    for (const method of methods) {
      // 带 body 的 POST 端点：给一个最小的、类型合法的 body。
      const body = method === 'POST' ? { siteId: 'deepseek', sessionId: '', count: 1 } : undefined;
      const r = await call(control, method, '/__webcode/' + suffix, body);
      if (r.status === 404 || r.status === 405) {
        failures.push(`${method} /__webcode/${suffix} -> ${r.status}`);
        continue;
      }
      // 关键断言：**任何**响应体都不能为空，且必须是 JSON。
      assert.notEqual(r.text.length, 0, `${method} ${suffix} 响应体不得为空`);
      assert.match(r.ctype, /application\/json/, `${method} ${suffix} 必须回 JSON`);
      const parsed = JSON.parse(r.text);            // 空了/不是 JSON 就会在这里炸
      assert.equal(typeof parsed, 'object');
    }
  }
  assert.deepEqual(failures, [], '这些 action 在挂载清单里却不可达：\n' + failures.join('\n'));
});

// B-3（0.14.1）：窗口声明必须可核对。此前「桥声明的上下文窗口」只存在于代码里，
// 用户在 GUI 上看到的占用百分比是相对一个看不见的数，越界报错也说不清比的是哪个值。
test('GET context-windows 列出每个站点的声明窗口与来源（B-3）', async () => {
  const control = stubControl();
  const r = await call(control, 'GET', '/__webcode/context-windows');
  assert.equal(r.status, 200);
  const body = JSON.parse(r.text);
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.sites) && body.sites.length > 0, '应逐站点列出');
  const ids = body.sites.map((s) => s.siteId);
  assert.ok(ids.includes('glm') && ids.includes('zai'), 'glm/zai 必须在列（本轮的声明改动对象）');
  // 同站点各模型的声明值必须一致——不一致本身就是信号，consistent 字段如实标注
  for (const s of body.sites) {
    assert.equal(typeof s.consistent, 'boolean', `${s.siteId} 必须给出 consistent`);
    assert.ok(Array.isArray(s.sources) && s.sources.length > 0, `${s.siteId} 必须给出 source`);
  }
  // 逐模型明细也在（面板可以下钻）
  assert.ok(Array.isArray(body.models) && body.models.length > 0, '应含逐模型明细');
  for (const m of body.models) assert.ok('contextWindow' in m, `${m.id} 必须带 contextWindow`);
});

// 0.16.24：在途等待必须经**真实 HTTP 载荷**透出（药丸按它决定显示什么、多久问一次）。
//
// 这层是 index.js 与 client.cjs 之间的唯一接口，而它此前只被「响应体非空」那条
// 泛化护栏扫过——字段名写错（liveValue / live / now）在泛化护栏下完全无声：药丸
// 只会安静地回落到账本，观感退化成「等完才跳一下」，而那正是本轮要修的东西。
test('POST wait-stats：在途等待透出 live/now/liveValue，且药丸文案取正在涨的那个数', async () => {
  const NOW = 1_789_000_003_000;
  const control = createWebControl({
    driver: { status: () => ({}) }, relay: { status: () => ({}) },
    config: {}, host: {}, logger,
    presetInfo: () => null,
    settingsStore: { get: () => ({}), set: (v) => v },
    // 本会话账本已有 12 秒历史；在途那一段才刚开始 3 秒。
    waitStatsOf: (sessionId) => ({
      total: { totalWaitMs: 20000, turns: 9, waitedTurns: 4, rateLimitRetries: 1 },
      session: sessionId ? { totalWaitMs: 12000, turns: 2, waitedTurns: 1, rateLimitRetries: 0 } : null,
      live: { startedAt: NOW - 3000, endsAt: NOW + 7000, baseMs: 0, kind: 'gap' },
      now: NOW,
    }),
  });
  const r = await call(control, 'POST', '/__webcode/wait-stats', { sessionId: 'sess-1' });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.text);
  assert.equal(body.ok, true);
  // 0.16.26：药丸是「本会话等待发送总量」的投影 = 账本 12 s + 在途 3 s = 15 s。
  // 旧断言（3 s）钉的是 0.16.24 的语义切换：等的时候只显示这一段，等一结束
  // 就跳回账本 12 s —— 那正是用户报的跳变。一个数、一个来源之后才不会跳。
  assert.equal(body.label, '等待发送 15 s');
  // 面板那一行**仍然只给在途那一段**：它是「正在等待发送」这个标签下的增量，
  // 与药丸的会话总量是两个不同的问题，各自如实回答。
  assert.equal(body.liveValue, '3 s', '面板的「正在等待发送」行取同一套边界');
  // 客户端据此判断要不要把轮询提到 1 秒；缺了它就只能 10 秒一问。
  assert.ok(body.live && typeof body.live === 'object', '在途时必须给 live 供客户端判断');
  assert.equal(body.live.startedAt, NOW - 3000);
  // now 必须与文案同源：客户端不知道它是服务端时刻的话，秒级取整下两个数会差一格。
  assert.equal(body.now, NOW);
});

test('POST wait-stats：无在途时 live/liveValue 为 null（回落账本，不留幽灵读数）', async () => {
  const control = createWebControl({
    driver: { status: () => ({}) }, relay: { status: () => ({}) },
    config: {}, host: {}, logger,
    presetInfo: () => null,
    settingsStore: { get: () => ({}), set: (v) => v },
    waitStatsOf: () => ({
      total: { totalWaitMs: 20000, turns: 9, waitedTurns: 4, rateLimitRetries: 0 },
      session: { totalWaitMs: 12000, turns: 2, waitedTurns: 1, rateLimitRetries: 0 },
      live: null,
      now: 1_789_000_003_000,
    }),
  });
  const r = await call(control, 'POST', '/__webcode/wait-stats', { sessionId: 'sess-1' });
  const body = JSON.parse(r.text);
  assert.equal(body.live, null, '等待结束后必须清掉 live，否则药丸会停在冻结值上');
  assert.equal(body.liveValue, null);
  // 结算后回落到账本（12 s）——不能出现「等待结束了药丸反而变空」。
  assert.equal(body.label, '等待发送 12 s');
});

// 0.16.24：药丸「开始就涨」的前半段在 index.js——**等待一开始**就发布 live，
// 而不是等账本结算。这一半无法用载荷测试覆盖（apply() 只回 disposer，测试
// 拿不到内部注册表），所以照本仓库既有纪律用源码护栏钉住调用顺序与收尾。
test('index.js：等待开始即发布 live，且每条路径都在 finally 里清掉', () => {
  const src = fs.readFileSync(path.join(here, '..', 'lib', 'index.js'), 'utf8');
  assert.match(src, /function beginLiveWait\(/, '必须有发布在途等待的入口');
  assert.match(src, /function clearLiveWait\(/, '必须有清理在途等待的入口');
  // 发布点必须在 await sleepSignal **之前**：放到之后就成了「等完才说在等」，
  // 观感与旧实现（等完才跳一下）完全一样。
  const gapPublish = src.indexOf("beginLiveWait(m, accountKey, 'gap'");
  assert.ok(gapPublish > 0, '发送间隔等待必须发布 live');
  assert.match(src, /function liveWaitOf\(/, '控制面必须能读到在途等待');
  // 清理必须成对出现：限流退避那条路径也要清（只清一条会留下冻结的幽灵读数）。
  // 两种调用形态都算：等待路径传本轮 meta（m），结算路径传回调进来的 meta。
  const clears = src.match(/clearLiveWait\((?:m|meta)\)/g) || [];
  assert.ok(clears.length >= 3, `清理点至少 3 处（间隔等待/退避/结算），当前 ${clears.length}`);
  assert.match(src, /beginLiveWait\(m, accountKey, 'rate-limit'/,
    '限流退避必须也发布 live，并带 baseMs 接着涨（不是从 0 重来）');
  // 结算时必须让位：否则 live 会一直盖住刚落账的累计值。
  // 用**位置**判定而不是跨行正则：本文件是 CRLF，`\n` 形状的正则在这里匹配不上
  //（写错了会静默变成「永远失败」或「永远命中」，两种都是假结论）。
  const settle = src.indexOf('function recordWaitMetrics(metrics, meta)');
  assert.ok(settle > 0, '找不到 recordWaitMetrics');
  const settleClear = src.indexOf('clearLiveWait(meta)', settle);
  const settleAccum = src.indexOf('accumulateWait(waitStats.total', settle);
  assert.ok(settleClear > 0, 'recordWaitMetrics 必须清 live');
  assert.ok(settleClear < settleAccum, 'recordWaitMetrics 必须**先**清 live，再累加账本');
});

test('未知方法回 405 JSON（带 Allow），未知路径回 false 由调用方补 404 JSON', async () => {
  const control = stubControl();
  // 路径存在、方法不对：必须是 405 + 非空 JSON body。
  const wrong = await call(control, 'POST', '/__webcode/models');
  assert.equal(wrong.status, 405);
  assert.notEqual(wrong.text.length, 0, '405 不得是空 body —— 空 body 正是那句 JSON 解析错误的来源');
  const parsed = JSON.parse(wrong.text);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /method not allowed/);
  assert.match(parsed.error, /GET/, '405 必须告诉调用方允许什么方法');

  // 路径不存在：handle() 返回 false（调用方负责写 404 JSON）。
  const server = http.createServer((req, res) => {
    control.handle(req, res, '/__webcode/definitely-not-a-route').then((handled) => {
      assert.equal(handled, false, '未知路径必须交回调用方');
      const text = JSON.stringify({ ok: false, error: 'no route' });
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(text);
    }).catch(() => { try { res.end(); } catch { /* closed */ } });
  });
  const port = await listen(server);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/__webcode/definitely-not-a-route`, { method: 'POST' });
    assert.equal(r.status, 404);
    assert.notEqual((await r.text()).length, 0);
  } finally {
    await new Promise((r) => server.close(r));
  }
});