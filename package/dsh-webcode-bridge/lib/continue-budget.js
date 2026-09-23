// continue-budget.js — 自动续跑的**整会话累计**与「完整提醒」升级点（0.19.3）。
//
// ## 为什么需要它（用户指令）
//
// 用户原话：「加"整会话累计"：超过 N 次就改为发完整提醒，优先保证长上下文循环问题！解决！」
// 「A+C：但是不能停！继续后续需要 auto！！我说我需要真实长上下文你不理解吗？？能够做到！！
// 不要停！」——所以这个模块刻意**不是刹车**：它只回答「这一轮该用短提示还是完整提醒」，
// 永远不会让自动续跑停下。N 是**形态切换点**，不是熔断点。
//
// 上一轮的研究已经把这个缺口写成待办：桥的防护全部是单轮闭环，没有跨轮次的累积计数
// （doc/research/2026-09-23-longrun-two-rounds-thinking.md §2）。本模块补的就是那一条。
//
// ## 为什么累计要落盘
//
// 「整会话」的语义必须跨进程成立：本项目的纪律是「装完不重启 = 等于没装」，重启 dsh web
// 是常态操作；只放内存会把「整会话」悄悄降级成「每进程」，于是长期会话永远到不了升级点，
// 用户看到的仍是「后面全是提醒，而且一模一样」。落盘失败**必须静默**（与 reply-log /
// prompt-store 同一纪律）：计数是策略手段，不是交付物，不许因为它把回合搞挂。
//
// ## 计数口径（刻意选「每次真的补发了一轮」）
//
// 只在**真把提示补发进网页会话**时 +1（`autoContinueRound` 内、过了会话键与
// `autoContinueRounds` 两道闸之后）。没补发的轮（无会话键 / 用户关掉续跑）不计——
// 否则「整会话累计」会把从未发生的补发算进去，升级点提前到来，读数与事实不符。

import fs from 'node:fs';
import path from 'node:path';
import { sanitizeToken } from './prompt-store.js';

/** 默认升级点 N：第 4 次补发起改用完整提醒（用户选值，设置页可改）。 */
export const DEFAULT_CONTINUE_COMPLETE_AFTER = 3;

/** 累计计数的落盘子目录（与 prompts/、sessions/ 同级，便于一并取证与清理）。 */
const CONTINUATION_DIRNAME = 'continuations';

/**
 * 判定「这一轮续跑用哪种提示形态」（纯函数，可离线断言）。
 *
 * 边界写死在这里而不是散在调用点：`after = 0`（或非法值）表示**不升级**，永远短提示——
 * 这是「用户可以把这条策略关掉」的唯一含义，不是「立即升级」。`cumulative > after`
 * 才是升级：N=3 时第 1/2/3 次短提示、第 4 次起完整提醒（用户原话「超过 N 次就改为
 * 发完整提醒」）。
 *
 * @param {{cumulative?: number, after?: number}} [v] 本会话累计补发次数与升级点 N。
 * @returns {'short'|'complete'} 短提示 / 完整提醒。
 */
export function continueFormFor({ cumulative = 0, after = DEFAULT_CONTINUE_COMPLETE_AFTER } = {}) {
  const n = Math.floor(Number(after) || 0);
  if (n < 1) return 'short';
  return Math.floor(Number(cumulative) || 0) > n ? 'complete' : 'short';
}

/**
 * 某会话累计计数的落盘路径：`<dir>/continuations/<sessionKey>.json`。
 *
 * sessionKey 走 prompt-store 的 `sanitizeToken`（同一处消毒规则，不再各写一份），
 * 因此路径段里不会剩下分隔符，也逃不出 continuations/。
 *
 * @param {string} dir 存储根目录。
 * @param {string} sessionKey 会话键（`<sessionId>` 或 `<sessionId>::<agentId>`）。
 * @returns {string} 计数文件绝对路径。
 */
export function continuationFilePath(dir, sessionKey) {
  const token = sanitizeToken(String(sessionKey || '').replace(/::/g, '__'));
  return path.join(dir, CONTINUATION_DIRNAME, `${token}.json`);
}

/**
 * 建一个按会话累计的计数器（读改写一个极小 JSON，失败静默）。
 *
 * 落盘守卫与 prompt-store 严格对称：测试进程（`NODE_TEST_CONTEXT`）在未显式指定
 * 目录时**不写真实 `~/.dsh/webcode/`**，只走内存——否则跑一次测试就会污染用户的
 * 真实累计值；而行为测试显式传 `dir`/`WEBCODE_CONTINUE_STATE_DIR` 时照常落盘。
 *
 * @param {{dir?: string|null, env?: Record<string, string|undefined>}} [options]
 *   `dir` 存储根目录（null/空 = 只走内存）。
 * @returns {{peek: (sessionKey?: string|null) => number, bump: (sessionKey?: string|null) => number, reset: (sessionKey?: string|null) => void}}
 *   三个方法：`peek` 读当前值、`bump` 自增并返回新值、`reset` 归零（测试与手动清理用）。
 */
export function createContinueCounter({ dir = null, env = process.env } = {}) {
  // 内存是唯一权威读缓存：同一进程内绝不为了计数反复读盘（每次续跑都在关键路径上）。
  const memory = new Map();
  const dirFor = () => env.WEBCODE_CONTINUE_STATE_DIR || dir || null;
  const persistent = () => {
    const d = dirFor();
    if (!d) return false;
    if (env.NODE_TEST_CONTEXT && !env.WEBCODE_CONTINUE_STATE_DIR) return false;
    return true;
  };
  const load = (key) => {
    if (memory.has(key)) return memory.get(key);
    let n = 0;
    if (persistent()) {
      try {
        const parsed = JSON.parse(fs.readFileSync(continuationFilePath(dirFor(), key), 'utf8'));
        n = Math.max(0, Math.floor(Number(parsed?.cumulative) || 0));
      } catch {
        n = 0; // 首次运行 / 文件损坏 / 读不了：从 0 起算，绝不抛出
      }
    }
    memory.set(key, n);
    return n;
  };
  const save = (key, n) => {
    if (!persistent()) return;
    try {
      const file = continuationFilePath(dirFor(), key);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ cumulative: n, updatedAt: new Date().toISOString() }) + '\n');
    } catch {
      // 落盘失败不影响本次策略：内存里的值已经更新，升级点在本进程内照常生效。
    }
  };
  return {
    peek(sessionKey) {
      if (!sessionKey) return 0;
      return load(String(sessionKey));
    },
    bump(sessionKey) {
      if (!sessionKey) return 0;
      const key = String(sessionKey);
      const n = load(key) + 1;
      memory.set(key, n);
      save(key, n);
      return n;
    },
    reset(sessionKey) {
      if (!sessionKey) return;
      const key = String(sessionKey);
      memory.set(key, 0);
      save(key, 0);
    },
  };
}
