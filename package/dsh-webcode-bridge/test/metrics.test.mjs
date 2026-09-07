import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveLastRate, expectedModelType, estimateTokens } from '../lib/metrics.js';

const oldEstimate = (s) => Math.ceil((s ? String(s).length : 0) / 4);

test('deriveLastRate：空/无 metrics → null', () => {
  assert.equal(deriveLastRate(null), null);
  assert.equal(deriveLastRate({}), null);
  assert.equal(deriveLastRate({ metrics: null, chars: 5 }), null);
});

test('deriveLastRate：正常样本推导 charsPerSec 与各阶段', () => {
  const out = deriveLastRate({ metrics: { responseMs: 349, firstResponseMs: 528, thinkingMs: null, endToEndMs: 877 }, chars: 12 }, 'flash');
  assert.deepEqual(out, {
    chars: 12,
    responseMs: 349,
    firstResponseMs: 528,
    thinkingMs: null,
    endToEndMs: 877,
    charsPerSec: 34, // Math.round(12 / (349 / 1000))
    mode: 'flash',
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

test('expectedModelType：真机核验契约 flash=default/deepseek=expert/vision=vision', () => {
  assert.equal(expectedModelType('flash'), 'default');
  assert.equal(expectedModelType('deepseek'), 'expert');
  assert.equal(expectedModelType('vision'), 'vision');
  assert.equal(expectedModelType('unknown'), null);
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