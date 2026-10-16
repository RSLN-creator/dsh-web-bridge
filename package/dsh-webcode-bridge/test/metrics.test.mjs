import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveLastRate, expectedModelType, expectedRequestMetadata, estimateTokens } from '../lib/metrics.js';

const oldEstimate = (s) => Math.ceil((s ? String(s).length : 0) / 4);

test('deriveLastRate：空/无 metrics → null', () => {
  assert.equal(deriveLastRate(null), null);
  assert.equal(deriveLastRate({}), null);
  assert.equal(deriveLastRate({ metrics: null, chars: 5 }), null);
});

test('deriveLastRate：正常样本推导 charsPerSec 与各阶段', () => {
  const out = deriveLastRate({ metrics: { responseMs: 349, firstResponseMs: 528, thinkingMs: null, endToEndMs: 877 }, chars: 12 }, 'deepseek');
  assert.deepEqual(out, {
    chars: 12,
    responseMs: 349,
    firstResponseMs: 528,
    thinkingMs: null,
    endToEndMs: 877,
    charsPerSec: 34, // Math.round(12 / (349 / 1000))
    mode: 'deepseek',
  });
});

test('deriveLastRate：responseMs<=0 → charsPerSec null（不除零）', () => {
  const out = deriveLastRate({ metrics: { responseMs: 0, firstResponseMs: null }, chars: 100 });
  assert.equal(out.charsPerSec, null);
  assert.equal(out.firstResponseMs, null);
});

test('deriveLastRate：默认 mode null', () => {
  const out = deriveLastRate({ metrics: { responseMs: 1000 }, chars: 500 });
  assert.equal(out.mode, null);
});

test('expectedModelType：classic（旧三 pill UI）deepseek 走专家模式', () => {
  assert.equal(expectedModelType('deepseek'), 'expert');
  assert.equal(expectedModelType('unknown'), null);
});

test('expectedModelType：unified（2026-09-10 新版 UI）model_type 恒为 default', () => {
  // probe-19/20 真机实测：新版没有模型 pill，纯文本与带图发送的 model_type 都是 default
  assert.equal(expectedModelType('deepseek', 'unified'), 'default');
});

test('expectedRequestMetadata：unified 看 thinking_enabled，classic 看 model_type', () => {
  assert.deepEqual(expectedRequestMetadata('deepseek', { ui: 'unified', wantThink: true }), { model_type: 'default', thinking_enabled: true });
  assert.deepEqual(expectedRequestMetadata('deepseek', { ui: 'unified', wantThink: false }), { model_type: 'default', thinking_enabled: false });
  assert.deepEqual(expectedRequestMetadata('deepseek', { ui: 'classic', wantThink: true }), { model_type: 'expert' });
});

test('estimateTokens：空串 → 0', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(undefined), 0);
});

test('estimateTokens：中文不再被低估（修复 字符数/4 失真）', () => {
  // 旧实现 5 汉字→2 token；真实 DeepSeek 中文 ≈0.7+ tok/字，应明显高于旧估算
  const zh = '这是一个安全问题排查示例文本';
  const now = estimateTokens(zh);
  assert.ok(now > oldEstimate(zh), `中文应比旧实现高：${now} vs ${oldEstimate(zh)}`);
  assert.ok(Math.abs(now - zh.length * 0.7) <= Math.ceil(zh.length * 0.08) + 2, '中文估算贴近 0.7 tok/字');
});

test('estimateTokens：纯英文估算合理且≥1', () => {
  const en = 'hello world security review package json dependencies';
  const now = estimateTokens(en);
  assert.ok(now >= 1 && now <= en.length, `英文估算 ${now}`);
  // 英文 0.25 tok/char 上下，不应按 1:1
  assert.ok(now <= Math.ceil(en.length / 3) + 1, '英文不过高估');
});

test('estimateTokens：非空至少 1 token', () => {
  assert.equal(estimateTokens('啊'), 1);
  assert.equal(estimateTokens('a'), 1);
});

test('estimateTokens：中英混合按 CJK/ASCII 分别计价', () => {
  const zh = '审查';            // 2 汉字
  const mix = '审查 package.json';
  const zhOnly = estimateTokens('审查审查审查'); // 6 汉字
  const mixE = estimateTokens(mix);
  assert.ok(mixE >= estimateTokens('package.json'), '混合含 ASCII 不应低于纯 ASCII 部分');
  assert.ok(zhOnly > estimateTokens('abc'), '纯中文长文本估算应高于短英文');
});

test('estimateTokens：非 ASCII 非 CJK（emoji/带重音拉丁）仍按 other 计价，快速路径不改变归类', () => {
  // 0.19.92 给 ASCII 加了码点快速路径；这条钉住「非 ASCII 非 CJK 字符仍落 other 桶」
  // 这一语义等价性，防止将来有人把 else 分支写成 word 而悄悄改判计价。
  const emoji = '🙂';         // 码点 > 128，非 CJK
  const accented = 'é';       // 带重音拉丁
  // 一个 emoji 与一个 ascii 符号同桶，估算应一致（margin 下至少同数量级、且相等）
  assert.equal(estimateTokens(emoji), estimateTokens('!'));
  assert.equal(estimateTokens(accented), estimateTokens('!'));
});