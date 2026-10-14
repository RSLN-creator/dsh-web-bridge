#!/usr/bin/env node
// gen-progress-index.mjs — 给 `doc/progress.md` 生成/校验**顶部分节索引**。
//
// 为什么需要它（真实缺口）：
//
// `doc/progress.md` 是 7,000+ 行、97 个 `##` 小节的**一手台账**，而且是**倒序**堆叠的
// （最新在最上）。没有索引时的实际后果有三条，都发生过：
//   1. 「0.19.5x 那轮到底改了什么」只能从头往下翻，翻到一半就丢了上下文；
//   2. 同一版本号有多节（`0.19.68` 有三节：10-06 轮 / 10-07 轮 / 10-08 轮），
//      按号检索会拿到其中一节就以为拿全了；
//   3. 文件里**混着顺序异常**：历史半段不再是严格倒序（实测 4 处），
//      而「最新在最上」这个隐含约定**没有任何一行写出来**。
//
// 本脚本把小节表**现扫生成**，并把它夹在 progress.md 顶部的两个标记之间——
// 与 `wiki/tools/gen-index.mjs` 同一套办法：机器生成、可校验、过期即红。
//
//   node scripts/gen-progress-index.mjs           # 重建索引（就地改写 progress.md 的索引块）
//   node scripts/gen-progress-index.mjs --check   # 只校验（过期退 1，其余退 0）
//   node scripts/gen-progress-index.mjs --json    # 打印解析结果（不改文件）
//
// 退出码：0 = 已写入 / 已最新；1 = --check 模式下索引过期；2 = 脚本自身出错。
//
// ⚠ 判据边界（照 check-ledger 的先例写在输出里）：本脚本只判「索引与小节表是否一致」，
//   不判「每节写得对不对」，也不判「同一版本号的多节该不该合并」。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const DOC = path.join(repoRoot, 'doc', 'progress.md');

/** 索引块的两个标记。手写内容一律在标记之外。 */
const BEGIN = '<!-- BEGIN GENERATED: progress-index（由 scripts/gen-progress-index.mjs 生成，不要手改） -->';
const END = '<!-- END GENERATED: progress-index -->';

/**
 * 解析小节表。
 *
 * `line` 是**生成时**的行号；写入索引块会把整份文件往下推，所以真正的写入流程是
 * 「先摘掉旧索引块 → 再解析 → 再插入」，否则行号会自我指涉地漂移。
 *
 * @param {string} md progress.md 全文
 * @returns {Array<{line:number,title:string,version:string|null,date:string|null,era:string}>}
 */
export function parseSections(md) {
  const out = [];
  const lines = md.split(/\r?\n/);
  let insideIndex = false;
  for (let i = 0; i < lines.length; i += 1) {
    // 索引块自己的 `## 分节索引` 不是台账小节 ⇒ 跳过整块，否则生成器会把自己数进去、
    // 于是每次重建都「多一节」、--check 永远红（第一版就踩了这个自指）。
    if (lines[i].includes(BEGIN)) { insideIndex = true; continue; }
    if (lines[i].includes(END)) { insideIndex = false; continue; }
    if (insideIndex) continue;
    if (!/^## /.test(lines[i])) continue;
    const title = lines[i].slice(3).trim();
    const version = (/(\d+\.\d+\.\d+)/.exec(title) || [])[1] || null;
    const date = (/(\d{4}-\d{2}-\d{2})/.exec(title) || [])[1] || null;
    out.push({ line: i + 1, title, version, date, era: eraOf(version, date) });
  }
  return out;
}

/**
 * 把一节归入「时代」。分界按**代码与纪律的转折点**取，不按日历等分：
 * 九个时代见 `doc/HISTORY.md` 的分段说明。
 */
function eraOf(version, date) {
  const v = version ? Number(version.split('.')[1]) : null;
  const minor = version ? Number(version.split('.')[2]) : null;
  if (!version) return '前史 / 无版本号小节';
  if (v === 5 || v === 6 || v === 7 || v === 8 || v === 9 || v === 10 || v === 11 || v === 12 || v === 13) return '① 立骨架（0.5–0.13）';
  if (v === 14 || v === 15) return '② 纪律成型（0.14–0.15）';
  if (v === 16) return '③ 契约与解码器收口（0.16）';
  if (v === 17 || v === 18 || v === 20 || v === 21) return '④ 镜像/画面流路线（0.17–0.21，部分已回退）';
  if (v === 19) {
    if (minor !== null && minor <= 9) return '⑤ 0.19 早期（多账号/思考等级/npm 首发）';
    if (minor !== null && minor <= 49) return '⑥ 0.19.1x–0.19.4x（镜像与契约闸门）';
    if (minor !== null && minor <= 59) return '⑦ 0.19.5x（DSH 0.2.x 兼容 + 并发会话起步）';
    return '⑧ 0.19.6x–0.19.75（并发会话面板 + 内容完整性/账号锁）';
  }
  return '⑨ 其它';
}

/** 时代的固定展示顺序（索引按它分组，组内保持文件顺序 = 倒序）。 */
const ERA_ORDER = [
  '⑧ 0.19.6x–0.19.75（并发会话面板 + 内容完整性/账号锁）',
  '⑦ 0.19.5x（DSH 0.2.x 兼容 + 并发会话起步）',
  '⑥ 0.19.1x–0.19.4x（镜像与契约闸门）',
  '⑤ 0.19 早期（多账号/思考等级/npm 首发）',
  '④ 镜像/画面流路线（0.17–0.21，部分已回退）',
  '③ 契约与解码器收口（0.16）',
  '② 纪律成型（0.14–0.15）',
  '① 立骨架（0.5–0.13）',
  '前史 / 无版本号小节',
  '⑨ 其它',
];

/**
 * 生成索引块文本。
 *
 * 版本文案用**小节的原文标题**（截断），不做改写——台账是记录，不是摘要。
 * 因此索引只提供「跳到哪一行」，不替读者下结论。
 */
export function renderIndex(secs) {
  const byEra = new Map();
  for (const s of secs) {
    if (!byEra.has(s.era)) byEra.set(s.era, []);
    byEra.get(s.era).push(s);
  }
  const total = secs.length;
  const L = [];
  L.push(BEGIN);
  L.push('');
  L.push('## 分节索引（自动生成）');
  L.push('');
  L.push(`本文件共 **${total}** 个 ` + '`## `' + '小节，**最新在最上**。');
  L.push('下面按「时代」分组，组内保持文件顺序；行号是本节在**当前文件**里的起始行。');
  L.push('');
  L.push('> 索引由 `node scripts/gen-progress-index.mjs` 生成、`--check` 校验。');
  L.push('> 它只回答「哪一轮在哪一行」，**不替读者下结论**——结论在小节正文里。');
  L.push('> ⚠ 同一版本号可能有多节（例：`0.19.68` 有 10-06 / 10-07 / 10-08 三轮），');
  L.push('> 它们是**不同轮次**，不是重复登记。');
  L.push('');
  L.push('| 时代 | 节数 | 版本跨度 |');
  L.push('| --- | --- | --- |');
  for (const era of ERA_ORDER) {
    const rows = byEra.get(era);
    if (!rows || !rows.length) continue;
    const vs = rows.map((r) => r.version).filter(Boolean);
    const span = vs.length ? `${vs[vs.length - 1]} → ${vs[0]}` : '（无版本号）';
    L.push(`| ${era} | ${rows.length} | ${span} |`);
  }
  L.push('');
  for (const era of ERA_ORDER) {
    const rows = byEra.get(era);
    if (!rows || !rows.length) continue;
    L.push(`### ${era}`);
    L.push('');
    L.push('| 行 | 版本 | 日期 | 小节 |');
    L.push('| --- | --- | --- | --- |');
    for (const r of rows) {
      const t = r.title.replace(/\|/g, '\\|');
      L.push(`| ${r.line} | ${r.version || '—'} | ${r.date || '—'} | ${t} |`);
    }
    L.push('');
  }
  L.push(END);
  return L.join('\n');
}

/** 摘掉旧的索引块（含标记所在整段），返回 `{body, found}`。 */
function stripIndexBlock(md) {
  const b = md.indexOf(BEGIN);
  if (b === -1) return { body: md, found: false };
  const e = md.indexOf(END, b);
  if (e === -1) return { body: md, found: false };
  // ⚠ 只吃掉**缝合处**的换行，不得对全文做 `\n{3,}` → `\n\n` 那种「顺手规整」：
  // 第一版就是那么写的，于是 `--check` 会把**正文里的空行**也压掉 ⇒ 重算出的索引与
  // 文件里的永远差若干行、永远红；更坏的是它**真的改写了正文**（一个「校验」动作
  // 在破坏被校验的文件）。判据必须只碰它自己那一段。
  let end = e + END.length;
  while (md[end] === '\n') end += 1;
  return { body: md.slice(0, b) + md.slice(end), found: true };
}

/**
 * 决定索引插在哪：**第一个 `---` 分隔线之后**（即文件头那几段约定文字的下方）。
 *
 * 为什么不插在文件最顶上：顶部那几段回答「这个文件为什么存在、与 long-term-issues
 * 怎么分工」，是**读之前**就该看到的；索引是**查**的入口，排在它后面更顺。
 */
function insertIndex(body, indexBlock) {
  const lines = body.split(/\r?\n/);
  let at = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^---\s*$/.test(lines[i])) { at = i; break; }
  }
  if (at === -1) return body + '\n\n' + indexBlock + '\n';
  const head = lines.slice(0, at + 1).join('\n');
  const tail = lines.slice(at + 1).join('\n').replace(/^\n+/, '');
  return head + '\n\n' + indexBlock + '\n\n' + tail;
}

/** 当前文件里索引块的内容（用于 --check 比对）。 */
function currentIndexBlock(md) {
  const b = md.indexOf(BEGIN);
  if (b === -1) return null;
  const e = md.indexOf(END, b);
  if (e === -1) return null;
  return md.slice(b, e + END.length);
}

function main(argv) {
  const check = argv.includes('--check');
  const json = argv.includes('--json');
  if (!fs.existsSync(DOC)) { process.stderr.write('[progress-index] 读不到 ' + DOC + '\n'); return 2; }

  const original = fs.readFileSync(DOC, 'utf8');

  // ⚠ 行尾归一化（2026-10-14 CI 红后修）：本文件在**干净 clone** 上可能是 CRLF。
  //   `core.autocrlf=true`（本机默认）且仓库**没有** `.gitattributes` ⇒ git checkout
  //   出来的 progress.md 是 CRLF，而本机工作树是 LF（两种都合法）。
  //   重建出的索引块由 `join('\n')` 生成 ⇒ 恒为 LF；若比较前不归一化，
  //   `--check` 在 CRLF 形态下**恒红**（首个差异就是每行末尾多一个 `\r`）。
  //   实测（2026-10-14，CI run 38530563959）：本机绿、CI 红，真因就是这个。
  //   归一化只用于比较与解析；**写回时用文件原有的行尾**（见 writeEol）。
  const writeEol = original.includes('\r\n') ? '\r\n' : '\n';
  const md = original.replace(/\r\n/g, '\n');

  if (json) {
    const secs = parseSections(md);
    process.stdout.write(JSON.stringify({ sections: secs.length, secs }, null, 2) + '\n');
    return 0;
  }

  const { body } = stripIndexBlock(md);
  const secs = parseSections(body);
  // 行号要按**插入后**的真实位置算：插入点之前有多少行，就整体下移多少。
  const probe = insertIndex(body, renderIndex(secs));
  const finalSecs = parseSections(probe);
  const block = renderIndex(finalSecs);
  const next = insertIndex(body, block);
  const hadBlock = currentIndexBlock(md) !== null;

  if (check) {
    const cur = currentIndexBlock(md);
    if (!hadBlock) {
      process.stderr.write('[progress-index] ✖ 索引块不存在（缺 ' + BEGIN.slice(0, 40) + '…）\n');
      process.stderr.write('[progress-index] 跑 `node scripts/gen-progress-index.mjs` 生成。\n');
      return 1;
    }
    if (cur !== block) {
      // ⚠ 这里**不要**用 `parseSections(cur)` 当读数：`parseSections` 会跳过整个索引块
      //   （`insideIndex`），对「块本身」解析**恒为 0 节**。旧文案因此打成
      //   「文档 99 节，索引 0 节」——一个自相矛盾的读数（索引明明在，却说 0 节），
      //   把「块内容与重建块不一致」误导成「索引不见了」。
      const a = cur.split('\n'); const c = block.split('\n');
      let firstDiff = -1;
      for (let i = 0; i < Math.max(a.length, c.length); i += 1) {
        if (a[i] !== c[i]) { firstDiff = i + 1; break; }
      }
      process.stderr.write('[progress-index] ✖ 索引块与重建结果不一致：文档 ' + finalSecs.length
        + ' 个小节；块内 ' + a.length + ' 行 vs 重建 ' + c.length + ' 行；首个差异在第 '
        + (firstDiff === -1 ? '（无）' : firstDiff) + ' 行。\n');
      process.stderr.write('[progress-index] 跑 `node scripts/gen-progress-index.mjs` 重建。\n');
      return 1;
    }
    process.stdout.write('[progress-index] ✔ 索引最新（' + finalSecs.length + ' 个小节）。\n');
    return 0;
  }

  if (next !== md) {
    // 写回时恢复**文件原有的行尾**，避免把 CRLF 文件改成 LF（那会产生全文件 diff）
    fs.writeFileSync(DOC, writeEol === '\r\n' ? next.replace(/\n/g, '\r\n') : next);
    process.stdout.write('[progress-index] ✔ 已写入索引：' + finalSecs.length + ' 个小节' +
      (hadBlock ? '（替换旧索引块）' : '（新建索引块）') + '（行尾 ' + (writeEol === '\r\n' ? 'CRLF' : 'LF') + '）。\n');
  } else {
    process.stdout.write('[progress-index] ✔ 索引已是最新（' + finalSecs.length + ' 个小节）。\n');
  }
  process.stdout.write('[progress-index] 注意：本脚本只判「索引与小节表是否一致」，' +
    '不判每节写得对不对。\n');
  return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (e) { process.stderr.write('[progress-index] ' + (e?.message || e) + '\n'); process.exitCode = 2; }
}
