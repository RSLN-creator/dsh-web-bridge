// offline-tool-loop.mjs — 离线验证「新会话里工具闭环能不能建立」。
//
// 用户反馈的原话是「有些工具用现在模型 dsh 里的 DeepSeek 没法执行，必须每个新开
// 对话验证」。这里把「新开对话」这条路径上**桥这一侧**的全部判据固定成回归：
// 用注入驱动模拟网页真实产出的五种工具调用形状，每一种都必须产出**可执行的**
// tool-call 块（名字 + 参数都对），另外覆盖参数形状纠偏与未知工具的处理。
//
// 它不能替代真机验证（网页 DOM/SSE 仍在桥之外），但它能证明「同一段网页回复，
// 桥不会再把它吃掉或变形」——这正是「工具调用失败」里属于桥的那一半。
import { apply } from '../lib/index.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 测试隔离（0.14.4）：本文件此前不传 profileDir，于是 apply() 落到**用户真实**的
// `~/.dsh/webcode-edge-profile`，读到真实的 `webcode-settings.json`。真机设置里
// `sendGapMs: 30000` 会盖过用例传入的 `rateLimitBackoffMinMs: 1`（退避取
// `max(sendGapMs, backoffMinMs)`），三次限流重试变成 30s+30s+60s=120s，正好撞上
// 适配器侧 `IDLE_TIMEOUT_MS` 看门狗 —— 用例于是报 WEB_NO_PROGRESS 而不是
// RATE_LIMITED，单测「看环境脸色」。这里改用一次性临时 profile，测试与用户设置解耦。
const TEST_PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hwb-tool-loop-'));
process.on('exit', () => { try { fs.rmSync(TEST_PROFILE_DIR, { recursive: true, force: true }); } catch {} });

const SHAPES = {
  '标准 <tool_call>': (name) => `<tool_call>{"mcp_action":"call","name":"${name}","arguments":{"command":"Get-Date"}}</tool_call>`,
  '全角 DSML': (name) => `\uff5cDSML\uff5c${name}\uff5e{"mcp_action":"call","name":"${name}","arguments":{"command":"Get-Date"}}`,
  '裸 invoke XML': (name) => `<invoke name="${name}"><parameter name="command">Get-Date</parameter></invoke>`,
  '```json 围栏': (name) => '```json\n{"mcp_action":"call","name":"' + name + '","arguments":{"command":"Get-Date"}}\n```',
  '**Calling:** 渲染': (name) => `**Calling:** \`${name}\`\n{"command":"Get-Date"}`,
};

const TOOL = { name: 'pwsh', description: 'run', parameters: { type: 'object', properties: { command: { type: 'string' } } } };
let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log('PASS', label); }
  else { fail++; console.log('FAIL', label, detail ?? ''); }
}

/** 建一个只回一段固定文本的桥实例，收集这一轮的全部 chunk。 */
async function runTurn({ reply, think, tools, sessionId, message = '看时间', driver: injectDriver, config } = {}) {
  let adapter;
  const driver = injectDriver || {
    status: () => ({ running: true }), close: async () => {}, resetConversation: async () => {},
    sendTurn: async (key, prompt, opts) => { if (think) opts.onThink?.(think); opts.onDelta?.(reply); return { text: reply }; },
    sendPrompt: async () => ({ text: '' }),
  };
  const dispose = apply({ llm: { registerAdapter: (_, a) => { adapter = a; } }, get: () => null }, { port: 0, requireConsent: false, driver, profileDir: TEST_PROFILE_DIR, ...(config || {}) });
  try {
    const chunks = [];
    for await (const c of adapter.stream({
      sessionId, model: 'deepseek:deepseek',
      messages: [{ role: 'user', content: [{ type: 'text', text: message }] }],
      tools,
    })) chunks.push(c);
    return chunks;
  } finally { await dispose(); }
}

for (const [label, make] of Object.entries(SHAPES)) {
  const reply = make('pwsh');
  const chunks = await runTurn({ reply, tools: [TOOL], sessionId: 's-' + label });
  const calls = chunks.filter(c => c.type === 'block-end' && c.block?.type === 'tool-call');
  check('新会话工具闭环 · ' + label,
    calls.length === 1 && calls[0].block.name === 'pwsh' && JSON.parse(calls[0].block.arguments).command === 'Get-Date'
      && chunks.at(-1).reason?.kind === 'tool-calls',
    JSON.stringify(calls.map(c => c.block)));
}

// 参数形状漂移：schema 要求 number，网页给字符串 —— 必须纠偏后才能交给 Harness
{
  const tool = { name: 'read', description: 'r', parameters: { type: 'object', properties: { offset: { type: 'number' }, limit: { type: 'number' } } } };
  const reply = '<tool_call>{"mcp_action":"call","name":"read","arguments":{"offset":"5","limit":"10"}}</tool_call>';
  const chunks = await runTurn({ reply, tools: [tool], sessionId: 's-coerce', message: '读' });
  const call = chunks.find(c => c.type === 'block-end' && c.block?.type === 'tool-call');
  const args = call ? JSON.parse(call.block.arguments) : {};
  check('参数纠偏 · 字符串 offset/limit 变成数字', args.offset === 5 && args.limit === 10, JSON.stringify(args));
}

// 未知工具：不得交给 Harness 执行，也不得让整轮失败
{
  const reply = '<tool_call>{"mcp_action":"call","name":"subagent","arguments":{}}</tool_call>';
  const chunks = await runTurn({ reply, tools: [TOOL], sessionId: 's-unknown', message: 'x' });
  const text = chunks.find(c => c.type === 'block-end' && c.block?.type === 'text')?.block?.text || '';
  const executed = chunks.some(c => c.type === 'block-end' && c.block?.type === 'tool-call');
  check('未知工具 · 不执行、回报可用清单、正常收束',
    !executed && /TOOL_UNKNOWN/.test(text) && /pwsh/.test(text) && chunks.at(-1).reason?.kind === 'stop',
    text.slice(0, 120));
}

// GLM-5.3 强制思考（2026-09-13 真机）：工具调用写进思考流、正文只有散文。
// 思考里的 taught 形状调用必须被兜底解析成可执行的 tool-call 块，且正文
// （含流式收尾时仍扣着的 8 字符尾巴）必须一字不少。
{
  const reply = '我来帮你检查项目。';
  const think = '需要先看时间。<tool_call>{"mcp_action":"call","name":"pwsh","arguments":{"command":"Get-Date"}}</tool_call>';
  const chunks = await runTurn({ reply, think, tools: [TOOL], sessionId: 's-glm-think' });
  const calls = chunks.filter(c => c.type === 'block-end' && c.block?.type === 'tool-call');
  const text = chunks.filter(c => c.type === 'block-end' && c.block?.type === 'text').map(c => c.block.text).join('');
  check('GLM-5.3 思考中调用 · 兜底解析成 tool-call 且正文完整',
    calls.length === 1 && calls[0].block.name === 'pwsh' && JSON.parse(calls[0].block.arguments).command === 'Get-Date'
      && text === '我来帮你检查项目。' && chunks.at(-1).reason?.kind === 'tool-calls',
    JSON.stringify({ calls: calls.map(c => c.block), text }));
}

// GLM 原生裸名形状（真机 2026-09-13）：<tool_call>pwsh{"command":…}</tool_call>，
// 没有 name 字段、参数 JSON 直接跟随裸名 —— 必须还原成真调用而不是泄漏进正文。
{
  const reply = '<tool_call>pwsh{"command":"Get-Date"}</tool_call>';
  const chunks = await runTurn({ reply, tools: [TOOL], sessionId: 's-glm-bare' });
  const calls = chunks.filter(c => c.type === 'block-end' && c.block?.type === 'tool-call');
  const leaked = chunks.some(c => c.type === 'text-delta' && /tool_call/.test(c.text || ''));
  check('GLM 裸名标签 · 还原调用且协议不泄漏',
    calls.length === 1 && calls[0].block.name === 'pwsh' && JSON.parse(calls[0].block.arguments).command === 'Get-Date' && !leaked,
    JSON.stringify(chunks));
}

// 嵌套参数的裸名形状也要配平（非贪婪正则会截断嵌套 JSON —— 用配平扫描）。
{
  const reply = '<tool_call>write{"file":{"path":"a.md","content":"# hi"}}</tool_call>';
  const chunks = await runTurn({ reply, tools: [{ name: 'write', description: 'w', parameters: { type: 'object', properties: { file: { type: 'object' } } } }], sessionId: 's-glm-nested' });
  const call = chunks.find(c => c.type === 'block-end' && c.block?.type === 'tool-call');
  const args = call ? JSON.parse(call.block.arguments) : {};
  check('GLM 裸名标签 · 嵌套参数配平', call?.block.name === 'write' && args.file?.path === 'a.md', JSON.stringify(args));
}

// 站点限流（RATE_LIMITED）：第一次被限流，退避后重试成功 —— 长任务不断链。
{
  let attempts = 0;
  const drv = {
    status: () => ({ running: true }), close: async () => {}, resetConversation: async () => {},
    sendTurn: async (key, prompt, opts) => {
      attempts += 1;
      if (attempts === 1) { const e = new Error('RATE_LIMITED: 网页端限流'); e.code = 'RATE_LIMITED'; throw e; }
      opts.onDelta?.('重试成功');
      return { text: '重试成功', metrics: { endToEndMs: 5 } };
    },
    sendPrompt: async () => ({ text: '' }),
  };
  const chunks = await runTurn({ driver: drv, reply: '', tools: [TOOL], sessionId: 's-rate-retry', config: { rateLimitBackoffMinMs: 1 } });
  const text = chunks.find(c => c.type === 'block-end' && c.block?.type === 'text')?.block?.text || '';
  check('限流退避重试 · 第二次成功并记入统计',
    attempts === 2 && /重试成功/.test(text) && chunks.at(-1).reason?.kind === 'stop',
    JSON.stringify(chunks.map(c => c.type)));
}

// 限流重试耗尽：3 次全部被限流 → 整轮失败抛出（DSH 侧可见错误）。
{
  let attempts = 0;
  const drv = {
    status: () => ({ running: true }), close: async () => {}, resetConversation: async () => {},
    sendTurn: async () => {
      attempts += 1;
      const e = new Error('RATE_LIMITED: 网页端限流');
      e.code = 'RATE_LIMITED';
      throw e;
    },
    sendPrompt: async () => ({ text: '' }),
  };
  let failed = null;
  try {
    await runTurn({ driver: drv, reply: '', tools: [TOOL], sessionId: 's-rate-fail', config: { rateLimitBackoffMinMs: 1 } });
  } catch (err) { failed = err; }
  check('限流重试耗尽 · 3 次尝试后如实失败',
    attempts === 3 && failed?.code === 'RATE_LIMITED',
    String(failed));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
