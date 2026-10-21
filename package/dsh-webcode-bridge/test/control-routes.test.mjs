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
//
// 2026-09-30（第二次 flake 归因）：`listen(0)` 还可能拿到 undici 的**保留坏端口**
// （fetch 规范 79 个——本机 Node 22 逐个探测，79/79 与规范一致）。撞上时 `fetch`
// 一律 `bad port`，与服务器状态无关。真机现场：全量批跑里 prompt-file 用例间歇红
// （单独复跑 4 次全绿、干净树绿），日志逐字 `[TypeError: fetch failed] { cause: bad port }`。
// 守卫已抽成共享 helper `test/fixtures/listen.js`（本轮 mirror / site-mount 等 9 个
// 同款夹具一并接入），此处保留薄包装以维持既有导入面。
const listen = (server, attempts) => import('./fixtures/listen.js').then((m) => m.listen(server, attempts));

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
  //
  // ⚠ 0.19.46 更正：本行原先还断言 `glm:auto` 与 `zai:auto` 必须存在——那两个
  // 条目已在 **0.19.43 按用户指令真删**（原话：「不需要这个自动吧？……提供网站
  // 提供的模型列表就行」；判据是「桥有没有该站点的 modelPicker 契约」）。
  // 因此「列表里没有 auto」才是**现行设计**，旧断言只会常年发红、把真回归淹掉。
  //
  // 但删表**不等于**删解析：`glm:auto` / `zai:auto` 必须**仍解析得开**（真机
  // ~/.dsh/settings.yaml 的 subagent-model-selection.allowedModels 里就写着它们，
  // 解析不了会当场 session/model-unavailable）。所以这里同时钉住两件事：
  //   ① 列表里**没有** auto（下拉不再出现由桥自造的档位）；
  //   ② 解析**仍然成功**（历史设置值不会失效）。
  for (const id of ['glm:glm-5.3', 'zai:glm-5.3', 'deepseek:deepseek']) {
    const row = body.models.find((m) => m.id === id);
    assert.ok(row, `应有 ${id}`);
    assert.ok(typeof row.sendBudget === 'number' && row.sendBudget > 0, `${id}: sendBudget 应为正数，实际 ${row.sendBudget}`);
    assert.ok(typeof row.displayContext === 'number' && row.displayContext > 0, `${id}: displayContext 应为正数`);
  }
  for (const gone of ['glm:auto', 'zai:auto']) {
    assert.ok(!body.models.some((m) => m.id === gone),
      `${gone} 已在 0.19.43 真删，不得再出现在模型列表里`);
  }
});

// 0.19.39：更新栏的三跳必须齐全（用户：「设计好本插件的更新和只做提醒重启操作，
// 替换现在空白的单独 github 按钮」）。
//
// 与账户身份那条同型：单看每一跳都「有代码」，断一跳就整块失效。
//   ① lib/update.js  —— 判据纯函数（由 update.test.mjs 覆盖）
//   ② web-control    —— GET update-status（只读）与 POST update（真装）
//   ③ client.cjs     —— 顶部渲染版本 + 按钮 + 重启提醒
// 本文件钉第 ②，第 ③ 由 client-render 钉。
//
// 「只提醒重启」这条纪律也在判据里：安装动作**不得**自己重启进程
//（重启会终止在跑的会话），因此 runInstall 只回 needsRestart。
test('★ 0.19.39 更新：控制面必须同时有只读的 update-status 与真装的 update', async () => {
  const src = fs.readFileSync(new URL('../lib/web-control.js', import.meta.url), 'utf8');
  assert.match(src, /'GET update-status'/, '必须有 GET update-status（设置页挂载时读版本，只读）');
  assert.match(src, /'POST update'/, '必须有 POST update（唯一有副作用的那个）');
  // 版本号形状必须被校验：spec 会被拼进命令行，放开等于开一个任意参数入口。
  assert.match(src, /版本号形状不合法/, 'POST update 必须校验版本号形状（它会进命令行）');
  // profile 必须由服务端推出——浏览器侧不知道自己在哪个 profile 里跑。
  //
  // 0.19.61 修判据：旧断言钉的是 `path.basename(String(config.profileDir`，而**那正是
  // 缺陷本身**。`config.profileDir` 是桥自己的浏览器数据目录
  //（`webcode-edge-profile` / 桌面端 patch 改成 `webcode-edge-profile-desktop`），
  // 不是 DSH profile 名。真机读数（2026-10-04，运行中的 0.19.60）：该端点实回
  // `profile: "webcode-edge-profile-desktop"` ⇒ `dsh plugin --profile
  // webcode-edge-profile-desktop add …` 指向不存在的 profile。宿主唯一权威来源是
  // `DSH_PROFILE`（dsh-shell-env 写 `values[DSH_PROFILE_KEY] = profile.name`）。
  // 判据因此改成钉「环境变量优先」，并**反向**禁止退回按 profileDir 末段取名。
  assert.match(src, /process\.env\.DSH_PROFILE/, 'profile 名必须优先取宿主发的 DSH_PROFILE（唯一权威来源）');
  assert.ok(!/path\.basename\(String\(config\.profileDir/.test(src),
    '不得再拿 profileDir 的末段当 profile 名 —— 那是浏览器数据目录名，不是 DSH profile 名（0.19.61 的真缺陷）');
  // 装完必须清缓存：current 变了，旧的检查结果不再成立。
  assert.match(src, /updateCache = null/, '装完必须清掉检查缓存');
  // 「只提醒重启」的落点在 lib/update.js：装完只回 needsRestart，不代重启。
  const upd = fs.readFileSync(new URL('../lib/update.js', import.meta.url), 'utf8');
  assert.match(upd, /needsRestart: true/, 'runInstall 必须回 needsRestart（不代重启）');
  assert.ok(!/process\.exit|restart\(\)|spawn\('dsh',\s*\['web'/.test(upd),
    '更新模块不得自己重启进程（重启会终止在跑的会话）');
});

// 0.16.24：在途等待必须经**真实 HTTP 载荷**透出（药丸按它决定显示什么、多久问一次）。
//
// 这层是 index.js 与 client.cjs 之间的唯一接口，而它此前只被「响应体非空」那条
// 泛化护栏扫过——字段名写错（liveValue / live / now）在泛化护栏下完全无声：药丸
// 只会安静地回落到账本，观感退化成「等完才跳一下」，而那正是本轮要修的东西。
test('POST wait-stats：在途等待透出 live/now/projectedValue，且药丸文案取正在涨的那个数', async () => {
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
  // 0.19.34：面板标题右侧那个数改成**与药丸同源的投影**（账本 12 秒 + 在途 3 秒
  // = 15 秒），而不是只在途那一段。旧形态里标题右侧钉着不动的 sessionValue，
  // 在途那一段另起一行「正在等待发送 3 秒」——用户要求把那一行移除、由标题实时更新。
  assert.equal(body.projectedValue, '15 秒', '面板标题右侧必须是在途期间逐秒前进的投影');
  // 账本口径的 sessionValue 仍在载荷里（公开只读面），但不再上标题。
  assert.equal(body.sessionValue, '12 秒', 'sessionValue 仍是账本口径，供 curl 与旧前端核对');
  // 旧字段必须彻底消失：留着它，某个旧渲染路径就可能把它又画回面板上。
  assert.equal(body.liveValue, undefined, 'liveValue 已由 projectedValue 取代，不得复活');
  // 客户端据此判断要不要把轮询提到 1 秒；缺了它就只能 10 秒一问。
  assert.ok(body.live && typeof body.live === 'object', '在途时必须给 live 供客户端判断');
  assert.equal(body.live.startedAt, NOW - 3000);
  // now 必须与文案同源：客户端不知道它是服务端时刻的话，秒级取整下两个数会差一格。
  assert.equal(body.now, NOW);
});

test('POST wait-stats：无在途时 live 为 null、标题回落到账本（不留幽灵读数）', async () => {
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
  // 0.19.34：live 消失后标题右侧回落到账本本身（12 秒），读数连续、不跳变。
  assert.equal(body.projectedValue, '12 秒');
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

test('POST account-remove：「删除」必须删数据→再摘槽位，且默认槽只清文件不连坐兄弟槽', async () => {
  // 用户指令（0.19.59）：「每个设置界面的网站分页，每个账户……增加一个按钮：『删除』
  // 作用是：删除这个账户数据」。这条把「删什么」钉成可执行的——面板只发 {siteId, slot}，
  // 路径与键形状全在服务端算。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webcode-acct-rm-'));
  // 账户 2 的槽目录（叶子，整目录可删）
  const slot2 = path.join(root, 'sites', 'glm', '2');
  fs.mkdirSync(slot2, { recursive: true });
  fs.writeFileSync(path.join(slot2, 'webcode-login-state.json'), '{}', 'utf8');
  // 默认槽目录 + 它的**兄弟槽** #3：默认槽删除绝不允许连坐删掉它
  const defDir = path.join(root, 'sites', 'glm');
  const slot3 = path.join(defDir, '3');
  fs.mkdirSync(slot3, { recursive: true });
  fs.writeFileSync(path.join(defDir, '3', 'webcode-login-state.json'), '{}', 'utf8');
  for (const f of ['webcode-login-state.json', 'webcode-account-identity.json', 'webcode-sessions-glm.json']) {
    fs.writeFileSync(path.join(defDir, f), '{}', 'utf8');
  }
  let saved = null;
  const forgets = [];
  const control = createWebControl({
    driver: { status: () => ({}) },
    relay: {
      status: () => ({}),
      config: { accountForget: async (k) => { forgets.push(k); return { ok: true }; } },
    },
    config: { profileDir: root }, host: {}, logger,
    presetInfo: () => null,
    settingsStore: {
      get: () => ({
        accounts: [{ siteId: 'glm', slot: '2', enabled: true }, { siteId: 'glm', slot: '3', enabled: true }],
        sendGapMsBySlot: { 'glm#2': 5000, glm: 1000 },
        defaultModelBySite: { glm: 'glm@2:glm-5.3' },
      }),
      set: (v) => { saved = v; return v; },
    },
  });

  // ── 非默认槽：整目录删 + 摘槽位 + 清两处悬空引用 ──────────────────────
  const r = await call(control, 'POST', '/__webcode/account-remove', { siteId: 'glm', slot: '2' });
  const body = JSON.parse(r.text);
  assert.equal(body.ok, true, '删除必须成功：' + r.text.slice(0, 200));
  assert.equal(body.slotRemoved, true, '非默认槽必须从设置里摘掉');
  assert.ok(!fs.existsSync(slot2), '账户 2 的 profile 目录必须被整目录删除');
  assert.deepEqual(forgets, ['glm#2'],
    '必须先按 accountKey 关掉**该账号自己**的浏览器（按站点判会牵连另一个账号）');
  assert.deepEqual(saved.accounts.map((a) => a.slot), ['3'], '只摘被删的那个槽，其它槽原样保留');
  assert.equal(saved.sendGapMsBySlot['glm#2'], undefined, '槽级发送间隔覆盖必须随账号一起清掉');
  assert.equal(saved.sendGapMsBySlot.glm, 1000, '别的槽的间隔覆盖不得被牵连');
  assert.equal(saved.defaultModelBySite.glm, undefined,
    '指向已删槽的站点默认模型必须清掉——留着会在下一次解析时把账号悄悄复活');

  // ── 默认槽：只清属于它的文件，目录与兄弟槽都不许动 ────────────────────
  const r2 = await call(control, 'POST', '/__webcode/account-remove', { siteId: 'glm', slot: '' });
  const b2 = JSON.parse(r2.text);
  assert.equal(b2.ok, true, '默认槽删除必须成功：' + r2.text.slice(0, 200));
  assert.equal(b2.slotRemoved, false, '默认槽是隐式存在的，摘不掉槽位，只能清数据');
  assert.ok(fs.existsSync(defDir), '默认槽目录不得被删除（它可能住着 settings/consent）');
  assert.ok(fs.existsSync(slot3), '兄弟槽目录绝不能被连坐删除（账户 3 的数据不是这次要删的）');
  assert.ok(!fs.existsSync(path.join(defDir, 'webcode-login-state.json')), '默认槽登录态缓存必须清掉');
  assert.ok(!fs.existsSync(path.join(defDir, 'webcode-account-identity.json')), '默认槽身份缓存必须清掉');
  assert.ok(!fs.existsSync(path.join(defDir, 'webcode-sessions-glm.json')), '默认槽网页会话记录必须清掉');

  // 未知站点必须明确失败：不然「删了一个不存在的站点」会静默成功。
  const bad = JSON.parse((await call(control, 'POST', '/__webcode/account-remove', { siteId: 'nope' })).text);
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

test('POST account-identity：debug 取证通道是**opt-in**，常规轮询一行开销都不多花', async () => {
  // 背景（0.19.60）：为了给「真实昵称/头像」的**选择器**取真机证据，同一次读取多回一份
  // 页面候选节点。风险有两个，都在这里钉住：
  //   ① 常规路径（右栏每 8s 一次轮询）**不得**多扫一遍全页 DOM —— 判据是「驱动收到的
  //      opts 必须是 undefined」+「响应里没有 candidates 字段」；
  //   ② 候选必须能原样透出来（否则取证通道等于装饰）。
  const calls = [];
  const fakeDriver = {
    readAccountIdentity: async (opts) => {
      calls.push(opts);
      return {
        name: 'RSYHN', avatarUrl: 'https://cdn.example.test/a.png', basis: 'site-probe', capturedAt: null,
        candidates: {
          url: 'https://chatglm.cn/', title: '智谱清言', loginHints: [],
          nameCandidates: [{ selectorHint: 'p.sidebar-user-name', text: 'RSYHN', score: 8 }],
          avatarCandidates: [{ selectorHint: 'img.avatar', src: 'https://cdn.example.test/a.png', score: 9 }],
          notes: [],
        },
      };
    },
  };
  const control = createWebControl({
    driver: { status: () => ({}) },
    relay: { status: () => ({}), config: { siteConnect: () => fakeDriver } },
    config: {}, host: {}, logger,
    presetInfo: () => null,
    settingsStore: { get: () => ({}), set: (v) => v },
  });

  const plain = JSON.parse((await call(control, 'POST', '/__webcode/account-identity', { siteId: 'glm' })).text);
  assert.equal(plain.ok, true, '常规读取必须成功：' + JSON.stringify(plain).slice(0, 200));
  assert.deepEqual(calls[0], undefined, '常规读取不得向驱动传 opts（默认路径一字未改）');
  assert.equal(plain.candidates, undefined, '常规读取不得回传候选（否则每次轮询都白扫一遍 DOM）');
  assert.equal(plain.name, 'RSYHN', '常规读取仍必须给真实昵称');

  const dbg = JSON.parse((await call(control, 'POST', '/__webcode/account-identity', { siteId: 'glm', debug: true })).text);
  assert.deepEqual(calls[1], { debug: true }, 'debug:true 必须原样下发到驱动');
  assert.equal(dbg.candidates.nameCandidates[0].selectorHint, 'p.sidebar-user-name',
    '取证通道必须把候选原样透出——否则选择器取证无从下手');
  assert.equal(dbg.name, 'RSYHN', '取证通道不得丢掉身份读数本身');
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

// ── 任务看板的控制面路由级护栏：**已随任务板一并删除**（0.22.0）──────────────
//
// 这里原有两条用例（0.17.3 / 0.19.0），钉住 `POST task-*` 的路由级行为与
// 「任务台账存储根单一取法」。用户 2026-10-21 明令删除任务板之后，
// 那 7 个动作与 `lib/task-ledger.js` 一起移除，判据的对象不存在了。
//
// **不因删测试而丢掉的知识**（仍有效，只是换了守卫对象）：
//   · 「每个动作都必须能被真实 HTTP 命中」—— 由本文件前面那条用例继续覆盖，
//     对象是**当前**的整张动作表（它对新加动作自动生效）；
//   · 「写路径的根必须单一取法、且 GET 如实回显」—— 任务台账是唯一需要它的族。
//     **若将来再加任何落盘族，这条判据要原样重建，不要另立第二套取法。**
