// continue-budget.test.mjs — 0.19.3 护栏：自动续跑的「整会话累计」与完整提醒升级点。
//
// ## 用户指令（原话）
//
// 「加"整会话累计"：超过 N 次就改为发完整提醒，优先保证长上下文循环问题！解决！」
// 「A+C：但是不能停！继续后续需要 auto！！我说我需要真实长上下文你不理解吗？？能够做到！！
// 不要停！」
//
// 因此这条护栏要同时钉住**两件方向相反**的事：
//   · 累计真的起作用（超过 N 就换形态）；
//   · 累计**不是刹车**（换形态之后续跑照旧，绝不因为计数而停手）。
// 只钉前一条会把功能做成用户明确否掉的样子；只钉后一条则等于什么都没加。
//
// ## 还钉住「整会话」的跨进程语义
//
// 计数落盘（`continuations/<sessionKey>.json`）：本项目的常态操作是重启 dsh web，
// 只放内存会把「整会话」悄悄降级成「每进程」。这里用「新建一个计数器实例仍读回同一个值」
// 来代表重启，而不是靠读源码猜。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  continueFormFor,
  continuationFilePath,
  createContinueCounter,
  DEFAULT_CONTINUE_COMPLETE_AFTER,
} from '../lib/continue-budget.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const src = fs.readFileSync(path.join(repoRoot, 'lib', 'index.js'), 'utf8');

/** 工作区内建临时目录：沙箱只允许写工作区，用它代表真实落盘根。 */
function tempDir() {
  return fs.mkdtempSync(path.join(repoRoot, 'test', '.tmp-continue-'));
}

/**
 * 落盘路径受控的计数器：**显式传 env（不含 NODE_TEST_CONTEXT）**。
 *
 * 为什么必须显式传而不是依赖环境：模块的落盘守卫是
 * `NODE_TEST_CONTEXT 存在且未指定 WEBCODE_CONTINUE_STATE_DIR ⇒ 只走内存`，
 * 而 CI 与本地复核都会设 `NODE_TEST_CONTEXT`——靠环境决定行为的用例会在
 * 一种条件下绿、另一种条件下红（本用例初版就真的这样红过一次）。
 * 这里把「这条用例要验的是落盘」写死在入参里，两种条件下行为一致。
 */
const persistentCounter = (dir) => createContinueCounter({ dir, env: {} });

// ---------------------------------------------------------------------------
// ① 判据（纯函数）
// ---------------------------------------------------------------------------

test('① 升级点语义：> N 才升级，N 次以内仍是短提示', () => {
  assert.equal(DEFAULT_CONTINUE_COMPLETE_AFTER, 3, '默认 N 必须是用户选的 3');
  for (const cumulative of [1, 2, 3]) {
    assert.equal(continueFormFor({ cumulative, after: 3 }), 'short', `第 ${cumulative} 次仍在升级点以内`);
  }
  assert.equal(continueFormFor({ cumulative: 4, after: 3 }), 'complete', '第 4 次（超过 3）起改用完整提醒');
  assert.equal(continueFormFor({ cumulative: 99, after: 3 }), 'complete');
});

test('①b 边界：after=0 是「不升级」而不是「立即升级」', () => {
  assert.equal(continueFormFor({ cumulative: 1, after: 0 }), 'short');
  assert.equal(continueFormFor({ cumulative: 999, after: 0 }), 'short',
    '0 是用户关掉这条策略的唯一含义；读成「立即升级」会让关不掉');
  for (const after of [-1, NaN, 'x', null]) {
    assert.equal(continueFormFor({ cumulative: 999, after }), 'short', `非法升级点 ${String(after)} 必须退化成不升级`);
  }
  // undefined 是**另一个含义**：取默认升级点 3（调用方 `cfg.x ?? DEFAULT` 的口径），
  // 不是「非法值」。把它混进上面那组会把「漏传 = 用默认」误判成「关掉策略」。
  assert.equal(continueFormFor({ cumulative: 999, after: undefined }), 'complete',
    'undefined = 取默认升级点，因此 999 次仍升级');
  for (const cumulative of [NaN, -3, 'x', null, undefined]) {
    assert.equal(continueFormFor({ cumulative, after: 3 }), 'short', `非法累计 ${String(cumulative)} 不得触发升级`);
  }
});

// ---------------------------------------------------------------------------
// ② 计数
// ---------------------------------------------------------------------------

test('② bump 逐次自增、peek 不改变值、reset 归零', () => {
  const dir = tempDir();
  try {
    const counter = persistentCounter(dir);
    assert.equal(counter.peek('s1'), 0, '首次读到 0（不是 undefined）');
    assert.equal(counter.bump('s1'), 1);
    assert.equal(counter.bump('s1'), 2);
    assert.equal(counter.peek('s1'), 2, 'peek 不得自增');
    assert.equal(counter.peek('s1'), 2);
    assert.equal(counter.bump('s2'), 1, '会话之间互不影响');
    counter.reset('s1');
    assert.equal(counter.peek('s1'), 0);
    assert.equal(counter.peek('s2'), 1, 'reset 只能清一个会话');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('②b 「整会话」跨进程成立：新实例（=重启）读回同一个累计值', () => {
  const dir = tempDir();
  try {
    const before = persistentCounter(dir);
    before.bump('sess-a'); before.bump('sess-a'); before.bump('sess-a');
    const afterRestart = persistentCounter(dir);
    assert.equal(afterRestart.peek('sess-a'), 3, '累计必须落盘——否则「整会话」会退化成「每进程」');
    assert.equal(afterRestart.bump('sess-a'), 4);
    assert.equal(continueFormFor({ cumulative: afterRestart.peek('sess-a'), after: 3 }), 'complete',
      '重启之后升级点依然可达（这正是它要解决的场景）');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('②c 计数文件路径：continuations/ 子目录 + 会话键消毒（不逃出目录）', () => {
  const file = continuationFilePath('/root', 'sess::agent/../../evil');
  assert.ok(file.replace(/\\/g, '/').endsWith('/continuations/sess__agent________evil.json') || /continuations[/\\][A-Za-z0-9_-]+\.json$/.test(file),
    `会话键必须被消毒成单段安全 token：${file}`);
  assert.ok(!path.relative(path.join('/root', 'continuations'), file).startsWith('..'),
    '消毒后不得逃出 continuations/');
});

test('②d 测试进程守卫：无显式目录时不写真实存储根', () => {
  const dir = tempDir();
  try {
    // 守卫本身要验的就是「NODE_TEST_CONTEXT 在场」，所以把 env **显式**交给模块，
    // 不改全局 process.env：用例之间不再互相影响，两种环境条件下判据相同。
    const counter = createContinueCounter({ dir, env: { NODE_TEST_CONTEXT: '1' } });
    counter.bump('sess-guard'); counter.bump('sess-guard');
    assert.equal(counter.peek('sess-guard'), 2, '内存里照常计数（策略不受影响）');
    assert.equal(fs.existsSync(continuationFilePath(dir, 'sess-guard')), false,
      'NODE_TEST_CONTEXT 在场且未指定 WEBCODE_CONTINUE_STATE_DIR 时不得落盘——否则跑一次测试就污染用户真实累计值');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('②e 落盘失败/文件损坏都不许抛出（读回 0 即可）', () => {
  const dir = tempDir();
  try {
    const counter = persistentCounter(dir);
    counter.bump('sess-bad');
    fs.writeFileSync(continuationFilePath(dir, 'sess-bad'), '{ 这不是 JSON');
    const fresh = createContinueCounter({ dir });
    assert.equal(fresh.peek('sess-bad'), 0, '损坏的计数文件按 0 处理，绝不抛出');
    // 目录不可写时同样只能退化成内存计数。
    const unwritable = persistentCounter(path.join(dir, 'nope', 'deep'));
    assert.equal(unwritable.bump('x'), 1);
    assert.equal(unwritable.bump('x'), 2, '落盘失败不影响本进程内的计数与升级点');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// ③ 接线（本模块只在被真的用上时才有价值）
// ---------------------------------------------------------------------------

test('③ 配置项存在且默认就是升级点常数', () => {
  assert.match(src, /autoContinueCompleteAfter: DEFAULT_CONTINUE_COMPLETE_AFTER/,
    'DEFAULTS 必须声明升级点，否则「可配置」只对了一半（同 answerTimeoutMs 的教训）');
  assert.match(src, /continueFormFor\(\{ cumulative, after: completeAfter \}\)/,
    '形态必须由 continueFormFor 判定，不许在续跑路径上另写一遍比较');
});

test('③b 累计只在补发**确认送出**后落账（发送抛错不占额度）', () => {
  const body = autoContinueBody();
  assert.match(body, /continueCounter\.peek\(sessionKey\) \+ 1/, '形态判据用预期序号（peek + 1）');
  const submitAt = body.indexOf('await relay.submit(');
  const bumpAt = body.indexOf('continueCounter.bump(sessionKey)');
  assert.ok(submitAt >= 0 && bumpAt > submitAt, 'bump 必须出现在 relay.submit 之后');
  assert.match(body, /catch \(err\) \{[\s\S]*?return null;/, '发送抛错仍交回 null（不落账、不说「已补发」）');
});

test('③c 累计不是刹车：唯一的 disabled 出口是「续跑被关 / 无会话键」', () => {
  const body = autoContinueBody();
  const hits = body.match(/disabled: true/g) || [];
  assert.equal(hits.length, 1, `autoContinueRound 里只许有一个 disabled 出口，实际 ${hits.length} 个`);
  assert.match(body, /if \(rounds < 1 \|\| !turn\.meta\?\.sessionKey\) return \{ disabled: true/,
    '那个出口必须只由 rounds/会话键决定——绝不能由累计次数决定（用户原话：不能停）');
  assert.ok(!/cumulative\s*>\s*completeAfter[\s\S]{0,200}disabled: true/.test(body),
    '累计越过升级点之后不得走 disabled 分支');
});

test('③d 完整提醒取「会话教学正本」，与首轮教学逐字同源', () => {
  const body = autoContinueBody();
  assert.match(body, /siteTeachingBySession\.get\(sessionKey\)/,
    '完整提醒必须优先取会话教学正本（首轮真实发出去的那一份）');
  assert.match(body, /buildPreset\(\{ tools, siteId \}\) \+ teachFor\(siteId, tools\)/,
    '正本缺失时回落现算，且必须用同一组 builder');
  assert.match(src, /const siteText = buildPreset\(\{ \.\.\.options, extraPrompt, sitePrompt, siteId \}\) \+ teachFor\(siteId, options\.tools\);/,
    'buildTurn 必须把同一份 siteText 既落盘又存进正本表');
  assert.match(src, /rememberSiteTeaching\(keyPath, siteText\)/);
  // 完整提醒自带协议段，因此两支必须互斥——否则同一份协议文本会在一轮里发两遍。
  assert.match(body, /completeTeaching[\s\S]{0,40}\?[\s\S]{0,900}: \(transport \?/, '完整提醒与「仅协议段」必须二选一');
});

test('③e 八处进度说明出口共用一处读数口径（不许有出口静默漏掉升级状态）', () => {
  // 逐行匹配（调用点各占一行；参数里含 `)`，因此不能用 `[^)]*`）。
  const sites = src.match(/autoContinuedNotice\(\{[^\n]*\}\)/g) || [];
  assert.ok(sites.length >= 8, `进度说明出口应至少 8 处，实际 ${sites.length}`);
  const missing = sites.filter((s) => !s.includes('continueNoticeFields(cont)') && !s.includes('disabled: true'));
  assert.deepEqual(missing, [], `有出口没带累计/形态读数：${missing.join(' | ')}`);
});

/** 取 autoContinueRound 的函数体（含结尾分号），供结构断言使用。 */
function autoContinueBody() {
  const start = src.indexOf('const autoContinueRound = async');
  assert.ok(start >= 0, '找不到 autoContinueRound：接线被改名或删除');
  const end = src.indexOf('const continueNoticeFields');
  assert.ok(end > start, '找不到 autoContinueRound 的结束边界（continueNoticeFields 标记）');
  return src.slice(start, end);
}
