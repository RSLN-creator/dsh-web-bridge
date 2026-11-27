// glm-attach-limit.test.mjs — GLM 必须留在**附件投递**路径上（0.19.41）。
//
// ## 真机事故（2026-09-27，本机 0.19.40）
//
// 一轮 **12,911 字符**的提示词在 chatglm.cn 上以
// `PROMPT_TRUNCATED: 网页输入框只接收了 12870/12911 字符（网页端长度上限）`
// 失败——用户报的「chatglm 老是失败」正是这一条。
//
// 根因不是输入框上限本身（那是站点的既定事实），而是**桥把长文判成了短消息**：
// 全站默认阈值 `attachInlineLimitChars = 60_000`，12,911 < 60,000 ⇒ `under-limit`
// ⇒ 走 inline ⇒ 灌进 chatglm 输入框 ⇒ 被站点静默截断。
//
// 而 `browser-driver.js` 里 `ATTACH_FORBIDDEN_SITES` 的注释（0.16.31 写）与
// `providers.js` 的 GLM 声明**早就把结论写死了**：
//
//   > 真正的站点差异（**GLM 输入框装不下长文**）仍然由各站点的**阈值**表达。
//   > 真机读数：GLM 的输入框装不下长文（用户原话「他在附件可以，输入框过长」），
//   > 所以它必须留在附件路径上。
//
// GLM 的 adapter 必须声明 `limits.attachInlineLimitChars = 8_000`；共享驱动只消费该值，
// 不再另维护 GLM 的站点 ID 映射。本护栏把这项事实及它对真实事故的作用钉成判据。
//
// ## 判据（三条，防的是三种不同的回归）
//
// ① **表里有 glm** —— 防「注释说要留、表里忘了写」再发生一次；
// ② 12,911 字符必须判成 `attach`（over-limit）——防阈值被调回大数字；
// ③ 用户显式关闭附件（配置 0）时仍一律 inline —— 防本次收紧顺手把开关强开。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SITE_ATTACH_INLINE_LIMIT,
  effectiveAttachInlineLimit,
  promptTransportPlan,
} from '../lib/browser-driver.js';

test('★ 0.19.41 GLM 的 adapter 必须声明实测附件阈值（共享驱动导出表由它派生）', () => {
  assert.ok(
    Number.isFinite(SITE_ATTACH_INLINE_LIMIT.glm) && SITE_ATTACH_INLINE_LIMIT.glm > 0,
    'glm 缺席就是 2026-09-27 PROMPT_TRUNCATED 事故的直接根因',
  );
  // 与 deepseek/kimi 同口径（8,000）：真实会话首轮普遍 ≥ 20k，收紧后全部走附件。
  assert.equal(SITE_ATTACH_INLINE_LIMIT.glm, 8_000);
});

test('★ 0.19.41 真机现场复算：12,911 字符必须判 attach，不得再判 inline', () => {
  // 用户真实配置：全站默认 60_000 + 站点级 promptTransportBySite.glm = 'attach'
  const limit = effectiveAttachInlineLimit('glm', 60_000);
  assert.equal(limit, 8_000, '站点上限必须收紧到 8,000');

  const plan = promptTransportPlan({
    chars: 12_911,          // 真机那一轮的字符数（逐字取自报错文本）
    inlineLimit: limit,
    attachEnabled: limit > 0,
    attachSupported: true,  // providers.js: glm 有 attachSelector
    attachForbidden: false,
    transport: 'attach',    // 设置面：promptTransportBySite.glm = 'attach'
  });
  assert.equal(plan.mode, 'attach', '修复前这里是 inline —— 那就是 PROMPT_TRUNCATED 的来源');
  assert.equal(plan.reason, 'over-limit');
  assert.equal(plan.payloadChars, 12_911, '附件路径不做截断（maxChars 未配置）');
  assert.equal(plan.truncate, false);
});

test('★ 0.19.41 对照：修复前的判据（阈值 60,000）确实会判 inline —— 证明这不是空转护栏', () => {
  const plan = promptTransportPlan({
    chars: 12_911,
    inlineLimit: 60_000,   // 修复前 glm 实际吃到的阈值
    attachEnabled: true,
    attachSupported: true,
    attachForbidden: false,
    transport: 'attach',
  });
  assert.equal(plan.mode, 'inline');
  assert.equal(plan.reason, 'under-limit');
});

test('★ 0.19.41 只收紧不开启：用户显式关闭附件（配置 0）仍一律 inline', () => {
  assert.equal(effectiveAttachInlineLimit('glm', 0), 0);
  const plan = promptTransportPlan({
    chars: 200_000,
    inlineLimit: effectiveAttachInlineLimit('glm', 0),
    attachEnabled: false,
    attachSupported: true,
    attachForbidden: false,
    transport: 'attach',
  });
  assert.equal(plan.mode, 'inline');
  assert.equal(plan.reason, 'attach-disabled');
});

test('★ 0.19.41 未列出的站点零位移：阈值逐字维持全站默认', () => {
  // 本次只加 glm 一行，其它站点（含 qwen/doubao/zai）必须与改动前逐字相同。
  assert.equal(effectiveAttachInlineLimit('qwen', 60_000), 60_000);
  assert.equal(effectiveAttachInlineLimit('doubao', 60_000), 60_000);
  assert.equal(effectiveAttachInlineLimit('zai', 60_000), 60_000);
  assert.equal(effectiveAttachInlineLimit('deepseek', 60_000), 8_000);
  assert.equal(effectiveAttachInlineLimit('kimi', 60_000), 8_000);
});
