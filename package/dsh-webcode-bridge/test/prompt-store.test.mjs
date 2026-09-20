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
import { sitePromptPath, sessionPromptPath, writePromptFile, writePromptFiles, readPromptFile, DEFAULT_PROMPT_STORE_DIR } from '../lib/prompt-store.js';

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

// ── 0.16.29：读回（文件投递）────────────────────────────────────────────────
//
// 用户指令：「如果新开会话-web 端，就一样把这个当上下文通过文件发送」。
// 落盘从「副本」升格为「投递源」的前提是**能原样读回**——写出去什么，读回来
// 就是什么（头部元信息除外）。下面四条钉住这个往返。

test('读回：写→读往返必须拿回正文原文（头部元信息被剥掉）', () => {
  const dir = tmpDir();
  const file = writePromptFile(path.join(dir, 'prompts', 'deepseek.md'), '教学全文 ABC\n第二行');
  assert.ok(file);
  const back = readPromptFile(file);
  assert.equal(back, '教学全文 ABC\n第二行', '读回的必须是正文原文，不含 writePromptFile 的头部');
  assert.ok(!back.includes('dsh-webcode-bridge 提示词落盘'), '头部元信息不得混进投递内容');
});

test('读回：正文里的引用块（> 开头）不被当头部吃掉', () => {
  const dir = tmpDir();
  const body = '> 这是正文里的引用，不是头部\n\n普通段落';
  const file = writePromptFile(path.join(dir, 'sessions', 's.md'), body);
  const back = readPromptFile(file);
  assert.ok(back.includes('这是正文里的引用'), '正文引用块必须保留：' + JSON.stringify(back));
  assert.ok(back.includes('普通段落'));
});

test('读回：0.16.28 旧文件（头部与正文粘在一行）仍读得出完整正文', () => {
  // 0.16.28 的 writePromptFile 用 `[..., ''].filter(Boolean)` 拼头部，那个空串被
  // filter 删掉，于是头部末行与正文首行**没有换行**、粘成一行（真机实测：正文第一
  // 行被吞）。升级后磁盘上已有的旧文件必须仍能完整读回，否则第一次重建静默丢一行。
  const dir = tmpDir();
  const file = path.join(dir, 'legacy.md');
  fs.writeFileSync(file, '> dsh-webcode-bridge 提示词落盘（0.16.28）\n'
    + '> 更新时间：2026-09-19T19:28:08.990Z教学全文 ABC\n第二行\n');
  assert.equal(readPromptFile(file), '教学全文 ABC\n第二行', '旧粘行格式必须补回正文首行');
});

test('读回：0.16.28 带 note 的旧文件（正文粘在「说明」行后）仍读得出完整正文', () => {
  // 真机实测（`~/.dsh/webcode/prompts/deepseek.md`，0.16.28 写的）：无 note 时正文粘在
  // 「更新时间」行后，**有 note 时粘在「说明」行后**——而落盘入口恒传 note，所以
  // 生产文件走的正是这一种。修前读回会丢掉正文首行（真机上就是 `# 可用本地工具` 那一行）。
  const dir = tmpDir();
  const file = path.join(dir, 'legacy-note.md');
  fs.writeFileSync(file, '> dsh-webcode-bridge 提示词落盘（0.16.28）\n'
    + '> 更新时间：2026-09-19T19:10:25.540Z\n'
    + '> 说明：站点 deepseek 的教学/协议全文（逐轮覆盖）# 可用本地工具\n'
    + '本次会话已为你接入…\n');
  const back = readPromptFile(file);
  assert.ok(back.startsWith('# 可用本地工具'),
    '正文首行（真机是 `# 可用本地工具`）必须被补回，实际开头：' + JSON.stringify(String(back).slice(0, 40)));
  assert.ok(back.includes('本次会话已为你接入'), '后续正文必须完整');
});

test('读回：文件不存在 / 传 null / 内容是空 → 返回 null，不抛错', () => {
  const dir = tmpDir();
  assert.equal(readPromptFile(path.join(dir, 'nope.md')), null);
  assert.equal(readPromptFile(null), null);
  assert.equal(readPromptFile(undefined), null);
  const empty = path.join(dir, 'empty.md');
  fs.writeFileSync(empty, '> 只有头部\n\n');
  assert.equal(readPromptFile(empty), null, '只有头部没有正文时返回 null（调用方回落内存序列化）');
});
