// delivery-trace-wiring.test.mjs — 交付链取证的**接线**护栏（0.19.75）。
//
// ## 为什么需要接线级用例（而不只测纯函数）
//
// 本仓库记过多次「纯函数全绿而调用点没接上」的假绿（见 test/stall-settle.test.mjs §③：
// 0.15.2 只加判据、没把配置接进去，行为「恰好」对但旋钮够不着）。所以这里用注入式
// 脚本驱动跑**真实的适配器 → relay → driver 链路**，再看取证读数有没有被填上。
//
// ## 本条钉住的关键形状：内容走**权威全文补发**时不得被误报为丢失
//
// 真机存在「增量通道什么都没送、正文只存在于 decoder.finish() 的权威全文里」的形态
// （0.16.4 记过）。适配器在拿到 end 事件时会把 `full.slice(acc.length)` 作为尾部
// **补发**给用户（lib/index.js 的 `end` 分支）。若 adapter 层只数 `ev.delta`，
// 这种轮次会显示成「relay 有、adapter 零」⇒ **误报分叉**，而用户其实拿到了全部正文。
//
// 首版正是这么写错的：探针 `.tmp/probe-trace-readings.mjs` 实测 B 形状
// （零增量 + 权威全文）交付完整，但 adapter 层没被计数。故补此护栏。
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

function mockCtx() {
  const registered = { adapter: null };
  const llm = { registerConfigurableProviders() {}, registerAdapter(ids, a) { registered.adapter = a; } };
  return { registered, ctx: { llm, get: (n) => (n === 'llm' ? llm : n === 'webServer' ? { register() {} } : undefined) } };
}

/** 跑一轮真实适配器链，返回交付文本与驱动 status 工厂（取 trace 用）。 */
async function runTurn({ deltas, endText, traceOn = true }) {
  const driver = {
    async sendTurn(key, message, { onDelta } = {}) {
      for (const d of deltas) onDelta?.(d);
      return { text: endText, sessionId: 'sess-1', metrics: {} };
    },
    async resetConversation() {}, async close() {},
    status() {
      return {
        running: true, busy: true, preview: true, lastActivityAt: Date.now(),
        domReplyChars: null, lastEndReason: null, lastRecovered: null, lastStalledSettle: null,
        thinkingOnlyTurns: 0, recoveredTurns: 0,
      };
    },
  };
  const { ctx, registered } = mockCtx();
  const dispose = apply(ctx, {
    port: 0, host: '127.0.0.1', requireConsent: false, driver,
    profileDir: process.env.TEMP + '\\webcode-trace-wiring',
    deliveryTrace: traceOn,
  });
  let text = '';
  let err = null;
  try {
    for await (const c of registered.adapter.stream({
      purpose: null, model: 'deepseek:deepseek',
      messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
      tools: [], sessionId: 'trace-wiring-' + Math.random().toString(36).slice(2),
    })) { if (c?.type === 'text-delta') text += c.text; }
  } catch (e) { err = e; }
  finally { try { dispose?.(); } catch {} }
  return { text, err };
}

test('① 零增量 + 权威全文：内容仍必须完整交付（正向基线）', async () => {
  const r = await runTurn({ deltas: [], endText: '只存在于权威全文里的正文' });
  assert.equal(r.err, null, '不得报错：' + (r.err && r.err.message));
  assert.equal(r.text, '只存在于权威全文里的正文',
    '权威全文必须被补发出去（这一支就是补发点）');
});

test('② 增量与全文一致：不得重复交付（补发逻辑不能把已有内容再发一遍）', async () => {
  const r = await runTurn({ deltas: ['网页', '答复'], endText: '网页答复' });
  assert.equal(r.text, '网页答复', '重复交付会表现为文本被拼接两次：' + JSON.stringify(r.text));
});

test('③ 增量比全文短（尾部滞后）：只补差集，不得整段重发', async () => {
  const r = await runTurn({ deltas: ['网页'], endText: '网页答复完整版' });
  assert.equal(r.text, '网页答复完整版', '必须是「已有 + 差集」：' + JSON.stringify(r.text));
});

test('④ 未开启取证时链路行为逐字不变（开关不得改变交付语义）', async () => {
  const off = await runTurn({ deltas: ['网页', '答复'], endText: '网页答复', traceOn: false });
  const on = await runTurn({ deltas: ['网页', '答复'], endText: '网页答复', traceOn: true });
  assert.equal(off.text, on.text, '开关只该影响读数，不该影响交付内容');
  assert.equal(off.err, null);
});

test('⑤ 接线存在性：adapter 层的计数点必须真的在「权威全文补发」那一支里', async () => {
  // 纯文本判据：确认 lib/index.js 里补发尾部的那一行**确实**带了 trace 计数。
  // 这一条防的是「把计数写在别处、看起来有读数、实际对不上交付」。
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8');
  assert.match(src, /turn\.trace\?\.note\('adapter', rest\)/,
    '「权威全文补发的尾部」必须计入 adapter 层，否则该形状会被误报成分叉');
  assert.match(src, /turn\.trace\?\.note\('relay', t\)/,
    'relay 层必须真的接在 onDelta 上');
});