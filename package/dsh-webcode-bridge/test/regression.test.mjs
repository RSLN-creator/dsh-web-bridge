import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';
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
    assert.ok(ids.includes('deepseek:flash') && ids.includes('deepseek:vision') && ids.includes('deepseek:deepseek'));
    assert.ok(ids.includes('glm:glm-4.6') && ids.includes('chatgpt:gpt-5') && ids.includes('kimi:kimi'));
    const base = { sessionId: 'regression', model: 'flash', messages: [user('第一句')] };
    const chunks = await collect(base);
    assert.equal(chunks.at(-1).type, 'finish');
    assert.equal(turns[0].model, 'deepseek:flash');
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
    // 无 model 字段 → buildTurn 用 settings defaultModel；默认配置里 defaultModel='flash'
    const chunks = await collect({ sessionId: 'dm', messages: [user('问')] });
    assert.equal(chunks.at(-1).type, 'finish');
    assert.equal(turns[0].model, 'deepseek:flash');
  } finally { await dispose(); }
});
test('首轮保留全部历史与工具结果', () => {
  const text = serializeFirstTurn({ messages: [{ role: 'user', content: '旧问题' }, { role: 'assistant', content: '旧答案' }, { role: 'user', content: '最新问题' }] });
  assert.ok(text.includes('最新问题')); assert.ok(text.includes('旧答案'));
  const delta = serializeDelta([{ role: 'tool', tool_call_id: 'a', name: 'read', content: '文件内容' }], 0);
  assert.ok(delta.text.includes('文件内容'));
});
test('普通 JSON 示例不触发工具执行', () => {
  assert.equal(parseAgentReply('例子：```json\n{"name":"read","arguments":{}}\n```').calls.length, 0);
});
test('真实网页 Calling 格式经过严格 JSON 解析', () => {
  assert.deepEqual(parseAgentReply('**Calling:** `str_replace_editor`\n{"command":"view","path":"README.md"}').calls,
    [{ name: 'str_replace_editor', arguments: { command: 'view', path: 'README.md' } }]);
  assert.equal(parseAgentReply('例如 Calling: read {"path":"secret"}').calls.length, 0);
  assert.equal(parseAgentReply('**Calling:** `read`\n{"path":"README.md"}\n只是示例').calls.length, 0);
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
