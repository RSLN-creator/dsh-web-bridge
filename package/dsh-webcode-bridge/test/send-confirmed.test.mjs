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
