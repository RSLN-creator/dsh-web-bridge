// idle-window.test.mjs — 看门狗窗口必须**分相位**：把「网页还没开口」与「网页不说了」分开（0.16.3）。
//
// ## 这个纯函数钉的是哪一次真机事故
//
// 2026-09-17 18:39-18:43，会话 `session-dff3edf7`：桥把 **127,888 字符**纯文本一次性贴进
// DeepSeek 网页输入框（`POST /__webcode/history` 的 user 消息读数：工具教学 38,279 +
// 会话 transcript 89,609）。该轮 turn1 的 step5 从 18:41:59 到 18:43:51 **跨度 112 秒
// 零事件**，适配器侧 120s 看门狗开火，用户看到的就是那句
//
//   WEB_NO_PROGRESS: 网页侧超过 120s 没有任何新内容（页面在，本轮收束原因 finished）
//
// ——但同一轮 step1-4 **每一步都有事件**（工具调用 2-4 条），说明捕获链是活的：不是链路坏，
// 是网页还在 prefill 那 12.8 万字符，**还没吐第一个 token**。旧实现用同一把尺子量了两个
// 完全不同的阶段。
//
// ## 判据（接线级用例在同目录的 watchdog-first-byte.test.mjs，本文件只钉纯函数）
//
//   · 首个事件**已到**（mid-stream）→ 常规窗口，**不给宽限**；
//   · 首个事件**未到** + 驱动报告本轮仍在忙 → 常规窗口 × 倍数（默认 2 ⇒ 120s → 240s），
//     phase 记 `awaiting-first-byte`，让下一次事故的超时文案能自证是哪个相位；
//   · 首个事件**未到** + 驱动**不忙**（捕获链没跑起来）→ 常规窗口，**同样不给宽限**：
//     链路已经死了还给宽限，只会把故障从 120s 拖到 240s 才暴露，比旧行为更糟。
//
// ## 反向验证纪律（doc/comment-style.md §9.3）
//
// ②③ ④ 是反向安全线，分别钉住三种「看起来更省事」的错误修法：
//   · ② 给已经开流的轮次也乘倍数（改成「一律乘倍数」即红）；
//   · ③ 驱动不忙时也乘倍数（改成「不看 busy」即红）；
//   · ④ 用真值判断 firstEventAt（`if (!firstEventAt)`），于是 0 被当成「还没开口」——
//     而 0 是一个**合法的**时刻（epoch 0），这条判据必须按「已到」处理。
//
// ## ⑧ 是 0.16.3 的接口扩展：相位窗口必须给「驱动整轮预算」留余量
//
// 宽限后的相位窗口（120s × 2 = 240s）与驱动**整轮**预算 `requestTimeoutMs`（默认 240s）
// 同值 ⇒ 谁先开火由事件循环决定；而整轮超时那句报错没有相位、没有页面现场。于是本轮要修的
// 那次真机事故（网页在 prefill 12.8 万字符）会被整轮超时先杀掉，报错从 `WEB_NO_PROGRESS`
// 变成 `web turn timed out`——修了等于没修。因此新增 `totalBudgetMs`：只对
// `awaiting-first-byte` 相位的窗口设上限（留 10% 余量），被压过就置 `capped:true`。
// ⑧b/⑧c/⑧d 是它的安全线：不传预算时逐字回到旧行为、mid-stream 永不压缩、极端小预算
// 宁可按常规窗口快报也不给出「比常规窗口还长的宽限」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { idleWindowDecision } from '../lib/idle-window.js';

/** 真机默认值：适配器侧看门狗 IDLE_TIMEOUT_MS = 120_000（lib/index.js 的 cfg.idleTimeoutMs）。 */
const BASE = 120_000;

/** 本轮**首个**事件从未到达（调用方在自己这一轮的闭包里保留 null）。只有显式 null 算「还没开口」。 */
const NO_FIRST_EVENT = null;

// ── ① 正向：首字节相位的宽限（这就是真机事故的修法）──────────────────────────

test('① 首个事件未到 + 驱动在忙 ⇒ 窗口 ×2、相位 awaiting-first-byte（真机默认 120s → 240s）', () => {
  const r = idleWindowDecision({ baseMs: BASE, firstEventAt: NO_FIRST_EVENT, driverBusy: true });
  assert.equal(r.windowMs, 240_000,
    '默认倍数 2 没生效：窗口是 ' + r.windowMs + 'ms。12.8 万字符输入的 prefill 必然超过 120s，'
    + '这正是真机事故里那一轮被误杀的原因');
  assert.equal(r.phase, 'awaiting-first-byte',
    '相位名必须是 awaiting-first-byte：超时文案要靠它自证「等的是网页开口，不是网页卡住」');
});

// ── ② 反向安全线（最重要的一条）：已经开流就不许宽限 ────────────────────────

test('② 首个事件已到 ⇒ 常规窗口，即便驱动仍在忙也不宽限', () => {
  const r = idleWindowDecision({ baseMs: BASE, firstEventAt: Date.now(), driverBusy: true });
  assert.equal(r.windowMs, BASE,
    '已经开流的轮次被宽限成 ' + r.windowMs + 'ms：开流之后静默就是「卡住」，'
    + '宽限只会让真卡死晚 120s 才报——这一条是本次改动的安全线，不许为了「少报错」把它放宽');
  assert.equal(r.phase, 'mid-stream', '已开流的相位必须是 mid-stream');
});

test('②b 反向安全线：firstEventAt=0（合法时刻）必须按「已到」处理，不得当成没到', () => {
  // 0 是 falsy 但合法：用 `if (!firstEventAt)` 判「还没开口」的实现会把它判成未到，
  // 于是**已经开流的轮次被乘了倍数**——安全线就是这样被一行「顺手简化」放掉的。
  const r = idleWindowDecision({ baseMs: BASE, firstEventAt: 0, driverBusy: true });
  assert.equal(r.phase, 'mid-stream',
    'firstEventAt=0 被判成「还没开口」：这是真值判断的经典坑（0 是合法时刻），'
    + '会让已经开流的轮次拿到宽限');
  assert.equal(r.windowMs, BASE, 'firstEventAt=0 时窗口应是常规值');
});

// ── ③ 反向安全线：链路没跑起来不许宽限 ─────────────────────────────────────

test('③ 首个事件未到但驱动不忙（false/null/undefined）⇒ 常规窗口、相位 mid-stream', () => {
  for (const busy of [false, null, undefined]) {
    const r = idleWindowDecision({ baseMs: BASE, firstEventAt: NO_FIRST_EVENT, driverBusy: busy });
    assert.equal(r.windowMs, BASE,
      'driverBusy=' + String(busy) + ' 时窗口被放宽到 ' + r.windowMs + 'ms：'
      + '驱动不在忙说明捕获链根本没跑起来，等更久只会更晚发现');
    assert.equal(r.phase, 'mid-stream',
      'driverBusy=' + String(busy) + ' 的相位应是 mid-stream（不得报 awaiting-first-byte）');
  }
});

test('③b 反向安全线：firstEventAt=undefined（忘传参数）⇒ 按「已到」处理，宁快不快宽', () => {
  // 接口约定只有**显式 null** 才算「还没开口」。忘传参数时若按「未到」处理，等于让一个
  // 漏掉的字段把安全线从 120s 悄悄拉成 240s。
  const r = idleWindowDecision({ baseMs: BASE, driverBusy: true });
  assert.equal(r.phase, 'mid-stream', 'firstEventAt 缺省时被当成了「还没开口」：安全线被静默放宽');
  assert.equal(r.windowMs, BASE, 'firstEventAt 缺省时应是常规窗口');
});

// ── ④ 非法入参必须回落到安全值 ─────────────────────────────────────────────

test('④ baseMs 非法（0/-1/NaN/undefined/"x"）⇒ 回落到基础值 120000', () => {
  for (const bad of [0, -1, Number.NaN, undefined, 'x']) {
    // 用「首个事件已到」隔离出基础值回落本身：此时相位是 mid-stream，窗口 = 基础值，不乘倍数。
    const r = idleWindowDecision({ baseMs: bad, firstEventAt: 0, driverBusy: true });
    assert.equal(r.windowMs, 120_000,
      'baseMs=' + String(bad) + ' 应回落到 120000，实际 ' + r.windowMs
      + '（NaN 会被 setTimeout 当成 0 ⇒ 每轮立刻判死；0/负数同理。0 尤其危险：'
      + '它不是「一个很小的窗口」，而是一个错误配置，语义上等价于没配）');
  }
});

test('④b 回落的是**基础值**而不是最终窗口：相位规则仍然生效', () => {
  // baseMs 写错时只许退化成「旧行为的 120s 基础值」，不许连相位宽限一起丢掉：
  // 12.8 万字符的 prefill 与配置写错是两件事，前者不该因为后者被误杀。
  const r = idleWindowDecision({ baseMs: 0, firstEventAt: NO_FIRST_EVENT, driverBusy: true });
  assert.equal(r.windowMs, 240_000,
    'baseMs 非法时窗口是 ' + r.windowMs + 'ms（应为回落基础值 120000 × 2）：'
    + '「回落」的语义是基础值回落，不是把首字节相位的宽限一起取消');
  assert.equal(r.phase, 'awaiting-first-byte', 'baseMs 非法不改变相位判定');
});

test('⑤ multiplier 非法（0/-1/NaN/"x"）⇒ 乘 1（等于不做任何放宽）', () => {
  for (const bad of [0, -1, Number.NaN, 'x']) {
    const r = idleWindowDecision({ baseMs: BASE, firstEventAt: NO_FIRST_EVENT, driverBusy: true, multiplier: bad });
    assert.equal(r.windowMs, BASE,
      'multiplier=' + String(bad) + ' 应等价于 1（窗口 ' + BASE + 'ms），实际 ' + r.windowMs
      + '：配置写错时只许退化成旧行为，不许把窗口放大或缩到 0');
    assert.equal(r.phase, 'awaiting-first-byte', '非法倍数不改变相位判定');
  }
});

test('⑤b multiplier=1 ⇒ 逐字恢复旧行为（用户想关掉宽限时应拿到 120s）', () => {
  const r = idleWindowDecision({ baseMs: BASE, firstEventAt: NO_FIRST_EVENT, driverBusy: true, multiplier: 1 });
  assert.equal(r.windowMs, BASE, 'multiplier=1 必须等于常规窗口');
});

// ── ⑥ 无参调用：不许抛错，且必须给安全默认 ──────────────────────────────────

test('⑥ 无参调用不抛错，回落 120000 / mid-stream', () => {
  let r;
  assert.doesNotThrow(() => { r = idleWindowDecision(); }, '无参调用抛错了');
  assert.equal(r.windowMs, 120_000, '无参调用应回落 120000');
  assert.equal(r.phase, 'mid-stream', '无参调用应回落 mid-stream（不给自己发宽限）');

  let r2;
  assert.doesNotThrow(() => { r2 = idleWindowDecision({}); }, '空对象调用抛错了');
  assert.equal(r2.windowMs, 120_000, '空对象调用应回落 120000');
  assert.equal(r2.phase, 'mid-stream', '空对象调用应回落 mid-stream');
});

// ── ⑦ 返回值必须能直接进 setTimeout ────────────────────────────────────────

test('⑦ windowMs 恒为正的有限整数；phase 只有两个取值', () => {
  const inputs = [
    {},
    { baseMs: BASE, firstEventAt: null, driverBusy: true },
    { baseMs: 1000, firstEventAt: null, driverBusy: true, multiplier: 1.5 },
    { baseMs: Number.POSITIVE_INFINITY, firstEventAt: null, driverBusy: true },
    { baseMs: BASE, firstEventAt: null, driverBusy: true, multiplier: Number.POSITIVE_INFINITY },
    // 倍数小于 1 也是合法输入（用户可以把宽限调小）。接线点保证 baseMs ≥ 3500
    // （lib/index.js：`Math.max(WIP_IDLE_MS + 1000, cfg.idleTimeoutMs)`），所以这里取真实下界口径。
    { baseMs: 3_500, firstEventAt: null, driverBusy: true, multiplier: 0.5 },
  ];
  for (const input of inputs) {
    const r = idleWindowDecision(input);
    assert.ok(Number.isFinite(r.windowMs) && r.windowMs > 0,
      'windowMs 不是正有限数（' + String(r.windowMs) + '），输入 ' + JSON.stringify(input)
      + '：Infinity ⇒ 看门狗永不超时，NaN ⇒ setTimeout 当成 0 立刻判死');
    assert.ok(Number.isInteger(r.windowMs),
      'windowMs 不是整数（' + String(r.windowMs) + '）：倍数是 Math.round 出来的，不该出现小数');
    assert.ok(r.phase === 'mid-stream' || r.phase === 'awaiting-first-byte',
      'phase 出现了未定义取值：' + String(r.phase));
  }
});

test('⑦b 倍数如实生效且按 Math.round（1000 × 1.5 = 1500，不凭空少给）', () => {
  const r = idleWindowDecision({ baseMs: 1000, firstEventAt: NO_FIRST_EVENT, driverBusy: true, multiplier: 1.5 });
  assert.equal(r.windowMs, 1500, '倍数没有如实相乘（实际 ' + r.windowMs + 'ms）');
  const up = idleWindowDecision({ baseMs: 1001, firstEventAt: NO_FIRST_EVENT, driverBusy: true, multiplier: 1.5 });
  assert.equal(up.windowMs, 1502, 'Math.round 没生效（1001 × 1.5 = 1501.5 → 1502），实际 ' + up.windowMs);
});

// ── ⑧ 0.16.3 扩展：相位窗口必须给「驱动整轮预算」留余量（capped）──────────────
//
// ## 来由（真问题，不是加功能）
//
// 宽限后的相位窗口是 `120s × 2 = 240s`，而驱动**整轮**总超时 `requestTimeoutMs`
// 默认也是 **240s**——两者同值 ⇒ 谁先开火由事件循环决定。而驱动整轮超时那句报错
// **丢掉页面现场**（没有相位、没有「页面已有 N 字回复未回传」）。更糟的是：本轮要修
// 的那次真机事故（网页在 prefill 12.8 万字符）会被整轮超时先杀掉，报错从
// `WEB_NO_PROGRESS` 变成 `web turn timed out`——修了等于没修。
//
// 因此 `totalBudgetMs`（驱动整轮预算）对 `awaiting-first-byte` 相位的窗口设**上限**：
// `reserve = max(1000, round(budget × 10%))`、`ceiling = budget - reserve`，窗口取
// `min(wanted, ceiling)`，被压过就置 `capped:true` 让调用方与日志看得出「这是被预算
// 压过的窗口」而不是配置写错。余量必须**严格大于零**：同值就是上面那条赛跑。

test('⑧ 默认组合：240s 的相位窗口被整轮预算压到 216s，且严格小于预算', () => {
  const r = idleWindowDecision({
    baseMs: BASE, firstEventAt: NO_FIRST_EVENT, driverBusy: true, multiplier: 2, totalBudgetMs: 240_000,
  });
  assert.equal(r.windowMs, 216_000,
    '窗口不是 216000ms（实际 ' + r.windowMs + '）：240000 − max(1000, 240000×10% = 24000) 才是'
    + '留给整轮超时的余量，否则两者的 deadline 同值、谁先开火由事件循环决定');
  assert.equal(r.phase, 'awaiting-first-byte', '相位判定不该被 totalBudgetMs 改变');
  assert.equal(r.capped, true, 'capped 必须是 true：日志要能看出这个窗口是被整轮预算压过的');
  assert.ok(r.windowMs < 240_000,
    '相位窗口（' + r.windowMs + 'ms）必须**严格小于**整轮预算 240000ms：'
    + '同值就是赛跑，信息量最少的那个报错会先到，页面现场就丢了');
});

test('⑧b totalBudgetMs 缺省或非法（0/-1/NaN/"x"）⇒ 与旧行为逐字相同：不设上限、capped:false', () => {
  for (const bad of [undefined, 0, -1, Number.NaN, 'x']) {
    const r = idleWindowDecision({
      baseMs: BASE, firstEventAt: NO_FIRST_EVENT, driverBusy: true, multiplier: 2, totalBudgetMs: bad,
    });
    assert.equal(r.windowMs, 240_000,
      'totalBudgetMs=' + String(bad) + ' 时窗口应是 240000（纯函数不依赖预算），实际 ' + r.windowMs);
    assert.equal(r.capped, false, 'totalBudgetMs=' + String(bad) + ' 时 capped 必须是 false（没有上限可言）');
    assert.equal(r.phase, 'awaiting-first-byte', 'totalBudgetMs=' + String(bad) + ' 不该改变相位');
  }
});

test('⑧c mid-stream 相位永远不受 totalBudgetMs 影响，capped 恒 false', () => {
  // 已经开流就该快报：预算再小也不许把常规窗口压短（压短＝把正常的长回复判死）。
  for (const budget of [undefined, 0, 1_000, 60_000, 240_000, 1_200]) {
    const r = idleWindowDecision({ baseMs: BASE, firstEventAt: 0, driverBusy: true, totalBudgetMs: budget });
    assert.equal(r.windowMs, BASE,
      'totalBudgetMs=' + String(budget) + ' 改动了 mid-stream 的窗口（实际 ' + r.windowMs + '）');
    assert.equal(r.phase, 'mid-stream');
    assert.equal(r.capped, false, 'mid-stream 不存在「被预算压过」这回事，capped 必须恒 false');
  }
  // 驱动不忙时也走 mid-stream 那一支：同样不许被预算压短。
  const idle = idleWindowDecision({ baseMs: BASE, firstEventAt: NO_FIRST_EVENT, driverBusy: false, totalBudgetMs: 1_000 });
  assert.equal(idle.windowMs, BASE, '驱动不忙时窗口被 totalBudgetMs 改动了：' + idle.windowMs);
  assert.equal(idle.capped, false, '驱动不忙时不涉及预算余量，capped 必须是 false');
});

test('⑧d 极端小预算（整轮 1.2s）⇒ 按常规窗口快报，不给出「比常规窗口还长的宽限」', () => {
  const r = idleWindowDecision({
    baseMs: 120_000, firstEventAt: NO_FIRST_EVENT, driverBusy: true, multiplier: 2, totalBudgetMs: 1_200,
  });
  assert.equal(r.windowMs, 120_000,
    '窗口应是常规值 120000ms（实际 ' + r.windowMs + '）：整轮预算 1.2s 连余量都不够，'
    + '此时给出比常规窗口还长的「宽限」或负数/零窗口都是错的');
  assert.equal(r.phase, 'awaiting-first-byte', '相位仍是「网页还没开口」——预算是压缩窗口，不是改变相位');
  assert.equal(r.capped, false, '没有压缩成功（退回常规窗口）时不得标 capped');
});

test('⑧e 带 totalBudgetMs 的各种组合下，windowMs 仍是正有限整数、capped 恒为布尔', () => {
  const combos = [
    { baseMs: BASE, firstEventAt: null, driverBusy: true, multiplier: 2, totalBudgetMs: 240_000 },
    { baseMs: BASE, firstEventAt: null, driverBusy: true, multiplier: 2, totalBudgetMs: 480_000 },
    { baseMs: BASE, firstEventAt: null, driverBusy: true, multiplier: 2, totalBudgetMs: 130_000 },
    { baseMs: BASE, firstEventAt: null, driverBusy: true, multiplier: 4, totalBudgetMs: 600_000 },
    { baseMs: BASE, firstEventAt: null, driverBusy: true, multiplier: 1, totalBudgetMs: 240_000 },
    { baseMs: 3_500, firstEventAt: null, driverBusy: true, multiplier: 2, totalBudgetMs: 10_000 },
    { baseMs: 3_500, firstEventAt: null, driverBusy: true, multiplier: 2, totalBudgetMs: 3_000 },
    { baseMs: BASE, firstEventAt: 0, driverBusy: true, totalBudgetMs: 240_000 },
  ];
  for (const input of combos) {
    const r = idleWindowDecision(input);
    assert.ok(Number.isFinite(r.windowMs) && r.windowMs > 0,
      'windowMs 不是正有限数（' + String(r.windowMs) + '），输入 ' + JSON.stringify(input)
      + '：Infinity ⇒ 永不超时；NaN/0 ⇒ setTimeout 立刻开火，等于每一轮都判死');
    assert.ok(Number.isInteger(r.windowMs),
      'windowMs 不是整数（' + String(r.windowMs) + '），输入 ' + JSON.stringify(input));
    assert.equal(typeof r.capped, 'boolean', 'capped 不是布尔值：' + String(r.capped));
    // 预算只许把相位窗口**压短**，不许把它拉长；被压过的窗口必须真的留出余量。
    if (r.capped) {
      assert.ok(r.windowMs < input.totalBudgetMs,
        'capped:true 却没有留出余量（窗口 ' + r.windowMs + ' ≥ 预算 ' + input.totalBudgetMs + '）');
    }
    const wanted = Math.round((input.baseMs ?? 120_000) * (input.multiplier ?? 2));
    assert.ok(r.windowMs <= Math.max(wanted, input.baseMs ?? 120_000),
      '窗口 ' + r.windowMs + ' 比未压缩的相位窗口 ' + wanted + ' 还长：预算只能压短窗口，'
      + '任何「拉长」都意味着给定配置下看门狗会晚于预期开火：' + JSON.stringify(input));
  }
});
