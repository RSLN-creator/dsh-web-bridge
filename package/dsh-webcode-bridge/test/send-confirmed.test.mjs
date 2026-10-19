// send-confirmed.test.mjs — 0.19.8 护栏：**发送必须被页面事实确认**。
//
// ## 真机故障（2026-09-24，本机 0.19.7，DeepSeek 统一 UI）
//
// 带图片的那一轮：上传证据命中（`imageTransport.ok=true` / `img[src^='blob:']`），
// 但 22 秒后页面**仍停在站点首页、正文还躺在输入框里**——程序化 Enter 没有提交。
// 同一页面手工按 Enter 立刻成功（模型正确读出图里的字符）。于是整轮白等 240s 超时，
// 而读数只说「超时」，看不出「消息压根没发出去」。
//
// ## 为什么这条护栏必须存在
//
// 旧实现的发送是「调用即完成」：点按钮或回车之后直接 `startWipWatch()` 等回复。
// 于是「没发出去」与「发出去了但网页不回」在读数上长得一模一样，而两者的修法
// 完全不同。这与本项目记过的「只声明不接线」是同一族：**把动作当成结果**。
//
// 判据：驱动源码里必须有 (a) 清空判据、(b) 地址栏判据、(c) 未确认时的明确错误码。
// 反向验证：删掉 `composerCleared` 或 `SEND_NOT_CONFIRMED` → 本用例立刻变红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(here, '..', 'lib');
const src = readFileSync(path.join(LIB, 'browser-driver.js'), 'utf8');

/** 取「发送确认」那一段源码：从契约发送注释起到 startWipWatch 之前为止。 */
function sendBlock() {
  const at = src.indexOf('0.19.8：**发送必须确认**');
  assert.ok(at > 0, '找不到发送确认段 —— 本测试的锚点失效，先修解析');
  const end = src.indexOf('startWipWatch()', at);
  assert.ok(end > at, '找不到 startWipWatch —— 发送段的结构变了，先修解析');
  return src.slice(at, end);
}

test('★ 0.19.8 发送必须确认：清空 / 地址栏两条页面事实，未确认不许当成功', () => {
  const block = sendBlock();
  // (a) 输入框被清空才是「网页收下了」
  assert.match(block, /const composerCleared = async \(\) =>/, '缺少「输入框已清空」判据');
  assert.match(block, /readComposer\(input\)/, '清空判据必须回读真实的 composer，不能凭调用成功');
  // (b) 新会话地址栏改写的第二条页面事实
  assert.match(block, /const navigatedAway = \(\) =>/, '缺少「地址栏已切到会话」判据');
  // (c) 两条路都试过仍没发出 → 明确抛错（不是继续等回复）
  assert.match(block, /SEND_NOT_CONFIRMED/, '缺少未确认发送的错误码 —— 又会退化成静默超时');
  // (d) 必须真的有多条发送路径（按钮 / Enter），否则确认失败时无处重试
  assert.match(block, /input\.press\('Enter'\)/, '缺少 Enter 发送路径');
  assert.match(block, /page\.locator\(SEL\.sendButton\)/, '缺少按契约点发送按钮的路径');
  // (e) 确认必须在「启动等待回复」之前：抛错那一步早于 startWipWatch（wait 段起点）。
  assert.ok(!/startWipWatch\(\)/.test(block),
    '发送确认段里出现了 startWipWatch —— 那意味着没确认就先开始等回复，又会退化成 240s 静默超时');
});

test('★ 0.19.8 发送确认不得引入永久等待：轮询是有限次', () => {
  const block = sendBlock();
  // settle(rounds) 必须是 250ms × 有限次数，不能是 while(true)
  assert.match(block, /await page\.waitForTimeout\(250\)/, '确认轮询的间隔必须是 250ms（可预期）');
  assert.ok(!/while\s*\(\s*true\s*\)/.test(block), '发送确认里出现了 while(true) —— 会把一轮卡死');
  const settles = [...block.matchAll(/settle\((\d+)\)/g)].map((m) => Number(m[1]));
  assert.ok(settles.length >= 3, '应有三条发送路径各自确认（实际 ' + settles.length + ' 条）');
  for (const n of settles) {
    assert.ok(n > 0 && n <= 20, 'settle 轮数 ' + n + ' 不在合理范围（1..20 × 250ms）');
  }
});

// ── F16：页面级 UI 遮罩必须被识别（真机 z.ai 产品导览拦截发送点击）────────────
//
// ## 缺陷现场（2026-10-19 Wave2，只读 live-probe，`.tmp/live-2026-10-19/probe-report-2.md` §4）
//
// 既有会话页 `body.className="driver-active driver-fade"`、`.driver-overlay` svg、
// `.driver-popover` 文案「将任务结果保存到文件夹 … 1/2 下一页」；`elementFromPoint`
// 在发送键中心 (1209,849) 与输入框中心 (852,799) 命中的都是 `.driver-overlay` 内的
// `<path>`（pointer-events:auto），`hitInsideSelf=false`（headed/headless 双证）。
// 机制与症状吻合：正文进框（不需要点击）→ 点发送键被遮罩拦 → 改 Enter（zai 不响应）
// → 再点仍被拦 → `SEND_NOT_CONFIRMED`。
//
// 修法：发送点击前用 elementFromPoint 检测遮罩；产品导览先 Escape 一次再重测，
// 仍被盖住则抛可读的 `WEB_UI_OVERLAY_BLOCKED`；地区弹窗不自动处理（直接抛错）。
test('F16 ① 遮罩判定纯函数：driver-overlay / driver-popover / _modal-overlay 命中 ⇒ blocked', async () => {
  const { overlayBlocksPoint } = await import('../lib/browser-driver.js');
  // 真机形状：命中的是 `.driver-overlay` 内的 <path>，祖先链带 driver-overlay。
  assert.deepEqual(overlayBlocksPoint({
    className: '', ancestorClasses: ['driver-overlay', ''],
    bodyClasses: 'driver-active driver-fade', point: { x: 1209, y: 849 },
  }), { blocked: true, kind: 'driver-tour' }, '导览遮罩盖住目标点 ⇒ 必须 blocked');
  assert.equal(overlayBlocksPoint({ className: 'driver-popover', ancestorClasses: [] }).blocked, true);
  assert.equal(overlayBlocksPoint({ className: '_modal-overlay' }).blocked, true, '地区弹窗也必须被识别');
  assert.equal(overlayBlocksPoint({ className: '_modal-overlay' }).kind, 'modal-overlay');
});

test('F16 ② 遮罩判定纯函数：无遮罩/普通元素 ⇒ 不 blocked（不得误伤正常发送）', async () => {
  const { overlayBlocksPoint } = await import('../lib/browser-driver.js');
  // 正常页面：命中发送按钮本身，body 只有普通 class。
  assert.deepEqual(overlayBlocksPoint({
    className: 'send-button', ancestorClasses: ['composer', 'chat-page'],
    bodyClasses: 'theme-light', point: { x: 1, y: 2 },
  }), { blocked: false, kind: null }, '普通元素不得判成遮罩（否则每轮都会误 Escape/误报）');
  // 只有 body 的 driver-active、但命中点不在 overlay 里 ⇒ 不算盖住目标点。
  assert.equal(overlayBlocksPoint({ className: 'chat-input', ancestorClasses: [], bodyClasses: 'driver-active' }).blocked, false,
    '导览「激活」但没盖住目标点 ⇒ 不得 block（判据是 elementFromPoint 确实命中遮罩）');
  assert.equal(overlayBlocksPoint(null).blocked, false);
  assert.equal(overlayBlocksPoint(undefined).blocked, false);
  assert.equal(overlayBlocksPoint({}).blocked, false);
});

test('F16 ③ 接线：发送点击前必须检测遮罩，且新错误码已登记', async () => {
  const { WEBCODE_CODES } = await import('../lib/error-codes.js');
  // (a) 错误码必须在真源登记表里（未登记会被 error-codes.test.mjs ⑥ 抓出来）。
  assert.ok('WEB_UI_OVERLAY_BLOCKED' in WEBCODE_CODES,
    'WEB_UI_OVERLAY_BLOCKED 必须在 lib/error-codes.js 的 WEBCODE_CODES 登记');
  const block = sendBlock();
  // (b) 检测必须真的**被调用**，且发生在发送点击之前（发送确认段内、路 ① 之前）。
  //     只断言 `overlayBlocksPoint(` 出现在段里是不够的——那可能是函数定义本身
  //     （`detectOverlay` 的 body）；断言检测调用与点击调用的先后，且必须是
  //     **首次检测**（`let overlay = await detectOverlay();`）——只留 Escape 重试
  //     里那一次不算（那时已经点过发送键了）。
  const detectAt = block.indexOf('let overlay = await detectOverlay();');
  const clickAt = block.indexOf('clickSendButton(SEL.sendButton');
  assert.ok(detectAt > 0, '发送段里必须有首次遮罩检测调用 `let overlay = await detectOverlay();`');
  assert.ok(clickAt > detectAt, '遮罩检测必须在发送点击之前——点完再检测就晚了');
  // (c) 命中时要出声：Escape 关导览 + 可读错误码（不是继续走到含糊的 SEND_NOT_CONFIRMED）。
  assert.match(block, /page\.keyboard\.press\('Escape'\)/,
    '产品导览遮罩必须先尝试 Escape 关闭（可逆 UI 操作）');
  assert.match(block, /WEB_UI_OVERLAY_BLOCKED/, '仍被盖住时必须抛可读错误码，不得落到含糊的 SEND_NOT_CONFIRMED');
});
