// empty-response.test.mjs — 0.16.11 护栏：思考-only 轮不得整轮作废（#26）。
//
// 真机取证（会话 d5fd2e11 turn 8，2026-09-18 22:48，见 doc/diagnosis-2026-09-19.md §二）：
// 网页只送出 reasoning 块（block-start + reasoning-chunks + finish，正文与调用一个字节
// 都没有），驱动的 `empty response from web AI` 判定只看 result.text —— 思考再多也照抛，
// 整轮以 UNKNOWN 硬错误作废，任务断链，用户必须手动补一句才能继续。
//
// 与 #22「只出思考不出正文」同族，但那次没走 thinkingOnlyNotice 软提示路径。
// 修法：空回复判定抽成纯函数 emptyWebResponseError（正文/思考/图片**全空**才判空），
// 驱动只抛全空轮；思考-only 轮把结果交回适配器，由 zeroProgressDecision →
// thinkingOnlyNotice 交回提示正文，任务继续。

import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';
import { emptyWebResponseError } from '../lib/zero-progress.js';

const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const TOOLS = [{ name: 'read', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];

function harness(sendTurnImpl) {
  let adapter;
  const dispose = apply(
    { llm: { registerAdapter: (_, a) => { adapter = a; } }, get: () => null },
    {
      port: 0, requireConsent: false,
      driver: {
        status: () => ({ running: true }), close: async () => {}, resetConversation: async () => {},
        sendTurn: sendTurnImpl,
        sendPrompt: async (prompt, opts) => sendTurnImpl('main', prompt, opts),
      },
    },
  );
  const collect = async (options) => {
    const chunks = [];
    for await (const c of adapter.stream(options)) chunks.push(c);
    return chunks;
  };
  return { collect, dispose };
}

test('纯函数：只有思考（正文空）不是空回复——必须返回 null 让 thinkingOnly 接手', () => {
  assert.equal(emptyWebResponseError({ text: '', thinking: 'let me check the repo structure', images: [] }), null);
});

test('纯函数：只有图片也不是空回复（识图轮的合法形态）', () => {
  assert.equal(emptyWebResponseError({ text: '', thinking: '', images: [{ contentType: 'image/png' }] }), null);
});

test('纯函数：正文/思考/图片全空才是空回复，且报错带收束现场', () => {
  const err = emptyWebResponseError({ text: '  ', thinking: '', images: [] }, { lastEndReason: 'finished' });
  assert.ok(err instanceof Error, '全空必须返回 Error');
  assert.match(err.message, /^empty response from web AI/, '报错前缀必须保留（既有日志/告警按它匹配）');
  assert.match(err.message, /finished/, '报错必须带收束原因（报错自带取证的纪律）');
});

test('纯函数：入参畸形（null/缺字段）按全空处理，不抛 TypeError', () => {
  assert.ok(emptyWebResponseError(null) instanceof Error);
  assert.ok(emptyWebResponseError(undefined) instanceof Error);
  assert.ok(emptyWebResponseError({}) instanceof Error);
});

test('端到端：思考-only 轮必须交回 THINKING_ONLY_NO_ANSWER 提示，而不是整轮作废', async () => {
  const { collect, dispose } = harness(async (key, prompt, opts) => {
    opts.onThink?.('The task needs the repo layout first, so I will inspect the tree.');
    return { text: '', thinking: 'The task needs the repo layout first, so I will inspect the tree.' };
  });
  try {
    const chunks = await collect({
      sessionId: 'think-only', model: 'deepseek:deepseek', tools: TOOLS,
      messages: [user('继续任务')],
    });
    assert.equal(chunks.at(-1).type, 'finish', '必须正常收尾而不是抛 empty response');
    assert.equal(chunks.at(-1).reason.kind, 'stop');
    const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
    assert.match(deltas, /THINKING_ONLY_NO_ANSWER/, '必须交回思考-only 提示让任务继续');
    assert.match(deltas, /inspect the tree/, '提示必须带思考末尾现场');
  } finally { await dispose(); }
});
