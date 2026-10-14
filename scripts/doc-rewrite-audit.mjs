#!/usr/bin/env node
// doc-rewrite-audit.mjs — 大文档「结构性重写」的零丢失核对。
//
// 为什么需要它（真实缺口）：
//
// `doc/progress.md`（7300+ 行）与 `doc/long-term-issues.md`（3600+ 行）是**一手记录**，
// 里面逐字写着真机读数、命令、退出码、被证伪的候选修法。做结构性重写（拆节、换表、
// 重排）时，最贵的失败不是「写得难看」，而是**静默删掉一段取证**——而这类删除
// 没有任何闸门在看：`check-long-term-issues.mjs` 只判「一览表 ↔ 正文自洽」，
// `check-ledger.mjs` 只判版本号与测试文件数，两轮之间**没有一行**在比对新旧文本。
//
// 所以这里把「重写前后内容等价」做成可跑的命令，**改前先 snapshot、改后 check**：
//
//   node scripts/doc-rewrite-audit.mjs snapshot doc/progress.md
//   # …重写…
//   node scripts/doc-rewrite-audit.mjs check doc/progress.md      # 缺一项即退 1
//
// 判据（每条都对应一种真实的丢法）：
//   H 标题：重写前的每个 `#`~`######` 标题文本（规范化空白后）必须仍然存在
//          ⇒ 防「整节被顺手删掉」。
//   F 围栏：`lib/xxx.js:123` 这类**带行号的出处**必须逐字仍在
//          ⇒ 防「换行重排把行号引用冲掉」。**这是本仓库最贵的一类引用**。
//   C 代码：反引号包裹的短片段（含错误码、选择器、字段名）多重集计数不得减少
//          ⇒ 防「把逐字证据改写成转述」。转述会丢前提，本仓库记过多次。
//   K 中文二元组：CJK 二字组多重集，任何一个二元组的缺失量不得超过阈值（默认 0）
//          ⇒ 防「大段散文被压缩掉」。这是唯一能覆盖普通叙述的判据。
//   N 数字读数：正文里所有独立数字（含 `44,202` / `0/84` / `126` 这类真机读数）
//          的多重集计数不得减少 ⇒ 防「读数被抹平成『已修复』」。
//
// 退出码：0 = 全绿；1 = 有缺失（逐条列出是哪一类、缺了什么、原在哪一行）；2 = 用法/IO 错误。
//
// ⚠ 本工具**只判「少了什么」，不判「写得对不对」**。全绿不等于重写没问题，
//   只等于「没有内容因重写而消失」。这句话照 `check-ledger.mjs` 的先例写在输出里。

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const SNAP_DIR = path.join(repoRoot, '.tmp', 'doc-audit');

/** 默认阈值：某一个中文二元组允许的缺失次数。0 = 一个字都不许少。 */
const DEFAULT_CJK_TOLERANCE = 0;

/** 正文里所有独立数字（含千分位）。`0/84` 会拆成 `0` 与 `84`，两边都进计数。 */
const NUMBER_RE = /\d[\d,]*(?:\.\d+)?/g;

/** 反引号包裹的片段（单行内），去掉反引号本身。 */
const CODE_RE = /`([^`\n]+)`/g;

/** `文件.js:123` / `文件.js:123-130` / `doc/x.md:12` 形状的带行号出处。 */
const FILELINE_RE = /\b[A-Za-z0-9_./\\-]+\.(?:js|cjs|mjs|md|json|yml|yaml|ps1|txt|ts):\d+(?:-\d+)?/g;

/** 中文（含 CJK 标点外的汉字）二元组。刻意只取汉字，不取标点。 */
const HAN_RE = /[\u4e00-\u9fff]/;

/**
 * 把文本切成「规范化后的多重集」。
 *
 * 规范化口径：连续空白折成单个空格、去首尾空白。**不做**大小写折叠——
 * 本仓库的大小写是有意义的（`WEB_NO_PROGRESS` 这类错误码、`sendTurn` 这类符号）。
 *
 * @param {string} text
 * @returns {{headings:Map<string,number>, filelines:Map<string,number>, codes:Map<string,number>, numbers:Map<string,number>, cjk:Map<string,number>, lines:number, chars:number}}
 */
export function fingerprint(text) {
  const lines = text.split(/\r?\n/);
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const bump = (map, key) => { if (key) map.set(key, (map.get(key) || 0) + 1); };

  const headings = new Map();
  const filelines = new Map();
  const codes = new Map();
  const numbers = new Map();
  const cjk = new Map();

  for (const line of lines) {
    const h = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (h) bump(headings, norm(h[2]));
  }

  const whole = text;
  for (const m of whole.matchAll(FILELINE_RE)) bump(filelines, m[0]);
  for (const m of whole.matchAll(CODE_RE)) {
    const v = norm(m[1]);
    // 只收「短片段」：长反引号块更像代码粘贴，会随重排整体挪动，噪声大。
    if (v && v.length <= 120 && !v.includes('\n')) bump(codes, v);
  }
  for (const m of whole.matchAll(NUMBER_RE)) bump(numbers, m[0].replace(/,/g, ''));

  // 中文二元组：按行切，避免跨行造出「本不存在的词组」。
  for (const line of lines) {
    const chars = [...line];
    for (let i = 0; i + 1 < chars.length; i += 1) {
      if (HAN_RE.test(chars[i]) && HAN_RE.test(chars[i + 1])) bump(cjk, chars[i] + chars[i + 1]);
    }
  }

  return { headings, filelines, codes, numbers, cjk, lines: lines.length, chars: text.length };
}

/** 多重集快照 → 可 JSON 序列化的对象。 */
function toJSON(fp) {
  const dump = (m) => Object.fromEntries([...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  return {
    lines: fp.lines, chars: fp.chars,
    headings: dump(fp.headings), filelines: dump(fp.filelines),
    codes: dump(fp.codes), numbers: dump(fp.numbers), cjk: dump(fp.cjk),
  };
}

function fromJSON(o) {
  const load = (d) => new Map(Object.entries(d || {}));
  return {
    lines: o.lines, chars: o.chars,
    headings: load(o.headings), filelines: load(o.filelines),
    codes: load(o.codes), numbers: load(o.numbers), cjk: load(o.cjk),
  };
}

function snapshotPathFor(absFile) {
  const rel = path.relative(repoRoot, absFile).replace(/[\\/]/g, '__').replace(/\./g, '_');
  return path.join(SNAP_DIR, rel + '.json');
}

/**
 * 比对两枚指纹，返回「少了什么」。
 *
 * `allow` 是**有意退休**的清单：结构性重写有时会**故意**改掉一些字面量
 * （例如把指向被 gitignore 路径的引用换成入库路径）。这类「少」是决定，不是事故。
 * 但「有意」必须**留痕**——所以清单从 `scripts/doc-rewrite-audit.allow.json` 读，
 * 每条都要写理由。没有理由的放行等于把闸门关掉。
 *
 * @param {ReturnType<typeof fromJSON>} before
 * @param {ReturnType<typeof fromJSON>} after
 * @param {{cjkTolerance?:number, allow?:{keys?:string[], cjk?:string[], reasons?:Record<string,string>}}} [opts]
 * @returns {{problems:Array<{kind:string,key:string,missing:number}>, allowed:Array<object>, stats:object}}
 */
export function diffFingerprints(before, after, { cjkTolerance = DEFAULT_CJK_TOLERANCE, allow = {} } = {}) {
  const allowExact = new Set(allow.keys || []);
  const allowCjk = new Set(allow.cjk || []);
  // 「被改写的旧文本块」折算成减免额度：只减该块自身贡献的 token（按块放行，不误伤别处）
  const budget = retiredBudget(allow.retiredBlocks || []);
  const problems = [];
  const allowed = [];
  const compare = (kind, b, a, credit) => {
    for (const [key, n] of b) {
      const now = a.get(key) || 0;
      if (now >= n) continue;
      let miss = n - now;
      const cr = credit ? (credit.get(key) || 0) : 0;
      if (cr) miss = Math.max(0, miss - cr);
      if (miss === 0) continue;
      const rec = { kind, key, missing: miss };
      if (allowExact.has(key)) { allowed.push(rec); continue; }
      problems.push(rec);
    }
  };
  compare('标题', before.headings, after.headings, null);
  compare('带行号出处', before.filelines, after.filelines, null);
  compare('反引号片段', before.codes, after.codes, null);
  compare('数字读数', before.numbers, after.numbers, budget.numbers);

  // 中文二元组按阈值判：允许容忍度内的抖动，默认 0。
  let cjkMissingTokens = 0;
  let cjkMissingTotal = 0;
  for (const [key, n] of before.cjk) {
    const now = after.cjk.get(key) || 0;
    let missing = n - now;
    if (missing <= cjkTolerance) continue;
    const cr = budget.cjk.get(key) || 0;
    if (cr) missing = Math.max(0, missing - cr);
    if (missing === 0) continue;
    if (allowCjk.has(key)) { allowed.push({ kind: '中文二元组', key, missing }); continue; }
    cjkMissingTokens += 1;
    cjkMissingTotal += missing;
    problems.push({ kind: '中文二元组', key, missing });
  }

  return {
    problems,
    allowed,
    stats: {
      beforeLines: before.lines, afterLines: after.lines,
      beforeChars: before.chars, afterChars: after.chars,
      cjkMissingTokens, cjkMissingTotal,
      allowedCount: allowed.length,
      beforeCjkTokens: before.cjk.size, afterCjkTokens: after.cjk.size,
    },
  };
}

/**
 * 读「有意退休」清单。缺失或为空都当空清单（不报错）——
 * 它不是必需文件，只是把「有意的删除」留痕的地方。
 *
 * 支持三种粒度（从粗到细，优先用细的）：
 *   `keys`            —— 逐字面量放行（用于「这条命令的路径改了」这类）。
 *   `cjk`             —— 逐中文二元组放行。⚠ **危险**：像「格式」「配合」这种常见词一旦放行，
 *                        以后真丢它们也不会报。只在确实无法更细时用。
 *   `retiredHeadings` —— **推荐**：给出**被改写的旧标题原文**，脚本会算出「这个标题自身贡献的
 *                        token」，只把那些减掉。这样放行是**按块**的，不会误伤别处的同一个词。
 *                        2026-10-14 加：`#30` 关闭时标题按事实改写，逐 token 放行出现了
 *                        「补 20 个再冒出 11 个」的打地鼠，且被迫放行常见词——那是判据设计错了。
 */
function loadAllowlist() {
  const p = path.join(repoRoot, 'scripts', 'doc-rewrite-audit.allow.json');
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      keys: Array.isArray(j.keys) ? j.keys : [],
      cjk: Array.isArray(j.cjk) ? j.cjk : [],
      // 兼容两个名字：retiredBlocks 是正式名，retiredHeadings 是 2026-10-14 的初版名
      retiredBlocks: [
        ...(Array.isArray(j.retiredBlocks) ? j.retiredBlocks : []),
        ...(Array.isArray(j.retiredHeadings) ? j.retiredHeadings : []),
      ],
      reasons: j.reasons || {},
    };
  } catch { return { keys: [], cjk: [], retiredBlocks: [], reasons: {} }; }
}

/**
 * 把「被改写的旧文本块」折算成 token 减免额度。
 *
 * 典型用法：某条长期问题**关闭**时，它的 `## N.` 标题与一览表行都要按事实改写
 * （旧标题写着「未录制 / 9 个 kind 都读不了」，而事实已变）。这类改是**有意**的，
 * 但逐 token 放行会出现打地鼠（补 20 个再冒 11 个），且被迫放行「格式」「配合」
 * 这类常见词——那会让闸门以后对它们彻底失效。
 *
 * 所以按**块**放行：给出旧文本（标题原文、或整行表行），只减免**该块自身**贡献的
 * 中文二元组与数字读数。放行的额度以该块的内容为上限，不牵连别处同样的词。
 *
 * @param {Array<string>} blocks 旧文本块原文（可含多行）
 * @returns {{cjk:Map<string,number>, numbers:Map<string,number>}}
 */
function retiredBudget(blocks) {
  const cjk = new Map(); const numbers = new Map();
  for (const b of blocks) {
    const fp = fingerprint(b);
    for (const [k, n] of fp.cjk) cjk.set(k, (cjk.get(k) || 0) + n);
    for (const [k, n] of fp.numbers) numbers.set(k, (numbers.get(k) || 0) + n);
  }
  return { cjk, numbers };
}

// ------------------------------------------------------------------ CLI

function parseArgs(argv) {
  const out = { mode: null, file: null, cjkTolerance: DEFAULT_CJK_TOLERANCE, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === 'snapshot' || a === 'check') out.mode = a;
    else if (a === '--cjk-tolerance') { i += 1; out.cjkTolerance = Number(argv[i]); }
    else if (a === '--json') out.json = true;
    else if (!a.startsWith('--')) out.file = a;
  }
  return out;
}

function main(argv) {
  const opts = parseArgs(argv);
  if (!opts.mode || !opts.file) {
    console.error('用法：node scripts/doc-rewrite-audit.mjs snapshot <文件>');
    console.error('      node scripts/doc-rewrite-audit.mjs check <文件> [--cjk-tolerance N] [--json]');
    return 2;
  }
  const abs = path.resolve(repoRoot, opts.file);
  if (!fs.existsSync(abs)) { console.error('[doc-audit] 找不到文件：' + abs); return 2; }
  const text = fs.readFileSync(abs, 'utf8');
  const snapPath = snapshotPathFor(abs);

  if (opts.mode === 'snapshot') {
    fs.mkdirSync(SNAP_DIR, { recursive: true });
    const payload = {
      file: path.relative(repoRoot, abs).replace(/[\\/]/g, '/'),
      at: new Date().toISOString(),
      sha256: sha256(text),
      fingerprint: toJSON(fingerprint(text)),
    };
    fs.writeFileSync(snapPath, JSON.stringify(payload, null, 2));
    console.log(`[doc-audit] ✔ 已留档 ${payload.file}`);
    console.log(`  指纹：${payload.fingerprint.lines} 行 / ${payload.fingerprint.chars} 字符 / ` +
      `${Object.keys(payload.fingerprint.headings).length} 个标题 / ` +
      `${Object.keys(payload.fingerprint.cjk).length} 个中文二元组`);
    console.log(`  落盘：${path.relative(repoRoot, snapPath)}`);
    return 0;
  }

  if (!fs.existsSync(snapPath)) {
    console.error('[doc-audit] 没有改前留档，无法核对：' + path.relative(repoRoot, snapPath));
    console.error('  先在改之前跑：node scripts/doc-rewrite-audit.mjs snapshot ' + opts.file);
    return 2;
  }
  const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
  const before = fromJSON(snap.fingerprint);
  const after = fingerprint(text);
  const allow = loadAllowlist();
  const { problems, allowed, stats } = diffFingerprints(before, after, { cjkTolerance: opts.cjkTolerance, allow });

  if (opts.json) {
    console.log(JSON.stringify({ file: opts.file, beforeSha256: snap.sha256, stats, allowed, problems }, null, 2));
    return problems.length ? 1 : 0;
  }

  console.log(`[doc-audit] 文档：${opts.file}`);
  console.log(`  改前 ${snap.at}`);
  console.log(`  行数 ${stats.beforeLines} → ${stats.afterLines}；字符 ${stats.beforeChars} → ${stats.afterChars}`);
  console.log(`  中文二元组 缺 ${stats.cjkMissingTokens} 种 / ${stats.cjkMissingTotal} 次` +
    `（阈值 ${opts.cjkTolerance}）`);
  if (stats.allowedCount) {
    console.log(`  有意退休（清单内放行）${stats.allowedCount} 项：` +
      [...new Set(allowed.map((a) => a.key))].slice(0, 6).map((k) => `「${k}」`).join('、') +
      (new Set(allowed.map((a) => a.key)).size > 6 ? ' 等' : ''));
  }
  if (!problems.length) {
    console.log('[doc-audit] ✔ 没有内容因重写而消失（标题 / 带行号出处 / 反引号片段 / 数字读数 / 中文二元组 五项全过）');
    console.log('[doc-audit] 注意：本工具只判「少了什么」，不判「写得对不对」。全绿不等于重写没问题。');
    return 0;
  }
  const byKind = new Map();
  for (const p of problems) byKind.set(p.kind, (byKind.get(p.kind) || 0) + 1);
  console.log(`[doc-audit] ✖ ${problems.length} 项在重写后消失了：` +
    [...byKind].map(([k, n]) => `${k} ${n}`).join('、'));
  const show = problems.slice(0, 40);
  for (const p of show) console.log(`  - [${p.kind}] 「${p.key}」少了 ${p.missing} 次`);
  if (problems.length > show.length) console.log(`  …另有 ${problems.length - show.length} 项，用 --json 取全量`);
  return 1;
}

function sha256(text) {
  // 用 node:crypto 而不是自己算：这里要的不是「无依赖」，是「对得上」。
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (e) { console.error('[doc-audit] ' + (e?.message || e)); process.exitCode = 2; }
}
