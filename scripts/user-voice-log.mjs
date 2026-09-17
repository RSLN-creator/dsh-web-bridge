#!/usr/bin/env node
// user-voice-log.mjs — 把**用户本人**说过的话从 DSH 会话日志里抽出来，落成一份可检索的意图底稿。
//
// ## 为什么需要这个文件
//
// 本项目最贵的一类返工不是代码写错，而是**意图被转述走样**：lead 把用户的诉求写的任务书
// 措辞与用户原话有出入，下一轮的人照着转述做，做完才发现做偏了。`doc/PROJECT-INTENT.md`
// 与 `doc/REQUIREMENTS-TASKBOARD.md` 都已经在用「用户原话 + 文件:行号」的写法抗这件事，
// 但它们的原料是**人手工从会话里捞的**——捞漏了没人知道。
//
// 这个脚本把「捞」这一步变成可重跑的：直接读 DSH 的会话落盘（`session.v3.jsonl.zstd`），
// 只取 `user/message` 里 **source.kind === 'user'** 的那些（外加 `goal` 轮次里被逐字引用的
// 目标原话），按时间顺序落成 `doc/user-voice-log.md` + 同名 `.json`。**之后每轮重跑一次即可**
// ——新会话自动被带上，不需要任何人补记。
//
// 2026-09-18 扩展：**Codex 侧的会话也一起抽**。用户在这两个客户端里说的话都是「他的原话」，
// 而 9/18 的意图澄清（优先级顺序、三列对比、长跑判据）恰好只落在 Codex 侧——只读 DSH 会漏掉
// 最新、最关键的限定语。Codex 会话是 `~/.codex/sessions/<年>/<月>/<日>/rollout-*.jsonl`：
//   · 他直接敲的字在 `response_item` / `role === 'user'` 的正文里，形式是 `## My request:` 之后那段；
//   · 他对着上一轮回答划词写的批注，在 `<response-annotations>` 的 JSON 数组里，字段名 `annotation`；
//   · `# AGENTS.md instructions` / `<environment_context>` / `<codex_internal_context>` 开头的整条
//     是系统注入（其中 goal 模板里的 `<objective>` 已由 DSH 侧那 24 条覆盖），一律不取。
// 来源记进 `origin`：`codex-user`（他敲的）与 `codex-annotation`（他划词批注的）。
//
// ## 什么算「用户的话」（口径写死在这里，改口径先改这里）
//
// 取：
//   · `source.kind === 'user'` 且**没有** plugin/form —— 用户在输入框里敲的字，以及他在
//     审批界面点「继续/重试」时系统代填的那句（两者都是他的意志，后者文本以「提交工具结果」等开头）；
//   · `source.kind === 'goal'` —— goal 轮次的消息体是 `Objective: "<用户原话>"` 的模板，
//     本脚本**只抽引号里那一段**，并标注这是从 goal 模板里解出来的（不是他直接敲的）。
//
// 不取（这些都是系统/插件/AI 产生的，混进来会让「他的意图」失真）：
//   · `source.plugin`（system-prompt 快照、plan-mode 通知、compact 检查点、model-selection 提示…）
//   · `source.kind` 为 `team-message` / `agent-message` / `subagent-settled` / `skill-catalog` /
//     `skill-invocation` / `agent-instructions` / `loopx-continuation` / `session-reference` 等
//   · assistant 的一切输出（含 thinking）
//   · **子代理会话的派发提示**：子代理会话的目录名是裸 uuid（`<uuid>/` 而不是
//     `session-<uuid>/`），且 `delegationDepth > 0`；里面那条 `You are working in an
//     existing Windows repo…` 是**别的 AI 写给子代理的任务书**，不是他敲的字。
//     这类会话整条排除（判据：目录名无 `session-` 前缀 **或** `delegationDepth > 0`）。
//
// ## 去重口径（同一个意思只留一条，但不丢「他说过几次」）
//
// DSH 会把同一句话在**同一次会话**里重放（上下文压缩后的重放、审批后重发），因此：
//   1. 先按 `(会话 id, 事件 seq)` 去掉同会话内的重放；
//   2. 再按**归一化后的正文**分组：同一条正文只保留**最早**的那次作为主条目，
//      后来的出现记成 `also` 引用（只显示会话短 id 与时间），并给出总数。
// 后果是「继续」这种高频短语会合并成一条 —— 这是刻意的：它证明他在推进，不构成新意图。
//
// ## 用法
//
//   node scripts/user-voice-log.mjs                 # 重写 doc/user-voice-log.md + .json
//   node scripts/user-voice-log.mjs --stats         # 只打统计，不写文件
//   node scripts/user-voice-log.mjs --all-workspaces # 连别的项目工作区一起抽（默认只抽本仓库）
//   node scripts/user-voice-log.mjs --workspace 比赛 --workspace dsh-webcode  # 只要这些工作区（子串，可重复）
//   node scripts/user-voice-log.mjs --journal doc/user-voice-journal.md   # 换输出路径
//
// 退出码：0 正常；1 脚本自身出错。
//
// ## 已知边界（宁可漏报也不伪造）
//
//   · 会话被 compact 压缩掉的早期原文**不在**日志里 —— 那些字是真的没有落盘，脚本不会替它猜。
//   · 子代理会话（目录名是裸 uuid）里若也有用户输入，同样会被抽到并标注它的会话 id。
//   · 时间统一按本机时区（Asia/Shanghai）渲染，同时保留 epoch 毫秒供机器比对。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { listAllSessions, readSessionLog } from './session-read.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

/** 默认只抽本仓库的会话；`--all-workspaces` 可放开。 */
const DEFAULT_WORKSPACE = /dsh-webcode-bridge/;
const DEFAULT_OUT = path.join(repoRoot, 'doc', 'user-voice-log.md');

/** goal 模板里那句被逐字引用的目标：`Objective: "…"\nRound: n/m`。 */
const GOAL_OBJECTIVE_RE = /Objective:\s*"([\s\S]*?)"\s*\n\s*Round:/;

/**
 * 把一段正文归一化，用作跨会话去重的键。
 *
 * 只做「不改变语义」的整理：统一换行、去掉每行尾部空白、把连续空行压成一个、去首尾空白。
 * **不改标点、不改错别字、不合并不同措辞** —— 他要看到的是自己写的字。
 */
function normalize(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sha1(s) {
  return crypto.createHash('sha1').update(s, 'utf8').digest('hex');
}

/** 会话目录名 → 可读 cwd（裸 uuid 目录没有转义过的 cwd，只能回落成目录名本身）。 */
function workspaceFromDirName(dirName) {
  const m = /^--(.+)--$/.exec(dirName);
  const body = m ? m[1] : dirName;
  const decoded = body.replace(/~([0-9A-F]{4})~/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return decoded.replace(/-/g, '\\');
}

/**
 * 抽取原始条目（未去重）。
 *
 * @param {{workspaces?: RegExp[]|null, includeGoal?: boolean}} opts
 * @returns {{entries: Array, sessions: number, skipped: number, subagentSessions: number}}
 */
export function collectVoice({ workspaces = [DEFAULT_WORKSPACE], includeGoal = true } = {}) {
  const entries = [];
  let sessions = 0;
  let skipped = 0;
  let subagentSessions = 0;
  for (const s of listAllSessions()) {
    if (workspaces && workspaces.length && !workspaces.some((re) => re.test(s.workspace))) { skipped += 1; continue; }
    let log;
    try { log = readSessionLog(s.file); } catch { skipped += 1; continue; }
    const meta = log.events.find((e) => e?.type === 'session');
    // 子代理会话整条排除（判据见文件头）：裸 uuid 目录 + delegationDepth > 0。
    // 先读 meta 再决定要不要计入 sessions，否则统计里会把它们算成「他的会话」。
    if (!/^session-/.test(s.id) || (meta?.delegationDepth ?? 0) > 0) { subagentSessions += 1; continue; }
    sessions += 1;
    const cwd = meta?.cwd || workspaceFromDirName(s.workspace);
    for (const e of log.events) {
      if (e?.type !== 'user/message') continue;
      const src = e.data?.source ?? {};
      // 插件/表单产生的「用户消息」不是他敲的字，一律不取（口径见文件头）。
      if (src.plugin || src.form) continue;
      const isUser = src.kind === 'user';
      const isGoal = src.kind === 'goal';
      if (!isUser && !(includeGoal && isGoal)) continue;
      const joined = (e.data?.content || []).map((b) => (b?.type === 'text' ? b.text : '')).join('\n');
      let text = joined;
      if (isGoal) {
        const m = GOAL_OBJECTIVE_RE.exec(joined);
        if (!m) continue;
        text = m[1];
      }
      const body = normalize(text);
      if (!body) continue;
      entries.push({
        sessionId: s.id,
        workspace: cwd,
        at: typeof e.time === 'number' ? e.time : meta?.createdAt ?? null,
        seq: e.seq ?? null,
        origin: isGoal ? 'goal' : 'user',
        goalId: src.goalId || null,
        round: typeof src.round === 'number' ? src.round : null,
        text: body,
      });
    }
  }
  return { entries, sessions, skipped, subagentSessions };
}

/**
 * 去重并合并「同一句话说过几次」。
 *
 * 两段去重：同会话内按 (sessionId, seq) 去重放；跨会话按正文哈希合并。
 * 合并时保留**最早**一次作主条目，其余进 `also`。
 */
/** Codex 会话根目录（~/.codex/sessions/<年>/<月>/<日>/rollout-*.jsonl）。 */
function codexSessionsRoot() {
  return path.join(os.homedir(), '.codex', 'sessions');
}

/** 递归列出 rollout 会话文件；读不动的目录直接跳过，不让它把整轮抽词带崩。 */
function listCodexRollouts(root = codexSessionsRoot()) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const full = path.join(dir, it.name);
      if (it.isDirectory()) walk(full, depth + 1);
      else if (it.isFile() && /^rollout-.*\.jsonl$/.test(it.name)) out.push(full);
    }
  };
  walk(root, 0);
  return out;
}

/**
 * 从 Codex 会话里抽「他敲的字」与「他划词写的批注」。
 *
 * 为什么两处都要抽：9/18 的意图澄清基本只出现在 Codex 侧——他既在输入框里给优先级顺序，
 * 也在上一轮回答上划词批注（「？？？什么意思」这类追问只在批注里）。只取其中一处都会漏。
 *
 * 判据（宁可漏报也不伪造）：
 *   · 只取 `response_item` / `role === 'user'`——developer 与 assistant 的一切都不取；
 *   · 正文以 `# AGENTS.md instructions` / `<environment_context` / `<codex_internal_context`
 *     开头的是系统注入，整条丢弃；
 *   · 没有 `## My request:` 也没有 `<response-annotations>` 的条目（工具结果回填、goal 继续模板）
 *     一律丢弃——那些不是他这一轮说的话。
 */
export function collectCodexVoice({ workspaces = [DEFAULT_WORKSPACE], roots = [codexSessionsRoot()] } = {}) {
  const entries = [];
  let sessions = 0;
  let skipped = 0;
  for (const root of roots) {
    for (const file of listCodexRollouts(root)) {
      let raw;
      try { raw = fs.readFileSync(file, 'utf8'); } catch { skipped += 1; continue; }
      const lines = raw.split('\n').filter(Boolean);
      let head = null;
      try { head = JSON.parse(lines[0]); } catch { /* 首行坏了也继续，逐行还有机会 */ }
      const cwd = head?.payload?.cwd || '';
      if (workspaces && workspaces.length && !workspaces.some((re) => re.test(cwd))) { skipped += 1; continue; }
      const sessionId = 'codex-' + String(head?.payload?.session_id || path.basename(file)).slice(0, 8);
      let used = false;
      for (const line of lines) {
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        if (rec.type !== 'response_item') continue;
        const pl = rec.payload || {};
        if (pl.type !== 'message' || pl.role !== 'user') continue;
        const text = (pl.content || []).map((b) => (b && b.text) || '').join('\n');
        if (!text) continue;
        if (/^\s*(# AGENTS\.md instructions|<environment_context|<codex_internal_context)/.test(text)) continue;
        const at = Date.parse(rec.timestamp || head?.payload?.timestamp || '') || null;
        const seq = rec.ordinal ?? null;
        let hit = false;
        const annMatch = /<response-annotations>\s*([\s\S]*?)\s*<\/response-annotations>/.exec(text);
        if (annMatch) {
          let list = null;
          try { list = JSON.parse(annMatch[1]); } catch { list = null; }
          if (Array.isArray(list)) {
            list.forEach((item, i) => {
              const body = normalize(item?.annotation || '');
              if (!body) return;
              hit = true;
              entries.push({
                sessionId, workspace: cwd, at, seq: seq === null ? null : String(seq) + '.' + (i + 1),
                origin: 'codex-annotation', goalId: null, round: null, text: body,
              });
            });
          }
        }
        const reqIdx = text.indexOf('## My request:');
        const ask = normalize(reqIdx >= 0 ? text.slice(reqIdx + '## My request:'.length) : '');
        if (ask) {
          hit = true;
          entries.push({
            sessionId, workspace: cwd, at, seq, origin: 'codex-user', goalId: null, round: null, text: ask,
          });
        }
        if (hit) used = true;
      }
      if (used) sessions += 1;
    }
  }
  return { entries, sessions, skipped };
}

export function mergeVoice(entries) {
  const seenSeq = new Set();
  const byText = new Map();
  for (const e of entries) {
    const seqKey = e.sessionId + '#' + String(e.seq);
    if (seenSeq.has(seqKey)) continue;
    seenSeq.add(seqKey);
    const key = sha1(e.text);
    const prev = byText.get(key);
    if (!prev) { byText.set(key, { ...e, hash: key.slice(0, 8), also: [] }); continue; }
    const isEarlier = (e.at ?? 0) < (prev.at ?? 0);
    const later = isEarlier ? prev : e;
    const keep = isEarlier ? e : prev;
    prev.at = keep.at;
    prev.sessionId = keep.sessionId;
    prev.seq = keep.seq;
    prev.origin = keep.origin;
    prev.also.push({ sessionId: later.sessionId, at: later.at, origin: later.origin });
  }
  return [...byText.values()].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}

const pad = (n) => String(n).padStart(2, '0');

/** epoch 毫秒 → 本机时区的 `YYYY-MM-DD HH:mm`。 */
function fmt(at) {
  if (typeof at !== 'number') return '时间未知';
  const d = new Date(at);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/** ISO 周次（用于分节），形如 `2026-W38`。 */
function isoWeek(at) {
  const d = new Date(at);
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return t.getUTCFullYear() + '-W' + pad(week);
}

/** 渲染成 Markdown。`goal` 来源的条目加一行出处说明，不与他直接敲的话混为一谈。 */
export function renderVoice(rows, { scopeLabel = '（未指定）', command = 'node scripts/user-voice-log.mjs' } = {}) {
  const L = [];
  L.push('# 用户原话记录（自动汇总）');
  L.push('');
  L.push('**这份文件是脚本生成的，不要手改。**');
  L.push('生成命令：`' + command + '`');
  L.push('数据源一：`.dsh` 会话落盘里 `user/message` 且 `source.kind` 为 `user` / `goal` 的事件。');
  L.push('数据源二：`~/.codex/sessions/<年>/<月>/<日>/rollout-*.jsonl` 里他敲的字（`## My request:` 之后那段）与划词批注（`<response-annotations>` 的 `annotation` 字段）。');
  L.push('');
  L.push('## 怎么用这份文件');
  L.push('');
  L.push('- 判断「这算不算本项目的意图」时，**先在正文里搜原话**，而不是靠会话记忆或别人的转述；');
  L.push('- 条目按时间升序；`同句另见 N 处` 是他把同一句话说过几次（最早那次就是本条的位置）；');
  L.push('- 标注 `（goal 模板里的逐字引用）` 的条目取自 goal 轮次模板，引号内是原话，**不是他直接在输入框敲的**；');
  L.push('- 标注 `来源 Codex 输入框` / `来源 Codex 划词批注` 的条目来自 Codex 客户端——前者是他敲的，后者是对上一轮回答划词写的批注（正文即批注原文）；');
  L.push('- 这份记录只增不改：重跑脚本会把新会话带上，旧条目按同一去重口径稳定重现。');
  L.push('');
  L.push('## 覆盖范围');
  L.push('');
  L.push('| 项 | 值 |');
  L.push('| --- | --- |');
  L.push('| 工作区过滤 | ' + scopeLabel + ' |');
  L.push('| 条目数 | ' + rows.length + '（去重合并后） |');
  L.push('| 时间跨度 | ' + (rows.length ? fmt(rows[0].at) + ' → ' + fmt(rows[rows.length - 1].at) : '—') + ' |');
  L.push('');
  if (!rows.length) {
    L.push('（没有抽到任何条目——先确认这个工作区里有会话落盘。）');
    return L.join('\n') + '\n';
  }
  let curWeek = null;
  for (const [i, r] of rows.entries()) {
    const week = isoWeek(r.at);
    if (week !== curWeek) {
      curWeek = week;
      L.push('---');
      L.push('');
      L.push('## 周次 ' + week);
      L.push('');
    }
    const no = String(i + 1).padStart(3, '0');
    L.push('### ' + no + ' · ' + fmt(r.at));
    L.push('');
    const short = r.sessionId.replace(/^session-/, '').slice(0, 8);
    const meta = ['会话 `' + short + '`', 'seq `' + r.seq + '`'];
    if (r.origin === 'goal') meta.push('来源 goal 模板（round ' + r.round + '）');
    if (r.origin === 'codex-user') meta.push('来源 Codex 输入框');
    if (r.origin === 'codex-annotation') meta.push('来源 Codex 划词批注');
    L.push('`' + meta.join('` · `') + '`');
    L.push('');
    for (const line of r.text.split('\n')) L.push(line);
    L.push('');
    if (r.origin === 'goal') L.push('> （goal 模板里的逐字引用，不是直接在输入框敲的）');
    if (r.origin === 'codex-annotation') L.push('> （他对着上一轮回答划词写的批注，正文即批注原文）');
    if (r.also.length) {
      const refs = r.also.slice(0, 8).map((a) => '`' + a.sessionId.replace(/^session-/, '').slice(0, 8) + '`@' + fmt(a.at)).join('、');
      const more = r.also.length > 8 ? ' 等' : '';
      L.push('> 同句另见 ' + r.also.length + ' 处：' + refs + more);
    }
    L.push('');
  }
  return L.join('\n');
}

function parseArgs(argv) {
  const opts = { stats: false, allWorkspaces: false, journal: DEFAULT_OUT, workspaces: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--stats') opts.stats = true;
    else if (a === '--all-workspaces') opts.allWorkspaces = true;
    else if (a === '--workspace') { i += 1; opts.workspaces.push(String(argv[i] || '')); }
    else if (a === '--journal') { i += 1; opts.journal = path.resolve(argv[i] || DEFAULT_OUT); }
    else if (a === '--help' || a === '-h') { opts.help = true; }
    else throw new Error('未知参数：' + a + '（用 --help 看用法）');
  }
  return opts;
}

/**
 * 工作区子串 → 匹配用的正则。
 *
 * 用**子串**而不是完整路径：会话目录名里的 cwd 是转义过的（盘符与反斜杠都被压成 `-`），
 * 让人去拼转义后的字符串不现实——他看到的是 `D:\9_Code_Workspace\dsh-webcode-bridge`。
 * 因此按他给的中文/英文片段去 match；正则元字符先转义，避免一个 `(` 把匹配打崩。
 */
export function workspaceMatchers(list) {
  return list.filter(Boolean).map((s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log('用法：node scripts/user-voice-log.mjs [--stats] [--all-workspaces] [--workspace <子串>]... [--journal <文件>]');
    return 0;
  }
  // 工作区范围：`--all-workspaces` > 显式 `--workspace` 列表 > 默认（本仓库）。
  // 显式列表与默认互斥，避免「既给了片段又悄悄把默认那条也抽进来」这种说不清的读数。
  const workspaces = opts.allWorkspaces
    ? null
    : (opts.workspaces.length ? workspaceMatchers(opts.workspaces) : [DEFAULT_WORKSPACE]);
  const scopeLabel = opts.allWorkspaces
    ? '全部工作区'
    : (opts.workspaces.length ? opts.workspaces.map((w) => '`' + w + '`').join('、') : '`dsh-webcode-bridge`');
  const command = ['node scripts/user-voice-log.mjs', opts.allWorkspaces ? '--all-workspaces' : '',
    ...opts.workspaces.map((w) => '--workspace ' + w)].filter(Boolean).join(' ');

  const dsh = collectVoice({ workspaces });
  const codex = collectCodexVoice({ workspaces });
  const entries = dsh.entries.concat(codex.entries);
  const rows = mergeVoice(entries);
  const sessions = dsh.sessions;
  const skipped = dsh.skipped;
  const subagentSessions = dsh.subagentSessions;
  const chars = rows.reduce((n, r) => n + r.text.length, 0);
  const goals = rows.filter((r) => r.origin === 'goal').length;
  const merged = rows.filter((r) => r.also.length).length;

  console.log('[user-voice-log] 范围：' + scopeLabel);
  console.log('  会话 ' + sessions + ' 个（跳过 ' + skipped + ' 个不匹配/读不动；另排除子代理会话 ' + subagentSessions + ' 个）');
  console.log('  Codex 会话 ' + codex.sessions + ' 个（另有 ' + codex.entries.length + ' 条原话/批注；跳过 ' + codex.skipped + ' 个不匹配）');
  console.log('  原始条目 ' + entries.length + ' → 去重合并后 ' + rows.length + ' 条（' + chars + ' 字符）');
  console.log('  其中 goal 模板引用 ' + goals + ' 条；合并了重复句 ' + merged + ' 条');
  if (rows.length) console.log('  时间跨度 ' + fmt(rows[0].at) + ' → ' + fmt(rows[rows.length - 1].at));
  if (opts.stats) return 0;

  const md = renderVoice(rows, { scopeLabel, command });
  fs.mkdirSync(path.dirname(opts.journal), { recursive: true });
  fs.writeFileSync(opts.journal, md, 'utf8');
  const jsonPath = opts.journal.replace(/\.md$/, '') + '.json';
  fs.writeFileSync(jsonPath, JSON.stringify({ generatedAt: Date.now(), scope: scopeLabel, command, rows }, null, 2) + '\n', 'utf8');
  console.log('  写出 ' + path.relative(repoRoot, opts.journal) + '（' + Buffer.byteLength(md, 'utf8') + ' B）');
  console.log('  写出 ' + path.relative(repoRoot, jsonPath) + '（机读副本，供后续增量核对）');
  return 0;
}
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (e) { console.error('[user-voice-log] ' + (e?.message || e)); process.exitCode = 1; }
}
