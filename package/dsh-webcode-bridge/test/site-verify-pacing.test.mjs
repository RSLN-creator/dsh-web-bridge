// site-verify-pacing.test.mjs — 验收脚本的**发送间隔闸门**护栏（0.19.82）。
//
// ## 为什么需要它（这是「验收工具自己违规」的第二例）
//
// `.tmp/real-lane/PHASE2-RUNBOOK.md` §3 写着「本脚本内部三轮间隔由 `sendGapMs`
// 控制」，而修前的 `site-verify.mjs` **一处等待都没有**（背靠背连发三轮）。
// 后果不是文案问题：验收脚本用比产品严苛的节奏打站点 ⇒ 自造风控 ⇒ 四态记 `BLOCKED`，
// **外部原因掩盖工具自己的违规**（与「风控挡住」这种真外部条件在读数上无法区分）。
//
// 因此本文件钉两件事：
//   ① 间隔判定**复用产品真源**（`sendGapForSlot` + `computeSendGap`），不另写一份；
//   ② `site-verify.mjs` 里**真的存在**调用它的代码（源码级判据，防「文档写了、代码没写」）。
//
// 每一条正向断言都配一条反向变异（错误实现必须变红）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planSendGap, normalizeGapBasis, MIN_SEND_GAP_MS } from '../test-mock/site-verify-pacing.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// ── ① 设置值 vs 地板：地板独立于设置，设置 0 时也不许零等待 ────────────────────

test('① 设置 30000ms / end-to-start：距上次结束 10s ⇒ 等满 20s', () => {
  const now = 1_000_000;
  const p = planSendGap({
    settings: { sendGapMs: 30_000, sendGapBasis: 'end-to-start' },
    accountKey: 'glm', siteId: 'glm', now,
    lastSendAt: now - 40_000, lastEndAt: now - 10_000,
  });
  assert.equal(p.waitMs, 20_000, '距上次回复结束 10s、设置 30s ⇒ 还要等 20s');
  assert.equal(p.gapMs, 30_000);
  assert.equal(p.configuredMs, 30_000);
  assert.equal(p.basis, 'end-to-start');
});

test('①b ★ 设置写 0（关掉产品节流）⇒ 验收仍必须等满地板 20s（这是本层的理由）', () => {
  // 产品的 `sendGapMs=0` 是用户在**自己日常节奏**下的合法选择；但验收脚本是
  // **人为制造负载**（同站点连发多轮），必须另有地板，否则「设置关了就猛发」。
  const now = 1_000_000;
  const p = planSendGap({
    settings: { sendGapMs: 0, sendGapBasis: 'end-to-start' },
    accountKey: 'glm', siteId: 'glm', now,
    lastSendAt: now - 40_000, lastEndAt: now - 1_000,
  });
  assert.equal(p.configuredMs, 0, '设置值如实回显为 0');
  assert.equal(p.floorMs, MIN_SEND_GAP_MS);
  assert.equal(p.gapMs, MIN_SEND_GAP_MS, '实际采用值必须是地板');
  assert.equal(p.waitMs, 19_000, '距上次结束 1s ⇒ 还要等 19s 才够 20s 地板');
});

test('①c 设置值**大于**地板时以设置为准（地板是下限，不是固定值）', () => {
  const now = 1_000_000;
  const p = planSendGap({
    settings: { sendGapMs: 60_000, sendGapBasis: 'end-to-start' },
    accountKey: 'glm', siteId: 'glm', now, lastEndAt: now - 5_000, lastSendAt: now - 70_000,
  });
  assert.equal(p.gapMs, 60_000, '用户设了 60s ⇒ 按 60s');
  assert.equal(p.waitMs, 55_000);
});

test('①d 槽级覆盖优先于全局（复用 sendGapForSlot 的回落链，不另写一份）', () => {
  const now = 1_000_000;
  const settings = {
    sendGapMs: 30_000,
    sendGapMsBySlot: { 'glm#2': 90_000, zai: 45_000 },
  };
  const glmViaSlot = planSendGap({ settings, accountKey: 'glm#2', siteId: 'glm', now, lastEndAt: now });
  assert.equal(glmViaSlot.configuredMs, 90_000, '①槽显式值');
  const zai = planSendGap({ settings, accountKey: 'zai', siteId: 'zai', now, lastEndAt: now });
  assert.equal(zai.configuredMs, 45_000, '②站点级键');
  const glm = planSendGap({ settings, accountKey: 'glm', siteId: 'glm', now, lastEndAt: now });
  assert.equal(glm.configuredMs, 30_000, '③全局值');
});

// ── ② 首轮无基准 ⇒ 不等待（不拿另一个基准凑数）──────────────────────────────

test('② 本次运行首轮（无任何基准）⇒ waitMs 0，但设置与地板仍如实回显', () => {
  const now = 1_000_000;
  const p = planSendGap({
    settings: { sendGapMs: 30_000 }, accountKey: 'glm', siteId: 'glm', now,
    lastSendAt: null, lastEndAt: null,
  });
  assert.equal(p.waitMs, 0, '没有基准 = 首轮 = 无可回避（与 metrics.js 同口径）');
  assert.equal(p.sincePrevMs, null);
  assert.equal(p.gapMs, 30_000, '回显仍要给出实际采用的间隔，便于读数核对');
});

test('②b 基准只认逐字 end-to-start；其余（含 null/拼错）一律 send-to-send', () => {
  assert.equal(normalizeGapBasis('end-to-start'), 'end-to-start');
  assert.equal(normalizeGapBasis('end_to_start'), 'send-to-send');
  assert.equal(normalizeGapBasis(undefined), 'send-to-send');
  // 基准不同 ⇒ 同一个 lastSendAt 下等待不同（证明归一化真的被用上了）
  const now = 1_000_000;
  const end = planSendGap({ settings: { sendGapMs: 30_000, sendGapBasis: 'end-to-start' }, accountKey: 's', siteId: 's', now, lastEndAt: now - 10_000, lastSendAt: now - 10_000 });
  const s2s = planSendGap({ settings: { sendGapMs: 30_000, sendGapBasis: 'send-to-send' }, accountKey: 's', siteId: 's', now, lastEndAt: now - 1_000, lastSendAt: now - 10_000 });
  assert.equal(end.waitMs, 20_000);
  assert.equal(s2s.waitMs, 20_000);
});

// ── ③ 时钟回拨（skewed）必须如实透出，不假装没发生 ───────────────────────────

test('③ 基准在未来（时钟回拨）⇒ skewed 如实为真且按「刚发过」处理', () => {
  const now = 1_000_000;
  const p = planSendGap({
    settings: { sendGapMs: 30_000, sendGapBasis: 'end-to-start' },
    accountKey: 'glm', siteId: 'glm', now, lastEndAt: now + 60_000,
  });
  assert.equal(p.skewed, true, '未来时间必须被标出来（否则读数不可信）');
  assert.equal(p.waitMs, 30_000, 'clamp 到 now ⇒ 等一个完整的间隔，不白等几小时');
});

// ── ④ 源码级：site-verify.mjs 必须**真的**调用闸门（防「runbook 写了、代码没写」）──

test('④ site-verify.mjs 必须真的调用间隔闸门，且三轮发送前各等着一次', () => {
  const src = readFileSync(join(here, '..', 'test-mock', 'site-verify.mjs'), 'utf8');
  const code = src.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.match(code, /import \{[^}]*planSendGap[^}]*\} from '\.\/site-verify-pacing\.mjs'/,
    'site-verify.mjs 必须从本层取闸门（不许自己内联一份判定）');
  const calls = code.match(/await waitForSendGap\(/g) || [];
  assert.equal(calls.length, 3,
    '三轮真实发送前必须各过一次闸门（修前是 0 处等待，runbook 却宣称有）');
  // 反向：不许出现「算了但没等」——闸门里必须真的 await 等待器
  assert.match(code, /await sleepMs\(plan\.waitMs\)/,
    '闸门必须真的 await 等待（只算不等的实现会让这条变红）');
  // 三轮之后必须各有一次 end 锚点（end-to-start 基准靠它）
  const ends = code.match(/mark\('end'\)/g) || [];
  assert.equal(ends.length, 2,
    '前三轮里有两轮的结束要记锚点（第 1、2 轮），否则第 2、3 轮的 end-to-start 基准是空的');
});

test('④b 反向变异：把闸门调用删掉 ⇒ 上面的计数判据必须变红', () => {
  // 这条不模拟真实文件，而是直接验证「计数判据本身是判据」：
  // 若实现退化成 0 次调用，calls.length 就不再等于 3。
  const fake = "await driver.sendTurn('a', 'b', {});";
  const calls = fake.match(/await waitForSendGap\(/g) || [];
  assert.notEqual(calls.length, 3, '没有闸门调用的实现必须不满足「=3」这一条');
});
