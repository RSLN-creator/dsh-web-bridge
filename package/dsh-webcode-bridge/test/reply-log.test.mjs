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
import { appendReplyLog, DEFAULT_REPLY_LOG_DIR } from '../lib/reply-log.js';

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
  // 本文件就在 node --test 下运行（NODE_TEST_CONTEXT 必然已设），不传 opts.dir
  // 必须返回 null；若实现回归，这里会真的往 ~/.dsh/logs 写入测试噪声。
  assert.ok(process.env.NODE_TEST_CONTEXT, '前提：本用例跑在测试进程里');
  const file = appendReplyLog('should not be written', { calls: 0 });
  assert.equal(file, null, '测试进程 + 无显式目录必须 no-op');
  assert.ok(!fs.existsSync(path.join(DEFAULT_REPLY_LOG_DIR, 'webcode-bridge-replies.log')
    ) || !fs.readFileSync(path.join(DEFAULT_REPLY_LOG_DIR, 'webcode-bridge-replies.log'), 'utf8').includes('should not be written'),
    '默认日志文件里不得出现本用例的写入');
});
