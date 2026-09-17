// settings-transport.test.mjs — 「投递形态」开关的契约：inline = 逐字回到旧行为（0.16.4）。
//
// ## 用户原话与它对应的开关
//
// > 「然后是发送的纯文本太长了！看看怎么做到解决：通过文本发送文件发送过长内容，glm 和
// > deepsek，同样注意风险」
//
// 0.16.3 把超长正文改成走**附件**投递（默认 `attachInlineLimitChars: 60_000`）。附件
// 投递是**有副作用**的路径：一次真实上传、可能撞站点风控、模型未必读附件。因此用户必须
// 能在设置面把这条路整条关掉——`promptTransport: 'attach' | 'inline'`（默认 `attach`）。
//
// ## 冻结契约（护栏按它写）
//
//   · 配置 `promptTransport: 'inline'` ⇒ 计划层必须 `mode:'inline'`（**逐字**回到旧行为：
//     不看阈值、不看页面有没有上传入口）；
//   · 默认 `'attach'` ⇒ 超阈值且页面有入口时走附件；
//   · 设置页与控制面必须能**读回当前生效值**（面板要显示「现在到底是哪条路」）。
//
// ## 为什么前三组都要有（少一组就会出现「改了没生效」）
//
//   ① 判据层（纯函数）：`transport:'inline'` 真的把 mode 压成 inline；
//   ② 配置层（真驱动）：`index.js` 传进来的**读取函数**真的被读到（不是快照）；
//   ③ 接线层（源码）：DEFAULTS 声明 + **两个**构造点都传了读取函数——只传一个的话，
//      「账户2 发长提示词」与「默认槽」会走出两种行为（同 answerTimeoutMs 的教训）；
//   ④ 面层（真 HTTP）：控制面读得回当前值，设置面的写入能往返。
//
// ## 反向验证纪律（doc/comment-style.md §9.3）
//
// ① 是「inline = 逐字回到旧行为」的主判据；②③④ 各自是它的一半。在 %TEMP% 等价拷贝里把
// `transport === 'inline'` 那一支删掉，① 必须变红（记录见报告）。
//
// ## 怎么跑这个文件
//
//   node --test --test-timeout=90000 test/settings-transport.test.mjs
//
// **不要加 `--test-force-exit`**：真 HTTP + 真 `apply()` 的组合在本机实测会让该开关在退出
// 路径上撞 libuv 断言（子用例全绿而**文件**被判红，既有文件 test/wiring-roster.test.mjs 同样）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promptTransportPlan } from '../lib/browser-driver.js';

const pkg = path.dirname(import.meta.dirname);
const LIB = path.join(pkg, 'lib');

/** 真机读数：一轮实际发出去的首轮提示词长度（GET /__webcode/preset，2026-09-17）。 */
const REAL_PROMPT_CHARS = 409_555;
/** 真机默认阈值（index.js DEFAULTS.attachInlineLimitChars）。 */
const REAL_LIMIT = 60_000;

/** 临时目录：本机沙箱下 `os.tmpdir()` 可能 ACL 受限，失败就落到包内 .tmp。 */
function tmpDir(prefix = 'webcode-transport-') {
  try { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); } catch {
    const d = path.join(pkg, '.tmp', prefix + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
}

// ── ① 'inline' 必须压过一切：阈值、入口、长度都不看 ───────────────────────────

test('① transport=inline ⇒ mode=inline（409,555 字符、入口齐全、阈值有值也照压）', () => {
  const plan = promptTransportPlan({
    chars: REAL_PROMPT_CHARS,
    inlineLimit: REAL_LIMIT,
    attachEnabled: true,
    attachSupported: true,
    transport: 'inline',
  });
  assert.equal(plan.mode, 'inline',
    '选定「纯文本」后仍走了附件：这一支必须逐字回到旧行为（用户要的就是把有副作用的路整条关掉）。'
    + ' plan=' + JSON.stringify(plan));
  assert.equal(plan.reason, 'transport-inline',
    'reason 必须是独立的一个值：借用 attach-disabled 会被面板读成「附件功能坏了」，'
    + '而用户只是选了纯文本。plan=' + JSON.stringify(plan));
  // inline 路径不截断任何字符：读数必须与事实一致（同 attach-callsite.test.mjs ⑦ 的口径）。
  assert.equal(plan.truncate, false, 'inline 路径不截断，truncate 必须是 false：' + JSON.stringify(plan));
  assert.equal(plan.payloadChars, REAL_PROMPT_CHARS, 'inline 时 payloadChars 必须等于真正外发的字符数');
});

// ── ② 默认（attach）路径不变：超阈值走附件，未超/没入口回落纯文本 ──────────────

test('② transport=attach 与缺省时判据不变：超阈值→attach，未超/无入口→inline', () => {
  const over = promptTransportPlan({
    chars: REAL_PROMPT_CHARS, inlineLimit: REAL_LIMIT, attachEnabled: true, attachSupported: true, transport: 'attach',
  });
  assert.equal(over.mode, 'attach', '默认形态下超阈值必须走附件：' + JSON.stringify(over));
  assert.equal(over.reason, 'over-limit');

  const under = promptTransportPlan({
    chars: 3_000, inlineLimit: REAL_LIMIT, attachEnabled: true, attachSupported: true,
  });
  assert.equal(under.mode, 'inline', '普通单轮增量（几千字符）必须仍走纯文本（行为不变）');
  assert.equal(under.reason, 'under-limit');

  const noInput = promptTransportPlan({
    chars: REAL_PROMPT_CHARS, inlineLimit: REAL_LIMIT, attachEnabled: true, attachSupported: false, transport: 'attach',
  });
  assert.equal(noInput.mode, 'inline', '页面没有上传入口时必须回落纯文本：' + JSON.stringify(noInput));
  assert.equal(noInput.reason, 'no-attach-input');
});

// ── ③ 配置层：真驱动必须每次现读传入的读取函数（不是构造期快照）───────────────

test('③ 真驱动：默认 attach；getPromptTransport 返回 inline 时 status 报 inline；非法值回落 attach', async () => {
  const { createBrowserDriver } = await import('../lib/browser-driver.js');
  const base = { siteId: 'deepseek', site: 'https://chat.deepseek.com/', profileDir: tmpDir(), headless: true };

  const d0 = createBrowserDriver({ ...base });
  assert.equal(d0.status().promptTransport, 'attach',
    '缺省必须是 attach（冻结契约的默认值）：' + JSON.stringify(d0.status().promptTransport));

  // 读取函数形态：index.js 传的是 `() => configManager.get().promptTransport ?? cfg.promptTransport`。
  let current = 'inline';
  const d1 = createBrowserDriver({ ...base, getPromptTransport: () => current });
  assert.equal(d1.status().promptTransport, 'inline', '读取函数返回 inline 时 status 必须是 inline');
  current = 'attach';
  assert.equal(d1.status().promptTransport, 'attach',
    '状态是构造期快照（读了第一次就不再看读取函数）：设置页改了、行为不会变——'
    + '这正是 answerTimeoutMs 那次「配置项够不着」的同族缺陷');

  for (const bad of ['ATTACH', 'text', '', null, undefined, 1]) {
    const d = createBrowserDriver({ ...base, getPromptTransport: () => bad });
    assert.equal(d.status().promptTransport, 'attach',
      '非法值 ' + JSON.stringify(bad) + ' 必须回落 attach（投递形态只有两个合法取值）：'
      + JSON.stringify(d.status().promptTransport));
  }
});

// ── ④ 接线层：DEFAULTS 声明 + 两个构造点都传读取函数 ──────────────────────────

test('④ index.js 必须声明 promptTransport 默认值，且**两个** createBrowserDriver 调用点都传读取函数', () => {
  const src = fs.readFileSync(path.join(LIB, 'index.js'), 'utf8');
  assert.match(src, /promptTransport:\s*'attach'/,
    'index.js 的 DEFAULTS 没有声明 promptTransport（默认 attach）：'
    + 'driver 侧有默认值不代表配置层够得着（0.15.2 的 answerTimeoutMs 就是这么「可配」了一半）');

  const callSites = [...src.matchAll(/createBrowserDriver\(\{/g)].length;
  const readSites = [...src.matchAll(/getPromptTransport\s*:/g)].length;
  assert.ok(callSites >= 2, '只找到 ' + callSites + ' 个 createBrowserDriver 调用点（应为默认槽 + 懒创建两条）');
  assert.equal(readSites, callSites,
    '有 ' + callSites + ' 个驱动构造点，却只有 ' + readSites + ' 处传了 getPromptTransport：'
    + '漏传的那个槽会永远走默认 attach——「账户2 发长提示词」与「默认槽」行为分叉');
});

// ── ⑤ 控制面：读得回当前生效值，设置面写得进、读得出 ─────────────────────────

/** 最小 DSH 宿主替身 + 真 HTTP 服务（只挂本插件控制面路由）。 */
async function withControlPlane({ config = {}, driver }, fn) {
  const routes = new Map();
  const ctx = {
    llm: { registerAdapter() {} },
    webServer: { register(def) { routes.set(def.path, def); return () => {}; } },
    get: () => null,
  };
  const { apply } = await import(pathToFileURL(path.join(LIB, 'index.js')).href);
  const profileDir = tmpDir();
  fs.writeFileSync(path.join(profileDir, 'webcode-consent.json'), JSON.stringify({ accepted: true }), 'utf8');
  const disposer = apply(ctx, { port: 0, host: '127.0.0.1', requireConsent: false, driver, profileDir, ...config });
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://loopback').pathname;
    const def = routes.get(p);
    if (def) return def.handler(req, res);
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const call = async (method, name, body) => {
    const r = await fetch(`http://127.0.0.1:${port}/__webcode/${name}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify(body || {}) } : {}),
    });
    return { status: r.status, json: await r.json() };
  };
  try {
    return await fn({ get: (n) => call('GET', n), post: (n, b) => call('POST', n, b) });
  } finally {
    // 同 attach-probe-contract：必须等监听句柄真的关掉（keep-alive 连接会让
    // `server.close()` 迟迟不回调，`--test-force-exit` 下会撞 libuv 断言）；
    // `disposer()` 关的是插件自己的 relay，同样要 await。
    await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); });
    try { await disposer?.(); } catch { /* 测试替身，忽略 */ }
  }
}

/** 桩驱动：status 里带着驱动自己算出来的 promptTransport（真驱动由 promptTransportNow 现算）。 */
function statusStub(promptTransport = 'attach') {
  return {
    async sendTurn() { return { text: 'x' }; },
    async resetConversation() {},
    conversationFor() { return null; },
    status() {
      return {
        running: true, busy: false, siteId: 'deepseek', preview: true,
        promptTransport, attachTransport: null, attachProbe: null,
        sessionSlot: { webSessionId: null, at: null, source: 'none' },
      };
    },
    async close() {},
  };
}

test('⑤ 控制面：默认 attach、config=inline 时读回 inline，且设置面写入能往返', async () => {
  // (a) 默认：插件 config 不配 ⇒ 生效值 attach。
  await withControlPlane({ driver: statusStub('attach') }, async ({ get }) => {
    const r = await get('attach-status');
    assert.equal(r.status, 200, 'GET attach-status 必须可用：' + r.status);
    assert.equal(r.json.effective, 'attach', '缺省生效值必须是 attach：' + JSON.stringify(r.json));
    assert.ok(/附件投递/.test(String(r.json.transportLine || '')),
      '默认形态的文案应当说明会走附件：' + JSON.stringify(r.json.transportLine));
    const s = await get('settings');
    assert.equal(s.json.promptTransport, 'attach',
      'GET settings 必须带默认值回来（否则面板上一个单选都不选中，看起来像设置坏了）：' + JSON.stringify(s.json));
  });

  // (b) 插件 config 选纯文本 ⇒ 生效值 inline（这是「配置真的到达行为层」的面层读数）。
  await withControlPlane({ driver: statusStub('inline'), config: { promptTransport: 'inline' } }, async ({ get }) => {
    const r = await get('attach-status');
    assert.equal(r.json.effective, 'inline',
      '插件 config 写了 inline，控制面读回的生效值仍是 ' + r.json.effective + '：设置面会显示错的路');
    assert.ok(/纯文本/.test(String(r.json.transportLine || '')),
      'inline 形态的文案必须是「纯文本」：' + JSON.stringify(r.json.transportLine));
  });

  // (c) 设置面写入能往返（设置页的单选保存走的就是 POST settings）。
  await withControlPlane({ driver: statusStub('attach') }, async ({ get, post }) => {
    const w = await post('settings', { promptTransport: 'inline' });
    assert.equal(w.status, 200, 'POST settings 必须可用：' + w.status);
    const after = await get('settings');
    assert.equal(after.json.promptTransport, 'inline',
      '写入后读不回 inline：设置页选「纯文本」保存后会显示回「附件投递」（读写不闭环）：'
      + JSON.stringify(after.json));
    const st = await get('attach-status');
    assert.equal(st.json.effective, 'inline',
      '设置面选了纯文本之后生效值仍是 ' + st.json.effective + '：设置页与驱动行为会各说一套');
  });

  // (d) /status 也必须能把驱动那枚读数透出来（面板刷新时读的是它）。
  await withControlPlane({ driver: statusStub('inline') }, async ({ get }) => {
    const r = await get('status');
    assert.equal(r.status, 200);
    const hit = findKey(r.json, 'promptTransport');
    assert.ok(hit.length, '/status 里完全没有 promptTransport 读数：' + JSON.stringify(r.json).slice(0, 300));
    assert.ok(hit.includes('inline'),
      '/status 的 promptTransport 读数与驱动不一致（' + JSON.stringify(hit) + '）：'
      + '两个入口各读一份，面板与真实行为就会分叉');
  });
});

/** 递归找出某个键在所有层级上的值（面板刷新读的入口可能被包在 driver/sites 里）。 */
function findKey(value, key, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return [];
  const out = [];
  for (const [k, v] of Object.entries(value)) {
    if (k === key) out.push(v);
    else out.push(...findKey(v, key, depth + 1));
  }
  return out;
}

// ── ⑥ 动作名契约：面板侧引用的每个动作都必须在服务端动作表里 ──────────────────

test('⑥ 设置页 / 客户端引用的动作名都必须在服务端动作表里（真机 405 的那一族）', () => {
  const server = fs.readFileSync(path.join(LIB, 'web-control.js'), 'utf8');
  const actions = new Set();
  for (const m of server.matchAll(/'(GET|POST)\s+([a-z][a-z0-9-]*)'\s*:/g)) actions.add(m[1] + ' ' + m[2]);
  for (const m of server.matchAll(/actions\s*\[\s*'(GET|POST)\s+([a-z][a-z0-9-]*)'\s*\]\s*=/g)) actions.add(m[1] + ' ' + m[2]);
  assert.ok(actions.size > 10, '服务端动作表解析失败（只找到 ' + actions.size + ' 条）——先修本测试的解析');
  // 本文件关心的三个新动作必须在表里，且名字逐字。
  for (const want of ['POST attach-probe', 'GET attach-status', 'GET session-slot']) {
    assert.ok(actions.has(want), '服务端动作表缺 ' + want + '：冻结动作名就是它，改名等于面板按钮打不通');
  }

  // 独立设置页只有 POST 一条路（settings-page.js 的 apiPost / apiSoftPost）。
  const page = fs.readFileSync(path.join(LIB, 'settings-page.js'), 'utf8');
  const pageCalls = [...page.matchAll(/\bapi(?:Soft)?Post\(\s*'([a-z][a-z0-9-]*)'/g)].map((m) => m[1]);
  assert.ok(pageCalls.length > 0, '设置页动作调用解析失败（一处都没找到）——先修本测试的解析');
  const missingPage = pageCalls.filter((n) => !actions.has('POST ' + n));
  assert.deepEqual(missingPage, [],
    '设置页 POST 了服务端没注册的动作（真机是 405 + 空 body，而 mock fetch 看不见）：\n  '
    + missingPage.join('\n  '));

  // 原生面板（client.cjs bundle）：与 test/client-server-contract.test.mjs 同一判据，
  // 这里只补上「本轮的三个新动作确实被面板调用且服务端有对应方法」。
  const client = fs.readFileSync(path.join(LIB, 'client.cjs'), 'utf8');
  const clientCalls = [...client.matchAll(/\bapi(?:Soft)?\(\s*'([a-z][a-z0-9-]*)'\s*(,?)/g)]
    .map((m) => ({ name: m[1], method: m[2] === ',' ? 'POST' : 'GET' }));
  const missingClient = clientCalls
    .filter((c) => !actions.has(c.method + ' ' + c.name))
    .map((c) => c.method + ' ' + c.name);
  assert.deepEqual(missingClient, [],
    '客户端动作名/方法与服务端动作表不一致（真机 405）：\n  ' + missingClient.join('\n  '));
});
