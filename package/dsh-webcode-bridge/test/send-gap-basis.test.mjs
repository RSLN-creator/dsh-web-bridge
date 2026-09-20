// send-gap-basis.test.mjs — 0.16.31 护栏：发送间隔的**两个口径**互不替代。
//
// 用户原话：「我需要的是 web 思考后调用时间后不立即回复而是间隔多少秒回复，不是现在
// 好像是的那个距离上传里面回复时间？注意是为了隔开和他发消息我立马回复的规避点！」
// —— 即基准要从「上次**发出**」改成「上次**回复完成**」。
//
// 本文件钉三件事：
//   ① send-to-send 的既有行为**逐字不变**（0.14.0 的承诺，不许被这次改动动摇）；
//   ② end-to-start 的语义：上一轮跑了多久**不影响**本轮等待，答完起重新数满；
//   ③ 基准缺失时的取舍：不拿另一个基准凑数，如实返回 0 等待。
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSendGap } from '../lib/metrics.js';

const NOW = 1_700_000_000_000;

// ── ① send-to-send：0.14.0 的既有行为，逐字不变 ──────────────────────────────

test('① send-to-send：距上次**发出**不足间隔就补满，已满足则不等待', () => {
  const wait = computeSendGap({ lastSendAt: NOW - 4_000, now: NOW, gapMs: 10_000 });
  assert.equal(wait.waitMs, 6_000, '距上次发出 4s、目标 10s ⇒ 还要等 6s');
  assert.equal(wait.basis, 'send-to-send', '默认口径必须回显 send-to-send');

  const done = computeSendGap({ lastSendAt: NOW - 20_000, now: NOW, gapMs: 10_000 });
  assert.equal(done.waitMs, 0, '距上次发出 20s > 目标 10s ⇒ 零等待（既有承诺）');
  assert.equal(done.sincePrevSendMs, 20_000, '距上次发出的实际间隔必须如实报出');
});

test('①b 显式传 basis:send-to-send 与不传逐字同结果', () => {
  const a = computeSendGap({ lastSendAt: NOW - 4_000, now: NOW, gapMs: 10_000 });
  const b = computeSendGap({ lastSendAt: NOW - 4_000, now: NOW, gapMs: 10_000, basis: 'send-to-send' });
  assert.deepEqual(b, a, '显式与默认必须是同一条路（不能各写一套）');
});

// ── ② end-to-start：答完起重新数满 ─────────────────────────────────────────

test('② end-to-start：上一轮跑得再久也不影响本轮，基准是**回复完成**时刻', () => {
  // 关键对照：同一组读数下两个口径给出**不同**结论——这正是它必须可选的证据。
  // 上一轮发出在 30s 前（send 口径早已满足），但回复刚在 3s 前完成。
  const input = { lastSendAt: NOW - 30_000, lastEndAt: NOW - 3_000, now: NOW, gapMs: 10_000 };
  const sendSide = computeSendGap({ ...input, basis: 'send-to-send' });
  const replySide = computeSendGap({ ...input, basis: 'end-to-start' });
  assert.equal(sendSide.waitMs, 0, 'send-to-send：距上次发出 30s ⇒ 零等待');
  assert.equal(replySide.waitMs, 7_000, 'end-to-start：距回复完成 3s ⇒ 还要等 7s（用户要的就是这个）');
  assert.equal(replySide.sincePrevSendMs, 3_000, '读数含义随之切换成「距上次回复完成」');
  assert.equal(replySide.basis, 'end-to-start');
});

test('②b end-to-start：回复早已完成 ⇒ 零等待（不是无条件每轮都等）', () => {
  const wait = computeSendGap({ lastSendAt: NOW - 60_000, lastEndAt: NOW - 30_000, now: NOW, gapMs: 10_000, basis: 'end-to-start' });
  assert.equal(wait.waitMs, 0, '答完 30s 了，10s 的间隔早就满足——不许无条件加等待');
});

// ── ③ 基准缺失：如实零等待，不拿另一个基准凑数 ──────────────────────────────

test('③ end-to-start 但从未记过回复完成时刻 ⇒ 零等待（不拿 send 基准凑）', () => {
  const wait = computeSendGap({ lastSendAt: NOW - 1_000, lastEndAt: null, now: NOW, gapMs: 10_000, basis: 'end-to-start' });
  assert.equal(wait.waitMs, 0,
    '拿 send 基准凑出一个等待 ⇒ 用户看到「刚切成 end-to-start 就等了」，而这 9s 无从解释');
  assert.equal(wait.sincePrevSendMs, null, '没有基准时读数必须是 null，不能编一个数');
});

test('③b 非法 basis 一律退回默认口径（配置写错只许退化成旧行为）', () => {
  // 样例里刻意放**大小写与分隔符变体**：判据是逐字相等，不是模糊匹配。
  // （`END-TO-START`、`end_to_start` 都不合法——认了它们等于把「写错也算数」
  //   变成新行为，而配置写错的正确处置是退化成默认。）
  for (const bad of ['reply', 'END-TO-START', 'end_to_start', 'end-to-start ', '', null, undefined, 42, {}]) {
    const got = computeSendGap({ lastSendAt: NOW - 4_000, lastEndAt: NOW - 1_000, now: NOW, gapMs: 10_000, basis: bad });
    assert.equal(got.basis, 'send-to-send', '非法 basis 必须退回 send-to-send：' + JSON.stringify(bad));
    assert.equal(got.waitMs, 6_000, '退回后按 send 基准算（与不传 basis 一致）：' + JSON.stringify(bad));
  }
});

// ── ④ 共用边界：gapMs=0 关闭、时钟回拨、首次发送 ────────────────────────────

test('④ gapMs=0 ⇒ 两个口径都零等待（关闭语义与口径无关）', () => {
  for (const basis of ['send-to-send', 'end-to-start']) {
    const got = computeSendGap({ lastSendAt: NOW - 1, lastEndAt: NOW - 1, now: NOW, gapMs: 0, basis });
    assert.equal(got.waitMs, 0, basis + ' 下 gapMs=0 必须是零等待');
    assert.equal(got.basis, basis, '即使不等待也要回显口径，读数才可核对');
  }
});

test('④b 基准在未来（时钟回拨）⇒ skewed 为真且按「刚发生」处理', () => {
  const got = computeSendGap({ lastEndAt: NOW + 60_000, now: NOW, gapMs: 10_000, basis: 'end-to-start' });
  assert.equal(got.skewed, true, '未来时刻必须标 skewed，调用方据此 warn');
  assert.equal(got.waitMs, 10_000, '按「刚刚完成」处理 ⇒ 等满一个间隔（既不全额白等也不假装没发生）');
  assert.equal(got.sincePrevSendMs, 0, 'clamp 到 now ⇒ 距基准 0ms');
});

test('④c 首次发送（两个基准都没有）⇒ 零等待且 skewed=false', () => {
  const got = computeSendGap({ lastSendAt: null, lastEndAt: null, now: NOW, gapMs: 10_000, basis: 'end-to-start' });
  assert.equal(got.waitMs, 0, '首次没有可回避的对象，不该凭空等一轮');
  assert.equal(got.skewed, false, '缺基准不是时钟问题，不许误报 skewed');
});

// ── ⑤ 源码结构钉子：口径必须真的接进执行器与设置面 ────────────────────────
//
// 与 upload-attachment-structure.test.mjs 同一取舍：钉接线事实。纯函数全绿也可能
// 整条链路没接上——0.14.0 的「OpenAI 前端绕过发送间隔」就是这么发生的（gapTargetMs
// 恒为 0，而 computeSendGap 的单测一直全绿）。因此这里逐点确认调用方真的在传。

test('⑤ 结构：executor 必须把 basis 传进 computeSendGap，且落 gapBasis 读数', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const pkg = path.dirname(import.meta.dirname);
  const src = fs.readFileSync(path.join(pkg, 'lib', 'index.js'), 'utf8');
  assert.match(src, /basis:\s*sendGapBasis/, 'executor 没有把口径传给 computeSendGap ⇒ 设置选了也不生效');
  assert.match(src, /lastEndAt:\s*sendState\?\.end/, '没有把「上次回复完成」时刻传进去 ⇒ end-to-start 永远退化成零等待');
  assert.match(src, /gapBasis:\s*gapPlan\.basis/, 'metrics 没有落 gapBasis 读数 ⇒ 面板无法显示用的是哪把尺子');
  // 记账点必须在**收束之后**，而不是 finally（finally 在抛错时也跑，会把基准提前）。
  assert.match(src, /rememberTurnEnd\(accountKey\)/, '没有在收束点记录回复完成时刻 ⇒ end-to-start 没有基准');
});

test('⑤b 结构：设置面读写两侧都认这个键（否则「改了不生效」）', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const pkg = path.dirname(import.meta.dirname);
  const control = fs.readFileSync(path.join(pkg, 'lib', 'web-control.js'), 'utf8');
  assert.match(control, /updated\.sendGapBasis\s*=/, 'POST settings 没有归一化 sendGapBasis ⇒ 存进去的是任意字符串');
  assert.match(control, /sendGapBasis:\s*config\.sendGapBasis === 'end-to-start'/, 'GET settings 没有回默认值 ⇒ 面板下拉一个都不选中');
  const page = fs.readFileSync(path.join(pkg, 'lib', 'settings-page.js'), 'utf8');
  assert.match(page, /id="sendGapBasis"/, '设置页缺少口径选择控件');
  assert.match(page, /sendGapBasis:/, '设置页提交时没有带上口径 ⇒ 保存等于清空');
});

// ── ⑥ 药丸连续性：等待正常结束时**不许**提前清掉在途读数 ──────────────────
//
// 用户报「底下框的时间会跳动」。根因取证：旧实现把 clearLiveWait 放在 sleep 的
// finally 里 ⇒ 等待一结束在途读数就消失，而账本要等整轮生成跑完（relay 的 onMetrics）
// 才吸收——中间那几十秒药丸掉回**上一轮**的旧值，收束时再跳上去。
//
// 这条只能钉结构：运行时序（等待 → 生成 → 结算）需要真机才能复现，而单测跑不了
// 浏览器。判据是「正常路径不清、abort 路径清」两件事同时在源码里成立。

test('⑥ 结构：等待正常结束**保留**在途读数，只有 abort 路径清', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const pkg = path.dirname(import.meta.dirname);
  const src = fs.readFileSync(path.join(pkg, 'lib', 'index.js'), 'utf8');
  // 发送间隔等待：必须是 catch + clearLiveWait + throw，而不是 finally。
  const gapIdx = src.indexOf("beginLiveWait(m, accountKey, 'gap'");
  assert.ok(gapIdx > 0, '找不到发送间隔等待的 beginLiveWait 调用点');
  const gapWindow = src.slice(gapIdx, gapIdx + 700);
  assert.match(gapWindow, /\} catch \(err\) \{/, '等待块必须用 catch 而不是 finally（finally 会在正常结束时也清）');
  assert.match(gapWindow, /clearLiveWait\(m\);[\s\S]*throw err;/, 'abort 分支必须清掉在途读数并重新抛出');
  assert.doesNotMatch(gapWindow, /\} finally \{/, '发送间隔等待里仍有 finally ⇒ 正常结束又会在途读数提前消失（跳动回归）');
  // 限流退避：同一条修正，同一个判据。
  const rlIdx = src.indexOf("beginLiveWait(m, accountKey, 'rate-limit'");
  assert.ok(rlIdx > 0, '找不到限流退避的 beginLiveWait 调用点');
  const rlWindow = src.slice(rlIdx, rlIdx + 700);
  assert.doesNotMatch(rlWindow, /\} finally \{/, '限流退避等待里仍有 finally ⇒ 两段等待之间会出现一次回跌');
});

