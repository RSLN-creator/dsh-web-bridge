// session-continuity.test.mjs — 「同一会话却每轮新开对话」的会话连续性护栏（0.16.4）。
//
// ## 用户症状与真机读数（本轮定位，不是推测）
//
// 用户原话是「明明上下文没到，却一直新开对话」。真机现场（session-063b0a99）：
//
//   · 三轮 navTrace 同形：`resume(187fdbbd) → fresh(caller-requested-fresh) → fresh(2471a679)`，
//     每轮 messageChars 都是**四十万级**（真机一轮 407,064 / 415,001 字符）；
//   · 根因之一在驱动：`rememberConversation` 只在 `runTurn` **成功返回后**执行
//     （旧位置 `lib/browser-driver.js` 的 sendTurn 收尾）。首轮导航已经落到网页会话
//     187fdbbd，但该轮随后失败（真机命中 WEB_NO_PROGRESS）⇒ 映射**从未落盘**，
//     `webcode-sessions-deepseek.json` 里没有这个会话 ⇒ 下一轮 `conversationFor` 为空
//     ⇒ `conversationNav` 判 `unsupported/no-stored-session` ⇒ 上层整段重建 + `fresh:true`；
//   · 根因之二在上层：任何一轮失败都会 `turn.invalidate()`（`lib/index.js` 里
//     `relay.submit(...).catch(err => { turn.invalidate?.(); … })`），于是**下一轮重新
//     整段首轮提示词**——正是用户看到的「每轮四十万字符」。
//
// 两条根因指向同一句判据：**失败的一轮不得让会话连续性归零**。本文件把它拆成两组：
//
//   A 组（上层真代码 + 脚本驱动）：`fresh` 标志、单轮字符数、失败后的第三轮、重建节流。
//   B 组（驱动真代码，离线可验的部分）：`status().sessionSlot` 的读盘三态、
//     以及「导航落地即落盘」的结构判据。
//
// ## 为什么 B 组有一条源码级判据（边界写在明处）
//
// 真实的「导航落地 → 写盘」需要一个 Playwright 页面（`page.goto` + `page.url()`）。本机
// 没有可用的离线页面替身，所以这里用**花括号配平**框出 `runTurn` 的函数体，断言「落盘点
// 在 runTurn 之内、且 id 来自地址栏」。这与 test/attach-callsite.test.mjs 是同一取舍，
// 边界也一样：它证明的是**接线事实**（落盘点存在、在整轮成功之前），**不证明**真机上
// 那一行真的被走到——后者只能在真机用 `GET /__webcode/status` 的 `sessionSlot` 核对。
// 反向验证（%TEMP% 等价拷贝里删掉落盘点）必须让 ⑨ 变红，见报告。
//
// ## 反向验证纪律（doc/comment-style.md §9.3）
//
// ④ 是用户报的那条红基线（失败一轮后第三轮仍不许 fresh）；⑥ 是「重建→失败→再重建」
// 雪崩的刹车；⑨ 是落盘点的结构判据。三条都各自在 %TEMP% 拷贝里做过「改坏 → 变红」。
//
// 0.16.6 起 ⑥ 的**判据换了对象**：节流命中不再抛 WEB_SESSION_REBUILD_THROTTLED 让整轮
// 失败（界面上是一条红色「本轮运行失败」），而是交回一条「网页会话已切换」提示。因此
// ⑥ 现在断言三件事——① 这一轮成功且正文是提示；② 重放仍被挡在发送之前（只发 1 次）；
// ③ 节流那一轮没有让发送游标前进（第三轮仍是整段重建）。第三件是新增的安全线：
// 少了它，「不中断」会退化成「静默丢上下文」。反向验证见 doc/progress.md 0.16.6 段。
//
// ## 怎么跑这个文件
//
//   node --test --test-timeout=90000 test/session-continuity.test.mjs
//
// **不要加 `--test-force-exit`**：本文件里有真 HTTP 服务 + 真 `apply()`（⑦ 那条），
// 本机实测该开关会在退出路径上撞 libuv 的 `Assertion failed: !(handle->flags &
// UV_HANDLE_CLOSING)`——子用例全绿而**文件**被判红（既有文件 test/wiring-roster.test.mjs
// 同样如此，不是本文件引入的）。本文件收尾时已把监听句柄关干净并 `await`，不加也自然退出。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const pkg = path.dirname(import.meta.dirname);
const DRIVER_SRC = fs.readFileSync(path.join(pkg, 'lib', 'browser-driver.js'), 'utf8');

/** 首轮提示词的量级（真机 407,064 / 415,001）；用例把内容压到这个量级就够了。 */
const BIG_CHARS = 150_000;
/** 「增量轮」的字符数上限：只发一个会话键 + 几轮 transcript（真机几万 → 这里几千以内）。 */
const SMALL_CHARS = 5_000;

/** 临时目录：本机沙箱下 `os.tmpdir()` 可能 ACL 受限，失败就落到包内 .tmp（见 doc/progress.md）。 */
function tmpDir(prefix = 'webcode-cont-') {
  try { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); } catch {
    const d = path.join(pkg, '.tmp', prefix + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
}

/** 最小 DSH 宿主替身：`llm.registerAdapter` + `webServer.register`（与 wiring-roster 同源）。 */
function mockCtx() {
  const registered = { adapter: null, routes: new Map() };
  const llm = {
    registerConfigurableProviders() {},
    registerAdapter(ids, adapter) { registered.adapter = adapter; registered.adapterIds = [...ids]; },
  };
  const ctx = {
    llm,
    get(name) {
      if (name === 'llm') return llm;
      if (name === 'webServer') return { register: ({ path: p, handler }) => { registered.routes.set(p, handler); } };
      return undefined;
    },
  };
  return { ctx, registered };
}

/**
 * 脚本驱动：**只演网页那一侧**（这一轮成功还是抛错、网页会话 id 是什么），
 * 不替上层做任何判断。抛错码逐字使用产品里既有的码（WEB_NO_PROGRESS / WEB_SESSION_LOST）。
 */
function scriptedDriver({ script = [], slot = null } = {}) {
  const calls = [];
  const navTrace = [];
  let i = 0;
  const stub = {
    calls,
    navTrace,
    async sendTurn(key, message, { fresh = false, onDelta } = {}) {
      const step = script[Math.min(i, script.length - 1)] || { text: '好' };
      i += 1;
      const text = String(message || '');
      const chars = text.length;
      // `message` 一并留存：0.16.29 的「文件投递」判据要在发送文本里找哨兵。
      calls.push({ kind: 'sendTurn', key: String(key), fresh: Boolean(fresh), messageChars: chars, message: text });
      navTrace.push({ at: Date.now(), phase: 'nav', key: String(key), requestedFresh: Boolean(fresh) });
      if (step.throw) {
        const err = new Error(step.throw + ': 脚本驱动按剧本抛出（site=deepseek）');
        err.code = step.throw;
        throw err;
      }
      onDelta?.(step.text || '好');
      return { text: step.text || '好', sessionId: step.webSessionId || 'web-1' };
    },
    async sendPrompt(prompt) {
      calls.push({ kind: 'sendPrompt', key: null, fresh: true, messageChars: String(prompt || '').length });
      return { text: '好', sessionId: 'web-1' };
    },
    async resetConversation() {},
    conversationFor() { return slot; },
    status() {
      return {
        running: true, busy: false, preview: true, loggedIn: true,
        lastActivityAt: null, domReplyChars: null, lastEndReason: null, lastEndReasonAt: null,
        recoveredTurns: 0, lastRecovered: null, lastStalledSettle: null, thinkingOnlyTurns: 0,
        conversations: {}, sessionSlot: slot || { webSessionId: null, at: null, source: 'none' },
        navTrace: navTrace.slice(-12),
      };
    },
    async close() {},
  };
  return stub;
}

/**
 * 起一次真实的 `apply`（= 宿主里的一个进程实例），并在它的生命周期里跑多轮。
 *
 * **必须复用同一个实例**：`fresh` 的判据来自 `apply` 闭包里的 `sessionState`（「这个会话
 * 已经发到第几条消息」），每次 `apply` 都是全新的一张表——每个用例各起一个实例的话，
 * 第二轮会因为「实例是新的」而必然 fresh，护栏就变成了永远测不到真东西的假红。
 */
async function openBridge({ driver, profileDir = tmpDir(), ...cfgExtra }) {
  const { apply } = await import(pathToFileURL(path.join(pkg, 'lib', 'index.js')).href);
  const { ctx, registered } = mockCtx();
  const disposer = apply(ctx, {
    port: 0, host: '127.0.0.1', requireConsent: false, driver, profileDir, ...cfgExtra,
  });
  if (!registered.adapter) throw new Error('适配器没注册上：mock ctx 与 index.js 的取法对不上了');
  return {
    routes: registered.routes,
    /** 跑一轮真实适配器流（失败时连错误码一起带回）。 */
    // 0.16.29：`system` / `tools` 可覆盖——「契约指纹」判据（⑪）要能改契约逼出
    // contract-changed。默认值与从前逐字相同（deepseek / 空工具表），既有用例不受影响。
    // **不用换 model 来改契约**：换站点会去起一个真实浏览器（本机 spawn EPERM），
    // 而 system 与工具名集合同属契约四项，改它们既改了契约又留在同一站点。
    async stream({ sessionId, messages, signal, model = 'deepseek', tools = [], system }) {
      let text = '';
      try {
        for await (const c of registered.adapter.stream({
          purpose: null, model, messages, tools, sessionId, signal, system,
        })) {
          if (c?.type === 'text-delta') text += c.text;
        }
        return { ok: true, text };
      } catch (err) {
        return { ok: false, error: err, code: err?.code || String(err?.message || '').split(':')[0] };
      }
    },
    close() { return Promise.resolve(disposer?.()).catch(() => { /* 测试替身，忽略 */ }); },
  };
}

/** 一个会话的消息序列：首轮那条很大，后续只追加小消息（模拟 DSH 的增量轮）。 */
function messagesAt(turn) {
  const big = 'A'.repeat(BIG_CHARS);
  const out = [{ role: 'user', content: big }];
  for (let k = 1; k < turn; k += 1) {
    out.push({ role: 'assistant', content: '第 ' + k + ' 轮答复' });
    out.push({ role: 'user', content: '第 ' + (k + 1) + ' 轮的问题' });
  }
  return out;
}

// ── ③① 首轮：fresh + 大数，且驱动侧真代码能在「落地后」从 store 读到 id ─────────

test('① 首轮必须是 fresh 且是真·整段首轮提示词（大数）', async () => {
  const driver = scriptedDriver({ script: [{ text: '首轮答复' }] });
  const bridge = await openBridge({ driver });
  try {
    const r = await bridge.stream({ sessionId: 'sess-1', messages: messagesAt(1) });
    assert.equal(r.ok, true, '首轮不该失败：' + (r.ok ? '' : r.error?.message));
    assert.equal(driver.calls.length, 1, '首轮只应有一次 sendTurn，实际 ' + driver.calls.length);
    const [first] = driver.calls;
    assert.equal(first.fresh, true, '首轮必须是 fresh（否则增量会被丢进一个没有前文的网页会话）');
    assert.ok(first.messageChars > 100_000,
      '首轮 messageChars = ' + first.messageChars + '，不足 10 万：整段首轮提示词没有真的发出去（用例失去意义）');
  } finally { await bridge.close(); }
});

test('①b 驱动真代码：会话槽从 store 读得回来（面板/控制面读的就是这一枚读数）', async () => {
  const { createBrowserDriver } = await import('../lib/browser-driver.js');
  const emptyDir = tmpDir('webcode-slot-none-');
  const d0 = createBrowserDriver({ siteId: 'deepseek', site: 'https://chat.deepseek.com/', profileDir: emptyDir, headless: true });
  const slot0 = d0.status().sessionSlot;
  assert.ok(slot0 && typeof slot0 === 'object', 'status() 必须带 sessionSlot（冻结接口），实际：' + JSON.stringify(slot0));
  assert.deepEqual(
    { webSessionId: slot0.webSessionId, at: slot0.at, source: slot0.source },
    { webSessionId: null, at: null, source: 'none' },
    '空 profile 下 sessionSlot 必须是 {null,null,"none"}，实际 ' + JSON.stringify(slot0));

  // 预置一份「上一轮已经落地并落盘」的 store：这是「导航落地即落盘」在磁盘上的形状。
  const seededDir = tmpDir('webcode-slot-store-');
  fs.writeFileSync(path.join(seededDir, 'webcode-sessions-deepseek.json'),
    JSON.stringify({ main: { webSessionId: 'web-landed-7', at: 1_760_000_000_000 } }), 'utf8');
  const d1 = createBrowserDriver({ siteId: 'deepseek', site: 'https://chat.deepseek.com/', profileDir: seededDir, headless: true });
  const slot1 = d1.status().sessionSlot;
  assert.equal(slot1.webSessionId, 'web-landed-7', 'store 里的网页会话 id 没被读出来：' + JSON.stringify(slot1));
  assert.equal(slot1.at, 1_760_000_000_000, '写入时刻必须原样读回（派障要靠它判断这枚槽有多旧）');
  assert.equal(slot1.source, 'store', '从落盘读到的槽，source 必须是 "store"');
  assert.equal(d1.conversationFor('main')?.webSessionId, 'web-landed-7', 'conversationFor 必须与 sessionSlot 同源');
});

// ── ①c 行为级：导航落地后**即使这一轮失败**，会话槽也必须已经落盘 ─────────────

/** 真机形态的网页会话地址（DeepSeek 的会话页长这样）。 */
const SESSION_URL = 'https://chat.deepseek.com/a/chat/s/187fdbbd-2f5a-4a37-9d0e-9c7b1f4a2c31';

/**
 * 脚本页：把「导航落地」这一相位做成可控输入（`options.page` 是驱动自带的离线注入口）。
 *
 * 时序刻意这样安排（真机就是这个顺序）：站点在**首轮发送之后**把地址切到会话页。
 * 这里模拟为「每次 evaluate（= 判定登录态那一步）之后地址就变成会话页」——
 * 于是 `runTurn` 里那句「落地点立刻写盘」读到的是一个**真的会话 id**，
 * 而这一轮随后会因为脚本页缺少 composer 动作而失败。**失败的一轮同样产生身份**，
 * 这正是本用例要钉的东西。
 */
function scriptedPage() {
  let url = 'https://chat.deepseek.com/';
  const page = {
    isClosed: () => false,
    url: () => url,
    async goto(u) { url = String(u); },
    async waitForSelector() { return null; },
    async evaluate() { url = SESSION_URL; return 1; },
    on() {}, off() {},
    async close() {},
    locator: () => ({ first: () => ({ count: async () => 0, isVisible: async () => false }) }),
  };
  page.context = () => ({ on() {}, newPage: async () => page, close: async () => {} });
  return page;
}

test('①c 导航落地即落盘：这一轮随后失败，会话槽也必须已经在磁盘上', async () => {
  const { createBrowserDriver } = await import('../lib/browser-driver.js');
  const profileDir = tmpDir('webcode-landed-');
  const d = createBrowserDriver({
    siteId: 'deepseek', site: 'https://chat.deepseek.com/', profileDir, headless: true,
    page: scriptedPage(),
    // 页面里没有真的 composer 动作，这一轮**必然失败**——这正是要复现的相位。
    requestTimeoutMs: 5_000,
  });
  let failed = false;
  try {
    await d.sendTurn('sess-landed', '首轮提示词', { fresh: true });
  } catch (err) {
    failed = true;
    assert.ok(err, '本轮应当失败（脚本页没有 composer 动作）');
  } finally {
    try { await d.close(); } catch { /* 脚本页，忽略 */ }
  }
  assert.equal(failed, true,
    '这一轮居然成功了：脚本页不该能跑完一轮（用例失去意义，无法证明「失败的一轮也落盘」）');

  const slot = d.status().sessionSlot;
  assert.equal(slot.webSessionId, '187fdbbd-2f5a-4a37-9d0e-9c7b1f4a2c31',
    '失败的一轮之后会话槽是空的（' + JSON.stringify(slot) + '）：'
    + '这就是真机 187fdbbd 丢失的形态——下一轮 conversationFor 为空 ⇒ 整段重建 + 又开一个新对话');
  assert.equal(slot.source, 'store', '槽应当来自落盘（source=store），实际 ' + JSON.stringify(slot));

  const storeFile = path.join(profileDir, 'webcode-sessions-deepseek.json');
  assert.ok(fs.existsSync(storeFile), '落盘文件不存在：' + storeFile);
  const store = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  assert.equal(store['sess-landed']?.webSessionId, '187fdbbd-2f5a-4a37-9d0e-9c7b1f4a2c31',
    '落盘文件里没有这个会话键：' + JSON.stringify(store));
});

test('②③ 第二轮必须 fresh=false、命中同一会话键、且 messageChars 掉到几千以内', async () => {
  const driver = scriptedDriver({ script: [{ text: '首轮答复' }, { text: '第二轮答复' }] });
  const sessionId = 'sess-cont-2';
  const bridge = await openBridge({ driver });
  try {
    const r1 = await bridge.stream({ sessionId, messages: messagesAt(1) });
    assert.equal(r1.ok, true, '首轮不该失败：' + (r1.ok ? '' : r1.error?.message));
    const r2 = await bridge.stream({ sessionId, messages: messagesAt(2) });
    assert.equal(r2.ok, true, '第二轮不该失败：' + (r2.ok ? '' : r2.error?.message));

    assert.equal(driver.calls.length, 2, '两轮应共两次 sendTurn，实际 ' + driver.calls.length);
    const [first, second] = driver.calls;
    assert.equal(second.key, first.key, '第二轮换了会话键：同一 DSH 会话必须复用同一个网页会话键');
    assert.equal(second.fresh, false,
      '第二轮 requestedFresh 仍是 true：增量被丢进一个新开的网页会话，模型毫无前文（用户报的「一直新开对话」）');
    assert.ok(second.messageChars < SMALL_CHARS,
      '第二轮 messageChars = ' + second.messageChars + '，没有掉到 ' + SMALL_CHARS + ' 以内：'
      + '整段首轮提示词被重发了（真机就是这个形状：每轮四十万级）');
    // 同一枚 navTrace 读数（驱动/面板可核对的那一份）也必须记 false。
    const navs = driver.navTrace.filter((n) => n.phase === 'nav');
    assert.deepEqual(navs.map((n) => n.requestedFresh), [true, false],
      'navTrace 的 requestedFresh 序列不是 [true,false]：' + JSON.stringify(navs.map((n) => n.requestedFresh)));
  } finally { await bridge.close(); }
});

test('③ 三轮里只有首轮是大数（后续每个会话键都只发增量）', async () => {
  const driver = scriptedDriver({ script: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] });
  const sessionId = 'sess-cont-3';
  const bridge = await openBridge({ driver });
  try {
    const sizes = [];
    for (let turn = 1; turn <= 3; turn += 1) {
      const r = await bridge.stream({ sessionId, messages: messagesAt(turn) });
      assert.equal(r.ok, true, '第 ' + turn + ' 轮不该失败：' + (r.ok ? '' : r.error?.message));
      sizes.push(driver.calls[turn - 1].messageChars);
    }
    assert.ok(sizes[0] > 100_000, '首轮不是大数（' + sizes[0] + '）：用例失去意义');
    assert.deepEqual(sizes.slice(1).map((n) => n < SMALL_CHARS), [true, true],
      '第 2/3 轮的字符数 = ' + JSON.stringify(sizes.slice(1)) + '，没有都掉到 ' + SMALL_CHARS + ' 以内');
  } finally { await bridge.close(); }
});

// ── ④ 用户报的红基线：失败一轮之后，第三轮仍不许 fresh ────────────────────────

test('④ 第二轮失败（WEB_NO_PROGRESS）后，第三轮仍必须 fresh=false（不许整段重开）', async () => {
  const driver = scriptedDriver({
    script: [{ text: '首轮答复' }, { throw: 'WEB_NO_PROGRESS' }, { text: '第三轮答复' }],
  });
  const sessionId = 'sess-cont-4';
  const bridge = await openBridge({ driver });
  try {
    const r1 = await bridge.stream({ sessionId, messages: messagesAt(1) });
    assert.equal(r1.ok, true, '首轮不该失败：' + (r1.ok ? '' : r1.error?.message));

    const r2 = await bridge.stream({ sessionId, messages: messagesAt(2) });
    assert.equal(r2.ok, false, '第二轮应当失败（用例的输入就是失败的一轮）');
    assert.match(String(r2.error?.message || ''), /WEB_NO_PROGRESS/, '第二轮失败码不是 WEB_NO_PROGRESS：' + r2.error?.message);

    const r3 = await bridge.stream({ sessionId, messages: messagesAt(3) });
    // 第三轮可以成功也可以失败（网页会话是不是活的与这条判据无关），关键是**不许 fresh**。
    const third = driver.calls[driver.calls.length - 1];
    assert.equal(third.fresh, false,
      '第二轮失败后，第三轮又变成了 fresh（messageChars=' + third.messageChars + '）——'
      + '这正是用户报的「一直新开对话」：失败一轮就把整段上下文重发一次。'
      + ' 三轮的 fresh 序列 = ' + JSON.stringify(driver.calls.map((c) => c.fresh))
      + '（第三轮结果：' + (r3.ok ? '成功' : r3.error?.message) + '）');
    assert.ok(third.messageChars < SMALL_CHARS,
      '第三轮 messageChars = ' + third.messageChars + '：整段首轮提示词又被重发了');
  } finally { await bridge.close(); }
});

// ── ⑥ 重建节流（0.16.28 新契约）：撞窗后**本轮内等完剩余窗口再重建**，不再用提示打断任务 ──
//
// 0.16.6 的旧契约是「撞窗 → 交回『已切换会话』提示、重放挡在发送之前」。真机取证
// （session-4f236a51，reply-log 逐字 52 次 SESSION_SWITCHED）证明那个契约有致命盲区：
// 提示是**纯文本回复**，agent 循环把它当最终答复收场——goal 自动化的每一轮被空转
// 烧掉 30 秒、任务零进展，用户原话「被好心提示内容完全打断」。0.16.28 起撞窗改为
// 等待后重建；提示只在「用户真的叫停」（abort）时才有资格成为本轮正文（⑥b）。

test('⑥ 节流窗内的第二次会话丢失：等完剩余窗口后照常重建并交回重建内容', async () => {
  // 剧本按调用序：① 第一轮原发（丢）② 第一轮整段重放（丢）——本轮失败；
  //              ③ 第二轮原发（丢 → 撞节流窗 → 等完 → 重建，成功）。
  const driver = scriptedDriver({
    script: [
      { throw: 'WEB_SESSION_LOST' },
      { throw: 'WEB_SESSION_LOST' },
      { throw: 'WEB_SESSION_LOST' },
      { text: '重建后的答复', webSessionId: 'web-2' },
    ],
  });
  const sessionId = 'sess-throttle';
  // 窗口取 400ms：足够让「等待语义」可观测（≥300ms），又不拖慢测试。
  const bridge = await openBridge({ driver, sessionRebuildThrottleMs: 400 });
  try {
    const before1 = driver.calls.length;
    const r1 = await bridge.stream({ sessionId, messages: messagesAt(1) });
    const during1 = driver.calls.length - before1;
    assert.equal(r1.ok, false, '第一次会话丢失应当本轮失败（然后整段重建一次）');
    assert.equal(r1.code, 'WEB_SESSION_LOST',
      '第一次会话丢失的失败码应当是 WEB_SESSION_LOST（第一次重建是允许的），实际 ' + r1.code);
    assert.equal(during1, 2,
      '第一次会话丢失这一轮发了 ' + during1 + ' 次（应为 2 = 原轮 + 一次整段重放）：'
      + JSON.stringify(driver.calls.map((c) => ({ fresh: c.fresh, chars: c.messageChars }))));

    const before2 = driver.calls.length;
    const t0 = Date.now();
    const r2 = await bridge.stream({ sessionId, messages: messagesAt(2) });
    const waitedMs = Date.now() - t0;
    const during2 = driver.calls.length - before2;
    assert.equal(r2.ok, true,
      '撞节流窗的第二轮不该失败：' + String(r2.error?.message || '').slice(0, 200));
    assert.equal(String(r2.text || '').trim(), '重建后的答复',
      '第二轮必须等完节流窗后真的重建，并把重建轮的真实回复交回（任务不断链），实际正文 = '
      + JSON.stringify(String(r2.text || '').slice(0, 200)));
    assert.ok(waitedMs >= 300,
      '第二轮没有等待节流窗口就重建了（等待语义丢失）：只过了 ' + waitedMs + 'ms');
    assert.equal(during2, 2,
      '第二轮应发 2 次（原轮 + 等待后的整段重建），实际 ' + during2 + '：'
      + JSON.stringify(driver.calls.map((c) => ({ fresh: c.fresh, chars: c.messageChars }))));
    const rebuilt = driver.calls[driver.calls.length - 1];
    assert.equal(rebuilt.fresh, true, '等待后的那次发送必须是整段重建（fresh）');
    assert.ok(rebuilt.messageChars > 100_000,
      '重建发送 messageChars = ' + rebuilt.messageChars + '，不足 10 万：整段首轮提示词没有真的重放');

    // 重建成功并正常 commit → 游标前进 → 第三轮是增量（不再有第三次重建）。
    const before3 = driver.calls.length;
    const r3 = await bridge.stream({ sessionId, messages: messagesAt(3) });
    assert.equal(r3.ok, true, '第三轮不该失败：' + String(r3.error?.message || '').slice(0, 200));
    const third = driver.calls[driver.calls.length - 1];
    assert.equal(third.fresh, false,
      '重建成功后第三轮应是增量（fresh=' + third.fresh + '）——重建不再被节流挡掉，游标正常前进');
    assert.ok(third.messageChars < SMALL_CHARS,
      '第三轮 messageChars = ' + third.messageChars + '：增量轮不应重发大数');
  } finally { await bridge.close(); }
});

test('⑥b 节流等待中途被 abort：本轮按中止收场，且绝不发起等待后的重建发送', async () => {
  // abort 的到达语义在 relay（调用方 abort → item 立即 reject，executor 的任何
  // 返回都被丢弃）。因此这条护栏钉的不是「提示能不能送达」，而是**资源安全线**：
  // 用户叫停之后，executor 不得再向网页发起一次 40 万字符的整段重建——
  // 等待必须被 abort 打断、重建分支必须被跳过。
  const driver = scriptedDriver({
    script: [
      { throw: 'WEB_SESSION_LOST' },
      { throw: 'WEB_SESSION_LOST' },
      { throw: 'WEB_SESSION_LOST' },
      { text: '不该走到这一步' },
    ],
  });
  const sessionId = 'sess-throttle-abort';
  // `minSendIntervalMs: 0`：0.19.4 起的**全局发送错峰**（生产默认 1s）会让本用例
  // 的三次发送之间各插入 1s 等待，而本用例的判据是「abort 时已经发生过几次发送」——
  // 一个与「中止安全」正交的节流不该决定这条断言。这里显式关掉它，让判据只测中止语义
  // （错峰本身由 test/relay-lanes.test.mjs 单独钉住）。
  const bridge = await openBridge({ driver, sessionRebuildThrottleMs: 5_000, minSendIntervalMs: 0 });
  try {
    const r1 = await bridge.stream({ sessionId, messages: messagesAt(1) });
    assert.equal(r1.ok, false, '第一轮按剧本失败（建立节流记录）');
    // 第二轮撞窗进入 5s 等待；100ms 时 abort → 等待短路，重建分支不得执行。
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const r2 = await bridge.stream({ sessionId, messages: messagesAt(2), signal: controller.signal });
    assert.equal(r2.ok, false, '调用方 abort 的本轮应当按中止收场');
    assert.match(String(r2.error?.message || r2.code || ''), /abort/i,
      '失败原因应当是中止，实际：' + String(r2.error?.message || r2.code || '').slice(0, 120));
    assert.ok(!/不该走到这一步/.test(String(r2.text || '')),
      'abort 之后不应再发起重建发送');
    assert.equal(driver.calls.length, 3,
      'abort 后应停在 3 次发送（原轮+重放 ×2 轮），第 4 次（等待后的重建）绝不发生，实际 '
      + driver.calls.length);
  } finally { await bridge.close(); }
});

// ── ⑦ 控制面：session-slot 只读动作必须把驱动的那枚读数透出来 ──────────────────

test('⑦ 控制面 session-slot 动作必须能读回驱动当前的会话槽', async () => {
  const slot = { webSessionId: 'web-ctrl-42', at: 1_760_000_123_456, source: 'url-heal' };
  const driver = scriptedDriver({ script: [{ text: '好' }], slot });
  const bridge = await openBridge({ driver });
  const def = bridge.routes.get('/__webcode/session-slot');
  assert.ok(def, '`/__webcode/session-slot` 没有被挂上：动作名与冻结接口不一致'
    + '（已挂：' + [...bridge.routes.keys()].filter((p) => /session|status/.test(p)).join(', ') + '）');

  // mockCtx 的 webServer.register 直接把 handler 存进了表（见上面的 makeCtx）。
  const handle = bridge.routes.get('/__webcode/session-slot');
  const server = http.createServer((req, res) => {
    if (new URL(req.url, 'http://loopback').pathname === '/__webcode/session-slot') return handle(req, res);
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    let body = null;
    for (const method of ['POST', 'GET']) {
      const r = await fetch(`http://127.0.0.1:${port}/__webcode/session-slot`, {
        method, headers: { 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      if (r.status === 200) { body = await r.json(); break; }
    }
    assert.ok(body, 'POST/GET session-slot 都没有 200：动作挂上了但方法对不上（真机是 405）');
    const found = findSlotLike(body);
    assert.ok(found, '响应里找不到会话槽对象：' + JSON.stringify(body).slice(0, 300));
    assert.equal(found.webSessionId, slot.webSessionId,
      '读回的会话 id 与驱动的不一致：' + JSON.stringify(found));
    assert.equal(found.source, slot.source, 'source 必须原样透出（面板据此区分 store / url-heal / none）：' + JSON.stringify(found));
  } finally {
    // 等监听句柄真的关掉再退出：只调 `server.close()` 时 keep-alive 连接会让它迟迟不回调，
    // `--test-force-exit` 的强制退出会在 Windows 上撞 libuv 的 UV_HANDLE_CLOSING 断言
    // （表现是「子用例全绿、文件被判红」，attach-probe-contract 实测过）。
    await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); });
    await bridge.close();
  }
});

// ── ⑪ 0.16.29：fresh 的**原因**必须可查（用户第 4 问「搞清楚为什么会新开 web 端对话」）──
//
// 从前只有 `fresh` 一个布尔量，于是「又新开了一个对话」在四种完全不同的真因面前
// 长得一模一样：首次轮 / 契约变了 / 锚点丢了 / 锚定后无新消息。四者修法互不相同
// （前两个正常，后两个是真故障），因此逐因计数并透出 /status。
test('⑪ fresh 原因必须逐因可查：首轮记 no-cursor，契约变化记 contract-changed', async () => {
  const driver = scriptedDriver({ script: [{ text: '答复' }] });
  const bridge = await openBridge({ driver });
  try {
    const statusHandler = bridge.routes.get('/__webcode/status');
    assert.ok(statusHandler, '/__webcode/status 没挂上：已挂 ' + [...bridge.routes.keys()].join(', '));

    // 直接调控制面动作（`GET status` 同时支持 POST/GET，见 web-control 的 actions 别名）。
    const readStatus = async () => {
      const server = http.createServer((req, res) => {
        if (new URL(req.url, 'http://loopback').pathname === '/__webcode/status') return statusHandler(req, res);
        res.writeHead(404).end();
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const port = server.address().port;
      try {
        const r = await fetch(`http://127.0.0.1:${port}/__webcode/status`, { method: 'GET' });
        return await r.json();
      } finally {
        await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); });
      }
    };

    // ① 首轮：游标表里没有这个会话 ⇒ no-cursor。
    const first = await bridge.stream({ sessionId: 'sess-fresh-why', messages: messagesAt(1) });
    assert.equal(first.ok, true, '首轮应当成功');
    const s1 = await readStatus();
    assert.ok(s1.driver && s1.driver.freshReasons,
      '/status 上没有 driver.freshReasons：「为什么新开对话」仍只能靠读日志猜：'
      + JSON.stringify(Object.keys(s1.driver || {})));
    assert.equal(s1.driver.freshReasons['no-cursor'], 1,
      '首轮必须记成 no-cursor，实际 ' + JSON.stringify(s1.driver.freshReasons));

    // ② 契约变化（系统提示词改写）⇒ contract-changed，而不是笼统的「又 fresh 了一次」。
    // 这正是「宿主升级改了 system 措辞」那一类——它必须能一眼认出来，
    // 否则每次宿主小版本升级都会表现成「网页会话莫名其妙重开了」。
    const second = await bridge.stream({
      sessionId: 'sess-fresh-why', messages: messagesAt(2), system: '改写过的系统提示词',
    });
    assert.equal(second.ok, true, '契约变化轮应当成功：' + String(second.error?.message || '').slice(0, 200));
    const s2 = await readStatus();
    assert.equal(s2.driver.freshReasons['contract-changed'], 1,
      'system 改写必须记成 contract-changed，实际 ' + JSON.stringify(s2.driver.freshReasons));
  } finally { await bridge.close(); }
});

/** 在控制面响应里找「会话槽」对象：字段名固定为 webSessionId/source，包在外层哪个键里由实现决定。 */
function findSlotLike(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return null;
  if (typeof value.webSessionId !== 'undefined' && typeof value.source === 'string') return value;
  for (const v of Object.values(value)) {
    const hit = findSlotLike(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

// ── ⑧⑨ 驱动侧结构判据：落盘点必须在 runTurn 之内、且 id 来自地址栏 ─────────────

/** 斜杠处在「表达式起始位置」时它是正则字面量，不是除号（与 scripts/lint-comments.mjs 同源）。 */
const REGEX_START_AFTER = new Set(['', '=', '(', ',', ':', '[', '!', '&', '|', '?', '{', '}', ';', 'return']);

/** 跳过一段引号字面量（'…'、"…"、`…`），返回其结束后的下标；转义连同下一字符一起吞掉。 */
function skipQuoted(src, i) {
  const quote = src[i];
  i += 1;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === quote) return i + 1;
    i += 1;
  }
  return i;
}

/** 跳过一段正则字面量，返回其结束后的下标；字符类 `[…]` 内的 `/` 不结束正则。 */
function skipRegex(src, i) {
  i += 1;
  let inClass = false;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (inClass) { if (c === ']') inClass = false; }
    else if (c === '[') inClass = true;
    else if (c === '/') return i + 1;
    i += 1;
  }
  return i;
}

/**
 * 框出 `function <name>(…)` 的函数体（含两侧花括号），扫过字符串/注释/正则不计配平。
 *
 * 只把**括号之外**的花括号算进配平：`foo({ a: 1 })` 里的花括号属于实参，算进来会让函数体
 * 被提前判完（test/upload-attachment-structure.test.mjs 记过这次实测）。
 */
function functionBodyOf(src, name) {
  const m = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(src);
  if (!m) return null;
  let i = m.index + m[0].length;
  let paren = 1;
  let start = -1;
  let depth = 0;
  let prev = '';
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') { const e = src.indexOf('\n', i); i = e === -1 ? src.length : e + 1; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); i = e === -1 ? src.length : e + 2; continue; }
    if (c === "'" || c === '"' || c === '`') { i = skipQuoted(src, i); prev = c; continue; }
    if (c === '/' && REGEX_START_AFTER.has(prev)) { i = skipRegex(src, i); prev = '/'; continue; }
    if (c === '(') paren += 1;
    else if (c === ')') paren -= 1;
    else if (c === '{' && paren === 0) {
      if (start === -1) { start = i; depth = 1; prev = c; i += 1; continue; }
      depth += 1;
    } else if (c === '}' && paren === 0 && start !== -1) {
      depth -= 1;
      if (depth === 0) return { bodyStart: start, bodyEnd: i, body: src.slice(start, i + 1) };
    }
    if (c.trim() !== '') prev = c;
    i += 1;
  }
  return null;
}

test('⑧ 扫描器自检：嵌套看得见、字符串/正则/注释里的花括号不参与配平', () => {
  const nested = [
    'async function outer(arg, { opt = 1 } = {}) {',
    '  const re = /[{}]/g;',
    "  const s = '}';",
    '  /* } */',
    '  async function inner() { return 1; }',
    '  return inner;',
    '}',
    'async function inner() { return 2; }',
  ].join('\n');
  const outer = functionBodyOf(nested, 'outer');
  assert.ok(outer, '扫描器自检失败：连合成的 outer 都框不出来（那 ⑨ 就是永远假绿）');
  assert.ok(outer.body.includes('async function inner() { return 1; }'),
    '扫描器自检失败：嵌套函数没被算进外层函数体');
  assert.ok(!outer.body.includes('return 2'), '扫描器自检失败：函数体越界吃到了下一个同名函数');
});

test('⑨ 落盘点必须在 runTurn 之内、且网页会话 id 来自地址栏（不许只等整轮成功）', () => {
  const runTurn = functionBodyOf(DRIVER_SRC, 'runTurn');
  assert.ok(runTurn, '在 lib/browser-driver.js 里框不出 runTurn 的函数体：结构被改坏了（本判据的前提失效）');

  assert.match(runTurn.body, /rememberConversation\s*\(/,
    'runTurn 体内没有落盘点：会话槽只在「整轮成功之后」才写（sendTurn 收尾那一处），'
    + '而失败的一轮恰恰是最需要它的一轮——真机 187fdbbd 就是这么丢的。'
    + ' 修法：导航一落地就 `rememberConversation(key, id)`，不等本轮成功。');

  assert.ok(/sessionIdFromUrl\s*\(|conversationIdFromUrl\s*\(|page\??\.url\s*\?\.?\s*\(/.test(runTurn.body),
    'runTurn 体内没有从地址栏取会话 id 的调用（sessionIdFromUrl / conversationIdFromUrl / page.url()）：'
    + '落盘的 id 必须来自**已经落地的地址**，而不是等流里回传的 sessionId');

  // 落盘点必须早于本轮结束：它出现在函数体后半段（收尾/返回区）就说明还是「整轮成功才写」。
  const at = runTurn.body.search(/rememberConversation\s*\(/);
  assert.ok(at < runTurn.body.length * 0.9,
    '落盘点落在 runTurn 体的最后 10%（下标 ' + at + '/' + runTurn.body.length + '）：'
    + '那正是旧实现的形状——整轮跑完才写盘，失败的那一轮什么也不留');
});

// ── ⑩ 0.16.29：落盘文件必须是**投递源**（不只是副本）────────────────────────────
//
// 用户指令：「如果新开会话-web 端，就一样把这个当上下文通过文件发送」。
// 判据：整段重建时发出去的那段文本，**逐字等于磁盘上那份会话文件**——
// 也就是说，文件不是事后抄写的副本，而是重建时真正被读回来的正本。
test('⑩ 整段重建必须从落盘文件读回（文件是投递源，不是副本）', async () => {
  // 判据用**哨兵串**而不是字符数：把哨兵写进磁盘上的会话文件，再逼出一次整段重建；
  // 只要发出去的文本里出现哨兵，就证明它是从文件读回来的（内存序列化里没有这个串）。
  // 字符数比对会纠缠头部/换行/末尾空行，那种断言会随排版改动假红——哨兵不会。
  const storeDir = tmpDir('webcode-file-delivery-');
  const SENTINEL = 'FILE_DELIVERY_SENTINEL_7f3a';
  const sessionId = 'sess-file-delivery';
  const driver = scriptedDriver({
    script: [
      { text: '首轮答复', webSessionId: 'web-1' },   // 首轮正常 → 落盘
      { throw: 'WEB_SESSION_LOST' },                 // 第二轮原发丢失 → 触发整段重建
      { text: '重建答复', webSessionId: 'web-2' },   // 重建成功
    ],
  });
  process.env.WEBCODE_PROMPT_STORE_DIR = storeDir;
  const bridge = await openBridge({ driver, profileDir: tmpDir() });
  try {
    // 先跑一轮把文件写出来（fresh 首轮会落盘）。
    const first = await bridge.stream({ sessionId, messages: messagesAt(1) });
    assert.equal(first.ok, true, '首轮应当正常落盘：' + String(first.error?.message || '').slice(0, 200));
    // 会话文件名 **0.19.4 起带账号段**（`<sessionId>__<accountKey>.md`）：会话键里含
    // accountKey 是「一个对话对应唯一账号」的结构性保证（见 index.js 的 keyPath 注释）。
    // 因此这里按**前缀**找文件（判据关心的是「有没有落盘、重建是不是从它读回」，
    // 不是文件名拼接），并额外钉住账号段确实在名字里。
    const sessionsDir = path.join(storeDir, 'sessions');
    const names = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : [];
    const hit = names.find((n) => n.startsWith(sessionId + '__') && n.endsWith('.md'));
    assert.ok(hit, '首轮没有落下会话文件，文件投递无从谈起：' + JSON.stringify(names));
    assert.match(hit, /__[A-Za-z0-9_-]+\.md$/, '会话文件名必须带账号段（一个对话一个账号）');
    const sessionFile = path.join(sessionsDir, hit);

    // 把哨兵塞进磁盘上的正本 —— 下一次重建若真从文件读，就会把它带走。
    fs.appendFileSync(sessionFile, '\n' + SENTINEL + '\n');

    // 触发整段重建：丢掉会话槽 + 让下一次 sendTurn 抛 WEB_SESSION_LOST。
    const before = driver.calls.length;
    await bridge.stream({ sessionId, messages: messagesAt(2) });
    const sent = driver.calls.slice(before);
    const rebuilt = sent.filter((c) => c.fresh).pop();
    assert.ok(rebuilt, '整段重建没有发生（剧本没跑到）：' + JSON.stringify(sent));
    assert.ok(rebuilt.message.includes(SENTINEL),
      '重建发送的文本里没有磁盘上的哨兵 —— 说明它是内存序列化出来的，文件只是副本，'
      + '「把上下文通过文件发送」没有真正实现');
  } finally {
    delete process.env.WEBCODE_PROMPT_STORE_DIR;
    await bridge.close();
  }
});

test('⑨b sendTurn 必须把 requestedFresh 记进 navTrace（用户排障读的就是这一枚）', () => {
  const sendTurn = functionBodyOf(DRIVER_SRC, 'sendTurn');
  assert.ok(sendTurn, '框不出 sendTurn 的函数体：结构被改坏了');
  assert.match(sendTurn.body, /requestedFresh\s*:\s*fresh/,
    'navTrace 的 nav 相位没有记录 requestedFresh：'
    + '「这一轮为什么新开对话」就会重新变成只能靠猜的事（真机三次同形 navTrace 是本轮定位的关键读数）');
});
