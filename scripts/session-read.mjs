#!/usr/bin/env node
// session-read.mjs — 按「会话地址 / id / 路径」读取 DSH 会话日志，导出成可直读的记录。
//
// 为什么需要这个文件：
//
// DSH 的会话落盘是 **多帧拼接** 的 zstd（一条 jsonl 事件一帧，文件里几百帧）。
// 踩过的坑：`zstdDecompressSync(buf)` 只解**第一帧**，于是文件明明 1.3 MB、
// 解出来只有 220 字节（那条 `{"type":"session",...}` 头），看起来「日志是空的」。
// 这个坑在 2026-09-14 的会话里被反复踩了三次，每次都在终端里临时拼一条 node
// 命令。那些临时命令随会话结束就消失了，下一次又得重新踩。
//
// 所以这里把「找到会话 → 解多帧 zstd → 渲染成人能读的记录」做成**一个可复用入口**，
// 并且接受人们实际会手里的那种东西：GUI 里的会话链接、会话 id、id 片段、目录路径。
//
// 用法：
//   node scripts/session-read.mjs                       # 最近 1 个会话，打印摘要
//   node scripts/session-read.mjs latest                # 同上
//   node scripts/session-read.mjs --list                # 列出全部会话（挑一个再读）
//   node scripts/session-read.mjs --recent 5            # 最近 5 个会话的摘要
//   node scripts/session-read.mjs f9010b75              # 按 id 片段（必须唯一匹配）
//   node scripts/session-read.mjs session-f9010b75-258b-4154-833f-832fa399b5b6
//   node scripts/session-read.mjs <目录|session.v3.jsonl.zstd 路径>
//   node scripts/session-read.mjs "http://127.0.0.1:3080/?session=session-f9010b75-..."
//
// 导出完整记录（这是「让它自己阅读理解」的主用法）：
//   node scripts/session-read.mjs f9010b75 --out            # 默认写到 .tmp/session-<id>.md
//   node scripts/session-read.mjs f9010b75 --out D:\x.md
//   node scripts/session-read.mjs f9010b75 --transcript     # 直接打到 stdout
//
// 选项：
//   --list           列出全部会话（id / 时间 / 大小 / 工作区）
//   --recent N       取最近 N 个会话
//   --out [文件]     导出可读记录（不带值则用 .tmp/session-<短id>.md）
//   --transcript     把完整转录打到 stdout
//   --errors-only    摘要里只留失败项
//   --chars N        每条记录截断长度（默认 600）
//   --tail N         明细段落最多 N 条（默认 60）
//   --json           摘要以 JSON 输出
//
// 退出码：0 正常；1 参数/路径/匹配错误。
//
// ⚠ 跨工作区：会话目录是 `<sessions 根>/<转义后的 cwd>/<sessionId>/`。
//   本脚本**默认扫全部工作区**，而不是只看当前 cwd——用户给一个 id 时，
//   他并不关心那个会话属于哪个目录。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

/** zstd 帧魔数：每一帧都以它开头，用来切多帧文件。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 会话文件名（DSH v3 落盘格式）。 */
const SESSION_FILE = 'session.v3.jsonl.zstd';

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function sessionsRoot() {
  return path.join(dshHome(), 'sessions');
}

// ------------------------------------------------------------------ 多帧 zstd

/**
 * 按 zstd 魔数切帧并逐帧解压，拼成完整文本。
 *
 * 关键设计：**帧尾不靠魔数硬切**。压缩数据里可能出现与魔数相同的字节序列，
 * 硬切会产生一个坏帧、并把它后面的真帧一起带坏。这里的做法是「从当前帧起点
 * 向后找最近的、能成功解压的终点」——解码器自己会拒绝残缺输入，
 * 所以「第一次成功」就是真实帧边界。
 *
 * @param {Buffer} buf 整个 zstd 文件
 * @returns {{frames:number, text:string, frameErrors:Array}}
 */
export function decodeZstdFrames(buf) {
  const offsets = [];
  let i = -1;
  while ((i = buf.indexOf(ZSTD_MAGIC, i + 1)) !== -1) offsets.push(i);
  if (!offsets.length) return { frames: 0, text: '', frameErrors: [] };
  offsets.push(buf.length);

  const chunks = [];
  const frameErrors = [];
  let k = 0;
  while (k < offsets.length - 1) {
    const start = offsets[k];
    let decoded = null;
    let end = k;
    // 从最近的终点开始试，逐步放宽；成功后把游标跳到那个终点。
    for (let j = k + 1; j < offsets.length; j += 1) {
      try {
        const out = decompressFrame(buf.subarray(start, offsets[j]));
        if (out.length) { decoded = out; end = j; break; }
      } catch { /* 终点太早，继续放宽 */ }
    }
    if (decoded) {
      chunks.push(decoded);
      k = end;
    } else {
      frameErrors.push({ offset: start, message: 'frame could not be decompressed' });
      k += 1;
    }
  }
  return { frames: offsets.length - 1, text: chunks.join(''), frameErrors };
}

/**
 * 解一帧。`zstdDecompressSync` 在「尾部带下一帧字节」时会报
 * `premature end` / `unknown frame descriptor`，但**已解出的部分是有价值的**，
 * 因此失败时退回流式解压取回已解数据。
 */
function decompressFrame(frame) {
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

// ------------------------------------------------------------------ 定位会话

/**
 * 枚举 sessions 根下**全部工作区**的会话。
 *
 * 目录形状：`<root>/<escaped-cwd>/<sessionId>/session.v3.jsonl.zstd`。
 * 只下探两层——再深就不是会话了（历史上有过误把 profile 目录当会话的教训）。
 */
export function listAllSessions(root = sessionsRoot()) {
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of entries) {
      if (!d.isDirectory()) continue;
      const sub = path.join(dir, d.name);
      const file = path.join(sub, SESSION_FILE);
      if (fs.existsSync(file)) {
        const st = fs.statSync(file);
        out.push({
          id: d.name,
          file,
          bytes: st.size,
          mtime: st.mtimeMs,
          workspace: path.basename(dir),
        });
        continue;
      }
      if (depth > 1) walk(sub, depth - 1);
    }
  };
  walk(root, 2);
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/** 从任意字符串里抽出「像会话 id」的候选（链接、路径、纯 id 都能用）。 */
export function extractIdCandidates(ref) {
  const s = String(ref || '');
  const cands = new Set();
  // `session-<uuid>` 完整形状
  for (const m of s.matchAll(/session-[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}/g)) cands.add(m[0]);
  // 裸 uuid（子代理/团队会话的目录名没有 session- 前缀）
  for (const m of s.matchAll(/[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}/g)) cands.add(m[0]);
  return [...cands];
}

/**
 * 把用户的「会话地址」解析成一批会话条目。
 *
 * 接受：真实路径（文件或目录）→ 链接/纯 id → id 片段（前缀，要求唯一）。
 * 片段命中多个时**报错并列出候选**，而不是随便挑一个——猜错会话比报错更糟。
 */
export function resolveRef(ref, { all = null } = {}) {
  const sessions = all || listAllSessions();

  // 1) 真实文件/目录优先（用户可能直接粘路径）
  if (ref && fs.existsSync(ref)) {
    const p = path.resolve(ref);
    if (fs.statSync(p).isFile()) return [{ id: path.basename(path.dirname(p)), file: p, bytes: fs.statSync(p).size, mtime: fs.statSync(p).mtimeMs, workspace: '?' }];
    const direct = path.join(p, SESSION_FILE);
    if (fs.existsSync(direct)) return [{ id: path.basename(p), file: direct, bytes: fs.statSync(direct).size, mtime: fs.statSync(direct).mtimeMs, workspace: path.basename(path.dirname(p)) }];
  }

  // 2) 链接 / id：先精确、再片段
  const cands = extractIdCandidates(ref);
  const exact = sessions.filter((s) => s.id === ref || cands.includes(s.id));
  if (exact.length) return exact.slice(0, 1);

  const needle = String(ref || '').trim().toLowerCase();
  if (!needle || needle === 'latest') return sessions.slice(0, 1);

  const partial = sessions.filter((s) => s.id.toLowerCase().includes(needle));
  if (partial.length === 1) return partial;
  if (partial.length > 1) {
    const err = new Error('id 片段「' + ref + '」匹配到 ' + partial.length + ' 个会话，请给更长的前缀：\n' +
      partial.slice(0, 10).map((s) => '  ' + s.id + '  ' + new Date(s.mtime).toISOString()).join('\n'));
    err.code = 'AMBIGUOUS';
    throw err;
  }
  throw new Error('找不到会话：' + ref + '\n先用 --list 看有哪些。');
}

// ------------------------------------------------------------------ 解析

/** 读一个会话文件 → 事件数组 + 元信息。 */
export function readSessionLog(file) {
  const buf = fs.readFileSync(file);
  const { frames, text, frameErrors } = decodeZstdFrames(buf);
  const events = [];
  const badLines = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { events.push(JSON.parse(line)); }
    catch (e) { badLines.push({ message: String(e?.message || e), head: line.slice(0, 120) }); }
  }
  return { file, bytes: buf.length, chars: text.length, frames, events, badLines, frameErrors };
}

function clip(s, n) {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n) + `…(+${t.length - n})` : t;
}

function textOf(content, kinds = ['text']) {
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && kinds.includes(b.type) && typeof b.text === 'string').map((b) => b.text).join('\n');
}

/** 事件类型直方图。 */
export function histogram(events) {
  const out = {};
  for (const e of events) { const k = e?.type || '(no type)'; out[k] = (out[k] || 0) + 1; }
  return out;
}

/**
 * 把事件流压成「轮次 / 失败项 / 用户输入 / 工具调用」结构。
 * 与 test-mock/parse-session-log.mjs 的口径一致，便于两份报告互相印证。
 */
export function summarize(session, { chars = 600, tail = 60 } = {}) {
  const { events } = session;
  const t0 = events.find((e) => typeof e.time === 'number')?.time ?? null;
  const turns = [];
  const errors = [];
  const userMessages = [];
  const titles = [];
  const goals = [];
  const toolCalls = [];
  let cur = null;
  let meta = null;

  for (const e of events) {
    switch (e.type) {
      case 'session': meta = e; break;
      case 'turn/start': {
        cur = { turn: e.data?.turn ?? turns.length + 1, startAt: e.time, endAt: null, reason: null, error: null, steps: 0, calls: 0 };
        turns.push(cur);
        break;
      }
      case 'turn/end': {
        const t = cur || turns[turns.length - 1];
        const reason = e.data?.reason || null;
        if (t) {
          t.reason = reason?.kind || String(reason || 'unknown');
          t.error = reason?.error?.message ? String(reason.error.message) : null;
          t.endAt = e.time;
          if (t.reason !== 'completed') errors.push({ kind: 'turn/end', turn: t.turn, reason: t.reason, message: t.error });
        }
        cur = null;
        break;
      }
      case 'step/start': if (cur) cur.steps += 1; break;
      case 'user/message': {
        const text = textOf(e.data?.content);
        if (!text) break;
        const src = e.data?.source?.kind || e.data?.source || 'user';
        userMessages.push({ seq: e.seq, at: e.time, source: typeof src === 'string' ? src : JSON.stringify(src), text: clip(text, chars) });
        break;
      }
      case 'assistant/message': {
        const content = e.data?.message?.content;
        const text = textOf(content);
        const calls = Array.isArray(content) ? content.filter((b) => b?.type === 'tool-call') : [];
        if (cur) cur.calls += calls.length;
        for (const c of calls) toolCalls.push({ turn: cur?.turn ?? null, step: e.data?.step ?? null, name: c.name || '?', args: clip(typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? ''), 200) });
        break;
      }
      case 'tool/result': {
        for (const b of e.data?.message?.content || []) {
          if (b?.type !== 'tool-result') continue;
          const inner = Array.isArray(b.content) ? b.content : [];
          const txt = inner.filter((x) => x?.type === 'text').map((x) => x.text).join('\n');
          if (b.isError || e.data?.message?.isError) {
            errors.push({ kind: 'tool/result', turn: cur?.turn ?? null, reason: 'isError', message: clip(txt || '(no text)', 300) });
          }
        }
        break;
      }
      case 'session/title': if (e.data?.title) titles.push({ at: e.time, title: e.data.title, source: e.data.source?.kind || null }); break;
      case 'goal/change': goals.push({ at: e.time, operation: e.data?.operation, round: e.data?.roundsStarted ?? null, objective: clip(String(e.data?.goal?.objective || ''), 300) }); break;
      default: break;
    }
  }

  const last = events.length ? events[events.length - 1] : null;
  return {
    file: session.file,
    bytes: session.bytes,
    chars: session.chars,
    frames: session.frames,
    entries: events.length,
    badLines: session.badLines,
    frameErrors: session.frameErrors,
    types: histogram(events),
    meta,
    t0,
    tEnd: last?.time ?? null,
    turns,
    errors,
    userMessages,
    titles,
    goals,
    toolCalls: toolCalls.slice(-tail),
  };
}

// ------------------------------------------------------------------ 渲染

const fmtTime = (t) => (typeof t === 'number' ? new Date(t).toISOString() : '?');
const dur = (a, b) => (typeof a === 'number' && typeof b === 'number' ? ((b - a) / 1000).toFixed(0) + 's' : '?');

/** 摘要文本（给人看的短版，也是默认输出）。 */
export function renderSummary(rep) {
  const L = [];
  L.push('会话 ' + path.basename(path.dirname(rep.file)));
  L.push('  文件 ' + rep.file);
  L.push('  大小 ' + rep.bytes + ' B → 解出 ' + rep.chars + ' 字符，' + rep.frames + ' 个 zstd 帧，' + rep.entries + ' 条事件');
  if (rep.frameErrors.length) L.push('  ⚠ 坏帧 ' + rep.frameErrors.length);
  if (rep.badLines.length) L.push('  ⚠ 无法解析的行 ' + rep.badLines.length);
  if (rep.meta?.cwd) L.push('  工作目录 ' + rep.meta.cwd);
  L.push('  开始 ' + fmtTime(rep.t0) + '   结束 ' + fmtTime(rep.tEnd));
  L.push('  类型 ' + JSON.stringify(rep.types));
  if (rep.titles.length) L.push('  标题 ' + JSON.stringify(rep.titles[rep.titles.length - 1].title));
  L.push('');
  L.push('-- 轮次 --');
  for (const t of rep.turns) {
    L.push(`  ${t.reason === 'completed' ? '✔' : '✖'} turn ${t.turn}  steps=${t.steps} calls=${t.calls}  用时=${dur(t.startAt, t.endAt)}  reason=${t.reason}`);
    if (t.error) L.push('       ' + clip(t.error.replace(/\s+/g, ' '), 300));
  }
  L.push('');
  L.push('-- 失败项 --');
  if (!rep.errors.length) L.push('  （无）');
  for (const e of rep.errors.slice(0, 40)) L.push(`  ✖ [${e.kind}] turn=${e.turn} ${e.reason}: ${String(e.message).replace(/\s+/g, ' ').slice(0, 260)}`);
  L.push('');
  L.push('-- 工具调用（名字计数）--');
  const byName = {};
  for (const c of rep.toolCalls) byName[c.name] = (byName[c.name] || 0) + 1;
  L.push('  ' + JSON.stringify(byName));
  return L.join('\n');
}

/**
 * 完整可读记录（markdown）——这是「让它自己阅读理解」的产物。
 *
 * 渲染原则：**保留顺序与角色边界**（user / assistant / tool-call / tool-result），
 * 每条按 chars 截断。巨量输出在这里被有意压缩：完整 jsonl 另存一份，
 * 需要某条原文时再去查它，而不是让整份记录大到读不完。
 */
export function renderTranscript(session, rep, { chars = 600 } = {}) {
  const L = [];
  const id = path.basename(path.dirname(rep.file));
  L.push('# 会话记录 ' + id);
  L.push('');
  L.push('- 文件: `' + rep.file + '`');
  if (rep.meta?.cwd) L.push('- 工作目录: `' + rep.meta.cwd + '`');
  L.push('- 开始: ' + fmtTime(rep.t0));
  L.push('- 结束: ' + fmtTime(rep.tEnd));
  L.push('- 规模: ' + rep.bytes + ' B → ' + rep.chars + ' 字符，' + rep.frames + ' 帧 zstd，' + rep.entries + ' 条事件');
  L.push('- 类型: `' + JSON.stringify(rep.types) + '`');
  if (rep.titles.length) L.push('- 标题: ' + JSON.stringify(rep.titles.map((t) => t.title)));
  L.push('');
  L.push('## 轮次概览');
  L.push('');
  L.push('| turn | 结果 | steps | tool-calls | 用时 | 结束原因 |');
  L.push('| --- | --- | --- | --- | --- | --- |');
  for (const t of rep.turns) {
    L.push(`| ${t.turn} | ${t.reason === 'completed' ? '✔' : '✖'} | ${t.steps} | ${t.calls} | ${dur(t.startAt, t.endAt)} | ${t.reason} |`);
  }
  L.push('');
  if (rep.errors.length) {
    L.push('## 失败项');
    L.push('');
    for (const e of rep.errors.slice(0, 80)) L.push(`- [${e.kind}] turn=${e.turn} **${e.reason}**: ${String(e.message).replace(/\s+/g, ' ').slice(0, 300)}`);
    L.push('');
  }
  if (rep.goals.length) {
    L.push('## 目标变更');
    L.push('');
    for (const g of rep.goals) L.push(`- ${fmtTime(g.at)} ${g.operation} round=${g.round} — ${g.objective}`);
    L.push('');
  }

  L.push('## 完整转录');
  L.push('');
  let turn = null;
  for (const e of session.events) {
    if (e.type === 'turn/start') {
      turn = e.data?.turn ?? turn;
      L.push('');
      L.push('---');
      L.push('');
      L.push('### turn ' + turn + '  ' + fmtTime(e.time));
      L.push('');
      continue;
    }
    if (e.type === 'user/message') {
      const text = textOf(e.data?.content);
      if (!text) continue;
      const src = e.data?.source?.kind || e.data?.source || 'user';
      L.push('#### [user/' + (typeof src === 'string' ? src : '?') + '] ' + fmtTime(e.time));
      L.push('');
      L.push(clip(text, chars));
      L.push('');
      continue;
    }
    if (e.type === 'assistant/message') {
      const content = e.data?.message?.content;
      const reasoning = textOf(content, ['reasoning']);
      const text = textOf(content);
      const calls = Array.isArray(content) ? content.filter((b) => b?.type === 'tool-call') : [];
      if (reasoning) {
        L.push('#### [assistant/thinking] step ' + (e.data?.step ?? '?') + ' ' + fmtTime(e.time));
        L.push('');
        L.push(clip(reasoning, chars));
        L.push('');
      }
      if (text) {
        L.push('#### [assistant] step ' + (e.data?.step ?? '?') + ' ' + fmtTime(e.time));
        L.push('');
        L.push(clip(text, chars));
        L.push('');
      }
      for (const c of calls) {
        L.push('#### [tool-call] ' + (c.name || '?') + ' step ' + (e.data?.step ?? '?') + ' ' + fmtTime(e.time));
        L.push('');
        L.push('```json');
        L.push(clip(typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}, null, 2), chars));
        L.push('```');
        L.push('');
      }
      continue;
    }
    if (e.type === 'tool/result') {
      for (const b of e.data?.message?.content || []) {
        if (b?.type !== 'tool-result') continue;
        const inner = Array.isArray(b.content) ? b.content : [];
        const txt = inner.filter((x) => x?.type === 'text').map((x) => x.text).join('\n');
        const isErr = b.isError === true || e.data?.message?.isError === true;
        L.push('#### [tool-result] ' + (isErr ? 'ERROR' : 'ok') + ' step ' + (e.data?.step ?? '?') + ' ' + fmtTime(e.time));
        L.push('');
        L.push(clip(txt, chars));
        L.push('');
      }
      continue;
    }
  }
  return L.join('\n');
}

// ------------------------------------------------------------------ CLI

function parseArgs(argv) {
  const opts = { list: false, recent: 0, out: null, outGiven: false, transcript: false, errorsOnly: false, chars: 600, tail: 60, json: false, target: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--list') opts.list = true;
    else if (a === '--recent') opts.recent = Number(argv[++i]) || 0;
    else if (a === '--out') {
      opts.outGiven = true;
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { opts.out = argv[++i]; } else { opts.out = null; }
    }
    else if (a === '--transcript') opts.transcript = true;
    else if (a === '--errors-only') opts.errorsOnly = true;
    else if (a === '--chars') opts.chars = Number(argv[++i]) || 600;
    else if (a === '--tail') opts.tail = Number(argv[++i]) || 60;
    else if (a === '--json') opts.json = true;
    else if (a.startsWith('--')) throw new Error('未知选项：' + a);
    else opts.target = a;
  }
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  const all = listAllSessions();

  if (opts.list) {
    console.log('共 ' + all.length + ' 个会话（按时间倒序）：');
    for (const s of all.slice(0, 200)) {
      console.log('  ' + s.id + '  ' + new Date(s.mtime).toISOString().replace('T', ' ').slice(0, 19) +
        '  ' + String(Math.round(s.bytes / 1024)).padStart(6) + ' KB  ' + s.workspace);
    }
    if (all.length > 200) console.log('  …还有 ' + (all.length - 200) + ' 个');
    console.log('\n读一个：node scripts/session-read.mjs <id 片段> --out');
    return;
  }

  let targets;
  if (opts.recent > 0) targets = all.slice(0, opts.recent);
  else targets = resolveRef(opts.target ?? 'latest', { all });

  const reports = [];
  const sessions = [];
  for (const t of targets) {
    const session = readSessionLog(t.file);
    sessions.push(session);
    reports.push(summarize(session, { chars: opts.chars, tail: opts.tail }));
  }

  if (opts.json) { console.log(JSON.stringify(reports, null, 2)); return; }

  for (let i = 0; i < reports.length; i += 1) {
    if (i) console.log('\n' + '='.repeat(78));
    console.log(renderSummary(reports[i]));
  }

  // 导出：默认把完整记录 + 原始 jsonl 各写一份。
  if (opts.outGiven || opts.transcript) {
    const id = path.basename(path.dirname(reports[0].file));
    const short = id.replace(/^session-/, '').slice(0, 8);
    if (opts.transcript) {
      for (let i = 0; i < sessions.length; i += 1) {
        console.log('\n' + '#'.repeat(78));
        console.log(renderTranscript(sessions[i], reports[i], { chars: opts.chars }));
      }
    }
    if (opts.outGiven) {
      const outFile = opts.out || path.join(process.cwd(), '.tmp', 'session-' + short + '.md');
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      const parts = [];
      for (let i = 0; i < sessions.length; i += 1) parts.push(renderTranscript(sessions[i], reports[i], { chars: opts.chars }));
      fs.writeFileSync(outFile, parts.join('\n\n---\n\n'), 'utf8');
      console.log('\n[可读记录] ' + outFile + '  (' + fs.statSync(outFile).size + ' B)');

      // 同时落一份「完整未截断」的 jsonl，需要某条原文时查它。
      const rawFile = outFile.replace(/\.md$/, '') + '.jsonl';
      const lines = [];
      for (const s of sessions) for (const e of s.events) lines.push(JSON.stringify(e));
      fs.writeFileSync(rawFile, lines.join('\n'), 'utf8');
      console.log('[原始事件] ' + rawFile + '  (' + fs.statSync(rawFile).size + ' B)');
      console.log('\n下一步：直接读 ' + outFile);
      console.log('或：node scripts/session-read.mjs ' + short + ' --transcript');
    }
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (invokedDirectly) {
  try { main(process.argv.slice(2)); }
  catch (e) { console.error('session-read: ' + (e?.message || e)); process.exitCode = 1; }
}
