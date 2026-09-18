// prompt-compact.test.mjs — 0.16.11 护栏：PROMPT_TRUNCATED 的压缩重试（长跑阻断项）。
//
// 真机取证（doc/diagnosis-2026-09-19.md §一）：会话 0a62dbb8 首轮提示词 72,980 字符，
// 网页输入框只收了 72,969——**差 11 个字符**，整轮按 PROMPT_TRUNCATED 致命错误作废，
// 模型一个字都没回。0.16.7 起 DeepSeek 禁用附件投递（收得下但读不到），长文本只能
// inline，这类越界在长跑里必然复发。
//
// 修法两层：
//   · 纯函数层 —— `serializeFirstTurn` 接受 `maxPromptChars`：超预算时**丢最旧的消息段**
//     （最新上下文与工具教学完整保留），插入显式的省略标记。绝不静默截断字符串——
//     截在 JSON 中间会让模型看到坏掉的结构（「上下文不丢」约束的诚实版：丢就明说）。
//   · 接线层 —— 驱动报 PROMPT_TRUNCATED 时带 accepted/total；executor 对 fresh 首轮
//     自动按 accepted 压缩重试一次。
//
// 默认路径零位移（PROMPT-ENGINEERING.md §1.3）：不传 maxPromptChars 时输出必须与
// 既有实现逐字节相同。

import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';
import { serializeFirstTurn } from '../lib/agent-preset.js';

const TOOLS = [{ name: 'read', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
const sys = (text) => ({ role: 'system', content: [{ type: 'text', text }] });
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const assistant = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] });

function bigMessages() {
  const filler = '历史消息占位内容。'.repeat(200); // ≈ 2000 字符/条
  const msgs = [sys('系统指令。')];
  for (let i = 0; i < 30; i++) {
    msgs.push(user(`第 ${i} 轮提问：${filler}`));
    msgs.push(assistant(`第 ${i} 轮答复：${filler}`));
  }
  msgs.push(user('最新任务：请审查本项目代码质量并出报告。'));
  return msgs;
}

test('不传 maxPromptChars：输出与无预算路径逐字节相同（默认路径零位移）', () => {
  const msgs = bigMessages();
  const a = serializeFirstTurn({ messages: msgs, tools: TOOLS, siteId: 'deepseek' });
  const b = serializeFirstTurn({ messages: msgs, tools: TOOLS, siteId: 'deepseek', maxPromptChars: undefined });
  assert.equal(a, b);
});

test('预算内：不做任何压缩，输出与无预算逐字节相同', () => {
  const msgs = bigMessages();
  const full = serializeFirstTurn({ messages: msgs, tools: TOOLS, siteId: 'deepseek' });
  const under = serializeFirstTurn({ messages: msgs, tools: TOOLS, siteId: 'deepseek', maxPromptChars: full.length + 1000 });
  assert.equal(under, full);
});

test('超预算：丢最旧消息段、留显式标记、最新任务完整保留', () => {
  const msgs = bigMessages();
  const full = serializeFirstTurn({ messages: msgs, tools: TOOLS, siteId: 'deepseek' });
  const budget = Math.floor(full.length * 0.5);
  const compact = serializeFirstTurn({ messages: msgs, tools: TOOLS, siteId: 'deepseek', maxPromptChars: budget });
  assert.ok(compact.length < full.length, '压缩后必须更短');
  assert.ok(compact.length <= budget, `必须真的装进预算（${compact.length} <= ${budget}）`);
  assert.match(compact, /早期上下文已省略 \d+ 条消息/, '省略必须显式留痕，不得静默');
  assert.ok(compact.includes('最新任务：请审查本项目代码质量并出报告。'), '最新消息必须完整保留');
  assert.ok(!compact.includes('第 0 轮提问'), '最旧的消息必须被丢掉');
  assert.ok(compact.includes('[会话开始]'), '桥的教学与协议头必须保留');
});

test('极端小预算：不抛错、保底保留最新一条消息（装不下由 PROMPT_TRUNCATED 回读兜底）', () => {
  const msgs = bigMessages();
  const compact = serializeFirstTurn({ messages: msgs, tools: TOOLS, siteId: 'deepseek', maxPromptChars: 50 });
  assert.ok(compact.includes('最新任务：请审查本项目代码质量并出报告。'), '最新一条必须保底保留');
});

test('端到端：首轮 PROMPT_TRUNCATED 自动按 accepted 压缩重试一次', async () => {
  const msgs = bigMessages();
  const seen = [];
  let calls = 0;
  let adapter;
  const dispose = apply(
    { llm: { registerAdapter: (_, a) => { adapter = a; } }, get: () => null },
    {
      port: 0, requireConsent: false, contextMode: 'session',
      driver: {
        status: () => ({ running: true }), close: async () => {}, resetConversation: async () => {},
        sendTurn: async (key, prompt) => {
          calls += 1;
          seen.push(prompt);
          if (calls === 1) {
            const err = new Error(`PROMPT_TRUNCATED: 网页输入框只接收了 60000/${prompt.length} 字符（网页端长度上限）— 请缩短上下文或先压缩历史再重试`);
            err.code = 'PROMPT_TRUNCATED';
            err.accepted = 60000;
            err.total = prompt.length;
            throw err;
          }
          return { text: '压缩重试后正常收尾。' };
        },
        sendPrompt: async (prompt) => { seen.push(prompt); return { text: 'ok' }; },
      },
    },
  );
  try {
    const chunks = [];
    for await (const c of adapter.stream({
      sessionId: 'compact-retry', model: 'deepseek:deepseek', tools: TOOLS, messages: msgs,
    })) chunks.push(c);
    assert.equal(calls, 2, `必须重试一次（实际 ${calls} 次）`);
    assert.ok(seen[0].length > 60000, '首轮必须先撞上越界');
    assert.ok(seen[1].length <= 60000, `重试的提示词必须装进 accepted（${seen[1].length} <= 60000）`);
    assert.ok(seen[1].length < seen[0].length, '重试提示词必须比原提示词短');
    assert.match(seen[1], /早期上下文已省略 \d+ 条消息/, '重试提示词必须带省略标记');
    assert.ok(seen[1].includes('最新任务：请审查本项目代码质量并出报告。'), '最新任务保留');
    assert.equal(chunks.at(-1).type, 'finish', '重试后必须正常收尾');
  } finally { await dispose(); }
});
