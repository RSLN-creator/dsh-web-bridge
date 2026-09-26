// bridge-lock.js — 「同一账号不得同时桥接」的单一实例锁（0.19.18；0.19.22 修「重启后被自己的旧锁挡住」）。
//
// ## 为什么必须是一个进程外可见的锁
//
// 用户明确立的准则（2026-09-26 原话）：
//
//   > 同一账号不能同时桥接运行！
//
// 「账号」在这里 = **站点 × 账户槽**（`glm`、`glm#2`），落盘形态是**一个 profileDir**。
// 两个桥进程（或同一进程里两个驱动实例）指向同一个 profileDir 时会互相破坏：
//
//   · Chromium 的 profile 单实例锁（`SingletonLock` / `lockfile`）被一方持有，
//     另一方启动即抛 ProcessSingleton；旧的「自愈」路径会**杀掉对方的浏览器**
//     （`killOrphanEdgeForProfile` 按 profileDir 匹配命令行）——两边反复互相杀，
//     表现为「随机 240s 超时 / 登录态莫名丢失」；
//   · 更隐蔽的一种：两边都成功启动（不同 profile 但同账号登录态），**同时往同一个
//     网页会话发消息**，网页侧把两条用户消息交错处理，两边都读到对方的回复 ——
//     这是本项目记过的「跑着跑着变傻」的形态之一。
//
// 因此判据必须在**启动浏览器之前**就生效，而且必须跨进程可见：进程内的 Map 挡不住
// 「两个 dsh 进程」。
//
// ## 判据设计（纯函数 + 一个文件系统副作用层，两者分开）
//
// `decideBridgeLock(existing, now, self)` 是**纯函数**：只吃「锁文件内容」、
// 「当前时刻」与**注入的存活判据**，输出三态。这样全部边界（过期、坏 JSON、空文件、
// 持有者已死、自己人）都能离线反向验证，不需要真的起两个进程。
//
// 三态语义：
//   · `'free'`   —— 没有锁文件，或持有者已死/锁已过期/是本进程上一个化身 ⇒ 可以拿锁；
//   · `'mine'`   —— 锁是我的（同 pid 且启动时刻一致）⇒ 重入，不重复写；
//   · `'held'`   —— **别人正持有且活着** ⇒ 必须拒绝启动，报出持有者现场。
//
// ## 为什么「过期」必须存在
//
// 只判「进程活着吗」不够：pid 会被复用（Windows 尤其），一个崩溃进程的 pid 很快
// 被无关进程占用，于是一个**永远解不开的锁**把用户彻底挡在门外。因此加一道
// `STALE_MS`（默认 12 小时）上限：超过就认为持有者已异常退出，允许接管并留痕。
//
// ## 0.19.22：为什么必须补上「持有者进程是否还活着」
//
// 真机事故（用户 2026-09-26 原话）：
//
//   > 本轮运行失败账号 glm 已被另一个桥接实例占用（pid 17820，自 2026/9/26 05:50:38 起）……
//   > 这个报错怎么回事？还有我是重启了的啊！
//
// 实测现场：`sites/glm/webcode-bridge.lock.json` 与根目录那份都写着 pid=17820、
// `at` = 05:50:38，而 **17820 早已不在进程表里**（当时活着的 dsh 是 08:39 起的
// 另一个 pid）。`deepseek` 与 `glm` **两个站点同时**被这份死锁挡住。
//
// 旧判据只有两条出路：同 pid 同 startedAt（mine）与 12 小时时间上限（stale）。
// 于是「进程被强杀/重启 → 锁留在盘上 → 12 小时内任何人（**包括刚重启的主人**）都被拒」。
// 用户越是老实重启，越会被自己的旧锁挡住，而且报错里那个 pid 根本不存在，他无从下手。
// 这是「误拒」最糟的形态：它**不保护任何东西**。
//
// 所以 0.19.22 加三条判据，每一条都只增加「可以合法拿锁」的情形：
//
//   ① `isProcessAlive(pid)` —— 唯一能**证明**持有者已死的信号是 `ESRCH`
//      （`process.kill(pid, 0)`；Windows 上实测同为 ESRCH，**不需要起子进程**）。
//      `EPERM` = 存在但无权打开 ⇒ 仍按活着处理（宁可误拒，不可误放）。
//   ② 同 pid 但 `startedAt` 不同 —— 只可能是**本进程的上一个化身**（插件热重载）
//      或「死进程的 pid 被我们接手」。pid 在活进程之间唯一，所以这份锁不可能是
//      别人的 ⇒ 允许覆盖，绝**不**当成「别人持锁」。
//   ③ `process.on('exit')` 兜底释放 —— 正常退出路径（包括 `close()` 被漏调）
//      不该留下需要靠 ①② 救回来的锁。只释放**自己那份**。
//
// 原先「刻意不检查 pid 存活」的理由是「Windows 上要起子进程」——**实测不成立**，
// 见 `test/bridge-lock.test.mjs` 的 ⑦ 组（真起进程再杀，验证 ESRCH / 存活两态）。
//
// ## 与 Chromium 自带锁的分工
//
// Chromium 的 `SingletonLock` 只保护**它自己**，且失败形态是「抛异常 + 互相杀进程」；
// 本锁保护的是**「同一账号的桥接语义」**，失败形态是「友好拒绝 + 告诉你谁占着」。
// 两者都要有：本锁在前（明确拒绝），Chromium 锁在后（最后防线）。

import fs from 'node:fs';
import path from 'node:path';

/** 锁文件过期上限：超过就认为持有者已异常退出（默认 12 小时）。 */
export const DEFAULT_BRIDGE_LOCK_STALE_MS = 12 * 60 * 60 * 1000;

/** 锁文件名。刻意放在 profileDir **里面**：一个账号一个目录，天然一对一。 */
export const BRIDGE_LOCK_FILE = 'webcode-bridge.lock.json';

/**
 * 真判「这个 pid 现在还在不在」。
 *
 * 语义按**证据强度**分档，绝不猜：
 *   · `ESRCH`  —— 进程不存在。这是唯一能证明「持有者已死」的信号；
 *   · `EPERM`  —— 进程存在，只是本进程无权打开它（系统进程、别的用户）⇒ **活着**；
 *   · 其它异常 —— 判据本身失效（不该发生）⇒ 保守按**活着**处理。
 *
 * `process.kill(pid, 0)` 在 Windows 上由 libuv 直接落到 OpenProcess，**不起子进程**
 * （本机实测：自身 true；已退出的 17820 → ESRCH；系统 pid 4 → EPERM）。
 *
 * @param {number} pid 待判进程号
 * @returns {boolean} true = 活着（或无法证伪）
 */
export function isProcessAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;   // 无效 pid 谈不上「活着」
  if (n === process.pid) return true;                // 就是我自己
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err?.code !== 'ESRCH';
  }
}

/** 调用方注入了坏 isAlive 时，一律按「活着」处理（保守，不误放）。 */
function safeAlive(isAlive, pid) {
  try {
    const v = isAlive(pid);
    if (v === true) return true;
    if (v === false) return false;
    return true;                                     // 非布尔 = 判据没给出结论
  } catch { return true; }
}

/**
 * 决定能否拿锁（纯函数，可离线反向验证）。
 *
 * @param {object|null|undefined} existing 锁文件的解析结果（读不到/坏 JSON 传 null）
 * @param {number} now 当前时刻（ms）
 * @param {{pid?: number, startedAt?: number, staleMs?: number, isAlive?: (pid:number)=>boolean}} [self]
 *        本进程身份。`isAlive` 缺席 = 不做存活判据（保持 0.19.18 起的三条旧判据）。
 * @returns {{state: 'free'|'mine'|'held', reason: string, holder: object|null, stale: boolean}}
 */
export function decideBridgeLock(existing, now, self = {}) {
  const pid = Number(self.pid);
  const startedAt = Number(self.startedAt);
  const staleMs = Number.isFinite(Number(self.staleMs)) && Number(self.staleMs) > 0
    ? Number(self.staleMs) : DEFAULT_BRIDGE_LOCK_STALE_MS;
  const isAlive = typeof self.isAlive === 'function' ? self.isAlive : null;

  // 没有锁 / 坏 JSON / 空文件 —— 一律视为「没有可信的持有者」，可以直接拿。
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    return { state: 'free', reason: 'no-lock-file', holder: null, stale: false };
  }
  const hPid = Number(existing.pid);
  if (!Number.isFinite(hPid) || hPid <= 0) {
    return { state: 'free', reason: 'lock-without-valid-pid', holder: null, stale: false };
  }

  // ── 与本进程的关系（pid 决定一切）────────────────────────────────
  // pid 在**活进程**之间唯一，所以：
  //   · 同 pid + 同启动时刻 ⇒ 我这一轮的锁（重入）；
  //   · 同 pid + 不同启动时刻 ⇒ 本进程的上一个化身（插件热重载），或「死进程的
  //     pid 被我接手」。两种都该覆盖，绝不能报「别人持锁」——见文件头 ② 。
  if (Number.isFinite(pid) && pid > 0 && hPid === pid) {
    if (Number(existing.startedAt) === startedAt) {
      return { state: 'mine', reason: 'same-process', holder: existing, stale: false };
    }
    return { state: 'free', reason: 'previous-incarnation', holder: existing, stale: true };
  }

  // ── 持有者已死（0.19.22）────────────────────────────────────────
  // 必须排在「时间上限」之前：死进程的锁**不需要**等满 12 小时。
  if (isAlive && safeAlive(isAlive, hPid) === false) {
    return { state: 'free', reason: 'holder-process-dead', holder: existing, stale: true };
  }

  // ── 时间上限：pid 判据给不出结论时的有界兜底 ────────────────────
  const hAt = Number(existing.at);
  if (Number.isFinite(hAt) && now - hAt > staleMs) {
    return { state: 'free', reason: 'stale-lock-expired', holder: existing, stale: true };
  }

  // 其余一律拒绝：持有者还活着，且锁未过期。
  // 误拒的代价是「用户看到一条说得清的提示」，误放的代价是「两个桥互相杀浏览器」。
  return { state: 'held', reason: 'held-by-live-owner', holder: existing, stale: false };
}

// ───────────────────── process.on('exit') 兜底释放 ─────────────────────

/** 本进程当前持有的锁：lockPath → { profileDir, pid, startedAt }。 */
const heldLocks = new Map();
let exitHookInstalled = false;

/** 装一次性的退出兜底（同步 rmSync，只动自己那份）。 */
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // `exit` 里的 handler 只能是**同步**操作；releaseBridgeLock 全程 sync，成立。
  process.on('exit', () => {
    for (const info of [...heldLocks.values()]) {
      try { releaseBridgeLock(info.profileDir, { pid: info.pid, startedAt: info.startedAt }); } catch { /* 退出路径不抛 */ }
    }
  });
}

/** 供测试与显式清理用：释放本进程登记的全部锁。 */
export function releaseAllBridgeLocks() {
  let n = 0;
  for (const info of [...heldLocks.values()]) {
    try { if (releaseBridgeLock(info.profileDir, { pid: info.pid, startedAt: info.startedAt })) n += 1; } catch { /* 忽略 */ }
  }
  return n;
}

/** 供测试观察登记表（不参与生产判据）。 */
export function heldBridgeLockPaths() {
  return [...heldLocks.keys()];
}

/** 环境变量旋钮：排障时把过期窗口调小（毫秒）。 */
function envStaleMs() {
  const raw = Number(process.env.WEBCODE_BRIDGE_LOCK_STALE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

/**
 * 拿锁（有副作用：写文件 + 登记退出兜底）。拿到返回 `{ ok: true, path }`，
 * 被拒返回 `{ ok: false, ...decide }`。
 *
 * 写文件用 `wx`（独占创建）失败时的**回退读**是必要的：两个进程可能同时通过
 * `decideBridgeLock` 的检查，`wx` 保证只有一个写成功。
 *
 * @param {string} profileDir 该账号的 profile 目录（锁放在它里面）
 * @param {{pid?: number, startedAt?: number, siteId?: string, accountKey?: string, now?: number}} [info]
 * @param {{staleMs?: number, isAlive?: (pid:number)=>boolean, logger?: object}} [opts]
 * @returns {{ok: boolean, path: string, state: string, reason: string, holder: object|null, stale?: boolean}}
 */
export function acquireBridgeLock(profileDir, info = {}, opts = {}) {
  const dir = String(profileDir || '');
  if (!dir) return { ok: false, path: '', state: 'free', reason: 'no-profile-dir', holder: null };
  const lockPath = path.join(dir, BRIDGE_LOCK_FILE);
  const now = Number.isFinite(Number(info.now)) ? Number(info.now) : Date.now();
  const warn = typeof opts.logger?.warn === 'function' ? opts.logger.warn.bind(opts.logger) : () => {};
  // ★ 0.19.22：**必须把本进程 pid 传进判据**。0.19.18 的接线只传了 startedAt，
  //   于是 `decideBridgeLock` 里的 `isFinite(pid)` 恒假、「同进程重入」这条分支
  //   在生产路径上**从未生效**（单测传了 pid，所以看不出）。这里补上。
  const selfPid = Number.isFinite(Number(info.pid)) && Number(info.pid) > 0
    ? Number(info.pid) : process.pid;
  const alive = typeof opts.isAlive === 'function' ? opts.isAlive : isProcessAlive;
  const staleMs = opts.staleMs ?? envStaleMs();
  const self = { pid: selfPid, startedAt: info.startedAt, staleMs, isAlive: alive };

  let existing = null;
  try {
    if (fs.existsSync(lockPath)) existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch (err) {
    // 坏 JSON / 读不到 —— 按「没有可信持有者」处理，但**必须留痕**：静默接管会让
    // 「为什么上次那个进程没释放锁」永远查不出来。
    warn(`[bridge-lock] unreadable lock at ${lockPath} (${err?.message}); treating as free`);
    existing = null;
  }

  const verdict = decideBridgeLock(existing, now, self);
  if (verdict.state === 'mine') {
    heldLocks.set(lockPath, { profileDir: dir, pid: selfPid, startedAt: info.startedAt });
    installExitHook();
    return { ok: true, path: lockPath, ...verdict };
  }
  if (verdict.state === 'held') {
    const h = verdict.holder || {};
    warn(`[bridge-lock] DENIED: ${lockPath} held by pid=${h.pid} account=${h.accountKey || '?'} `
      + `since=${h.at ? new Date(Number(h.at)).toISOString() : '?'}`);
    return { ok: false, path: lockPath, ...verdict };
  }
  if (verdict.stale) {
    warn(`[bridge-lock] taking over STALE lock at ${lockPath} (reason=${verdict.reason}, `
      + `holder pid=${existing?.pid}, age=${Math.round((now - Number(existing?.at || 0)) / 1000)}s) `
      + '— previous bridge exited abnormally or is this process\'s own earlier incarnation');
  }

  const payload = {
    pid: selfPid,
    startedAt: Number.isFinite(Number(info.startedAt)) ? Number(info.startedAt) : null,
    siteId: info.siteId ?? null,
    accountKey: info.accountKey ?? null,
    at: now,
    version: 1,
  };
  const serialized = JSON.stringify(payload, null, 2);
  const remember = () => {
    heldLocks.set(lockPath, { profileDir: dir, pid: selfPid, startedAt: info.startedAt });
    installExitHook();
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    // `wx` = 独占创建：并发的两个进程只有一个能成功，这是**无锁竞争**的正确判据。
    fs.writeFileSync(lockPath, serialized, { encoding: 'utf8', flag: 'wx' });
    remember();
    return { ok: true, path: lockPath, state: 'free', reason: 'acquired', holder: null };
  } catch (err) {
    if (err?.code !== 'EEXIST') {
      warn(`[bridge-lock] write failed at ${lockPath}: ${err?.message}`);
      return { ok: false, path: lockPath, state: 'free', reason: 'write-failed', holder: null };
    }
    // EEXIST：文件已存在。两种可能必须**分开处置**——
    //   · 我们正处在「接管陈旧/坏锁/已死持有者」路径（前面已判定 free）：文件就是我们
    //     要覆盖的那个陈旧锁，必须**覆盖写**。首版在这里一律拒绝，于是「坏锁/过期锁」
    //     把用户永久挡在门外（test/bridge-lock.test.mjs ②b/②c 抓到，两条断言先红）；
    //   · 我们处在「无锁竞争」路径：说明另一个进程**在我们检查之后**抢到了锁，
    //     回读它、如实拒绝——绝不能覆盖（覆盖就等于两个桥同时跑）。
    let other = null;
    try { other = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { other = null; }
    // 用**同一条判据**重新裁决「现在这份文件」：只有它已不可信（陈旧/坏/持有者已死）
    // 才允许覆盖。判据必须与上面逐字相同——两条判据分叉过一次就是 bug 的温床。
    const recheck = decideBridgeLock(other, now, self);
    if (recheck.state === 'held') {
      warn(`[bridge-lock] DENIED (race): ${lockPath} created by pid=${other?.pid ?? '?'} between check and write`);
      return { ok: false, path: lockPath, state: 'held', reason: 'race-lost-to-live-owner', holder: other };
    }
    // 现在这份文件已陈旧/损坏（或恰是本进程的旧锁）⇒ 安全覆盖。
    try {
      fs.writeFileSync(lockPath, serialized, { encoding: 'utf8' });
      remember();
      warn(`[bridge-lock] took over unusable lock at ${lockPath} (reason=${recheck.reason})`);
      return { ok: true, path: lockPath, state: 'free', reason: 'acquired-after-takeover', holder: null };
    } catch (err2) {
      warn(`[bridge-lock] takeover write failed at ${lockPath}: ${err2?.message}`);
      return { ok: false, path: lockPath, state: 'free', reason: 'write-failed', holder: null };
    }
  }
}

/**
 * 释放锁。**只释放自己的**（pid + startedAt 都对得上）——
 * 无条件删文件会在「我已过期被接管、新持有者正在跑」时把别人的锁删掉。
 *
 * @param {string} profileDir
 * @param {{pid?: number, startedAt?: number}} [info]
 * @returns {boolean} 是否真的删掉了
 */
export function releaseBridgeLock(profileDir, info = {}) {
  const dir = String(profileDir || '');
  if (!dir) return false;
  const lockPath = path.join(dir, BRIDGE_LOCK_FILE);
  try {
    if (!fs.existsSync(lockPath)) { heldLocks.delete(lockPath); return false; }
    const cur = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const minePid = Number.isFinite(Number(info.pid)) ? Number(info.pid) : process.pid;
    if (Number(cur?.pid) !== minePid) return false;                       // 已被别人接管
    if (Number.isFinite(Number(info.startedAt)) && Number(cur?.startedAt) !== Number(info.startedAt)) return false;
    fs.rmSync(lockPath, { force: true });
    heldLocks.delete(lockPath);
    return true;
  } catch { return false; }
}

/** 便于报错的持有者描述（纯函数）。 */
export function describeBridgeLockHolder(holder, siteId, accountKey, opts = {}) {
  const h = holder || {};
  const who = `${siteId || h.siteId || '?'}${accountKey && accountKey !== siteId ? `（槽 ${accountKey}）` : ''}`;
  const when = h.at ? new Date(Number(h.at)).toLocaleString() : '未知时间';
  // 存活读数要如实写出来：用户最先想知道的是「那个 pid 到底还在不在」。
  const aliveNote = opts.alive === true ? '（本机实测：该进程仍在运行）'
    : opts.alive === false ? '（本机实测：该进程已不在进程表里）'
      : '';
  const fileNote = opts.lockPath ? `锁文件：${opts.lockPath}。` : '';
  return `账号 ${who} 已被另一个桥接实例占用（pid ${h.pid ?? '?'}，自 ${when} 起）${aliveNote}。`
    + '同一账号不能同时桥接运行——请先关闭另一个 dsh / 另一个窗口，或在设置里为该站点配置第二个账户槽。'
    + fileNote
    + '若确认没有任何别的 dsh 在跑，删除该锁文件后重试即可：桥在启动时会自动接管「持有者进程已不存在」的锁。';
}
