#!/usr/bin/env node
// parse-session-log.mjs — DSH 会话日志（`session.v3.jsonl.zstd`）解析器。
//
// 为什么需要这个文件（而不是每次临时拼一条 node 命令）：
//
// DSH 的会话落盘是 **多帧拼接** 的 zstd —— 一条 jsonl 事件一帧。踩过的坑：
// `zstdDecompressSync(buf)` 只解**第一帧**，于是文件明明 1.3 MB、解出来只有
// 220 字节（那条 `{"type":"session",...}` 头），看起来「日志是空的」。
// 正确做法是按 zstd magic（`28 B5 2F FD`）切帧后逐帧解压。
//
// 这个坑在 2026-09-14 的会话里被反复踩了三次（三次都以为日志只有一行），
// 所以解析逻辑必须进仓库、可复用、可被下一次会话直接调用，而不是留在
// 某个终端的历史里。
//
// 用法：
//   node test-mock/parse-session-log.mjs <会话目录|session.v3.jsonl.zstd>
//   node test-mock/parse-session-log.mjs --recent 2            # 本工作区最近 2 个会话
//   node test-mock/parse-session-log.mjs --recent 3 --errors-only
//   node test-mock/parse-session-log.mjs <path> --json > out.json
//
// 选项：
//   --recent N      在默认 sessions 根下取最近 N 个会话目录（按 mtime 倒序）
//   --errors-only   只打印失败项（turn/end 非 completed、tool/result isError）
//   --json          输出机器可读 JSON（给后续脚本/报告用）
//   --tail N        每个明细段落最多打印 N 条（默认 40）
//   --text-chars N  正文/推理片段截断长度（默认 400）
//   --sessions-root 覆盖 sessions 根目录
//
// 退出码：0 正常；1 参数/路径错误。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** zstd 帧魔数：每一帧都以它开头，用来切多帧文件。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 默认的会话根目录：`<DSH home>/sessions/<escaped-cwd>/<sessionId>/`。 */
function defaultSessionsRoot() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'sessions');
}

/**
 * 把当前工作目录转成 DSH 的会话目录名。
 *
 * DSH 用「路径里非字母数字的字符 → `-`」的规则生成目录名（`D:\9_...` →
 * `--D-9_...--`）。这里只用于 `--recent` 的默认作用域，取不到就退化成
 * 整个 sessions 根（调用方仍能看到全部会话，只是顺序按时间）。
 */
function sessionDirNameForCwd(cwd = process.cwd()) {
  const normalized = path.resolve(cwd);
  // DSH 的转义规则：非 [A-Za-z0-9_] 一律变 '-'，首尾各补一个 '-'。
  // 真机实测：`D:\9_Code_Workspace\dsh-webcode-bridge` →
  //   `--D-9_Code_Workspace-dsh-webcode-bridge--`（下划线保留）。
  // 早先按 [^A-Za-z0-9] 写会把 `_` 也吃掉，目录名就对不上、一条会话都找不到。
  const esc = normalized.replace(/[^A-Za-z0-9_]/g, '-').replace(/^-+|-+$/g, '');
  return '--' + esc + '--';
}

/** 按 zstd 魔数切帧并逐帧解压，拼成完整文本。 */
export function decodeZstdFrames(buf) {
  const offsets = [];
  let i = 0;
  while ((i = buf.indexOf(ZSTD_MAGIC, i)) !== -1) {
    offsets.push(i);
    i += ZSTD_MAGIC.length;
  }
  if (!offsets.length) return { frames: 0, text: '', frameErrors: [] };
  const chunks = [];
  const frameErrors = [];
  for (let k = 0; k < offsets.length; k++) {
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    try {
      chunks.push(decompressFrame(buf.subarray(offsets[k], end)));
    } catch (e) {
      // 单帧坏掉不能丢掉整个文件：记下来继续解后面的帧。
      frameErrors.push({ offset: offsets[k], message: String(e?.message || e) });
    }
  }
  return { frames: offsets.length, text: chunks.join(''), frameErrors };
}

/**
 * 解一帧。
 *
 * `zstdDecompressSync` 在遇到「尾部有下一帧的字节」时会报
 * `premature end`/`unknown frame descriptor`，但它**已经解出的部分**是有价值的
 * —— 因此先按整帧试，失败则退回到流式解压，取已解出的数据。
 */
function decompressFrame(frame) {
  const zlib = zstd();
  try {
    return zlib.zstdDecompressSync(frame).toString('utf8');
  } catch (e) {
    try {
      return zlib.zstdDecompressSync(frame, { finishFlush: zlib.constants.ZSTD_e_continue }).toString('utf8');
    } catch {
      throw e;
    }
  }
}

let _zlib = null;
function zstd() {
  if (!_zlib) _zlib = require$zlib();
  return _zlib;
}

// ESM 里拿 node:zlib（保持顶层 import 简单，同时允许上面的懒加载）。
function require$zlib() {
  return zlibModule;
}

import zlibModule from 'node:zlib';

/** 读一个会话文件，返回解析后的事件数组与元信息。 */
export function readSessionLog(file) {
  const buf = fs.readFileSync(file);
  const { frames, text, frameErrors } = decodeZstdFrames(buf);
  const events = [];
  const badLines = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch (e) {
      badLines.push({ message: String(e?.message || e), head: line.slice(0, 120) });
    }
  }
  return { file, bytes: buf.length, chars: text.length, frames, events, badLines, frameErrors };
}

/** 事件类型直方图。 */
export function histogram(events) {
  const out = {};
  for (const e of events) {
    const k = e?.type || '(no type)';
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

/** 取消息里的纯文本块（正文），拼成一段。 */
function textOf(content, kinds = ['text']) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && kinds.includes(b.type) && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

/** 消息里所有 tool-call 块的 { name, arguments }。 */
function toolCallsOf(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => b && (b.type === 'tool-call' || b.name) && b.type === 'tool-call')
    .map((b) => ({ name: b.name || '?', arguments: typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments ?? '') }));
}

/** 把一次会话的事件流压成报告需要的结构。 */
export function summarize(session, { textChars = 400 } = {}) {
  const { events } = session;
  const turns = [];
  const errors = [];
  const toolCalls = [];
  const userMessages = [];
  const titles = [];
  const goals = [];
  const todos = [];
  const presented = [];
  let currentTurn = null;

  for (const e of events) {
    switch (e.type) {
      case 'turn/start': {
        currentTurn = { turn: e.data?.turn ?? turns.length + 1, startAt: e.time, reason: null, error: null, steps: 0, calls: 0 };
        turns.push(currentTurn);
        break;
      }
      case 'turn/end': {
        const t = currentTurn || { turn: turns.length, steps: 0, calls: 0 };
        const reason = e.data?.reason || e.reason || null;
        t.reason = reason?.kind || String(reason || 'unknown');
        t.error = reason?.error?.message ? String(reason.error.message) : null;
        t.endAt = e.time;
        if (t.reason !== 'completed') errors.push({ kind: 'turn/end', turn: t.turn, reason: t.reason, message: t.error });
        currentTurn = null;
        break;
      }
      case 'step/start': {
        if (currentTurn) currentTurn.steps += 1;
        break;
      }
      case 'user/message': {
        const src = e.data?.source?.kind;
        const text = textOf(e.data?.content);
        if (!text) break;
        // 插件注入的运行时快照（sandbox/policy、skills 目录）不算「用户说的话」。
        if (src === 'plugin') break;
        userMessages.push({ seq: e.seq, source: src || 'user', text: clip(text, textChars) });
        break;
      }
      case 'assistant/message': {
        const content = e.data?.message?.content;
        const text = textOf(content);
        const reasoning = textOf(content, ['reasoning']);
        const calls = toolCallsOf(content);
        if (currentTurn) currentTurn.calls += calls.length;
        for (const c of calls) toolCalls.push({ turn: currentTurn?.turn ?? null, step: e.data?.step ?? null, name: c.name, args: clip(c.arguments, 160) });
        if (text) {
          const leaked = detectProtocolLeak(text);
          if (leaked) errors.push({ kind: 'assistant/message', turn: currentTurn?.turn ?? null, reason: 'protocol-leak', message: leaked });
        }
        break;
      }
      case 'tool/result': {
        const blocks = e.data?.message?.content || [];
        for (const b of blocks) {
          if (b?.type !== 'tool-result') continue;
          const inner = Array.isArray(b.content) ? b.content : [];
          const txt = inner.filter((x) => x?.type === 'text').map((x) => x.text).join('\n');
          if (b.isError || e.data?.message?.isError) {
            errors.push({ kind: 'tool/result', turn: currentTurn?.turn ?? null, reason: 'isError', message: clip(txt || '(no text)', 300) });
          }
        }
        break;
      }
      case 'session/title':
        if (e.data?.title) titles.push({ title: e.data.title, source: e.data.source?.kind || null });
        break;
      case 'goal/change':
        goals.push({ operation: e.data?.operation, objective: clip(String(e.data?.goal?.objective || ''), 300), round: e.data?.roundsStarted ?? null });
        break;
      case 'todo/write':
        todos.push({ seq: e.seq, items: Array.isArray(e.data?.todos) ? e.data.todos : (Array.isArray(e.data) ? e.data : []) });
        break;
      case 'deliverables/presented':
        presented.push(clip(JSON.stringify(e.data ?? {}), 300));
        break;
      default:
        break;
    }
  }

  return {
    file: session.file,
    bytes: session.bytes,
    chars: session.chars,
    frames: session.frames,
    entries: events.length,
    badLines: session.badLines,
    frameErrors: session.frameErrors,
    types: histogram(events),
    turns,
    errors,
    toolCalls,
    userMessages,
    titles,
    goals,
    todos,
    presented,
  };
}

/**
 * 检测正文里是否残留协议记号（0.9.4 起 bridge 应在写入会话前剥掉）。
 *
 * 只认「真调用形状」——`<tool_call>` 标签、DSML 全角标记、`{"mcp_action":"call"`
 * 这种本桥自己的调用外壳。散落的 `<` `>` 或普通 JSON 不算，避免误报。
 *
 * ⚠ 检测器**必须与被保护的正则同步扩集**（0.14.6 的教训）：旧版本只认
 * `<tool_call>` / `<tool_result>` / DSML / mcp_action，于是
 * `</call>` 与 `<call_call>` 残片既漏过边界锚点、**也漏过本检测器**——
 * 「日志没有泄漏告警」是**假阴性**，13 处残片是靠直接扫 text 块才抓到的。
 * 现在 `call` / `call_call` 同时进了 `lib/agent-preset.js` 的 PROTOCOL_ANCHORS
 * 与本检测器；两者必须保持同一套形态知识。
 * 安全性：`(?![\w-])` 让 `<calling>` 不命中。
 */
export function detectProtocolLeak(text) {
  const patterns = [
    /<tool_call>/i,
    /<\/tool_call>/i,
    // 无下划线的 `toolcall` / `toolcalls`（0.15.0）：0.14.6 扩集时漏掉的一族，而它
    // 恰恰出现在**最新两个会话**里（session-94966bd8 seq=2798/2983、session-f9010b75
    // seq=812）。当时本检测器与 lib/agent-preset.js 的 PROTOCOL_ANCHORS 共享同一个盲区，
    // 于是那些 text 块里的残片**一个告警都没有**——又是假阴性。
    // 两条断言同时钉住同步性：test/protocol-leak.test.mjs 的
    // 「六种形态 probe 与 parser 必须一致」+ 本文件的 --errors-only 真机扫描。
    /<\/?\s*toolcalls?(?![\w-])/i,
    /\{\s*"mcp_action"\s*:\s*"call"/i,
    /<\s*[｜|]{1,2}DSML[｜|]{1,2}/i,
    /<\/tool_result>/i,
    /<tool_result>/i,
    /<\/?\s*call_call(?![\w-])/i,
    /<\/?\s*call(?![\w-])/i,
  ];
  for (const p of patterns) {
    const m = p.exec(text);
    if (m) return '命中 ' + p.source + ' @' + m.index;
  }
  return null;
}

function clip(s, n) {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n) + `…(+${t.length - n})` : t;
}

/** 在 sessions 根下按 mtime 取最近 N 个含 `session.v3.jsonl.zstd` 的会话目录。 */
export function recentSessions(root, n) {
  const rows = [];
  const scan = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of entries) {
      if (!d.isDirectory()) continue;
      const sub = path.join(dir, d.name);
      const file = path.join(sub, 'session.v3.jsonl.zstd');
      if (fs.existsSync(file)) {
        rows.push({ name: d.name, file, mtime: fs.statSync(file).mtimeMs });
        continue;
      }
      // sessions 根下是按 cwd 分层的目录（`--D-9_...--`），真正的会话在其下一层。
      // 旧实现只看第一层，于是「找不到任何会话日志」——这就是当时的症状。
      if (depth > 0) scan(sub, depth - 1);
    }
  };
  scan(root, 1);
  rows.sort((a, b) => b.mtime - a.mtime);
  return rows.slice(0, n);
}

/** 把路径解析成「一批会话文件」：目录 → 其下会话；单文件 → 它自己。 */
export function resolveTargets(target) {
  const p = path.resolve(target);
  const st = fs.statSync(p);
  if (st.isFile()) return [{ name: path.basename(path.dirname(p)) || path.basename(p), file: p }];
  const direct = path.join(p, 'session.v3.jsonl.zstd');
  if (fs.existsSync(direct)) return [{ name: path.basename(p), file: direct }];
  // 当成 sessions 根：取全部会话
  return recentSessions(p, Number.MAX_SAFE_INTEGER).map((r) => ({ name: r.name, file: r.file }));
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const opts = { recent: 0, errorsOnly: false, json: false, tail: 40, textChars: 400, sessionsRoot: null, target: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--recent') opts.recent = Number(argv[++i]) || 0;
    else if (a === '--errors-only') opts.errorsOnly = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--tail') opts.tail = Number(argv[++i]) || 40;
    else if (a === '--text-chars') opts.textChars = Number(argv[++i]) || 400;
    else if (a === '--sessions-root') opts.sessionsRoot = argv[++i];
    else if (a.startsWith('--')) throw new Error('未知选项：' + a);
    else opts.target = a;
  }
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  let targets = [];
  if (opts.target) {
    targets = resolveTargets(opts.target);
  } else {
    const root = opts.sessionsRoot || path.join(defaultSessionsRoot(), sessionDirNameForCwd());
    const base = fs.existsSync(root) ? root : defaultSessionsRoot();
    targets = recentSessions(base, opts.recent || 2);
  }
  if (!targets.length) {
    console.error('没有找到任何会话日志。用 --sessions-root 指定 sessions 根，或直接传路径。');
    process.exitCode = 1;
    return;
  }

  const reports = targets.map((t) => summarize(readSessionLog(t.file), { textChars: opts.textChars }));

  if (opts.json) {
    console.log(JSON.stringify(reports, null, 2));
    return;
  }

  for (const r of reports) {
    console.log('');
    console.log('='.repeat(78));
    console.log('会话 ' + path.basename(path.dirname(r.file)));
    console.log('  文件 ' + r.file);
    console.log('  大小 ' + r.bytes + ' B → 解出 ' + r.chars + ' 字符，' + r.frames + ' 个 zstd 帧，' + r.entries + ' 条事件');
    if (r.frameErrors.length) console.log('  ⚠ 坏帧 ' + r.frameErrors.length + '：' + r.frameErrors.map((f) => f.message).join('; '));
    if (r.badLines.length) console.log('  ⚠ 无法解析的行 ' + r.badLines.length);
    console.log('  类型 ' + JSON.stringify(r.types));
    if (r.titles.length) console.log('  标题 ' + JSON.stringify(r.titles[r.titles.length - 1]));
    if (r.goals.length) console.log('  goal ' + JSON.stringify(r.goals[0]).slice(0, 300));

    console.log('');
    console.log('-- 轮次 --');
    for (const t of r.turns) {
      const flag = t.reason === 'completed' ? '✔' : '✖';
      console.log(`  ${flag} turn ${t.turn}  steps=${t.steps} calls=${t.calls}  reason=${t.reason}`);
      if (t.error) console.log('       ' + clip(t.error.replace(/\s+/g, ' '), 400));
    }

    console.log('');
    console.log('-- 用户输入 --');
    for (const u of r.userMessages.slice(-opts.tail)) {
      console.log(`  [seq ${u.seq}] (${u.source}) ${u.text.replace(/\s+/g, ' ').slice(0, opts.textChars)}`);
    }

    console.log('');
    console.log('-- 失败项 --');
    if (!r.errors.length) console.log('  （无）');
    for (const e of r.errors.slice(0, opts.tail)) {
      console.log(`  ✖ [${e.kind}] turn=${e.turn} ${e.reason}: ${String(e.message).replace(/\s+/g, ' ').slice(0, 300)}`);
    }

    if (!opts.errorsOnly) {
      console.log('');
      console.log('-- 工具调用（名字计数）--');
      const byName = {};
      for (const c of r.toolCalls) byName[c.name] = (byName[c.name] || 0) + 1;
      console.log('  ' + JSON.stringify(byName));

      console.log('');
      console.log('-- 最后 ' + Math.min(opts.tail, r.toolCalls.length) + ' 次工具调用 --');
      for (const c of r.toolCalls.slice(-opts.tail)) {
        console.log(`  turn ${c.turn} step ${c.step} ${c.name}(${c.args.replace(/\s+/g, ' ').slice(0, 140)})`);
      }
    }
  }
}

// 只有被直接执行时才跑 CLI（被 import 时保持纯函数库）。
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (invokedDirectly) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error('parse-session-log: ' + (e?.message || e));
    process.exitCode = 1;
  }
}