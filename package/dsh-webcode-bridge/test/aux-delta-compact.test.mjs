// aux-delta-compact.test.mjs — 0.19.14 护栏：辅助调用（手动 /compact）的增量发送。
//
// 真机取证（2026-09-25 探针 test-mock/real-compact-probe.mjs + 会话扫描）：
//   · 病因：压缩调用的 messages = 整段历史回放 + 末尾一条 user 压缩指令；旧实现
//     把它当无会话键的独立首轮整包重发。真实长会话（本项目 ≈190 万字符 ≈110 万
//     token）必然撞 assertContextBudget 的 100 万预算闸（CONTEXT_WINDOW_EXCEEDED）
//     ——压缩只在需要压缩的会话上做不了。
//   · 修复（真机 A 相验证）：主会话游标命中（契约指纹一致 + 内容锚「只多最后一条」）
//     时只把指令作为增量发进既有网页会话；不命中回落整段独立首轮（带自己的 aux
//     会话槽，不再落到驱动的 'main' 槽被 URL 自愈接到错误会话上）。
//   · 两条路都不碰主游标：压缩成功后宿主替换 surface，下一真实轮自然整段重建；
//     压缩失败则游标原样有效。
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

const TOOLS = [{ name: 'read', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
const sys = (text) => ({ role: 'system', content: [{ type: 'text', text }] });
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const assistant = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] });

const INSTRUCTION = 'You are now acting as a compaction engine. Condense the conversation ABOVE into a structured checkpoint.';
const FILLER = '历史消息占位内容。'.repeat(120); // ≈1200 字符/条

function historyMessages() {
  const msgs = [sys('系统指令。')];
  for (let i = 0; i < 5; i++) {
    msgs.push(user(`第 ${i} 轮提问：${FILLER}`));
    msgs.push(assistant(`第 ${i} 轮答复：${FILLER}`));
  }
  return msgs;
}

/** 驱动桩：记录 (key, prompt, opts)，可编程失败（failWhen 命中即抛 failWith）。 */
function mockDriver({ failWhen = null, failWith = null } = {}) {
  const calls = [];
  return {
    calls,
    driver: {
      status: () => ({ running: true }),
      close: async () => {},
      resetConversation: async () => {},
      sendTurn: async (key, prompt, opts = {}) => {
        calls.push({ key, prompt, opts });
        if (failWhen && failWhen(key, prompt)) throw failWith();
        return { text: 'ok' };
      },
      sendPrompt: async (prompt) => { calls.push({ key: null, prompt, opts: {} }); return { text: 'ok' }; },
    },
  };
}

function boot(driver) {
  let adapter;
  const dispose = apply(
    { llm: { registerAdapter: (_, a) => { adapter = a; } }, get: () => null },
    { port: 0, requireConsent: false, contextMode: 'session', driver },
  );
  return { adapter, dispose };
}

async function drain(iter) { const chunks = []; for await (const c of iter) chunks.push(c); return chunks; }

test('压缩调用：主游标命中 → 只发指令增量进既有网页会话（不再整包重放）', async () => {
  const M = historyMessages();
  const { driver, calls } = mockDriver();
  const { adapter, dispose } = boot(driver);
  try {
    await drain(adapter.stream({ sessionId: 's1', model: 'deepseek:deepseek', tools: TOOLS, messages: M }));
    assert.equal(calls.length, 1);
    assert.ok(calls[0].prompt.includes('第 0 轮提问'), '真实首轮必须整段发出（含历史）');

    const aux = [...M, user(INSTRUCTION)];   // 同一批消息对象 + 末尾压缩指令
    const chunks = await drain(adapter.stream({
      sessionId: 's1', model: 'deepseek:deepseek', tools: TOOLS,
      purpose: 'compaction', maxTokens: 65536, messages: aux,
    }));
    assert.equal(calls.length, 2, '压缩调用必须真实发送');
    assert.equal(calls[1].key, 's1::deepseek', '必须发进主会话的网页对话');
    assert.equal(calls[1].opts.fresh, false, '必须续跑同一网页会话');
    assert.ok(calls[1].prompt.includes(INSTRUCTION), '增量正文 = 压缩指令');
    assert.ok(!calls[1].prompt.includes('第 0 轮提问'), '历史不得重发（网页侧本已保有哪些内容）');
    assert.ok(calls[1].prompt.length < 4000, `增量必须远小于整包（${calls[1].prompt.length} 字符）`);
    const usage = chunks.find((c) => c.type === 'usage');
    assert.ok(usage?.usage?.inputTokens > 5000, `usage 必须报主会话累计规模（${usage?.usage?.inputTokens}）`);
    assert.equal(chunks.at(-1).type, 'finish');
  } finally { await dispose(); }
});

test('压缩调用后主游标原样有效：下一真实轮仍是增量（游标不被辅助轮污染）', async () => {
  const M = historyMessages();
  const { driver, calls } = mockDriver();
  const { adapter, dispose } = boot(driver);
  try {
    await drain(adapter.stream({ sessionId: 's2', model: 'deepseek:deepseek', tools: TOOLS, messages: M }));
    await drain(adapter.stream({
      sessionId: 's2', model: 'deepseek:deepseek', tools: TOOLS,
      purpose: 'compaction', messages: [...M, user(INSTRUCTION)],
    }));
    await drain(adapter.stream({
      sessionId: 's2', model: 'deepseek:deepseek', tools: TOOLS,
      messages: [...M, user('压缩失败后继续的新任务')],
    }));
    const last = calls.at(-1);
    assert.ok(last.prompt.includes('压缩失败后继续的新任务'), '新任务必须发出');
    assert.ok(!last.prompt.includes('第 0 轮提问'), '游标未被污染：仍走增量，历史不重发');
    assert.ok(last.prompt.length < 4000, `真实轮保持增量形态（${last.prompt.length} 字符）`);
  } finally { await dispose(); }
});

test('游标不匹配（历史被改写）→ 回落整段独立首轮，用自己的 aux 会话槽且 fresh=true', async () => {
  const M = historyMessages();
  const { driver, calls } = mockDriver();
  const { adapter, dispose } = boot(driver);
  try {
    await drain(adapter.stream({ sessionId: 's3', model: 'deepseek:deepseek', tools: TOOLS, messages: M }));
    // 历史被替换（尾部改写 → 锚点失配）+ 指令
    const rewritten = [sys('系统指令。'), user('完全不同的历史。'), user(INSTRUCTION)];
    await drain(adapter.stream({
      sessionId: 's3', model: 'deepseek:deepseek', tools: TOOLS,
      purpose: 'compaction', messages: rewritten,
    }));
    assert.equal(calls.length, 2);
    assert.equal(calls[1].key, 'aux::compaction::s3', '必须用辅助专用槽，不得落到驱动 main 槽');
    assert.equal(calls[1].opts.fresh, true, '独立会话必须新开');
    assert.ok(calls[1].prompt.includes('完全不同的历史。'), '回落路径整包重放回放历史');
    assert.ok(calls[1].prompt.includes(INSTRUCTION), '整包含末尾指令');
    assert.ok(typeof calls[1].opts === 'object');
  } finally { await dispose(); }
});

test('无游标（新会话直接压缩）→ 回落整段独立首轮', async () => {
  const { driver, calls } = mockDriver();
  const { adapter, dispose } = boot(driver);
  try {
    await drain(adapter.stream({
      sessionId: 's4', model: 'deepseek:deepseek', tools: TOOLS,
      purpose: 'compaction', messages: [sys('系统指令。'), user('历史。'), user(INSTRUCTION)],
    }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].key, 'aux::compaction::s4');
    assert.equal(calls[0].opts.fresh, true);
    assert.ok(calls[0].prompt.includes(INSTRUCTION));
  } finally { await dispose(); }
});

test('增量发送遇 WEB_SESSION_LOST → 按既有语义整段重放（重建文本含全部历史）', async () => {
  const M = historyMessages();
  const err = new Error('WEB_SESSION_LOST: 会话槽为空 — 需要整段重建');
  err.code = 'WEB_SESSION_LOST';
  // 只把**第一次含指令的发送**（增量那发）打挂；重建重放的正文同样含指令，
  // 若不限定一次会把回落路径也打死（这正是护栏要验证的路径）。
  let failedOnce = false;
  const { driver, calls } = mockDriver({
    failWhen: (_key, prompt) => {
      if (!prompt.includes(INSTRUCTION)) return false;
      if (failedOnce) return false;
      failedOnce = true;
      return true;
    },
    failWith: () => err,
  });
  const { adapter, dispose } = boot(driver);
  try {
    await drain(adapter.stream({ sessionId: 's5', model: 'deepseek:deepseek', tools: TOOLS, messages: M }));
    await drain(adapter.stream({
      sessionId: 's5', model: 'deepseek:deepseek', tools: TOOLS,
      purpose: 'compaction', messages: [...M, user(INSTRUCTION)],
    }));
    assert.equal(calls.length, 3, `真实首轮 + 失败的增量 + 整段重放（实际 ${calls.length}）`);
    const rebuildCall = calls[2];
    assert.equal(rebuildCall.key, 's5::deepseek');
    assert.equal(rebuildCall.opts.fresh, true, '重放必须新开会话');
    assert.ok(rebuildCall.prompt.includes('第 0 轮提问'), '重放含整段历史');
    assert.ok(rebuildCall.prompt.includes(INSTRUCTION), '重放必须含本轮压缩指令（不能用落盘的真实首轮正本代替）');
  } finally { await dispose(); }
});
