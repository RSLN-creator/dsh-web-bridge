// site-attach-limit.test.mjs — 0.19.11 护栏：站点级附件阈值收紧。
//
// 真机病因（2026-09-24）：全站默认 attachInlineLimitChars = 60_000，而 webcode
// 路由的**典型首轮**实测 48,937 / 53,797 字符（navTrace 的 messageChars）——
// 低于阈值 ⇒ under-limit ⇒ 全文逐字灌进输入框。用户原话：「明明在附件投递模式下，
// 看的还是完整上下文」。越典型的会话越走 inline，这就是病根。
//
// 修法只做两件事：给 deepseek 一个更低的站点上限；**只收紧不开启**。

import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveAttachInlineLimit, SITE_ATTACH_INLINE_LIMIT } from '../lib/browser-driver.js';

test('deepseek 的站点上限低于全站默认 60,000（否则典型首轮仍走 inline）', () => {
  const limit = effectiveAttachInlineLimit('deepseek', 60_000);
  assert.ok(limit < 60_000, 'deepseek 必须被收紧');
  // 真机典型首轮的两个实测值必须落进 attach 区（> limit）
  assert.ok(limit < 48_937, `典型首轮 48,937 字符必须走附件（当前上限 ${limit}）`);
  assert.ok(limit < 53_797, '典型首轮 53,797 字符必须走附件');
  // 真机探针证明 3,554 字符的附件也能被读，但阈值不必压到那么低（省一次上传往返）
  assert.ok(limit >= 3_554, '不必低于真机已验证的最小可用尺寸');
});

test('「0 = 关闭」的语义逐字保住：只收紧，绝不开启', () => {
  assert.equal(effectiveAttachInlineLimit('deepseek', 0), 0, '配置 0 必须仍然关闭附件');
  assert.equal(effectiveAttachInlineLimit('deepseek', -1), 0);
  assert.equal(effectiveAttachInlineLimit('deepseek', NaN), 0);
  assert.equal(effectiveAttachInlineLimit('deepseek', undefined), 0);
});

test('未列出的站点逐字维持旧行为（能力边界：只改 deepseek）', () => {
  for (const site of ['glm', 'kimi', 'chatgpt', 'qwen', 'doubao', 'grok', 'gemini', 'zai', '', undefined]) {
    assert.equal(effectiveAttachInlineLimit(site, 60_000), 60_000, `${site} 不得被本次改动影响`);
  }
});

test('站点上限只做上限：配置值更小时取配置值（用户显式收紧优先）', () => {
  assert.equal(effectiveAttachInlineLimit('deepseek', 2_000), 2_000);
  assert.equal(effectiveAttachInlineLimit('deepseek', 60_000), SITE_ATTACH_INLINE_LIMIT.deepseek);
});
