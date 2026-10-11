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
  const aliveVerdict = isAlive ? safeAlive(isAlive, hPid) : null;
  if (aliveVerdict === false) {
    return { state: 'free', reason: 'holder-process-dead', holder: existing, stale: true };
  }

  const hAt = Number(existing.at);
  const expired = Number.isFinite(hAt) && now - hAt > staleMs;

  // ── 明确存活：锁龄**不再**构成放行理由（0.19.71；回归 ①e2）──────────
  //
  // 0.19.22 把时间上限写成「pid 判据给不出结论时的兜底」，但实现是：`safeAlive`
  // 已经明确返回 true 之后，代码**仍然继续往下走**并在过期时放行。于是
  // 「一个真跑了 12 小时以上的桥」会被第二个实例抢走账号锁——两个桥同时驱动
  // 同一账号、互相杀浏览器、两条用户消息交错污染同一网页会话（见文件头）。
  //
  // 时间上限**只能触发恢复判定，不能证明接管安全**：它无法区分「持有者真的跑
  // 了 12 小时」与「pid 被复用、原持有者早已消失」。因此这里一律拒绝，并把
  // 后者需要的出口显式标出来（`recoverable` / `recoveryBasis`）：
  //   · 调用方据此可以告诉用户「这把锁过期了但进程还活着」；
  //   · **但本轮没有**为它接线任何自动恢复路径——`acquireBridgeLock` 的接管分支
  //     仍是「读→判→写」，而实测证明那条路径在陈旧锁场景下会**多持有者**
  //     （见 `doc/long-term-issues.md` #50 的 P1/P2/P3 三个协议）。
  // ⇒ 现状是「不会无声抢锁」+「有可诊断的恢复信号」，**不是**「已具备安全恢复」。
  //   把 `recoverable` 接成自动接管**必须**先落地原子+身份绑定的协议，否则
  //   等于用一个新的双持换掉一个误报。
  if (aliveVerdict === true) {
    return {
      state: 'held', reason: 'held-by-live-owner', holder: existing, stale: false,
      recoverable: expired,
      recoveryBasis: expired ? 'holder-alive-but-lock-expired' : null,
    };
  }

  // ── 时间上限：**仅**在「存活判据缺席」时的有界兜底 ──────────────────
  // 保持 0.19.18 起的行为：不注入 isAlive 时，过期锁仍可被接管，否则
  // 「判据不可用」就会退化成永久锁死。①e / ①f 钉住这一侧。
  if (expired) {
    return { state: 'free', reason: 'stale-lock-expired', holder: existing, stale: true };
  }

  // 其余一律拒绝：持有者还活着（或判据给不出结论），且锁未过期。
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

// ───────────────────── 过渡互斥（transition guard）─────────────────────
//
// ## 为什么光有 `wx` 还不够（2026-10-11 实测）
//
// 锁文件的**创建**用 `wx`（独占创建）本来就是原子的；坏的是**接管陈旧锁**那条路：
// 它是「读 → 判 → 非独占覆写」，两步之间没有任何原子性。盘上留有陈旧锁时
// （强杀/崩溃/重启的常见后果，正是 0.19.22 要解决的场景），多个进程可以**全部**
// 读到同一份陈旧锁、**全部**判定可接管、然后**全部**覆写并各自返回 `ok:true`
// ⇒ 同一账号出现多个持有者，破坏用户立的准则「同一账号不能同时桥接运行」。
//
// 实测（修复前）：`fresh`（盘上无锁文件）**0/20** 多持；`stale`（盘上有死锁）
// **20/20** 多持；屏障同步 4 进程 × 8 轮**每轮 4 个进程全部 `ok`**。
//
// ## 为什么不是「换成 mkdir 锁」也不是「rename aside」
//
// 三个候选都被**同一个固定交错**打穿过（完整读数见 `doc/long-term-issues.md` #50）：
//
//   · `rename(lockPath, aside)` 是**按路径**操作，不是**按身份**操作 ⇒ A 可能移走
//     B **刚建立**的活锁（ABA 问题）。实测：A 移走的是 `B-LIVE`，两个进程同时
//     认为自己持有。**「原型 0/N 多持」不构成安全证明**——它只说明那个交错没触发。
//   · 天真的「`mkdir` 当锁 + `rmdir` 回收」只修**首次获取**；回收那一步仍然是
//     「先删掉、再建立」，照样把新持有者删掉。
//   · 非独占覆写（当前实现）B 直接被静默覆盖。
//
// ⇒ 真正需要的不是「换一个看似原子的原语」，而是**把所有对锁文件的改动
//   （建立、回收、释放）串行化进同一个临界区**。
//
// ## 设计
//
// 用一个**短命目录**当过渡互斥：`mkdir` 在 POSIX 与 Windows 上都是原子的
// 「不存在才创建」语义。**所有**对 `lockPath` 的改动都在它里面发生，于是
// 「读 → 判 → 写」不再与其他进程交错。临界区内只有几次同步文件操作
// （无网络、无浏览器、无等待），因此它天然是**毫秒级**的。
//
// 守卫自身的回收因此可以有一个**远紧于 12 小时**的界：临界区只有毫秒级，
// 一个 15 秒仍未被释放的守卫**不可能**是合法持有者（进程被强杀是唯一解释）。
// 回收 = `rename` 原子认领 + 认领后**复核年龄**。这是它与 12 小时那条的关键区别：
// 12 小时那条无法区分「持有者真跑了 12 小时」与「pid 被复用」（见 §3.6），
// 而 15 秒 ≫ 毫秒级临界区，这个区分是成立的。
//
// ## 与旧版锁文件的兼容
//
// `lockPath` 的内容格式**一字未改**（`pid/startedAt/siteId/accountKey/at/version`），
// 升级前后互相看得懂对方写的锁。守卫目录是新增的旁挂文件，旧版本会忽略它。

/** 过渡互斥目录名（放在 profileDir 里，与锁文件同级）。 */
export const BRIDGE_GUARD_DIRNAME = 'webcode-bridge.lock.guard.d';

/**
 * 守卫的过期上限：超过就认为持有它的进程被强杀了。
 *
 * 取值依据：临界区只有**毫秒级**的几次同步文件操作，因此 15 秒是三个数量级
 * 以上的余量。刻意远小于锁文件那个 12 小时——时间上限只有在「远大于合法
 * 持有时长」时才谈得上安全回收（见文件头 §设计）。
 */
export const DEFAULT_BRIDGE_GUARD_STALE_MS = 15_000;

/** 等待守卫的最长时间（毫秒）。竞争只发生在「同一瞬间启动两个桥」时。 */
export const DEFAULT_BRIDGE_GUARD_WAIT_MS = 4_000;

/** 本进程的启动时刻（守卫持有者标记用；与锁文件判据同源）。 */
const GUARD_STARTED_AT = Date.now();

/** 同步小睡：`Atomics.wait` 可用就用它（不烧 CPU），否则退化为自旋。 */
function sleepSync(ms) {
  if (!(ms > 0)) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* 自旋兜底：只在 Atomics 不可用时走到 */ }
  }
}

/** 本进程的守卫启动时刻（供持有者标记写入；测试可覆盖）。 */
function guardStartedAt() { return GUARD_STARTED_AT; }

/** 读一个目录的 mtime（毫秒）；读不到返回 null。 */
function dirMtimeMs(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return null; }
}

/** 读守卫的持有者标记；读不到/损坏返回 null（**不可当成「没有持有者」**）。 */
function readGuardOwner(guardDir) {
  try {
    const raw = fs.readFileSync(path.join(guardDir, 'owner.json'), 'utf8');
    const o = JSON.parse(raw);
    return (o && typeof o === 'object') ? o : null;
  } catch { return null; }
}

/**
 * 回收一个陈旧守卫。
 *
 * ## 0.19.73：为什么必须「先验证，后动手」（复审指出并已确定性复现）
 *
 * 0.19.72 的顺序是**先移走、后判定**：
 *
 *   ① `rename(guardDir, aside)`  ← 此刻 guardDir **这个路径不存在**
 *   ② 读 `owner.json`、判存活
 *   ③ 若持有者仍存活 ⇒ 把 aside 放回
 *
 * 第 ① 与第 ③ 步之间那个「路径不存在」的窗口是**真实可用的**：第三个进程 C 可以
 * 恰好在此刻 `mkdir(guardDir)` 成功并自认持有者，而**原持有者 A 仍然活着、仍在
 * 临界区里**。确定性三进程注入实测（`.tmp/lockrace/guard-gap-injection.mjs`）：
 *
 *   guardPathExistsAfterRename: false      ← 路径消失
 *   C_acquiredInWindow:         true       ← C 趁空档进入
 *   B_putBackSucceeded:         false      ← 放回还失败了（C 已占位）
 *   ⇒ A（存活、在临界区）与 C 同时持有；且 A 的守卫被永久遗弃在 aside 路径
 *
 * **这不是「年龄兜底」那一类风险**：B 的判断本身是**正确**的（A 活着 ⇒ 拒绝回收），
 * 破坏互斥的是「先移走」这个动作本身。所以只加一次存活检查不够——**存活判定必须
 * 排在任何移走操作之前**。
 *
 * 现在的顺序：
 *
 *   ① 读标记 + 判存活（**完全不碰路径**）：明确存活 ⇒ 当场拒绝，路径始终存在，
 *      C 无从进入；
 *   ② 只有「确认已死」或「判据无结论且远超放宽阈值」才 `rename` 认领；
 *   ③ 认领后**复核身份**（pid + startedAt 与验过的一致）——防「验完到认领之间
 *      被别人换了」的 ABA；不一致就放回并如实报告竞争；
 *   ④ 放不回去时**也不继续**（宁可放弃回收，也不冒双持风险）。
 *
 * ## 为什么不用「原子替换」绕开窗口
 *
 * 本机实测：**文件** `rename` 覆盖已存在目标会原子成功，但**非空目录**会 `EPERM`
 * （目录无法原子替换）。守卫是目录（`mkdir` 是我们唯一的原子「不存在才创建」
 * 原语），因此没有「无窗口替换」可用 ⇒ 只能靠「先验证后动手」把窗口关掉。
 *
 * @param {string} guardDir
 * @param {number} now
 * @param {number} staleMs 年龄门槛
 * @param {(m: string) => void} warn
 * @param {(pid: number) => boolean} isAlive 注入的存活判据
 * @returns {boolean} true = 已确认可回收并已清掉（调用方应重试 mkdir）
 */
function recoverStaleGuard(guardDir, now, staleMs, warn, isAlive) {
  // ── ① 先验证：读标记 + 判存活。**这一段完全不碰路径。** ──────────────
  const preOwner = readGuardOwner(guardDir);
  const preMtime = dirMtimeMs(guardDir);
  if (preMtime === null) return false;                 // 已消失（别人先回收了）
  const preAge = now - preMtime;
  if (preAge <= staleMs) return false;                 // 还没到门槛

  const prePid = Number(preOwner?.pid);
  const prePidUsable = Number.isFinite(prePid) && prePid > 0;
  let preVerdict;
  if (prePidUsable && typeof isAlive === 'function') {
    try { preVerdict = isAlive(prePid); } catch { preVerdict = undefined; }
  }

  if (preVerdict === true) {
    // 持有者明确活着 ⇒ **当场拒绝，绝不移走**。路径保持存在，C 无从趁空档进入。
    // 这正是复审要求的那条：「明确存活的持有者必须在任何移走操作之前就被拒绝」。
    warn(`[bridge-lock] refusing to recover transition guard at ${guardDir}: `
      + `owner pid=${prePid} is still ALIVE (age=${Math.round(preAge / 1000)}s). `
      + 'A live owner is never evicted by age alone — it may simply be paused.');
    return false;
  }

  // 只有「确认已死」才有资格回收；「判据无结论」只能在**远超**放宽阈值时兜底。
  // 注意 `prePidUsable === false`（无标记/坏标记）与 `preVerdict === undefined`
  // （判据抛错/非布尔）都属「不知道」，两者都必须过放宽阈值才敢动。
  const guessMs = Math.max(staleMs * 4, staleMs + 60_000);
  const confirmedDead = preVerdict === false;
  const mayGuess = preAge > guessMs;                    // 放宽门槛（仅在非确认死亡时用到）
  if (!confirmedDead && !mayGuess) return false;        // 不知道就别动

  // ── ② 原子认领（只有一个进程能 rename 成功）─────────────────────────
  const aside = `${guardDir}.stale-${process.pid}-${now}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.renameSync(guardDir, aside);
  } catch {
    return false;                                       // ENOENT = 输给别人；别的错也不硬闯
  }

  // ── ③ 复核身份：认领到的必须**就是我们刚验过的那一个**（防 ABA）──────
  const postOwner = readGuardOwner(aside);
  const sameIdentity = Number(postOwner?.pid) === prePid
    && Number(postOwner?.startedAt) === Number(preOwner?.startedAt);
  if (!sameIdentity) {
    // 验完到认领之间被人换了（别人刚建立的活守卫）⇒ 原样放回，如实报告竞争。
    let back = false;
    try { fs.renameSync(aside, guardDir); back = true; } catch { back = false; }
    warn(`[bridge-lock] ABA on transition guard at ${guardDir}: claimed a different owner `
      + `(expected pid=${prePid || '?'}, got pid=${postOwner?.pid ?? '?'}); putBack=${back}. `
      + 'Refusing to remove it.');
    return false;
  }

  // ── ④ 确认无疑 ⇒ 清掉 ────────────────────────────────────────────────
  try { fs.rmSync(aside, { recursive: true, force: true }); } catch { /* 下次再来 */ }
  if (confirmedDead) {
    warn(`[bridge-lock] recovered transition guard at ${guardDir}: owner pid=${prePid} is dead `
      + `(age=${Math.round(preAge / 1000)}s)`);
  } else {
    warn(`[bridge-lock] recovered transition guard at ${guardDir} on an AGE GUESS `
      + `(age=${Math.round(preAge / 1000)}s > ${Math.round(guessMs / 1000)}s, `
      + `owner pid=${prePidUsable ? prePid : 'unknown'}, liveness=inconclusive). `
      + 'This is a guess, not proof — if a bridge was merely paused, double-drive is possible.');
  }
  return true;
}

/**
 * 拿过渡互斥（有副作用：建目录 + 写持有者标记）。拿到返回 true。
 *
 * 全同步实现：调用方（`launch()` 与 `process.on('exit')`）都在同步上下文里，
 * 因此这里不做成 async。等待用 `Atomics.wait` 小睡，不空转烧 CPU。
 *
 * @param {string} guardDir 守卫目录
 * @param {{now?: number, staleMs?: number, waitMs?: number, label?: string, logger?: object}} [opts]
 * @returns {boolean} 是否拿到
 */
export function acquireTransitionGuard(guardDir, opts = {}) {
  const warn = typeof opts.logger?.warn === 'function' ? opts.logger.warn.bind(opts.logger) : () => {};
  const staleMs = Number.isFinite(Number(opts.staleMs)) && Number(opts.staleMs) > 0
    ? Number(opts.staleMs) : DEFAULT_BRIDGE_GUARD_STALE_MS;
  const waitMs = Number.isFinite(Number(opts.waitMs)) && Number(opts.waitMs) >= 0
    ? Number(opts.waitMs) : DEFAULT_BRIDGE_GUARD_WAIT_MS;
  // 存活判据：与锁文件判据同源（默认 isProcessAlive）。**这是回收能否安全的关键**。
  const isAlive = typeof opts.isAlive === 'function' ? opts.isAlive : isProcessAlive;
  const deadline = Date.now() + waitMs;
  const label = opts.label || '';

  for (;;) {
    try {
      fs.mkdirSync(guardDir, { recursive: false });
      // 持有者标记：**回收判据会读它**（存活 + 身份），不再只是诊断信息。
      try {
        fs.writeFileSync(path.join(guardDir, 'owner.json'),
          JSON.stringify({ pid: process.pid, startedAt: guardStartedAt(), at: Date.now(), label }), 'utf8');
      } catch { /* 标记写不进去不影响互斥成立；但它会让回收退回年龄兜底 */ }
      return true;
    } catch (err) {
      if (err?.code !== 'EEXIST') {
        warn(`[bridge-lock] transition guard mkdir failed at ${guardDir}: ${err?.message}`);
        return false;
      }
    }
    const now = Date.now();
    const mtime = dirMtimeMs(guardDir);
    if (mtime !== null && now - mtime > staleMs) {
      if (recoverStaleGuard(guardDir, now, staleMs, warn, isAlive)) continue;   // 已清掉 ⇒ 立刻重试
    }
    if (Date.now() >= deadline) {
      warn(`[bridge-lock] transition guard busy at ${guardDir} (waited ${waitMs}ms); refusing to mutate the lock`);
      return false;
    }
    sleepSync(5);
  }
}

/**
 * 释放过渡互斥：**只删自己的**，且判据不只 pid。
 *
 * ## 为什么 pid 不够（0.19.72；审阅第 2 点）
 *
 * pid 不是永久唯一的进程身份——会被复用。旧持有者若在「守卫已被回收、新持有者
 * 已重建」之后恢复执行并调用本函数，仅凭 `owner.pid === process.pid` 可能**误删
 * 新持有者的守卫**，等于把别人从临界区里踢出去。因此判据加上 `startedAt`
 * （本模块对「本进程这一化身」的既有身份来源，与 `decideBridgeLock` 的
 * `previous-incarnation` 分支同一套语义）。
 *
 * ## 标记缺失/损坏时的策略（明确的，不是碰运气）
 *
 * · `owner.json` **缺失** ⇒ 退回「只删自己的」不可能判定。这里选择**删除**：
 *   守卫是本进程刚在 `acquireTransitionGuard` 里 `mkdir` 出来的，若标记写失败
 *   （磁盘满/权限），不删就会把一个**空守卫**永久留在盘上，让所有人拿不到锁——
 *   那比误删更糟，而且它不可能是「别人的守卫」（别人建立时会写自己的标记）。
 * · `owner.json` **损坏**（非 JSON / 不是对象）⇒ 同上按「可能是我自己写坏的」处理，
 *   但**留痕**，因为损坏本身是异常信号。
 *
 * @param {string} guardDir
 * @param {{pid?: number, startedAt?: number, logger?: object}} [opts]
 * @returns {boolean} 是否真的删掉了
 */
export function releaseTransitionGuard(guardDir, opts = {}) {
  const warn = typeof opts.logger?.warn === 'function' ? opts.logger.warn.bind(opts.logger) : () => {};
  const myPid = Number.isFinite(Number(opts.pid)) ? Number(opts.pid) : process.pid;
  const myStartedAt = Number.isFinite(Number(opts.startedAt)) ? Number(opts.startedAt) : guardStartedAt();
  try {
    const ownerPath = path.join(guardDir, 'owner.json');
    const ownerExists = fs.existsSync(ownerPath);
    if (ownerExists) {
      let owner = null;
      let corrupt = false;
      try {
        owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
        if (!owner || typeof owner !== 'object') { corrupt = true; owner = null; }
      } catch { corrupt = true; owner = null; }

      if (owner) {
        // 被别人回收过又重建 ⇒ 里面不是我的标记，**绝不能删**（会放别人进临界区）。
        if (Number(owner.pid) !== myPid) return false;
        // 同 pid 但不同化身 ⇒ 这是**复用了我 pid 的另一个进程**（或我的上一个化身），
        // 不是本次持有 ⇒ 同样不许删。
        if (Number.isFinite(Number(owner.startedAt)) && Number(owner.startedAt) !== myStartedAt) return false;
      } else if (corrupt) {
        warn(`[bridge-lock] transition guard owner.json is corrupt at ${guardDir}; `
          + 'treating it as ours (an unremovable empty guard would block every bridge)');
      }
    } else {
      warn(`[bridge-lock] transition guard has no owner.json at ${guardDir}; `
        + 'treating it as ours (an unremovable empty guard would block every bridge)');
    }
    fs.rmSync(guardDir, { recursive: true, force: true });
    return true;
  } catch (err) {
    warn(`[bridge-lock] transition guard release failed at ${guardDir}: ${err?.message}`);
    return false;
  }
}

/** 在过渡互斥保护下执行 fn；拿不到守卫时返回哨兵而不是硬闯。 */
function withTransitionGuard(guardDir, opts, fn) {
  if (!acquireTransitionGuard(guardDir, opts)) {
    return { __guardUnavailable: true };
  }
  try {
    return fn();
  } finally {
    releaseTransitionGuard(guardDir, opts);
  }
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
  // 过渡互斥：**所有对 lockPath 的改动都在它里面**（见文件头「设计」）。
  const guardDir = path.join(dir, BRIDGE_GUARD_DIRNAME);
  const guardStaleMs = Number.isFinite(Number(opts.guardStaleMs)) && Number(opts.guardStaleMs) > 0
    ? Number(opts.guardStaleMs) : DEFAULT_BRIDGE_GUARD_STALE_MS;
  const guardWaitMs = Number.isFinite(Number(opts.guardWaitMs)) && Number(opts.guardWaitMs) >= 0
    ? Number(opts.guardWaitMs) : DEFAULT_BRIDGE_GUARD_WAIT_MS;

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
  const freshLock = () => ({
    ok: true, path: lockPath, state: 'free', reason: 'acquired', holder: null, guard: 'held',
  });

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    warn(`[bridge-lock] cannot create profile dir ${dir}: ${err?.message}`);
    return { ok: false, path: lockPath, state: 'free', reason: 'write-failed', holder: null };
  }

  // ── 唯一改动锁文件的地方：整个「读 → 判 → 写」都在过渡互斥里 ──────────────
  //
  // 这是 0.19.71 修的核心。上面那次 `decideBridgeLock` 只是**快速路径**
  // （无竞争时避免进临界区、也避免与全局串行），**不可作为权威判据**：从那次
  // 读取到这里之间，别的进程可能已经把陈旧锁接管走了。因此临界区里**必须
  // 重新读一次**，并按同一套判据重新裁决。
  const guarded = withTransitionGuard(guardDir, {
    now, staleMs: guardStaleMs, waitMs: guardWaitMs,
    label: `acquire:${info.accountKey || info.siteId || '?'}`, logger: opts.logger,
  }, () => {
    // ★ 临界区内重读：权威事实来源
    let live = null;
    try {
      if (fs.existsSync(lockPath)) live = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    } catch (err) {
      warn(`[bridge-lock] unreadable lock at ${lockPath} inside guard (${err?.message}); treating as free`);
      live = null;
    }
    const re = decideBridgeLock(live, now, self);

    if (re.state === 'mine') return { ok: true, path: lockPath, ...re };
    if (re.state === 'held') {
      const h = re.holder || {};
      warn(`[bridge-lock] DENIED (in guard): ${lockPath} held by pid=${h.pid} account=${h.accountKey || '?'}`);
      return { ok: false, path: lockPath, ...re };
    }

    // free ⇒ 可写。**整份覆写**（不再依赖 `wx` 给原子性：原子性已由临界区提供）。
    //
    // 为什么从「`wx` 独占创建 + EEXIST 回退」改成「无条件覆写」：
    //   · 临界区已保证同一时刻只有一个进程在这里，因此不存在「两个都写成功」；
    //   · 旧写法在接管分支用的是**非独占** `writeFileSync`（那才是缺陷），
    //     而首建分支用 `wx`——两套语义分叉正是 bug 的温床；
    //   · 保留「坏锁/陈旧锁必须能被覆盖」的既有语义（②b/②c 钉住的那一侧）。
    try {
      fs.writeFileSync(lockPath, serialized, { encoding: 'utf8' });
    } catch (err) {
      warn(`[bridge-lock] write failed at ${lockPath}: ${err?.message}`);
      return { ok: false, path: lockPath, state: 'free', reason: 'write-failed', holder: null };
    }
    remember();
    if (re.stale) {
      warn(`[bridge-lock] took over STALE lock at ${lockPath} (reason=${re.reason}, `
        + `holder pid=${live?.pid}, age=${Math.round((now - Number(live?.at || 0)) / 1000)}s)`);
      return { ok: true, path: lockPath, state: 'free', reason: 'acquired-after-takeover', holder: null };
    }
    return freshLock();
  });

  if (guarded.__guardUnavailable) {
    // 拿不到过渡互斥 ⇒ **绝不改动锁文件**。宁可拒绝启动并说明，也不冒双持风险：
    // 「误拒的代价是一条说得清的提示，误放的代价是两个桥互相杀浏览器」。
    warn(`[bridge-lock] held back: transition guard unavailable at ${guardDir}`);
    return {
      ok: false, path: lockPath, state: 'held', reason: 'transition-guard-busy',
      holder: verdict.holder || existing || null, stale: false,
    };
  }
  return guarded;
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
  const guardDir = path.join(dir, BRIDGE_GUARD_DIRNAME);
  // 释放也是**对锁文件的改动**，因此同样进临界区：否则它可能与「接管」交错，
  // 把刚被新持有者写下的锁删掉（那正是 ④ 那条最危险边界要防的事）。
  //
  // 与 acquire 的区别：这里**拿不到守卫时直接放弃释放**（返回 false），
  // 而不是抛错或硬闯——释放失败的最坏后果是「锁多留一会儿」，由进程退出兜底
  // 与「持有者已死」判据收拾；硬闯的后果是删掉别人的锁。
  // `waitMs: 0` 是必须的：本函数会被 `process.on('exit')` 兜底调用，而退出处理器
  // 只能是同步且应当尽快的——在那里等守卫会把「正常退出」拖成卡顿。不等待
  // 不损失正确性：拿不到就放弃本次释放，锁留给「持有者已死」判据收拾。
  const guarded = withTransitionGuard(guardDir, { label: 'release', waitMs: 0 }, () => {
    try {
      if (!fs.existsSync(lockPath)) { heldLocks.delete(lockPath); return false; }
      const cur = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      const minePid = Number.isFinite(Number(info.pid)) ? Number(info.pid) : process.pid;
      if (Number(cur?.pid) !== minePid) return false;                     // 已被别人接管
      if (Number.isFinite(Number(info.startedAt)) && Number(cur?.startedAt) !== Number(info.startedAt)) return false;
      fs.rmSync(lockPath, { force: true });
      heldLocks.delete(lockPath);
      return true;
    } catch { return false; }
  });
  return guarded.__guardUnavailable ? false : guarded;
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
  // 「锁过期但进程仍活着」是一个**真歧义**状态（0.19.71 起才会出现）：
  // 要么原持有者真的跑了很久，要么它的 pid 已被无关进程复用。两者在锁文件里
  // 长得一样，所以文案必须**两种都说到**，而不是假装知道是哪一种。
  const recoverableNote = opts.recoverable === true
    ? '⚠ 这把锁的写入时间已超过过期窗口，但该 pid 现在仍在运行：'
      + '可能是原持有者确实跑了很久，也可能是原进程早已退出、而这个 pid 被别的程序复用了。'
      + '请先确认是否真的还有另一个 dsh 在跑（例如看该 pid 对应的程序）。'
    : '';
  return `账号 ${who} 已被另一个桥接实例占用（pid ${h.pid ?? '?'}，自 ${when} 起）${aliveNote}。`
    + '同一账号不能同时桥接运行——请先关闭另一个 dsh / 另一个窗口，或在设置里为该站点配置第二个账户槽。'
    + recoverableNote
    + fileNote
    + '若确认没有任何别的 dsh 在跑，删除该锁文件后重试即可：桥在启动时会自动接管「持有者进程已不存在」的锁。';
}
