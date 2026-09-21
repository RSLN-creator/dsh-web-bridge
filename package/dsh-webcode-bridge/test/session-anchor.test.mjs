// session-anchor.test.mjs — 0.16.28 护栏：会话游标的内容锚定（修「每轮整段重建」风暴）。
//
// ## 真机根因（session-4f236a51，2026-09-20 01:29–01:31，取证见 doc/progress.md 0.16.28）
//
// 宿主 goal 自动化每个 turn 把 `<goal_round>` 提示拼进消息数组头部（agent/inbox/spliced
// start=0 inserted=1）、turn 结束再移除（removed=1）。旧的「已发前缀整体指纹」对头部
// 增删零容忍 → 每轮判 fresh → 整段重建风暴（52 次 SESSION_SWITCHED、重放 245k→251k
// 字符逐轮膨胀、网页会话被反复重开）。
//
// 修法：指纹拆两层（契约指纹 + 内容锚）。本文件两组：
//   A 组（纯函数）：reanchorSent 的匹配语义、contractFingerprintOf 的口径边界。
//   B 组（行为级，真 apply + 脚本驱动）：goal 头槽轮转**不得**触发 fresh；
//   尾部真被改写 / 契约变化仍必须 fresh。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { messageHash, contractFingerprintOf, reanchorSent, ANCHOR_LEN } from '../lib/session-anchor.js';

const pkg = path.dirname(import.meta.dirname);

// ── A 组：纯函数 ────────────────────────────────────────────────────────────────

test('reanchorSent：头槽轮转（尾部最后一条被移除）后，靠持久尾段重定位游标', () => {
  // turn N 的数组：[..., p3, p4, p5, goalN]（goalN 是瞬态头槽的宿主侧投影）
  const p = (i) => ({ role: 'user', content: '持久消息 ' + i });
  const goalN = { role: 'user', content: '<goal_round> Round: 5/256' };
  const turnN = [p(1), p(2), p(3), p(4), p(5), goalN];
  const tails = turnN.slice(-ANCHOR_LEN).map(messageHash);
  // turn N+1 的数组：goalN 被移除，aN / goalN+1 追加——其余原样
  const turnNext = [p(1), p(2), p(3), p(4), p(5), { role: 'assistant', content: '第 5 轮答复' }, { role: 'user', content: '<goal_round> Round: 6/256' }];
  const re = reanchorSent(turnNext, tails);
  assert.ok(re, '持久尾段必须命中锚点');
  // 重定位点 = p5 之后：goalN 已不在数组里，增量应从 aN 开始
  assert.equal(re.sent, 5, '游标应落在 p5 之后（下标 5），实际 ' + re.sent);
  const delta = turnNext.slice(re.sent);
  assert.equal(delta.length, 2, '增量应恰为 [aN, goalN+1]');
  assert.equal(delta[0].role, 'assistant', '增量第一条应是新助手消息');
});

test('reanchorSent：重复内容取最后一次出现（最新对齐才是真对齐）', () => {
  const dup = { role: 'tool', content: 'ok' };
  const a = [{ role: 'user', content: 'q' }, dup, dup, { role: 'user', content: 'q2' }];
  // 已发尾部 = [dup, q2]；新数组里 [dup, q2] 只出现一次，但 dup 出现两次——
  // 单条（s=1 不启用）不会误配；这里钉 s=2 的连续段匹配。
  const tails = [dup, { role: 'user', content: 'q2' }].map(messageHash);
  const next = [{ role: 'user', content: 'q' }, dup, dup, { role: 'user', content: 'q2' }, dup, { role: 'user', content: 'q3' }];
  const re = reanchorSent(next, tails);
  assert.ok(re);
  assert.equal(re.sent, 4, '必须匹配 q2 的实际位置（下标 3）之后，实际 ' + re.sent);
});

test('reanchorSent：尾部真被改写（锚全部消失）→ null（回落整段重建）', () => {
  const tails = [{ role: 'user', content: '旧1' }, { role: 'user', content: '旧2' }].map(messageHash);
  const rewritten = [{ role: 'user', content: '压缩摘要' }, { role: 'user', content: '新消息' }];
  assert.equal(reanchorSent(rewritten, tails), null, '锚不存在时必须返回 null');
});

test('reanchorSent：短输入安全线（<2 条锚或 <2 条消息直接 null）', () => {
  const one = [{ role: 'user', content: 'x' }];
  assert.equal(reanchorSent(one, [messageHash(one[0])]), null, '锚只有 1 条 → null');
  assert.equal(reanchorSent([], [{}, {}]), null, '空数组 → null');
  assert.equal(reanchorSent(one, undefined), null, '无锚 → null');
});

test('contractFingerprintOf：只锁契约项（0.16.38 起含站点专属指令），消息内容不参与', () => {
  const base = { model: 'deepseek:deepseek', system: 'sys', toolNameKey: 'a,b', extraPrompt: '' };
  const f1 = contractFingerprintOf(base);
  assert.equal(f1, contractFingerprintOf({ ...base }), '同契约必须同指纹');
  assert.notEqual(f1, contractFingerprintOf({ ...base, model: 'glm:glm-5.3' }), '换模型必须换指纹');
  assert.notEqual(f1, contractFingerprintOf({ ...base, toolNameKey: 'a,b,c' }), '工具集变化必须换指纹');
  assert.notEqual(f1, contractFingerprintOf({ ...base, extraPrompt: '新全局指令' }), '全局指令变化必须换指纹');
  assert.notEqual(f1, contractFingerprintOf({ ...base, system: '新系统提示词' }), '系统提示词变化必须换指纹');
  // 0.16.38：站点专属指令与全局指令同一性质——它进的是网页侧的首轮正文，改了
  // 就必须整段重建（否则旧首轮里那一句永远留着，新的永远送不进去）。
  assert.notEqual(f1, contractFingerprintOf({ ...base, sitePrompt: '本网站指令' }), '站点专属指令变化必须换指纹');
  // 反向：未设置站点指令（undefined）与空串必须同指纹——否则「从没配过」会被当成
  // 「契约变了」，每轮整段重建一次。
  assert.equal(f1, contractFingerprintOf({ ...base, sitePrompt: '' }), '未设置站点指令与空串必须等价');
  // 消息内容不参与：契约相同、消息不同 → 指纹相同（内容归内容锚管）
  assert.equal(f1, contractFingerprintOf(base), '口径必须稳定（不含 messages）');
});

// ── B 组：行为级（真 apply + 脚本驱动，与 session-continuity 同源替身） ────────────

const BIG_CHARS = 150_000;

function mockCtx() {
  const registered = { adapter: null };
  const llm = {
    registerConfigurableProviders() {},
    registerAdapter(ids, adapter) { registered.adapter = adapter; },
  };
  const ctx = { llm, get(name) { return name === 'llm' ? llm : undefined; } };
  return { ctx, registered };
}

function scriptedDriver({ script = [] } = {}) {
  const calls = [];
  let i = 0;
  return {
    calls,
    async sendTurn(key, message, { fresh = false, onDelta } = {}) {
      const step = script[Math.min(i, script.length - 1)] || { text: '好' };
      i += 1;
      calls.push({ fresh: Boolean(fresh), messageChars: String(message || '').length });
      if (step.throw) { const e = new Error(step.throw); e.code = step.throw; throw e; }
      onDelta?.(step.text || '好');
      return { text: step.text || '好', sessionId: step.webSessionId || 'web-1' };
    },
    async sendPrompt(prompt) { calls.push({ fresh: true, messageChars: String(prompt || '').length }); return { text: '好', sessionId: 'web-1' }; },
    async resetConversation() {},
    status() { return { running: true, busy: false, preview: true, loggedIn: true, conversations: {}, sessionSlot: { webSessionId: null, at: null, source: 'none' }, navTrace: [] }; },
    async close() {},
  };
}

async function openBridge(driver) {
  const { apply } = await import('../lib/index.js');
  const { ctx, registered } = mockCtx();
  // profileDir 必须给临时目录：不给的话设置层会读到真实 ~/.dsh 的 settings
  //（真机 sendGapMs=30s），行为测试会被发送间隔拖住 30 秒一轮。
  let profileDir;
  try { profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webcode-anchor-')); } catch {
    profileDir = path.join(pkg, '.tmp', 'anchor-' + Date.now());
    fs.mkdirSync(profileDir, { recursive: true });
  }
  const disposer = apply(ctx, { port: 0, host: '127.0.0.1', requireConsent: false, driver, profileDir });
  if (!registered.adapter) throw new Error('适配器没注册上');
  return {
    async stream({ sessionId, messages }) {
      let text = '';
      for await (const c of registered.adapter.stream({ purpose: null, model: 'deepseek', messages, tools: [], sessionId })) {
        if (c?.type === 'text-delta') text += c.text;
      }
      return text;
    },
    close() { return Promise.resolve(disposer?.()).catch(() => {}); },
  };
}

test('行为级：goal 头槽轮转（turn 间头部增删）不得触发整段重建', async () => {
  const driver = scriptedDriver({ script: [{ text: '第 1 轮答复' }, { text: '第 2 轮答复' }] });
  const bridge = await openBridge(driver);
  try {
    const sessionId = 'sess-anchor-goal';
    // turn 1：[u1, goal1]——宿主把 goal 提示作为本轮 user 消息追加（真机形状）
    const turn1 = [
      { role: 'user', content: '任务指令（' + 'A'.repeat(BIG_CHARS) + '）' },
      { role: 'user', content: '<goal_round>\nObjective: 做完它\nRound: 1/256\n\nContinue working toward the objective.' },
    ];
    await bridge.stream({ sessionId, messages: turn1 });
    assert.equal(driver.calls[0].fresh, true, '首轮必须 fresh');
    assert.equal(driver.calls[0].messageChars > BIG_CHARS, true, '首轮是整段');

    // turn 2：goal1 被移除、assistant 答复与新 goal 追加（真机 splice 形状）。
    // 旧整体指纹在这里必然失配（前缀窗口内容位移）→ 旧实现整段重建；
    // 新实现靠内容锚重定位 → 续同一网页会话发增量。
    const turn2 = [
      { role: 'user', content: '任务指令（' + 'A'.repeat(BIG_CHARS) + '）' },
      { role: 'assistant', content: '第 1 轮答复' },
      { role: 'user', content: '<goal_round>\nObjective: 做完它\nRound: 2/256\n\nContinue working toward the objective.' },
    ];
    await bridge.stream({ sessionId, messages: turn2 });
    assert.equal(driver.calls[1].fresh, false,
      '头槽轮转后第二轮必须续同一网页会话（fresh=false），实际走了整段重建：'
      + JSON.stringify(driver.calls));
    assert.ok(driver.calls[1].messageChars < 5_000,
      '第二轮应是增量（messageChars=' + driver.calls[1].messageChars + '），不该重放首轮大数');
  } finally { await bridge.close(); }
});

test('行为级：尾部真被改写（历史被替换）仍必须整段重建', async () => {
  const driver = scriptedDriver({ script: [{ text: '第 1 轮答复' }, { text: '第 2 轮答复' }] });
  const bridge = await openBridge(driver);
  try {
    const sessionId = 'sess-anchor-rewrite';
    const turn1 = [
      { role: 'user', content: '任务指令（' + 'A'.repeat(BIG_CHARS) + '）' },
      { role: 'user', content: '第 1 轮问题' },
    ];
    await bridge.stream({ sessionId, messages: turn1 });
    // turn 2：历史被压缩摘要替换（锚全部消失）→ 必须 fresh 整段重建
    const turn2 = [
      { role: 'user', content: '【压缩摘要】早期上下文已浓缩' },
      { role: 'user', content: '第 2 轮问题' },
    ];
    await bridge.stream({ sessionId, messages: turn2 });
    assert.equal(driver.calls[1].fresh, true,
      '锚全部消失（历史被改写）时必须整段重建，实际没重建：' + JSON.stringify(driver.calls));
  } finally { await bridge.close(); }
});
