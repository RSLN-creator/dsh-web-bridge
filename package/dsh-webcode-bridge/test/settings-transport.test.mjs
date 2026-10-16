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
import { listen } from './fixtures/listen.js';
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
  const port = await listen(server); // 共享守卫：坏端口/null 重试（见 fixtures/listen.js 头注的两类 flake）
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

// ── ⑦ 设置页不得手写协议文本（红线 3 的展示面判据，0.19.80）──────────────────
//
// ## 这条判据的来历（真缺陷，不是假想）
//
// `settings-page.js` 原先在 `native-spec-card` 里**手写**了各模型的「首轮教学提示词」。
// 2026-10-15 真机复核发现它与 `lib/agent-preset.js`（**唯一协议真源**）实际发送的**不一致**：
//
//   | 站点 | 设置页原先教的 | 真源实际发的 | 后果 |
//   | --- | --- | --- | --- |
//   | GLM | 代码块 | 代码块 | 一致 |
//   | Doubao | `<seed:tool_call>{"name":…}` | `<tool_call>{"mcp_action":"call",…}` | 教了**真源从不教**的壳，且缺 `mcp_action` |
//   | Kimi | `<tool_call>{"name":…}` | 同上（带 `mcp_action`） | 缺 `mcp_action` |
//   | Qwen | `# Tools` + `<tool_call>{"name":…}` | 同上（带 `mcp_action`） | 缺 `mcp_action` |
//
// 而 `agent-preset.js:2553` 的**唯一解析判据**是 `tagged || obj.mcp_action === 'call'`
// ⇒ 设置页教的裸 JSON 形状（无 `mcp_action`）**解析不了**；用户照抄会得到「调用了但没执行」。
// `seed:tool_call` 的三处分布是决定性读数：解析器认它、设置页教它、**教学侧零出现**。
//
// ## 判据（两侧都钉，缺一不可）
//   ① **正向**：真源文本必须真的上屏（拿 `transportNoteFor` 现算，去 HTML 里找）
//   ② **反向**：旧的手写教学形状必须**不再**出现（否则等于第二份协议又回来了）
test('⑦ 设置页只展示真源教学文本，不手写第二份协议（红线 3 的展示面）', async () => {
  const { renderSettingsPage } = await import(pathToFileURL(path.join(LIB, 'settings-page.js')).href);
  const { transportNoteFor, trainNoteFor } = await import(pathToFileURL(path.join(LIB, 'agent-preset.js')).href);

  const tools = [{ name: 'read', description: '读取本地文件文本内容。',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];
  const teaching = {
    default: transportNoteFor('kimi', tools),
    glm: transportNoteFor('glm', tools),
    trainDefault: trainNoteFor('kimi', '', tools),
    trainGlm: trainNoteFor('glm', '', tools),
  };
  const html = renderSettingsPage([{ id: 'kimi:k3', name: 'kimi/k3', siteName: 'Kimi' }], teaching);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // ① 正向：真源文本上屏
  assert.ok(html.includes(esc(teaching.default).slice(0, 120)),
    '设置页没有展示「默认形状」的真源文本——展示层没接真源');
  assert.ok(html.includes(esc(teaching.glm).slice(0, 120)),
    '设置页没有展示 GLM 形状的真源文本');
  assert.ok(html.includes('mcp_action'),
    '设置页连 mcp_action 都不出现 ⇒ 展示的形状缺唯一解析凭据');

  // ② 反向：旧手写教学形状必须消失
  assert.ok(!/必须使用 &lt;seed:tool_call&gt;/.test(html),
    '设置页仍在教 seed:tool_call —— 桥的教学侧从不发它（agent-preset 零出现），照抄会解析不了');
  assert.ok(!/网页避拦截推荐/.test(html),
    '旧的「网页避拦截推荐」手写文案仍在 ⇒ 第二份协议文本没删干净');
  assert.ok(!/># Tools\s*\n\s*必须使用/.test(html),
    '旧的 qwen「# Tools」手写教学仍在');

  // ③ 缺省参数必须**如实显示未提供**，不得回落旧手写文本（回落＝把刚删的第二份请回来）
  const bare = renderSettingsPage([{ id: 'x', name: 'x', siteName: 'X' }]);
  assert.ok(bare.includes('未提供：请从 lib/agent-preset.js 取真源文本'),
    '缺省 teaching 时应如实显示「未提供」，而不是静默给别的文本');
  assert.ok(!/必须使用 &lt;tool_call&gt;/.test(bare),
    '缺省 teaching 时回落到了手写文本 ⇒ 第二份协议会随缺省路径复活');
});

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

// ── ⑦ 登录入口不得把人引到「登了不算数」的地方（0.18.0）────────────────────────
//
// 用户 2026-09-22 原话：「设置界面和右侧本插件带来的登录必须落实一处，必须脱离本机
// 浏览器可用（零外部？就是自带浏览器完整实现）」。
//
// 核实到的真问题：桥跑在**自己独占的 Chromium profile** 里，而界面上有两个入口会把
// 用户带到别的浏览器去登录 —— 官方 iframe 浏览器（`ui-sidebar-browser`，另一个进程、
// 另一份 cookie 罐）与 `window.open()`（用户日常浏览器）。在那里登录，桥**永远不会
// 知道**，于是长期出现「探针说未登录、用户说我登了」而两边都是真的。
//
// 判据：这两个动作**都不许**再出现在登录通路上。删掉任一条判据，本条立刻变红。
test('⑦ 登录入口不得指向桥以外的浏览器（登了不算数）', () => {
  const page = fs.readFileSync(path.join(LIB, 'settings-page.js'), 'utf8');
  const client = fs.readFileSync(path.join(LIB, 'client.cjs'), 'utf8');

  // ① 设置页不得再提供「打开网站」这类按钮（它调 window.open，登的是用户日常浏览器）。
  assert.ok(!page.includes("id=\"subOpenSite\""),
    '设置页不得再有 subOpenSite 按钮 —— 它调 window.open 打开用户日常浏览器，在那里登录桥不知道');

  // ② 面板的站点工具条不得再用官方 iframe 浏览器作为**登录**入口。
  //    注意：站点目录页仍可用 openTab('browser') 做「浏览」；这里只禁**登录按钮**那条路。
  assert.ok(!/aria-label':\s*'在官方内置浏览器中打开'/.test(client),
    '站点工具条不得再把「官方内置浏览器」当登录入口 —— 那是独立 iframe，登录态不进桥的 profile');

  // ③ 正判据：登录必须走桥自己的窗口（window 动作），且这条通路确实在。
  assert.match(page, /subAction\('window'\)/, '设置页的「登录窗口」必须仍走 window 动作（桥自己的浏览器）');
  assert.match(client, /onClick:\s*toggleWindow/, '面板的站点工具条必须仍能打开桥自己的登录窗口');

  // ④ 0.19.0 补：站点目录（SiteCatalogBody）**不得**再把官方 iframe 浏览器或
  //    `window.open` 当登录入口。
  //
  //    这是上一条留下的缺口：0.18.0 只钉住了工具条那个按钮，而目录里的账户菜单
  //    仍有一项「🌐 在内置浏览器打开/登录」，它调 `ctx.sidebarRight.openTab('browser')`
  //    （拿不到就 `window.open`）—— 那两处都不是桥的浏览器，在那里登录桥永远不知道。
  //    本轮真机复现了这条漏网路径，故按**组件体**钉住，而不是只钉某个 aria-label 字面量。
  //
  //    判据只看**去掉注释的代码**：本文件已经三次踩到同一个坑 —— 解释缺陷的注释里
  //    引用了旧写法，护栏把「说明」当成「缺陷仍在」，失败信息还指向代码，把排查
  //    方向完全带偏（`client-render.test.mjs` 的「轮询不得覆盖用户输入」为此立过规矩）。
  //
  //    注意**换行符**：本仓库的文件是 CRLF（`\r\n`）。按 `\n` 切分后每行尾部带 `\r`，
  //    形如 `                    // 说明…\r` —— 用 `^\s*\/\/.*$` 去匹配时，`\s` 会把
  //    行首缩进连同 `\r` 一起吃掉，`.*` 再退回空串，结果**整行注释被判成空行**、
  //    根本没被去掉。这是本轮实测踩到的真实坑，所以下面显式去掉 `\r` 再判。
  const stripComments = (s) => s
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\/\/.*$/, ''))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const catalogAt = client.indexOf('function SiteCatalogBody');
  assert.ok(catalogAt > 0, '找不到 SiteCatalogBody');
  const catalogEnd = client.indexOf('\n    function ', catalogAt + 10);
  const catalog = stripComments(client.slice(catalogAt, catalogEnd === -1 ? client.length : catalogEnd));
  assert.ok(!/openTab\('browser'\)/.test(catalog),
    '站点目录不得用官方 iframe 浏览器做登录入口 —— 那是另一个进程、另一份 cookie 罐，登录态不进桥');
  assert.ok(!/window\.open\(/.test(catalog),
    '站点目录不得用 window.open 做登录入口 —— 那打开的是用户日常浏览器，登录态不进桥');
  //    正判据：它必须走与工具条同一条控制面动作（window + action:open）。
  assert.match(catalog, /apiSoft\('window',\s*\{[^}]*action:\s*'open'/,
    '站点目录的登录必须走 POST window {action:open}（与工具条 🌐 同一个落点）');

  // ⑤ 0.19.0 补：`SiteCatalogBody` 不得引用**别的组件的局部函数**。
  //
  //    本轮自查抓到的真缺陷：登录路径原写 `siteSlot(accountKey)`，而 `siteSlot`
  //    定义在 `SiteAccounts` 的**函数体内**（同文件另一处），本组件取不到——
  //    `node --check` / `new vm.Script()` 都判 SYNTAX OK，**一按才抛 ReferenceError**。
  //
  //    ⚠ 第一版判据写成 `if (!/const slotOf/…) { assert.ok(!/siteSlot\(/…) }`，
  //    被独立审查（task-4）指出有**逃逸形态**：只要把 `slotOf` 的定义留着、把
  //    **调用处**改回 `siteSlot(...)`，`if` 分支不进，缺陷回来了却不变红
  //    （实测反向验证不变红）。现已改为**无条件**断言，并且不依赖具体函数名——
  //    判据是「本组件内不得出现**定义在别处**的 siteSlot 调用」，与叫 slotOf 还是
  //    别的名字无关（那才是真正的性质）。
  const siteAccountsAt = client.indexOf('function SiteAccounts');
  const siteAccountsEnd = client.indexOf('\n    function ', siteAccountsAt + 10);
  const siteAccounts = client.slice(siteAccountsAt, siteAccountsEnd === -1 ? client.length : siteAccountsEnd);
  assert.match(siteAccounts, /const siteSlot = \(key\) =>/,
    'SiteAccounts 里应有它自己的 siteSlot —— 若已抽成模块作用域函数，请同步改本条判据');
  // 无条件：目录里不得调用 `siteSlot`（它是 SiteAccounts 的局部函数）。
  // 词界用 `(?<![\w$])` 否定回顾，**不能**写 `[^\w.]`——因为调用点常见写法是
  // 展开 `...siteSlot(x)`，前面那个字符正是 `.`，会被 `[^\w.]` 排除而漏判。
  assert.ok(!/(?<![\w$])siteSlot\s*\(/.test(catalog),
    'SiteCatalogBody 调用了 siteSlot —— 那是 SiteAccounts 的函数体局部函数，跨组件作用域引用，'
    + '点击时会抛 ReferenceError（语法检查抓不到）。必须在本组件内自行定义拆解函数。');
  // 正判据：本组件必须**自己**定义一个拆解函数并真的用它——只删调用、没接上替代品
  // 也是一种失败（登录会用到未定义的函数或传错形状）。
  //
  // 注意 `defd[0]` 只是匹配到的那一小截（`const slotOf = (key)`），**不等于**完整
  // 定义文本；所以不能 `replace(defd[0], '')` 去「删掉定义再找调用」——那会留下
  // ` => {`，判据必然误报。改成按**定义所在行**整行剔除。
  const defd = catalog.match(/^\s*(?:const|function)\s+([A-Za-z_$][\w$]*)\s*(?:=\s*\(key\)|\(key\))/m);
  assert.ok(defd, 'SiteCatalogBody 内没有定义账户键拆解函数（形如 `const x = (key) => …`）');
  const name = defd[1];
  const bodyLines = catalog.split('\n').filter((l) => !l.includes('(key)'));
  assert.ok(new RegExp('(?<![\\w$])' + name + '\\s*\\(').test(bodyLines.join('\n')),
    '本组件定义了拆解函数 ' + name + ' 却没用它 —— 登录会用到未定义的函数');

  // ⑥ 0.19.0 起：目录开窗的忙碌态必须是**集合**（不得全局锁）。
  //    0.19.4 起：粒度为**账号**（用户指令「能够同时开多个账号的窗口/标签」）——
  //    按站点判会把「给同站再加一个账号」静默丢弃，用户点「新账号」毫无反应。
  //
  //    ① 的成因：初版用 `if (busySid) return;` 做**全局**锁，而这条请求要等浏览器
  //    起来（最长 120s）——期间点**其它站点**会被静默丢弃，用户只看到上一个站点的
  //    成功回执、自己这次点击毫无反馈（本项目记为「说做了、其实没做」的那类）。
  //
  //    ③ 的成因（0.19.0 自查用状态机模拟抓到）：把全局锁改成单值后仍存在这条交错 ——
  //    `点A → 点B → B 先返回` ⇒ 忙碌态被清空，而 A 其实还在开窗 ⇒ A 随即重新可点
  //    ⇒ 再点一次拉起**第二个窗口**覆盖同一个 profile，正是这个忙碌态本来要防的事。
  assert.match(catalog, /const \[busyAccounts, setBusyAccounts\] = React\.useState\(\[\]\)/,
    '忙碌态必须用集合 —— 单值无法表示多个账号同时在途');
  assert.match(catalog, /const isBusy = \(key\) => busyAccounts\.includes\(key\)/,
    '必须有 isBusy(key) 判据，且键是 accountKey');
  assert.ok(!/if \(busySid\) return;/.test(catalog),
    '不得用全局 `if (busySid) return;` —— 那会静默吞掉其它站点的点击');
  assert.ok(!/busySids/.test(catalog),
    '按**站点**判的旧忙碌态必须清干净 —— 否则同站加第二个账号会被误判成「正在开窗」而丢弃');
  // 两个入口都必须反映忙碌态：账号下拉底部那行「新账号」，以及开窗函数自身的守卫。
  assert.match(catalog, /disabled: isBusy\('__new__' \+ sid\)/,
    '「新账号」那一行必须在新增进行中被禁用 —— 连点会一次加出两个空槽');
  assert.match(catalog, /if \(isBusy\(acctKey\)\) return;/,
    '开窗函数必须有按账号的守卫 —— 没有它，连点同一个账号会拉起多个窗口覆盖同一份 profile');
  // 入集合去重 + 解锁只摘自己那一个账号。
  assert.match(catalog, /setBusyAccounts\(\(prev\) => \(prev\.includes\(acctKey\) \? prev : \[\.\.\.prev, acctKey\]\)\)/,
    '入集合必须去重（连点同一账号不得重复入集合）');
  assert.match(catalog, /setBusyAccounts\(\(prev\) => prev\.filter\(\(x\) => x !== acctKey\)\)/,
    '解锁必须只摘掉自己那一个账号（其它账号的在途必须保持忙碌）');
  // 新增账号的「正在新增」位用**合成键**占位，且必须 finally 释放——
  // 早退路径（account-add 失败）不释放的话，「新账号」会永久变灰。
  assert.match(catalog, /const guard = '__new__' \+ sid;/,
    '新增账号必须有独立的防连点键');
  assert.match(catalog, /finally \{[\s\S]{0,200}setBusyAccounts\(\(prev\) => prev\.filter\(\(x\) => x !== guard\)\)/,
    '新增账号的防连点键必须在 finally 里释放（失败路径也要放）');
});

// ── ⑧ 附件探针不得回到任何面向用户的界面（0.19.6）────────────────────────────
//
// 用户 2026-09-24 原话：「附件探针……探针是你自己使用！不需要！然后是解释不需要！！
// 无意义！！面向用户使用！！」。核实到**两处**入口：原生设置面板（client.cjs 的
// 「提示词投递」卡）与独立设置页（settings-page.js，由 index.js 挂载
// `/__webcode/settings-page`）。两处都在本轮撤掉。
//
// 为什么判据要落在**渲染出的 HTML** 上而不是源码上：探针的名字会留在注释里（说明
// 「为什么撤掉」是仓库的台账纪律），用源码正则会把注释也算成命中。因此独立页走
// `renderSettingsPage()` 的返回值，原生面板走渲染出的文本。
//
// 能力本身（服务端 `POST attach-probe`）**保留**——它是开发者自用的读数通路，需要时
// 直接调 HTTP；本条禁的是「用户界面上出现这个按钮/读数」，不是删能力。
test('⑧ 附件探针与「最近一次实际投递」不得出现在用户界面上（两处入口都算）', async () => {
  // ① 独立设置页：`renderSettingsPage` 返回的就是整份 HTML（含 `<script>`），因此
  //    判据要**去掉注释行**再查——注释里写「为什么撤掉探针」是仓库的台账纪律，
  //    不能被当成界面回潮。id 只在标记里出现，可直接查。
  const { renderSettingsPage } = await import('../lib/settings-page.js');
  const html = renderSettingsPage([]);
  assert.ok(!html.includes('attachProbeBtn'), '独立设置页又有了探针按钮（id=attachProbeBtn）');
  assert.ok(!html.includes('transportProbeLine'), '独立设置页又有了探针读数行（id=transportProbeLine）');
  assert.ok(!html.includes('transportLastLine'), '独立设置页又有了「最近一次实际投递」行');
  const pageVisible = html.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.ok(!pageVisible.includes('附件探针'), '独立设置页的可见文案又出现「附件探针」');
  assert.ok(!pageVisible.includes('最近一次实际投递'), '独立设置页的可见文案又出现「最近一次实际投递」');

  // ② 原生设置面板的「提示词投递」卡区段：可见文案（去掉注释行）里不得出现。
  const client = fs.readFileSync(path.join(LIB, 'client.cjs'), 'utf8');
  const start = client.indexOf("'提示词投递'");
  assert.ok(start > 0, '找不到「提示词投递」卡 —— 本测试的分区锚点失效，先修解析');
  // 下一个锚点（0.19.59）：原来是「连接」卡，该卡已按用户要求整块删除，
  // 因此改用紧跟在投递卡之后的「速度与等待」——锚点必须真的存在，否则本用例的
  // 分区会静默变成「从投递卡到文件末尾」，那会让下面的反向断言失去意义。
  const end = client.indexOf("'速度与等待'", start);
  assert.ok(end > start, '找不到「速度与等待」卡（提示词投递卡的下一个锚点），先修解析');
  const card = client.slice(start, end);
  const visible = card.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  for (const banned of ['附件探针', '最近一次实际投递', 'runAttachProbe', 'probeBusy', 'probeResult']) {
    assert.ok(!visible.includes(banned), '原生设置面板的投递卡又出现 ' + banned);
  }

  // ③ 正判据（只删不加 = 用户失去形态选择）：形态单选与当前生效读数必须还在。
  assert.ok(visible.includes('附件投递') && visible.includes('纯文本'), '投递形态的两个选项必须保留');
  assert.ok(/当前生效/.test(visible), '「当前生效」读数必须保留');
  assert.ok(pageVisible.includes('提示词投递形态') && pageVisible.includes('transportLine'),
    '独立设置页的投递形态行必须保留（不能连功能一起删）');

  // ④ 服务端能力不得被顺手删掉（探针通路仍在，只是没有用户界面入口）。
  const server = fs.readFileSync(path.join(LIB, 'web-control.js'), 'utf8');
  assert.ok(server.includes('attach-probe'),
    '服务端的 attach-probe 动作被删了 —— 本轮只撤界面，不删能力');
});

// ── ⑨ 并发车道上限（0.19.52，多 profile 真并发的可调面）────────────────────────
//
// 用户原话：「真并发 = 多 profile 产品决策，我需要实现」。车道模型（relay.js）0.19.4
// 起就是「同账号串行、跨账号真并发」；本轮把**上限**从常量提升为设置项。判据分三层：
//   ① 面层往返：GET 默认 2、POST 写 5 读回 5、非法值夹取到 1..8（0/负数→1，越界→8，
//      NaN→2）——写坏的配置只许退化成合法值，不许变成第三种谁也没定义过的口径；
//   ② 接线层（源码）：defaultConfig 声明默认 + createRelay 用 laneCapOf(设置) 覆盖
//      静态值 + laneCapSink 在 set() 后同步（保存即生效，不需要重启）；
//   ③ 设置页：下拉存在、保存 payload 带这个键。
test('⑨ 并发车道上限：往返 + 夹取 + 保存即生效的接线', async () => {
  // ① 面层：默认值、写入往返、非法值夹取。
  await withControlPlane({ driver: statusStub('attach') }, async ({ get, post }) => {
    const before = await get('settings');
    assert.equal(before.json.maxConcurrentLanes, 2,
      '从未保存过时 GET settings 必须带默认 2 回来（否则下拉像「坏了」）：'
        + JSON.stringify(before.json.maxConcurrentLanes));

    const w = await post('settings', { maxConcurrentLanes: 5 });
    assert.equal(w.status, 200, 'POST settings 写 maxConcurrentLanes 必须可用：' + w.status);
    const after = await get('settings');
    assert.equal(after.json.maxConcurrentLanes, 5, '写入 5 后读不回 5（读写不闭环）');

    // 夹取三档：下界、上界、非数字。
    await post('settings', { maxConcurrentLanes: 0 });
    assert.equal((await get('settings')).json.maxConcurrentLanes, 1, '0 必须夹到 1（0 会把队列堵死）');
    await post('settings', { maxConcurrentLanes: 99 });
    assert.equal((await get('settings')).json.maxConcurrentLanes, 8, '99 必须夹到 8（内存/风控边界）');
    await post('settings', { maxConcurrentLanes: 'abc' });
    assert.equal((await get('settings')).json.maxConcurrentLanes, 2, '非数字必须归默认 2');
  });

  // ② 接线层（源码结构；relay 是 apply() 作用域内的真对象，单测拿不到句柄）。
  const src = fs.readFileSync(path.join(LIB, 'index.js'), 'utf8');
  assert.match(src, /const laneCapOf = \(s\) => \{\s*\r?\n\s*const n = Math\.round\(Number\(s\?\.maxConcurrentLanes\)\);/,
    'laneCapOf 夹取函数缺失或口径变了（数值夹 1..8，非数值归 2）——三处（index/web-control/设置页）同源');
  assert.match(src, /return Number\.isFinite\(n\) \? Math\.min\(8, Math\.max\(1, n\)\) : 2;/,
    'laneCapOf 的夹取语义必须保持：数值→1..8，NaN→默认 2（0 会堵死队列，写 0 的人要的是 1）');
  assert.match(src, /maxConcurrentLanes: 2 \}/,
    'defaultConfig 必须声明 maxConcurrentLanes: 2（0.19.4 的保守起点，未配置用户零位移）');
  assert.match(src, /maxConcurrentLanes: laneCapOf\(configManager\.get\(\)\)/,
    'createRelay 必须用「设置值」覆盖 ...cfg 摊平的静态值（settings > config 优先序）');
  assert.match(src, /laneCapSink = \(s\) => \{ try \{ relay\.config\.maxConcurrentLanes = laneCapOf\(s\); \}/,
    'laneCapSink 必须在 relay 创建后绑定到 relay.config（保存即生效的落点）');
  assert.match(src, /try \{ laneCapSink\?\.\(merged\); \} catch/,
    'configManager.set() 必须在落盘后调 laneCapSink（POST settings / account-add 两条写路径都会经过它）');

  // ③ 设置页：字段存在 + 保存 payload 带键（模板串内脚本，只能按源码文本钉）。
  const { renderSettingsPage } = await import('../lib/settings-page.js');
  const html = renderSettingsPage([]);
  assert.ok(html.includes('id="maxConcurrentLanes"'), '设置页没有并发上限下拉（id=maxConcurrentLanes）');
  const page = fs.readFileSync(path.join(LIB, 'settings-page.js'), 'utf8');
  assert.match(page, /const laneCap = Number\.isFinite\(laneN\) \? Math\.min\(8, Math\.max\(1, laneN\)\) : 2;/,
    '设置页保存前必须按同一口径夹取（先算后用，不把复杂表达式塞进对象字面量）');
  assert.match(page, /maxConcurrentLanes: laneCap,/,
    '设置页保存 payload 必须带 maxConcurrentLanes 键（键名丢了会静默保存不了上限）');
});
