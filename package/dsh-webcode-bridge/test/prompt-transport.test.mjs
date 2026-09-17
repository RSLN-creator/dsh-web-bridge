// prompt-transport.test.mjs — 超长提示词改走附件投递的判据（0.16.2）。
//
// ## 用户可见症状（用户原话）
//
// > 「然后是发送的纯文本太长了！看看怎么做到解决：通过文本发送文件发送过长内容，
// >  glm 和 deepsek，同样注意风险」
//
// ## 实测构成（GET /__webcode/preset，真机读数）
//
//   TOTAL 409,555
//     工具教学（preset）        38,241  ( 9.3%)
//     会话 transcript         370,985  (90.6%)   ← 其中 DSH 系统指令 279,223
//     传输协议                     329
//
// 这 40 万字符全部作为**纯文本**灌进网页输入框，而纯文本投递已经出过两次真机
// 事故：PROMPT_WRITE_STALLED（写入期间长度不增长）与 PROMPT_TRUNCATED（只收了半截）。
//
// ## 为什么默认必须关闭
//
// 附件投递是有副作用的动作（触发上传、可能撞站点风控、模型未必读附件），
// 因此 `attachInlineLimitChars` 默认 0 = 关闭：**没有真机配对数据之前，
// 默认行为与 0.16.1 逐字相同**。这组护栏钉的是「关闭时绝不改变行为」
// 与「开启后只有超限才走附件」两条。
//
// ## 反向验证纪律（doc/comment-style.md §9.3）
//
// ①②③ 是正向判据；④⑤⑥⑦⑧ 是反向安全线（默认关、阈值失效、入口缺失都要回落）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { promptTransportPlan } from '../lib/browser-driver.js';

/** 真机读数：这一轮实际发出去的首轮提示词长度。 */
const REAL_PROMPT_CHARS = 409_555;

// ── ① 默认关闭 ⇒ 永远 inline（这是最重要的一条）────────────────────────────

test('① 默认（attachEnabled 缺省）永远 inline，409,555 字符也不例外', () => {
  const plan = promptTransportPlan({ chars: REAL_PROMPT_CHARS });
  assert.equal(plan.mode, 'inline');
  assert.equal(plan.reason, 'attach-disabled');
});

// ── ② 开启后超阈值才走附件 ────────────────────────────────────────────────

test('② 开启且超阈值 ⇒ attach；未超 ⇒ inline', () => {
  const over = promptTransportPlan({ chars: REAL_PROMPT_CHARS, inlineLimit: 100_000, attachEnabled: true, attachSupported: true });
  assert.equal(over.mode, 'attach');
  assert.equal(over.reason, 'over-limit');
  // 边界是「大于」：恰好等于阈值仍走 inline（保守）。
  const at = promptTransportPlan({ chars: 100_000, inlineLimit: 100_000, attachEnabled: true, attachSupported: true });
  assert.equal(at.mode, 'inline');
  assert.equal(at.reason, 'under-limit');
  const under = promptTransportPlan({ chars: 99_999, inlineLimit: 100_000, attachEnabled: true, attachSupported: true });
  assert.equal(under.mode, 'inline');
});

// ── ③ 计划里带出可核对的读数 ──────────────────────────────────────────────

test('③ 返回 total/limit 供日志与界面核对', () => {
  const plan = promptTransportPlan({ chars: REAL_PROMPT_CHARS, inlineLimit: 100_000, attachEnabled: true, attachSupported: true });
  assert.equal(plan.total, REAL_PROMPT_CHARS);
  assert.equal(plan.limit, 100_000);
});

// ── ④ 反向安全线：页面没有上传入口 ⇒ 回落 inline ─────────────────────────

test('④ attachSupported=false ⇒ inline（哪怕开关开着、长度超了）', () => {
  const plan = promptTransportPlan({ chars: REAL_PROMPT_CHARS, inlineLimit: 1_000, attachEnabled: true, attachSupported: false });
  assert.equal(plan.mode, 'inline');
  assert.equal(plan.reason, 'no-attach-input');
});

// ── ⑤ 反向安全线：阈值非法 ⇒ 回落 inline ──────────────────────────────────

test('⑤ 阈值 0/负数/NaN ⇒ inline（配置错误等价于没配）', () => {
  for (const bad of [0, -1, Number.NaN, undefined, null, 'abc']) {
    const plan = promptTransportPlan({ chars: REAL_PROMPT_CHARS, inlineLimit: bad, attachEnabled: true, attachSupported: true });
    assert.equal(plan.mode, 'inline', 'inlineLimit=' + String(bad) + ' 应回落 inline');
  }
});

// ── ⑥ 反向安全线：字符数非法 ⇒ 按 0 处理（不因垃圾输入走附件）───────────────

test('⑥ chars 非法 ⇒ 视为 0，绝不走附件', () => {
  for (const bad of [undefined, null, Number.NaN, -5, 'x']) {
    const plan = promptTransportPlan({ chars: bad, inlineLimit: 1_000, attachEnabled: true, attachSupported: true });
    assert.equal(plan.mode, 'inline', 'chars=' + String(bad) + ' 应回落 inline');
  }
});

// ── ⑦ 反向安全线：无参调用不抛错 ──────────────────────────────────────────

test('⑦ 无参调用返回 inline（默认安全）', () => {
  const plan = promptTransportPlan();
  assert.equal(plan.mode, 'inline');
  assert.equal(plan.total, 0);
});

// ── ⑧ 反向安全线：阈值取整，不出现小数块 ──────────────────────────────────

test('⑧ 小数阈值向下取整；小数长度也取整', () => {
  const plan = promptTransportPlan({ chars: 1000.9, inlineLimit: 1000.9, attachEnabled: true, attachSupported: true });
  assert.equal(plan.limit, 1000);
  assert.equal(plan.total, 1000);
  assert.equal(plan.mode, 'inline');
});
