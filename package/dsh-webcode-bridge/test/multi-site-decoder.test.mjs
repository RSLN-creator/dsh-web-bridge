import test from 'node:test';
import assert from 'node:assert/strict';
import '../lib/decoder.js';
import { qualifyModelId, resolveWebModel, listAllModels, SITES } from '../lib/providers.js';

const D = globalThis.WebCodeStreamDecoders;

test('qualifyModelId：裸 id 补站点前缀、限定 id 原样、空值透传', () => {
  assert.equal(qualifyModelId('auto', 'glm'), 'glm:auto');
  assert.equal(qualifyModelId('deepseek:deepseek', 'deepseek'), 'deepseek:deepseek');
  assert.equal(qualifyModelId('flash', undefined), 'flash');
  assert.equal(qualifyModelId(null, 'glm'), null);
});

test('listAllModels：全站点目录含 DeepSeek/GLM/ChatGPT/Kimi/Qwen 与兼容别名', () => {
  const all = listAllModels();
  const ids = new Set(all.map((m) => m.id));
  // 三合一后 DeepSeek 只有唯一模型（旧 id 仍可解析为别名，但不再出现在目录里）
  assert.ok(ids.has('deepseek:deepseek') && !ids.has('deepseek:flash') && !ids.has('deepseek:vision'));
  assert.ok(ids.has('glm:auto') && ids.has('chatgpt:auto') && ids.has('kimi:auto'));
  assert.ok(ids.has('qwen:auto') && ids.has('deepseek-web'));
  // z.ai（GLM 海外站点）已入目录，且别名可解析
  assert.ok(ids.has('zai:auto'), '目录应包含 zai:auto');
  assert.equal(resolveWebModel('zai').siteId, 'zai');
  assert.equal(resolveWebModel('z-ai').siteId, 'zai');
  const m = resolveWebModel('glm:auto');
  assert.equal(m.siteId, 'glm');
  assert.equal(m.id, 'auto');
});

test('z.ai：站点契约（origin / SSE 端点 / 解码器 / 静态域）', () => {
  const z = resolveWebModel('zai:auto');
  assert.equal(z.siteId, 'zai');
  assert.equal(z.origin, 'https://chat.z.ai');
  assert.equal(z.decoder, 'openai-sse');
  const st = SITES.find(s => s.id === 'zai');
  assert.ok(st, 'SITES 必须包含 zai');
  assert.ok(st.completionPaths.includes('/api/chat/completions'));
  assert.deepEqual([...st.staticOrigins], ['https://z-cdn.chatglm.cn', 'https://api.z.ai']);
  // 解码器注册表里确实有这个 kind（否则驱动会静默拿不到 decoder）
  assert.equal(typeof D['openai-sse'], 'function');
});

test('glm：parts[].content[] 嵌套结构的正文与图片（glm-free-api 同构帧）', () => {
  const deltas = [];
  const images = [];
  const decoder = new D.glm({ onDelta: (t) => deltas.push(t), onImage: (i) => images.push(i) });
  const frame = (obj) => decoder.push('data: ' + JSON.stringify(obj) + '\n\n');
  frame({
    conversation_id: 'c1', status: 'processing',
    parts: [{ status: 'processing', content: [
      { status: 'init', type: 'text', text: '你好，' },
    ] }],
  });
  frame({
    conversation_id: 'c1', status: 'processing',
    parts: [{ status: 'processing', content: [
      { status: 'finish', type: 'text', text: '我是 GLM。' },
      { status: 'finish', type: 'image', image: [{ image_url: 'https://glm.example/a.png' }] },
    ] }],
  });
  frame({ conversation_id: 'c1', status: 'finish', parts: [] });
  const out = decoder.finish();
  assert.equal(out.complete, true);
  assert.equal(out.text, '你好，我是 GLM。');
  assert.deepEqual(deltas.join(''), '你好，我是 GLM。');
  assert.equal(images.length, 1);
  assert.equal(images[0].url, 'https://glm.example/a.png');
});

test('kimi：cmpl 事件正文 + all_done 收尾（Kimi-Free-API 同构帧）', () => {
  const deltas = [];
  const decoder = new D.kimi({ onDelta: (t) => deltas.push(t) });
  const frame = (obj) => decoder.push('data: ' + JSON.stringify(obj) + '\n\n');
  frame({ event: 'req', id: 'seg1' });
  frame({ event: 'cmpl', text: '你好' });
  frame({ event: 'cmpl', text: '，我是 Kimi。' });
  frame({ event: 'search_plus', msg: { type: 'get_res', title: '来源', url: 'https://x' } });
  frame({ event: 'all_done' });
  const out = decoder.finish();
  assert.equal(out.complete, true);
  assert.equal(out.text, '你好，我是 Kimi。');
  assert.deepEqual(deltas.join(''), '你好，我是 Kimi。');
});

test('kimi：thinking 字段经 onThink 暴露且不混入正文', () => {
  const think = [];
  const decoder = new D.kimi({ onDelta: () => {}, onThink: (t) => think.push(t) });
  decoder.push('data: ' + JSON.stringify({ event: 'cmpl', thinking: '先分析……', text: '结论。' }) + '\n\n');
  decoder.push('data: ' + JSON.stringify({ event: 'all_done' }) + '\n\n');
  const out = decoder.finish();
  assert.equal(out.complete, true);
  assert.ok(think.join('').includes('先分析'));
  assert.equal(out.text, '结论。');
  assert.ok(!out.text.includes('先分析'));
});

test('chatgpt：JSON-patch 帧 o/p/v（LLMs2API 同构）', () => {
  const deltas = [];
  const decoder = new D.chatgpt({ onDelta: (t) => deltas.push(t) });
  decoder.push('data: ' + JSON.stringify({ o: 'append', p: '/message/content/parts/0', v: 'Hello' }) + '\n\n');
  decoder.push('data: ' + JSON.stringify({ o: 'append', p: '/message/content/parts/0', v: ' world' }) + '\n\n');
  decoder.push('data: ' + JSON.stringify({ type: 'message_stream_complete' }) + '\n\n');
  const out = decoder.finish();
  assert.equal(out.complete, true);
  assert.equal(out.text, 'Hello world');
  assert.deepEqual(deltas.join(''), 'Hello world');
});

test('chatgpt：reasoning JSON-patch 帧走 onThink', () => {
  const think = [];
  const decoder = new D.chatgpt({ onDelta: () => {}, onThink: (t) => think.push(t) });
  decoder.push('data: ' + JSON.stringify({ o: 'append', p: '/message/reasoning/0', v: '想一下' }) + '\n\n');
  decoder.push('data: ' + JSON.stringify({ type: 'message_stream_complete' }) + '\n\n');
  const out = decoder.finish();
  assert.equal(out.complete, true);
  assert.ok(think.join('').includes('想一下'));
  assert.equal(out.text, '');
});

test('qwen：contents[] 直连兜底结构（qwen-free-api 同构）', () => {
  const deltas = [];
  const decoder = new D['openai-sse']({ onDelta: (t) => deltas.push(t) });
  decoder.push('data: ' + JSON.stringify({ sessionId: 's1', msgId: 'm1', contentType: 'text', msgStatus: 'running', contents: [{ contentType: 'text', role: 'assistant', content: '你好' }] }) + '\n\n');
  decoder.push('data: ' + JSON.stringify({ sessionId: 's1', msgId: 'm1', contentType: 'text', msgStatus: 'finished', contents: [{ contentType: 'text', role: 'assistant', content: '，我是通义。' }] }) + '\n\n');
  const out = decoder.finish();
  assert.equal(out.complete, true);
  assert.equal(out.text, '你好，我是通义。');
  assert.deepEqual(deltas.join(''), '你好，我是通义。');
});

test('qwen：OpenAI 兼容 SSE 仍正常（LLMs2API 实测浏览器形态）', () => {
  const deltas = [];
  const decoder = new D['openai-sse']({ onDelta: (t) => deltas.push(t) });
  decoder.push('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hi' }, finish_reason: null }] }) + '\n\n');
  decoder.push('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n');
  const out = decoder.finish();
  assert.equal(out.complete, true);
  assert.equal(out.text, 'Hi');
  assert.deepEqual(deltas.join(''), 'Hi');
});
