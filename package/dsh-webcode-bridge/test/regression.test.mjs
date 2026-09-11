import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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
  assert.deepEqual(calls, [{ name: 'read', arguments: { path: 'doc/security-review.md' } }]);
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

test('工具名称在网页流完成前到达 Harness，参数完整后才提交', async () => {
  let adapter, finish;
  const result = new Promise(resolve => { finish = resolve; });
  const driver = {
    status: () => ({}), close: async () => {},
    sendPrompt: async (_, opts) => { opts.onDelta('**Calling:** `read`\n'); return result; },
  };
  const dispose = apply({ llm: { registerAdapter: (_, value) => { adapter = value; } }, get: () => null }, { port: 0, requireConsent: false, driver });
  try {
    const stream = adapter.stream({ model: 'flash', tools: [{ name: 'read', parameters: {} }], messages: [{ role: 'user', content: '读取文件' }] });
    assert.equal((await stream.next()).value.type, 'block-start');
    const early = (await stream.next()).value;
    assert.equal(early.type, 'tool-call-delta');
    assert.equal(early.name, 'read');
    assert.equal(early.argumentsDelta, '');
    finish({ text: '**Calling:** `read`\n{"path":"README.md"}' });
    const remaining = []; for await (const chunk of stream) remaining.push(chunk);
    assert.equal(remaining.find(chunk => chunk.type === 'block-end').block.arguments, '{"path":"README.md"}');
    // 0.7.1 回归（真实会话 f3fa97fd 复盘）：流式期间提前开块的调用，收尾时
    // 必须复用同一块补发参数——旧实现另开新块重发，Harness 收到同 id 两条
    // tool-call（空参数 INVALID_ARGS + 真参数重复执行）。
    const callEnds = remaining.filter(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call');
    assert.equal(callEnds.length, 1, '必须只有一个 tool-call 终块，实际 ' + callEnds.length);
    const callStarts = remaining.filter(chunk => chunk.type === 'block-start' && chunk.blockType === 'tool-call');
    assert.equal(callStarts.length, 0, '流中已开块，收尾不得再 block-start 新 tool-call');
    const deltas = remaining.filter(chunk => chunk.type === 'tool-call-delta');
    assert.equal(deltas.length, 1, '只有一个 tool-call-delta（同块补发参数）');
    assert.equal(deltas[0].argumentsDelta, '{"path":"README.md"}');
    assert.equal(deltas[0].id, early.id, '复用流式期间已宣布的 call id');
    assert.equal(callEnds[0].block.id, early.id, '终块 id 与流式期间一致');
  } finally { finish({ text: '' }); dispose(); }
});

test('流式多调用场景不重发：首调用复用 pendingCall 块，后续调用各一块', async () => {
  let adapter, finish;
  const result = new Promise(resolve => { finish = resolve; });
  const driver = {
    status: () => ({}), close: async () => {},
    sendPrompt: async (_, opts) => {
      // 流式先到达第一个调用的开头（fence + name），足以触发 pendingCall
      opts.onDelta('```json\n{"mcp_action": "call", "name": "read", "arguments": {"path":');
      return result;
    },
  };
  const dispose = apply({ llm: { registerAdapter: (_, value) => { adapter = value; } }, get: () => null }, { port: 0, requireConsent: false, driver });
  try {
    const stream = adapter.stream({ model: 'flash', tools: [{ name: 'read', parameters: {} }, { name: 'grep', parameters: {} }], messages: [{ role: 'user', content: '读两个目标' }] });
    await stream.next(); // block-start（pendingCall 开块）
    const early = (await stream.next()).value;
    assert.equal(early.type, 'tool-call-delta');
    assert.equal(early.name, 'read', '流式期间即宣布首调用名');
    finish({ text: '```json\n{"mcp_action": "call", "name": "read", "arguments": {"path": "README.md"}}\n```\n```json\n{"mcp_action": "call", "name": "grep", "arguments": {"query": "secret"}}\n```' });
    const remaining = []; for await (const chunk of stream) remaining.push(chunk);
    const callEnds = remaining.filter(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call');
    assert.equal(callEnds.length, 2, '两个调用两个终块');
    assert.deepEqual(callEnds.map(b => b.block.name), ['read', 'grep']);
    const ids = new Set(callEnds.map(b => b.block.id));
    assert.equal(ids.size, 2, '两个调用 id 不同');
    const lateStarts = remaining.filter(chunk => chunk.type === 'block-start');
    assert.equal(lateStarts.length, 1, '只有第二个调用新开块，首个复用流式已开块');
    assert.equal(lateStarts[0].blockType, 'tool-call');
    assert.equal(callEnds[0].block.id, early.id, '首调用终块 id 复用流式期间宣布的 id');
    const readDelta = remaining.find(chunk => chunk.type === 'tool-call-delta' && chunk.argumentsDelta?.includes('README'));
    assert.equal(readDelta.id, early.id, '首调用参数增量落在同一块');
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



