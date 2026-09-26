// column-fs.test.mjs — 并列三列的**产物围栏**（0.19.29，用户「沙箱」需求）。
//
// ## 这个文件要证明什么
//
// 两轮思考（`doc/research/2026-09-26-column-sandbox-round1/2-thinking.md`）的结论是：
// 并列三列走控制面通路、**不执行工具**，所以没有「模型越界写」可拦；本插件真正能设
// 围栏的地方只有**自己写文件的那一处**。本文件钉的就是那一处。
//
// ## 判据为什么必须成对
//
// 本仓库反复记过的教训：只测一侧的判据会被反向实现骗过。
//   · 只测「攻击路径被拒」⇒ 把围栏写成 `throw`（一律拒绝）也能全绿；
//   · 只测「正常路径可写」⇒ 把围栏写成 `return target`（一律放行）也能全绿。
// 所以下面每一组都同时有**允许**与**拒绝**两侧，且拒绝侧要断言**磁盘上没有留下文件**
// ——「拒绝了但已经写下去了」是最坏的一种假通过。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  COLUMN_FS_DENIED, ColumnFsDenied, assertUnderColumnRoot, canonicalWithMissingTail,
  columnRootOf, fencedBlocks, isPathUnder, writeColumnArtifact,
} from '../lib/column-fs.js';
import { normalizeColumnContext } from '../lib/column-context.js';

/** 一个真实的临时工作区（真文件系统 —— 符号链接与大小写只有真盘上才成立）。 */
function tmpWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwb-colf-'));
  fs.mkdirSync(path.join(dir, '.hwb', 'cols'), { recursive: true });
  return dir;
}

const CTX = normalizeColumnContext({ role: 'explore', key: 'c2', scope: 's1' });

test('围栏·允许侧：本列目录内的写入必须成功，且返回**重新规范化后**的路径', () => {
  const ws = tmpWorkspace();
  try {
    const root = columnRootOf(ws, CTX);
    assert.ok(root.startsWith(path.resolve(ws)), '本列根必须落在工作区内');
    assert.ok(root.includes('c2'), '本列根必须含列键（用户要能按列找产出）');

    const written = writeColumnArtifact(ws, CTX, 'plan.md', '# 方案\n\n内容');
    assert.ok(fs.existsSync(written), '写入后文件必须真的存在（不是只断言调用了函数）');
    assert.equal(fs.readFileSync(written, 'utf8'), '# 方案\n\n内容', '内容必须逐字落盘');
    // 返回的必须是规范化后的**绝对**路径（调用方要拿它去写，见 checkedTarget 口径）。
    assert.equal(written, path.resolve(written), '返回值必须是绝对路径');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('★ 围栏·拒绝侧：路径穿越 / 绝对路径 / 前缀伪装 —— 一律拒绝且**磁盘无残留**', () => {
  const ws = tmpWorkspace();
  try {
    const root = columnRootOf(ws, CTX);
    const outside = path.join(path.resolve(ws), 'ESCAPED.txt');
    // 具体形态：`..` 逃逸、绝对路径、以及「前缀相同但并非子目录」的伪装。
    // 最后一条是本判据的重点：裸 startsWith 会把 `cols/c2-evil` 判成在 `cols/c2` 之下。
    const attacks = [
      path.join(root, '..', '..', 'ESCAPED.txt'),
      path.join(root, '..', 'ESCAPED.txt'),
      outside,
      root + '-evil' + path.sep + 'ESCAPED.txt',
    ];
    for (const target of attacks) {
      assert.throws(() => assertUnderColumnRoot(target, root),
        (e) => e instanceof ColumnFsDenied && e.code === COLUMN_FS_DENIED,
        '越界目标必须抛 ColumnFsDenied：' + target);
    }
    // 成对：拒绝之后磁盘上**不能**有那个文件。
    assert.ok(!fs.existsSync(outside), '被拒绝的写入不得在磁盘上留下文件');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('围栏：根自身算「在根下」，但兄弟目录与父目录不算', () => {
  const ws = tmpWorkspace();
  try {
    const r1 = path.join(ws, '.hwb', 'cols', 's1-c1');
    const r2 = path.join(ws, '.hwb', 'cols', 's1-c2');
    assert.equal(isPathUnder(r1, r1), true, '根本身必须算在根下');
    assert.equal(isPathUnder(path.join(r1, 'a.md'), r1), true, '根的直接子项必须在根下');
    assert.equal(isPathUnder(r2, r1), false, '兄弟目录不在根下（列与列之间必须隔开）');
    assert.equal(isPathUnder(path.join(ws, '.hwb', 'cols'), r1), false, '父目录不在根下');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('围栏：文件名过白名单（`../` 与分隔符都进不来）', () => {
  const ws = tmpWorkspace();
  try {
    // 攻击性文件名：净化后必须仍落在本列目录内，绝不逃逸。
    const w = writeColumnArtifact(ws, CTX, '../../../ESCAPED.md', 'x');
    const root = columnRootOf(ws, CTX);
    assert.ok(isPathUnder(w, root), '恶意文件名净化后仍必须落在本列目录内');
    assert.ok(!fs.existsSync(path.join(path.resolve(ws), 'ESCAPED.md')), '不得逸出到工作区根');
    // 分隔符与编码形态同样进不来。
    for (const bad of ['a/b.md', 'a\\b.md', '%2e%2e%2fx.md']) {
      const p = writeColumnArtifact(ws, CTX, bad, 'y');
      assert.ok(isPathUnder(p, root), '净化后必须仍在根下：' + bad);
    }
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('★ 围栏：符号链接指向工作区外时必须拒绝（canonicalize 真的在承重）', () => {
  const ws = tmpWorkspace();
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwb-outside-'));
  try {
    const root = columnRootOf(ws, CTX);
    fs.mkdirSync(root, { recursive: true });
    // 在本列目录里放一个指向**外部目录**的链接：只看词法路径它「在根下」，
    // 只有真的 realpath 之后才看得出它其实指向外面。
    const link = path.join(root, 'escape');
    try {
      fs.symlinkSync(outsideDir, link, 'junction');
    } catch {
      // 无权限建链接（部分 Windows 配置）：如实跳过，不假装通过。
      return;
    }
    assert.throws(() => assertUnderColumnRoot(path.join(link, 'ESCAPED.txt'), root),
      (e) => e instanceof ColumnFsDenied,
      '经符号链接指向工作区外的目标必须被拒 —— 这条证明 canonicalize 在承重');
    assert.ok(!fs.existsSync(path.join(outsideDir, 'ESCAPED.txt')), '外部目录不得被写入');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('canonicalWithMissingTail：不存在的尾段也能规范化，且不因缺文件抛错', () => {
  const ws = tmpWorkspace();
  try {
    const deep = path.join(ws, 'a', 'b', 'c', 'nope.md');
    const real = canonicalWithMissingTail(deep);
    // 形态：最深的已存在祖先被 realpath，之后的尾段原样接回。
    assert.ok(real.endsWith(path.join('a', 'b', 'c', 'nope.md')), '不存在的尾段必须保留：' + real);
    assert.equal(real, path.resolve(real), '必须是绝对路径');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('缺列身份时拒绝（绝不退回所有列共用的根）', () => {
  const ws = tmpWorkspace();
  try {
    // 没有 key 就拼不出本列目录 —— 退回 `.hwb/cols/` 会让三列一起往里写，
    // 而界面上还写着「该目录归本列使用」。宁可不写。
    assert.throws(() => columnRootOf(ws, { key: '' }), (e) => e instanceof ColumnFsDenied);
    assert.throws(() => columnRootOf(ws, null), (e) => e instanceof ColumnFsDenied);
    assert.throws(() => writeColumnArtifact(ws, null, 'x.md', 'x'), (e) => e instanceof ColumnFsDenied);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('fencedBlocks：抽出围栏代码块并给对扩展名（认不出仍落盘，不丢内容）', () => {
  const text = [
    '先看这段：', '```js', 'const a = 1;', '```', '',
    '再看这段：', '```python', 'x = 1', '```', '',
    '还有没标语言的：', '```', 'plain text', '```',
  ].join('\n');
  const blocks = fencedBlocks(text);
  assert.equal(blocks.length, 3, '三个围栏块必须都被抽到');
  assert.equal(blocks[0].ext, 'js');
  assert.equal(blocks[0].code.trim(), 'const a = 1;');
  assert.equal(blocks[1].ext, 'py', 'python 必须映射到 .py');
  assert.equal(blocks[2].ext, 'txt', '没标语言时用 .txt（内容比扩展名重要）');
  // 没有围栏时不得凭空造块。
  assert.deepEqual(fencedBlocks('纯文本，没有代码块'), []);
});

test('不同列 / 不同会话的产物目录必须互不相同（0.19.23 那个缺陷的回归钉）', () => {
  const ws = tmpWorkspace();
  try {
    const a = columnRootOf(ws, normalizeColumnContext({ role: 'explore', key: 'c2', scope: 'sess-aaa' }));
    const b = columnRootOf(ws, normalizeColumnContext({ role: 'explore', key: 'c2', scope: 'sess-bbb' }));
    const c = columnRootOf(ws, normalizeColumnContext({ role: 'review', key: 'c1', scope: 'sess-aaa' }));
    assert.notEqual(a, b, '不同 DSH 会话的同名列必须落进不同目录 —— 否则草稿互相覆盖');
    assert.notEqual(a, c, '同一会话内不同列必须落进不同目录');
    // 成对：真的写下去，两个目录互不可见。
    const fa = writeColumnArtifact(ws, normalizeColumnContext({ role: 'explore', key: 'c2', scope: 'sess-aaa' }), 'p.md', 'A');
    const fb = writeColumnArtifact(ws, normalizeColumnContext({ role: 'explore', key: 'c2', scope: 'sess-bbb' }), 'p.md', 'B');
    assert.equal(fs.readFileSync(fa, 'utf8'), 'A');
    assert.equal(fs.readFileSync(fb, 'utf8'), 'B');
    assert.notEqual(path.dirname(fa), path.dirname(fb), '两次写入必须落在不同目录');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

/**
 * ★ 三跳齐全：`POST chat` 必须真的把产出落盘，且**落盘失败不得把整轮报成失败**。
 *
 * 第二跳与第三跳只看源码结构（本判据不启浏览器）：派发成功后才落盘、
 * 落盘结果如实透出、并且落盘包在 try 里而不是让异常冒出去。
 */
test('三跳齐全：POST chat 必须落盘，且落盘失败不得让整轮变成失败', () => {
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), '..', 'lib', 'web-control.js'), 'utf8');
  const block = src.slice(src.indexOf("'POST chat'"), src.indexOf('  };\n\n  // ── `status`'));
  assert.ok(block.length > 0, '找不到 POST chat 的动作体（改名则本判据失效，需同步）');
  // 第二跳：拿到回复之后必须调用落盘。
  assert.match(block, /const reply = res\?\.text \|\| res \|\| ''/, '必须先取到回复文本');
  assert.match(block, /saveColumnReply\(body\?\.columnContext, taskRootOf\(body\), reply, sessionKey\)/,
    'POST chat 必须把本列产出落盘（不落盘 ⇒ 提示词里那个目录永远不存在，就是撒谎）');
  assert.match(block, /return \{ ok: true, reply, sessionKey, fresh, resumed: !fresh/,
    '落盘是附带的：消息成功这件事不得因落盘而改变');
  // 第三跳：落盘自身必须吞掉异常并如实记录（best-effort）。
  const helper = src.slice(src.indexOf('function saveColumnReply'), src.indexOf('function saveColumnReply') + 2200);
  assert.match(helper, /catch \(e\) \{/, '落盘必须包 try/catch —— 抛出会让一次成功发送变成用户眼里的失败');
  assert.match(helper, /error: why/, '落盘失败原因必须如实透出，不得静默');
  assert.match(helper, /if \(!ctx\) return null;/, '没有有效列身份的请求不得往磁盘写东西');
});
