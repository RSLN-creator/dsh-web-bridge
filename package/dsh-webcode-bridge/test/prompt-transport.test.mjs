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
import { promptTransportPlan, ATTACH_FORBIDDEN_SITES } from '../lib/browser-driver.js';

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

// ── ⑨ 站点级禁令（0.16.7）：DeepSeek 收得下附件但读不到它，必须永远走输入框 ──────

test('⑨ attachForbidden ⇒ 无论多长都 inline（DeepSeek 附件投递零回复的直接修法）', () => {
  // 真机 2026-09-18：71994 字符走附件（reason=over-limit）那一轮零回复。用户原话
  // 「deepseek以附件投递会出问题！不能回复！前面时候改为输入框还行！」。
  const plan = promptTransportPlan({
    chars: 71_994, inlineLimit: 60_000, attachEnabled: true, attachSupported: true, attachForbidden: true,
  });
  assert.equal(plan.mode, 'inline',
    '站点禁令没生效：' + plan.mode + '/' + plan.reason + '（DeepSeek 会走附件 ⇒ 用户报的零回复）');
  assert.equal(plan.reason, 'site-no-attach');
  assert.equal(plan.total, 71_994, 'inline 必须原样发全部字符（不能截断）');
  assert.equal(plan.payloadChars, 71_994);
  assert.equal(plan.truncate, false);
  // 更长的也一样：禁令与长度无关。
  const big = promptTransportPlan({ chars: 409_555, inlineLimit: 60_000, attachEnabled: true, attachSupported: true, attachForbidden: true });
  assert.equal(big.mode, 'inline');
});

test('⑨b 站点禁令不误伤别的站点：GLM 超阈值仍走附件（输入框装不下长文）', () => {
  const plan = promptTransportPlan({
    chars: 71_994, inlineLimit: 60_000, attachEnabled: true, attachSupported: true, attachForbidden: false,
  });
  assert.equal(plan.mode, 'attach');
  assert.equal(plan.reason, 'over-limit');
  // 集合本身是站点契约的唯一出处：deepseek 在内，glm 不在。
  assert.equal(ATTACH_FORBIDDEN_SITES.has('deepseek'), true);
  assert.equal(ATTACH_FORBIDDEN_SITES.has('glm'), false);
});

// ── ⑩ 禁令必须**可核对**（0.16.9）：站点禁令不能只存在于代码里 ──────────────────
//
// 0.16.7 加了 ATTACH_FORBIDDEN_SITES，但 `site-no-attach` 分支不写 attachTransport
// 读数、status 也不投影这个布尔量。后果是真机上「禁令生效没有」完全看不出来：
// 读数停在上一轮的旧值，而 attach-status 还在承诺「超 60000 字符改走附件」。
// 这条钉的是「禁令必须能从读数里看见」——只 warn 到控制台等于没有读数。
//
// ## 为什么这条是**行为**断言而不是源码 grep（2026-09-19 对抗验证的教训）
//
// 本用例最初写成 `fs.readFileSync(lib/browser-driver.js)` + `assert.match`。对抗验证
// 实测它是**弱护栏**：那条正则
//
//     /attachForbidden:\s*ATTACH_FORBIDDEN_SITES\.has\(siteId\)/
//
// 同时命中两处——`status()` 的投影，以及 `promptTransportPlan({ attachForbidden: … })`
// 的**入参**。于是只删掉 status 投影（或只删掉那行入参）时，另一处仍然满足正则，
// 用例**照样全绿**。它只证明了「这个子串在文件里存在过」，没法区分「status 暴露了
// 禁令」与「某个无关的调用传了这个开关」——而这正是本护栏要防的那件事。
// 现在改为**驱动真实代码**：构造驱动读 `status()`、调用真实 `attach-status` 动作。
test('⑩ 站点禁令必须可核对：status 投影带 attachForbidden，且 site-no-attach 会落读数', async () => {
  const path = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const pkg = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));

  // ① status() 必须**真的**把站点事实暴露出来（不是源码里有这个子串）。
  const bd = await import(pathToFileURL(path.join(pkg, 'lib', 'browser-driver.js')).href);
  const driver = bd.createBrowserDriver({
    siteId: 'deepseek',
    site: 'deepseek',
    profileDir: path.join(pkg, '.tmp', 'test10-profile'),
    logger: { log() {}, warn() {} },
    context: {},
  });
  assert.equal(typeof driver.status, 'function', '驱动必须可读 status()');
  const st = driver.status();
  assert.equal(st.attachForbidden, true,
    'status() 没有投影站点禁令（attachForbidden）⇒ 用户与面板都无法核对禁令是否生效');
  assert.equal(st.siteId, 'deepseek', 'status() 必须带上站点身份，否则读数无法归因');
  await driver.stop?.();

  // ② 禁令必须在判定层压过一切「想走附件」的输入——包括用户把设置面设成 attach。
  const plan = promptTransportPlan({
    chars: 999_999, inlineLimit: 60_000, attachEnabled: true, attachSupported: true,
    attachForbidden: true, transport: 'attach',
  });
  assert.equal(plan.mode, 'inline',
    '设置面能把禁站点拉回附件 ⇒ 禁令可被绕过（' + plan.mode + '/' + plan.reason + '）');

  // ③ 面板文案必须按站点事实陈述，且**不能**在禁站点上承诺附件投递。
  const wc = await import(pathToFileURL(path.join(pkg, 'lib', 'web-control.js')).href);
  const control = wc.createWebControl({
    driver: { status: () => st },
    relay: null,
    config: {},
    logger: { log() {}, warn() {}, error() {} },
  });
  const fn = control.actions['GET attach-status'];
  assert.equal(typeof fn, 'function', 'attach-status 动作必须存在');
  const forbidden = await fn({}, {});
  assert.match(String(forbidden.transportLine), /永不使用附件投递/,
    '面板仍在禁站点上承诺「超阈值改走附件」⇒ 面板与驱动互相矛盾');
  // 反例对照：非禁站点**不许**被这条文案误伤。
  const other = wc.createWebControl({
    driver: { status: () => ({ ...st, siteId: 'glm', attachForbidden: false }) },
    relay: null,
    config: {},
    logger: { log() {}, warn() {}, error() {} },
  });
  const glmOut = await other.actions['GET attach-status']({}, {});
  assert.doesNotMatch(String(glmOut.transportLine), /永不使用附件投递/,
    '站点禁令文案被套用到了非禁站点（GLM 需要附件投递）');
});
