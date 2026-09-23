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
import os from 'node:os';
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

// Task 2.3：展示口径与预算口径字段级分开，端点如实投影二者，且 contextWindow 保留兼容。
test('context-windows 分开投影 displayContext 与 sendBudget（B-3 → Task 2.3）', async () => {
  const control = stubControl();
  const r = await call(control, 'GET', '/__webcode/context-windows');
  const body = JSON.parse(r.text);
  assert.equal(body.ok, true);
  for (const m of body.models) {
    assert.ok('displayContext' in m, `${m.id} 必须投影展示口径 displayContext`);
    assert.ok('sendBudget' in m, `${m.id} 必须投影预算口径 sendBudget`);
    // 语义分离但值上当前一致（providers budget 初值 = context），是设计如此。
    if (m.displayContext != null && m.sendBudget != null) {
      assert.equal(m.sendBudget, m.contextWindow, `${m.id}: sendBudget 应作为 contextWindow 的语义别名`);
    }
  }
  // glm/zai 是声明的改写对象：二者都应给出值，且预算值可核对。
  for (const id of ['glm:glm-5.3', 'glm:auto', 'zai:glm-5.3', 'zai:auto', 'deepseek:deepseek']) {
    const row = body.models.find((m) => m.id === id);
    assert.ok(row, `应有 ${id}`);
    assert.ok(typeof row.sendBudget === 'number' && row.sendBudget > 0, `${id}: sendBudget 应为正数，实际 ${row.sendBudget}`);
    assert.ok(typeof row.displayContext === 'number' && row.displayContext > 0, `${id}: displayContext 应为正数`);
  }
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
      total: { totalWaitMs: 20000, totalDurationMs: 60000, durationTurns: 9, turns: 9, waitedTurns: 4, rateLimitRetries: 1 },
      session: sessionId ? { totalWaitMs: 12000, totalDurationMs: 45000, durationTurns: 2, turns: 2, waitedTurns: 1, rateLimitRetries: 0 } : null,
      live: { startedAt: NOW - 3000, endsAt: NOW + 7000, baseMs: 0, kind: 'gap' },
      now: NOW,
    }),
  });
  const r = await call(control, 'POST', '/__webcode/wait-stats', { sessionId: 'sess-1' });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.text);
  assert.equal(body.ok, true);
  // 0.16.26：药丸是「本会话等待发送总量」的投影 = 账本 12 秒 + 在途 3 秒 = 15 秒。
  // 0.17.0：格式调整为「15 秒 · 等待占比 25%」（总耗时 15s wait + 45s duration = 60s）。
  assert.equal(body.label, '15 秒 · 等待占比 25%');
  // 面板那一行**仍然只给在途那一段**：它是「正在等待发送」这个标签下的增量，
  // 与药丸的会话总量是两个不同的问题，各自如实回答。
  assert.equal(body.liveValue, '3 秒', '面板的「正在等待发送」行取同一套边界');
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
      total: { totalWaitMs: 20000, totalDurationMs: 60000, durationTurns: 9, turns: 9, waitedTurns: 4, rateLimitRetries: 0 },
      session: { totalWaitMs: 12000, totalDurationMs: 48000, durationTurns: 2, turns: 2, waitedTurns: 1, rateLimitRetries: 0 },
      live: null,
      now: 1_789_000_003_000,
    }),
  });
  const r = await call(control, 'POST', '/__webcode/wait-stats', { sessionId: 'sess-1' });
  const body = JSON.parse(r.text);
  assert.equal(body.live, null, '等待结束后必须清掉 live，否则药丸会停在冻结值上');
  assert.equal(body.liveValue, null);
  // 结算后回落到账本（12 秒）——不能出现「等待结束了药丸反而变空」。
  // 0.17.0：格式改为「12 秒 · 等待占比 20%」（12s / (12s + 48s) = 20%）。
  assert.equal(body.label, '12 秒 · 等待占比 20%');
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

// 0.16.38：站点级设置与提示词文件。三条都是本轮新增的载荷契约，必须经**真实
// HTTP** 覆盖——它们是设置页与后端之间的唯一接口，字段名写错在泛化护栏下无声。
test('POST settings：站点级字典归一化（未知站点丢弃、跨站点模型丢弃、空指令删键）', async () => {
  let saved = null;
  const control = createWebControl({
    driver: { status: () => ({}) }, relay: { status: () => ({}) },
    config: {}, host: {}, logger,
    presetInfo: () => null,
    settingsStore: { get: () => ({}), set: (v) => { saved = v; return v; } },
  });
  const r = await call(control, 'POST', '/__webcode/settings', {
    defaultModelBySite: {
      deepseek: 'deepseek:deepseek',
      glm: 'deepseek:deepseek',      // 跨站点 → 丢弃
      nope: 'nope:auto',             // 未知站点 → 丢弃
    },
    extraPromptBySite: {
      deepseek: '  只答中文  ',
      glm: '',                        // 空 → 删键
      nope: 'x',                      // 未知站点 → 丢弃
    },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(saved.defaultModelBySite, { deepseek: 'deepseek:deepseek' },
    '站点级默认模型只接受落在同一站点的值');
  assert.deepEqual(saved.extraPromptBySite, { deepseek: '只答中文' },
    '站点指令必须 trim，且空串表示「没配」而不是「配了空值」');
});

test('POST account-add：「新账号」必须由服务端分配下一个空槽，且不动既有槽', async () => {
  // 用户指令（0.19.4）：「一个网址可以多个账号，多个对话」。下拉底部那行「新账号」
  // 点下去要为该站点加一个槽——**槽位合法性只有 accounts.js 说了算**，
  // 面板自己算「下一个空槽」必然长出第二套规则（`default` 的规范名、`#1` 是别名）。
  let saved = null;
  const control = createWebControl({
    driver: { status: () => ({}) }, relay: { status: () => ({}) },
    config: {}, host: {}, logger,
    presetInfo: () => null,
    settingsStore: { get: () => ({ accounts: [{ siteId: 'glm', slot: '2', enabled: true }] }), set: (v) => { saved = v; return v; } },
  });
  const r = await call(control, 'POST', '/__webcode/account-add', { siteId: 'glm' });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.text);
  assert.equal(body.ok, true);
  assert.equal(body.slot, '3', '已占用 2 时必须给 3（不是覆盖 2）');
  assert.equal(body.accountKey, 'glm#3', 'accountKey 必须是 accounts.js 的规范形状');
  assert.ok(saved, '必须落进设置（只回一个 key 而不保存＝界面上多一行、驱动解析不到）');
  assert.ok(saved.accounts.some((a) => a.siteId === 'glm' && a.slot === '2' && a.enabled === true),
    '既有槽必须原样保留（新账号是「增加」不是「替换」）');
  assert.ok(saved.accounts.some((a) => a.siteId === 'glm' && a.slot === '3'),
    '新槽必须写进 accounts');
  // 未知站点必须**明确失败**：悄悄建一个永远解析不了的槽，症状会推迟到用户点它时才出现。
  const bad = JSON.parse((await call(control, 'POST', '/__webcode/account-add', { siteId: 'nope' })).text);
  assert.equal(bad.ok, false, '未知站点必须报错');
});

test('POST account-identity：读不到驱动时如实失败，绝不返回伪造昵称', async () => {
  // 用户口径是「抓真实值 + 抓不到回落槽名」。这条钉住「抓不到」那半边：
  // 服务端必须说「没有」，而不是编一个名字——界面靠这个 null 回落成槽名。
  const control = createWebControl({
    driver: { status: () => ({}) }, relay: { status: () => ({}) },
    config: {}, host: {}, logger,
    presetInfo: () => null,
    settingsStore: { get: () => ({}), set: (v) => v },
  });
  const body = JSON.parse((await call(control, 'POST', '/__webcode/account-identity', { siteId: 'glm' })).text);
  assert.equal(body.ok, false, '没有驱动时必须明确失败');
  assert.equal(body.name, undefined, '失败时不得给出任何名字（伪造昵称比没有昵称更糟）');
});

test('GET settings：两个站点级字典永远回对象，不回 undefined', async () => {
  const control = createWebControl({
    driver: { status: () => ({}) }, relay: { status: () => ({}) },
    config: {}, host: {}, logger,
    presetInfo: () => null,
    // 从未保存过这两个键的设置文件形态。
    settingsStore: { get: () => ({ extraPrompt: '' }), set: (v) => v },
  });
  const body = JSON.parse((await call(control, 'GET', '/__webcode/settings')).text);
  assert.deepEqual(body.defaultModelBySite, {}, '未保存过时必须回空对象（前端据此渲染「跟随主线」）');
  assert.deepEqual(body.extraPromptBySite, {});
});

test('POST prompt-file：路径只由 siteId 派生，且缺文件如实报码（不接受调用方传路径）', async () => {
  const opened = [];
  const control = createWebControl({
    driver: { status: () => ({}) }, relay: { status: () => ({}) },
    config: {}, host: {}, logger,
    presetInfo: () => null,
    settingsStore: { get: () => ({}), set: (v) => v },
    openPath: async (p) => { opened.push(p); return { ok: true }; },
  });
  // 未知站点：直接拒，不得去碰磁盘。
  const bad = JSON.parse((await call(control, 'POST', '/__webcode/prompt-file', { siteId: 'nope' })).text);
  assert.equal(bad.ok, false);
  // 已知站点但文件还没生成（本机不一定有该文件）：必须回 PROMPT_FILE_MISSING 与**路径**。
  const miss = JSON.parse((await call(control, 'POST', '/__webcode/prompt-file', { siteId: 'deepseek' })).text);
  if (miss.ok) {
    // 本机恰好有该文件：那就必须真的走了 openPath，且路径在 prompts/ 下。
    assert.equal(opened.length, 1);
    assert.match(opened[0], /prompts[\\/]deepseek\.md$/);
  } else {
    assert.equal(miss.code, 'PROMPT_FILE_MISSING', '缺文件必须如实报码，不得静默失败');
    assert.match(miss.file, /prompts[\\/]deepseek\.md$/, '路径必须由服务端按 siteId 现算');
    assert.equal(opened.length, 0, '文件不存在时不得调用打开');
  }
  // 关键安全性质：请求体里塞路径也不生效——路径只从 siteId 来。
  const inject = JSON.parse((await call(control, 'POST', '/__webcode/prompt-file', {
    siteId: 'glm', path: 'C:\\Windows\\System32\\drivers\\etc\\hosts', file: '/etc/passwd',
  })).text);
  if (!inject.ok) assert.match(inject.file || '', /prompts[\\/]glm\.md$/);
  for (const p of opened) assert.match(p, /prompts[\\/](deepseek|glm)\.md$/, '打开过的路径必须落在 prompts/ 下');
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

// ── 0.17.3：任务看板控制面（第三轮补的路由级护栏）──────────────────────────────
//
// 为什么必须在这一层测：`client-server-contract.test.mjs` 只查「动作名对不对得上」，
// 查不出「路由存在但行为错」。0.17.3 的这批端点此前**一条路由级断言都没有**
// ——全量 867 条里没有任何一条真的 POST 到 `/__webcode/task-*`。
//
// 这一条同时钉住第三轮自审抓到的两个真实缺陷：
//   · 批注写路径的 CAS 必须真的生效（此前 `expectedRevision` 传进函数后被静默吞掉）；
//   · `task-implement` 只组装指令，必须如实标 `dispatched: false`，不许假装已派发。
test('★ 0.17.3 任务看板端点：真实 HTTP 走通 建→批注→解决→改(CAS)→实施→删除，并如实报错', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwb-task-'));
  const sent = [];
  // 会话槽夹具：只有 `task-session-t1` 是**已存在**的可续会话，其余键在槽里没有。
  // 这张表正是「fresh 该取什么」的判据所在（见下面 ⑥ 的三条断言）。
  const store = new Map([['task-session-t1', { webSessionId: 'web-existing-1' }]]);
  const control = createWebControl({
    driver: {
      sendTurn: async (key, message, opts) => { sent.push({ key, message, opts }); return { text: 'stub-reply' }; },
      conversationFor: (key) => store.get(String(key || 'main')) || null,
      status: () => ({ running: true, busy: false, loggedIn: true, conversations: {} }),
    },
    relay: {
      status: () => ({ running: true, consent: true, busy: false, queueLength: 0, activeRequests: 0, lastError: '', metrics: null }),
      setConsent() {},
      config: {},
    },
    config: {}, host: {}, logger,
    presetInfo: () => null,
    settingsStore: { get: () => ({}), set: (v) => v },
  });
  const post = async (p, b) => JSON.parse((await call(control, 'POST', '/__webcode/' + p, b)).text);
  try {
    // ① 建 —— 必须真写盘，不是只回一个包
    const created = await post('task-create', {
      workspaceRoot: root,
      subject: '第三轮端到端任务',
      description: '证明写路径真的落盘',
      assignedModel: { siteId: 'glm', accountSlot: 1, modelId: 'glm-5.3' },
      projectId: 'r3',
    });
    assert.equal(created.ok, true, '创建必须成功：' + JSON.stringify(created));
    const id = created.task.id;
    assert.equal(created.task.assignedModel.siteId, 'glm');
    assert.equal(created.task.projectId, 'r3');
    assert.equal(fs.existsSync(path.join(root, '.webcode-tasks', 'ledger.json')), true,
      '创建必须真写盘：文件不在就说明只改了内存副本，重启即丢');

    // ② 批注
    const c1 = await post('task-comment', { workspaceRoot: root, taskId: id, text: '请加验证码', quote: '登录表单' });
    assert.equal(c1.ok, true, JSON.stringify(c1));
    const cid = c1.comment.id;
    assert.equal(c1.comment.resolved, false);
    assert.equal(c1.comment.quote, '登录表单');

    // ②b 空文本必须如实拒，不许静默成功
    const empty = await post('task-comment', { workspaceRoot: root, taskId: id, text: '   ' });
    assert.equal(empty.ok, false);
    assert.equal(empty.error, 'empty-comment-text');

    // ②c CAS：过期 revision 批注必须拒（第三轮抓到的真缺陷）
    const stale = await post('task-comment', { workspaceRoot: root, taskId: id, text: '并发写入', expectedRevision: 999 });
    assert.equal(stale.ok, false, '过期 revision 必须拒 —— 静默覆盖会让前一个人的批注无声消失');
    assert.match(String(stale.error), /revision-mismatch/);

    // ③ 解决批注
    const rs = await post('task-comment-resolve', { workspaceRoot: root, taskId: id, commentId: cid });
    assert.equal(rs.ok, true, JSON.stringify(rs));
    assert.equal(rs.comment.resolved, true);

    // ④ 改状态 + CAS
    const up = await post('task-update', { workspaceRoot: root, taskId: id, patch: { status: 'in_progress' } });
    assert.equal(up.ok, true, JSON.stringify(up));
    const upStale = await post('task-update', {
      workspaceRoot: root, taskId: id, patch: { status: 'completed' }, expectedRevision: 0,
    });
    assert.equal(upStale.ok, false);
    assert.match(String(upStale.error), /revision-mismatch/);

    // ⑤ 实施：只组装、不派发，且必须如实说（此前谎报 dispatched:true 而客户端不发）
    const impl = await post('task-implement', {
      workspaceRoot: root, taskId: id, commentText: '按批注改', quote: '登录表单',
    });
    assert.equal(impl.ok, true, JSON.stringify(impl));
    assert.equal(impl.dispatched, false, 'task-implement 只组装指令：不得谎报已派发');
    assert.equal(impl.dispatchBy, 'client', '派发方必须是可核对的字段，不是注释里的一句话');
    assert.match(impl.prompt, /第三轮端到端任务/);
    assert.match(impl.prompt, /按批注改/);
    assert.match(impl.prompt, /登录表单/);
    assert.equal(sent.length, 0, '组装阶段不得替用户发消息');

    // ⑤b 未知任务必须如实拒
    const implBad = await post('task-implement', { workspaceRoot: root, taskId: 't999' });
    assert.equal(implBad.ok, false);
    assert.equal(implBad.error, 'task-not-found');

    // ⑥ chat：真的投递到 driver，且会话键语义正确
    //
    // 两条路径必须**分开**验 —— 0.17.3 第三轮真机缺陷正是把二者混为一谈：
    //   • 槽里**有**这个会话 → resume（fresh=false），保住任务上下文；
    //   • 槽里**没有**（全新 sessionKey）→ 必须 fresh=true 开新会话。
    //     若错判成 resume，驱动的 url-heal（browser-driver.js:2624）会把这个新键
    //     采纳成「页面当前正开着的那个会话」，任务指令就被发进用户自己的对话里。
    //     真机现场（2026-09-22 实测）：`task-session-t3-…` 与 `session-0f9fe6cf-…`
    //     的 `landedId` 同为 `37820be9-…`，`chat` 读回的「回复」是用户上一条
    //     消息的原文。
    const chat1 = await post('chat', { siteId: 'deepseek', prompt: '你好', sessionKey: 'task-session-t1' });
    assert.equal(chat1.ok, true, JSON.stringify(chat1));
    assert.equal(chat1.reply, 'stub-reply');
    assert.equal(chat1.sessionKey, 'task-session-t1');
    assert.equal(chat1.resumed, true, '槽里有该会话：必须如实报告为续接');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].key, 'task-session-t1');
    assert.equal(sent[0].opts.fresh, false,
      '槽里有会话才 resume；fresh 会把任务上下文每轮清掉，「以任务为核心」就断了');

    // ★ 本条就是真机缺陷的护栏：全新键必须 fresh=true，不得续到别人的页面上。
    const chatNew = await post('chat', { siteId: 'deepseek', prompt: '新会话', sessionKey: 'task-session-never-used' });
    assert.equal(chatNew.ok, true, JSON.stringify(chatNew));
    assert.equal(chatNew.resumed, false);
    assert.equal(sent[1].key, 'task-session-never-used');
    assert.equal(sent[1].opts.fresh, true,
      '槽里没有的会话键必须 fresh=true —— 否则驱动 url-heal 会把它采纳成当前页面所在的会话，'
      + '把任务指令发进用户自己的对话（真机 2026-09-22 实测）');

    const chat2 = await post('chat', { siteId: 'deepseek', prompt: '匿名会话' });
    assert.equal(sent[2].opts.fresh, true, '没有指定会话时才 fresh');
    assert.match(String(sent[2].key), /^chat-deepseek-/);

    // ⑦ 空 prompt 必须拒
    const chatEmpty = await post('chat', { siteId: 'deepseek', prompt: '   ' });
    assert.equal(chatEmpty.ok, false);
    assert.equal(chatEmpty.error, 'empty-prompt');

    // ⑧ 软删 + 摘边
    const del = await post('task-delete', { workspaceRoot: root, taskId: id });
    assert.equal(del.ok, true, JSON.stringify(del));
    assert.equal(del.task.status, 'deleted');
    assert.equal(del.tasks.length, 0, '软删除行不得出现在面板行里');

    // ⑨ 方法契约：client 只 GET task-ledger，因此只许注册 GET
    const idx = routeIndex(control.actions);
    assert.equal(idx.has('task-ledger'), true);
    assert.deepEqual([...idx.get('task-ledger')], ['GET'],
      'client 只 GET task-ledger；多注册 POST 会被 client-server-contract 判成死路由');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
// ── 任务台账存储根：必须**单一取法**（0.19.0）──────────────────────────────
//
// 0.19.0 独立审查发现的 HIGH：`task-*` 路由各自内联
// `body?.workspaceRoot || config.workspaceRoot || process.cwd()`（7 处），而任务投影
// 那一侧（`roster.js projectTasks`）用的是**会话的工作目录**。两者可以指向两个不同的
// `.webcode-tasks/ledger.json` —— 同一块界面上任务板与花名册各拿一份，互不可见。
//
// 判据两条：
//   ① 源码里**不得**再出现内联的那条表达式（收敛成 `taskRootOf` 一处）；
//   ② 根解析必须真的可注入，且 `GET task-ledger` 把实际用的根**如实透出**
//      （否则「面板读的到底是哪一份台账」只能靠猜）。
test('★ 0.19.0：任务台账的存储根必须是单一取法，且如实透出实际路径', async () => {
  const wcSrc = fs
    .readFileSync(path.join(here, '..', 'lib', 'web-control.js'), 'utf8')
    // **先去注释再断言**：本项目反复踩过「护栏匹配到注释」的坑——上面那段说明
    // 逐字引用了旧的表达式形态，不剥注释就会把「解释」读成「缺陷仍在」。
    // 文件是 CRLF：按 `\r?\n` 切分，否则行尾 `\r` 会让 `$` 对不上、注释根本剥不掉。
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\/\/.*$/, ''))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/body\?\.workspaceRoot \|\| config\.workspaceRoot \|\| process\.cwd\(\)/.test(wcSrc),
    '不得再内联存储根表达式 —— 7 处各写一份正是「两份真相」的来源，必须走 taskRootOf');
  assert.match(wcSrc, /function taskRootOf\(body\)/, '必须有唯一解析器 taskRootOf');
  assert.match(wcSrc, /resolveWorkspaceRoot/, '必须支持宿主注入根解析器（与会话工作目录同源）');

  // 行为：显式 workspaceRoot 优先；GET 回显实际用的根。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-taskroot-'));
  try {
    const webControl = stubControl();   // 与本文件其它用例同一个夹具
    const created = await call(webControl, 'POST', '/__webcode/task-create', { subject: 'x', workspaceRoot: root });
    assert.equal(created.status, 200);
    assert.ok(fs.existsSync(path.join(root, '.webcode-tasks', 'ledger.json')),
      '写必须真的落到那个根下的 ledger.json');
    // GET 那一跳**直接调动作表**：本文件的 `call()` 夹具把带 query 的 pathname
    // 原样传给 `handle()`，而 `handle()` 的 suffix 是按 `pathname` 整串切的——
    // query 会让它变成 `task-ledger?...` 从而 404（这是夹具的限制，不是产品缺陷：
    // 真实服务端传进来的 pathname 不含 query，实测 200 且回显正确）。
    // 因此这里走 `actions['GET task-ledger']` 的真实实现，验的是**同一段代码**。
    const gotBody = await webControl.actions['GET task-ledger']({ workspaceRoot: root });
    assert.equal(gotBody.workspaceRoot, root, 'GET 必须如实回显它读的根（可当场核对读的是哪一份）');
    assert.equal(gotBody.ok, true);
    assert.equal(gotBody.tasks.length, 1, '写的和读的必须是**同一份**台账');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
