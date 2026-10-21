#!/usr/bin/env node
// check-official-drift.mjs — 官方一侧改了没有？**每次提交前**告诉你「照抄的那几段要不要同步」。
//
// ## 为什么必须有这个闸门（用户 2026-10-06 明令）
//
// 用户原话：「能接近，但官方一改版就会不同步**你不可以加上校验这一个代码每次提交前让我
// 知道是否需要同步了**？」
//
// 本插件里有两类东西是**照抄官方**的：一类是「照抄行为」（相位算法、会话体 occurrence 的
// 官方接法），一类是「照抄形状」（列头那一行、视图切换那两块要按官方位置渲染）。
// 照抄的东西一旦官方改版就会**静默失同步**——最坏的情况不是报错，而是「看起来还在工作、
// 其实和官方不是一回事」。上面那句话要的就是：让失同步**在提交前被点名**，而不是等用户在
// 界面上发现「怎么和官方不一样」。
//
// ## 2026-10-21（0.22.0）：20 段删到 1 段，判据本身也跟着「无消费者即删」
//
// 那个闸门此前登记 20 段，**其中 19 段服务的都是并发会话的「列顶栏复刻」**——
// 列头那一行要按官方 DOM 逐字复刻，所以官方改文案/改槽结构就得同步我们那份。
// 用户 2026-10-21 删掉任务板与并发会话之后，那 19 段的**实现已经不存在**：
// 逐项在 `lib/client.cjs` 里搜代表串，19 项全部 0 命中（唯一例外是宿主侧的
// `client-hmr-reload`，它服务的是「桌面端不重启就生效」的热换链，与本插件界面无关）。
//
// 它们不只是「多余」——它们让 pre-commit 在真机上报 `? 缺失 primitives-button-and-chevrons`
// 并退出 1，也就是**一个为已删功能而存在的闸门在拦所有提交**。
//
// 留下的 `client-hmr-reload` 是唯一仍在服役的照抄段落。**新增照抄段落时照旧在这里登记**，
// 但判据加一条：**登记前先确认那段代码真的还在**（否则就是给已删功能立一块碑）。
//
// ## 判据（事实来源 vs 仓库快照）
//
// 1. 从**当前安装的** DSH 里读官方客户端代码（`app.asar`，路径可用 `--asar` 覆盖）；
// 2. 对我们依赖的每一「段」取指纹：**关键行**（按正则筛出的那几行，逐字）的 sha256；
// 3. 与仓库里的快照 `doc/official-fingerprints.json` 比对（`--update` 才写）；
// 4. 任何一段的指纹变了 ⇒ 退出 1 并逐段打印「哪一段变了 + 该去看哪个文件」。
//
// ## 刻意不做的事
//
//   · **不自动改我们的代码**：照抄段落要不要跟、怎么跟，是人的判断（官方也可能是在改别的
//     东西而这几行恰好挪位）。本脚本只负责「告诉你」。
//   · **不比对整个 bundle 的 hash**：官方每次发版所有 bundle 都变，那种「全红」等于没有
//     信息量——用户要的是「我照抄的那几段有没有变」。所以按**段**取指纹。
//
// 用法：
//   node scripts/check-official-drift.mjs              # 人读输出（提交前跑）
//   node scripts/check-official-drift.mjs --json       # 机读
//   node scripts/check-official-drift.mjs --update     # 人工确认「已同步」后刷新快照
//   node scripts/check-official-drift.mjs --asar <path>
//
// 退出码：0 = 全部与快照一致（或快照刚被 --update 刷新）；1 = 有段落漂移；2 = 脚本自身出错。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const SNAPSHOT = path.join(repoRoot, 'doc', 'official-fingerprints.json');
const DEFAULT_ASAR = 'D:/2_Download_Main/4_DeepSeek Harness_code/resources/app.asar';

/**
 * 我们**照抄/依赖**的官方段落清单。每段 = 一个包内文件 + 一组必须逐字存在的正则；
 * 指纹 = 命中的那些行（去掉首尾空白、按顺序拼接）的 sha256。
 *
 * ⚠ 新增照抄段落时必须在这里登记一段，否则这个闸门对它失明——登记本身就是「我抄了哪里」的台账。
 */
const SEGMENTS = [
  {
    id: 'client-hmr-reload',
    file: 'dsh-client-hmr/lib/index.js',
    why: '客户端热换链（mtime/ctime/size → rebuilt 帧）——桌面端「不重启就生效」的全部依据',
    patterns: [/artifactRevision|mtimeMs/, /clientModules\.rebuilt/, /pollIntervalMs/],
  },
];

/** 极简 asar 读取：头 16 字节 + JSON 目录 + 相对偏移。 */
function readAsarEntry(asarPath, entryPath) {
  const buf = fs.readFileSync(asarPath);
  const headerSize = buf.readUInt32LE(12);
  const header = JSON.parse(buf.subarray(16, 16 + headerSize).toString('utf8'));
  const base = 16 + headerSize;
  let node = header;
  for (const part of entryPath.split('/')) {
    node = node.files?.[part];
    if (!node) return null;
  }
  if (node.files) return null;
  const off = Number(node.offset);
  return buf.subarray(base + off, base + off + Number(node.size)).toString('utf8');
}

/** 取一段的指纹：命中的行（逐字、去首尾空白）按顺序拼接后 sha256。 */
function fingerprint(segments, source) {
  const lines = String(source).split(/\r?\n/);
  const hit = [];
  const perPattern = [];
  for (const re of segments.patterns) {
    const matched = lines.filter((l) => re.test(l));
    perPattern.push({ pattern: String(re), hits: matched.length });
    for (const l of matched) hit.push(l.trim());
  }
  return {
    sha256: crypto.createHash('sha256').update(hit.join('\n')).digest('hex').slice(0, 16),
    lines: hit.length,
    perPattern,
  };
}

function main(argv) {
  const asarIdx = argv.indexOf('--asar');
  const asarPath = asarIdx >= 0 ? argv[asarIdx + 1] : DEFAULT_ASAR;
  const update = argv.includes('--update');
  const asJson = argv.includes('--json');

  if (!fs.existsSync(asarPath)) {
    console.error('[drift] 找不到官方 asar：' + asarPath + '（用 --asar <path> 指定）');
    process.exitCode = 2;
    return;
  }
  const snapshot = fs.existsSync(SNAPSHOT) ? JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')) : { at: null, asar: null, segments: {} };
  const now = { at: new Date().toISOString(), asar: asarPath, segments: {} };
  const drift = [];
  const missing = [];

  for (const seg of SEGMENTS) {
    const src = readAsarEntry(asarPath, 'dsh/node_modules/@deepseek-ai/' + seg.file);
    if (src === null) { missing.push({ id: seg.id, file: seg.file }); continue; }
    const fp = fingerprint(seg, src);
    now.segments[seg.id] = { file: seg.file, why: seg.why, ...fp };
    const old = snapshot.segments?.[seg.id];
    if (!old) drift.push({ id: seg.id, file: seg.file, why: seg.why, kind: 'new' });
    else if (old.sha256 !== fp.sha256) drift.push({ id: seg.id, file: seg.file, why: seg.why, kind: 'changed', was: old.sha256, now: fp.sha256, counts: fp.perPattern });
  }

  if (update) {
    fs.writeFileSync(SNAPSHOT, JSON.stringify(now, null, 2) + '\n');
    console.log('[drift] 快照已刷新：' + SNAPSHOT + '（' + SEGMENTS.length + ' 段）');
    process.exitCode = 0;
    return;
  }

  const report = { ok: drift.length === 0 && missing.length === 0, asar: asarPath, snapshotAt: snapshot.at, drift, missing };
  if (asJson) console.log(JSON.stringify(report, null, 2));
  else {
    console.log('[drift] 官方 asar：' + asarPath);
    console.log('[drift] 快照时间：' + (snapshot.at || '(无，首次请跑 --update)'));
    for (const [id, s] of Object.entries(now.segments)) {
      const changed = drift.some((d) => d.id === id);
      console.log('  ' + (changed ? '✖ DRIFT ' : '✔ 一致  ') + id.padEnd(28) + ' 行数=' + s.lines + ' sha=' + s.sha256);
    }
    for (const m of missing) console.log('  ? 缺失  ' + m.id + '（文件不在 asar 里：' + m.file + '）');
    if (drift.length) {
      console.log('');
      console.log('[drift] ✖ 有 ' + drift.length + ' 段与快照不一致——**照抄的部分需要人工同步**：');
      for (const d of drift) console.log('  · ' + d.id + '（' + d.file + '）：' + d.why);
      console.log('  处理：读一遍官方那一段 → 同步我们的实现 → 跑 `node scripts/check-official-drift.mjs --update` 刷新快照。');
    } else if (!missing.length) {
      console.log('[drift] ✔ 照抄段落与官方一致（' + SEGMENTS.length + ' 段）');
    }
  }
  process.exitCode = report.ok ? 0 : 1;
}

main(process.argv.slice(2));
