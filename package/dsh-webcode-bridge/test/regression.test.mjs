import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../lib/index.js';
import { createWebControl } from '../lib/web-control.js';
import { serializeFirstTurn, serializeDelta, parseAgentReply } from '../lib/agent-preset.js';
import '../lib/decoder.js';

test('普通回复完成、模型传递、游标提交与同长度历史改写', async () => {
  let adapter; const turns = [];
  const driver = {
    status: () => ({ running: true }), close: async () => {}, resetConversation: async () => {},
    sendTurn: async (key, prompt, opts) => { turns.push({ key, prompt, ...opts }); opts.onDelta?.('回答'); return { text: '回答' }; },
    sendPrompt: async (prompt, opts) => { turns.push({ prompt, ...opts }); return { text: '回答' }; },
  };
  const dispose = apply({ llm: { registerAdapter: (_, a) => { adapter = a; } }, get: () => null }, { port: 0, requireConsent: false, driver });
  const user = text => ({ role: 'user', content: [{ type: 'text', text }] });
  const collect = async options => { const chunks = []; for await (const c of adapter.stream(options)) chunks.push(c); return chunks; };
  try {
    const models = await adapter.listModels('webcode');
    const ids = models.map(m => m.id);
    assert.ok(ids.includes('deepseek:deepseek'));
    assert.ok(ids.includes('glm:auto') && ids.includes('chatgpt:auto') && ids.includes('kimi:auto'));
    const base = { sessionId: 'regression', model: 'flash', messages: [user('第一句')] };
    const chunks = await collect(base);
    assert.equal(chunks.at(-1).type, 'finish');
    assert.equal(turns[0].model, 'deepseek:deepseek');
    await collect({ ...base, messages: [...base.messages, { role: 'assistant', content: [{ type: 'text', text: '回答' }] }, user('第二句')] });
    assert.equal(turns[1].fresh, false);
    assert.ok(!turns[1].prompt.includes('第一句'));
    await collect({ ...base, messages: [user('改写')] });
    assert.equal(turns[2].fresh, true);
    assert.ok(turns[2].prompt.includes('改写'));
  } finally { await dispose(); }
});
test('限定模型 id（site:model）全程不丢站点前缀，直达 executor', async () => {
  let adapter; const turns = [];
  const driver = {
    status: () => ({ running: true }), close: async () => {}, resetConversation: async () => {},
    sendTurn: async (key, prompt, opts) => { turns.push({ key, prompt, ...opts }); opts.onDelta?.('好'); return { text: '好' }; },
    sendPrompt: async (prompt, opts) => { turns.push({ prompt, ...opts }); return { text: '好' }; },
  };
  const dispose = apply({ llm: { registerAdapter: (_, a) => { adapter = a; } }, get: () => null }, { port: 0, requireConsent: false, driver });
  const user = text => ({ role: 'user', content: [{ type: 'text', text }] });
  try {
    const chunks = [];
    for await (const c of adapter.stream({ sessionId: 's', model: 'deepseek:deepseek', messages: [user('问')] })) chunks.push(c);
    assert.equal(chunks.at(-1).type, 'finish');
    assert.equal(turns[0].model, 'deepseek:deepseek');
  } finally { await dispose(); }
});
test('会话模式（sendTurn）思考链与图片经回调到达 DSH 流（回归 0.6 修复）', async () => {
  let adapter; let turnOpts;
  const driver = {
    status: () => ({ running: true }), close: async () => {}, resetConversation: async () => {},
    sendTurn: async (key, prompt, opts) => {
      turnOpts = opts; // 0.5.1 回归点：sendTurn 分支曾丢 onThink/onImage
      opts.onThink?.('先分析问题');
      opts.onDelta?.('结论在这里');
      opts.onImage?.({ url: 'https://example.com/pic.png' });
      return { text: '结论在这里', thinking: '先分析问题', images: [{ url: 'https://example.com/pic.png' }] };
    },
    sendPrompt: async () => ({ text: '' }),
  };
  const dispose = apply({ llm: { registerAdapter: (_, a) => { adapter = a; } }, get: () => null }, { port: 0, requireConsent: false, driver });
  const user = text => ({ role: 'user', content: [{ type: 'text', text }] });
  try {
    const chunks = [];
    for await (const c of adapter.stream({ sessionId: 's2', model: 'deepseek:deepseek', messages: [user('问')] })) chunks.push(c);
    assert.equal(typeof turnOpts.onThink, 'function', 'sendTurn 分支必须透传 onThink');
    assert.equal(typeof turnOpts.onImage, 'function', 'sendTurn 分支必须透传 onImage');
    const reasoning = chunks.find(c => c.type === 'reasoning-delta');
    assert.ok(reasoning, '思考链应以 reasoning-delta 输出');
    assert.equal(reasoning.text, '先分析问题');
    const textEnd = chunks.find(c => c.type === 'block-end' && c.block?.type === 'text');
    assert.ok(textEnd.block.text.includes('example.com/pic.png'), '网页图片应以 markdown 追加到文本');
    assert.equal(chunks.at(-1).type, 'finish');
  } finally { await dispose(); }
});
test('设置保存的默认模型在未显式选模型时生效', async () => {
  let adapter; const turns = [];
  const driver = {
    status: () => ({ running: true }), close: async () => {}, resetConversation: async () => {},
    sendTurn: async (key, prompt, opts) => { turns.push({ key, prompt, ...opts }); opts.onDelta?.('答'); return { text: '答' }; },
    sendPrompt: async (prompt, opts) => { turns.push({ prompt, ...opts }); return { text: '答' }; },
  };
  const dispose = apply({ llm: { registerAdapter: (_, a) => { adapter = a; } }, get: () => null }, { port: 0, requireConsent: false, driver });
  const user = text => ({ role: 'user', content: [{ type: 'text', text }] });
  try {
    // 直接调用 buildTurn 消费的同一 settings 路径：走 openai.js 风格限定 id
    const collect = async options => { const out = []; for await (const c of adapter.stream(options)) out.push(c); return out; };
    // 无 model 字段 → buildTurn 用 settings defaultModel；默认配置里 defaultModel='deepseek'
    const chunks = await collect({ sessionId: 'dm', messages: [user('问')] });
    assert.equal(chunks.at(-1).type, 'finish');
    assert.equal(turns[0].model, 'deepseek:deepseek');
  } finally { await dispose(); }
});
test('网页会话丢失时用整段首轮提示词重放，而不是把增量丢进空会话', async () => {
  let adapter; const turns = [];
  const driver = {
    status: () => ({ running: true }), close: async () => {}, resetConversation: async () => {},
    sendTurn: async (key, prompt, opts) => {
      turns.push({ key, prompt, fresh: opts.fresh === true });
      if (turns.length === 2) { const e = new Error('WEB_SESSION_LOST: gone'); e.code = 'WEB_SESSION_LOST'; throw e; }
      opts.onDelta?.('答');
      return { text: '答' };
    },
    sendPrompt: async (prompt, opts) => { turns.push({ prompt }); return { text: '答' }; },
  };
  const dispose = apply({ llm: { registerAdapter: (_, a) => { adapter = a; } }, get: () => null }, { port: 0, requireConsent: false, driver });
  const user = text => ({ role: 'user', content: [{ type: 'text', text }] });
  try {
    const collect = async options => { const out = []; for await (const c of adapter.stream(options)) out.push(c); return out; };
    const base = { sessionId: 'lost', model: 'flash', tools: [{ name: 'read', description: '读文件', parameters: { type: 'object' } }], messages: [user('第一句')] };
    await collect(base);
    assert.equal(turns[0].fresh, true);
    assert.ok(turns[0].prompt.includes('第一句'));
    // 第二轮走增量，网页侧会话已死 → 桥必须自己重放首轮整段，而不是把增量发进新会话
    const chunks = await collect({ ...base, messages: [...base.messages, { role: 'assistant', content: [{ type: 'text', text: '答' }] }, user('第二句')] });
    assert.equal(chunks.at(-1).type, 'finish');
    assert.equal(turns.length, 3, '丢失后自动重放一次，共三次网页发送');
    assert.equal(turns[1].fresh, false);
    assert.ok(!turns[1].prompt.includes('第一句'), '第二次是增量');
    assert.equal(turns[2].fresh, true, '重放必须开新会话');
    assert.ok(turns[2].prompt.includes('第一句') && turns[2].prompt.includes('第二句'), '重放带完整上下文');
    assert.ok(turns[2].prompt.includes('# 可用本地工具'), '重放带回工具协议');
  } finally { await dispose(); }
});
test('会话标题辅助调用只认 purpose=session-title，不误伤真实轮次', async () => {
  let adapter; const calls = [];
  const driver = {
    status: () => ({ running: true }), close: async () => {}, resetConversation: async () => {},
    sendTurn: async () => ({ text: '' }),
    sendPrompt: async (prompt) => { calls.push(prompt); return { text: '真实回答' }; },
  };
  const dispose = apply({ llm: { registerAdapter: (_, a) => { adapter = a; } }, get: () => null }, { port: 0, requireConsent: false, driver });
  const user = text => ({ role: 'user', content: [{ type: 'text', text }] });
  const collect = async options => { const out = []; for await (const c of adapter.stream(options)) out.push(c); return out; };
  try {
    // 工作区指令里出现「标题」字样 → 旧实现会把真实轮次本地截成前 16 字
    const real = await collect({ messages: [user('帮我分析这个仓库的结构')], system: '写文档时要给出标题和命名规范' });
    assert.equal(real.filter(c => c.type === 'text-delta').map(c => c.text).join(''), '真实回答');
    assert.equal(calls.length, 1, '真实轮次必须到达网页');
    // 真正的标题调用仍走本地快路径
    const title = await collect({ purpose: 'session-title', messages: [user('Generate the session title from this JSON array of human messages:\n[{"text":"帮我分析这个仓库的结构"}]')] });
    assert.equal(title.filter(c => c.type === 'text-delta').map(c => c.text).join(''), '帮我分析这个仓库的结构');
    assert.equal(calls.length, 1, '标题调用不落网页');
  } finally { await dispose(); }
});
test('工具描述按 DSH 原始长度进预设，不再截到 300 字符', () => {
  const long = 'x'.repeat(500);
  const preset = serializeFirstTurn({ messages: [{ role: 'user', content: '跑一下' }], tools: [{ name: 'pwsh', description: long, parameters: { type: 'object' } }] });
  assert.ok(preset.includes(long), '完整描述必须进首轮提示词（DSH 把硬约束写在描述里）');
});
test('首轮保留全部历史与工具结果', () => {
  const text = serializeFirstTurn({ messages: [{ role: 'user', content: '旧问题' }, { role: 'assistant', content: '旧答案' }, { role: 'user', content: '最新问题' }] });
  assert.ok(text.includes('最新问题')); assert.ok(text.includes('旧答案'));
  const delta = serializeDelta([{ role: 'tool', tool_call_id: 'a', name: 'read', content: '文件内容' }], 0);
  assert.ok(delta.text.includes('文件内容'));
});
test('goal 与 compact 在首轮和增量轮保留工程意图', () => {
  const goal = { role: 'user', content: [{ type: 'text', text: '/goal 查找本项目安全问题' }] };
  const first = serializeFirstTurn({ messages: [goal] });
  const delta = serializeDelta([{ role: 'user', content: '旧问题' }, goal], 1).text;
  for (const text of [first, delta]) {
    assert.ok(text.includes('[DSH 目标命令] 查找本项目安全问题'));
    assert.ok(text.includes('可验证结果'));
    assert.ok(!text.includes('/goal'));
  }
  const compact = serializeDelta([{ role: 'user', content: '/compact 保留未完成任务' }], 0).text;
  assert.ok(compact.includes('[DSH 压缩命令] 保留未完成任务'));
  assert.ok(compact.includes('必要文件路径'));
  assert.equal(serializeDelta([{ role: 'user', content: '解释 /goal 的用法' }], 0).text, '解释 /goal 的用法');
});
test('普通 JSON 示例不触发工具执行', () => {
  // 散文中的参数示例（无 name/arguments 调用形状）不触发执行
  assert.equal(parseAgentReply('例子：```json\n{"command":"view","path":"README.md"}\n```').calls.length, 0);
  // prose 前置 + 调用形状 fence：真机第二轮高频形态（2026-09-08 会话复盘），
  // 模型在错误回读后会省略 mcp_action 直接给 {"name","arguments"} fence，必须执行
  assert.deepEqual(parseAgentReply('让我读取该文件。\n```json\n{"name":"read","arguments":{"path":"README.md"}}\n```').calls,
    [{ name: 'read', arguments: { path: 'README.md' } }]);
});
test('真实网页 Calling 格式经过严格 JSON 解析', () => {
  assert.deepEqual(parseAgentReply('**Calling:** `str_replace_editor`\n{"command":"view","path":"README.md"}').calls,
    [{ name: 'str_replace_editor', arguments: { command: 'view', path: 'README.md' } }]);
  assert.equal(parseAgentReply('例如 Calling: read {"path":"secret"}').calls.length, 0);
  assert.equal(parseAgentReply('**Calling:** `read`\n{"path":"README.md"}\n只是示例').calls.length, 0);
});
test('裸 invoke XML 形状被解析为调用', () => {
  // probe-17 首跑（2026-09-09）：无 fence、无 mcp_action，模型直接输出
  // <invoke name="shell"><parameter name="command">ls -la</parameter></invoke>
  // 旧解析器三种形状都不认 → 第 3 轮裸奔。必须归一为调用。
  assert.deepEqual(parseAgentReply('<tool_call>\n<invoke name="shell">\n<parameter name="command">ls -la</parameter>\n<parameter name="purpose">查看仓库根目录文件列表</parameter>\n</invoke>\n').calls,
    [{ name: 'shell', arguments: { command: 'ls -la', purpose: '查看仓库根目录文件列表' } }]);
  // 多 invoke 同轮也要全收
  const two = parseAgentReply('先看结构：\n<invoke name="read"><parameter name="path">README.md</parameter></invoke>\n再检索：\n<invoke name="grep"><parameter name="query">secret</parameter></invoke>\n');
  assert.deepEqual(two.calls, [{ name: 'read', arguments: { path: 'README.md' } }, { name: 'grep', arguments: { query: 'secret' } }]);
  // 散文中举例的 invoke（无 parameter 或空 name）不触发
  assert.equal(parseAgentReply('可以像 <invoke name="read"></invoke> 这样调用').calls.length, 0);
});
test('混合形状：<invoke> 壳 + 裸 JSON 参数（2026-09-10 probe-17 真机出现）', () => {
  // 真机第 7 轮原文：外壳 DSH 原生 invoke，参数是本协议的裸 JSON，且尾随游离 </parameter>。
  // 旧解析器三种形状都不认 → 解析为空 → 探针误当收束、工具循环静默中断。
  const hybrid = 'The read output was truncated. Let me pull the key files.\n\n<tool_call>\n<invoke name="read" purpose="读取 providers.js 全文">\n{"path": "package/dsh-webcode-bridge/lib/providers.js"}\n</parameter>\n</invoke>\n<invoke name="grep" purpose="检索硬编码密钥形态">\n{"query": "sk-[A-Za-z0-9]{10,}|ghp_"}\n</parameter>\n</invoke>\n</tool_call>';
  assert.deepEqual(parseAgentReply(hybrid).calls, [
    { name: 'read', arguments: { path: 'package/dsh-webcode-bridge/lib/providers.js' } },
    { name: 'grep', arguments: { query: 'sk-[A-Za-z0-9]{10,}|ghp_' } },
  ]);
  // 回归护栏：空 invoke（散文举例）不触发；裸 JSON 参数照样收
  assert.equal(parseAgentReply('<invoke name="shell" purpose="示例"></invoke>').calls.length, 0);
  assert.deepEqual(parseAgentReply('<invoke name="shell" purpose="示例">{"command":"git status"}</invoke>').calls,
    [{ name: 'shell', arguments: { command: 'git status' } }]);
});
test('包装形状：<invoke name="tool_call"> 里装完整调用对象（2026-09-10 真机第 3 跑）', () => {
  // 真机原文：DSML 外壳名写成 tool_call，壳内才是真调用；旧逻辑会把 read/grep
  // 变成「名为 tool_call 的工具」的参数，每轮报一次未知工具（errRate 53%）。
  const raw = '<\uFF5C\uFF5CDSML\uFF5C\uFF5C calls>\n<\uFF5C\uFF5CDSML\uFF5C\uFF5C invoke name="tool_call">\n{"mcp_action": "call", "name": "read", "purpose": "read security doc", "arguments": {"path": "doc/security-review.md"}}\n</\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter>\n</\uFF5C\uFF5CDSML\uFF5C\uFF5C invoke>\n</\uFF5C\uFF5CDSML\uFF5C\uFF5C calls>';
  const calls = parseAgentReply(raw).calls;
  assert.equal(calls.length, 1, '壳 + 壳内 JSON 只应记一个调用');
  // purpose 自 0.12.7 起保留在调用对象上（供派发侧补缺失的 description 类必填参数）。
  assert.deepEqual(calls, [{ name: 'read', arguments: { path: 'doc/security-review.md' }, purpose: 'read security doc' }]);
});
test('畸形属性抢救：调用 JSON 塞进 <invoke name=…（2026-09-10 真机第 6 跑）', () => {
  // 真机原文：整段调用 JSON 落进了 invoke 的 name 属性区，标签本身没说清工具名。
  const raw = '<\uFF5C\uFF5CDSML\uFF5C\uFF5C calls>\n<\uFF5C\uFF5CDSML\uFF5C\uFF5C invoke name="mcp_action":"call","name":"read","arguments":{"path":"doc/security-review.md"}}\n<\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter name="mcp_action":"call","name":"grep","arguments":{"query":"secret"}}\n</\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter>\n</\uFF5C\uFF5CDSML\uFF5C\uFF5C invoke>\n</\uFF5C\uFF5CDSML\uFF5C\uFF5C calls>';
  assert.deepEqual(parseAgentReply(raw).calls, [
    { name: 'read', arguments: { path: 'doc/security-review.md' } },
    { name: 'grep', arguments: { query: 'secret' } },
  ]);
});
test('畸形标签抢救：JSON 漏进标签名的 `<parameter name="name": …`（2026-09-10 真机第 5 跑）', () => {
  // 真机原文：三段调用对象被拼进 <parameter name=… 的标签名里（畸形），
  // 但 \"name\"/\"arguments\" 片段完整——必须按片段配对还原，否则整轮丢 3 个调用。
  const raw = '<\uFF5C\uFF5CDSML\uFF5C\uFF5C calls>\n<\uFF5C\uFF5CDSML\uFF5C\uFF5C invoke name="tool_call">\n<\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter name="description" string="true">读取 README 与 PLAN</\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter>\n<\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter name="name": "read", "arguments": {"path": "README.md"}}\n</\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter>\n<\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter name="shell", "arguments": {"command": "git status"}}\n</\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter>\n</\uFF5C\uFF5CDSML\uFF5C\uFF5C invoke>\n</\uFF5C\uFF5CDSML\uFF5C\uFF5C calls>';
  assert.deepEqual(parseAgentReply(raw).calls, [
    { name: 'read', arguments: { path: 'README.md' } },
    { name: 'shell', arguments: { command: 'git status' } },
  ]);
});
test('包装形状：<invoke name="tool_call"> + name/arguments 参数（2026-09-10 真机第 4 跑）', () => {
  // 真机原文：外壳名 tool_call，真调用藏在 name/arguments 两个参数里。
  const raw = '<\uFF5C\uFF5CDSML\uFF5C\uFF5C calls>\n<\uFF5C\uFF5CDSML\uFF5C\uFF5C invoke name="tool_call">\n<\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter name="arguments" string="false">{"command": "git status"}</\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter>\n<\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter name="name" string="true">shell</\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter>\n<\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter name="purpose" string="true">查看状态</\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter>\n</\uFF5C\uFF5CDSML\uFF5C\uFF5C invoke>\n</\uFF5C\uFF5CDSML\uFF5C\uFF5C calls>';
  assert.deepEqual(parseAgentReply(raw).calls, [{ name: 'shell', arguments: { command: 'git status' } }]);
});
test('新版 DSML：带类型属性的 <parameter name="x" string="true">（2026-09-10 真机第 2 轮）', () => {
  // 真机原文（新版 UI）：全角竖线 DSML 前缀 + 参数带 string="true" 属性。
  // 旧 paramRe 要求 name 后直接跟 >，整段调用被判为空 → 工具循环静默中断。
  const raw = '我需要更完整的文件清单与源码细节。\n\n<\uFF5C\uFF5CDSML\uFF5C\uFF5C calls>\n<\uFF5C\uFF5CDSML\uFF5C\uFF5C invoke name="shell">\n<\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter name="command" string="true">git ls-files</\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter>\n<\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter name="purpose" string="true">列出代码文件</\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter>\n</\uFF5C\uFF5CDSML\uFF5C\uFF5C invoke>\n</\uFF5C\uFF5CDSML\uFF5C\uFF5C calls>';
  assert.deepEqual(parseAgentReply(raw).calls, [{ name: 'shell', arguments: { command: 'git ls-files', purpose: '列出代码文件' } }]);
});
test('DSML 全角/半角/丢开头形状归一为调用', () => {
  // 马拉松终跑（2026-09-09）观察：网页流式把协议标记噪声化——竖线成对全角化
  // （U+FF5C）或整段丢开头 <。reference/deepseek-free-api strip_dsml_markup 同源问题。
  assert.deepEqual(parseAgentReply('<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="shell">\n<｜｜DSML｜｜parameter name="command">git status</｜｜DSML｜｜parameter>\n</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>').calls,
    [{ name: 'shell', arguments: { command: 'git status' } }]);
  assert.deepEqual(parseAgentReply('<|DSML|tool_calls><|DSML|invoke name="read"><|DSML|parameter name="path">README.md</|DSML|parameter></|DSML|invoke></|DSML|tool_calls>').calls,
    [{ name: 'read', arguments: { path: 'README.md' } }]);
  assert.deepEqual(parseAgentReply('｜DSML｜invoke name="read"><｜DSML｜parameter name="path">PLAN.md</｜DSML｜parameter></｜DSML｜invoke>').calls,
    [{ name: 'read', arguments: { path: 'PLAN.md' } }]);
  // 散文提及 DSML 不触发
  assert.equal(parseAgentReply('DSML 是协议名，不是调用').calls.length, 0);
});
test('SSE 支持 CRLF 分块和空 close 事件', () => {
  const decoder = new globalThis.WebCodeDeepSeekStreamDecoder();
  const raw = 'data: ' + JSON.stringify({ v: { response: { role: 'ASSISTANT', message_id: '1', status: 'FINISHED', fragments: [{ type: 'RESPONSE', content: '成功' }] } } }) + '\r\n\r\nevent: close\r\n\r\n';
  for (const c of raw) decoder.push(c);
  assert.deepEqual(decoder.finish(), { complete: true, text: '成功', thinking: '', images: [] });
});

test('调用名先到、参数后到：配平前不开块也不泄漏协议文本，配平后恰好一块', async () => {
  let adapter, finish;
  const result = new Promise(resolve => { finish = resolve; });
  const driver = {
    status: () => ({}), close: async () => {},
    sendPrompt: async (_, opts) => { opts.onDelta('**Calling:** `read`\n'); return result; },
  };
  const dispose = apply({ llm: { registerAdapter: (_, value) => { adapter = value; } }, get: () => null }, { port: 0, requireConsent: false, driver });
  try {
    const stream = adapter.stream({ model: 'flash', tools: [{ name: 'read', parameters: {} }], messages: [{ role: 'user', content: '读取文件' }] });
    // 0.12.4 契约修订：流式开块只认「调用对象已配平」。早期开块（0.7.1：名字先到
    // 就宣布调用）在真机多闭包标签形态下与最终解析错位（开块 8 vs 解析 5），
    // TOOL_PROTOCOL_INVALID 整轮作废 → goal 空转，可靠性优先。配平前：不得开块、
    // 不得把协议原文当正文泄漏（流里什么都不该出现）。
    const pre = [];
    const collector = (async () => { for await (const chunk of stream) pre.push(chunk); })();
    await new Promise(r => setTimeout(r, 120));
    assert.equal(pre.filter(c => c.type === 'tool-call-delta').length, 0, '参数未配平不得提前开调用块');
    assert.equal(pre.some(c => c.type === 'text-delta' && /Calling|read/.test(c.text || '')), false, '协议形态不得作为正文泄漏');
    finish({ text: '**Calling:** `read`\n{"path":"README.md"}' });
    await collector;
    const callEnds = pre.filter(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call');
    assert.equal(callEnds.length, 1, '恰好一个 tool-call 终块，实际 ' + callEnds.length);
    assert.equal(callEnds[0].block.name, 'read');
    assert.equal(callEnds[0].block.arguments, '{"path":"README.md"}');
    const callStarts = pre.filter(chunk => chunk.type === 'block-start' && chunk.blockType === 'tool-call');
    assert.equal(callStarts.length, 1, '配平后只开一个 tool-call 块');
    const deltas = pre.filter(chunk => chunk.type === 'tool-call-delta');
    assert.equal(deltas.length, 1, '只有一个 tool-call-delta');
    assert.equal(deltas[0].argumentsDelta, '{"path":"README.md"}');
  } finally { finish({ text: '' }); dispose(); }
});

test('流式多调用：每个调用恰好一块、不重发、参数不丢', async () => {
  let adapter, finish;
  const result = new Promise(resolve => { finish = resolve; });
  const driver = {
    status: () => ({}), close: async () => {},
    sendPrompt: async (_, opts) => {
      // 首个调用的 fence+不完整参数先到：配平前不得开块（0.12.4 契约）。
      opts.onDelta('```json\n{"mcp_action": "call", "name": "read", "arguments": {"path":');
      return result;
    },
  };
  const dispose = apply({ llm: { registerAdapter: (_, value) => { adapter = value; } }, get: () => null }, { port: 0, requireConsent: false, driver });
  try {
    const stream = adapter.stream({ model: 'flash', tools: [{ name: 'read', parameters: {} }, { name: 'grep', parameters: {} }], messages: [{ role: 'user', content: '读两个目标' }] });
    const chunks = [];
    const collector = (async () => { for await (const chunk of stream) chunks.push(chunk); })();
    await new Promise(r => setTimeout(r, 120));
    assert.equal(chunks.filter(c => c.type === 'tool-call-delta').length, 0, '参数未配平不得提前开调用块');
    finish({ text: '```json\n{"mcp_action": "call", "name": "read", "arguments": {"path": "README.md"}}\n```\n```json\n{"mcp_action": "call", "name": "grep", "arguments": {"query": "secret"}}\n```' });
    await collector;
    const callEnds = chunks.filter(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call');
    assert.equal(callEnds.length, 2, '两个调用两个终块');
    assert.deepEqual(callEnds.map(b => b.block.name), ['read', 'grep']);
    const ids = new Set(callEnds.map(b => b.block.id));
    assert.equal(ids.size, 2, '两个调用 id 不同');
    const callStarts = chunks.filter(chunk => chunk.type === 'block-start' && chunk.blockType === 'tool-call');
    assert.equal(callStarts.length, 2, '每个调用恰好一个 tool-call block-start（不重发）');
    const readDelta = chunks.find(chunk => chunk.type === 'tool-call-delta' && chunk.argumentsDelta?.includes('README'));
    assert.ok(readDelta, 'read 参数完整');
    const grepDelta = chunks.find(chunk => chunk.type === 'tool-call-delta' && chunk.argumentsDelta?.includes('secret'));
    assert.ok(grepDelta, 'grep 参数完整');
  } finally { finish({ text: '' }); dispose(); }
});

test('权威全文与增量分叉（canonical 多出调用）：流式块按自身 JSON 收口并补发缺失调用', async () => {
  // 真机 2026-09-14 会话 c7c7a03c step70：SSE 增量缺 grep 的尾部（decoder 静默
  // 替换 fragments 不补发增量），流式只给 read 开了块；权威全文里 grep、read 都在。
  // 旧实现 TOOL_PROTOCOL_INVALID 整轮作废；现在流式块用它自己配平的 JSON 收口，
  // 权威解析里多出的 grep 由收尾补发。
  let adapter, finish;
  const result = new Promise(resolve => { finish = resolve; });
  const driver = {
    status: () => ({}), close: async () => {},
    sendPrompt: async (_, opts) => {
      opts.onDelta('先读配置。\n<tool_call>\n{"mcp_action":"call","name":"read","arguments":{"path":"a.md"}}\n</');
      return result;
    },
  };
  // profileDir 指向临时目录：0.14 起发送间隔持久化在真实 profile 里，前面的测试
  // 发送过会让本测试读回 lastSendAt 并等待 sendGapMs（真机设置 10s），测试必须隔离。
  const dispose = apply({ llm: { registerAdapter: (_, value) => { adapter = value; } }, get: () => null }, { port: 0, requireConsent: false, driver, profileDir: mkdtempSync(path.join(os.tmpdir(), 'webcode-test-')) });
  try {
    const stream = adapter.stream({ model: 'flash', tools: [{ name: 'read', parameters: {} }, { name: 'grep', parameters: {} }], messages: [{ role: 'user', content: '查配置' }] });
    const chunks = [];
    const collector = (async () => { for await (const chunk of stream) chunks.push(chunk); })();
    // 轮询等流式开块（全量套件负载下固定 sleep 不稳），最多 2s
    for (let i = 0; i < 100 && !chunks.some(c => c.type === 'tool-call-delta'); i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(chunks.filter(c => c.type === 'tool-call-delta').length, 1, '增量通道只有 read 配平并开块');
    finish({ text: '先读配置。\n<tool_call>\n{"mcp_action":"call","name":"grep","arguments":{"query":"x"}}\n</tool_call>\n<tool_call>\n{"mcp_action":"call","name":"read","arguments":{"path":"a.md"}}\n</tool_call>\n</' });
    await collector;
    const callEnds = chunks.filter(c => c.type === 'block-end' && c.block?.type === 'tool-call');
    assert.equal(callEnds.length, 2, '分叉修复后两个调用都必须到达');
    assert.deepEqual(callEnds.map(b => b.block.name), ['read', 'grep']);
    const readEnd = callEnds.find(b => b.block.name === 'read');
    assert.ok(readEnd.block.arguments.includes('a.md'), 'read 参数收口正确');
    const grepEnd = callEnds.find(b => b.block.name === 'grep');
    assert.ok(grepEnd.block.arguments.includes('x'), 'grep 由收尾补发');
    const finishChunk = chunks.find(c => c.type === 'finish');
    assert.equal(finishChunk.reason.kind, 'tool-calls', '整轮不得作废');
  } finally { finish({ text: '' }); dispose(); }
});

test('权威全文与增量分叉（canonical 丢失调用）：流式块按自身 JSON 收口，整轮不作废', async () => {
  // 真机 2026-09-14 会话 c7c7a03c turn2 step7：流式给 edit 开了块（增量里 JSON 已
  // 配平），权威全文却被服务端替换成只剩散文——旧实现「解析结果：无」整轮作废。
  let adapter, finish;
  const result = new Promise(resolve => { finish = resolve; });
  const driver = {
    status: () => ({}), close: async () => {},
    sendPrompt: async (_, opts) => {
      opts.onDelta('实现修复。\n<tool_call>\n{"mcp_action":"call","name":"edit","arguments":{"path":"x.ts","content":"y"}}\n');
      return result;
    },
  };
  const dispose = apply({ llm: { registerAdapter: (_, value) => { adapter = value; } }, get: () => null }, { port: 0, requireConsent: false, driver, profileDir: mkdtempSync(path.join(os.tmpdir(), 'webcode-test-')) });
  try {
    const stream = adapter.stream({ model: 'flash', tools: [{ name: 'edit', parameters: {} }], messages: [{ role: 'user', content: '改文件' }] });
    const chunks = [];
    const collector = (async () => { for await (const chunk of stream) chunks.push(chunk); })();
    await new Promise(r => setTimeout(r, 120));
    finish({ text: '实现修复。\n' });
    await collector;
    const callEnds = chunks.filter(c => c.type === 'block-end' && c.block?.type === 'tool-call');
    assert.equal(callEnds.length, 1, '流式块按自身 JSON 收口');
    assert.equal(callEnds[0].block.name, 'edit');
    assert.ok(callEnds[0].block.arguments.includes('x.ts'), '参数来自开块时配平的 JSON');
    const finishChunk = chunks.find(c => c.type === 'finish');
    assert.equal(finishChunk.reason.kind, 'tool-calls', '整轮不得作废');
  } finally { finish({ text: '' }); dispose(); }
});

test('调用之间的纯标签残片（</</）不再当正文外发', async () => {
  // 真机 2026-09-14 会话 c7c7a03c step69：调用 #0 没写闭标签、只吐了 '</</' 垃圾，
  // 下一个调用的边界到达时这段垃圾被当散文开块外发，用户看到「回复夹杂错误调用」。
  let adapter, finish;
  const result = new Promise(resolve => { finish = resolve; });
  const driver = {
    status: () => ({}), close: async () => {},
    sendPrompt: async (_, opts) => {
      opts.onDelta('<tool_call>\n{"mcp_action":"call","name":"read","arguments":{"path":"a.md"}}\n</</\n');
      opts.onDelta('<tool_call>\n{"mcp_action":"call","name":"read","arguments":{"path":"b.md"}}\n</tool_call>');
      return result;
    },
  };
  const dispose = apply({ llm: { registerAdapter: (_, value) => { adapter = value; } }, get: () => null }, { port: 0, requireConsent: false, driver, profileDir: mkdtempSync(path.join(os.tmpdir(), 'webcode-test-')) });
  try {
    const stream = adapter.stream({ model: 'flash', tools: [{ name: 'read', parameters: {} }], messages: [{ role: 'user', content: '读两个' }] });
    const chunks = [];
    const collector = (async () => { for await (const chunk of stream) chunks.push(chunk); })();
    await new Promise(r => setTimeout(r, 120));
    finish({ text: '<tool_call>\n{"mcp_action":"call","name":"read","arguments":{"path":"a.md"}}\n</</\n<tool_call>\n{"mcp_action":"call","name":"read","arguments":{"path":"b.md"}}\n</tool_call>' });
    await collector;
    const debris = chunks.filter(c => c.type === 'text-delta' && /[<>]/.test(c.text || ''));
    assert.equal(debris.length, 0, '标签残片不得进入正文: ' + JSON.stringify(debris.map(d => d.text)));
    const callEnds = chunks.filter(c => c.type === 'block-end' && c.block?.type === 'tool-call');
    assert.equal(callEnds.length, 2, '两个调用都要到达');
    assert.deepEqual(callEnds.map(b => b.block.arguments.includes('a.md') ? 'a' : 'b'), ['a', 'b'], '同名两调用参数不串');
  } finally { finish({ text: '' }); dispose(); }
});

test('APPEND 新 RESPONSE 片段的起始内容不丢失', () => {
  const deltas = [];
  const decoder = new globalThis.WebCodeDeepSeekStreamDecoder({ onDelta: text => deltas.push(text) });
  const push = value => decoder.push('data: ' + JSON.stringify(value) + '\n\n');
  push({ v: { response: { role: 'ASSISTANT', message_id: '1', status: 'WIP', fragments: [] } } });
  push({ o: 'APPEND', p: 'response/fragments', v: [{ type: 'RESPONSE', content: '开始' }] });
  push({ o: 'APPEND', p: 'response/fragments/-1/content', v: '结束' });
  push({ o: 'SET', p: 'response/status', v: 'FINISHED' });
  decoder.push('event: close\n\n');
  assert.equal(decoder.finish().text, '开始结束');
  assert.equal(deltas.join(''), '开始结束');
});

test('decoder：被网络任意切分的中文帧流仍完整无乱码（跨 push 缓冲）', () => {
  // 真实流式下 capture 增量 slice 会分多次 push，可能把一条 SSE data 帧切成多段，
  // 且切点常在汉字之后/之侧。SseDecoder 用 buf 累积、按 \n\n 分帧，必须保证整帧完整解析。
  const decoder = new globalThis.WebCodeDeepSeekStreamDecoder({ onDelta: () => {} });
  const full = [
    'data: ' + JSON.stringify({ v: { response: { role: 'ASSISTANT', message_id: '9', status: 'WIP', fragments: [{ type: 'RESPONSE', content: '安全' }] } } }),
    '',
    '',
    'data: ' + JSON.stringify({ o: 'APPEND', p: 'response/fragments/-1/content', v: '排查完成，未发现硬编码凭据。' }),
    '',
    '',
    'data: ' + JSON.stringify({ o: 'SET', p: 'response/status', v: 'FINISHED' }),
    '',
    '',
    'event: close',
    '',
    '',
  ].join('\n');
  // 把整条流按 1–3 字符的随机固定步长切成片段，模拟网络分片（不破坏即可片仍跨汉字）。
  const parts = [];
  for (let i = 0, step = 2; i < full.length; i += step) parts.push(full.slice(i, i + step));
  for (const part of parts) decoder.push(part);
  const out = decoder.finish();
  assert.equal(out.complete, true, '整帧跨 push 后应完整解析');
  assert.equal(out.text, '安全排查完成，未发现硬编码凭据。');
});

test('decoder：深度思考的 THINK 片段经 onThink 单独暴露且不污染正文', () => {
  // 用户「深度思考没接好/思考很浅」：若 THINK 被丢弃或混入正文都是 bug。
  // 必须 THINK→onThink、RESPONSE→text，二者隔离。
  const think = [];
  const decoder = new globalThis.WebCodeDeepSeekStreamDecoder({
    onDelta: () => {}, onThink: (t) => think.push(t),
  });
  decoder.push('data: ' + JSON.stringify({ v: { response: { role: 'ASSISTANT', message_id: 'a', status: 'WIP', fragments: [{ type: 'THINK', content: '正在深入思考安全边界……' }, { type: 'RESPONSE', content: '结论：未发现硬编码凭据。' }] } } }) + '\n\n');
  decoder.push('data: ' + JSON.stringify({ o: 'SET', p: 'response/status', v: 'FINISHED' }) + '\n\n');
  decoder.push('event: close\n\n');
  const out = decoder.finish();
  assert.equal(out.complete, true);
  assert.ok(think.join('').includes('深入思考'), 'THINK 片段应经 onThink 暴露');
  assert.equal(out.text, '结论：未发现硬编码凭据。');
  assert.ok(!out.text.includes('深入思考'), '思考不得混入正文');
});

test('decoder：reasoning_* 增量思考 op 也走 onThink 暴露', () => {
  const think = [];
  const decoder = new globalThis.WebCodeDeepSeekStreamDecoder({
    onDelta: () => {}, onThink: (t) => think.push(t),
  });
  decoder.push('data: ' + JSON.stringify({ v: { response: { role: 'ASSISTANT', message_id: 'b', status: 'WIP', fragments: [] } } }) + '\n\n');
  decoder.push('data: ' + JSON.stringify({ o: 'APPEND', p: 'response/fragments/-1/thinking_content', v: '先按依赖树逐个确认' }) + '\n\n');
  decoder.push('data: ' + JSON.stringify({ o: 'SET', p: 'response/status', v: 'FINISHED' }) + '\n\n');
  decoder.push('event: close\n\n');
  const out = decoder.finish();
  assert.equal(out.complete, true);
  assert.ok(think.join('').includes('先按依赖树'), 'reasoning op 应经 onThink 暴露');
});

// ---- 「跑到一半突然停止」：部分流必须保留内容，而不是整轮丢弃 ----------------
// 真机证据：会话 94f70e1a / 3144813e / 89775655 的 turn/end 都是
// reason.kind === 'error' 且 error.code === 'UNKNOWN'，对应驱动里
// 「web capture ended incomplete」这条抛错——解码器已经解出正文（有时还是一
// 段完整的工具调用），却因为网页没发 FINISHED/close 被整段扔掉。用户看到的是
// 「回复到一半突然停止、工具也不执行」。解码层现在把已解出的内容带出来并标
// partial，由驱动层决定是否可用。

test('decoder：未收到 FINISHED 但已解出正文 → partial=true 且保留全文', () => {
  const deltas = [];
  const decoder = new globalThis.WebCodeDeepSeekStreamDecoder({ onDelta: (t) => deltas.push(t) });
  const push = (value) => decoder.push('data: ' + JSON.stringify(value) + '\n\n');
  push({ v: { response: { role: 'ASSISTANT', message_id: '7', status: 'WIP', fragments: [{ type: 'RESPONSE', content: '我先读一下 ' }] } } });
  push({ o: 'APPEND', p: 'response/fragments/-1/content', v: 'README.md。' });
  // 没有 SET response/status=FINISHED，也没有 event: close —— 网页掉流了。
  const out = decoder.finish();
  assert.equal(out.complete, false, '没到 FINISHED 就不能声称完整');
  assert.equal(out.partial, true, '已经解出正文 → 必须标 partial 供上层决策');
  assert.equal(out.reason, 'stream_ended_before_finished');
  assert.equal(out.status, 'WIP');
  assert.equal(out.text, '我先读一下 README.md。', '已解出的正文必须带出来，不能丢');
  assert.equal(deltas.join(''), '我先读一下 README.md。');
});

test('decoder：连响应帧都没有（纯失败）→ partial=false，不得假装有内容', () => {
  const decoder = new globalThis.WebCodeDeepSeekStreamDecoder({ onDelta: () => {} });
  decoder.push('data: ' + JSON.stringify({ v: { response: { role: 'ASSISTANT', message_id: '8', status: 'WIP', fragments: [] } } }) + '\n\n');
  const out = decoder.finish();
  assert.equal(out.complete, false);
  assert.equal(out.partial, false, '没有任何正文/思考/图片 → 不构成部分可用');
  assert.equal(out.reason, 'stream_ended_before_finished');
  assert.equal(out.text, '');
});

test('decoder：解析失败（invalid_stream）不因 partial 被伪装成可交付', () => {
  const decoder = new globalThis.WebCodeDeepSeekStreamDecoder({ onDelta: () => {} });
  decoder.push('data: ' + JSON.stringify({ v: { response: { role: 'ASSISTANT', message_id: '9', status: 'WIP', fragments: [{ type: 'RESPONSE', content: '半句' }] } } }) + '\n\n');
  // 非法的 JSON 帧 → failed=true
  decoder.push('data: {not json\n\n');
  const out = decoder.finish();
  assert.equal(out.complete, false);
  assert.equal(out.reason, 'invalid_stream', '结构坏掉必须是 invalid_stream，不能被 partial 掩盖');
});

// ---- 「跑着跑着不动了」：调用不存在/游标被描述变化顶掉，都不得静默 -------------
// 真机证据：会话 e2e63eb6 里助手尝试调用本会话不存在的 write 工具；会话 5d08018b /
// 8e9c538a / 89775655 大量 turns 以 error 收尾。早期实现把「解析出的调用名不在本次
// 工具表里」直接过滤掉，剩下的空回复被当成收束——任务从此静止。

test('一轮回复里连发多个工具调用：每个各自一块、id 唯一、不重复、不丢参数', async () => {
  const DEBUG = process.env.WEBCODE_DEBUG_STREAM === '1';
  let adapter;
  const reply = [
    '先并行读三处。',
    '<tool_call>{"mcp_action":"call","name":"read","arguments":{"path":"a.js"}}</tool_call>',
    '<tool_call>{"mcp_action":"call","name":"read","arguments":{"path":"b.js"}}</tool_call>',
    '<tool_call>{"mcp_action":"call","name":"read","arguments":{"path":"c.js"}}</tool_call>',
  ].join('\n');
  const driver = {
    status: () => ({ running: true }), close: async () => {}, resetConversation: async () => {},
    sendTurn: async (key, prompt, opts) => {
      for (const piece of reply.match(/[\s\S]{1,7}/g)) { if (DEBUG) console.error('piece ' + JSON.stringify(piece)); opts.onDelta?.(piece); }
      return { text: reply };
    },
    sendPrompt: async () => ({ text: '' }),
  };
  const dispose = apply({ llm: { registerAdapter: (_, a) => { adapter = a; } }, get: () => null }, { port: 0, requireConsent: false, driver });
  const user = text => ({ role: 'user', content: [{ type: 'text', text }] });
  const tools = [{ name: 'read', description: 'r', parameters: {} }];
  try {
    const chunks = [];
    for await (const c of adapter.stream({ sessionId: 'multi', model: 'deepseek:deepseek', messages: [user('读三个文件')], tools })) {
      if (DEBUG && (c.type === 'block-end' || c.type === 'text-delta')) console.error('CHUNK ' + JSON.stringify(c));
      chunks.push(c);
    }
    const blocks = chunks.filter(c => c.type === 'block-end' && c.block?.type === 'tool-call');
    assert.equal(blocks.length, 3, '三个调用各应有一块（旧实现只留第一个，其余整轮作废）');
    assert.deepEqual(blocks.map(b => JSON.parse(b.block.arguments).path), ['a.js', 'b.js', 'c.js']);
    const ids = blocks.map(b => b.block.id);
    assert.equal(new Set(ids).size, 3, 'id 必须互不相同');
    for (const id of ids) {
      const endCount = chunks.filter(c => c.type === 'block-end' && c.block?.id === id).length;
      assert.equal(endCount, 1, 'id ' + id + ' 不应重复交付（否则 Harness 会执行两遍）');
    }
    const textEnd = chunks.find(c => c.type === 'block-end' && c.block?.type === 'text');
    assert.ok(textEnd.block.text.includes('先并行读三处'), '协议之前的散文要保留');
    assert.ok(!textEnd.block.text.includes('tool_call'), '协议文本不得进助手正文');
    assert.equal(chunks.at(-1).reason?.kind, 'tool-calls');
  } finally { await dispose(); }
});

test('网页调用了本会话不存在的工具 → 回报可用工具清单，不整轮作废也不静默收束', async () => {
  let adapter;
  const driver = {
    status: () => ({ running: true }), close: async () => {}, resetConversation: async () => {},
    sendTurn: async (key, prompt, opts) => {
      const text = '<tool_call>\n{"mcp_action": "call", "name": "subagent", "arguments": {"prompt": "x"}}\n</tool_call>';
      opts.onDelta?.(text);
      return { text };
    },
    sendPrompt: async () => ({ text: '' }),
  };
  const dispose = apply({ llm: { registerAdapter: (_, a) => { adapter = a; } }, get: () => null }, { port: 0, requireConsent: false, driver });
  const user = text => ({ role: 'user', content: [{ type: 'text', text }] });
  // 只登记 pwsh：模型却调 subagent。抛错会让整轮作废、用户得手动再催；
  // 正确行为是把「可用工具清单 + 请重试」作为这一轮回复交回会话。
  const tools = [{ name: 'pwsh', description: 'run', parameters: {} }];
  try {
    const chunks = [];
    for await (const c of adapter.stream({ sessionId: 'tu', model: 'deepseek:deepseek', messages: [user('跑')], tools })) chunks.push(c);
    const textEnd = chunks.find(c => c.type === 'block-end' && c.block?.type === 'text');
    assert.ok(textEnd, '必须给出文本回复（不能整轮作废）');
    assert.match(textEnd.block.text, /TOOL_UNKNOWN/);
    assert.match(textEnd.block.text, /subagent/, '要点名网页用错的工具');
    assert.match(textEnd.block.text, /pwsh/, '要给出本会话真正可用的工具名');
    assert.equal(chunks.at(-1).reason?.kind, 'stop', '正常收束，下一轮模型可自纠');
    assert.ok(!chunks.some(c => c.type === 'block-end' && c.block?.type === 'tool-call'), '不得把不存在的工具交给 Harness 执行');
  } finally { await dispose(); }
});

test('工具描述措辞变化不得顶掉会话游标（否则每轮都在重建首轮＝上下文像不动）', async () => {  let adapter; const turns = [];
  const driver = {
    status: () => ({ running: true }), close: async () => {}, resetConversation: async () => {},
    sendTurn: async (key, prompt, opts) => { turns.push({ fresh: opts.fresh === true, prompt }); opts.onDelta?.('答'); return { text: '答' }; },
    sendPrompt: async (prompt, opts) => { turns.push({ fresh: true, prompt }); return { text: '答' }; },
  };
  const dispose = apply({ llm: { registerAdapter: (_, a) => { adapter = a; } }, get: () => null }, { port: 0, requireConsent: false, driver });
  const user = text => ({ role: 'user', content: [{ type: 'text', text }] });
  const tools1 = [{ name: 'pwsh', description: '第一版描述', parameters: { type: 'object', properties: { command: { type: 'string' } } } }];
  const tools2 = [{ name: 'pwsh', description: '第二版措辞完全不同的描述', parameters: { type: 'object', properties: { command: { type: 'string', description: '新加的字段说明' } } } }];
  const base = { sessionId: 'fp', model: 'deepseek:deepseek' };
  try {
    for await (const _ of adapter.stream({ ...base, messages: [user('一')], tools: tools1 })) { /* drain */ }
    for await (const _ of adapter.stream({ ...base, messages: [user('一'), { role: 'assistant', content: [{ type: 'text', text: '答' }] }, user('二')], tools: tools2 })) { /* drain */ }
    assert.equal(turns[0].fresh, true, '首轮是 fresh');
    assert.equal(turns[1].fresh, false, '只有描述变化（工具名集合不变）时必须沿用同一网页会话');
    assert.ok(!turns[1].prompt.includes('一'), '增量轮不得重发首轮全文');
    // 工具名集合真的变了 → 才允许重建
    for await (const _ of adapter.stream({ ...base, messages: [user('一'), { role: 'assistant', content: [{ type: 'text', text: '答' }] }, user('二'), { role: 'assistant', content: [{ type: 'text', text: '答' }] }, user('三')], tools: [...tools2, { name: 'read', description: 'r', parameters: {} }] })) { /* drain */ }
    assert.equal(turns[2].fresh, true, '工具集合变化应重建网页会话');
  } finally { await dispose(); }
});

// ---- 控制面：登录必须可选站点、且把真实结果带回界面 ------------------------
// 真机现象：设置页点「登录」没有任何回执，退出一次之后想重登任何站点都找不到
// 入口（界面里只有写死 deepseek 的一行）。这里直接打控制面的 HTTP 路由。

function withServer(relayConfig, fn) {
  let control = null;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    control.handle(req, res, u.pathname).then((handled) => {
      if (!handled) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"ok":false}'); }
    }).catch(() => { try { res.writeHead(500).end(); } catch { /* already sent */ } });
  });
  control = createWebControl({
    relay: { config: relayConfig, status: () => ({ consent: true }) },
    driver: { status: () => ({ running: true, siteId: 'deepseek' }) },
    logger: { log() {}, warn() {} },
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', async () => {
      const port = server.address().port;
      const post = async (path, body) => {
        const r = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
        });
        return { status: r.status, json: await r.json() };
      };
      const get = async (path) => {
        const r = await fetch(`http://127.0.0.1:${port}${path}`);
        return { status: r.status, json: await r.json() };
      };
      try { await fn({ post, get }); } finally { server.close(); resolve(); }
    });
  });
}

test('POST login 等待真实结果并按站点路由（不再是 fire-and-forget）', async () => {
  const seen = [];
  await withServer({
    loginAndReport: async (siteId) => {
      seen.push(siteId);
      return { ok: true, siteId, siteName: 'Z.ai', loggedIn: true, alreadyLoggedIn: false, ms: 1234, note: '登录完成，已切回无头运行' };
    },
    driverStatus: () => ({ siteId: 'deepseek', sites: [] }),
  }, async ({ post }) => {
    const r = await post('/__webcode/login', { siteId: 'zai', wait: true });
    assert.equal(r.status, 200);
    assert.deepEqual(seen, ['zai'], '登录请求必须路由到所选站点');
    assert.equal(r.json.ok, true);
    assert.equal(r.json.loggedIn, true);
    assert.equal(r.json.siteId, 'zai');
    assert.ok(r.json.message.includes('登录完成'));
  });
});

test('POST login 失败时把原因带回界面（ok=false + message）', async () => {
  await withServer({
    loginAndReport: async (siteId) => ({ ok: false, siteId, error: 'login wait timed out', ms: 300001 }),
    driverStatus: () => ({ siteId: 'deepseek', sites: [] }),
  }, async ({ post }) => {
    const r = await post('/__webcode/login', { siteId: 'deepseek' });
    assert.equal(r.json.ok, false);
    assert.ok(r.json.message.includes('timed out'), '失败原因必须回传，而不是只写控制台');
  });
});

test('GET login-sites 列出全部站点（含 z.ai）且不启动浏览器', async () => {
  await withServer({
    driverStatus: () => ({ siteId: 'deepseek', sites: [{ siteId: 'glm', siteName: '智谱清言 (GLM)', initialized: true, loggedIn: true, loginState: 'ready', lastLogin: { at: 1 } }] }),
  }, async ({ get }) => {
    const r = await get('/__webcode/login-sites');
    assert.equal(r.status, 200);
    const ids = r.json.sites.map(s => s.siteId);
    assert.ok(ids.includes('zai'), '站点清单必须含 z.ai');
    assert.ok(ids.includes('deepseek') && ids.includes('gemini'));
    const glm = r.json.sites.find(s => s.siteId === 'glm');
    assert.equal(glm.loggedIn, true);
    assert.equal(glm.origin, 'https://chatglm.cn');
    // 只读状态查询，不得触发 connect / 启动浏览器
    const zai = r.json.sites.find(s => s.siteId === 'zai');
    assert.equal(zai.initialized, false);
    assert.equal(zai.loggedIn, null);
  });
});

// ---------------------------------------------------------------- 0.13.0
// 四个回归的护栏。每条都锁「旧实现的错误行为」，不是锁实现细节。

test('模型名是干净名字：不得含元描述或括注，auto 入口仍唯一且可解析', async () => {
  const { listAllModels, resolveWebModel } = await import('../lib/providers.js');
  const all = listAllModels();
  for (const m of all) {
    // 选择器里显示的必须是模型/站点名本身。像「网页当前模型（不切换）」
    // 这类元描述属于**说明文字**，不该占用模型名——说明放在 UI 的 hint 里。
    assert.ok(!m.name.includes('网页当前模型'), `${m.id} 仍带「网页当前模型」: ${m.name}`);
    // 0.14.0：名字统一为「站点短键/模型 id」，不再有括注——DeepSeek 的
    // 「（深度思考）」能力注记也随之取消（思考开关由模型元数据表达）。
    assert.ok(!m.name.includes('（') && !m.name.includes('）'), `${m.id} 名称应无括注: ${m.name}`);
  }
  // DeepSeek 只有一个模型，且名字就是「站点短键/模型 id」的形态（用户要求）。
  assert.equal(all.find(m => m.id === 'deepseek:deepseek').name, 'deepseek/deepseek');
  // 未校准站点仍只有唯一 auto 入口，且解析不因改名而失效。
  // 0.13.0 起 glm/zai/kimi 有了真实版本条目，auto 变回「站点默认（不切换）」，
  // 因此这里断言的是「auto 仍存在且解析到本站点」，而不是具体版本名。
  for (const [id, siteId] of [['glm:auto', 'glm'], ['zai:auto', 'zai'], ['kimi:auto', 'kimi'],
    ['qwen:auto', 'qwen'], ['doubao:auto', 'doubao'], ['grok:auto', 'grok']]) {
    const m = resolveWebModel(id);
    assert.equal(m.siteId, siteId, id + ' 必须解析到 ' + siteId);
    assert.equal(m.id, 'auto');
    assert.ok(m.name.trim().length > 0, id + ' 必须有显示名');
  }
  // 每个站点的 auto 入口唯一
  for (const siteId of new Set(all.map((m) => m.siteId))) {
    const autos = all.filter((m) => m.siteId === siteId && m.id === siteId + ':auto');
    assert.ok(autos.length <= 1, siteId + ' 的 auto 入口不得重复');
  }
});

test('右栏窗口状态是聚合对象：没有独立窗口时不得让面板渲染抛错', () => {
  // 0.11.0 把渲染改成 winOpen[siteId]?.open（聚合读法），却仍把 siteId/null
  // 塞进同一个 state：null['deepseek'] 抛 TypeError，整块右栏崩成白屏。
  // 护栏直接按「渲染期读法」验两条真实 payload 形态。
  const renderRead = winOpen => {
    const winOf = sid => (winOpen && typeof winOpen === 'object' ? winOpen[sid] : null);
    const winIsOpen = sid => winOf(sid)?.open === true;
    return { open: winIsOpen('deepseek'), pressed: winIsOpen('deepseek') };
  };
  // 没有窗口：控制面 /__webcode/window 的 windows 是 {}
  assert.deepEqual(renderRead({}), { open: false, pressed: false });
  // 有窗口：windows = { deepseek: { open: true } }
  assert.deepEqual(renderRead({ deepseek: { open: true } }), { open: true, pressed: true });
  // 其它站点开着窗口不影响当前站点
  assert.deepEqual(renderRead({ glm: { open: true } }), { open: false, pressed: false });
  // 回归护栏：旧实现存进去的 null / 字符串必须被防御式读法吃掉，而不是抛错
  assert.deepEqual(renderRead(null), { open: false, pressed: false });
  assert.deepEqual(renderRead('deepseek'), { open: false, pressed: false });
});

test('上下文计数按累计口径上报：增量轮不得让 inputTokens 掉回本轮增量', async () => {
  let adapter; const turns = [];
  const driver = {
    status: () => ({ running: true }), close: async () => {}, resetConversation: async () => {},
    sendTurn: async (key, prompt, opts) => { turns.push({ key, prompt, ...opts }); opts.onDelta?.('答'); return { text: '答' }; },
    sendPrompt: async (prompt, opts) => { turns.push({ prompt, ...opts }); return { text: '答' }; },
  };
  const dispose = apply({ llm: { registerAdapter: (_, a) => { adapter = a; } }, get: () => null }, { port: 0, requireConsent: false, driver });
  const user = text => ({ role: 'user', content: [{ type: 'text', text }] });
  const usageOf = async options => {
    const out = [];
    for await (const c of adapter.stream(options)) out.push(c);
    return out.filter(c => c.type === 'usage').at(-1).usage.inputTokens;
  };
  try {
    // 首轮：累计 = 首轮全文估算
    const long = '这是一段足够长的首轮问题。'.repeat(40);
    const u1 = await usageOf({ sessionId: 'ctx-acc', model: 'deepseek', messages: [user(long)] });
    assert.ok(u1 > 0, '首轮 inputTokens 必须为正');
    // 第二轮：只发增量，但上报的必须是「首轮 + 增量」的累计值，不能掉回增量本身
    const u2 = await usageOf({ sessionId: 'ctx-acc', model: 'deepseek', messages: [user(long), { role: 'assistant', content: [{ type: 'text', text: '答' }] }, user('再补一句很短的话')] });
    assert.ok(u2 > u1, `第二轮必须大于首轮（累计口径）：u1=${u1} u2=${u2}`);
    // 第三轮继续单调不减
    const u3 = await usageOf({ sessionId: 'ctx-acc', model: 'deepseek', messages: [user(long), { role: 'assistant', content: [{ type: 'text', text: '答' }] }, user('再补一句很短的话'), { role: 'assistant', content: [{ type: 'text', text: '答' }] }, user('第三句')] });
    assert.ok(u3 >= u2, `累计值必须单调不减：u2=${u2} u3=${u3}`);
    // 增量轮本身确实只发了很短一段（证明上面涨的是累计而不是重发全文）
    assert.ok(!turns[1].prompt.includes('这是一段足够长的首轮问题'), '第二轮仍是增量发送');
  } finally { await dispose(); }
});

test('会话命名优先取网页端真实标题，取不到才回落本地启发式', async () => {
  let adapter; const turns = [];
  const driver = {
    status: () => ({ running: true }), close: async () => {}, resetConversation: async () => {},
    sendTurn: async (key, prompt, opts) => { turns.push({ key, prompt, ...opts }); opts.onDelta?.('答'); return { text: '答' }; },
    sendPrompt: async (prompt, opts) => { turns.push({ prompt, ...opts }); return { text: '答' }; },
    // 本会话已有网页对话槽，且网页侧给它起了真实名字
    conversationFor: key => (key === 'title-web' ? { webSessionId: 'web-sess-1' } : null),
    listSessions: async () => ({ ok: true, sessions: [{ id: 'web-sess-1', title: '网页端起的真实标题' }] }),
  };
  const dispose = apply({ llm: { registerAdapter: (_, a) => { adapter = a; } }, get: () => null }, { port: 0, requireConsent: false, driver });
  const collect = async options => { const out = []; for await (const c of adapter.stream(options)) out.push(c); return out; };
  const textOf = chunks => chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('');
  const titleCall = (sessionId, text) => ({
    purpose: 'session-title', sessionId,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Generate the session title from this JSON array of human messages:\n[{"text":"' + text + '"}]' }] }],
  });
  try {
    // ① 网页端有真实标题 → 用它（含用户在网页端做过的重命名）
    const before = turns.length;
    assert.equal(textOf(await collect(titleCall('title-web', '帮我分析仓库'))), '网页端起的真实标题');
    assert.equal(turns.length, before, '命名不落网页，也不该发真实轮次');

    // ② 该 DSH 会话在网页侧还没有对话槽 → 回落本地启发式（首条消息前 16 字）
    const heuristic = textOf(await collect(titleCall('title-none', '帮我分析这个仓库的结构')));
    assert.equal(heuristic, '帮我分析这个仓库的结构'.slice(0, 16));
  } finally { await dispose(); }
});

// ── 0.14.0 两个真机问题的**接线**护栏 ──────────────────────────────────────
// 判定逻辑本身有专门文件（send-gap.test.mjs / wip-settle.test.mjs）覆盖。这里
// 只钉「有没有真的接上」——两个 bug 的共同特征都是「函数写好了但没人调用」或
// 「接线被改回旧写法」，那是纯逻辑单测看不见的。

const bridgeSrc = (rel) => readFileSync(new URL('../lib/' + rel, import.meta.url), 'utf8');

test('发送间隔基准必须落盘（重启后第一轮也要生效），不许退回纯内存', () => {
  const src = bridgeSrc('index.js');
  // 基准文件：真机「设了 10 秒、重启后第一条立刻发出去」的根因就是它不存在。
  assert.match(src, /webcode-send-state\.json/, '发送间隔基准必须落盘到 profileDir');
  assert.match(src, /function rememberSend\(/, '必须有记录「刚刚发出」的入口');
  // 判定必须走纯函数（而不是各处再写一遍减法），否则语义会再次漂移。
  assert.match(src, /computeSendGap\(\{/, '节流判定必须走 metrics.computeSendGap');
  // send-to-send：基准只在真正发出时更新，finally 里不再无条件刷新。
  assert.doesNotMatch(src, /节流基准是「上一轮结束时刻」/, '旧的 turn-end 基准注释不应残留');
  // 三个可核对字段必须进 metrics（右栏「发送前等待」恒可显示的前提）。
  for (const key of ['gapTargetMs', 'sincePrevSendMs', 'sendWaitMs']) {
    assert.match(src, new RegExp(key), `metrics 必须带 ${key}`);
  }
});

test('网页不回话时，适配器侧必须有「无进展」看门狗（否则无限思考中）', () => {
  const src = bridgeSrc('index.js');
  assert.match(src, /function idleTimeoutError\(/, '缺少无进展错误构造');
  assert.match(src, /WEB_NO_PROGRESS/, '必须用可识别的错误码');
  assert.match(src, /const nextWithIdle = async/, '消费端必须包一层超时');
  // 两个消费点（纯聊分支与带工具分支）都必须走它——只改一处的话另一条路仍然挂死。
  const uses = src.match(/await nextWithIdle\(\)/g) || [];
  assert.ok(uses.length >= 2, `nextWithIdle 必须覆盖两条消费路径，当前只有 ${uses.length} 处`);
  assert.doesNotMatch(src, /await ch\.next\(\)/, '不应再直接 await ch.next()（会无限挂住）');
  // 看门狗必须比稳态窗口大，否则会在稳态收束之前把可救回的轮次判死。
  assert.match(src, /IDLE_TIMEOUT_MS = Math\.max\(WIP_IDLE_MS \+ 1000/, '看门狗必须 > WIP 稳态窗口');
});

test('驱动侧必须装上 WIP 稳态巡检器，并在发送之后启动', () => {
  const src = bridgeSrc('browser-driver.js');
  assert.match(src, /function startWipWatch\(/, '缺少 WIP 稳态巡检器');
  assert.match(src, /shouldSettleWip\(\{/, '稳态判定必须走 metrics.shouldSettleWip');
  // 启动点必须在「发送动作」之后、`await done` 之前：
  //   • 发送前启动 → 会在上一轮收尾期间就开火；
  //   • 收束之后启动 → 永远等不到（done 已经 settle 或永远挂着）。
  // 用相对位置而不是逐字锚点：注释措辞会变，调用顺序不会。
  const sendBranch = src.indexOf('if (SEL.sendButton)');
  const watchIdx = src.indexOf('startWipWatch();');
  const awaitDoneIdx = src.indexOf('result = await done;');
  assert.ok(sendBranch > 0 && watchIdx > 0 && awaitDoneIdx > 0,
    '找不到发送分支/巡检器/await done 三处结构之一（源码结构已变，请核对本测试）');
  assert.ok(watchIdx > sendBranch, 'startWipWatch 必须在发送动作之后调用');
  assert.ok(watchIdx < awaitDoneIdx, 'startWipWatch 必须在 await done 之前启动（否则永远等不到收束）');
  // 巡检器必须随轮次结束一起停：否则下一轮会被上一轮的采样误判。
  assert.match(src, /if \(a\?\.wipTimer\) clearTimeout\(a\.wipTimer\)/, 'finishActive 必须清理巡检器');
  // 收束原因与超时现场必须进 status（否则用户仍然只能看到「卡了很久」）。
  for (const key of ['lastEndReason', 'lastTimeoutScene']) {
    assert.match(src, new RegExp(key), `driver.status() 必须透出 ${key}`);
  }
});

// ── 0.14.1：F（OpenAI 前端绕过发送间隔）/ B-3（窗口声明可见性）接线护栏 ──────

test('OpenAI 兼容前端（:8931）也必须遵守发送间隔（F 修复，不许退回）', () => {
  const front = bridgeSrc('openai.js');
  // 两条分支（流式 + 非流式）都要带 sendGapMs。真机 0.14.0 矩阵实测该路径
  // gapTargetMs 恒为 0 —— 因为 meta 里根本没这个字段，executor 的
  // clampSendGapMs(undefined) === 0，于是设置页的间隔被整体绕过。
  // 只认 relay.submit 的 meta（modelsDocument 里也有一个同名的模型元数据字段，
  // 与本修复无关，不能把它算进来）。
  const metas = front.match(/relay\.submit\([^;]*?meta: \{[^}]*\}/gs) || [];
  assert.ok(metas.length >= 2, `openai.js 应有两条 relay.submit meta（实际 ${metas.length}）`);
  for (const m of metas) {
    assert.match(m, /sendGapMs/, '每条 relay.submit 的 meta 都必须带 sendGapMs');
  }
  // 取值必须是**当场求值**的函数，不是建前端时的快照——否则设置页改完要重启才生效。
  assert.match(front, /sendGapMsOf/, '应通过 sendGapMsOf 注入取值函数');
  assert.match(front, /const gapMs = \(\) =>/, 'sendGapMs 必须是每次调用时求值');
  const idx = bridgeSrc('index.js');
  assert.match(idx, /sendGapMsOf: \(\) => clampSendGapMs\(configManager\.get\(\)\.sendGapMs\)/,
    'index.js 必须把设置里的 sendGapMs 接到前端');
});

test('窗口声明可见性（B-3）：模型目录与状态里能核对自己声明的窗口', () => {
  const prov = bridgeSrc('providers.js');
  // 目录条目带 context（此前 listAllModels 有、但要看得到「真实来源」）
  assert.match(prov, /context: m\.context \|\| null/, 'listAllModels 必须透出 context');
  assert.match(prov, /const GLM_CONTEXT_WINDOW = 1_000_000;/, 'glm/zai 窗口声明应有实名常量');
  // 控制面 /models 走的就是 listAllModels，因此面板能读到
  const ctl = bridgeSrc('web-control.js');
  assert.match(ctl, /'GET models': async \(\) => \(\{ ok: true, models: listAllModels\(\) \}\)/,
    '/__webcode/models 必须返回带 context 的目录');
  // 预算闸与声明共用同一个取值函数（否则「声明的数」与「闸门比的数」会分叉）
  const idx = bridgeSrc('index.js');
  assert.match(idx, /function contextWindowFor\(/, '窗口取值必须收口到一个函数');
});

// ── 0.14.3：GLM 深链风控页与「已在目标会话上」的接线护栏 ──────────────────────
// 来自 probe-26/27 的真机取证：C 修复让 GLM 的会话身份正确之后，第二轮**仍然**失败，
// 但失败形态换成了 fill 超时——因为导航到 ?cid= 时站点返回了阿里云滑块验证页，
// 而页面上那 3 个 textarea 全是**隐藏**的 WAF 脚本模板（内容是 CF_APP_WAF）。

test('登录回退判定必须要求 composer **可见**（只数个数会被风控页骗过）', () => {
  const src = bridgeSrc('browser-driver.js');
  assert.match(src, /async function visibleComposerCount\(/, '应有「可见 composer」判定');
  const at = src.indexOf('async function judgeLoggedIn(');
  assert.ok(at > 0, '应有 judgeLoggedIn');
  const body = src.slice(at, at + 2600);
  assert.ok(/return await visibleComposerCount\(p\) > 0;/.test(body),
    '回退判定必须走 visibleComposerCount');
  assert.ok(!/locator\(SEL\.input\)\.count\(\) > 0/.test(body),
    '不得回到「只数 SEL.input 个数」——GLM 风控页的隐藏 textarea 会命中它');
});

test('可见 composer 判定必须遍历**全部**候选选择器（GLM 的 composer 是裸 textarea）', () => {
  const src = bridgeSrc('browser-driver.js');
  const at = src.indexOf('async function visibleComposerCount(');
  const body = src.slice(at, at + 1400);
  // 真机 probe-27：GLM 真实 composer 是 <textarea>（id=null、placeholder=null），
  // 只认 SEL.input 的第一个候选（textarea#chat-input）会漏掉它 → 正常页被判未登录。
  assert.ok(/split\(','\)/.test(body), '必须切分候选选择器列表');
  assert.ok(!/split\(','\)\[0\]/.test(body), '不得只取第一个候选（会漏掉 GLM 的裸 textarea）');
  assert.match(body, /querySelectorAll\(c\)/, '逐个候选查元素');
  assert.match(body, /seen\.has\(e\)/, '跨候选去重，避免同一元素被计两次');
});

test('风控/验证页必须在判定登录态之前识别，并如实报成 challenge-page', () => {
  const src = bridgeSrc('browser-driver.js');
  assert.match(src, /async function detectChallenge\(/, '应有风控页识别');
  const at = src.indexOf('async function detectChallenge(');
  const body = src.slice(at, at + 1100);
  assert.ok(/滑动验证|访问验证/.test(body), '必须认站点验证页的文案');
  assert.ok(/CF_APP_WAF|aliyun_waf/.test(body), '必须认 WAF 脚本指纹');

  // 调用点：resume 分支里 detectChallenge 必须早于 judgeLoggedIn
  const rb = src.indexOf('let challenge = null;');
  assert.ok(rb > 0, 'resume 分支应记录 challenge');
  const seg = src.slice(rb, rb + 2800);
  const dc = seg.indexOf('detectChallenge(page)');
  const jl = seg.indexOf('judgeLoggedIn(page)');
  assert.ok(dc > 0 && jl > dc, 'detectChallenge 必须在 judgeLoggedIn 之前（否则隐藏 textarea 会骗过登录判定）');
  // 原因必须与「会话过期」分开，否则用户按会话过期去查永远查不到风控
  assert.match(seg, /challenge-page/, '必须用独立的 navReason 标注风控');
  assert.match(seg, /被风控验证页拦截/, '报错文本要说清风控');
});

test('「已在目标会话上」按会话 id 判定，不靠 URL 字符串前缀', () => {
  const src = bridgeSrc('browser-driver.js');
  const at = src.indexOf('const wantId = conversationIdFromUrl(');
  assert.ok(at > 0, '必须用会话 id 比较，而不是裸 startsWith');
  const seg = src.slice(at, at + 700);
  assert.ok(/conversationIdFromUrl\(siteId, target\)/.test(seg), '目标地址解析 id');
  assert.ok(/conversationIdFromUrl\(siteId, page\.url\(\)\)/.test(seg), '当前地址解析 id');
  assert.ok(/alreadyThere/.test(seg), '应先判断「已经在上面」再决定是否 goto');
});



