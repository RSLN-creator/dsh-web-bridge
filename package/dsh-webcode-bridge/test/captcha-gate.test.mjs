// captcha-gate.test.mjs — 护栏：站点人机验证闸门必须**提前如实报错**，不得伪装成「网页没回传」。
//
// ## 这个文件防的是哪一次真缺陷（z.ai，2026-09-27）
//
// 用户报障原文：
//
//   本轮运行失败WEB_NO_PROGRESS: 网页侧超过 120s 没有任何新内容（页面在，判定相位=网页还没
//   开口且驱动不在忙（按常规窗口未宽限），最近驱动活动时间 1s 前，页面已有 7 字回复未回传）
//
// 真因（真机四轮 + 站点自带前端 bundle 逐字片段，证据 `.tmp-probe/zai/RESULT.md`）：
// `/api/config.features.enable_captcha = true` ⇒ 前端在发请求**之前** `await HN()`
// （阿里云滑块）；自动化环境下它不返回 ⇒ `bhe()`（`POST /api/chat/completions`）
// **永不执行** ⇒ wire 上零帧。也就是说：**消息根本没被受理**，而那句「页面已有 7 字
// 回复未回传」是**假读数**——旧 `answerSelector` 尾部的 `[class*="message"]` 命中了
// 输入框容器 `div.messageInputContainer`，其 innerText 恰为「深度思考\n最高」= 7 字。
//
// 这条报错把排查方向引向了「解码器对不上」（zai 的 decoder 曾被怀疑是根因），而真因
// 在风控闸门上。按本仓库纪律「报错必须指向真因」，假读数比没有读数更贵。
//
// ## 判据
//
//   ① 站点声明位存在（`captchaSelector`），且 z.ai 上非空——没有它接线就是死的；
//   ② 驱动**读**这个声明位（按站点名硬编码不算：站点知识必须收口在 providers.js）；
//   ③ 检查必须发生在 `send confirmed` **之后**——在它之前查会把 SEND_NOT_CONFIRMED /
//      PROMPT_TRUNCATED 这些真错误盖掉；
//   ④ 抛错的码是 `WEB_CAPTCHA_REQUIRED`，且文案要给出可行动处置（手动完成验证后重试），
//      并且**明确否掉**「网页没回传 / 解码器」这两个误导方向；
//   ⑤ 有头时把窗口带到前台（验证只能由人完成，我们能做的是让窗口可见）。
//
// 刻意**不**断言的事：不断言它去破解验证。绕站点风控不在本项目范围内——这个闸门的
// 全部意义是「如实告诉用户发生了什么事」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SITES, ZAI } from '../lib/providers.js';

const PKG = path.join(import.meta.dirname, '..');
const DRIVER = fs.readFileSync(path.join(PKG, 'lib', 'browser-driver.js'), 'utf8');

test('① z.ai 必须声明人机验证选择器（真机 bundle 证据：features.enable_captcha=true）', () => {
  assert.equal(typeof ZAI.captchaSelector, 'string', 'ZAI 必须声明 captchaSelector');
  assert.ok(ZAI.captchaSelector.trim().length > 0, 'captchaSelector 不得为空串（空串等于没声明）');
  // 真机实测可见的两个节点（`.tmp-probe/zai/RESULT.md`）：一个是容器的 id，一个是弹窗。
  assert.match(ZAI.captchaSelector, /chat-captcha-element/, '必须包含真机实测的 #chat-captcha-element');
  assert.match(ZAI.captchaSelector, /aliyunCaptcha/, '必须包含真机实测的阿里云弹窗节点');
  // 站点表里只有 z.ai 声明它（其余站点没有这条读数，不许顺手加上）。
  const declared = SITES.filter((s) => s.captchaSelector).map((s) => s.id);
  assert.deepEqual(declared, ['zai'],
    'captchaSelector 只允许写在**有真机读数**的站点上；实际 ' + JSON.stringify(declared));
});

test('② 驱动必须读站点声明位，而不是按站点名硬编码', () => {
  assert.match(DRIVER, /site\.captchaSelector/, '驱动没有读 site.captchaSelector：声明位是死的');
  assert.ok(!/'zai'\s*===?\s*siteId[\s\S]{0,200}captcha/i.test(DRIVER),
    '不允许按站点名硬编码验证闸门——站点知识必须收口在 providers.js');
});

test('③ 检查必须发生在「发送已确认」之后（否则会盖掉真错误）', () => {
  const confirmAt = DRIVER.indexOf("log('send confirmed (composer cleared / navigated) url='");
  assert.ok(confirmAt > 0, '找不到发送确认点');
  // ⚠ 0.19.83 起 `WEB_CAPTCHA_REQUIRED` 在源文件里有**两处**：①「发送后那次采样」的
  // 闸门（本条要判的就是它），②**超时点**的延迟归因（doubao 图片选择式验证是发送
  // **之后**才弹出的，发送后 2.5s 那一次采样对它瞎 —— 见 long-term-issues #63）。
  // 两者在源码里的先后与执行先后无关（超时定时器在发送**之前**就已挂上），
  // 所以这里必须**按位置**取「发送确认之后的那一处」，而不是 `indexOf` 的第一处。
  // 取错位置会让本条判一个与发送顺序无关的代码块（首版就是这么写坏的）。
  const gateAt = DRIVER.indexOf('WEB_CAPTCHA_REQUIRED', confirmAt);
  assert.ok(gateAt > 0, '发送确认之后找不到 WEB_CAPTCHA_REQUIRED 的抛错点');
  // 也必须在「发送前预算/回读校验」之后——那两条同样是会给出更准确归因的真错误。
  const truncAt = DRIVER.indexOf('PROMPT_TRUNCATED: 网页输入框只接收了');
  assert.ok(truncAt > 0, '找不到 PROMPT_TRUNCATED 的抛错点');
  assert.ok(gateAt > truncAt, '验证检查必须晚于输入框回读校验（那是更准确的归因）');
  // 超时点那一处（延迟归因）必须**存在**——它是 #63 的修复本体（doubao 的验证在
  // 发送之后才弹出，发送后的一次采样抓不到）。
  //
  // ⚠ 锚点必须用**只属于超时块**的字符串。首版写成「在 `web turn timed out after`
  //   之前 6000 字符内找 `WEB_CAPTCHA_REQUIRED`」，反向变异（把整块删掉）**仍然 PASS**
  //   —— 因为删掉之后那个窗口落到**发送后闸门**的码上，判据照样成立。
  //   教训与 #68 那条同型：**护栏若只匹配「名字出现过」，它判的是文本，不是实现。**
  const timeoutMarker = DRIVER.indexOf('captcha gate hit at timeout');
  assert.ok(timeoutMarker > 0, '找不到超时点的验证归因（#63：doubao 延迟弹出的图片式验证）');

  // 真正要防的是「白等 120s」，而发送后那一次采样由下面这条保证：
  // 检查是**一次采样**、不轮询，因此用户在验证弹出后 3 秒内就能拿到可行动的报错。
  const sampling = DRIVER.indexOf('await page.waitForTimeout(2_500)');
  assert.ok(sampling > 0 && sampling < gateAt,
    '验证检查必须有「发送后的一次采样」（2.5s 内定性），不得改成轮询等超时');
});

test('④ 错误码与文案：指向真因、给出可行动处置、并否掉两个误导方向', () => {
  // 同样取「发送确认之后」的那一处（理由见 ③ 的注释：源文件里有两处闸门）。
  const confirmAt = DRIVER.indexOf("log('send confirmed (composer cleared / navigated) url='");
  const at = DRIVER.indexOf('WEB_CAPTCHA_REQUIRED', confirmAt);
  const seg = DRIVER.slice(at, at + 900);
  // 0.19.54：码改走 `withWebcodeCode`（唯一真源，同时挂 `failure` 快照）。
  // 裸 `err.code = '…'` 不带快照 ⇒ 码在 harness 边界被归一化成 `UNKNOWN`，
  // 实测 137/137。故这里**同时**断言新形状与否定旧形状。
  assert.match(seg, /withWebcodeCode\(err,\s*'WEB_CAPTCHA_REQUIRED'\)/, '必须经错误码真源挂码');
  assert.ok(!/err\.code\s*=\s*'WEB_CAPTCHA_REQUIRED'/.test(seg),
    '不得回退成裸赋值（那样码会被 harness 归一化成 UNKNOWN）');
  assert.match(seg, /手动完成验证/, '文案必须给出可行动处置（手动完成验证后重试）');
  assert.match(seg, /未被网页受理/, '文案必须说明「消息未被受理」这一事实');
  assert.ok(/不是解码器问题|解码器/.test(seg),
    '文案必须否掉「解码器」这个误导方向（本轮真因不在解码器）');
  assert.ok(/零帧|wire/.test(seg), '文案必须解释「wire 上零帧」这个现场');
});

test('④b 超时点那处归因也必须挂同一个码、给同一套处置（#63）', () => {
  // ⚠ 锚点用**只属于超时块**的字符串（`captcha gate hit at timeout`），并在它附近
  //   取码与文案。首版用「`web turn timed out after` 之前 6000 字符内找
  //   `WEB_CAPTCHA_REQUIRED`」⇒ 把整块删掉后窗口落到**发送后闸门**上、**仍然 PASS**
  //   （反向变异当场抓到）。护栏必须锚在「只有这个实现才会出现的字符串」上。
  const at = DRIVER.indexOf('captcha gate hit at timeout');
  assert.ok(at > 0, '找不到超时点归因块（#63）');
  // ⚠ 窗口要够宽：0.19.83 起这一段包含「逐 frame 查」的循环与 probe 诊断，
  //   300 字符的右窗看不到 `CHALLENGE_PATTERN_SOURCES` 与 `page.frames?.()`
  //   （它们分别在锚点**之前**约 900 字符处，故左窗 2600 覆盖）。
  const seg = DRIVER.slice(Math.max(0, at - 2600), at + 400);
  assert.match(seg, /withWebcodeCode\(err,\s*'WEB_CAPTCHA_REQUIRED'\)/, '超时点归因也要经错误码真源挂码');
  assert.match(seg, /手动完成验证/, '超时点文案也必须给可行动处置（否则用户仍只会看到「超时」）');
  assert.match(seg, /未被网页受理/, '超时点文案也必须说明消息未被受理');
  assert.ok(/不是解码器问题|网页没回传/.test(seg),
    '超时点文案必须否掉「网页没回传 / 解码器」这两个误导方向');
  // 判据②（文案指纹）：doubao **没有声明** `captchaSelector`，只靠站点声明会继续漏。
  // ⚠ 0.19.83 起词表**不再内联**在驱动里——它是 `lib/challenge-heuristics.js` 的
  //   唯一真源，由驱动以 `source` 传参在页面侧重建。所以这里断言的是**接线**
  //   （驱动确实注入了那个真源），而不是「超时块里有没有一段正则字面量」。
  assert.match(seg, /CHALLENGE_PATTERN_SOURCES/, '超时点必须注入 challenge-heuristics 的文案指纹（不依赖站点声明）');
  // ⚠ 0.19.83 真机复验逼出的第二条：**必须逐 frame 查**。`page.evaluate` 只跑主框架，
  //   而风控/人机验证普遍渲染在独立 iframe 里 ⇒ 只查主框架的实现在那种形态下必然漏。
  //   真机读数：修完重跑 doubao 仍是 `web turn timed out`（**不是**验证归因）。
  assert.match(seg, /page\.frames\?\.\(\)/, '超时点必须逐 frame 查（page.evaluate 只跑主框架，验证常渲染在 iframe 里）');
  const HEUR = fs.readFileSync(path.join(PKG, 'lib', 'challenge-heuristics.js'), 'utf8');
  // 真机 doubao 那句原文的关键措辞必须在唯一真源里（改错了这里就红）
  assert.match(HEUR, /请选择所有符合/, '词表真源必须含 doubao 真机的「请选择所有符合」');
  assert.match(HEUR, /并拖拽到下方/, '词表真源必须含 doubao 真机的「并拖拽到下方」');
});

test('⑤ 有头时必须把验证窗口带到前台（验证只能由人完成）', () => {
  const at = DRIVER.indexOf('WEB_CAPTCHA_REQUIRED');
  const seg = DRIVER.slice(Math.max(0, at - 1200), at);
  assert.match(seg, /bringToFront/, '命中验证时必须把页面带到前台，否则有头窗口藏在后面用户点不到');
});
