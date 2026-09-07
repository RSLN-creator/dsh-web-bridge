import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

/** 模拟网页：先吐思考增量，再吐正文增量，最后返回含 thinking/images 的终态。 */
function driverWith(emit) {
  return {
    status: () => ({ running: true }),
    close: async () => {},
    resetConversation: async () => {},
    sendPrompt: async (prompt, opts) => {
      emit(opts);
      return {
        text: '结论：已完成。',
        thinking: '先分析需求，再核对边界……',
        images: [{ url: 'https://example.com/a.png', mime: 'image/png' }, { base64: 'QUJD', mime: 'image/jpeg' }],
      };
    },
  };
}

function setup(driver) {
  let adapter;
  const dispose = apply({ llm: { registerAdapter: (_, a) => { adapter = a; } }, get: () => null }, { port: 0, requireConsent: false, driver });
  const collect = async (options) => { const chunks = []; for await (const c of adapter.stream(options)) chunks.push(c); return chunks; };
  return { dispose, collect };
}

test('纯聊天：深度思考链经 reasoning 块输出、图片转为 markdown 追加', async () => {
  const { dispose, collect } = setup(driverWith((opts) => {
    opts.onThink('先分析需求，');
    opts.onThink('再核对边界……');
    opts.onDelta('结论：已完成。');
  }));
  try {
    const chunks = await collect({ model: 'deepseek', messages: [{ role: 'user', content: '深度思考' }] });
    const reasoningStarts = chunks.filter((c) => c.type === 'block-start' && c.blockType === 'reasoning');
    const reasonDeltas = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('');
    const reasonEnds = chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'reasoning');
    assert.equal(reasoningStarts.length, 1, 'reasoning 块只开一次');
    assert.equal(reasonEnds.length, 1, 'reasoning 块闭合');
    assert.equal(reasonDeltas, '先分析需求，再核对边界……');
    assert.equal(reasonEnds[0].block.text, '先分析需求，再核对边界……');
    const textDeltas = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
    assert.ok(textDeltas.includes('结论：已完成。'), '正文完整');
    assert.ok(textDeltas.includes('![image](https://example.com/a.png)'), 'url 图片转 markdown');
    assert.ok(textDeltas.includes('data:image/jpeg;base64,QUJD'), 'base64 图片转 markdown');
    const textEnd = chunks.find((c) => c.type === 'block-end' && c.block?.type === 'text');
    assert.ok(textEnd.block.text.includes('![image](https://example.com/a.png)'), '终态文本含图片');
    assert.equal(chunks.at(-1).type, 'finish');
  } finally { await dispose(); }
});

test('纯聊天：无思考链无图片时仍输出普通文本块（兼容旧行为）', async () => {
  const driver = {
    status: () => ({}), close: async () => {},
    sendPrompt: async (_, opts) => { opts.onDelta?.('回答'); return { text: '回答' }; },
  };
  const { dispose, collect } = setup(driver);
  try {
    const chunks = await collect({ model: 'flash', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(chunks.find((c) => c.type === 'block-start').blockType, 'text');
    assert.ok(!chunks.some((c) => c.blockType === 'reasoning' || c.type === 'reasoning-delta'));
    assert.equal(chunks.filter((c) => c.type === 'block-end').length, 1);
    assert.equal(chunks.at(-1).type, 'finish');
  } finally { await dispose(); }
});

test('工具模式：思考链在正文前闭合、工具调用在文本之后', async () => {
  const toolText = '我先读一下。\n<tool_call>{"mcp_action":"call","name":"read","purpose":"x","arguments":{"path":"PLAN.md"}}</tool_call>';
  const driver = {
    status: () => ({}), close: async () => {},
    sendPrompt: async (_, opts) => {
      opts.onThink('先想清楚要调什么工具……');
      opts.onDelta('我先读一下。\n<tool_call>');
      opts.onDelta('{"mcp_action":"call","name":"read","purpose":"x","arguments":{"path":"PLAN.md"}}');
      opts.onDelta('</tool_call>');
      return { text: toolText, thinking: '先想清楚要调什么工具……', images: [] };
    },
  };
  const { dispose, collect } = setup(driver);
  try {
    const chunks = await collect({ model: 'deepseek', tools: [{ name: 'read', parameters: {} }], messages: [{ role: 'user', content: '读 PLAN' }] });
    const reasonEnd = chunks.find((c) => c.type === 'block-end' && c.block?.type === 'reasoning');
    assert.equal(reasonEnd.block.text, '先想清楚要调什么工具……');
    const reasonIdx = chunks.indexOf(reasonEnd);
    const textStart = chunks.find((c) => c.type === 'block-start' && c.blockType === 'text');
    const toolStart = chunks.find((c) => c.type === 'block-start' && c.blockType === 'tool-call');
    assert.ok(textStart && toolStart, '文本块与工具块均存在');
    assert.ok(chunks.indexOf(textStart) > reasonIdx, '思考链在正文之前');
    assert.ok(chunks.indexOf(toolStart) > chunks.indexOf(textStart), '工具块在正文之后');
    const tool = chunks.find((c) => c.type === 'tool-call-delta' && c.name === 'read');
    assert.ok(tool, '工具调用参数完整');
    assert.equal(chunks.at(-1).type, 'finish');
  } finally { await dispose(); }
});
