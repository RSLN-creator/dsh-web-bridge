// prompt-store.test.mjs — 0.16.28 护栏：提示词/上下文的每站点、每会话落盘。
//
// 用户指令（逐字）：「将提示词保存为本地的单独文件-每个网址一个，然后每轮发送过去，
// 然后是每轮会话单独本地地址——如果新开会话-web 端，就一样把这个当上下文通过文件发送」。
// 本文件钉四件事：路径消毒（不逃目录）、双文件内容落盘、显式关闭（'off'）、
// 测试进程守卫（无显式目录一律不写——与 reply-log 同款纪律）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sitePromptPath, sessionPromptPath, writePromptFile, writePromptFiles, DEFAULT_PROMPT_STORE_DIR } from '../lib/prompt-store.js';

const pkg = path.dirname(import.meta.dirname);

function tmpDir(prefix = 'webcode-pstore-') {
  try { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); } catch {
    const d = path.join(pkg, '.tmp', prefix + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
}

test('路径：站点与会话 token 消毒，不逃出存储目录', () => {
  assert.equal(sitePromptPath('/base', 'deepseek'), path.join('/base', 'prompts', 'deepseek.md'));
  const p1 = sessionPromptPath('/base', 'session-abc::agent-9');
  assert.ok(p1.includes('session-abc__agent-9'), ':: 必须折叠进单段 token：' + p1);
  assert.ok(!p1.includes('::'), '路径段里不保留 :: 分隔符');
  const evil = sessionPromptPath('/base', '../../etc/passwd');
  assert.ok(!evil.includes('..'), '路径穿越字符必须被消毒掉：' + evil);
  assert.ok(evil.startsWith(path.join('/base', 'sessions')), '消毒后必须仍落在 sessions/ 之内');
  assert.equal(sessionPromptPath('/base', ''), sessionPromptPath('/base', 'anonymous'), '空键回落 anonymous');
});

test('写入：站点文件 + 会话文件同时落盘，头部带元信息', () => {
  const dir = tmpDir();
  const { siteFile, sessionFile } = writePromptFiles({
    dir, siteId: 'deepseek', sessionKey: 'session-xyz::agent-1',
    siteText: '教学全文 ABC', sessionText: '首轮全文 DEF',
  });
  assert.ok(siteFile && fs.existsSync(siteFile), '站点文件必须落盘');
  assert.ok(sessionFile && fs.existsSync(sessionFile), '会话文件必须落盘');
  assert.ok(siteFile.includes(path.join('prompts', 'deepseek.md')), '站点文件在 prompts/ 下按站点命名');
  assert.ok(sessionFile.includes(path.join('sessions', 'session-xyz__agent-1.md')), '会话文件在 sessions/ 下按键命名');
  const siteBody = fs.readFileSync(siteFile, 'utf8');
  assert.ok(siteBody.includes('教学全文 ABC'), '站点文件含教学全文');
  assert.ok(siteBody.includes('dsh-webcode-bridge'), '头部带来源标识');
  assert.ok(fs.readFileSync(sessionFile, 'utf8').includes('首轮全文 DEF'), '会话文件含首轮全文');
});

test('语义：无会话文本/无会话键 → 只写站点文件；空文本不写', () => {
  const dir = tmpDir();
  const only = writePromptFiles({ dir, siteId: 'glm', siteText: 'GLM 教学' });
  assert.ok(only.siteFile, '只有 siteText 也应写站点文件（重建点没有工具清单可再生成）');
  assert.equal(only.sessionFile, null, '无会话文本时不得写会话文件');
  const empty = writePromptFiles({ dir, siteId: 'glm', siteText: '   ' });
  assert.equal(empty.siteFile, null, '空白文本不落盘');
});

test('开关：dir 写 off 显式关闭；测试进程（NODE_TEST_CONTEXT）无显式目录一律不写', () => {
  const off = writePromptFiles({ dir: 'off', siteId: 'deepseek', siteText: 'x', sessionKey: 's', sessionText: 'y' });
  assert.deepEqual(off, { siteFile: null, sessionFile: null }, "'off' 必须整条关闭");
  const guarded = writePromptFiles({ siteId: 'deepseek', siteText: 'x', sessionKey: 's', sessionText: 'y' });
  assert.deepEqual(guarded, { siteFile: null, sessionFile: null },
    'node --test 进程不许写真实 ~/.dsh/webcode/（取证数据纪律）');
});

test('失败静默：目标目录不可建（路径被文件占据）→ 返回 null 不抛出', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'blocked'), 'x');
  const r = writePromptFile(path.join(dir, 'blocked', 'prompts', 'deepseek.md'), '内容');
  assert.equal(r, null, 'mkdir 撞上已存在文件必须静默返回 null');
});

test('默认目录在用户目录下（与 reply-log 的 ~/.dsh 纪律一致）', () => {
  assert.ok(DEFAULT_PROMPT_STORE_DIR.includes('.dsh'), '默认目录应落在 ~/.dsh 之下：' + DEFAULT_PROMPT_STORE_DIR);
});
