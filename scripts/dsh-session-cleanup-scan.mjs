#!/usr/bin/env node
// dsh-session-cleanup-scan.mjs — 把本项目下的 DSH 会话按「有没有跑完第一轮」分类。
//
// 背景（为什么需要这个脚本）：
//
// 用户要清理的是两类会话：
//   1. **未进行过一轮**：一次会话里没有任何 `turn/start`，或者只有 `turn/start` 没有 `turn/end`
//      —— 打开就关掉、或者开了就崩，没产出任何东西。
//   2. **第一轮就报错失败**：唯一一轮的 `turn/end` 的 reason.kind 不是 `completed`。
//
// 而 DSH 没有现成的清单入口，所以这里落一个可复用扫描器：
// 既能出**人读的 markdown 报告**，也能出 **JSON**（给删除脚本当输入）。
//
// 关键实现点（都是真踩过的坑）：
//   - 会话落盘是**多帧 zstd**（`session.v3.jsonl.zstd` / `session.v4.jsonl.zstd`）。
//     `zstdDecompressSync(整文件)` 只解**第一帧**（就是那个 220 字节的头），
//     看起来「日志空」——所以这里按帧切分再逐帧解。
//   - 会话文件在同一目录里可能有**多个世代的副本**（v3 + v4）。以**版本号最高**的那份为准，
//     旧世代不参与判断（它是历史遗留，不是「另一条会话」）。
//   - **活跃会话**（新近有 mtime）不判成垃圾，标 `active`，由调用方跳过。
//
// 用法：
//   node scripts/dsh-session-cleanup-scan.mjs                  # 人读报告打到 stdout
//   node scripts/dsh-session-cleanup-scan.mjs --json <out.json>
//   node scripts/dsh-session-cleanup-scan.mjs --md <out.md>
//   node scripts/dsh-session-cleanup-scan.mjs --cwd <项目目录>   # 默认当前工作目录
//   node scripts/dsh-session-cleanup-scan.mjs --all             # 扫全部工作区
//   node scripts/dsh-session-cleanup-scan.mjs --active-min 30   # 活跃窗口（分钟，默认 60）
//
// 退出码：0 正常。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeZstdFrames, listAllSessions } from './session-read.mjs';

/** 判定为「活跃、不许动」的 mtime 窗口（毫秒）。 */
const DEFAULT_ACTIVE_MS = 60 * 60 * 1000;

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** 会话目录名 → 原始 cwd（DSH 的 projectKey：非字母数字折成 `-`）。 */
export function workspaceLabelOf(dirName) {
  return dirName.replace(/^-+|-+$/g, '').replace(/--+/g, ':');
}

/**
 * 一个会话目录里、**版本号最高**的那份日志。
 *
 * @param {string} dir 会话目录
 * @returns {{file:string,version:number,bytes:number,mtimeMs:number}|null}
 */
export function newestGeneration(dir) {
  let best = null;
  for (const name of fs.readdirSync(dir)) {
    const m = /^session(?:\.v([0-9]+))?\.jsonl(?:\.zstd)?$/.exec(name);
    if (!m) continue;
    const version = m[1] ? Number(m[1]) : 0;
    const st = fs.statSync(path.join(dir, name));
    if (!best || version > best.version) {
      best = { file: path.join(dir, name), name, version, bytes: st.size, mtimeMs: st.mtimeMs };
    }
  }
  return best;
}

/**
 * 把一次会话的事件流压成「第一轮跑成什么样」的判据。
 *
 * @param {Array<object>} events 事件数组（顺序即日志顺序）
 * @returns {{turns:Array, turnStarts:number, turnEnds:number, firstUserText:string, title:string|null}}
 */
export function turnFacts(events) {
  const turns = [];
  let cur = null;
  let firstUserText = '';
  let title = null;
  for (const e of events) {
    if (e?.type === 'turn/start') {
      cur = { turn: e.data?.turn ?? turns.length + 1, startAt: e.time ?? null, endAt: null, reason: null, error: null, steps: 0 };
      turns.push(cur);
    } else if (e?.type === 'turn/end') {
      const t = cur || turns[turns.length - 1];
      const reason = e.data?.reason || null;
      if (t) {
        t.reason = reason?.kind ?? (reason ? String(reason) : 'unknown');
        t.error = reason?.error?.message ? String(reason.error.message) : null;
        t.endAt = e.time ?? null;
      }
      cur = null;
    } else if (e?.type === 'step/start') {
      if (cur) cur.steps += 1;
    } else if (e?.type === 'user/message' && !firstUserText) {
      const blocks = Array.isArray(e.data?.content) ? e.data.content : [];
      firstUserText = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
    } else if (e?.type === 'session/title' && e.data?.title) {
      title = String(e.data.title);
    }
  }
  return { turns, turnStarts: turns.length, turnEnds: turns.filter((t) => t.reason !== null).length, firstUserText, title };
}

/**
 * 给一条会话判定类别。
 *
 * 类别只取一个，按「越靠近开局的失败优先级越高」：
 *   `unreadable` 装配不出来 / `empty-dir` 连日志都没有 /
 *   `zero-turn` 没有过任何 turn / `turn-stuck-open` 有 turn/start 没有 turn/end /
 *   `first-turn-failed` 真失败、一次都没跑完 /
 *   `aborted-no-completion` 用户按了停止、一次都没跑完 /
 *   `ok` 至少有一轮跑完了 / `active` 太新，不动。
 *
 * **`hasWork` 是独立的第二个维度，不是类别。** 分类只回答「这一轮跑成了没有」，
 * 但「没跑成」不等于「没有价值」：一条 800KB 的会话可能跑了 135 个 step、
 * 设了 goal、写了几万字，只是最后一步撞上站点故障。删掉它就等于删掉那次工作的全部记录。
 * 所以这里额外标出 `hasWork`，由清理脚本决定怎么处理（默认不动它们）。
 *
 * @param {object} row listAllSessions 形状的一行
 * @param {{activeMs:number, now:number}} opts
 */
export function classify(row, opts) {
  const dir = path.dirname(row.file);
  const gen = newestGeneration(dir);
  if (!gen) return { ...row, category: 'empty-dir', detail: '目录里没有任何 session*.jsonl(.zstd) 文件' };

  let text;
  let frameErrors = [];
  try {
    const decoded = decodeZstdFrames(fs.readFileSync(gen.file));
    text = decoded.text;
    frameErrors = decoded.frameErrors;
  } catch (e) {
    return { ...row, category: 'unreadable', detail: `解压失败：${e?.message || e}` };
  }

  const events = [];
  const badLines = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { events.push(JSON.parse(line)); } catch { badLines.push(line.slice(0, 120)); }
  }
  const header = events.find((e) => e?.type === 'session') || null;
  const facts = turnFacts(events);

  // 真实产出判据。只认「模型真的干了活」的信号：
  //   goal/change（设了目标）、deliverables/presented（交付物）、
  //   team/task 与 team/member（Agent Teams 状态）、todo/write（待办）、
  //   成篇的 assistant 正文。
  // **刻意不算的**：`session/end-seed`（只是日志/播种边界标记，连 684 字节的零轮
  // 会话里都有一条）、`session/title`（只根据首轮提示词生成，零轮会话也有）。
  const typeCount = {};
  for (const e of events) typeCount[e?.type] = (typeCount[e?.type] || 0) + 1;
  const assistantChars = events
    .filter((e) => e?.type === 'assistant/message')
    .reduce((n, e) => n + (Array.isArray(e.data?.message?.content) ? e.data.message.content : [])
      .filter((b) => b?.type === 'text').reduce((m, b) => m + String(b.text || '').length, 0), 0);
  const workSignals = [];
  if (typeCount['goal/change']) workSignals.push('goal×' + typeCount['goal/change']);
  if (typeCount['deliverables/presented']) workSignals.push('deliverables×' + typeCount['deliverables/presented']);
  if (typeCount['team/task']) workSignals.push('team/task×' + typeCount['team/task']);
  if (typeCount['team/member']) workSignals.push('team/member×' + typeCount['team/member']);
  if (typeCount['todo/write']) workSignals.push('todo×' + typeCount['todo/write']);
  if (assistantChars > 2000) workSignals.push('assistantText=' + assistantChars + 'ch');

  const base = {
    ...row,
    generation: gen.version,
    generationFile: gen.name,
    bytes: gen.bytes,
    mtimeMs: gen.mtimeMs,
    header,
    frameErrors,
    badLines,
    turnStarts: facts.turnStarts,
    turnEnds: facts.turnEnds,
    firstUserText: facts.firstUserText,
    title: facts.title,
    turns: facts.turns,
    assistantChars,
    workSignals,
    hasWork: workSignals.length > 0,
  };

  if (opts.now - gen.mtimeMs < opts.activeMs) return { ...base, category: 'active', detail: '新近活动，跳过' };
  if (facts.turnStarts === 0) return { ...base, category: 'zero-turn', detail: '没有过任何 turn/start' };
  if (facts.turnEnds === 0) return { ...base, category: 'turn-stuck-open', detail: `${facts.turnStarts} 个 turn/start，一个 turn/end 都没有` };

  const first = facts.turns[0];

  // 「第一轮就报错失败」要**真失败**才算，判据是两条同时成立：
  //   a) 第一轮的收束原因不是 completed —— 没有正常跑完；
  //   b) 整个会话**没有任何一轮** completed —— 也就是**一次都没成过**。
  //
  // (b) 不能省。只看 (a) 会把「第一轮被用户打断、后面十几轮都跑完了」的长会话判成废品：
  //   `session-0f9fe6cf` 第一轮 reason=aborted、总共 12 轮里有 5 轮 completed，
  //   它是一条正常使用的长会话。`aborted` / `interrupted` 是**用户按了停止**，
  //   不是站点或桥的失败——把它当失败删掉就是删用户的正经工作。
  const anyCompleted = facts.turns.some((t) => t.reason === 'completed');
  const userStopped = first.reason === 'aborted' || first.reason === 'interrupted';

  if (!anyCompleted && first.reason && !userStopped) {
    return { ...base, category: 'first-turn-failed', detail: `turn 1 reason=${first.reason}`, failReason: first.reason, failError: first.error };
  }
  if (!anyCompleted) {
    return {
      ...base,
      category: 'aborted-no-completion',
      detail: `第一轮 reason=${first.reason}，全程无 completed 轮`,
      failReason: first.reason,
      failError: first.error,
    };
  }
  return { ...base, category: 'ok', detail: `turn 1 reason=${first.reason}，有 ${facts.turns.filter((t) => t.reason === 'completed').length} 轮 completed` };
}

export const CATEGORY_ORDER = ['zero-turn', 'turn-stuck-open', 'first-turn-failed', 'aborted-no-completion', 'unreadable', 'empty-dir', 'active', 'ok'];

/**
 * 「一轮都没跑成」的类别 —— 用户要清的是这些。
 *
 * `aborted-no-completion` **刻意不在里面**：它的收束原因是用户自己按了停止，
 * 不是站点/桥的失败，交给人判断。
 */
export const PRUNABLE = new Set(['zero-turn', 'turn-stuck-open', 'first-turn-failed', 'unreadable', 'empty-dir']);

/**
 * 失败原因里**明确写着「可重试」**的那些 —— 这类一律不自动删。
 *
 * 判据来自桥自己的错误文案：`— 本轮已中止，可重试`、`请等窗口过去后…重试`、
 * `Insured` 类瞬态。它们说明**这一轮是被桥主动中止的，换个时间点就能继续**，
 * 而不是「这个会话废了」。实测 `session-63bd1b99`：4 轮、223KB，最后死在桥自己
 * 的 30 秒重建节流上（`WEB_SESSION_REBUILD_THROTTLED`，重放了 127895 字符），
 * 隔 30 秒重发就能接着跑。把它当垃圾删掉是拿掉一次本可继续的工作。
 */
const RETRIABLE_RE = /可重试|请等窗口过去|稍后重试|retry later|temporarily unavailable|timed out|rate.?limit|限流|Concurrency limit|Insufficient Balance/i;

/**
 * 最终真的会删的集合 = PRUNABLE **且** 没有任何真实产出 **且** 整条父子链都能删
 * **且** 失败原因不是「明确可重试」的瞬态。
 *
 * 这一层不能省。分类只回答「这一轮跑成了没有」，「没跑成」和「没价值」是两件事：
 * 实测 71 条 PRUNABLE 里有 20 条带着 goal、交付物、todo 或成篇正文，其中
 * `session-2f8975a0` 跑了 135 个 step / 133 次工具调用 / 4 次 goal 变更、
 * 最后停在 `goal/change:pause`（目标还挂着没关）。删掉它 = 那次工作的唯一记录没了。
 *
 * **父子链（`origin=subagent` 的 `parentSession`）是第二道闸。** 子代理会话的日志
 * 就是父会话里那次委派的全部经过：父会话还留着、子会话被删，用户点回父会话时
 * 那段子代理历史就凭空消失。实测 51 条候选里有 25 条是子代理，其中 20 条的父会话
 * 是**正常保留**的（最大的父会话 2.4MB）。这类一律不删。
 *
 * 判据是「**整条链**都得是垃圾」：父会话自己也在待删集里才放行子会话。
 * 否则会出现「删了孩子、留着爹」——爹的日志里那些子代理调用会指向不存在的会话。
 *
 * @param {object} row classify() 的产物
 * @param {Set<string>} dropRoots 「自身可删」的会话 id 集合（不含父子链判断）
 */
export function isSafeToDrop(row, dropRoots = new Set()) {
  if (!PRUNABLE.has(row.category)) return false;
  if (row.hasWork) return false;
  if (RETRIABLE_RE.test(String(row.failError || ''))) return false;
  const parent = row.header?.parentSession;
  // 有父会话、而父会话不能删 ⇒ 留着（否则父会话历史里这段委派会凭空消失）。
  if (parent && !dropRoots.has(parent)) return false;
  return true;
}

/** 读一个会话目录里版本最高那份日志的头（只解第一帧）。目录不可读/没日志时返回 null。 */
export function headerCwdOf(dir) {
  try {
    const gen = newestGeneration(dir);
    if (!gen) return null;
    const { text } = decodeZstdFrames(fs.readFileSync(gen.file));
    const first = text.split('\n').find(Boolean);
    if (!first) return null;
    const header = JSON.parse(first);
    return typeof header?.cwd === 'string' ? header.cwd : null;
  } catch { return null; }
}

/** Human-readable one-liner about why this session is being pruned. */export function reasonLine(row) {
  if (row.category === 'zero-turn') return '未进入任何一轮（打开就关/开不起来）';
  if (row.category === 'turn-stuck-open') return `${row.turnStarts} 个 turn/start 但一个 turn/end 都没有 —— 第一轮中途中断`;
  if (row.category === 'first-turn-failed') return `第一轮失败：reason=${row.failReason}`;
  if (row.category === 'aborted-no-completion') return `用户中断、且全程没有一轮跑完：reason=${row.failReason}（不自动删）`;
  if (row.category === 'unreadable') return `日志读不出来：${row.detail}`;
  if (row.category === 'empty-dir') return `空目录：${row.detail}`;
  if (row.category === 'active') return '活跃，跳过';
  return `第一轮完成：reason=${row.detail}`;
}

function parseArgs(argv) {
  const opts = { json: null, md: null, cwd: process.cwd(), all: false, activeMin: 60, target: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') opts.json = argv[++i];
    else if (a === '--md') opts.md = argv[++i];
    else if (a === '--cwd') opts.cwd = argv[++i];
    else if (a === '--all') opts.all = true;
    else if (a === '--active-min') opts.activeMin = Number(argv[++i]) || 60;
    else if (a.startsWith('--')) throw new Error('未知选项：' + a);
    else opts.target = a;
  }
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  const now = Date.now();
  const activeMs = opts.activeMin * 60 * 1000;

  const all = listAllSessions().map((r) => classify(r, { activeMs, now }));
  let scoped = all;
  if (!opts.all) {
    // 只认**同一个 cwd**。会话目录名是 DSH 自己的 projectKey 编码，不必去猜它的算法：
    // 每条会话的事件头里本来就有真实 `cwd`，拿它逐字比对即可（大小写不敏感，Windows）。
    // 不用后缀匹配——那会把兄弟项目（`dsh-webcode-bridge` vs 未来的 `webcode-bridge`）一起捞进来。
    const want = path.resolve(opts.cwd).toLowerCase();
    scoped = all.filter((r) => typeof r.header?.cwd === 'string' && r.header.cwd.toLowerCase() === want);
    if (!scoped.length) throw new Error('没找到 cwd = ' + want + ' 的会话\n用 --all 扫全部工作区确认。');
  }

  const byCat = {};
  for (const r of scoped) byCat[r.category] = (byCat[r.category] || 0) + 1;

  const prunable = scoped.filter((r) => PRUNABLE.has(r.category));
  // 第一遍：先只按「类别 + 有无产出」算出**根候选**（不看父子链）。
  const dropRoots = new Set(prunable.filter((r) => isSafeToDrop(r, new Set())).map((r) => r.id));
  // 第二遍：把父子链算进去 —— 子会话只有在父会话也能删时才跟着删。
  const safeToDrop = prunable.filter((r) => isSafeToDrop(r, dropRoots));
  const needsReview = prunable.filter((r) => !isSafeToDrop(r, dropRoots));
  const report = {
    generatedAt: new Date(now).toISOString(),
    scope: opts.all ? 'all-workspaces' : opts.cwd,
    activeWindowMinutes: opts.activeMin,
    total: scoped.length,
    counts: byCat,
    prunableCount: prunable.length,
    safeToDropCount: safeToDrop.length,
    needsReviewCount: needsReview.length,
    safeToDrop,
    needsReview,
    prunable,
    kept: scoped.filter((r) => !PRUNABLE.has(r.category)),
  };
  if (opts.json) {
    fs.mkdirSync(path.dirname(path.resolve(opts.json)), { recursive: true });
    fs.writeFileSync(path.resolve(opts.json), JSON.stringify(report, null, 2), 'utf8');
    console.log('[json] ' + path.resolve(opts.json));
  }
  console.log(`扫描 ${scoped.length} 个会话（范围=${report.scope}，活跃窗口=${opts.activeMin} 分钟）`);
  for (const c of CATEGORY_ORDER) if (byCat[c]) console.log(`  ${c.padEnd(18)} ${byCat[c]}`);
  console.log(`一轮没跑成 ${prunable.length} 个 = 可安全清理 ${safeToDrop.length} 个 + 有产出待复核 ${needsReview.length} 个；正常保留 ${report.kept.length} 个`);
  if (!opts.json) {
    console.log('\n-- 可安全清理（无任何产出）--');
    for (const r of safeToDrop.slice(0, 400)) {
      console.log(`  [${r.category}] ${r.id}  ${new Date(r.mtimeMs).toISOString().slice(0, 19)}  ${reasonLine(r)}`);
    }
    console.log('\n-- 待人工复核（没跑成，但有 goal / 交付物 / todo / 成篇正文）--');
    for (const r of needsReview.slice(0, 400)) {
      console.log(`  [${r.category}] ${r.id}  ${(r.bytes / 1024).toFixed(0)}KB  ${r.workSignals.join(' ')}`);
    }
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try { main(process.argv.slice(2)); }
  catch (e) { console.error('dsh-session-cleanup-scan: ' + (e?.message || e)); process.exitCode = 1; }
}
