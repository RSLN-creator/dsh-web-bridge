// prompt-transport-attach.test.mjs — 附件投递的**上限**判据：maxChars / truncate / payloadChars（0.16.3）。
//
// ## 这个文件补的是哪一段
//
// test/prompt-transport.test.mjs（0.16.2）钉的是「要不要改走附件」——默认关、只有超阈值才
// attach、页面没有上传入口就回落 inline。本文件钉的是它之后新加的一层：**附件自己也有上限**。
//
// 为什么需要这一层：判定「改走附件」只解决了输入框，附件本身还要过网页的上传与模型读取。
// 把整份 40 万级字符塞进去，是拿上传/风控换输入框，不是解决问题。因此 `chars > maxChars`
// 时 **mode 不变**（仍是 attach），只多出 `truncate:true` 与 `kept`——截断是**投递层**的事，
// 不是判定层的事（保留哪个方向由调用点决定：见 runTurn，保尾部）。
//
// ## 数字的口径（doc/comment-style.md §5：写进断言的数字必须可核对）
//
//   · 1_500_000 —— 默认上限。它不是网页的实测上限，而是「真机已知最大 409,555 字符
//     （`GET /__webcode/preset` 的 promptChars）的约 3.7 倍」这个余量的落点；
//   · 409,555 —— 真机 `GET /__webcode/preset` 读数（0.16.2 台账 §四）；
//   · 127,888 —— 真机失败会话里发进网页的纯文本（`POST /__webcode/history` 的 user 消息：
//     工具教学 38,279 + 会话 transcript 89,609）。两个真机读数都必须**离上限很远**：
//     上限是用来兜「上下文失控」的，不该在正常轮次上开火。
//
// ## 反向验证纪律（doc/comment-style.md §9.3）
//
// ①②③ 是正向判据；④ 是**最重要的一条安全线**：maxChars 只影响「上传多少」，绝不能影响
// 「走不走附件」——把上限写进 mode 判据（例如超上限就回落 inline）会让 ④ 变红；⑤ 钉住
// 0.16.2 的三条既有判据逐字未变；⑥ 是「正常轮次不得被截断」的安全线。
import test from 'node:test';
import assert from 'node:assert/strict';
import { promptTransportPlan } from '../lib/browser-driver.js';

/** 真机读数：`GET /__webcode/preset` 的 promptChars（0.16.2 台账）。 */
const REAL_PRESET_CHARS = 409_555;
/** 真机读数：失败会话里发进网页的纯文本（工具教学 38,279 + 会话 transcript 89,609）。 */
const REAL_SENT_CHARS = 127_888;
/** 默认上限：`chars > maxChars` 才截断。 */
const DEFAULT_MAX = 1_500_000;

/** 附件投递**已开启且页面有入口**的基准入参（只替换被测字段）。 */
const attachable = (extra) => ({ inlineLimit: 100_000, attachEnabled: true, attachSupported: true, ...extra });

// ── ① 默认上限 ───────────────────────────────────────────────────────────────

test('① 不传 maxChars ⇒ 默认 1_500_000；超它则 truncate/payloadChars/kept 一起落到上限', () => {
  const plan = promptTransportPlan(attachable({ chars: 2_000_000 }));
  assert.equal(plan.maxChars, DEFAULT_MAX, 'maxChars 默认值不是 ' + DEFAULT_MAX + '（实际 ' + plan.maxChars + '）');
  assert.equal(plan.mode, 'attach', '超上限不该改变投递方式：仍走附件');
  assert.equal(plan.reason, 'over-limit', 'reason 仍应是「超阈值」而不是换一个新的');
  assert.equal(plan.truncate, true, 'chars > maxChars 必须标 truncate=true，否则调用点会静默上传 200 万字符');
  assert.equal(plan.kept, DEFAULT_MAX, 'kept 应是保留的字符数（= 上限）');
  assert.equal(plan.payloadChars, DEFAULT_MAX, 'payloadChars 应是真正会上传的字符数（= 上限）');
  assert.equal(plan.total, 2_000_000, 'total 必须仍是原始长度，日志要靠它算出「省略了多少」');
});

test('①b 未超上限 ⇒ 不截断（真机两个读数都离上限很远）', () => {
  for (const chars of [REAL_PRESET_CHARS, REAL_SENT_CHARS]) {
    const plan = promptTransportPlan(attachable({ chars }));
    assert.equal(plan.truncate, false, chars + ' 字符被标成需要截断：正常轮次不该被砍');
    assert.equal(plan.kept, null, '不截断时 kept 必须是 null（不是数字 0，也不是原长度）');
    assert.equal(plan.payloadChars, chars, '不截断时 payloadChars 就是原长度');
  }
});

// ── ② 边界语义：大于才截断 ───────────────────────────────────────────────────

test('② 边界是「大于」：恰好等于上限不截断，多一个字符才截断', () => {
  const at = promptTransportPlan(attachable({ chars: DEFAULT_MAX }));
  assert.equal(at.truncate, false, 'chars === maxChars 不该截断（边界保守，与 inlineLimit 的语义一致）');
  assert.equal(at.payloadChars, DEFAULT_MAX, '恰好等于上限时 payloadChars = 原长度');
  const over = promptTransportPlan(attachable({ chars: DEFAULT_MAX + 1 }));
  assert.equal(over.truncate, true, 'chars = maxChars + 1 必须截断');
  assert.equal(over.payloadChars, DEFAULT_MAX, '截断后 payloadChars 落到上限');
  assert.equal(over.kept, DEFAULT_MAX, 'kept 是保留字符数');
});

// ── ③ 非法 maxChars = 不设上限（配置写错不许砍消息）─────────────────────────

test('③ 非法 maxChars（0/-1/NaN/"x"/null）⇒ 视为不设上限，绝不截断', () => {
  for (const bad of [0, -1, Number.NaN, 'x', null]) {
    const plan = promptTransportPlan(attachable({ chars: 2_000_000, maxChars: bad }));
    assert.equal(plan.maxChars, null,
      'maxChars=' + String(bad) + ' 应视为不设上限（maxChars=null），实际 ' + String(plan.maxChars));
    assert.equal(plan.truncate, false,
      'maxChars=' + String(bad) + ' 不该触发截断：配置写错只许退化成旧行为，'
      + '不许把这一轮的消息悄悄砍成半截');
    assert.equal(plan.payloadChars, 2_000_000, 'maxChars=' + String(bad) + ' 时 payloadChars 应是原长度');
    assert.equal(plan.kept, null, 'maxChars=' + String(bad) + ' 时 kept 必须是 null');
  }
});

// ── ④ 安全线：上限不得影响「走不走附件」────────────────────────────────────

test('④ 安全线：maxChars 只影响上传多少，绝不改变 mode/reason/limit/total', () => {
  const base = attachable({ chars: 2_000_000 });
  const variants = [undefined, 0, 500_000, 1_500_000, 2_000_000, 2_000_001, 10_000_000, Number.NaN, 'x'];
  for (const maxChars of variants) {
    const plan = promptTransportPlan(maxChars === undefined ? base : { ...base, maxChars });
    assert.equal(plan.mode, 'attach',
      'maxChars=' + String(maxChars) + ' 把投递方式改成了 ' + plan.mode
      + '：上限是**投递层**的事，判定层只回答「超没超 inline 阈值」');
    assert.equal(plan.reason, 'over-limit', 'maxChars=' + String(maxChars) + ' 改动了 reason');
    assert.equal(plan.limit, 100_000, 'maxChars=' + String(maxChars) + ' 改动了 inlineLimit 口径');
    assert.equal(plan.total, 2_000_000, 'maxChars=' + String(maxChars) + ' 改动了 total');
    assert.ok(plan.payloadChars <= plan.total, 'payloadChars 不得大于 total（上传的字符不可能比原文多）');
    assert.ok(plan.payloadChars > 0, 'payloadChars 不得为 0：空附件等于把上下文整段丢掉');
  }
});

// ── ⑤ 既有 mode 判据不受影响（0.16.2 的三条线逐字未变）──────────────────────

test('⑤ 既有 mode 判据不受影响：默认关 / 超阈值才 attach / 无入口回落 inline', () => {
  // 刻意用**未超上限**的长度（409,555 < 1,500,000）来看 inline 分支：这一分支上
  // truncate/payloadChars 的语义还没有定论（inline 并不上传、也不截断，而实现目前仍按
  // 「若走附件会怎样」算）。本文件不把那个歧义钉成判据——它记在随本轮提交的报告里。
  const disabled = promptTransportPlan({ chars: REAL_PRESET_CHARS });
  assert.equal(disabled.mode, 'inline', '默认（attachEnabled 缺省）必须仍走 inline');
  assert.equal(disabled.reason, 'attach-disabled', '默认关闭的 reason 必须仍是 attach-disabled');
  assert.equal(disabled.payloadChars, REAL_PRESET_CHARS, 'inline 时 payloadChars 必须反映真正发出去的字符数');
  assert.equal(disabled.truncate, false, 'inline 且未超上限时不得标 truncate');

  const disabledBig = promptTransportPlan({ chars: 2_000_000 });
  assert.equal(disabledBig.mode, 'inline', '默认关闭时，超长也仍然是 inline（既有判据逐字未变）');
  assert.equal(disabledBig.reason, 'attach-disabled');

  const over = promptTransportPlan(attachable({ chars: REAL_PRESET_CHARS }));
  assert.equal(over.mode, 'attach', '真机 409,555 字符在 100,000 阈值下必须走附件');
  assert.equal(over.reason, 'over-limit');

  const under = promptTransportPlan(attachable({ chars: 99_999 }));
  assert.equal(under.mode, 'inline', '未超阈值必须仍走 inline');
  assert.equal(under.reason, 'under-limit', '未超阈值的 reason 必须仍是 under-limit');

  const noInput = promptTransportPlan(attachable({ chars: REAL_PRESET_CHARS, attachSupported: false }));
  assert.equal(noInput.mode, 'inline', '页面没有上传入口时必须回落 inline');
  assert.equal(noInput.reason, 'no-attach-input', '无入口的 reason 必须仍是 no-attach-input');

  const noLimit = promptTransportPlan({ chars: REAL_PRESET_CHARS, inlineLimit: 0, attachEnabled: true, attachSupported: true });
  assert.equal(noLimit.mode, 'inline', 'inlineLimit 非法（=0）时必须回落 inline');
  assert.equal(noLimit.reason, 'no-limit', '阈值非法的 reason 必须仍是 no-limit');
});

// ── ⑥ 安全线：正常轮次不得被截断 ────────────────────────────────────────────

test('⑥ 安全线：真机的 409,555 与 127,888 字符都不触发截断（上限是兜上下文失控的）', () => {
  const preset = promptTransportPlan(attachable({ chars: REAL_PRESET_CHARS }));
  assert.equal(preset.truncate, false, '真机最大读数 409,555 字符被截断了——上限过低，正常轮次会被砍');
  assert.equal(preset.payloadChars, REAL_PRESET_CHARS, '真机读数必须整段上传');
  // 真机最大读数离默认上限还有约 3.7 倍余量：这个比值就是「什么时候才该怀疑上下文失控」的口径。
  assert.ok(DEFAULT_MAX > REAL_PRESET_CHARS * 3,
    '默认上限 ' + DEFAULT_MAX + ' 与真机最大读数 ' + REAL_PRESET_CHARS + ' 之间已不足 3 倍余量');
});

// ── ⑦ 字段形状：四个新字段在任何分支上都必须存在 ────────────────────────────

test('⑦ 任何分支的返回值都带齐 payloadChars / truncate / kept / maxChars（调用点要能无条件读）', () => {
  const plans = [
    promptTransportPlan(),
    promptTransportPlan({ chars: 1 }),
    promptTransportPlan(attachable({ chars: REAL_PRESET_CHARS })),
    promptTransportPlan(attachable({ chars: 2_000_000, maxChars: 0 })),
  ];
  for (const [i, plan] of plans.entries()) {
    for (const key of ['payloadChars', 'truncate', 'kept', 'maxChars']) {
      assert.ok(key in plan, '第 ' + i + ' 个返回里缺字段 ' + key + '：调用点会读到 undefined');
    }
    assert.equal(typeof plan.truncate, 'boolean', '第 ' + i + ' 个返回的 truncate 不是布尔值');
    assert.equal(typeof plan.payloadChars, 'number', '第 ' + i + ' 个返回的 payloadChars 不是数字');
  }
});

// ── ⑧ 取整口径：不出现小数字符块 ────────────────────────────────────────────

test('⑧ 小数上限向下取整；小数长度也取整（与既有 ⑧ 的 limit/total 口径一致）', () => {
  const plan = promptTransportPlan(attachable({ chars: 1000.9, maxChars: 1000.9 }));
  assert.equal(plan.maxChars, 1000, 'maxChars 应向下取整');
  assert.equal(plan.total, 1000, 'total 应向下取整');
  assert.equal(plan.payloadChars, 1000, 'payloadChars 应是取整后的字符数');
});
