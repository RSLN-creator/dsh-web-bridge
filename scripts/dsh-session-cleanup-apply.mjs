#!/usr/bin/env node
// dsh-session-cleanup-apply.mjs — 按扫描报告**物理删除**本项目下跑废的会话目录。
//
// 这是一个破坏性脚本，所以设计上只做一件事：**把「删什么」的判据全部交给扫描报告**，
// 自己不做任何分类判断。想改判据就改 `dsh-session-cleanup-scan.mjs`，不要在这里加特例。
//
// 安全设计（每条都对应一种「删错了就回不来」）：
//   1. **默认 dry-run**。不加 `--apply` 只打印将删什么，一个字节都不动。
//   2. **删前先备份**：整个会话目录复制到备份根下（保留 `<workspace>/<sessionId>/` 层级），
//      备份成功才删。备份失败 ⇒ 该会话跳过，绝不「先删后备份」。
//   3. **活跃窗口保护**：报告里 category=active 的条目本就不在 prunable 里，这里再核验一次 mtime。
//   4. **白名单兜底**：`--keep <id片段>` 可复现地排除指定会话（用于人工复核后捞回）。
//   5. **只删会话目录**，且必须是 `<sessions 根>/<项目>/session-*` 这一层形状；
//      路径形状不对就拒绝，避免手滑把工作区目录整个端掉。
//
// 用法：
//   node scripts/dsh-session-cleanup-apply.mjs --scan .tmp/cleanup-scan.json            # 预演
//   node scripts/dsh-session-cleanup-apply.mjs --scan .tmp/cleanup-scan.json --apply    # 真删
//   node scripts/dsh-session-cleanup-apply.mjs --scan ... --apply --keep 43f7c5c0
//   node scripts/dsh-session-cleanup-apply.mjs --scan ... --apply --backup-root D:\x
//
// 退出码：0 正常；1 参数/一致性错误。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function sessionsRoot() {
  return path.join(dshHome(), 'sessions');
}

/** 项目目录下**只允许**删掉这种名字的子目录（会话目录）。 */
const SESSION_DIR_RE = /^session-[0-9a-fA-F-]{36}$|^[0-9a-fA-F-]{36}$/;

function parseArgs(argv) {
  const opts = { scan: null, apply: false, keep: [], backupRoot: null, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--scan') opts.scan = argv[++i];
    else if (a === '--apply') opts.apply = true;
    else if (a === '--keep') opts.keep.push(argv[++i]);
    else if (a === '--backup-root') opts.backupRoot = argv[++i];
    else if (a === '--quiet') opts.quiet = true;
    else if (a.startsWith('--')) throw new Error('未知选项：' + a);
    else throw new Error('多余参数：' + a);
  }
  if (!opts.scan) throw new Error('必须给 --scan <扫描报告.json>（先跑 dsh-session-cleanup-scan.mjs）');
  if (!fs.existsSync(opts.scan)) throw new Error('扫描报告不存在：' + opts.scan);
  return opts;
}

/**
 * 复核一条待删记录是否真的可以删。
 *
 * 输入不可信：报告可能是**旧**的（会话后来又被用了），也可能是手改过的。
 * 所以这里对磁盘现状重新核验，任何一条对不上就跳过并说明原因。
 *
 * @returns {{ok:true}|{ok:false,why:string}}
 */
function recheck(row) {
  const dir = path.dirname(row.file);
  const parent = path.dirname(dir);
  const root = sessionsRoot();
  if (row.keep) return { ok: false, why: '人工复核标记为保留' };
  if (path.resolve(parent) === path.resolve(root)) {
    return { ok: false, why: '会话目录直接躺在 sessions 根下，路径形状可疑，拒绝删除' };
  }
  if (!SESSION_DIR_RE.test(path.basename(dir))) {
    return { ok: false, why: '目录名不是会话 id 形状（' + path.basename(dir) + '），拒绝删除' };
  }
  if (!fs.existsSync(dir)) return { ok: false, why: '目录已不在（可能已被清理）' };
  // 报告是不是旧的？目录里还有比报告更新的写入就不动它。
  let newest = 0;
  for (const name of fs.readdirSync(dir)) {
    try { newest = Math.max(newest, fs.statSync(path.join(dir, name)).mtimeMs); } catch { /* 读不到就忽略 */ }
  }
  if (newest > row.mtimeMs + 1000) {
    return { ok: false, why: `目录在扫描之后又被写过（${new Date(newest).toISOString()} > ${new Date(row.mtimeMs).toISOString()}），跳过` };
  }
  return { ok: true };
}

/** 递归复制目录（备份用）。Node 22+ 的 cpSync 足够，且能保留时间戳。 */
function copyDir(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, preserveTimestamps: true });
}

function main(argv) {
  const opts = parseArgs(argv);
  const report = JSON.parse(fs.readFileSync(opts.scan, 'utf8'));

  // 只吃 `safeToDrop`（= 一轮没跑成**且**没有任何产出）。
  // 刻意**不**回退到 `prunable`：`prunable` 里有 20 条带着 goal / 交付物 / todo /
  // 成篇正文（最大的 886KB、跑过 135 个 step），那是「待人工复核」而不是垃圾。
  // 拿不到 `safeToDrop` 就报错停下，而不是猜一个更宽的集合去删——删错了回不来。
  if (!Array.isArray(report.safeToDrop)) {
    throw new Error('扫描报告里没有 safeToDrop 字段（报告太旧？）——请用当前版本的 dsh-session-cleanup-scan.mjs 重跑一次。');
  }
  const prunable = report.safeToDrop;

  const backupRoot = opts.backupRoot
    ? path.resolve(opts.backupRoot)
    : path.join(sessionsRoot(), '..', 'dsh-session-archive', 'pruned-' + report.generatedAt.slice(0, 10));

  const keepSet = new Set(opts.keep);
  const rows = prunable.map((r) => ({ ...r, keep: keepSet.has(r.id) || [...keepSet].some((k) => r.id.includes(k)) }));

  const plan = [];
  const skipped = [];
  for (const row of rows) {
    const verdict = recheck(row);
    if (verdict.ok) plan.push(row);
    else skipped.push({ id: row.id, why: verdict.why });
  }

  console.log(`扫描报告：${opts.scan}`);
  console.log(`  生成于 ${report.generatedAt}    范围 ${report.scope}`);
  console.log(`  一轮没跑成 ${report.prunableCount ?? '?'} 条 → 其中无产出的 ${prunable.length} 条可删，待复核 ${report.needsReviewCount ?? '?'} 条不动`);
  console.log(`  实际可删 ${plan.length} 条，跳过 ${skipped.length} 条`);
  console.log(`  备份根：${backupRoot}`);
  console.log(`  模式：${opts.apply ? '【真删】' : '预演（dry-run，不动任何文件）'}`);
  if (skipped.length) {
    console.log('\n-- 跳过 --');
    for (const s of skipped) console.log(`  ${s.id}  ${s.why}`);
  }
  const byCat = {};
  for (const p of plan) byCat[p.category] = (byCat[p.category] || 0) + 1;
  console.log('\n-- 将删除（按类别）--');
  for (const [c, n] of Object.entries(byCat)) console.log(`  ${c.padEnd(18)} ${n}`);

  if (!opts.apply) {
    console.log('\n预演结束。加 --apply 才会真删（会先备份到上面那个备份根）。');
    return;
  }

  fs.mkdirSync(backupRoot, { recursive: true });
  const manifest = [];
  let deleted = 0;
  let failed = 0;
  for (const row of plan) {
    const dir = path.dirname(row.file);
    const rel = path.relative(sessionsRoot(), dir);
    const backupDir = path.join(backupRoot, rel);
    try {
      copyDir(dir, backupDir);
      // 备份校验：目录下文件数一致才允许删。
      const before = fs.readdirSync(dir).length;
      const after = fs.readdirSync(backupDir).length;
      if (after !== before) throw new Error(`备份文件数不符（原 ${before} / 备份 ${after}）`);
      fs.rmSync(dir, { recursive: true, force: true });
      deleted += 1;
      manifest.push({ id: row.id, category: row.category, dir, backupDir, deleted: true });
      if (!opts.quiet) console.log(`  已删 ${row.id}  [${row.category}]  → 备份 ${backupDir}`);
    } catch (e) {
      failed += 1;
      manifest.push({ id: row.id, category: row.category, dir, backupDir, deleted: false, error: String(e?.message || e) });
      console.error(`  失败 ${row.id}: ${e?.message || e}`);
    }
  }

  const manifestPath = path.join(backupRoot, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    scanReport: path.resolve(opts.scan),
    scope: report.scope,
    backupRoot,
    deleted,
    failed,
    entries: manifest,
  }, null, 2), 'utf8');

  console.log(`\n完成：删除 ${deleted} 个，失败 ${failed} 个。`);
  console.log('备份清单：' + manifestPath);
  if (failed) process.exitCode = 1;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try { main(process.argv.slice(2)); }
  catch (e) { console.error('dsh-session-cleanup-apply: ' + (e?.message || e)); process.exitCode = 1; }
}
