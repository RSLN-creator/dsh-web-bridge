// site-attach-limit.test.mjs — 0.19.11 护栏：站点级附件阈值收紧。
//
// 真机病因（2026-09-24）：全站默认 attachInlineLimitChars = 60_000，而 webcode
// 路由的**典型首轮**实测 48,937 / 53,797 字符（navTrace 的 messageChars）——
// 低于阈值 ⇒ under-limit ⇒ 全文逐字灌进输入框。用户原话：「明明在附件投递模式下，
// 看的还是完整上下文」。越典型的会话越走 inline，这就是病根。
//
// 修法：将实测上限放在 deepseek / kimi / glm 各自 adapter 的 limits 声明中；**只收紧不开启**。

import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveAttachInlineLimit, SITE_ATTACH_INLINE_LIMIT, SITE_COMPOSER_HARD_LIMIT, composerHardLimitFor } from '../lib/browser-driver.js';
import { SITES } from '../lib/providers.js';

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

test('kimi 的站点上限同样收紧（2026-09-25：38,807 字符轮被输入框静默截断）', () => {
  const limit = effectiveAttachInlineLimit('kimi', 60_000);
  assert.ok(limit < 20_000, `kimi 输入框实测上限 ~20K，阈值必须低于它（当前 ${limit}）`);
  assert.ok(limit < 38_807, '事故轮 38,807 字符必须走附件');
  assert.equal(limit, SITE_ATTACH_INLINE_LIMIT.kimi);
});

test('未列出的站点逐字维持旧行为（能力边界：只改 deepseek / kimi / glm）', () => {
  // glm 于 0.19.41 从本组**移出**（它当时就在这一行里，正是缺口本身）：
  // 真机 2026-09-27，一轮 12,911 字符的提示词在 chatglm.cn 上以
  // `PROMPT_TRUNCATED: 网页输入框只接收了 12870/12911 字符` 失败——
  // 60,000 的全站默认把长文判成 under-limit ⇒ inline ⇒ 撞输入框上限。
  // GLM 的专属护栏见 test/glm-attach-limit.test.mjs。
  for (const site of ['chatgpt', 'qwen', 'doubao', 'grok', 'gemini', 'zai', '', undefined]) {
    assert.equal(effectiveAttachInlineLimit(site, 60_000), 60_000, `${site} 不得被本次改动影响`);
  }
  // glm 现在必须被收紧（与 deepseek/kimi 同口径），不再是「未列出的站点」。
  assert.equal(effectiveAttachInlineLimit('glm', 60_000), 8_000);
});

test('站点上限只做上限：配置值更小时取配置值（用户显式收紧优先）', () => {
  assert.equal(effectiveAttachInlineLimit('deepseek', 2_000), 2_000);
  assert.equal(effectiveAttachInlineLimit('deepseek', 60_000), SITE_ATTACH_INLINE_LIMIT.deepseek);
});

test('兼容导出表严格派生自 adapter limits（不得维护第二张站点 ID 表）', () => {
  const expectedInline = Object.fromEntries(SITES
    .filter((site) => Number.isSafeInteger(site.limits?.attachInlineLimitChars))
    .map((site) => [site.id, site.limits.attachInlineLimitChars]));
  const expectedHard = Object.fromEntries(SITES
    .filter((site) => Number.isSafeInteger(site.limits?.composerHardLimitChars))
    .map((site) => [site.id, site.limits.composerHardLimitChars]));

  assert.deepEqual(expectedInline, { deepseek: 8_000, glm: 8_000, kimi: 8_000 });
  assert.deepEqual(expectedHard, { kimi: 200_000 });
  assert.deepEqual(SITE_ATTACH_INLINE_LIMIT, expectedInline);
  assert.deepEqual(SITE_COMPOSER_HARD_LIMIT, expectedHard);
});

test('Kimi 纯文本硬上限来自 adapter；其它站点维持无底线', () => {
  assert.equal(composerHardLimitFor('kimi'), 200_000);
  assert.equal(composerHardLimitFor('deepseek'), null);
  assert.equal(composerHardLimitFor('glm'), null);
  assert.equal(composerHardLimitFor('qwen'), null);
});
