// attach-selfheal.test.mjs — 0.16.28 护栏：附件「零回复」自愈降级。
//
// 0.16.7 的真机签名（DeepSeek：附件传得上、页面有卡片、当轮零回复）当时只能用
// 静态禁令止血，台账「仍未做 §2」挂账的理想形态是「附件投递后零回复 ⇒ 自动降级
// 并记住」。本文件钉自愈判据的行为：命中 → 该站点立即回落 inline 并被记住；
// 未命中 → 其它站点不受牵连；幂等 → 保留首次现场。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ATTACH_FORBIDDEN_SITES, attachForbiddenFor, dynamicAttachBlock, markDynamicAttachBlock, promptTransportPlan } from '../lib/browser-driver.js';

const pkg = path.dirname(import.meta.dirname);

test('静态禁令仍在：deepseek 永远不许走附件（0.16.7 站点契约原样保留）', () => {
  assert.ok(ATTACH_FORBIDDEN_SITES.has('deepseek'), 'deepseek 必须在静态禁令表里');
  assert.ok(attachForbiddenFor('deepseek'), 'attachForbiddenFor(deepseek) 必须为真');
  assert.equal(promptTransportPlan({ chars: 1_000_000, inlineLimit: 60_000, attachEnabled: true, attachSupported: true, attachForbidden: attachForbiddenFor('deepseek'), transport: 'attach' }).mode,
    'inline', 'deepseek 超长也必须 inline（site-no-attach）');
});

test('运行期禁令：命中零回复签名 → 立即回落 inline 并记住现场', () => {
  const site = 'glm-selfheal-' + Date.now(); // 不污染其它用例的进程级状态
  assert.equal(dynamicAttachBlock(site), null, '初始无运行期禁令');
  assert.ok(attachForbiddenFor(site) === false, '初始不拦');
  assert.equal(markDynamicAttachBlock(site, 71_994), true, '首次记录返回 true');
  const block = dynamicAttachBlock(site);
  assert.equal(block.code, 'ATTACH_ZERO_REPLY', '现场必须带判据码');
  assert.equal(block.total, 71_994, '现场必须带本轮提示词总量');
  assert.ok(Number.isFinite(block.at) && block.at > 0, '现场必须带时刻');
  assert.ok(attachForbiddenFor(site), '命中后该站点必须被拦');
  assert.equal(promptTransportPlan({ chars: 1_000_000, inlineLimit: 60_000, attachEnabled: true, attachSupported: true, attachForbidden: attachForbiddenFor(site), transport: 'attach' }).reason,
    'site-no-attach', '命中后超长也必须走 inline/site-no-attach');
});

test('幂等：重复命中保留首次现场（不刷新时刻，便于归因）', () => {
  const site = 'glm-idem-' + Date.now();
  markDynamicAttachBlock(site, 111);
  const first = dynamicAttachBlock(site);
  assert.equal(markDynamicAttachBlock(site, 222), false, '第二次记录返回 false');
  const second = dynamicAttachBlock(site);
  assert.equal(second.at, first.at, '时刻必须是首次的');
  assert.equal(second.total, 111, '总量必须是首次的');
});

test('未命中站点不受牵连：禁令按站点隔离', () => {
  const a = 'glm-iso-a-' + Date.now();
  const b = 'glm-iso-b-' + Date.now();
  markDynamicAttachBlock(a, 50_000);
  assert.ok(attachForbiddenFor(a), '被记站点要拦');
  assert.equal(attachForbiddenFor(b), false, '未命中站点不许被牵连');
});

// —— 源码结构钉子（与 upload-attachment-structure.test.mjs 同一取舍：钉接线事实，
//    不证明真机走到——真机判据见 doc/progress.md §0.16.28 五。5） ————————————

test('结构：整轮超时处理器必须带附件零回复的自愈补位（timeout 签名）', () => {
  const src = fs.readFileSync(path.join(pkg, 'lib', 'browser-driver.js'), 'utf8');
  const timeoutIdx = src.indexOf("lastEndReason = 'timeout'");
  assert.ok(timeoutIdx > 0, "找不到超时写入点 lastEndReason = 'timeout'");
  const window = src.slice(timeoutIdx, timeoutIdx + 900);
  assert.match(window, /markDynamicAttachBlock\(/, '超时点必须尝试记录运行期禁令');
  assert.match(window, /replyChars === 0/, '只有「页面无回复文本」才算零回复（已有 N 字未回传是捕获问题，不降级）');
  assert.match(window, /!attachTransport\.fallback/, '回落 inline 的轮不算附件轮（没有附件可怀疑）');
});
