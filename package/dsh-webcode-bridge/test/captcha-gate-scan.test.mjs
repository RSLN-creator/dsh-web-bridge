// captcha-gate-scan.test.mjs — 「逐 frame 扫验证」编排层的**行为**护栏（0.19.87）。
//
// ## 为什么需要行为级护栏（#75 的核心教训）
//
// 0.19.83 加的逐 frame 扫描，当时只有**源码级**护栏
// （`test/captcha-gate.test.mjs` ④b：`assert.match(seg, /page\.frames\?\.\(\)/)`）。
// 源码级护栏**只证明「那个字符串在场」**，不证明「那段代码跑得起来」——
// 于是 #75（`evaluate` 传 4 个实参 ⇒ Playwright 同步抛 ⇒ 被 `.catch` 吞）
// **全程没被发现**：所有护栏全绿，而那段判据**从未运行**。
//
// 本文件把编排逻辑（遍历 / 命中即停 / probe 汇总 / frameError 如实记）
// 用**假 frame** 直接驱动 ⇒ 判的是**行为**，不是字符串。
//
// ⚠ 与 `test/captcha-gate.test.mjs` ④b 的分工：那边仍保留**接线**判据
//   （驱动确实调了 `scanFramesForChallenge`），这边判**这个函数自己的行为**。
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanFramesForChallenge } from '../lib/captcha-gate-scan.js';

/** 造一个假 frame：`plan` 决定这次探测返回什么（或抛什么）。 */
const fakeFrame = (url, plan) => ({
  url: () => url,
  __plan: plan,
});

/** 由 plan 造出 probeFrame：命中 / 未命中 / 抛错（跨域 frame 的真实形态）。 */
const probeOf = () => async (f) => {
  const p = f.__plan;
  if (p === 'throw') throw new Error('cross-origin frame：evaluate 拒绝');
  if (p === 'title') return { basis: 'title', head: '滑动验证页面', probe: { bodyLen: 10, kws: ['验证'] } };
  if (p === 'selector') return { basis: 'site-selector', head: 'aliyunCaptcha', probe: { bodyLen: 20, kws: [] } };
  if (p === 'body') return { basis: 'body-text', head: '请选择所有符合…', probe: { bodyLen: 300, kws: ['验证', '请选择', '图片'] } };
  return { basis: null, probe: { bodyLen: 42, kws: ['提交'], titleLen: 5 } };
};
const urlOf = (f) => f.url();

test('① 命中即停：第一个命中的 frame 就定论，且**不再探测后面的**', async () => {
  const seen = [];
  const frames = [fakeFrame('about:blank', 'miss'), fakeFrame('https://captcha.a/', 'body'), fakeFrame('https://after/', 'body')];
  const r = await scanFramesForChallenge(frames, async (f) => { seen.push(f.url()); return probeOf()(f); }, urlOf);
  assert.equal(r.basis, 'body-text', '必须采用第一个命中的 frame 判据');
  assert.equal(r.head, '请选择所有符合…', '命中现场必须带出来');
  assert.equal(r.frameUrl, 'https://captcha.a/', '必须记住**是哪个 frame** 命中的（排障必需）');
  assert.deepEqual(seen, ['about:blank', 'https://captcha.a/'], '命中即停：不得继续探测后面的 frame');
});

test('② 未命中：把**每个 frame 的 probe** 都汇总（否则「本来没有」与「抓不到」不可分）', async () => {
  const frames = [fakeFrame('https://main/', 'miss'), fakeFrame('https://drive/', 'miss')];
  // ⚠ 这里直接用 `probeOf()`（**不是** `probeOf()` 再包一层）。
  //   首版写成 `async (f) => probeOf()(f)` ⇒ 外层箭头把返回值**原样转发**，
  //   而 `{ ...(r || {}) }` 展开的是**外层**那个对象 ⇒ `probe` 字段被丢。
  //   是测试②当场抓到的（断言 actual: undefined）。**这是我构造错了，不是产品错了。**
  const r = await scanFramesForChallenge(frames, probeOf(), urlOf);
  assert.equal(r.basis, null, '都不命中时 basis 必须是 null');
  assert.equal(r.probe.frames.length, 2, '每个 frame 都要留一条 probe 记录');
  assert.equal(r.probe.frames[0].url, 'https://main/');
  assert.deepEqual(r.probe.frames[0].probe?.kws, ['提交'],
    '关键词命中要如实透出（判断「形态漏了」还是「本来没有」）');
  assert.equal(r.probe.frames[0].probe?.bodyLen, 42);
});

test('③ ★ 抛错的 frame 必须**如实记 frameError**，不得静默跳过（跨域 frame 的真实形态）', async () => {
  // 这一条直接对应 doubao 那个场景：风控验证常渲染在**独立 iframe** 里，
  // 跨域时 `evaluate` 会抛。若静默吞掉，读数上就看不出「这个 frame 查不了」。
  const frames = [fakeFrame('https://cross-origin/', 'throw'), fakeFrame('https://main/', 'miss')];
  const r = await scanFramesForChallenge(frames, probeOf(), urlOf);
  assert.equal(r.basis, null);
  const first = r.probe.frames.find((x) => x.url === 'https://cross-origin/');
  assert.ok(first, '抛错的 frame 仍必须出现在 probe 里');
  assert.ok(/cross-origin|拒绝/.test(String(first.frameError || '')),
    '抛错必须记成 frameError 并带原文片段 —— 静默跳过会让「这个 frame 查不了」在读数上消失');
  // 第二个 frame 不能因为第一个抛错就被放弃
  assert.equal(r.probe.frames.length, 2, '一个 frame 抛错不得中断对其余 frame 的扫描');
});

test('④ 抛错之后**仍能**在后面的 frame 上命中（跨域 frame 不该挡住真命中）', async () => {
  const frames = [fakeFrame('https://cross-origin/', 'throw'), fakeFrame('https://captcha/', 'selector')];
  const r = await scanFramesForChallenge(frames, probeOf(), urlOf);
  assert.equal(r.basis, 'site-selector', '前面抛错、后面命中 ⇒ 必须报命中（不能被抛错吃掉）');
  assert.equal(r.frameUrl, 'https://captcha/');
});

test('⑤ 空 frame 列表 / null 都不许抛（超时点必须永远给出一个可读结论）', async () => {
  for (const input of [[], null, undefined]) {
    const r = await scanFramesForChallenge(input, probeOf(), urlOf);
    assert.equal(r.basis, null);
    assert.deepEqual(r.probe.frames, [], '没有 frame 时应如实报「查了 0 个」，而不是抛');
  }
});

test('⑥ probeFrame 自身抛错（而非 frame.evaluate 抛）也必须被如实记，不炸整轮', async () => {
  const r = await scanFramesForChallenge([fakeFrame('https://x/', 'miss')], async () => { throw new Error('探测器自己坏了'); }, urlOf);
  assert.equal(r.basis, null);
  assert.ok(/探测器自己坏了/.test(String(r.probe.frames[0].frameError || '')),
    '探测函数抛错同样要如实记——超时点不能因为探测器坏了而整轮炸掉');
});

test('⑦ 反向：把「命中即停」写成「扫完全部」时，本护栏必须变红（判据不是装饰品）', async () => {
  // 直接给一个**宽松实现**，验证 ① 的断言真的能区分它。
  const loose = async (frames) => {
    const probes = [];
    for (const f of frames) probes.push({ url: f.url(), ...(await probeOf()(f)) });
    // 宽松版：取**最后一个**命中（而不是第一个）
    const hits = probes.filter((p) => p.basis);
    return hits.length ? hits[hits.length - 1] : { basis: null, probe: { frames: probes } };
  };
  const frames = [fakeFrame('https://first/', 'body'), fakeFrame('https://last/', 'title')];
  const strict = await scanFramesForChallenge(frames, probeOf(), urlOf);
  const looseR = await loose(frames);
  assert.equal(strict.basis, 'body-text', '严格版取第一个命中的判据');
  assert.equal(looseR.basis, 'title', '宽松版取最后一个 ⇒ 与严格版结果**不同**');
  assert.notEqual(strict.basis, looseR.basis, '本护栏必须能区分这两种实现');
});
