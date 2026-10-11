// watchdog-first-byte.test.mjs — 「网页还没开口」不该被当成「网页不说了」（0.16.3）。
//
// ## 真机事故（本文件针对的那一次）
//
// 2026-09-17 18:39-18:43，会话 `session-dff3edf7`：桥把 **127,888 字符**纯文本
// 一次性贴进 DeepSeek 网页输入框（工具教学 38,279 + 会话 transcript 89,609）。
// 该轮 step5 从 18:41:59 到 18:43:51 **跨度 112 秒零事件**，适配器侧 120s 看门狗
// 开火，报 `WEB_NO_PROGRESS`；而**同一轮的 step1-4 每一步都有事件**（工具调用
// 2-4 条），说明捕获链是活的——不是链路坏，是网页还在 prefill 那 12.8 万字符的
// 输入，还没吐出第一个 token。
//
// ## 判据（本文件钉住的东西）
//
// 看门狗窗口必须**分相位**（见 lib/idle-window.js）：
//   · 首个事件之前（awaiting-first-byte）+ 驱动报告本轮仍在忙 → 窗口 = 常规 × 倍数；
//   · 首个事件之后（mid-stream）→ 常规窗口，**不得宽限**（已经开流还静默，就是卡住）；
//   · 驱动不忙 → 常规窗口，**不得宽限**（捕获链没跑起来，等更久只会更晚发现）。
//
// ## 为什么必须是**接线**级用例，而不是只测纯函数
//
// 项目已有教训（见 test/stall-settle.test.mjs §③）：0.15.2 只加了判据、没把配置
// 接进去，行为「恰好」对但旋钮完全够不着。纯函数全绿而调用点仍用旧窗口，是本
// 项目反复出现过的一类假绿。所以这里用**注入式脚本驱动**跑真实的适配器 → relay →
// driver 链路，用「驱动延迟多久吐第一个字节」制造真实相位，再看适配器是成功还是
// 抛 WEB_NO_PROGRESS。
//
// 时间尺度说明：真实窗口是 120s/240s，这个用例把它压到**毫秒级**（cfg.idleTimeoutMs
// 可配正是为此）。断言的是**相位判定与窗口选择**，不是墙钟数字。
//
// ## 反向验证纪律（doc/comment-style.md §9.3）
//
// ②③ 是反向安全线：分别把「mid-stream 宽限」与「驱动不忙也宽限」这两种错误修法
// 钉红。任何把窗口一律乘倍数的偷懒改法都会让 ③ 变红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = dirname(here);

/** 最小 DSH 宿主替身：只需要 llm.registerAdapter 与 webServer.register。 */
function mockCtx() {
  const registered = { adapter: null, adapterIds: null, routes: new Map() };
  const llm = {
    registerConfigurableProviders() {},
    registerAdapter(ids, adapter) { registered.adapter = adapter; registered.adapterIds = [...ids]; },
  };
  const ctx = {
    llm,
    get(name) {
      if (name === 'llm') return llm;
      if (name === 'webServer') return { register: ({ path, handler }) => { registered.routes.set(path, handler); } };
      return undefined;
    },
  };
  return { ctx, registered };
}

/**
 * 脚本驱动：把「网页侧要不要先憋一会儿」变成可控输入。
 *
 * @param {{firstByteDelayMs?: number, onDelta?: Function, busyReport?: 'busy'|'idle'|'none',
 *          statusActivityAt?: number|null, domReplyChars?: number|null}} o
 */
function scriptedDriver(o = {}) {
  const calls = [];
  return {
    calls,
    async sendTurn(key, message, { fresh = false, onDelta, onThink } = {}) {
      calls.push({ key, message, fresh, at: Date.now() });
      if (o.firstByteDelayMs) await new Promise((r) => setTimeout(r, o.firstByteDelayMs));
      onThink?.('（思考）');
      onDelta?.('网页答复');
      return { text: '网页答复', sessionId: 'sess-web-1', metrics: { endToEndMs: 1, firstResponseMs: 1 } };
    },
    async resetConversation() {},
    status() {
      return {
        running: true,
        // busyReport='none' 用来模拟「驱动还没建起来 / status 取不到」的形态。
        ...(o.busyReport === 'none' ? {} : { busy: o.busyReport !== 'idle' }),
        preview: true,
        lastActivityAt: o.statusActivityAt ?? null,
        domReplyChars: o.domReplyChars ?? null,
        lastEndReason: null,
        lastRecovered: null,
        lastStalledSettle: null,
        thinkingOnlyTurns: 0,
        recoveredTurns: 0,
      };
    },
    async close() {},
  };
}

/** 跑一轮真实适配器流，返回 { ok, text, error }。 */
async function runTurn({ driver, pluginConfig = {}, signal }) {
  const { apply } = await import(pathToFileURL(join(pkg, 'lib', 'index.js')).href);
  const { ctx, registered } = mockCtx();
  const disposer = apply(ctx, {
    port: 0,
    host: '127.0.0.1',
    requireConsent: false,
    driver,
    profileDir: mkdtempSync(join(tmpdir(), 'webcode-watchdog-')),
    ...pluginConfig,
  });
  const adapter = registered.adapter;
  try {
    const opts = {
      purpose: null,
      model: 'deepseek',
      messages: [{ role: 'user', content: '你好' }],
      tools: [],
      sessionId: 'watchdog-session',
      signal,
    };
    let text = '';
    for await (const chunk of adapter.stream(opts)) {
      if (chunk?.type === 'text-delta') text += chunk.text;
    }
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: err };
  } finally {
    try { disposer?.(); } catch { /* 测试替身，忽略 */ }
  }
}

// ── ① 正向：首个字节之前的等待必须被宽限（这就是真机事故的修法）────────────

test('① 首个字节迟到（超过常规窗口、但在倍数窗口内）→ 本轮成功，不再报 WEB_NO_PROGRESS', async () => {
  // 延迟（2000ms）**故意大于常规窗口**（wipIdleMs=200 ⇒ max(300,200)+1000 = 1300ms）：
  // 这正是真机那条事故的形状（网页还在 prefill，什么都没吐出来）。倍数窗口
  // 1300×4 = 5200ms 覆盖得住 ⇒ 本轮必须成功。
  //
  // 为什么不能把延迟设成小于常规窗口：那样看门狗根本不会开火，用例即使全绿也
  // 什么也没证明——「没有宽限也能过」是本项目里出现过的一类假绿。
  const driver = scriptedDriver({ firstByteDelayMs: 2000 });
  const r = await runTurn({
    driver,
    pluginConfig: { wipIdleMs: 200, idleTimeoutMs: 1300, idleFirstByteMultiplier: 4 },
  });
  assert.equal(r.ok, true, r.ok ? '' : '本轮应当成功，实际报错：' + r.error?.message);
  assert.equal(r.text, '网页答复');
  assert.equal(driver.calls.length, 1, '驱动必须真的被调用了一次');
});

// ── ② 反向安全线：mid-stream 之后不得宽限 ──────────────────────────────────

test('② 已开流后长时间静默 → 仍然按常规窗口判死（不许给 mid-stream 宽限）', async () => {
  const driver = scriptedDriver({
    busyReport: 'busy',
    // 先正常吐一个字节，然后整轮不再有任何事件：mid-stream 静默。
    firstByteDelayMs: 0,
  });
  // 覆写 sendTurn：吐一个 delta 之后永久挂住（不 resolve）。
  driver.sendTurn = async (key, message, { onDelta } = {}) => {
    driver.calls.push({ key, message });
    onDelta?.('开始');
    return await new Promise(() => {});   // 永不结算
  };
  const t0 = Date.now();
  const r = await runTurn({
    driver,
    pluginConfig: { wipIdleMs: 200, idleTimeoutMs: 1300, idleFirstByteMultiplier: 4 },
  });
  const dt = Date.now() - t0;
  assert.equal(r.ok, false, 'mid-stream 静默必须判死');
  assert.match(String(r.error?.message || '').toLowerCase(), /web_no_progress/);
  assert.ok(dt < 4000, `必须按常规窗口（1300ms）判死，实际等了 ${dt}ms —— 说明给 mid-stream 也乘了倍数`);
});

// ── ③ 反向安全线：驱动不忙时必须照旧快报 ──────────────────────────────────

test('③ 驱动不在忙（捕获链没跑起来）→ 不得宽限，仍按常规窗口尽快报错', async () => {
  const driver = scriptedDriver({ busyReport: 'idle' });
  driver.sendTurn = async () => await new Promise(() => {});
  const t0 = Date.now();
  const r = await runTurn({
    driver,
    pluginConfig: { wipIdleMs: 200, idleTimeoutMs: 1300, idleFirstByteMultiplier: 8 },
  });
  const dt = Date.now() - t0;
  assert.equal(r.ok, false);
  assert.match(String(r.error?.message || ''), /WEB_NO_PROGRESS/);
  assert.ok(dt < 4000, `驱动不忙时不得宽限（8 倍会等 10.4s），实际 ${dt}ms`);
});

test('③b 驱动根本没有 status()（取不到现场）→ 按不忙处理，同样不宽限', async () => {
  const driver = scriptedDriver({ busyReport: 'none' });
  driver.sendTurn = async () => await new Promise(() => {});
  const t0 = Date.now();
  const r = await runTurn({
    driver,
    pluginConfig: { wipIdleMs: 200, idleTimeoutMs: 1300, idleFirstByteMultiplier: 8 },
  });
  const dt = Date.now() - t0;
  assert.equal(r.ok, false);
  assert.match(String(r.error?.message || '').toLowerCase(), /web_no_progress/);
  assert.ok(dt < 4000, `status 取不到时必须按不忙处理，实际 ${dt}ms`);
});

test('③c 驱动的 status() 返回 null（本进程还没建起现场）→ 按不忙处理，不抛错', async () => {
  const driver = {
    async sendTurn() { return await new Promise(() => {}); },
    async resetConversation() {},
    async close() {},
    status() { return null; },
  };
  const r = await runTurn({
    driver,
    pluginConfig: { wipIdleMs: 200, idleTimeoutMs: 1300, idleFirstByteMultiplier: 8 },
  });
  assert.equal(r.ok, false);
  assert.match(String(r.error?.message || '').toLowerCase(), /web_no_progress/);
});

// ── ④ 倍数默认值：不配也要有宽限（否则修法等于没上）──────────────────────

test('④ 不配置 idleFirstByteMultiplier 时默认仍有宽限（默认 2 倍）', async () => {
  const driver = scriptedDriver({ firstByteDelayMs: 2200 });
  // 常规窗口 1300ms；默认 2 倍 = 2600ms > 2200ms，所以应当成功。
  const r = await runTurn({
    driver,
    pluginConfig: { wipIdleMs: 200, idleTimeoutMs: 1300 },
  });
  assert.equal(r.ok, true, r.ok ? '' : '默认倍数下仍未宽限：' + r.error?.message);
});

// ── ⑤ 报错文本必须带上新现场读数（下次事故一句话定位）──────────────────────

test('⑤ 超时报错要带出「最近驱动活动」与「页面已有 N 字回复未回传」', async () => {
  const driver = scriptedDriver({ busyReport: 'idle', statusActivityAt: Date.now() - 5_000, domReplyChars: 321 });
  driver.sendTurn = async () => await new Promise(() => {});
  const r = await runTurn({
    driver,
    pluginConfig: { wipIdleMs: 200, idleTimeoutMs: 1300 },
  });
  assert.equal(r.ok, false);
  const msg = String(r.error?.message || '');
  assert.match(msg, /WEB_NO_PROGRESS/);
  assert.match(msg, /321/, '报错必须带出页面 DOM 里的回复字数：' + msg);
  assert.match(msg, /最近驱动活动/, '报错必须带出最近驱动活动：' + msg);
});

// ── ⑥ 收束原因必须带时刻，且旧的读数不得冒充本轮 ─────────────────────────
//
// 这一条针对真机报错原文本身：「（页面在，本轮收束原因 finished）」——那一轮根本
// 没跑完，`finished` 是 **30 秒前** 上一轮写的。一个无标注的旧读数把「网页还在
// 生成」读成了「网页已收束」，是这次排障绕远路的直接原因。

test('⑥ 很久以前的收束原因 → 报错里必须标成「上一轮」并给出秒数，不许冒充本轮', async () => {
  const driver = scriptedDriver({ busyReport: 'idle' });
  driver.sendTurn = async () => await new Promise(() => {});
  driver.status = () => ({
    running: true,
    busy: false,
    preview: true,
    lastEndReason: 'finished',
    lastEndReasonAt: Date.now() - 30_000,
    lastActivityAt: null,
    domReplyChars: null,
    recoveredTurns: 0,
    lastRecovered: null,
    lastStalledSettle: null,
    thinkingOnlyTurns: 0,
  });
  const r = await runTurn({
    driver,
    pluginConfig: { wipIdleMs: 200, idleTimeoutMs: 1300 },
  });
  assert.equal(r.ok, false);
  const msg = String(r.error?.message || '');
  assert.match(msg, /上一轮收束原因（3[0-9]s 前）\s*finished/, '必须标出「上一轮」与秒数：' + msg);
  assert.ok(!/本轮收束原因 finished/.test(msg), '绝不允许把旧读数写成「本轮收束原因」：' + msg);
});

test('⑦ 写入时刻缺失 → 显式说「写入时刻未知」，不猜、不冒充', async () => {
  const driver = scriptedDriver({ busyReport: 'idle' });
  driver.sendTurn = async () => await new Promise(() => {});
  driver.status = () => ({
    running: true, busy: false, preview: true,
    lastEndReason: 'timeout', lastEndReasonAt: null,
    lastActivityAt: null, domReplyChars: null,
    recoveredTurns: 0, lastRecovered: null, lastStalledSettle: null, thinkingOnlyTurns: 0,
  });
  const r = await runTurn({ driver, pluginConfig: { wipIdleMs: 200, idleTimeoutMs: 1300 } });
  assert.equal(r.ok, false);
  const msg = String(r.error?.message || '');
  assert.match(msg, /最近一次收束原因 timeout（写入时刻未知）/, msg);
});

// ── ⑧ 【真机相位】看门狗判相位那一刻，驱动「还没进轮次」────────────────────
//
// 这一条针对 issue #1 报错原文里的自相矛盾，也是 0.16.3 首字节宽限可能在**生产
// 路径上根本不生效**的原因。
//
// 生产时序（不是静态测试桩的时序）：
//   1. 适配器调用 `relay.submit()` —— 它只是**入队**，executor 由微任务异步起跑
//      （lib/relay.js: `Promise.resolve().then(() => cfg.executor(…))`）；
//   2. 适配器同步进入消费循环 → `nextWithIdle()` → `idleDecision()` 在**这一刻**
//      读 `status().busy`；
//   3. 驱动真正把 `busy = true` 是在 `runTurn` 内部（browser-driver.js 的
//      `busy = true`），而那要等 executor 微任务跑起来 —— **在第 2 步之后**。
//
// 于是第 2 步读到的 `busy` 恒为 false ⇒ 相位恒判成「网页还没开口且驱动不在忙」
// ⇒ 首字节宽限**永远轮不到**；而没有事件就不会有第二次 `nextWithIdle()`，这个
// 判定被**冻结整轮**，而 `idleScene()` 在开火那一刻又去读**新鲜**读数。真机报错
// 把「驱动不在忙」与「最近驱动活动时间 2s 前 / 页面已有 2172 字回复未回传」并排
// 印出来，正是「冻结的相位」与「新鲜的现场」互相矛盾的结果。
//
// 既有 ① 用的是静态桩（`busyReport` 恒 busy）——它在驱动**从未被调用**时就报
// busy，因此复现不出这个时序，宽限看起来是生效的（一类假绿）。
test('⑧ 判相位时驱动还没进轮次（生产时序）→ 首字节宽限仍须生效', async () => {
  let entered = false;
  const driver = {
    calls: [],
    async sendTurn(key, message, { onDelta }) {
      entered = true;                    // 进了轮次，从此 busy 才为真（真机语义）
      this.calls.push({ key, message });
      await new Promise((r) => setTimeout(r, 2000));   // prefill：迟于常规窗口
      onDelta?.('网页答复');
      return { text: '网页答复', sessionId: 'sess-web-1', metrics: {} };
    },
    async resetConversation() {},
    async close() {},
    status() {
      return {
        running: true,
        // ← 生产语义：**进轮次之前不忙**。静态桩写不出这个形态。
        busy: entered,
        preview: true,
        lastActivityAt: null, domReplyChars: null,
        lastEndReason: null, lastRecovered: null, lastStalledSettle: null,
        thinkingOnlyTurns: 0, recoveredTurns: 0,
      };
    },
  };
  const r = await runTurn({
    driver,
    pluginConfig: { wipIdleMs: 200, idleTimeoutMs: 1300, idleFirstByteMultiplier: 4 },
  });
  assert.equal(r.ok, true, r.ok ? '' : '生产时序下首字节宽限必须生效，实际报错：' + r.error?.message);
  assert.equal(r.text, '网页答复');
  assert.equal(driver.calls.length, 1, '驱动必须真的被调用了一次');
});

// ── ⑨ 【真机相位】deadline 的起点是「上一次事件」，不是「本次提交」────────────
//
// 这一条与 ⑧ 是两个**独立**的缺陷，都已核实为既有缺陷（在 471efcd 上同样复现）。
// ⑧ 是「相位被冻结」；本条是「起点不跟事件走」。
//
// 旧实现 `idleDeadline` 返回 `submitAtReal + pre + windowMs`——**整轮固定**，
// 与事件无关。那实际上是「总时长上限」，而函数文档与 index.js 上方注释一直承诺的
// 是「自上次收到任何 delta/think/image 起」的**静默上限**。后果：只要一轮的墙钟
// 超过窗口，即使每一拍都在正常交付增量，下一拍也当场判死。
//
// 离线读数（窗口 1300ms、每 150ms 一个 delta）：旧实现 **1315ms 处判死**，
// 而那时已经收到 chunk0…chunk7 —— 报错文本却写着「超过 1s 没有任何新内容」。
// 真机尺度就是「单个模型调用超过 120s 即腰斩，哪怕正文一直在流」。
//
// 反向安全线（**必须同时钉住，否则本修法可以退化成「窗口无限」**）：
// ⑨b 证明「真正不再有事件」时仍然在一个窗口后判死 —— 改起点 ≠ 取消看门狗。
test('⑨ 持续有事件的轮次不得因『总时长超过窗口』被判死（静默上限 ≠ 总时长上限）', async () => {
  const driver = scriptedDriver({ busyReport: 'busy' });
  // 每 150ms 送一个 delta，持续 3s；窗口只有 1300ms。
  // 若 deadline 仍锚在 submit，会在 ~1315ms 处判死（旧行为）。
  driver.sendTurn = async (key, message, { onDelta } = {}) => {
    driver.calls.push({ key, message });
    const t0 = Date.now();
    let i = 0;
    while (Date.now() - t0 < 3000) {
      await new Promise((r) => setTimeout(r, 150));
      onDelta?.(`chunk${i++}`);
    }
    return { text: 'chunk-done', sessionId: 'sess-web-1', metrics: {} };
  };
  const r = await runTurn({
    driver,
    pluginConfig: { wipIdleMs: 200, idleTimeoutMs: 1300 },
  });
  assert.equal(r.ok, true, r.ok ? '' : '持续有事件时不得判死，实际报错：' + r.error?.message);
  assert.match(r.text, /chunk0/, '必须真的收到了增量：' + r.text);
});

test('⑨b 反向安全线：事件真的停了之后，仍必须在一个窗口内判死（改起点 ≠ 取消看门狗）', async () => {
  const driver = scriptedDriver({ busyReport: 'busy' });
  // 先吐 10 个 delta（约 1s），然后**永久静默**。
  // 起点跟事件走之后，deadline 必须从**最后一个事件**算起再给一个窗口。
  driver.sendTurn = async (key, message, { onDelta } = {}) => {
    driver.calls.push({ key, message });
    for (let i = 0; i < 10; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      onDelta?.(`chunk${i}`);
    }
    return await new Promise(() => {});   // 之后永不再有事件
  };
  const t0 = Date.now();
  const r = await runTurn({
    driver,
    pluginConfig: { wipIdleMs: 200, idleTimeoutMs: 1300 },
  });
  const dt = Date.now() - t0;
  assert.equal(r.ok, false, '静默后必须判死（否则就是「永不失败」的假安全）');
  assert.match(String(r.error?.message || ''), /WEB_NO_PROGRESS/);
  // 10 个 delta × 100ms ≈ 1000ms 的活跃期 + 1300ms 窗口 ≈ 2300ms。
  // 上界给足余量，但必须显著小于「永不判死」。
  assert.ok(dt < 6000, `必须在静默一个窗口后判死，实际 ${dt}ms`);
  assert.ok(dt > 1200, `不得在活跃期内提前判死，实际 ${dt}ms`);
});

// ── ⑩ 报错文案不得把「桥没收到」说成「网页没有」────────────────────────────
//
// Issue #1 报错原文的误导之处：`网页侧超过 120s 没有任何新内容`，而同一句里
// 并列着 `页面已有 2172 字回复未回传` —— 前者替网页侧下了「没有内容」的结论，
// 后者却证明页面**有**内容。本看门狗量的是适配器流，不是网页 DOM。
// 文案必须只陈述「桥侧没收到事件」这一件它真正量到的事。
test('⑩ 报错只陈述「桥侧没收到事件」，不得替网页侧断言「没有任何新内容」', async () => {
  const driver = scriptedDriver({ busyReport: 'busy', domReplyChars: 2172 });
  driver.sendTurn = async () => await new Promise(() => {});
  const r = await runTurn({ driver, pluginConfig: { wipIdleMs: 200, idleTimeoutMs: 1300 } });
  assert.equal(r.ok, false);
  const msg = String(r.error?.message || '');
  assert.ok(!/网页侧超过/.test(msg), '不得再出现「网页侧超过…没有任何新内容」这种替网页侧下的结论：' + msg);
  assert.match(msg, /桥侧/, '必须说清是桥这一侧没收到事件：' + msg);
  assert.match(msg, /2172/, '页面上的真实字数仍须带出（它才是「网页有内容」的证据）：' + msg);
});
