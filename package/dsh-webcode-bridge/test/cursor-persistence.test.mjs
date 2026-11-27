// cursor-persistence.test.mjs — 会话游标持久化 + 命名键形修复的护栏（0.21.1）。
//
// ## 真机症状（用户原话，本轮定位）
//
//   ① 「dsh 重启后不同会话」：sessionState 是纯内存 Map，dsh web 重启即清零 →
//      no-cursor → fresh → 整段重发（网页侧也跟着重 prefill）。网页会话身份
//      早已落盘（webcode-sessions-deepseek.json），丢的只是「发到第几条」。
//      long-term-issues.md #2（164-191 行）早已登记并写明修法方向。
//   ② 「dsh 没有同步 deepseek 会话智能标题」：命名链路已通，但查槽用裸
//      sessionId（webConversationTitle → conversationFor），而写入形状是
//      `<sessionId>::<accountKey>`（0.19.4 起带账号段）——键形错配必然 miss，
//      永远回落「首句截 16 字」。
//
// ## 修法与安全线（本文件钉住）
//
//   · 修复①：commit/invalidate 时原子落盘（tmp+rename）到
//     <profileDir>/webcode-cursor-state.json，启动回灌（上限 512 不变）。
//     **陈旧条目必须自愈**：契约变了 ⇒ contract-changed；transcript 漂了 ⇒
//     anchor-lost——持久化绝不能把旧游标错当新游标（③④ 两条反向线）。
//   · 修复②：裸 id 直查 miss 后按会话前缀查（驱动侧 conversationForSession，
//     优先本槽自己的 accountKey，多账户槽不串标题）。
//
// 测试驱动方式与 session-continuity.test.mjs 同源：真实 apply() + 注入脚本驱动，
// 「跨实例」= 先 openBridge 跑两轮后 close，再用**同一个 profileDir** 重新 openBridge
// ——这正等价于 dsh web 重启（新进程、新 Map、同磁盘）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const pkg = path.dirname(import.meta.dirname);
const BIG_CHARS = 60_000;

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'hwb-cursor-')); }

function mockCtx() {
  const registered = { adapter: null, routes: new Map() };
  const llm = {
    registerConfigurableProviders() {},
    registerAdapter(ids, adapter) { registered.adapter = adapter; },
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

function scriptedDriver({ slot = null } = {}) {
  const calls = [];
  let i = 0;
  const stub = {
    calls,
    async sendTurn(key, message, { fresh = false } = {}) {
      const step = { text: '好' };
      i += 1;
      calls.push({ key: String(key), fresh: Boolean(fresh), messageChars: String(message || '').length });
      return { text: step.text, sessionId: 'web-1' };
    },
    async sendPrompt() { return { text: '好', sessionId: 'web-1' }; },
    async resetConversation() {},
    conversationFor() { return slot; },
    conversationForSession(sessionId) { return slot ? { ...slot, requestedId: sessionId } : null; },
    async listSessions() { return { sessions: [{ id: 'web-1', title: '网页端真实标题' }] }; },
    status() {
      return { running: true, busy: false, preview: true, loggedIn: true, lastActivityAt: null, domReplyChars: null,
        lastEndReason: null, lastEndReasonAt: null, recoveredTurns: 0, lastRecovered: null, lastStalledSettle: null,
        thinkingOnlyTurns: 0, conversations: {}, sessionSlot: slot || { webSessionId: null, at: null, source: 'none' }, navTrace: [] };
    },
    async close() {},
  };
  return stub;
}

async function openBridge({ driver, profileDir, purpose = null } = {}) {
  const { apply } = await import(pathToFileURL(path.join(pkg, 'lib', 'index.js')).href);
  const { ctx, registered } = mockCtx();
  const disposer = apply(ctx, { port: 0, host: '127.0.0.1', requireConsent: false, driver, profileDir });
  if (!registered.adapter) throw new Error('适配器没注册上');
  return {
    async stream({ sessionId, messages, model = 'deepseek', tools = [] }) {
      let text = '';
      for await (const c of registered.adapter.stream({ purpose, model, messages, tools, sessionId })) {
        if (c?.type === 'text-delta') text += c.text;
      }
      return { text };
    },
    close() { return Promise.resolve(disposer?.()).catch(() => {}); },
  };
}

function messagesAt(turn) {
  const big = 'A'.repeat(BIG_CHARS);
  const out = [{ role: 'user', content: big }];
  for (let k = 1; k < turn; k += 1) {
    out.push({ role: 'assistant', content: '第 ' + k + ' 轮答复' });
    out.push({ role: 'user', content: '第 ' + (k + 1) + ' 轮的问题' });
  }
  return out;
}


const DEEPSEEK_REMOTE_ID = '187fdbbd-2f5a-4a37-9d0e-9c7b1f4a2c31';
const DEEPSEEK_REMOTE_URL = 'https://chat.deepseek.com/a/chat/s/' + DEEPSEEK_REMOTE_ID;

/**
 * Offline DeepSeek page fixture for the full restart path.
 *
 * On the first process it changes to the remote conversation URL at the navigation/
 * identity-probe phase. On the second process it starts at the origin and only changes
 * URL when the real browser driver navigates back to its persisted conversation.
 */
function deepseekRestartPage({ firstProcess = false } = {}) {
  let url = 'https://chat.deepseek.com/';
  const gotoCalls = [];
  const page = {
    isClosed: () => false,
    url: () => url,
    async goto(target) {
      const next = String(target);
      gotoCalls.push(next);
      url = next;
    },
    async waitForSelector() { return null; },
    async evaluate() {
      if (firstProcess) url = DEEPSEEK_REMOTE_URL;
      return 1;
    },
    on() {}, off() {},
    async close() {},
    locator: () => ({ first: () => ({ count: async () => 0, isVisible: async () => false }) }),
  };
  page.context = () => ({ on() {}, newPage: async () => page, close: async () => {} });
  return { page, gotoCalls };
}

/**
 * Keep real browser-driver navigation and persistence, but stub only the final remote
 * generation result. The page deliberately has no actionable composer, so the real
 * driver must stop after it has recorded/resumed the remote conversation identity.
 */
function withFixtureGeneration(driver, { expectedFresh, gotoCalls }) {
  const calls = [];
  const realSendTurn = driver.sendTurn.bind(driver);
  driver.sendTurn = async (key, message, options = {}) => {
    calls.push({
      key: String(key),
      fresh: options.fresh === true,
      messageChars: String(message || '').length,
    });

    let pageFailure = null;
    try {
      await realSendTurn(key, message, options);
    } catch (error) {
      pageFailure = error;
    }

    assert.equal(pageFailure?.message,
      'No visible editable composer matched the site contract or semantic fallback',
      'the fixture must stop only at the deliberate missing-composer boundary; unexpected driver failures must fail the test');
    assert.equal(options.fresh === true, expectedFresh,
      'the browser driver must receive the expected fresh/resume mode');

    const slot = driver.status().sessionSlot;
    assert.equal(slot?.webSessionId, DEEPSEEK_REMOTE_ID,
      'the browser driver status projection must expose the persisted remote conversation identity: '
      + JSON.stringify({ key, slot, navTrace: driver.status().navTrace }));
    assert.equal(slot?.source, 'store',
      'the restarted DSH bridge must observe the record from the browser profile, not infer it from the current URL');
    if (!expectedFresh) {
      assert.ok(gotoCalls.includes(DEEPSEEK_REMOTE_URL),
        'a restarted browser must navigate back to the exact persisted remote conversation: '
        + JSON.stringify(gotoCalls));
    }

    return { text: 'fixture browser reply', sessionId: DEEPSEEK_REMOTE_ID };
  };
  return calls;
}

test('① 游标跨实例存活：重启（同 profileDir 新实例）后继续增量，不再整段重发', async () => {
  const profileDir = tmpDir();
  const driverA = scriptedDriver();
  const bridgeA = await openBridge({ driver: driverA, profileDir });
  await bridgeA.stream({ sessionId: 'sess-1', messages: messagesAt(1) });
  await bridgeA.stream({ sessionId: 'sess-1', messages: messagesAt(2) });
  assert.equal(driverA.calls.at(-1).fresh, false, '实例内第二轮应增量');
  assert.equal(driverA.calls.at(-1).messageChars < BIG_CHARS, true);
  await bridgeA.close();

  const driverB = scriptedDriver();
  const bridgeB = await openBridge({ driver: driverB, profileDir });
  const r = await bridgeB.stream({ sessionId: 'sess-1', messages: messagesAt(3) });
  assert.equal(driverB.calls.length, 1);
  assert.equal(driverB.calls[0].fresh, false, '重启后不得 fresh（游标已持久化）');
  assert.equal(driverB.calls[0].messageChars < BIG_CHARS, true, '重启后必须只发增量，实际 '
    + driverB.calls[0].messageChars + ' 字符');
  await bridgeB.close();
  fs.rmSync(profileDir, { recursive: true, force: true });
});

test('② 安全线：契约变了（工具表变化）必须自愈 fresh，持久化不得骗过契约检查', async () => {
  const profileDir = tmpDir();
  const driverA = scriptedDriver();
  const bridgeA = await openBridge({ driver: driverA, profileDir });
  await bridgeA.stream({ sessionId: 'sess-1', messages: messagesAt(1) });
  await bridgeA.close();

  const driverB = scriptedDriver();
  const bridgeB = await openBridge({ driver: driverB, profileDir });
  await bridgeB.stream({ sessionId: 'sess-1', messages: messagesAt(1), tools: [{ name: 'read' }] });
  assert.equal(driverB.calls[0].fresh, true, '契约变化必须 fresh');
  await bridgeB.close();
  fs.rmSync(profileDir, { recursive: true, force: true });
});

test('③ 安全线：transcript 漂了（历史内容不同）必须自愈 fresh（锚点失效）', async () => {
  const profileDir = tmpDir();
  const driverA = scriptedDriver();
  const bridgeA = await openBridge({ driver: driverA, profileDir });
  await bridgeA.stream({ sessionId: 'sess-1', messages: messagesAt(1) });
  await bridgeA.close();

  const driverB = scriptedDriver();
  const bridgeB = await openBridge({ driver: driverB, profileDir });
  // 同长度但内容不同的历史 ⇒ 内容锚全部失配 ⇒ anchor-lost ⇒ fresh
  const drifted = [{ role: 'user', content: 'B'.repeat(BIG_CHARS) }];
  await bridgeB.stream({ sessionId: 'sess-1', messages: drifted });
  assert.equal(driverB.calls[0].fresh, true, '历史漂移必须 fresh');
  await bridgeB.close();
  fs.rmSync(profileDir, { recursive: true, force: true });
});

test('④ 坏文件不致命：游标文件损坏时新实例照常起、首轮照常 fresh', async () => {
  const profileDir = tmpDir();
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'webcode-cursor-state.json'), '{ 坏掉的 JSON');
  const driver = scriptedDriver();
  const bridge = await openBridge({ driver, profileDir });
  const r = await bridge.stream({ sessionId: 'sess-1', messages: messagesAt(1) });
  assert.equal(driver.calls[0].fresh, true, '无游标 ⇒ fresh');
  assert.ok(fs.existsSync(path.join(profileDir, 'webcode-cursor-state.json')), '本轮 commit 后应重新落盘');
  await bridge.close();
  fs.rmSync(profileDir, { recursive: true, force: true });
});

test('⑤ 命名键形：裸 id 精确 miss 后必须走前缀查，取回网页端真实标题', async () => {
  const profileDir = tmpDir();
  // slot 存的是「写入形状」的条目：conversationFor（裸 id）刻意 miss，
  // 只有 conversationForSession（前缀查）能命中 ⇒ 修的是键形错配本身。
  const driver = scriptedDriver({ slot: { webSessionId: 'web-1' } });
  const bridge = await openBridge({ driver, profileDir, purpose: 'session-title' });
  const r = await bridge.stream({ sessionId: 'sess-9', messages: [{ role: 'user', content: '随便说点什么' }] });
  assert.equal(r.text, '网页端真实标题', '命名必须取回网页端真实标题，实际：' + JSON.stringify(r.text));
  await bridge.close();
  fs.rmSync(profileDir, { recursive: true, force: true });
});


test('⑥ DSH restart composes the persisted cursor with the same browser profile and remote chat', async () => {
  const profileDir = tmpDir();
  const sessionId = 'sess-cross-layer-restart';

  // First DSH process: a real apply() + real browser driver. The fixture page lands in
  // the remote chat; the wrapper substitutes only the final generated answer so apply()
  // can commit its real DSH cursor to the same profile directory.
  const firstPage = deepseekRestartPage({ firstProcess: true });
  const driverA = await import('../lib/browser-driver.js')
    .then(({ createBrowserDriver }) => createBrowserDriver({
      siteId: 'deepseek',
      site: 'https://chat.deepseek.com/',
      profileDir,
      headless: true,
      page: firstPage.page,
      requestTimeoutMs: 5_000,
    }));
  const firstCalls = withFixtureGeneration(driverA, {
    expectedFresh: true,
    gotoCalls: firstPage.gotoCalls,
  });
  const bridgeA = await openBridge({ driver: driverA, profileDir });
  try {
    const first = await bridgeA.stream({ sessionId, messages: messagesAt(1) });
    assert.equal(first.text, 'fixture browser reply');
    assert.equal(firstCalls.length, 1);
    assert.equal(firstCalls[0].fresh, true);
    assert.ok(firstCalls[0].messageChars >= BIG_CHARS,
      'the first DSH turn must be the full transcript');
    assert.equal(driverA.status().sessionSlot?.webSessionId, DEEPSEEK_REMOTE_ID);
  } finally {
    await bridgeA.close();
  }

  // Both durable links must exist before the simulated process restart:
  //   1) DSH cursor (which determines fresh=false and the short incremental payload);
  //   2) browser-driver session store (which maps the same driver key to the remote chat).
  const cursorFile = path.join(profileDir, 'webcode-cursor-state.json');
  const conversationFile = path.join(profileDir, 'webcode-sessions-deepseek.json');
  assert.ok(fs.existsSync(cursorFile), 'the first apply() must persist the DSH cursor');
  assert.ok(fs.existsSync(conversationFile), 'the first browser driver must persist the remote chat');
  const webStore = JSON.parse(fs.readFileSync(conversationFile, 'utf8'));
  assert.equal(webStore[firstCalls[0].key]?.webSessionId, DEEPSEEK_REMOTE_ID,
    'the browser profile must map the exact DSH driver key to the remote conversation ID');

  // Second DSH process: brand-new apply() closure, new cursor Map and new browser driver,
  // but the same stable DSH Session ID and profile directory. The new page starts at the
  // site root; only the driver's persisted conversation mapping can take it back to chat.
  const secondPage = deepseekRestartPage({ firstProcess: false });
  const driverB = await import('../lib/browser-driver.js')
    .then(({ createBrowserDriver }) => createBrowserDriver({
      siteId: 'deepseek',
      site: 'https://chat.deepseek.com/',
      profileDir,
      headless: true,
      page: secondPage.page,
      requestTimeoutMs: 5_000,
    }));
  const secondCalls = withFixtureGeneration(driverB, {
    expectedFresh: false,
    gotoCalls: secondPage.gotoCalls,
  });
  const bridgeB = await openBridge({ driver: driverB, profileDir });
  try {
    const second = await bridgeB.stream({ sessionId, messages: messagesAt(2) });
    assert.equal(second.text, 'fixture browser reply');
    assert.equal(secondCalls.length, 1);
    assert.equal(secondCalls[0].key, firstCalls[0].key,
      'the restarted apply() must address the same DSH session/account driver key');
    assert.equal(secondCalls[0].fresh, false,
      'the persisted DSH cursor must prevent a full fresh turn after restart');
    assert.ok(secondCalls[0].messageChars < BIG_CHARS,
      'the restarted DSH session must send only an incremental transcript');
    assert.equal(driverB.status().sessionSlot?.webSessionId, DEEPSEEK_REMOTE_ID,
      'the new browser driver must recover the same remote conversation ID from the profile');
    assert.ok(secondPage.gotoCalls.includes(DEEPSEEK_REMOTE_URL),
      'the new browser page must navigate to the same remote chat, not open another one');
  } finally {
    await bridgeB.close();
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
});
