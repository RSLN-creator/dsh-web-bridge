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
