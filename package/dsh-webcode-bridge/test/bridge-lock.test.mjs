// bridge-lock.test.mjs — 用户准则「同一账号不能同时桥接运行」（0.19.18；0.19.22 补存活判据）。
//
// ## 这条准则为什么必须有护栏
//
// 它的失败形态**不出现在正常路径里**，只在「同时开两个」时出现——而正常测试永远
// 只开一个。因此它必须由**纯函数真值表** + **真实文件系统往返** + **真进程存活**
// 三层钉住，不能靠「人记得去开两个进程试试」。
//
// ## 0.19.22 为什么同时要钉住「误拒」这一侧
//
// 真机事故：进程被强杀后锁留在盘上，12 小时内**连刚重启的主人都被拒**（glm 与
// deepseek 双双中招）。所以判据有两个方向，**两个方向都要有红得起来的护栏**：
//
//   · 误放（两个桥同时跑）—— 用「持有者活着 ⇒ 必须拒绝」钉住（②g / ③）；
//   · 误拒（自己的旧锁把自己挡住）—— 用「持有者已死 ⇒ 必须接管」钉住（②f / ①g）。
//
// 只测一个方向等于没测：把判据改成 `return free` 能过掉全部「误放」用例，
// 改成 `return held` 能过掉全部「误拒」用例。本文件每次成对出现。
//
// 本文件覆盖：
//   ① 纯函数 `decideBridgeLock` 的全部边界（无锁/坏值/自己人/上一个化身/别人持锁/
//     持有者已死/过期/isAlive 判据失效）；
//   ② `acquireBridgeLock` 的文件系统往返（拿锁→重入→被别人拒→释放→可再拿→
//     接管死锁→退出兜底）；
//   ③ **并发竞争**：用 `wx` 独占创建保证只有一个赢家；
//   ④ `releaseBridgeLock` **只释放自己的**（不删别人的锁）——最危险的边界：
//      无条件删文件会在「我已过期被接管、新持有者正在跑」时把别人的锁删掉，
//      于是两个桥同时跑，准则被绕过；
//   ⑤ 报错文案（用户要看得懂、要知道怎么办）；
//   ⑥ 驱动器接线（`BRIDGE_ACCOUNT_BUSY` + launch 前拿锁 + close 时释放）；
//   ⑦ **真进程存活**（起一个真 node 子进程）：活着⇒拒、死后⇒接管，**不注入任何桩**。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  decideBridgeLock, acquireBridgeLock, releaseBridgeLock, isProcessAlive,
  releaseAllBridgeLocks, heldBridgeLockPaths,
  describeBridgeLockHolder, BRIDGE_LOCK_FILE, DEFAULT_BRIDGE_LOCK_STALE_MS,
} from '../lib/bridge-lock.js';

/** 每个用例一个独立临时目录，互不干扰。 */
function tmpDir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `bridge-lock-${tag}-`));
  return d;
}

const live = () => true;     // 「持有者还活着」的桩
const dead = () => false;    // 「持有者已死」的桩

/** 起一个真 node 子进程，停在那儿等被杀；返回 { pid, stop }。 */
function spawnIdleNode() {
  // stdio:'ignore'：本仓库的受限沙箱下管道式 stdio 会被拒（EPERM），
  // 而这个子进程永远不产出，也不需要读它的输出。
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' });
  return {
    pid: child.pid,
    stop: () => new Promise((resolve) => {
      child.once('exit', () => resolve(child.pid));
      try { child.kill(); } catch { resolve(child.pid); }
    }),
  };
}

// ───────────────────── ① 纯函数：三态真值表 ─────────────────────

test('① decideBridgeLock：没有锁 / 坏值 / 数组 ⇒ free', () => {
  const now = 1_800_000_000_000;
  for (const bad of [null, undefined, '', 0, 'str', [], true]) {
    const v = decideBridgeLock(bad, now, { pid: 111, startedAt: 1 });
    assert.equal(v.state, 'free', `输入 ${JSON.stringify(bad)} 应为 free`);
  }
});

test('①b decideBridgeLock：锁没有可用 pid ⇒ free（不当成有效持有者）', () => {
  const now = 1_800_000_000_000;
  for (const pid of [0, -1, 'abc', null, undefined, NaN]) {
    const v = decideBridgeLock({ pid, at: now - 1000 }, now, { pid: 111, startedAt: 1 });
    assert.equal(v.state, 'free', `pid=${pid} 应为 free`);
  }
});

test('①c decideBridgeLock：同 pid 同启动时刻 = mine；同 pid 不同时刻 = 本进程上一个化身 ⇒ free', () => {
  const now = 1_800_000_000_000;
  const lock = { pid: 4242, startedAt: 777, at: now - 1000 };
  // 都对得上 ⇒ mine（重入，不重复写）
  assert.equal(decideBridgeLock(lock, now, { pid: 4242, startedAt: 777 }).state, 'mine');
  // 0.19.22 语义变更：pid 在活进程之间唯一 ⇒ 同 pid 的锁**不可能**是别人的。
  // 只可能是本进程的上一个化身（插件热重载）或「死进程的 pid 被我接手」，
  // 两者都该覆盖。旧版这里返回 held，于是热重载会把自己锁在门外。
  const previous = decideBridgeLock(lock, now, { pid: 4242, startedAt: 888 });
  assert.equal(previous.state, 'free');
  assert.equal(previous.reason, 'previous-incarnation');
  assert.equal(previous.stale, true, '接管必须留痕');
  // 都不是 ⇒ 见 ①d
});

test('①d decideBridgeLock：别人持锁 + 持有者活着 + 未过期 ⇒ held（含现场）', () => {
  const now = 1_800_000_000_000;
  const lock = { pid: 5555, startedAt: 1, at: now - 60_000, siteId: 'glm', accountKey: 'glm' };
  // 不注入 isAlive：判据缺席 ⇒ 保持 0.19.18 的行为（保守拒绝）
  const bare = decideBridgeLock(lock, now, { pid: 111, startedAt: 2 });
  assert.equal(bare.state, 'held');
  assert.equal(bare.holder.pid, 5555);
  assert.equal(bare.stale, false);
  // 注入「活着」⇒ 同样 held
  assert.equal(decideBridgeLock(lock, now, { pid: 111, startedAt: 2, isAlive: live }).state, 'held');
});

test('①e decideBridgeLock：超过 staleMs ⇒ free 且标记 stale（有界，不会永久挡人）', () => {
  const now = 1_800_000_000_000;
  const lock = { pid: 5555, at: now - DEFAULT_BRIDGE_LOCK_STALE_MS - 1 };
  const v = decideBridgeLock(lock, now, { pid: 111, startedAt: 2 });
  assert.equal(v.state, 'free');
  assert.equal(v.stale, true, '必须标记 stale 以便调用方留痕');
  // 边界：恰好等于上限 ⇒ 不算过期（用 > 而非 >=），避免边界抖动
  const edge = { pid: 5555, at: now - DEFAULT_BRIDGE_LOCK_STALE_MS };
  assert.equal(decideBridgeLock(edge, now, { pid: 111, startedAt: 2 }).state, 'held');
});

test('①f decideBridgeLock：staleMs 可配置（真机排障与离线测试的旋钮）', () => {
  const now = 1_800_000_000_000;
  const lock = { pid: 5555, at: now - 5000 };
  assert.equal(decideBridgeLock(lock, now, { pid: 1, startedAt: 1 }).state, 'held');
  assert.equal(decideBridgeLock(lock, now, { pid: 1, startedAt: 1, staleMs: 1000 }).state, 'free');
});

test('①g ★ 持有者进程已死 ⇒ free（即使锁很新、时间上限远未到）', () => {
  const now = 1_800_000_000_000;
  // 锁是 1 秒前写的 —— 旧判据里这必然是 held，用户被挡满 12 小时。
  const lock = { pid: 17820, startedAt: 999, at: now - 1000, siteId: 'glm', accountKey: 'glm' };
  assert.equal(decideBridgeLock(lock, now, { pid: 111, startedAt: 2, isAlive: live }).state, 'held',
    '反向验证：持有者活着时这条路径必须仍然拒绝');
  const v = decideBridgeLock(lock, now, { pid: 111, startedAt: 2, isAlive: dead });
  assert.equal(v.state, 'free', '持有者已死必须能接管——这就是「我明明重启了」那条报错的根因');
  assert.equal(v.reason, 'holder-process-dead');
  assert.equal(v.stale, true, '接管必须留痕');
  // 死锁的接管**与时间无关**：锁再新也要放行
  assert.equal(decideBridgeLock({ ...lock, at: now }, now, { pid: 111, startedAt: 2, isAlive: dead }).state, 'free');
});

test('①h isAlive 判据本身失效（抛异常 / 非布尔）⇒ 保守按活着处理', () => {
  const now = 1_800_000_000_000;
  const lock = { pid: 5555, at: now - 1000 };
  const boom = () => { throw new Error('probe failed'); };
  assert.equal(decideBridgeLock(lock, now, { pid: 1, startedAt: 1, isAlive: boom }).state, 'held',
    '判据失效时误拒是可接受的，误放不是');
  assert.equal(decideBridgeLock(lock, now, { pid: 1, startedAt: 1, isAlive: () => undefined }).state, 'held');
});

// ───────────────────── ② 文件系统往返 ─────────────────────

test('② acquire → 重入 → 释放 → 可再拿（持有者活着的前置下）', () => {
  const dir = tmpDir('roundtrip');
  const opts = { isAlive: live };
  const self = { pid: 1001, startedAt: 42, siteId: 'glm', accountKey: 'glm' };
  const a = acquireBridgeLock(dir, self, opts);
  assert.equal(a.ok, true, '第一次必须拿到');
  assert.ok(fs.existsSync(path.join(dir, BRIDGE_LOCK_FILE)), '锁文件必须落盘');

  // 重入：同 pid + 同 startedAt ⇒ 仍然 ok（不重复写、不报错）
  assert.equal(acquireBridgeLock(dir, self, opts).ok, true, '同一进程重入必须允许');

  // 另一个人（不同 pid/startedAt，且持有者活着）⇒ 被拒，且带出现场
  const other = acquireBridgeLock(dir, { pid: 2002, startedAt: 43, accountKey: 'glm' }, opts);
  assert.equal(other.ok, false, '别人必须被拒');
  assert.equal(other.state, 'held');
  assert.equal(other.holder.pid, 1001, '拒绝时必须报出持有者 pid');

  // 释放后可以再拿
  assert.equal(releaseBridgeLock(dir, { pid: 1001, startedAt: 42 }), true);
  assert.ok(!fs.existsSync(path.join(dir, BRIDGE_LOCK_FILE)), '释放后锁文件必须消失');
  assert.equal(acquireBridgeLock(dir, { pid: 3003, startedAt: 44 }, opts).ok, true, '释放后别人可拿');
});

test('②b 坏 JSON 的锁 ⇒ 按 free 接管，但必须留痕（不静默）', () => {
  const dir = tmpDir('badjson');
  fs.writeFileSync(path.join(dir, BRIDGE_LOCK_FILE), '{ this is not json', 'utf8');
  const logs = [];
  const got = acquireBridgeLock(dir, { pid: 1, startedAt: 1 }, { logger: { warn: (m) => logs.push(String(m)) } });
  assert.equal(got.ok, true, '坏锁不该把用户永久挡在门外');
  assert.ok(logs.some((l) => /unreadable lock/.test(l)), '必须留下可归因的告警，实际=' + JSON.stringify(logs));
});

test('②c 过期锁 ⇒ 允许接管，且留痕说明接管了陈旧锁', () => {
  const dir = tmpDir('stale');
  fs.writeFileSync(path.join(dir, BRIDGE_LOCK_FILE), JSON.stringify({ pid: 8888, at: Date.now() - 99_999_999 }), 'utf8');
  const logs = [];
  const got = acquireBridgeLock(dir, { pid: 1, startedAt: 1 }, { logger: { warn: (m) => logs.push(String(m)) } });
  assert.equal(got.ok, true, '陈旧锁必须能被接管');
  assert.ok(logs.some((l) => /STALE lock/.test(l)), '必须留痕，实际=' + JSON.stringify(logs));
});

test('②d 盘上一份「持有者已死」的锁 ⇒ 接管并改写成本进程（假 pid + 注入判据）', () => {
  const dir = tmpDir('dead-holder');
  fs.writeFileSync(path.join(dir, BRIDGE_LOCK_FILE), JSON.stringify({
    pid: 17820, startedAt: 1790373028080, siteId: 'glm', accountKey: 'glm',
    at: Date.now() - 1000, version: 1,
  }), 'utf8');
  const logs = [];
  const got = acquireBridgeLock(dir, { pid: 500, startedAt: 7, siteId: 'glm', accountKey: 'glm' },
    { isAlive: dead, logger: { warn: (m) => logs.push(String(m)) } });
  assert.equal(got.ok, true, '死锁必须被接管');
  assert.equal(got.reason, 'acquired-after-takeover');
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, BRIDGE_LOCK_FILE), 'utf8'));
  assert.equal(onDisk.pid, 500, '锁文件必须改写成本进程 pid，否则下一轮还会看到死 pid');
  assert.ok(logs.some((l) => /holder-process-dead/.test(l)), '接管留痕必须写明是哪条判据，实际=' + JSON.stringify(logs));
});

test('②e 退出兜底：拿到的锁登记在册，releaseAllBridgeLocks 能清干净', () => {
  const dir = tmpDir('exit-hook');
  const got = acquireBridgeLock(dir, { pid: process.pid, startedAt: 12345 }, { isAlive: live });
  assert.equal(got.ok, true);
  assert.ok(heldBridgeLockPaths().includes(got.path), '拿到的锁必须登记（process.on(exit) 靠它兜底）');
  assert.equal(releaseAllBridgeLocks() >= 1, true);
  assert.ok(!fs.existsSync(got.path), '兜底释放后锁文件必须消失');
});

// ───────── ③ 并发竞争：wx 独占创建，只有一个赢家 ─────────

test('③ 同一 profileDir 连续两次不同身份 acquire：第二个必须被拒（准则核心）', () => {
  const dir = tmpDir('race');
  const opts = { isAlive: live };   // 第一个持有者活着
  const first = acquireBridgeLock(dir, { pid: 11, startedAt: 1 }, opts);
  const second = acquireBridgeLock(dir, { pid: 22, startedAt: 2 }, opts);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false, '同一账号的第二个桥接实例必须被拒绝');
  assert.equal(second.reason, 'held-by-live-owner');
});

// ───────── ④ releaseBridgeLock 只释放自己的（最危险边界） ─────────

test('④ release 不得删掉别人的锁（否则准则被绕过）', () => {
  const dir = tmpDir('release-safety');
  const opts = { isAlive: live };
  // A 拿锁，然后被 B 接管（模拟 A 过期）：这里直接写 B 的锁。
  acquireBridgeLock(dir, { pid: 1001, startedAt: 42 }, opts);
  fs.writeFileSync(path.join(dir, BRIDGE_LOCK_FILE), JSON.stringify({ pid: 2002, startedAt: 43, at: Date.now() }), 'utf8');
  // A 试图释放：pid 对不上 ⇒ 必须拒绝，且**文件必须还在**（B 还在跑）
  assert.equal(releaseBridgeLock(dir, { pid: 1001, startedAt: 42 }), false, '不得释放别人的锁');
  assert.ok(fs.existsSync(path.join(dir, BRIDGE_LOCK_FILE)), '别人的锁文件必须留着');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, BRIDGE_LOCK_FILE), 'utf8')).pid, 2002);

  // 即便 pid 相同、但 startedAt 不同（pid 复用）也不得释放
  fs.writeFileSync(path.join(dir, BRIDGE_LOCK_FILE), JSON.stringify({ pid: 1001, startedAt: 99, at: Date.now() }), 'utf8');
  assert.equal(releaseBridgeLock(dir, { pid: 1001, startedAt: 42 }), false, 'startedAt 不同不得释放');
  assert.ok(fs.existsSync(path.join(dir, BRIDGE_LOCK_FILE)));
});

test('④b release 对不存在的锁返回 false（不抛）', () => {
  const dir = tmpDir('release-missing');
  assert.equal(releaseBridgeLock(dir, { pid: 1, startedAt: 1 }), false);
});

// ───────── ⑤ 报错文案（用户要看得懂、要知道怎么办） ─────────

test('⑤ describeBridgeLockHolder：含账号、pid、时间、存活读数、锁路径，且给出可行动的下一步', () => {
  const msg = describeBridgeLockHolder({ pid: 4242, at: 1_800_000_000_000, siteId: 'glm', accountKey: 'glm#2' },
    'glm', 'glm#2', { alive: true, lockPath: 'D:\\x\\webcode-bridge.lock.json' });
  assert.match(msg, /glm/);
  assert.match(msg, /4242/);
  assert.match(msg, /同一账号不能同时桥接运行/, '必须逐字带上用户立的准则，它是这条报错的存在理由');
  assert.match(msg, /账户槽/, '必须告诉用户怎么解决');
  assert.match(msg, /该进程仍在运行/, '存活读数必须写出来——用户最先想知道 pid 到底还在不在');
  assert.match(msg, /webcode-bridge\.lock\.json/, '锁文件路径必须写出来，否则用户无从自己清');
});

// ───────── ⑥ 驱动器接线（源码结构断言） ─────────

test('⑥ 驱动在 launch 之前拿锁、close 时释放、被拒用 BRIDGE_ACCOUNT_BUSY', () => {
  const src = fs.readFileSync(new URL('../lib/browser-driver.js', import.meta.url), 'utf8');
  assert.match(src, /BRIDGE_ACCOUNT_BUSY/, '必须有可识别的错误码');
  assert.match(src, /acquireBridgeLock\(/, 'launch 路径必须真的调 acquireBridgeLock');
  assert.match(src, /releaseBridgeLock\(/, 'close 路径必须真的调 releaseBridgeLock');
  // 拿锁必须早于 clearStaleProfileLocks（即早于任何 profile 写操作）
  const atAcquire = src.indexOf('acquireBridgeLock(');
  const atClear = src.indexOf('clearStaleProfileLocks();', src.indexOf('async function launch'));
  assert.ok(atAcquire > 0 && atClear > 0 && atAcquire < atClear,
    '拿锁必须排在启动浏览器之前（否则两个桥已经互相杀过一轮了）');
});

// ───────── ⑦ 真进程存活（不注入任何桩；直接编码用户那次事故） ─────────

test('⑦a isProcessAlive：自身 / 真子进程 / 已退出子进程 / 系统 pid', async () => {
  assert.equal(isProcessAlive(process.pid), true, '自身必须判为活着');
  const child = spawnIdleNode();
  assert.equal(isProcessAlive(child.pid), true, '真活着的子进程必须判为活着（不靠注入）');
  await child.stop();
  assert.equal(isProcessAlive(child.pid), false, '已退出的子进程必须判为已死（ESRCH；Windows 亦然）');
  assert.equal(isProcessAlive(4), true, '系统 pid 打不开是 EPERM ⇒ 仍算活着（宁可误拒）');
  assert.equal(isProcessAlive(0), false, '非法 pid 谈不上活着');
});

test('⑦b ★ 真机事故复现：活着的持有者锁 ⇒ 拒；同一把锁、持有者退出后 ⇒ 接管', async () => {
  const dir = tmpDir('real-proc');
  const child = spawnIdleNode();

  // ① 让「另一个桥」（真活着的进程）持锁
  const holder = acquireBridgeLock(dir, { pid: child.pid, startedAt: 1, siteId: 'glm', accountKey: 'glm' });
  assert.equal(holder.ok, true);

  // ② 第二个实例（本进程，真 pid、真判据、**不注入**）必须被拒
  const denied = acquireBridgeLock(dir, { siteId: 'glm', accountKey: 'glm' });
  assert.equal(denied.ok, false, '持有者真活着时必须拒绝——这是准则本身');
  assert.equal(denied.reason, 'held-by-live-owner');
  assert.equal(denied.holder.pid, child.pid);

  // ③ 持有者被强杀（= 用户重启 dsh 时旧进程的结局），锁留在盘上
  await child.stop();
  assert.ok(fs.existsSync(path.join(dir, BRIDGE_LOCK_FILE)), '强杀不会执行释放 ⇒ 锁一定还在盘上');

  // ④ 重启后的新实例必须能自己接管 —— 用户那句「我是重启了的啊！」的验收点
  const logs = [];
  const after = acquireBridgeLock(dir, { siteId: 'glm', accountKey: 'glm' },
    { logger: { warn: (m) => logs.push(String(m)) } });
  assert.equal(after.ok, true, '持有者已死 ⇒ 新实例必须能接管（0.19.22 修的正是这里）');
  assert.equal(after.reason, 'acquired-after-takeover');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, BRIDGE_LOCK_FILE), 'utf8')).pid, process.pid);
  assert.ok(logs.some((l) => /holder-process-dead/.test(l)), '接管留痕=' + JSON.stringify(logs));
});
