// reply-log.test.mjs — 0.16.17 护栏：网页原始回复全文的落盘日志。
//
// 为什么必须钉住（真机取证第三次断链，2026-09-19）：0.16.13 的「扣留全文进日志」
// 走 console.warn，只到 DSH 进程 stderr、运行时不持久化——run-8 的 UNPARSED 扣留
// 1474 字符，磁盘上只剩提示里的 200 字符头（会话存档 `session-0fd32761`
// assistant/message 04:56:28 实测），归因断链且无法像夹具 19/20 那样靠残片重构。
// 模块行为：默认落 `~/.dsh/logs/webcode-bridge-replies.log`、超限轮转一代（.1）、
// 写失败静默返回 null、测试进程（NODE_TEST_CONTEXT）下不写默认目录。
// 全部用例显式传 opts.dir / opts.maxBytes，绝不触碰真实日志目录。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendReplyLog } from '../lib/reply-log.js';

/** 包根目录（源码级判据读文件用）。与其它测试文件同形（`import.meta.dirname` 的上一级）。 */
const PKG = path.join(import.meta.dirname, '..');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'webcode-reply-log-'));
const cleanup = (d) => fs.rmSync(d, { recursive: true, force: true });
const NOW = new Date('2026-09-19T04:56:28.000Z');

test('写入：头行元信息 + 原文逐字 + 尾行定界，返回文件路径', () => {
  const dir = tmp();
  try {
    const text = '第一行\r\n<｜｜DSML｜｜ invoke name="edit">\r\n第二行';
    const file = appendReplyLog(text, { sessionId: 'sess-abc', chars: 999, calls: 0, note: 'raw reply, verbatim' }, { dir, now: NOW });
    assert.equal(file, path.join(dir, 'webcode-bridge-replies.log'));
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    assert.ok(lines[0].startsWith('=== webcode-bridge raw reply === | '), '头行必须是定界前缀');
    assert.ok(lines[0].includes('2026-09-19T04:56:28'), '头行带时间');
    assert.ok(lines[0].includes('session=sess-abc'), '头行带会话');
    assert.ok(lines[0].includes('chars=999'), '头行带字符数（元信息优先于实测）');
    assert.ok(lines[0].includes('calls=0'), '头行带调用数');
    assert.ok(content.includes(text), '原文必须逐字在文件里（含全角标记与 CRLF）');
    assert.ok(content.endsWith('=== webcode-bridge raw reply === end\n'), '尾行定界');
    assert.equal(lines.filter((l) => l === '=== webcode-bridge raw reply === end').length, 1, '尾行只出现一次');
  } finally { cleanup(dir); }
});

test('轮转：超过 maxBytes 时旧文件改名为 .1（保留一代），新写入从头开始', () => {
  const dir = tmp();
  try {
    const big = 'x'.repeat(1200);
    appendReplyLog(big, { calls: 1 }, { dir, maxBytes: 1000, now: NOW });
    const first = path.join(dir, 'webcode-bridge-replies.log');
    assert.ok(fs.statSync(first).size > 1000, '第一次写入可以超限（轮转发生在下一次写入前）');
    appendReplyLog('second', { calls: 2 }, { dir, maxBytes: 1000, now: NOW });
    assert.ok(fs.existsSync(first + '.1'), '旧文件轮转为 .1');
    assert.ok(fs.readFileSync(first + '.1', 'utf8').includes(big), '.1 保存的是上一代全文');
    const cur = fs.readFileSync(first, 'utf8');
    assert.ok(cur.includes('second'), '当前文件是新内容');
    assert.ok(!cur.includes(big), '当前文件不再含旧正文');
    // 第三次写入（未超限）不得再次轮转：.1 保持不变
    appendReplyLog('third', { calls: 3 }, { dir, maxBytes: 1000, now: NOW });
    assert.ok(fs.readFileSync(first + '.1', 'utf8').includes(big), '未超限时 .1 不被覆盖');
  } finally { cleanup(dir); }
});

test('失败静默：目录不可写（路径被文件占用）返回 null 且不抛错', () => {
  const dir = tmp();
  try {
    const blocker = path.join(dir, 'occupied');
    fs.writeFileSync(blocker, 'not a dir');
    const file = appendReplyLog('x', { calls: 0 }, { dir: blocker });
    assert.equal(file, null, 'mkdir/mkdir 途中失败必须吞掉并返回 null');
  } finally { cleanup(dir); }
});

test('测试进程守卫：NODE_TEST_CONTEXT 下未显式给目录时不写默认位置', () => {
  // 本用例的守卫只在 NODE_TEST_CONTEXT 已设时才有意义（node --test 通道）；
  // 直跑（node test/x.mjs，调试用）没有这个 env——前提不成立时跳过守卫断言，
  // 但仍验证「不显式给目录」这条路径本身可走（写入落到默认目录或返回 null，
  // 两种都不抛错——0.19.30 起直跑不再把前提当硬断言拦整份测试）。
  if (!process.env.NODE_TEST_CONTEXT) {
    const file = appendReplyLog('should not be written', { calls: 0 });
    assert.ok(file === null || typeof file === 'string', '无 env 直跑：守卫路径不抛错即可');
    return;
  }
  const file = appendReplyLog('should not be written', { calls: 0 });
  assert.equal(file, null, '测试进程 + 无显式目录必须 no-op');
  // 契约就到此为止：**返回 null 就等于没有落盘**，这正是本用例要钉的那条守卫。
  //
  // 为什么删掉了原先那条「默认日志文件里不得出现本用例写入」的内容断言（2026-09-27）：
  // 它读的是**生产日志**（~/.dsh/logs/webcode-bridge-replies.log），而那份文件同时是桥的
  // **原始回复留痕**——正文里出现 `should not be written` 这句话完全合法。本机实测确已发生：
  // 一条被 dump 的模型回复逐字引用了本测试文件的源码（该文件第 25839 行），断言因此失败。
  // 关键读数：**HEAD 版本跑同一个用例同样失败** ⇒ 它与本轮改动无关，是一条**环境相关**的假红。
  // 假红比漏报更坏（doc/comment-style.md §9.1 第 1 条）：它会让整份测试在某台机器上永远红着，
  // 读者于是学会忽略它。真正的守卫由上一行断言承担；内容比对这一层判不了「谁写的」，
  // 留着只会再次误伤，因此按「修判据而不是绕过」的同一纪律删掉这一条。
});

// ── 0.19.83：**逐文件跑**（本机文档化的跑法）也必须被守卫拦住（long-term-issues #73）──
//
// ## 本条防的是哪一次真缺陷（2026-10-16 实测，逐条可复核）
//
// 旧守卫只认 `NODE_TEST_CONTEXT`，而它**只在 `node --test` 下由 runner 设置**。
// 本仓库因为「本机 `spawnSync` 调外部程序 EPERM」而**文档化要求逐文件跑**
// （`node test/xxx.test.mjs`）——**那种跑法根本不设这个变量** ⇒ 守卫不生效。
//
// 实测读数（可复核）：
//   · 跑一次 `node test/auto-continue.test.mjs` ⇒ 真实取证日志里
//     `session=auto-cont-1` 的条目 **34 → 36（+2）**；
//   · 全量：**3644 条里 2065 条来自非真机会话**，真机会话（`session-<uuid>`）只有 1579 条。
//
// 而本轮的 ④ 项审计**真的**先被它误导过一次：把一条**测试合成形状**
// （`D:/x.js` 占位值、9 个 `auto-*` 会话、201 条只有 4 个逐字片段）当成
// 「deepseek 真机的反复失败形态」，差点照它去改解析器。**假读数比没有读数更贵。**
//
// ## 判据（与跑法无关）
//
// 调用 `appendReplyLog` 时**不给 opts.dir**，然后断言它 **return null**。
// 这条在**两种跑法下都必须成立**：`node --test`（走 env 判据）与
// 逐文件 `node test/reply-log.test.mjs`（走**调用栈**判据——栈里出现本仓库
// `test/` 目录的 .mjs 文件）。
//
// ⚠ 为什么这里**可以**断言「必须 null」：本文件所有写入用例都显式传 `opts.dir`
//   （见文件头注），因此「不传 dir」在本文件里**只可能**来自测试上下文。
test('★ 0.19.83 逐文件跑也必须被守卫拦住：不给 opts.dir 时必须返回 null（#73）', () => {
  const file = appendReplyLog('MUST-NOT-LAND-IN-REAL-LOG', { sessionId: 'session-00000000-0000-0000-0000-000000000000', calls: 0 });
  assert.equal(file, null,
    '测试上下文（无论 node --test 还是逐文件跑）里不传 opts.dir 时必须 no-op —— '
    + '否则合成回复会写进真实取证日志 ~/.dsh/logs/，污染真机读数（#73 实测：+2 条/次）');
  // 反向补一条：**显式给目录仍必须能写**（守卫不能宽到把测试自己的用例也拦掉）
  const dir = tmp();
  try {
    const ok = appendReplyLog('explicit dir must still write', { calls: 0 }, { dir, now: NOW });
    assert.equal(ok, path.join(dir, 'webcode-bridge-replies.log'),
      '显式传 opts.dir 的写入必须照常落盘（守卫只拦「落到真实取证目录」这一种）');
  } finally { cleanup(dir); }
});

// ── 0.19.84：真机取证脚本**不得**把产物写进真实取证日志（#73 的同族纪律）──────────
//
// `site-verify-multiturn.mjs` 新增了 opt-in 的原始回复留档（`SV_CAPTURE_REPLIES=1`），
// 落点固定在 `.tmp/real-lane/out/`。**它绝不能碰 `~/.dsh/logs/`** ——
// 那份目录已经被测试合成数据污染过一次（#73：2065/3644 条），再让脚本往里写
// 等于把同一个坑挖第二次。这里用**源码级**判据钉住（改坏了立刻红）。
test('★ 0.19.84 取证脚本的留档必须落在 .tmp/，不得指向真实取证日志目录', () => {
  const raw = fs.readFileSync(path.join(PKG, 'test-mock', 'site-verify-multiturn.mjs'), 'utf8');
  // ⚠ 先剥注释再判（本轮第 5 次遇到同一形状）：脚本的**注释**里必须写明
  //   「绝不碰 `~/.dsh/logs/`」——那正是本判据要保护的东西，对原文匹配会把
  //   那句**说明**当成违规。护栏判**代码**，不判注释里的说明与证据引用。
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
  // ① 不得引用产品的默认**取证日志**目录
  //
  // ⚠ 判据要**精确到 logs/**，不能泛化成 `.dsh`：脚本必须读
  //   `~/.dsh/webcode-edge-profile`（**登录态 profile**，合法且必需），
  //   而**禁止**的是 `~/.dsh/logs`（真机取证的唯一原始记录）。
  //   首版写成「出现 `.dsh` 即红」⇒ 把合法的 profile 读取判成违规（当场假红）。
  //   教训与 #68/#73 同型：**判据的粒度必须对准要保护的那件事**，不是对准一个更大的名字。
  assert.ok(!src.includes('DEFAULT_REPLY_LOG_DIR'), '取证脚本不得引用产品的 DEFAULT_REPLY_LOG_DIR');
  assert.ok(!/['"](?:[^'"]*[\\/])?logs[\\/]/.test(src) && !src.includes("'.dsh', 'logs'"),
    '取证脚本不得指向 ~/.dsh/logs（真机取证的唯一原始记录；profile 读取是合法的，logs 不是）');
  assert.ok(!/appendReplyLog/.test(src),
    '取证脚本不得调用产品的 appendReplyLog（那条路只属于 index.js 的适配器路径，且会落到真实日志）');
  // ② 自己的留档必须显式指向 outDir（本脚本的 outDir = .tmp/real-lane/out）
  assert.match(src, /captureReply\(outDir,/, '留档调用必须显式传 outDir（脚本内的 .tmp 输出目录）');
  // ③ 默认关闭：只有显式 opt-in 才写盘
  assert.match(src, /process\.env\.SV_CAPTURE_REPLIES !== '1'\) return null/,
    '留档必须默认关闭（加了写盘就有 IO 与体积成本，只在需要取形状时开）');
});

test('0.19.30 按站点分文件：meta.siteId 时落 <site> 段文件，头行带 site= 字段', () => {
  const dir = tmp();
  try {
    const file = appendReplyLog('hi', { siteId: 'glm', calls: 1 }, { dir, now: NOW });
    assert.equal(file, path.join(dir, 'webcode-bridge-replies.glm.log'));
    const content = fs.readFileSync(file, 'utf8');
    assert.ok(content.includes('site=glm'), '头行带站点字段（时间之后、session 之前）');
    assert.ok(content.includes('session=-'), '无会话标识仍记 session=-');
    assert.ok(!fs.existsSync(path.join(dir, 'webcode-bridge-replies.log')), '默认名文件不被创建');
  } finally { cleanup(dir); }
});

test('siteId 安全化：非法字符剔除、空值回落默认文件名', () => {
  const dir = tmp();
  try {
    const a = appendReplyLog('a', { siteId: 'Deep_Seek!.exe', calls: 0 }, { dir });
    assert.equal(a, path.join(dir, 'webcode-bridge-replies.deepseekexe.log'));
    const b = appendReplyLog('b', { calls: 0 }, { dir });
    assert.equal(b, path.join(dir, 'webcode-bridge-replies.log'));
  } finally { cleanup(dir); }
});

test('显式 opts.basename 胜过站点分文件（测试通道不受 siteId 影响）', () => {
  const dir = tmp();
  try {
    const file = appendReplyLog('x', { siteId: 'glm', calls: 0 }, { dir, basename: 'custom.log' });
    assert.equal(file, path.join(dir, 'custom.log'));
  } finally { cleanup(dir); }
});
