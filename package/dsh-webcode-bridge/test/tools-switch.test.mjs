// tools-switch.test.mjs — 工具总闸（toolsEnabled，0.22.2）的行为护栏。
//
// 用户指令（2026-10-24）：「常时默认桥接网页就是只单独保留网页会话……开启后才是
// 现在这样的：提示词注入新工具调用」。本文件钉住这句话的三层含义：
//   ① 默认关 = 纯网页会话：prompt 只含用户原话（零注入），含 mcp_action 围栏的
//      回复**零重放**（一个工具调用块都不产生）、围栏原样作为正文透传；
//   ② 开 = 既有 agent 协议（首轮教工具，回复重放成 DSH 原生工具调用）——行为
//      与 0.22.1 逐字一致（这一点由 tool-loop / regression 等既有护栏继续钉）；
//   ③ 关⇄开切换 ⇒ 契约指纹必变 ⇒ 整段重建（绝不把增量发进教过协议的会话，
//      红线 2 的开关版）；重放带 '[assistant] ' 说话人标记，上下文不静默丢失。
//
// 护栏标准（test/ 的反向验证纪律）：把实现改错一行这些用例必须变红——
// 已做反向验证：见 doc/progress.md 0.22.2 节的变异体表。
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';
import { serializePlainTurn, serializePlainDelta, serializeFirstTurn } from '../lib/agent-preset.js';
import { createWebControl } from '../lib/web-control.js';

const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const TOOL = { name: 'pwsh', description: 'run', parameters: { type: 'object', properties: { command: { type: 'string' } } } };
const FENCE_REPLY = '好的。\n```json\n{"mcp_action":"call","name":"pwsh","arguments":{"command":"Get-Date"}}\n```';

/** 建一个可用 state 对象控制 toolsEnabled 的桥实例，收集驱动收到的全部 prompt。 */
function harness(state) {
  let adapter;
  const prompts = [];
  const driver = {
    status: () => ({ running: true }), close: async () => {}, resetConversation: async () => {},
    sendTurn: async (key, prompt, opts) => { prompts.push({ key, prompt }); opts?.onDelta?.(state.reply ?? FENCE_REPLY); return { text: state.reply ?? FENCE_REPLY }; },
    sendPrompt: async (prompt) => { prompts.push({ prompt }); return { text: '' }; },
  };
  // settings 桩对齐宿主签名：get(ns) / set(ns, value)——configManager 传的是
  // ('webcode', merged) 两参；只收一参会把 'webcode' 字符串 assign 进 state。
  const settings = {
    get: () => ({ ...state }),
    set: (ns, value) => { Object.assign(state, value ?? {}); return { ...state }; },
  };
  const ctx = { llm: { registerAdapter: (_, a) => { adapter = a; } }, get: (n) => (n === 'settings' ? settings : null) };
  const dispose = apply(ctx, { port: 0, requireConsent: false, driver });
  return { adapter, prompts, dispose };
}

async function collect(adapter, options) {
  const chunks = [];
  for await (const c of adapter.stream(options)) chunks.push(c);
  return chunks;
}

// ---- ① 纯网页序列化（agent-preset 的两个纯函数）--------------------------------

test('纯网页序列化：只发用户原话，任何注入物都不出现', () => {
  const out = serializePlainTurn({
    messages: [user('你好，今天天气如何？')],
    system: 'You are a coding agent.', extraPrompt: 'GLOBAL-INJECT', sitePrompt: 'SITE-INJECT',
    tools: [TOOL], siteId: 'deepseek',
  });
  assert.equal(out, '你好，今天天气如何？');
  for (const banned of ['GLOBAL-INJECT', 'SITE-INJECT', '可用本地工具', '[会话开始]', '[系统指令]', '[全局指令]', 'mcp_action']) {
    assert.ok(!out.includes(banned), `纯模式首轮不得出现 ${banned}`);
  }
});

test('纯网页序列化：DSH 斜杠指令原样透传（不做 normalizeHarnessDirective 改写）', () => {
  const plain = serializePlainTurn({ messages: [user('/compact 保留要点')] });
  assert.equal(plain, '/compact 保留要点');
  // 对照：同一输入在工具模式下会被改写成 [DSH 压缩命令] 形状。
  const on = serializeFirstTurn({ messages: [user('/compact 保留要点')], tools: [TOOL], siteId: 'kimi' });
  assert.ok(on.includes('[DSH 压缩命令]'), '对照失效：工具模式本应改写斜杠指令');
});

test('纯网页整段重放：assistant 带 [assistant] 标记、system 跳过、工具痕迹如实带过', () => {
  const out = serializePlainTurn({
    messages: [
      { role: 'system', content: 'SYSTEM-NOISE' },
      user('问一'),
      { role: 'assistant', content: [{ type: 'text', text: '答一' }] },
      { role: 'tool', content: [{ type: 'text', text: 'tool-out' }] },
      user('问二'),
    ],
  });
  assert.ok(out.includes('问一') && out.includes('问二') && out.includes('[assistant] 答一'),
    '重放必须保住全部对话内容（红线 2）');
  assert.ok(!out.includes('SYSTEM-NOISE'), '零注入：system 整条跳过');
  assert.ok(out.includes('本地工具调用/结果记录'), '工具痕迹必须如实带一行说明，不得静默丢弃');
  assert.ok(!out.includes('mcp_action'), '重放不得携带任何协议形状');
});

test('纯网页预算重试：超上限保最新后缀 + 显式省略标记（绝不静默截断）', () => {
  const out = serializePlainTurn({
    messages: [user('a'.repeat(80)), user('b'.repeat(60))],
    maxPromptChars: 90,
  });
  assert.ok(out.includes('b'.repeat(60)), '最新消息必须完整保留');
  assert.ok(out.includes('已省略 1 条'), '省略必须有显式标记');
  assert.ok(!out.includes('a'.repeat(80)), '最旧段应被整段省略（不是截半截字符串）');
});

test('纯网页增量为空时的兜底与游标推进', () => {
  const delta = serializePlainDelta([user('一'), { role: 'assistant', content: [{ type: 'text', text: '答' }] }], 0);
  assert.equal(delta.text, '一');
  assert.equal(delta.consumed, 2, 'assistant 跳过但仍计数（游标必须推进）');
  assert.equal(serializePlainDelta([], 0).text, '[系统] 上一次回复未成功接收，请重新回复。');
});

// ---- ② 适配器级行为（默认关 = 纯网页会话）---------------------------------------

test('总闸默认关：首轮 prompt 就是用户原话（零注入）', async () => {
  const { adapter, prompts, dispose } = harness({});
  try {
    await collect(adapter, { sessionId: 'sw-pure-1', messages: [user('看时间')], tools: [TOOL] });
    assert.equal(prompts[0].prompt, '看时间', 'toolsEnabled 缺省 ⇒ 纯模式 ⇒ 零注入');
  } finally { await dispose(); }
});

test('总闸默认关：含 mcp_action 围栏的回复零重放、围栏原样透传、收尾是 stop', async () => {
  const { adapter, prompts, dispose } = harness({});
  try {
    const chunks = await collect(adapter, { sessionId: 'sw-pure-2', messages: [user('看时间')], tools: [TOOL] });
    const calls = chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'tool-call');
    assert.equal(calls.length, 0, '纯模式下不得产生任何工具调用块');
    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
    assert.ok(text.includes('mcp_action'), '围栏必须原样作为正文透传（不扣留、不解析）');
    assert.equal(chunks.at(-1)?.reason?.kind, 'stop', '收尾必须是普通 stop，不是 tool-calls');
  } finally { await dispose(); }
});

test('总闸默认关：设置里存了非法值（字符串/1）也一律按关处理', async () => {
  const { adapter, prompts, dispose } = harness({ toolsEnabled: 'true' });
  try {
    await collect(adapter, { sessionId: 'sw-pure-3', messages: [user('看时间')], tools: [TOOL] });
    assert.equal(prompts[0].prompt, '看时间', '读取侧只认逐字 true——写错的配置退化成默认行为');
  } finally { await dispose(); }
});

// ---- ③ 开关切换 ⇒ 契约重建 ------------------------------------------------------

test('开关切换 ⇒ 契约指纹必变 ⇒ 整段重建（最苛场景：无工具、有系统提示、无指令）', async () => {
  // 为什么不给工具、不给指令：那种会话里 toolNameKey/extraPrompt/sitePrompt 三项
  // 在开关两侧都相同，契约指纹**只能**靠 system 门变化——摘掉它，增量就会发进
  // 一个带着旧系统提示的网页会话（红线 2 的开关版）。变异 M3 正是靠这条用例抓红。
  const state = { toolsEnabled: true };
  const { adapter, prompts, dispose } = harness(state);
  const sysTurn = (msgs) => ({
    sessionId: 'sw-mix-1', messages: msgs,
    system: 'SYS-PROMPT-MARKER You are a coding agent.',
  });
  try {
    await collect(adapter, sysTurn([user('问一')]));
    assert.ok(prompts[0].prompt.includes('[系统指令]') && prompts[0].prompt.includes('SYS-PROMPT-MARKER'),
      '开闸首轮必须注入系统指令（对照组）');
    state.toolsEnabled = false;
    await collect(adapter, sysTurn([
      user('问一'), { role: 'assistant', content: [{ type: 'text', text: '答一' }] }, user('问二'),
    ]));
    const p = prompts[1].prompt;
    assert.ok(!p.includes('SYS-PROMPT-MARKER') && !p.includes('[系统指令]'),
      '关闸后的重建不得再注入任何系统内容');
    assert.ok(p.includes('[assistant] 答一'), '整段重放带说话人标记（上下文不静默丢失）');
    assert.ok(p.includes('问二'), '最新消息必须在场');
  } finally { await dispose(); }
});

// ---- ④ 设置归一化（web-control 的 GET/POST 同口径）------------------------------

test('POST settings：toolsEnabled 只认逐字 true；GET settings 回带默认 false', async () => {
  const state = {};
  const control = createWebControl({
    driver: { status: () => ({ running: false, busy: false }) },
    relay: { status: () => ({ running: true, consent: true, busy: false }), setConsent() {}, config: {} },
    config: {}, host: {}, logger: { log() {}, warn() {} },
    presetInfo: () => null,
    settingsStore: { get: () => ({ ...state }), set: (v) => { Object.assign(state, v); return { ...state }; } },
  });
  assert.equal((await control.actions['POST settings']({ toolsEnabled: 'true' })).toolsEnabled, false,
    "字符串 'true' 必须归 false（写入侧唯一归一化点）");
  assert.equal((await control.actions['POST settings']({ toolsEnabled: 1 })).toolsEnabled, false,
    '数字 1 必须归 false');
  assert.equal((await control.actions['POST settings']({ toolsEnabled: true })).toolsEnabled, true,
    '逐字 true 是唯一合法开启值');
  assert.equal((await control.actions['GET settings']()).toolsEnabled, true,
    'GET 回带与落盘一致的值');
  const fresh = createWebControl({
    driver: { status: () => ({ running: false, busy: false }) },
    relay: { status: () => ({ running: true, consent: true, busy: false }), setConsent() {}, config: {} },
    config: {}, host: {}, logger: { log() {}, warn() {} },
    presetInfo: () => null,
    settingsStore: { get: () => ({}), set: (v) => v },
  });
  assert.equal((await fresh.actions['GET settings']()).toolsEnabled, false,
    '从未配置过 ⇒ GET 必须回显默认 false（不回 undefined）');
});
